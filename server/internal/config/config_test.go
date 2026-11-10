package config

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setValidEnv(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	webDir := filepath.Join(root, "web")
	if err := os.MkdirAll(webDir, 0o750); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IREAD_ADDR", "127.0.0.1:18080")
	t.Setenv("IREAD_BOOKS_DIR", filepath.Join(root, "books"))
	t.Setenv("IREAD_DB_DIR", filepath.Join(root, "db"))
	t.Setenv("IREAD_CACHE_DIR", filepath.Join(root, "cache"))
	t.Setenv("IREAD_WEB_DIR", webDir)
	t.Setenv("IREAD_LOG_LEVEL", "debug")
	t.Setenv("IREAD_LOG_FORMAT", "json")
	t.Setenv("IREAD_ALLOW_NON_LOOPBACK", "")
	t.Setenv("IREAD_PUBLIC_ORIGIN", "")
	t.Setenv("IREAD_SETUP_TOKEN", "")
	t.Setenv("IREAD_INDEX_WORKERS", "")
	t.Setenv("IREAD_ENV", "")
	t.Setenv("IREAD_DEV_NO_AUTH", "")
	return root
}

func TestLoadValid(t *testing.T) {
	root := setValidEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Addr != "127.0.0.1:18080" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	for _, dir := range []string{cfg.BooksDir, cfg.DBDir, cfg.CacheDir} {
		if !filepath.IsAbs(dir) {
			t.Fatalf("目录未绝对化: %s", dir)
		}
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			t.Fatalf("目录未创建: %s (%v)", dir, err)
		}
	}
	if cfg.BooksDir != filepath.Join(root, "books") {
		t.Fatalf("BooksDir = %q", cfg.BooksDir)
	}
	if cfg.WebDir != filepath.Join(root, "web") || cfg.NonLoopback {
		t.Fatalf("WebDir/NonLoopback = %q/%v", cfg.WebDir, cfg.NonLoopback)
	}
	if cfg.LogLevel != slog.LevelDebug || cfg.LogFormat != "json" {
		t.Fatalf("日志配置 = %v/%s", cfg.LogLevel, cfg.LogFormat)
	}
	if cfg.PublicOrigin != "http://127.0.0.1:8080" || cfg.SecureCookie {
		t.Fatalf("公开来源配置 = %q/%v", cfg.PublicOrigin, cfg.SecureCookie)
	}
	if cfg.IndexWorkers != 1 {
		t.Fatalf("IndexWorkers = %d，期望 1", cfg.IndexWorkers)
	}
	if cfg.SetupToken != "" {
		t.Fatal("未设置 IREAD_SETUP_TOKEN 时不应产生安装令牌")
	}
	if cfg.Env != "development" || cfg.DevNoAuth {
		t.Fatalf("默认环境配置 = %q/%v，期望 development/false", cfg.Env, cfg.DevNoAuth)
	}
}

func TestLoadDevNoAuth(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_DEV_NO_AUTH", "1")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.DevNoAuth || cfg.Env != "development" {
		t.Fatalf("开发免认证配置 = %q/%v", cfg.Env, cfg.DevNoAuth)
	}
}

func TestLoadRejectsDevNoAuthInProduction(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_ENV", "production")
	t.Setenv("IREAD_DEV_NO_AUTH", "1")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_DEV_NO_AUTH") {
		t.Fatalf("production + IREAD_DEV_NO_AUTH=1 未被拒绝: %v", err)
	}
}

func TestLoadRejectsInvalidDevNoAuth(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_DEV_NO_AUTH", "yes")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_DEV_NO_AUTH") {
		t.Fatalf("非法 IREAD_DEV_NO_AUTH 未被拒绝: %v", err)
	}
}

func TestLoadRejectsInvalidEnv(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_ENV", "prodction")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_ENV") {
		t.Fatalf("非法 IREAD_ENV 未被拒绝: %v", err)
	}
}

func TestLoadReadsSetupToken(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_SETUP_TOKEN", "  setup-token-value  ")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SetupToken != "setup-token-value" {
		t.Fatalf("SetupToken = %q", cfg.SetupToken)
	}
}

