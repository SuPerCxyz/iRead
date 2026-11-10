// Package config 解析环境变量并验证存储目录边界与阶段2运行参数。
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"iread/server/internal/auth"
)

// Config 是启动所需的全部配置。
type Config struct {
	Addr         string
	Env          string
	DevNoAuth    bool
	BooksDir     string
	DBDir        string
	CacheDir     string
	WebDir       string
	LogLevel     slog.Level
	LogFormat    string
	NonLoopback  bool
	PublicOrigin string
	SecureCookie bool
	SetupToken   string
	IndexWorkers int
}

type namedDir struct {
	name string
	path string
}

type envDefaults struct {
	addr         string
	booksDir     string
	dbDir        string
	cacheDir     string
	webDir       string
	logLevel     string
	logFormat    string
	publicOrigin string
	indexWorkers string
}

var defaults = envDefaults{
	addr:         "127.0.0.1:8080",
	booksDir:     "../data/books",
	dbDir:        "../data/db",
	cacheDir:     "../data/cache",
	webDir:       "../web/dist",
	logLevel:     "info",
	logFormat:    "text",
	publicOrigin: "http://127.0.0.1:8080",
	indexWorkers: "1",
}

// Load 读取环境变量、规范化路径、创建存储目录并验证可写性。
func Load() (Config, error) {
	env, err := parseEnv(envOr("IREAD_ENV", "development"))
	if err != nil {
		return Config{}, err
	}
	devNoAuth, err := parseDevNoAuth(envOr("IREAD_DEV_NO_AUTH", ""))
	if err != nil {
		return Config{}, err
	}
	// 生产环境必须保留密码认证；即使误配也必须启动失败，不能静默忽略。
	if env == "production" && devNoAuth {
		return Config{}, fmt.Errorf("IREAD_ENV=production 时禁止设置 IREAD_DEV_NO_AUTH=1：生产环境必须保留密码认证")
	}

	addr, loopback, err := normalizeAddr(envOr("IREAD_ADDR", defaults.addr))
	if err != nil {
		return Config{}, err
	}
	allowNonLoopback, err := parseAllowNonLoopback(envOr("IREAD_ALLOW_NON_LOOPBACK", ""))
	if err != nil {
		return Config{}, err
	}
	if !loopback && !allowNonLoopback {
		return Config{}, fmt.Errorf("IREAD_ADDR 默认仅允许回环地址 127.0.0.1/::1/localhost；非回环监听必须显式设置 IREAD_ALLOW_NON_LOOPBACK=1")
	}

	booksDir, err := normalizeDir("IREAD_BOOKS_DIR", envOr("IREAD_BOOKS_DIR", defaults.booksDir))
	if err != nil {
		return Config{}, err
	}
	dbDir, err := normalizeDir("IREAD_DB_DIR", envOr("IREAD_DB_DIR", defaults.dbDir))
	if err != nil {
		return Config{}, err
	}
	cacheDir, err := normalizeDir("IREAD_CACHE_DIR", envOr("IREAD_CACHE_DIR", defaults.cacheDir))
	if err != nil {
		return Config{}, err
	}

	storageDirs := []namedDir{
		{"IREAD_BOOKS_DIR", booksDir},
		{"IREAD_DB_DIR", dbDir},
		{"IREAD_CACHE_DIR", cacheDir},
	}
	for i := 0; i < len(storageDirs); i++ {
		for j := i + 1; j < len(storageDirs); j++ {
			first, second := storageDirs[i], storageDirs[j]
			if sameOrNested(first.path, second.path) {
				return Config{}, fmt.Errorf("%s 与 %s 不得相同或互相包含", first.name, second.name)
			}
		}
	}

	webDir, err := normalizeDir("IREAD_WEB_DIR", envOr("IREAD_WEB_DIR", defaults.webDir))
	if err != nil {
		return Config{}, err
	}

	level, err := parseLogLevel(envOr("IREAD_LOG_LEVEL", defaults.logLevel))
	if err != nil {
		return Config{}, err
	}
	format := strings.ToLower(strings.TrimSpace(envOr("IREAD_LOG_FORMAT", defaults.logFormat)))
	if format != "text" && format != "json" {
		return Config{}, fmt.Errorf("IREAD_LOG_FORMAT 仅支持 text/json")
	}

	publicOrigin, secureCookie, err := auth.NormalizeOrigin(envOr("IREAD_PUBLIC_ORIGIN", defaults.publicOrigin))
	if err != nil {
		return Config{}, fmt.Errorf("IREAD_PUBLIC_ORIGIN 无效: %w", err)
	}

	// 可选安装令牌；未设置时 setup 仍只允许回环地址。令牌不得写入日志。
	setupToken := strings.TrimSpace(os.Getenv("IREAD_SETUP_TOKEN"))

	// 阶段2 worker 上限固定为 1；非法/越界值收敛为 1，与 jobs 层保持一致。
	const maxIndexWorkers = 1
	indexWorkers := maxIndexWorkers
	if value, parseErr := strconv.Atoi(strings.TrimSpace(envOr("IREAD_INDEX_WORKERS", defaults.indexWorkers))); parseErr == nil &&
		value >= 1 && value <= maxIndexWorkers {
		indexWorkers = value
	}

	for _, dir := range storageDirs {
		if err := ensureWritableDir(dir.path); err != nil {
			return Config{}, fmt.Errorf("%s 不可用: %w", dir.name, err)
		}
	}

	// 目录创建后再解析符号链接，防止配置路径不同但实际指向同一/嵌套位置。
	resolvedDirs := make([]string, len(storageDirs))
	for i, dir := range storageDirs {
		resolved, err := filepath.EvalSymlinks(dir.path)
		if err != nil {
			return Config{}, fmt.Errorf("%s 路径无法解析: %w", dir.name, err)
		}
		resolvedDirs[i] = resolved
	}
	for i := 0; i < len(storageDirs); i++ {
		for j := i + 1; j < len(storageDirs); j++ {
			if sameOrNested(resolvedDirs[i], resolvedDirs[j]) {
				return Config{}, fmt.Errorf("%s 与 %s 解析符号链接后不得相同或互相包含", storageDirs[i].name, storageDirs[j].name)
			}
			same, err := sameUnderlyingDir(resolvedDirs[i], resolvedDirs[j])
			if err != nil {
				return Config{}, fmt.Errorf("检查存储目录底层身份失败: %w", err)
			}
			if same {
				return Config{}, fmt.Errorf("%s 与 %s 指向同一底层目录", storageDirs[i].name, storageDirs[j].name)
			}
		}
	}

	if err := validateWebDir(webDir, storageDirs, resolvedDirs); err != nil {
		return Config{}, err
	}

	return Config{
		Addr:         addr,
		Env:          env,
		DevNoAuth:    devNoAuth,
		BooksDir:     booksDir,
		DBDir:        dbDir,
		CacheDir:     cacheDir,
		WebDir:       webDir,
		LogLevel:     level,
		LogFormat:    format,
		NonLoopback:  !loopback,
		PublicOrigin: publicOrigin,
		SecureCookie: secureCookie,
		SetupToken:   setupToken,
		IndexWorkers: indexWorkers,
	}, nil
}

