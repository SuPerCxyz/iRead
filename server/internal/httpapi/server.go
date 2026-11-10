// Package httpapi 提供 JSON API、单管理员认证门禁、健康检查与静态/SPA 服务。
package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"iread/server/internal/auth"
	"iread/server/internal/jobs"
	"iread/server/internal/library"
	"iread/server/internal/reader/pdf"
	"iread/server/internal/store"
)

const defaultPublicOrigin = "http://127.0.0.1:8080"

// Options 是构造 Server 所需的依赖。
type Options struct {
	Store        *store.Store
	WebDir       string
	Version      string
	Logger       *slog.Logger
	StorageDirs  []string
	PublicOrigin string
	BooksDir     string
	CacheDir     string
	SetupToken   string
	// DevNoAuth 仅由显式开发配置开启；生产由 config 拒绝。开启后跳过
	// 会话/CSRF/Origin 校验并注入合成开发上下文，不创建用户或会话。
	DevNoAuth bool
	// Library 与 Jobs 为阶段2书库/任务依赖；为空时对应路由不注册，
	// 便于认证/静态等单元测试按需构造最小 Server。生产入口必须同时提供。
	Library *library.Service
	Jobs    *jobs.Manager
}

// Server 是阶段2 HTTP 处理器集合。
type Server struct {
	store            *store.Store
	webDir           string
	version          string
	logger           *slog.Logger
	storageDirs      []string
	publicOrigin     string
	secureCookies    bool
	limiter          *auth.RateLimiter
	now              func() time.Time
	libraryHandlers  *LibraryHandlers
	taskHandlers     *TaskHandlers
	cacheHandlers    *CacheHandlers
	booksDir         string
	cacheDir         string
	setupToken       string
	devNoAuth        bool
	pdfHandler       *PDFContentHandler
	manifestHandlers *ReaderManifestHandlers
	comicHandlers    *ComicHandlers
	readerDispatch   *ReaderDispatch
	readerHandlers   *ReaderDataHandlers
}

// New 构造 Server；依赖缺失时返回错误而不是延迟到请求阶段。
func New(options Options) (*Server, error) {
	if options.Store == nil {
		return nil, fmt.Errorf("httpapi: store 不能为空")
	}
	if strings.TrimSpace(options.WebDir) == "" {
		return nil, fmt.Errorf("httpapi: web 目录不能为空")
	}
	if len(options.StorageDirs) == 0 {
		return nil, fmt.Errorf("httpapi: 存储目录不能为空")
	}
	version := options.Version
	if version == "" {
		version = "dev"
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}

	publicOrigin := strings.TrimSpace(options.PublicOrigin)
	if publicOrigin == "" {
		publicOrigin = defaultPublicOrigin
	}
	canonicalOrigin, secureCookies, err := auth.NormalizeOrigin(publicOrigin)
	if err != nil {
		return nil, fmt.Errorf("httpapi: IREAD_PUBLIC_ORIGIN 无效: %w", err)
	}

	server := &Server{
		store:         options.Store,
		webDir:        options.WebDir,
		version:       version,
		logger:        logger,
		storageDirs:   append([]string(nil), options.StorageDirs...),
		publicOrigin:  canonicalOrigin,
		secureCookies: secureCookies,
		limiter:       auth.NewRateLimiter(),
		now:           time.Now,
		booksDir:      strings.TrimSpace(options.BooksDir),
		cacheDir:      strings.TrimSpace(options.CacheDir),
		setupToken:    strings.TrimSpace(options.SetupToken),
		devNoAuth:     options.DevNoAuth,
	}

	readerHandlers, err := NewReaderDataHandlers(ReaderDataOptions{
		Store:        options.Store,
		BookResolver: StoreReaderBookResolver{Store: options.Store},
		RequireAuth:  server.RequireAuth,
		RequireCSRF:  server.RequireCSRF,
		Logger:       logger,
	})
	if err != nil {
		return nil, err
	}
	server.readerHandlers = readerHandlers

	if server.booksDir != "" {
		pdfHandler, err := NewPDFContentHandler(PDFContentOptions{
			Resolver:    pdf.NewStoreResolver(options.Store),
			BooksDir:    server.booksDir,
			Logger:      logger,
			RequireAuth: server.RequireAuth,
		})
		if err != nil {
			return nil, err
		}
		server.pdfHandler = pdfHandler

		manifestHandlers, err := NewReaderManifestHandlers(ReaderManifestOptions{
			Resolver:    NewReaderManifestStoreResolver(options.Store),
			Store:       options.Store,
			BooksDir:    server.booksDir,
			Logger:      logger,
			RequireAuth: server.RequireAuth,
		})
		if err != nil {
			return nil, err
		}
		server.manifestHandlers = manifestHandlers

		if server.cacheDir != "" {
			comicHandlers, err := NewComicHandlers(ComicOptions{
				Resolver:    NewComicStoreResolver(options.Store),
				Store:       options.Store,
				BooksDir:    server.booksDir,
				CacheDir:    server.cacheDir,
				Logger:      logger,
				RequireAuth: server.RequireAuth,
			})
			if err != nil {
				return nil, err
			}
			server.comicHandlers = comicHandlers
		}

		dispatch, err := NewReaderDispatch(ReaderDispatchOptions{
			Store:       options.Store,
			Manifest:    server.manifestHandlers,
			Comic:       server.comicHandlers,
			Logger:      logger,
			RequireAuth: server.RequireAuth,
		})
		if err != nil {
			return nil, err
		}
		server.readerDispatch = dispatch
	}

	if options.Library != nil {
		handlers, err := NewLibraryHandlers(LibraryOptions{
			Service:     options.Library,
			Logger:      logger,
			RequireAuth: server.RequireAuth,
			RequireCSRF: server.RequireCSRF,
		})
		if err != nil {
			return nil, err
		}
		server.libraryHandlers = handlers
	}
	if options.Jobs != nil {
		handlers, err := NewTaskHandlers(TaskOptions{
			Store:       options.Store,
			RequireAuth: server.RequireAuth,
			RequireCSRF: server.RequireCSRF,
			Logger:      logger,
			Notify:      options.Jobs.Notify,
		})
		if err != nil {
			return nil, err
		}
		server.taskHandlers = handlers
	}

	// CacheDir 为空时不注册缓存管理路由，保持最小 Server 测试可按需构造；
	// 生产入口始终提供 CacheDir 与 Jobs。Jobs 为空时清理任务依赖 worker 轮询，
	// 不能把 nil *jobs.Manager 赋给接口，否则 Notify 会命中 nil 接收者。
	if server.cacheDir != "" {
		var notifier CacheNotifier
		if options.Jobs != nil {
			notifier = options.Jobs
		}
		handlers, err := NewCacheHandlers(CacheOptions{
			Store:       options.Store,
			Jobs:        notifier,
			CacheDir:    server.cacheDir,
			RequireAuth: server.RequireAuth,
			RequireCSRF: server.RequireCSRF,
			Logger:      logger,
		})
		if err != nil {
			return nil, err
		}
		server.cacheHandlers = handlers
	}

	return server, nil
}

