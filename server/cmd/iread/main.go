// Command iread 启动 iRead HTTP 服务。
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"iread/server/internal/config"
	"iread/server/internal/httpapi"
	"iread/server/internal/jobs"
	"iread/server/internal/library"
	"iread/server/internal/store"
)

// version 由 -ldflags "-X main.version=..." 覆盖。
var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "iread:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("配置失败: %w", err)
	}

	logger := newLogger(cfg)
	logger.Info("启动 iRead", "addr", cfg.Addr, "version", version, "env", cfg.Env, "indexWorkers", cfg.IndexWorkers)
	if cfg.DevNoAuth {
		// 开发免认证是显式危险开关；不输出任何令牌/密码。非回环时提示更醒目。
		if cfg.NonLoopback {
			logger.Warn("开发模式已禁用密码认证：所有 API 无需登录/会话/CSRF 即可访问；当前监听非回环地址，任何能访问该端口的人都可读写数据，仅限可信开发网络，严禁生产使用",
				"addr", cfg.Addr,
				"env", cfg.Env,
				"version", version,
				"nonLoopback", true,
			)
		} else {
			logger.Warn("开发模式已禁用密码认证：所有 API 无需登录/会话/CSRF 即可访问，仅限本机/可信开发网络",
				"addr", cfg.Addr,
				"env", cfg.Env,
				"version", version,
			)
		}
	}
	if cfg.NonLoopback {
		logger.Warn("非回环监听：请确认 IREAD_PUBLIC_ORIGIN 与反向代理 TLS 配置正确",
			"addr", cfg.Addr,
			"version", version,
			"allowNonLoopback", true,
			"publicOrigin", cfg.PublicOrigin,
			"secureCookie", cfg.SecureCookie,
		)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	database, err := store.OpenWithLogger(ctx, filepath.Join(cfg.DBDir, "iread.db"), logger)
	if err != nil {
		return fmt.Errorf("数据库初始化失败: %w", err)
	}
	defer func() {
		if closeErr := database.Close(); closeErr != nil {
			logger.Error("关闭数据库失败", "error", closeErr)
		}
	}()

	libraryService, err := library.NewService(library.Config{
		Store:    database,
		BooksDir: cfg.BooksDir,
		CacheDir: cfg.CacheDir,
		Logger:   logger,
		Now:      time.Now,
	})
	if err != nil {
		return fmt.Errorf("书库服务初始化失败: %w", err)
	}

	manager, err := jobs.NewManager(jobs.Options{
		Store:    database,
		BooksDir: cfg.BooksDir,
		CacheDir: cfg.CacheDir,
		Workers:  cfg.IndexWorkers,
		Logger:   logger,
	})
	if err != nil {
		return fmt.Errorf("后台任务初始化失败: %w", err)
	}
	if err := manager.Start(ctx); err != nil {
		return fmt.Errorf("启动后台任务失败: %w", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		if stopErr := manager.Stop(stopCtx); stopErr != nil {
			logger.Error("停止后台任务失败", "error", stopErr)
		}
	}()

	api, err := httpapi.New(httpapi.Options{
		Store:        database,
		WebDir:       cfg.WebDir,
		Version:      version,
		Logger:       logger,
		StorageDirs:  []string{cfg.BooksDir, cfg.DBDir, cfg.CacheDir},
		PublicOrigin: cfg.PublicOrigin,
		BooksDir:     cfg.BooksDir,
		CacheDir:     cfg.CacheDir,
		SetupToken:   cfg.SetupToken,
		DevNoAuth:    cfg.DevNoAuth,
		Library:      libraryService,
		Jobs:         manager,
	})
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := api.Close(); closeErr != nil {
			logger.Error("关闭阅读器资源失败", "error", closeErr)
		}
	}()

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP 服务失败: %w", err)
		}
		return nil
	case <-ctx.Done():
		logger.Info("收到退出信号，开始关闭", "addr", cfg.Addr, "version", version)
	}

	// 先停止任务 worker（把运行中任务释放回队列），再关闭 HTTP 与数据库。
	managerStopCtx, managerStopCancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := manager.Stop(managerStopCtx); err != nil {
		logger.Error("停止后台任务失败", "error", err)
	}
	managerStopCancel()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("关闭 HTTP 服务失败: %w", err)
	}
	logger.Info("iRead 已停止", "addr", cfg.Addr, "version", version)
	return nil
}

func newLogger(cfg config.Config) *slog.Logger {
	options := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, options))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, options))
}