// validateWebDir 将 Web 根纳入目录安全边界；目录必须存在且可解析。
func validateWebDir(webDir string, storageDirs []namedDir, resolvedStorage []string) error {
	if isFilesystemRoot(webDir) {
		return fmt.Errorf("IREAD_WEB_DIR 不得为根目录 /")
	}
	for _, dir := range storageDirs {
		if sameOrNested(webDir, dir.path) {
			return fmt.Errorf("IREAD_WEB_DIR 与 %s 不得相同或互相包含", dir.name)
		}
	}

	webInfo, err := os.Stat(webDir)
	switch {
	case err == nil:
		if !webInfo.IsDir() {
			return fmt.Errorf("IREAD_WEB_DIR 不是目录")
		}
		resolved, err := filepath.EvalSymlinks(webDir)
		if err != nil {
			return fmt.Errorf("IREAD_WEB_DIR 路径无法解析: %w", err)
		}
		if isFilesystemRoot(resolved) {
			return fmt.Errorf("IREAD_WEB_DIR 解析后不得为根目录 /")
		}
		for i, dir := range storageDirs {
			if sameOrNested(resolved, resolvedStorage[i]) {
				return fmt.Errorf("IREAD_WEB_DIR 与 %s 不得相同或互相包含（解析符号链接后）", dir.name)
			}
			same, err := sameUnderlyingDir(webDir, resolvedStorage[i])
			if err != nil {
				return fmt.Errorf("检查 IREAD_WEB_DIR 与 %s 底层身份失败: %w", dir.name, err)
			}
			if same {
				return fmt.Errorf("IREAD_WEB_DIR 与 %s 指向同一底层目录", dir.name)
			}
		}
		return nil
	case errors.Is(err, fs.ErrNotExist):
		if _, lstatErr := os.Lstat(webDir); lstatErr == nil {
			return fmt.Errorf("IREAD_WEB_DIR 是无效符号链接")
		} else if !errors.Is(lstatErr, fs.ErrNotExist) {
			return fmt.Errorf("IREAD_WEB_DIR 路径不可用: %w", lstatErr)
		}
		return fmt.Errorf("IREAD_WEB_DIR 不存在或不是目录")
	default:
		return fmt.Errorf("IREAD_WEB_DIR 路径不可用: %w", err)
	}
}

