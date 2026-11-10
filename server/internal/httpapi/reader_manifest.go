// Package httpapi 的阅读器 manifest 与 EPUB 资源端点。
//
// 本文件只新增路由与 handler，不修改 server.go；集成方通过
// RegisterReaderManifestRoutes 接线，测试可直接构造 handler 调用。
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"iread/server/internal/reader/epub"
	"iread/server/internal/store"
)

const (
	// ReaderManifestPath 是 EPUB manifest 端点。
	ReaderManifestPath = "/api/v1/books/{bookId}/manifest"
	// ReaderResourcePath 是 EPUB 单资源端点的规范形状。
	ReaderResourcePath = "/api/v1/books/{bookId}/versions/{fileVersion}/resources/{resourceId}"
	// ReaderResourcePrefix 是资源路由前缀；用子树匹配让带编码斜杠或多余段
	// 的穿越请求也进入统一 JSON 404，而不是落到 ServeMux 的纯文本 404。
	ReaderResourcePrefix = "/api/v1/books/{bookId}/versions/{fileVersion}/resources/"
)

var (
	// ErrReaderManifestBookNotFound 表示书籍或原件登记不存在。
	ErrReaderManifestBookNotFound = errors.New("httpapi: reader manifest book not found")
	// ErrReaderManifestPersist 表示 manifest 无法持久化。
	ErrReaderManifestPersist = errors.New("httpapi: reader manifest persist failed")
)

// ManifestBook 是 manifest 解析结果：原件定位信息加书籍状态。
// 状态只来自服务端登记，不来自客户端，用于统一可读状态门禁。
type ManifestBook struct {
	Source           epub.Source
	Status           string
	ExtractionStatus string
}

// ReaderManifestBookResolver 把 bookId 解析为服务端登记的原件信息。
// 客户端不能提供 storage path 或 fileVersion。
type ReaderManifestBookResolver interface {
	ResolveManifestBook(ctx context.Context, bookID string) (epub.Source, error)
}

// ReaderManifestBookStateResolver 是可选的扩展接口。实现方在原件信息之外
// 提供服务端登记状态，用于统一 manifest 可读门禁；未实现时保持仅按原件
// 解析的兼容行为。
type ReaderManifestBookStateResolver interface {
	ResolveManifestBookState(ctx context.Context, bookID string) (ManifestBook, error)
}

// ReaderManifestStoreResolver 从 SQLite 的 books/book_files 读取当前原件。
type ReaderManifestStoreResolver struct {
	store *store.Store
}

// NewReaderManifestStoreResolver 构造默认 resolver。
func NewReaderManifestStoreResolver(database *store.Store) *ReaderManifestStoreResolver {
	return &ReaderManifestStoreResolver{store: database}
}

// ResolveManifestBook 读取当前书籍详情；未知书籍返回 ErrReaderManifestBookNotFound。
func (r *ReaderManifestStoreResolver) ResolveManifestBook(ctx context.Context, bookID string) (epub.Source, error) {
	book, err := r.ResolveManifestBookState(ctx, bookID)
	if err != nil {
		return epub.Source{}, err
	}
	return book.Source, nil
}

// ResolveManifestBookState 在原件信息之外返回 books.status 与提取状态。
func (r *ReaderManifestStoreResolver) ResolveManifestBookState(ctx context.Context, bookID string) (ManifestBook, error) {
	if r == nil || r.store == nil {
		return ManifestBook{}, ErrReaderManifestBookNotFound
	}
	detail, err := r.store.GetBookDetail(ctx, bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		return ManifestBook{}, ErrReaderManifestBookNotFound
	}
	if err != nil {
		return ManifestBook{}, err
	}
	return ManifestBook{
		Source: epub.Source{
			BookID:         detail.BookID,
			FileVersion:    detail.File.SHA256,
			Format:         detail.Format,
			StorageRelPath: detail.File.StorageRelPath,
			IndexVersion:   detail.IndexVersion,
			ByteSize:       detail.ByteSize,
		},
		Status:           detail.Status,
		ExtractionStatus: detail.Metadata.ExtractionStatus,
	}, nil
}

