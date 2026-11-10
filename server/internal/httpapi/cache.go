package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"iread/server/internal/jobs"
	"iread/server/internal/store"
)

const (
	maxCacheMutationBytes    = 64 << 10
	cacheControlNoStoreValue = "no-store"
)

// CacheNotifier 只暴露唤醒 worker 所需的最小能力；*jobs.Manager 可直接使用。
type CacheNotifier interface {
	Notify()
}

var _ CacheNotifier = (*jobs.Manager)(nil)

// CacheOptions 构造缓存管理 API。认证与 CSRF 由调用方注入；Jobs 可为空，
// 此时仅依赖 worker 轮询。
type CacheOptions struct {
	Store       *store.Store
	Jobs        CacheNotifier
	CacheDir    string
	RequireAuth Middleware
	RequireCSRF Middleware
	Logger      *slog.Logger
}

// CacheHandlers 是服务端阅读派生缓存用量与清理 API。
type CacheHandlers struct {
	Store       *store.Store
	Jobs        CacheNotifier
	CacheDir    string
	RequireAuth Middleware
	RequireCSRF Middleware
	Logger      *slog.Logger
}

// NewCacheHandlers 校验依赖并规范化缓存根目录。
func NewCacheHandlers(options CacheOptions) (*CacheHandlers, error) {
	if options.Store == nil {
		return nil, errors.New("httpapi: cache store 不能为空")
	}
	cacheDir := strings.TrimSpace(options.CacheDir)
	if cacheDir == "" {
		return nil, errors.New("httpapi: cache 目录不能为空")
	}
	absolute, err := filepath.Abs(cacheDir)
	if err != nil {
		return nil, errors.New("httpapi: cache 目录无法解析")
	}
	cleaned := filepath.Clean(absolute)
	if cleaned == string(filepath.Separator) {
		return nil, errors.New("httpapi: cache 目录不能是根目录")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &CacheHandlers{
		Store:       options.Store,
		Jobs:        options.Jobs,
		CacheDir:    cleaned,
		RequireAuth: options.RequireAuth,
		RequireCSRF: options.RequireCSRF,
		Logger:      logger,
	}, nil
}

type cacheUsageDTO struct {
	DerivedBytes int64          `json:"derivedBytes"`
	Entries      int64          `json:"entries"`
	ByKind       cacheByKindDTO `json:"byKind"`
	Task         *taskDTO       `json:"task"`
}

type cacheByKindDTO struct {
	Covers jobs.CacheKindUsage `json:"covers"`
	Comic  jobs.CacheKindUsage `json:"comic"`
}

type cacheClearRequest struct {
	Scope string `json:"scope"`
}

type cacheClearResponse struct {
	TaskID string `json:"taskId"`
}

// RegisterCacheRoutes 注册缓存用量与清理路由。方法校验在 handler 内完成，
// 以便返回统一 JSON 405 包络。
func (h *CacheHandlers) RegisterCacheRoutes(mux *http.ServeMux) {
	if h == nil || mux == nil {
		return
	}
	mux.Handle("/api/v1/cache/usage", h.secured(h.handleUsage, false))
	mux.Handle("/api/v1/cache/clear", h.secured(h.handleClear, true))
}

// RegisterCacheRoutes 是便于集成的包级入口。
func RegisterCacheRoutes(mux *http.ServeMux, handlers *CacheHandlers) {
	if handlers != nil {
		handlers.RegisterCacheRoutes(mux)
	}
}

func (h *CacheHandlers) secured(next http.HandlerFunc, csrf bool) http.Handler {
	var handler http.Handler = next
	if csrf {
		handler = h.withCSRF(handler)
	}
	handler = h.withAuth(handler)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", cacheControlNoStoreValue)
		handler.ServeHTTP(w, r)
	})
}

func (h *CacheHandlers) withAuth(next http.Handler) http.Handler {
	if h == nil || h.RequireAuth == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.writeCacheError(w, r, http.StatusUnauthorized, "unauthenticated", "需要登录", nil)
		})
	}
	return h.RequireAuth(next)
}

func (h *CacheHandlers) withCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if h == nil || h.RequireCSRF == nil {
			h.writeCacheError(w, r, http.StatusForbidden, "forbidden", "CSRF 校验失败",
				map[string]any{"reason": "csrf_invalid"})
			return
		}
		h.RequireCSRF(next).ServeHTTP(w, r)
	})
}