// Close 释放阅读器资源，尤其是漫画索引器缓存的 RAR 会话与文件句柄。
func (s *Server) Close() error {
	if s == nil || s.comicHandlers == nil {
		return nil
	}
	return s.comicHandlers.Close()
}

// Handler 返回带中间件的完整 HTTP 处理器。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc(apiHealthPath, s.handleAPIHealth)
	mux.HandleFunc(authStatusPath, s.handleAuthStatus)
	mux.HandleFunc(authSetupPath, s.handleAuthSetup)
	mux.HandleFunc(authLoginPath, s.handleAuthLogin)
	mux.HandleFunc(authLogoutPath, s.handleAuthLogout)
	mux.HandleFunc("/api/v1/settings/appearance", s.handleAppearance)
	mux.HandleFunc("/api/v1/settings/", s.handleOtherSettings)
	mux.HandleFunc("/api/v1/settings", s.handleAPINotFound)
	mux.HandleFunc("/api", s.handleAPINotFound)
	mux.HandleFunc("/api/", s.handleAPINotFound)

	// 阅读器/原件路由必须先于书库的 /api/v1/books/ 子树注册。Go 1.22
	// ServeMux 按模式具体度选择，顺序不是正确性的前提，但显式优先便于审阅。
	if s.pdfHandler != nil {
		s.pdfHandler.RegisterPDFRoutes(mux)
	}
	// EPUB 与漫画共享 manifest/资源路径，只能注册统一 dispatcher；分别注册
	// RegisterReaderManifestRoutes 与 RegisterComicRoutes 会让漫画精确路由
	// 对 GET/HEAD 遮蔽 EPUB。
	if s.readerDispatch != nil {
		s.readerDispatch.RegisterReaderRoutes(mux)
	}
	if s.readerHandlers != nil {
		s.readerHandlers.RegisterReaderDataRoutes(mux)
	}

	// 阶段2书库/上传/任务路由。apiGuard 已在外层统一执行会话与 CSRF 校验；
	// handler 内的 RequireAuth/RequireCSRF 只复用同一请求上下文，不再次消费
	// body 或轮换令牌，因此不会产生重复 401/403。
	if s.libraryHandlers != nil {
		s.libraryHandlers.RegisterLibraryRoutes(mux)
	}
	if s.taskHandlers != nil {
		s.taskHandlers.RegisterTaskRoutes(mux)
	}
	if s.cacheHandlers != nil {
		s.cacheHandlers.RegisterCacheRoutes(mux)
	}

	mux.HandleFunc("/", s.handleStatic)
	return s.middleware(s.apiGuard(mux))
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := newRequestID()
		w.Header().Set("X-Request-Id", requestID)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		if isAPIRequest(r.URL.Path) {
			w.Header().Set("Cache-Control", "no-store")
		}

		ctx := context.WithValue(r.Context(), requestIDContextKey, requestID)
		r = r.WithContext(ctx)
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		start := time.Now()
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Error("请求处理 panic",
					"requestId", requestID,
					"panic", recovered,
					"stack", string(debug.Stack()),
				)
				if !recorder.wroteHeader {
					s.writeAPIError(recorder, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
				}
			}
			s.logger.Debug("请求完成",
				"method", r.Method,
				"path", r.URL.Path,
				"status", recorder.status,
				"duration", time.Since(start),
				"requestId", requestID,
			)
		}()

		next.ServeHTTP(recorder, r)
	})
}

func isAPIRequest(path string) bool {
	return path == "/healthz" || path == "/api" || strings.HasPrefix(path, "/api/")
}

func newRequestID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// crypto/rand 在受支持平台上不会失败；保留非敏感兜底避免请求中断。
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw[:])
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.wroteHeader {
		return
	}
	r.status = status
	r.wroteHeader = true
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(body []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(body)
}

// Unwrap 允许 http.ResponseController 访问底层 ResponseWriter。
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (s *Server) handleAPINotFound(w http.ResponseWriter, r *http.Request) {
	s.writeAPIError(w, r, http.StatusNotFound, "not_found", "接口不存在", nil)
}
