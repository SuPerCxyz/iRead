// Package httpapi 的漫画 manifest 与按页资源端点。
//
// 本文件只新增路由与 handler，不修改 server.go；统一 manifest dispatcher
// 接线时应调用 ServeComicManifest / ServeComicPage；独立注册时使用
// RegisterComicRoutes。
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"

	"iread/server/internal/reader/comic"
	"iread/server/internal/store"
)

const (
	// ComicManifestPath 与共享 manifest 端点形状一致。
	ComicManifestPath = "/api/v1/books/{bookId}/manifest"
	// ComicResourcePath 是漫画页资源的规范形状。
	ComicResourcePath = "/api/v1/books/{bookId}/versions/{fileVersion}/resources/{resourceId}"
)

var (
	// ErrComicBookNotFound 表示书籍或原件登记不存在。
	ErrComicBookNotFound = errors.New("httpapi: comic book not found")
	// ErrComicManifestPersist 表示漫画 manifest 无法持久化。
	ErrComicManifestPersist = errors.New("httpapi: comic manifest persist failed")
)

// ComicBook 是漫画 manifest 解析结果：原件定位信息加书籍状态。
// 状态只来自服务端登记，不来自客户端，用于统一可读状态门禁。
type ComicBook struct {
	Source           comic.Source
	Status           string
	ExtractionStatus string
}

// ComicBookResolver 把 bookId 解析为服务端登记的原件信息。
type ComicBookResolver interface {
	ResolveComicBook(ctx context.Context, bookID string) (comic.Source, error)
}

// ComicBookStateResolver 是可选的扩展接口。实现方在原件信息之外提供服务端
// 登记状态；未实现时保持仅按原件解析的兼容行为。
type ComicBookStateResolver interface {
	ResolveComicBookState(ctx context.Context, bookID string) (ComicBook, error)
}

// ComicStoreResolver 从 SQLite 的 books/book_files 读取当前原件。
type ComicStoreResolver struct {
	store *store.Store
}

// NewComicStoreResolver 构造默认 resolver。
func NewComicStoreResolver(database *store.Store) *ComicStoreResolver {
	return &ComicStoreResolver{store: database}
}

// ResolveComicBook 读取当前书籍详情；未知书籍返回 comic.ErrBookNotFound。
func (r *ComicStoreResolver) ResolveComicBook(ctx context.Context, bookID string) (comic.Source, error) {
	book, err := r.ResolveComicBookState(ctx, bookID)
	if err != nil {
		return comic.Source{}, err
	}
	return book.Source, nil
}