func (h *CacheHandlers) handleUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, r, "GET")
		return
	}
	if h == nil || h.Store == nil {
		h.internalError(w, r, "缓存存储未配置", errors.New("cache store is nil"))
		return
	}
	usage, err := jobs.MeasureDerivedCache(h.CacheDir)
	if err != nil {
		h.internalError(w, r, "读取缓存用量失败", err)
		return
	}
	task, found, err := h.Store.LatestCacheClearTask(r.Context())
	if err != nil {
		h.internalError(w, r, "读取缓存清理任务失败", err)
		return
	}
	var taskValue *taskDTO
	if found {
		dto := toTaskDTO(task)
		taskValue = &dto
	}
	writeJSON(w, http.StatusOK, dataEnvelope{Data: cacheUsageDTO{
		DerivedBytes: usage.DerivedBytes,
		Entries:      usage.Entries,
		ByKind: cacheByKindDTO{
			Covers: usage.ByKind[jobs.CacheKindCovers],
			Comic:  usage.ByKind[jobs.CacheKindComic],
		},
		Task: taskValue,
	}})
}

func (h *CacheHandlers) handleClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, r, "POST")
		return
	}
	if h == nil || h.Store == nil {
		h.internalError(w, r, "缓存存储未配置", errors.New("cache store is nil"))
		return
	}
	scope, ok := h.readClearScope(w, r)
	if !ok {
		return
	}
	if scope != jobs.CacheScopeReadingDerived {
		h.writeCacheError(w, r, http.StatusBadRequest, "invalid_request", "不支持的缓存清理范围",
			map[string]any{"field": "scope"})
		return
	}
	task, _, err := h.Store.CreateCacheClearTask(r.Context())
	if err != nil {
		h.logger().Error("创建缓存清理任务失败", "error", err, "requestId", requestIDFromRequest(r))
		h.writeCacheError(w, r, http.StatusServiceUnavailable, "cache_clear_failed",
			"缓存清理暂时不可用，可稍后重试", map[string]any{"reason": "unavailable"})
		return
	}
	if h.Jobs != nil {
		h.Jobs.Notify()
	}
	writeJSON(w, http.StatusAccepted, dataEnvelope{Data: cacheClearResponse{TaskID: task.ID}})
}

func (h *CacheHandlers) readClearScope(w http.ResponseWriter, r *http.Request) (string, bool) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		h.writeCacheError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type",
			"仅支持 application/json", nil)
		return "", false
	}
	if r.ContentLength > maxCacheMutationBytes {
		h.writeCacheError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large",
			"请求体超过 64 KiB", nil)
		return "", false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxCacheMutationBytes+1))
	if err != nil {
		h.writeCacheError(w, r, http.StatusBadRequest, "invalid_request", "读取请求体失败", nil)
		return "", false
	}
	if len(body) > maxCacheMutationBytes {
		h.writeCacheError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large",
			"请求体超过 64 KiB", nil)
		return "", false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var request cacheClearRequest
	if err := decoder.Decode(&request); err != nil {
		h.writeCacheError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return "", false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		h.writeCacheError(w, r, http.StatusBadRequest, "invalid_request", "JSON 后存在多余内容", nil)
		return "", false
	}
	if strings.TrimSpace(request.Scope) == "" {
		h.writeCacheError(w, r, http.StatusBadRequest, "invalid_request", "缺少 scope",
			map[string]any{"field": "scope"})
		return "", false
	}
	return request.Scope, true
}

func (h *CacheHandlers) writeCacheError(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
	if details == nil {
		details = struct{}{}
	}
	writeJSON(w, status, errorEnvelope{Error: errorPayload{
		Code:      code,
		Message:   message,
		RequestID: requestIDFromRequest(r),
		Details:   details,
	}})
}

func (h *CacheHandlers) logger() *slog.Logger {
	if h != nil && h.Logger != nil {
		return h.Logger
	}
	return slog.Default()
}

func (h *CacheHandlers) internalError(w http.ResponseWriter, r *http.Request, logMessage string, err error) {
	h.logger().Error(logMessage, "error", err, "requestId", requestIDFromRequest(r))
	h.writeCacheError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
}