func sameUnderlyingDir(first, second string) (bool, error) {
	firstInfo, err := os.Stat(first)
	if err != nil {
		return false, err
	}
	secondInfo, err := os.Stat(second)
	if err != nil {
		return false, err
	}
	return os.SameFile(firstInfo, secondInfo), nil
}

func isFilesystemRoot(path string) bool {
	cleaned := filepath.Clean(path)
	return cleaned == string(filepath.Separator) || filepath.Dir(cleaned) == cleaned
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func normalizeAddr(value string) (string, bool, error) {
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return "", false, fmt.Errorf("IREAD_ADDR 格式无效，应形如 127.0.0.1:8080")
	}
	normalizedHost := host
	if normalizedHost == "" {
		normalizedHost = "0.0.0.0"
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 0 || portNumber > 65535 {
		return "", false, fmt.Errorf("IREAD_ADDR 端口无效")
	}
	loopback := host == "127.0.0.1" || host == "::1" || strings.EqualFold(host, "localhost")
	return net.JoinHostPort(normalizedHost, port), loopback, nil
}

func parseAllowNonLoopback(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0":
		return false, nil
	case "1", "true":
		return true, nil
	default:
		return false, fmt.Errorf("IREAD_ALLOW_NON_LOOPBACK 仅支持 1 或 0")
	}
}

// parseEnv 规范化运行环境；未知值直接拒绝，避免拼写错误绕过生产保护。
func parseEnv(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "development", "dev":
		return "development", nil
	case "staging":
		return "staging", nil
	case "production", "prod":
		return "production", nil
	default:
		return "", fmt.Errorf("IREAD_ENV 仅支持 development/staging/production")
	}
}

// parseDevNoAuth 解析显式开发免认证开关；默认关闭。
func parseDevNoAuth(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0", "false":
		return false, nil
	case "1", "true":
		return true, nil
	default:
		return false, fmt.Errorf("IREAD_DEV_NO_AUTH 仅支持 1 或 0")
	}
}

func normalizeDir(key, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s 不能为空", key)
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("%s 路径无法解析", key)
	}
	return filepath.Clean(absolute), nil
}

// sameOrNested 判断两个已清理绝对路径是否相同或存在父子关系。
func sameOrNested(a, b string) bool {
	return pathContains(a, b) || pathContains(b, a)
}

func pathContains(parent, child string) bool {
	if parent == child {
		return true
	}
	prefix := parent
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(child, prefix)
}

func ensureWritableDir(path string) error {
	if err := os.MkdirAll(path, 0o750); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("路径不是目录")
	}
	file, err := os.CreateTemp(path, ".iread-write-check-*")
	if err != nil {
		return err
	}
	name := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Remove(name); err != nil {
		return err
	}
	return nil
}

func parseLogLevel(value string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("IREAD_LOG_LEVEL 仅支持 debug/info/warn/error")
	}
}