// ResolveComicBookState 在原件信息之外返回 books.status 与提取状态。
func (r *ComicStoreResolver) ResolveComicBookState(ctx context.Context, bookID string) (ComicBook, error) {
	if r == nil || r.store == nil {
		return ComicBook{}, ErrComicBookNotFound
	}
	detail, err := r.store.GetBookDetail(ctx, bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		return ComicBook{}, ErrComicBookNotFound
	}
	if err != nil {
		return ComicBook{}, err
	}
	return ComicBook{
		Source: comic.Source{
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
func (h *ComicHandlers) resolveBook(ctx context.Context, bookID string) (ComicBook, error) {
	if resolver, ok := h.resolver.(ComicBookStateResolver); ok {
		return resolver.ResolveComicBookState(ctx, bookID)
	}
	source, err := h.resolver.ResolveComicBook(ctx, bookID)
	if err != nil {
		return ComicBook{}, err
	}
	return ComicBook{Source: source}, nil
}

// ComicOptions 是漫画 handler 的依赖。
type ComicOptions struct {
	Resolver    ComicBookResolver
	Store       *store.Store
	BooksDir    string
	CacheDir    string
	Logger      *slog.Logger
	RequireAuth Middleware
}

// ComicHandlers 注册漫画 manifest 与页资源路由。
type ComicHandlers struct {
	resolver    ComicBookResolver
	store       *store.Store
	builder     *comic.Builder
	logger      *slog.Logger
	requireAuth Middleware
}

// NewComicHandlers 构造 handler；依赖缺失或目录不可用时返回错误。
func NewComicHandlers(options ComicOptions) (*ComicHandlers, error) {
	if options.Resolver == nil {
		return nil, errors.New("httpapi: comic resolver 不能为空")
	}
	if options.Store == nil {
		return nil, errors.New("httpapi: comic store 不能为空")
	}
	builder, err := comic.NewBuilder(options.BooksDir, options.CacheDir)
	if err != nil {
		return nil, err
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &ComicHandlers{
		resolver:    options.Resolver,
		store:       options.Store,
		builder:     builder,
		logger:      logger,
		requireAuth: options.RequireAuth,
	}, nil
}

// Close 释放漫画索引器持有的 RAR 会话与文件句柄。
func (h *ComicHandlers) Close() error {
	if h == nil || h.builder == nil {
		return nil
	}
	return h.builder.Close()
}

// RegisterComicRoutes 在 mux 上注册漫画 manifest 与页端点。
//
// 注意：共享资源路径与 EPUB 的 ReaderResourcePrefix 重叠。本函数用于独立
// 接入/测试；生产统一 dispatcher 应按格式调用 ServeComicManifest /
// ServeComicPage，而不是同时注册两套资源路由。
func (h *ComicHandlers) RegisterComicRoutes(mux *http.ServeMux) {
	if h == nil || mux == nil {
		return
	}
	mux.Handle("GET "+ComicManifestPath, h.authenticated(http.HandlerFunc(h.HandleManifest)))
	mux.Handle("GET "+ComicResourcePath, h.authenticated(http.HandlerFunc(h.HandleResource)))
}

// RegisterComicRoutes 是包级包装，便于集成方按函数名接线。
func RegisterComicRoutes(mux *http.ServeMux, handlers *ComicHandlers) {
	if handlers != nil {
		handlers.RegisterComicRoutes(mux)
	}
}

func (h *ComicHandlers) authenticated(next http.Handler) http.Handler {
	if h.requireAuth == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeComicError(w, r, http.StatusUnauthorized, "unauthenticated", "请先登录", nil)
		})
	}
	return h.requireAuth(next)
}

// HandleManifest 解析 bookId 后提供漫画 manifest。
func (h *ComicHandlers) HandleManifest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	bookID, ok := parseComicManifestPath(r)
	if !ok {
		writeComicError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	book, err := h.resolveBook(r.Context(), bookID)
	if err != nil {
		h.writeResolveError(w, r, bookID, err)
		return
	}
	h.ServeComicManifest(w, r, book)
}

// ServeComicManifest 是统一 dispatcher 的漫画 manifest 入口。调用方必须
// 已完成认证与 bookId 归属检查。
func (h *ComicHandlers) ServeComicManifest(w http.ResponseWriter, r *http.Request, book ComicBook) {
	source := book.Source
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeComicError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
		return
	}
	if source.Format != comic.FormatCBZ && source.Format != comic.FormatCBR {
		writeComicError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持漫画阅读", map[string]string{"reason": "unsupported_format"})
		return
	}
	if requested := strings.TrimSpace(r.URL.Query().Get("fileVersion")); requested != "" &&
		requested != source.FileVersion {
		writeComicError(w, r, http.StatusConflict, "file_version_conflict",
			"原件版本已变化，请重新加载书籍", map[string]string{"current": source.FileVersion})
		return
	}

	state := readerReadStateFor(source.Format, book.Status, book.ExtractionStatus)
	if state.unreadable {
		writeReaderUnreadable(w, r, state)
		return
	}

	manifest, err := h.Manifest(r.Context(), source)
	if err != nil {
		// CBR 索引失败时先让 C6 针对原件给出真实原因；只有未知错误才回退
		// index_failed，已有稳定映射的加密/多卷/不安全/损坏/超时照常返回。
		if state.probeParser && !comicManifestErrorMapped(err) {
			h.logger.Warn("CBR 索引失败且解析器未给出稳定原因，回退 index_failed",
				"bookId", source.BookID, "error", err)
			writeReaderUnreadable(w, r, readerReadState{reason: "index_failed", unreadable: true})
			return
		}
		h.writeComicManifestError(w, r, source.BookID, err)
		return
	}
	if state.probeParser {
		// 归档可解析不等于索引成功：books.status=error 说明 book.index 已失败，
		// 不能借 manifest 的即时解析把失败书籍改报为可读。
		writeReaderUnreadable(w, r, readerReadState{reason: "index_failed", unreadable: true})
		return
	}
	if state.reason == "not_ready" {
		manifest.ReadingCapabilities.CanRead = false
		manifest.ReadingCapabilities.UnavailableReason = "not_ready"
		manifest.ReadingCapabilities.Features = []string{}
	}
	writeReaderManifestJSON(w, http.StatusOK, struct {
		Data comic.Manifest `json:"data"`
	}{Data: manifest})
}

