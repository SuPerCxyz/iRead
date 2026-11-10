package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"iread/server/internal/reader/comic"
	"iread/server/internal/store"
)

// ReaderDispatchOptions 是统一阅读器 manifest/资源分发的依赖。
type ReaderDispatchOptions struct {
	Store       *store.Store
	Manifest    *ReaderManifestHandlers
	Comic       *ComicHandlers
	Logger      *slog.Logger
	RequireAuth Middleware
}

// ReaderDispatch 按书籍格式把共享 manifest/资源路径分发给 EPUB、漫画或 PDF。
//
// EPUB 与漫画的独立 Register*Routes 不能同时挂在同一个 ServeMux 上：两者的
// manifest 路径相同，资源路径也会互相遮蔽。生产 Server 只注册本 dispatcher，
// 各格式 handler 只负责已解析书籍之后的格式逻辑。
type ReaderDispatch struct {
	store       *store.Store
	manifest    *ReaderManifestHandlers
	comic       *ComicHandlers
	logger      *slog.Logger
	requireAuth Middleware
}

// NewReaderDispatch 构造统一分发器；缺少 Store 或 EPUB handler 时返回错误。
func NewReaderDispatch(options ReaderDispatchOptions) (*ReaderDispatch, error) {
	if options.Store == nil {
		return nil, errors.New("httpapi: reader dispatch store 不能为空")
	}
	if options.Manifest == nil {
		return nil, errors.New("httpapi: reader dispatch manifest handler 不能为空")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &ReaderDispatch{
		store:       options.Store,
		manifest:    options.Manifest,
		comic:       options.Comic,
		logger:      logger,
		requireAuth: options.RequireAuth,
	}, nil
}

// RegisterReaderRoutes 注册唯一的 manifest 与资源路由。
//
// manifest 使用精确模式；资源使用带尾部斜杠的子树模式，让多余段/编码斜杠
// 也进入统一 JSON 404，而不是落回书库的 /api/v1/books/ 子路由。
func (d *ReaderDispatch) RegisterReaderRoutes(mux *http.ServeMux) {
	if d == nil || mux == nil {
		return
	}
	mux.Handle(ReaderManifestPath, d.authenticated(http.HandlerFunc(d.handleManifest)))
	mux.Handle(ReaderResourcePrefix, d.authenticated(http.HandlerFunc(d.handleResource)))
}

// RegisterReaderRoutes 是包级包装，便于集成方按函数名接线。
func RegisterReaderRoutes(mux *http.ServeMux, dispatch *ReaderDispatch) {
	if dispatch != nil {
		dispatch.RegisterReaderRoutes(mux)
	}
}

func (d *ReaderDispatch) authenticated(next http.Handler) http.Handler {
	if d.requireAuth == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeReaderManifestError(w, r, http.StatusUnauthorized, "unauthenticated", "请先登录", nil)
		})
	}
	return d.requireAuth(next)
}

func (d *ReaderDispatch) handleManifest(w http.ResponseWriter, r *http.Request) {
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
	detail, ok := d.resolveBook(w, r, bookID)
	if !ok {
		return
	}
	if requested := strings.TrimSpace(r.URL.Query().Get("fileVersion")); requested != "" &&
		requested != detail.File.SHA256 {
		writeReaderManifestError(w, r, http.StatusConflict, "file_version_conflict",
			"原件版本已变化，请重新加载书籍", map[string]string{"current": detail.File.SHA256})
		return
	}

	switch detail.Format {
	case "epub":
		d.manifest.handleManifest(w, r)
	case comic.FormatCBZ, comic.FormatCBR:
		if d.comic == nil {
			d.writeReaderUnavailable(w, r)
			return
		}
		d.comic.ServeComicManifest(w, r, comicSource(detail))
	case "pdf":
		d.writePDFManifest(w, r, detail)
	default:
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持阅读", map[string]string{"reason": "unsupported_format"})
	}
}

func (d *ReaderDispatch) handleResource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeReaderManifestError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
		return
	}
	bookID, fileVersion, resourceID, ok := parseReaderResourcePath(r)
	if !ok {
		writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
		return
	}
	detail, ok := d.resolveBook(w, r, bookID)
	if !ok {
		return
	}
	if !strings.EqualFold(fileVersion, detail.File.SHA256) {
		writeReaderManifestError(w, r, http.StatusConflict, "file_version_conflict",
			"原件版本已变化，请重新加载书籍", map[string]string{"current": detail.File.SHA256})
		return
	}

	switch detail.Format {
	case "epub":
		d.manifest.handleResource(w, r)
	case comic.FormatCBZ, comic.FormatCBR:
		if d.comic == nil {
			d.writeReaderUnavailable(w, r)
			return
		}
		d.comic.ServeComicPage(w, r, comicSource(detail).Source, fileVersion, resourceID)
	case "pdf":
		// PDF 没有派生资源；原件只通过 /content 提供。
		writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
	default:
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持阅读", map[string]string{"reason": "unsupported_format"})
	}
}

func (d *ReaderDispatch) resolveBook(w http.ResponseWriter, r *http.Request,
	bookID string) (store.BookDetail, bool) {
	detail, err := d.store.GetBookDetail(r.Context(), bookID)
	if err == nil {
		return detail, true
	}
	if errors.Is(err, store.ErrBookNotFound) {
		writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return store.BookDetail{}, false
	}
	d.logger.Error("读取阅读器书籍登记失败", "bookId", bookID, "error", err)
	writeReaderManifestError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
	return store.BookDetail{}, false
}

func (d *ReaderDispatch) writeReaderUnavailable(w http.ResponseWriter, r *http.Request) {
	writeReaderManifestError(w, r, http.StatusServiceUnavailable, "storage_unavailable",
		"阅读服务暂不可用", map[string]string{"reason": "reader_unavailable"})
}

func comicSource(detail store.BookDetail) ComicBook {
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
	}
}