// resolveBook 优先使用可选状态 resolver；自定义 resolver 未实现时保持兼容。
func (h *ReaderManifestHandlers) resolveBook(ctx context.Context, bookID string) (ManifestBook, error) {
	if resolver, ok := h.resolver.(ReaderManifestBookStateResolver); ok {
		return resolver.ResolveManifestBookState(ctx, bookID)
	}
	source, err := h.resolver.ResolveManifestBook(ctx, bookID)
	if err != nil {
		return ManifestBook{}, err
	}
	return ManifestBook{Source: source}, nil
}

// ReaderManifestOptions 是阅读器资源 handler 的依赖。
type ReaderManifestOptions struct {
	Resolver    ReaderManifestBookResolver
	Store       *store.Store
	BooksDir    string
	Logger      *slog.Logger
	RequireAuth Middleware
}

// ReaderManifestHandlers 注册 GET manifest 与 GET 资源路由。
type ReaderManifestHandlers struct {
	resolver    ReaderManifestBookResolver
	store       *store.Store
	builder     *epub.Builder
	logger      *slog.Logger
	requireAuth Middleware
}

// NewReaderManifestHandlers 构造 handler；依赖缺失或 books 目录不可用时返回错误。
func NewReaderManifestHandlers(options ReaderManifestOptions) (*ReaderManifestHandlers, error) {
	if options.Resolver == nil {
		return nil, errors.New("httpapi: reader manifest resolver 不能为空")
	}
	if options.Store == nil {
		return nil, errors.New("httpapi: reader manifest store 不能为空")
	}
	builder, err := epub.NewBuilder(options.BooksDir)
	if err != nil {
		return nil, err
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &ReaderManifestHandlers{
		resolver:    options.Resolver,
		store:       options.Store,
		builder:     builder,
		logger:      logger,
		requireAuth: options.RequireAuth,
	}, nil
}

// RegisterReaderManifestRoutes 在 mux 上注册 manifest 与资源端点。
func (h *ReaderManifestHandlers) RegisterReaderManifestRoutes(mux *http.ServeMux) {
	if h == nil || mux == nil {
		return
	}
	mux.Handle(ReaderManifestPath, h.authenticated(http.HandlerFunc(h.handleManifest)))
	mux.Handle(ReaderResourcePrefix, h.authenticated(http.HandlerFunc(h.handleResource)))
}

// RegisterReaderManifestRoutes 是包级包装，便于集成方按函数名接线。
func RegisterReaderManifestRoutes(mux *http.ServeMux, handlers *ReaderManifestHandlers) {
	if handlers != nil {
		handlers.RegisterReaderManifestRoutes(mux)
	}
}

func (h *ReaderManifestHandlers) authenticated(next http.Handler) http.Handler {
	if h.requireAuth == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeReaderManifestError(w, r, http.StatusUnauthorized, "unauthenticated", "请先登录", nil)
		})
	}
	return h.requireAuth(next)
}

func (h *ReaderManifestHandlers) handleManifest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeReaderManifestError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
		return
	}
	bookID, ok := parseReaderManifestPath(r)
	if !ok {
		writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}

	book, err := h.resolveBook(r.Context(), bookID)
	if err != nil {
		if errors.Is(err, ErrReaderManifestBookNotFound) {
			writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
			return
		}
		h.logger.Error("读取阅读器书籍登记失败", "bookId", bookID, "error", err)
		writeReaderManifestError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
		return
	}
	source := book.Source
	if requested := strings.TrimSpace(r.URL.Query().Get("fileVersion")); requested != "" &&
		requested != source.FileVersion {
		writeReaderManifestError(w, r, http.StatusConflict, "file_version_conflict",
			"原件版本已变化，请重新加载书籍", map[string]string{"current": source.FileVersion})
		return
	}
	if source.Format != epub.FormatEPUB {
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持阅读", map[string]string{"reason": "unsupported_format"})
		return
	}

	state := readerReadStateFor(source.Format, book.Status, book.ExtractionStatus)
	if state.unreadable {
		writeReaderUnreadable(w, r, state)
		return
	}

	manifest, err := h.ensureManifest(r.Context(), source)
	if err != nil {
		h.writeManifestBuildError(w, r, source.BookID, err)
		return
	}
	// 构建结果仍可能发现内容加密（例如历史登记状态不准确），此时必须按
	// 永久不可读返回 409，而不是用 200+canRead=false 冒充已打开。
	if !manifest.ReadingCapabilities.CanRead {
		reason := manifest.ReadingCapabilities.UnavailableReason
		if reason == "" {
			reason = "drm_protected"
		}
		writeReaderUnreadable(w, r, readerReadState{reason: reason, unreadable: true})
		return
	}
	if state.reason == "not_ready" {
		manifest.ReadingCapabilities.CanRead = false
		manifest.ReadingCapabilities.UnavailableReason = "not_ready"
		manifest.ReadingCapabilities.Features = []string{}
	}
	writeReaderManifestJSON(w, http.StatusOK, struct {
		Data epub.Manifest `json:"data"`
	}{Data: manifest})
}