// Manifest 读取与当前 fileVersion/indexVersion 匹配的持久化记录；缺失或
// 版本过期时按需构建并写回 book_manifests。
func (h *ComicHandlers) Manifest(ctx context.Context, source comic.Source) (comic.Manifest, error) {
	stored, found, err := h.store.GetBookManifest(ctx, source.BookID)
	if err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			return comic.Manifest{}, ErrComicBookNotFound
		}
		return comic.Manifest{}, err
	}
	if found && stored.FileVersion == source.FileVersion && stored.Format == source.Format &&
		stored.IndexVersion == source.IndexVersion && stored.SchemaVersion == comic.ManifestSchemaVersion {
		var manifest comic.Manifest
		if json.Unmarshal(stored.ManifestJSON, &manifest) == nil && manifest.ValidFor(source) {
			return manifest, nil
		}
	}

	manifest, err := h.builder.Build(ctx, source)
	if err != nil {
		return comic.Manifest{}, err
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return comic.Manifest{}, ErrComicManifestPersist
	}
	if _, err := h.store.UpsertBookManifest(ctx, store.BookManifest{
		BookID:        source.BookID,
		FileVersion:   source.FileVersion,
		Format:        source.Format,
		IndexVersion:  source.IndexVersion,
		SchemaVersion: comic.ManifestSchemaVersion,
		ManifestJSON:  raw,
	}); err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			return comic.Manifest{}, ErrComicBookNotFound
		}
		return comic.Manifest{}, errors.Join(ErrComicManifestPersist, err)
	}
	return manifest, nil
}

// HandleResource 解析 bookId/fileVersion/resourceId 后提供漫画页。
func (h *ComicHandlers) HandleResource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	bookID, fileVersion, resourceID, ok := parseComicResourcePath(r)
	if !ok {
		writeComicError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
		return
	}
	book, err := h.resolveBook(r.Context(), bookID)
	if err != nil {
		h.writeResolveError(w, r, bookID, err)
		return
	}
	h.ServeComicPage(w, r, book.Source, fileVersion, resourceID)
}

// ServeComicPage 是统一 dispatcher 的漫画页入口。调用方必须已完成认证与
// bookId 归属检查。
func (h *ComicHandlers) ServeComicPage(w http.ResponseWriter, r *http.Request,
	source comic.Source, fileVersion, resourceID string) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeComicError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
		return
	}
	variant, ok := parseComicVariant(r)
	if !ok {
		writeComicError(w, r, http.StatusBadRequest, "invalid_request",
			"variant 只支持 screen 或 original", map[string]string{"parameter": "variant"})
		return
	}
	if source.Format != comic.FormatCBZ && source.Format != comic.FormatCBR {
		writeComicError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持漫画阅读", map[string]string{"reason": "unsupported_format"})
		return
	}
	if !strings.EqualFold(fileVersion, source.FileVersion) {
		writeComicError(w, r, http.StatusConflict, "file_version_conflict",
			"原件版本已变化，请重新加载书籍", map[string]string{"current": source.FileVersion})
		return
	}
	if !validReaderManifestHex(resourceID, 32) {
		writeComicError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
		return
	}
	resourceID = strings.ToLower(resourceID)

	manifest, err := h.Manifest(r.Context(), source)
	if err != nil {
		h.writeComicManifestError(w, r, source.BookID, err)
		return
	}
	page, found := comic.PageByResourceID(manifest, resourceID)
	if !found {
		writeComicError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
		return
	}

	switch variant {
	case comic.VariantScreen:
		h.serveComicScreen(w, r, source, page)
	case comic.VariantOriginal:
		h.serveComicOriginal(w, r, source, page)
	}
}