func TestLoadClampsIndexWorkersToOne(t *testing.T) {
	for _, value := range []string{"2", "0", "-1", "invalid", "8"} {
		t.Run(value, func(t *testing.T) {
			setValidEnv(t)
			t.Setenv("IREAD_INDEX_WORKERS", value)
			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.IndexWorkers != 1 {
				t.Fatalf("IndexWorkers = %d，期望收敛为 1", cfg.IndexWorkers)
			}
		})
	}
}

func TestLoadPublicOriginHTTPS(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_PUBLIC_ORIGIN", "https://iread.example.com/")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.PublicOrigin != "https://iread.example.com:443" || !cfg.SecureCookie {
		t.Fatalf("公开来源配置 = %q/%v", cfg.PublicOrigin, cfg.SecureCookie)
	}
}

func TestLoadRejectsInvalidPublicOrigin(t *testing.T) {
	for _, value := range []string{
		"ftp://iread.example.com",
		"iread.example.com",
		"http://iread.example.com/path",
		"http://user:pass@iread.example.com",
		"http://",
	} {
		t.Run(value, func(t *testing.T) {
			setValidEnv(t)
			t.Setenv("IREAD_PUBLIC_ORIGIN", value)
			if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_PUBLIC_ORIGIN") {
				t.Fatalf("非法公开来源未被拒绝: %v", err)
			}
		})
	}
}

func TestLoadRejectsNonLoopbackWithoutOptIn(t *testing.T) {
	for _, addr := range []string{":8080", "0.0.0.0:8080", "[::]:8080", "192.168.1.10:8080", "example.com:8080"} {
		t.Run(addr, func(t *testing.T) {
			setValidEnv(t)
			t.Setenv("IREAD_ADDR", addr)
			if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_ALLOW_NON_LOOPBACK=1") {
				t.Fatalf("非回环监听未被拒绝: %v", err)
			}
		})
	}
}

func TestLoadAllowsNonLoopbackWithOptIn(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_ADDR", "0.0.0.0:18080")
	t.Setenv("IREAD_ALLOW_NON_LOOPBACK", "1")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("显式 opt-in 后 Load() error = %v", err)
	}
	if cfg.Addr != "0.0.0.0:18080" || !cfg.NonLoopback {
		t.Fatalf("Addr/NonLoopback = %q/%v", cfg.Addr, cfg.NonLoopback)
	}
}

func TestLoadAllowsLoopbackHosts(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:18080", "localhost:18080", "[::1]:18080"} {
		t.Run(addr, func(t *testing.T) {
			setValidEnv(t)
			t.Setenv("IREAD_ADDR", addr)
			cfg, err := Load()
			if err != nil {
				t.Fatalf("回环地址被拒绝: %v", err)
			}
			if cfg.NonLoopback {
				t.Fatalf("%s 不应标记为非回环", addr)
			}
		})
	}
}

func TestLoadRejectsInvalidNonLoopbackFlag(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_ALLOW_NON_LOOPBACK", "yes")
	if _, err := Load(); err == nil {
		t.Fatal("非法 IREAD_ALLOW_NON_LOOPBACK 未被拒绝")
	}
}

func TestLoadRejectsWebDirRoot(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_WEB_DIR", string(filepath.Separator))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "不得为根目录") {
		t.Fatalf("WebDir 根目录未被拒绝: %v", err)
	}
}

func TestLoadRejectsWebDirSameAsStorage(t *testing.T) {
	root := setValidEnv(t)
	t.Setenv("IREAD_WEB_DIR", filepath.Join(root, "books"))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_WEB_DIR 与 IREAD_BOOKS_DIR") {
		t.Fatalf("WebDir 与 books 相同未被拒绝: %v", err)
	}
}

func TestLoadRejectsWebDirNestedInStorage(t *testing.T) {
	root := setValidEnv(t)
	t.Setenv("IREAD_WEB_DIR", filepath.Join(root, "books", "web"))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_WEB_DIR 与 IREAD_BOOKS_DIR") {
		t.Fatalf("WebDir 位于 books 内未被拒绝: %v", err)
	}
}