// ensureManifest 先读取与当前 fileVersion/indexVersion 匹配的持久化记录；
// 缺失或版本过期时按需构建并写回 book_manifests。
func (h *ReaderManifestHandlers) ensureManifest(ctx context.Context, source epub.Source) (epub.Manifest, error) {
	stored, found, err := h.store.GetBookManifest(ctx, source.BookID)
	if err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			return epub.Manifest{}, ErrReaderManifestBookNotFound
		}
		return epub.Manifest{}, err
	}
	if found && stored.FileVersion == source.FileVersion && stored.Format == epub.FormatEPUB &&
		stored.IndexVersion == source.IndexVersion && stored.SchemaVersion == epub.ManifestSchemaVersion {
		var manifest epub.Manifest
		if json.Unmarshal(stored.ManifestJSON, &manifest) == nil &&
			manifest.SchemaVersion == epub.ManifestSchemaVersion &&
			manifest.BookID == source.BookID && manifest.FileVersion == source.FileVersion &&
			manifest.Format == epub.FormatEPUB && manifest.IndexVersion == source.IndexVersion &&
			manifest.FormatData.Resources != nil {
			return manifest, nil
		}
	}

	manifest, err := h.builder.Build(ctx, source)
	if err != nil {
		return epub.Manifest{}, err
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return epub.Manifest{}, ErrReaderManifestPersist
	}
	if _, err := h.store.UpsertBookManifest(ctx, store.BookManifest{
		BookID:        source.BookID,
		FileVersion:   source.FileVersion,
		Format:        epub.FormatEPUB,
		IndexVersion:  source.IndexVersion,
		SchemaVersion: epub.ManifestSchemaVersion,
		ManifestJSON:  raw,
	}); err != nil {
		return epub.Manifest{}, errors.Join(ErrReaderManifestPersist, err)
	}
	return manifest, nil
}

func (h *ReaderManifestHandlers) writeManifestBuildError(w http.ResponseWriter, r *http.Request, bookID string, err error) {
	switch {
	case errors.Is(err, ErrReaderManifestBookNotFound):
		writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
	case errors.Is(err, context.DeadlineExceeded):
		writeReaderManifestError(w, r, http.StatusServiceUnavailable, "parser_timeout",
			"解析超时，请稍后重试", map[string]string{"reason": "parser_timeout"})
	case errors.Is(err, epub.ErrInvalidBook):
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书无法解析，不能打开", map[string]string{"reason": "invalid_epub"})
	case errors.Is(err, epub.ErrUnsupportedFormat):
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持阅读", map[string]string{"reason": "unsupported_format"})
	case errors.Is(err, epub.ErrStorageUnavailable):
		writeReaderManifestError(w, r, http.StatusServiceUnavailable, "storage_unavailable",
			"存储暂不可用", nil)
	case errors.Is(err, ErrReaderManifestPersist):
		h.logger.Error("持久化阅读器 manifest 失败", "bookId", bookID, "error", err)
		writeReaderManifestError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
	default:
		h.logger.Error("构建阅读器 manifest 失败", "bookId", bookID, "error", err)
		writeReaderManifestError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
	}
}

func parseReaderManifestPath(r *http.Request) (string, bool) {
	escaped := strings.ToLower(r.URL.EscapedPath())
	if strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") ||
		strings.Contains(escaped, "%00") {
		return "", false
	}
	const prefix = "/api/v1/books/"
	if !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, "/manifest") {
		return "", false
	}
	bookID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), "/manifest")
	if bookID == "" || strings.Contains(bookID, "/") || !validReaderManifestHex(bookID, 32) {
		return "", false
	}
	return strings.ToLower(bookID), true
}

func validReaderManifestHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') &&
			(character < 'A' || character > 'F') {
			return false
		}
	}
	return true
}

func writeReaderManifestJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	writeJSON(w, status, payload)
}

func writeReaderManifestError(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
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