func (h *ComicHandlers) serveComicScreen(w http.ResponseWriter, r *http.Request, source comic.Source, page comic.Page) {
	screen, err := h.builder.EnsureScreen(r.Context(), source, page)
	if err != nil {
		h.writeComicPageError(w, r, source.BookID, comic.VariantScreen, err)
		return
	}
	etag := screen.ETag
	w.Header().Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	file, err := os.Open(screen.Path)
	if err != nil {
		h.logger.Error("打开漫画 screen 缓存失败", "bookId", source.BookID, "error", err)
		writeComicError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", comic.MediaTypeJPEG)
	w.Header().Set("Content-Length", strconv.FormatInt(screen.Size, 10))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Accept-Ranges", "none")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, file); err != nil {
		h.logger.Debug("读取漫画 screen 缓存中断", "bookId", source.BookID, "error", err)
	}
}

func (h *ComicHandlers) serveComicOriginal(w http.ResponseWriter, r *http.Request, source comic.Source, page comic.Page) {
	if !comic.OriginalPageAvailable(page) {
		writeComicError(w, r, http.StatusConflict, "variant_unavailable",
			"该页不提供原始尺寸", map[string]string{"variant": comic.VariantOriginal, "reason": "too_large"})
		return
	}
	etag := comic.OriginalETag(source.FileVersion, page.ResourceID)
	w.Header().Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", page.MediaType)
		w.Header().Set("Content-Length", strconv.FormatInt(page.Size, 10))
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Accept-Ranges", "none")
		w.WriteHeader(http.StatusOK)
		return
	}
	data, err := h.builder.OpenOriginal(r.Context(), source, page)
	if err != nil {
		h.writeComicPageError(w, r, source.BookID, comic.VariantOriginal, err)
		return
	}
	w.Header().Set("Content-Type", page.MediaType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Accept-Ranges", "none")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		h.logger.Debug("写入漫画 original 页中断", "bookId", source.BookID, "error", err)
	}
}