func TestLoadRejectsStorageNestedInWebDir(t *testing.T) {
	root := setValidEnv(t)
	t.Setenv("IREAD_BOOKS_DIR", filepath.Join(root, "web", "books"))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_WEB_DIR 与 IREAD_BOOKS_DIR") {
		t.Fatalf("books 位于 WebDir 内未被拒绝: %v", err)
	}
}

func TestLoadRejectsWebDirSymlinkToStorage(t *testing.T) {
	root := setValidEnv(t)
	link := filepath.Join(root, "web-link")
	if err := os.Symlink(filepath.Join(root, "books"), link); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	t.Setenv("IREAD_WEB_DIR", link)
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_WEB_DIR 与 IREAD_BOOKS_DIR") {
		t.Fatalf("WebDir 符号链接指向 books 未被拒绝: %v", err)
	}
}

func TestLoadRejectsMissingWebDir(t *testing.T) {
	root := setValidEnv(t)
	t.Setenv("IREAD_WEB_DIR", filepath.Join(root, "not-built-yet"))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_WEB_DIR 不存在") {
		t.Fatalf("缺失 WebDir 未被拒绝: %v", err)
	}
}

func TestSameUnderlyingDir(t *testing.T) {
	dir := t.TempDir()
	same, err := sameUnderlyingDir(dir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !same {
		t.Fatal("同一目录的 os.SameFile 分支应返回 true")
	}
}

func TestLoadRejectsSameDirectories(t *testing.T) {
	root := setValidEnv(t)
	t.Setenv("IREAD_DB_DIR", filepath.Join(root, "books"))

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "不得相同或互相包含") {
		t.Fatalf("相同目录未被拒绝: %v", err)
	}
}

func TestLoadRejectsNestedDirectories(t *testing.T) {
	root := setValidEnv(t)
	t.Setenv("IREAD_DB_DIR", filepath.Join(root, "books", "db"))

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "不得相同或互相包含") {
		t.Fatalf("books 包含 db 未被拒绝: %v", err)
	}

	t.Setenv("IREAD_BOOKS_DIR", filepath.Join(root, "db", "books"))
	t.Setenv("IREAD_DB_DIR", filepath.Join(root, "db"))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "不得相同或互相包含") {
		t.Fatalf("db 包含 books 未被拒绝: %v", err)
	}
}

func TestLoadRejectsSymlinkedNestedDirectory(t *testing.T) {
	root := setValidEnv(t)
	realBooks := filepath.Join(root, "real-books")
	if err := os.Mkdir(realBooks, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "db-link")
	if err := os.Symlink(realBooks, link); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	t.Setenv("IREAD_BOOKS_DIR", realBooks)
	t.Setenv("IREAD_DB_DIR", link)

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "符号链接") {
		t.Fatalf("符号链接嵌套未被拒绝: %v", err)
	}
}

func TestLoadRejectsUnwritableDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root 可写入只读目录，跳过权限测试")
	}
	root := setValidEnv(t)
	locked := filepath.Join(root, "locked")
	if err := os.Mkdir(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
	t.Setenv("IREAD_BOOKS_DIR", locked)

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "IREAD_BOOKS_DIR 不可用") {
		t.Fatalf("不可写目录未被拒绝: %v", err)
	}
}

func TestLoadRejectsInvalidOptions(t *testing.T) {
	setValidEnv(t)
	t.Setenv("IREAD_LOG_LEVEL", "verbose")
	if _, err := Load(); err == nil {
		t.Fatal("非法日志级别未被拒绝")
	}

	setValidEnv(t)
	t.Setenv("IREAD_LOG_FORMAT", "xml")
	if _, err := Load(); err == nil {
		t.Fatal("非法日志格式未被拒绝")
	}

	setValidEnv(t)
	t.Setenv("IREAD_ADDR", "not-an-address")
	if _, err := Load(); err == nil {
		t.Fatal("非法监听地址未被拒绝")
	}
}