func (h *ComicHandlers) writeResolveError(w http.ResponseWriter, r *http.Request, bookID string, err error) {
	if errors.Is(err, ErrComicBookNotFound) || errors.Is(err, comic.ErrBookNotFound) {
		writeComicError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	h.logger.Error("读取漫画书籍登记失败", "bookId", bookID, "error", err)
	writeComicError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
}

func (h *ComicHandlers) writeComicManifestError(w http.ResponseWriter, r *http.Request, bookID string, err error) {
	switch {
	case errors.Is(err, ErrComicBookNotFound), errors.Is(err, comic.ErrBookNotFound):
		writeComicError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
	case errors.Is(err, comic.ErrParserTimeout), errors.Is(err, context.DeadlineExceeded):
		writeComicError(w, r, http.StatusServiceUnavailable, "parser_timeout",
			"解析超时，请稍后重试", map[string]string{"reason": "parser_timeout"})
	case errors.Is(err, comic.ErrUnsupportedFormat):
		writeComicError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持漫画阅读", map[string]string{"reason": "unsupported_format"})
	case errors.Is(err, comic.ErrUnsupportedArchive), errors.Is(err, comic.ErrEncryptedArchive),
		errors.Is(err, comic.ErrUnsafeArchive), errors.Is(err, comic.ErrArchiveLimit),
		errors.Is(err, comic.ErrInvalidArchive):
		writeComicError(w, r, http.StatusConflict, "book_not_readable",
			"该书无法解析，不能打开", map[string]string{"reason": comic.Reason(err)})
	case errors.Is(err, comic.ErrStorageUnavailable):
		writeComicError(w, r, http.StatusServiceUnavailable, "storage_unavailable", "存储暂不可用", nil)
	case errors.Is(err, ErrComicManifestPersist):
		h.logger.Error("持久化漫画 manifest 失败", "bookId", bookID, "error", err)
		writeComicError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
	default:
		h.logger.Error("构建漫画 manifest 失败", "bookId", bookID, "error", err)
		writeComicError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
	}
}

func (h *ComicHandlers) writeComicPageError(w http.ResponseWriter, r *http.Request, bookID, variant string, err error) {
	switch {
	case errors.Is(err, comic.ErrPageNotFound):
		writeComicError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
	case errors.Is(err, comic.ErrVariantUnavailable):
		writeComicError(w, r, http.StatusConflict, "variant_unavailable",
			"该页不提供原始尺寸", map[string]string{"variant": variant, "reason": "too_large"})
	case errors.Is(err, comic.ErrParserTimeout), errors.Is(err, context.DeadlineExceeded):
		writeComicError(w, r, http.StatusServiceUnavailable, "parser_timeout",
			"解析超时，请稍后重试", map[string]string{"reason": "parser_timeout"})
	case errors.Is(err, comic.ErrUnsupportedFormat):
		writeComicError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持漫画阅读", map[string]string{"reason": "unsupported_format"})
	case errors.Is(err, comic.ErrUnsupportedArchive), errors.Is(err, comic.ErrEncryptedArchive),
		errors.Is(err, comic.ErrUnsafeArchive), errors.Is(err, comic.ErrArchiveLimit),
		errors.Is(err, comic.ErrInvalidArchive):
		writeComicError(w, r, http.StatusConflict, "book_not_readable",
			"该书无法解析，不能打开", map[string]string{"reason": comic.Reason(err)})
	case errors.Is(err, comic.ErrStorageUnavailable):
		writeComicError(w, r, http.StatusServiceUnavailable, "storage_unavailable", "存储暂不可用", nil)
	default:
		h.logger.Error("读取漫画页失败", "bookId", bookID, "error", err)
		writeComicError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
	}
}

func parseComicManifestPath(r *http.Request) (string, bool) {
	if comicEscapedPathUnsafe(r) {
		return "", false
	}
	bookID := r.PathValue("bookId")
	if bookID == "" {
		const prefix = "/api/v1/books/"
		if !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, "/manifest") {
			return "", false
		}
		bookID = strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), "/manifest")
		if strings.Contains(bookID, "/") {
			return "", false
		}
	}
	if !validReaderManifestHex(bookID, 32) {
		return "", false
	}
	return strings.ToLower(bookID), true
}

func parseComicResourcePath(r *http.Request) (bookID, fileVersion, resourceID string, ok bool) {
	if comicEscapedPathUnsafe(r) {
		return "", "", "", false
	}
	bookID = r.PathValue("bookId")
	fileVersion = r.PathValue("fileVersion")
	resourceID = r.PathValue("resourceId")
	if bookID == "" || fileVersion == "" || resourceID == "" {
		const prefix = "/api/v1/books/"
		if !strings.HasPrefix(r.URL.Path, prefix) {
			return "", "", "", false
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, prefix), "/")
		if len(parts) != 5 || parts[1] != "versions" || parts[3] != "resources" {
			return "", "", "", false
		}
		bookID, fileVersion, resourceID = parts[0], parts[2], parts[4]
	}
	if !validReaderManifestHex(bookID, 32) || !validReaderManifestHex(fileVersion, 64) ||
		!validReaderManifestHex(resourceID, 32) {
		return "", "", "", false
	}
	return strings.ToLower(bookID), strings.ToLower(fileVersion), strings.ToLower(resourceID), true
}

func comicEscapedPathUnsafe(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return true
	}
	escaped := strings.ToLower(r.URL.EscapedPath())
	return strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") ||
		strings.Contains(escaped, "%00")
}

func parseComicVariant(r *http.Request) (string, bool) {
	values, present := r.URL.Query()["variant"]
	if !present || len(values) == 0 || values[0] == "" {
		return comic.VariantScreen, true
	}
	if len(values) > 1 {
		return "", false
	}
	switch values[0] {
	case comic.VariantScreen:
		return comic.VariantScreen, true
	case comic.VariantOriginal:
		return comic.VariantOriginal, true
	default:
		return "", false
	}
}

func etagMatches(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || candidate == etag {
			return true
		}
		if strings.HasPrefix(candidate, "W/") && strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

func writeComicError(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
	writeReaderManifestError(w, r, status, code, message, details)
}
