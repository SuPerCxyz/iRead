// Package pdf 提供 PDF 原件的安全读取与 HTTP Range/条件请求处理。
//
// 本包只负责服务原始字节：不解析 PDF、不生成派生资源，也不把文件挂到
// 静态目录。文件路径来自服务端登记（book_files.storage_rel_path），并在
// books 根目录内通过 os.Root 安全打开。
package pdf

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"iread/server/internal/store"
)

const (
	// ContentPath 是 PDF 原件流端点；Go 1.22+ ServeMux 通配符语法。
	ContentPath = "/api/v1/books/{bookId}/versions/{fileVersion}/content"

	// MediaType 是 PDF 原件的固定媒体类型。
	MediaType = "application/pdf"

	contentCacheControl = "private, no-cache, no-transform"

	// 多段 Range 的防御上限：避免恶意请求通过大量分段放大 multipart 头或
	// 读取次数。合法客户端通常只需单段或少量分段。
	maxRangeHeaderBytes = 4096
	maxRangeSpecs       = 8
)

var (
	// ErrBookNotFound 表示书籍或原件登记不存在。
	ErrBookNotFound = errors.New("pdf: book not found")
	// ErrContentNotFound 表示书籍存在但没有可用的 PDF 原件。
	ErrContentNotFound = errors.New("pdf: pdf content not found")

	errUnsafeContentPath = errors.New("pdf: unsafe content path")
)

// Source 是服务端登记的原件元数据；StorageRelPath 不是客户端输入。
type Source struct {
	StorageRelPath string
	ByteSize       int64
	SHA256         string
}

// Resolver 读取当前原件登记；fileVersion 比较由 HTTP 层完成。
type Resolver interface {
	ResolveContent(ctx context.Context, bookID string) (Source, error)
}

// StoreResolver 从 book_files 表读取 PDF 原件。
type StoreResolver struct {
	Store *store.Store
}

// NewStoreResolver 构造基于 SQLite 的 resolver。
func NewStoreResolver(database *store.Store) *StoreResolver {
	return &StoreResolver{Store: database}
}

// ResolveContent 读取书籍当前原件；非 PDF 或缺少登记时按不存在处理。
func (r *StoreResolver) ResolveContent(ctx context.Context, bookID string) (Source, error) {
	if r == nil || r.Store == nil {
		return Source{}, ErrContentNotFound
	}
	file, err := r.Store.BookFileByBookID(ctx, bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		return Source{}, ErrBookNotFound
	}
	if err != nil {
		return Source{}, fmt.Errorf("pdf: 读取原件登记失败: %w", err)
	}
	if file.Extension != "pdf" {
		return Source{}, ErrContentNotFound
	}
	return Source{
		StorageRelPath: file.StorageRelPath,
		ByteSize:       file.ByteSize,
		SHA256:         file.SHA256,
	}, nil
}

// Options 构造 PDF 原件处理器。
type Options struct {
	Resolver Resolver
	BooksDir string
	Logger   *slog.Logger
}

// Handler 处理 GET/HEAD 原件字节与 Range/条件请求。
type Handler struct {
	resolver Resolver
	booksDir string
	logger   *slog.Logger
}

// NewHandler 构造处理器；booksDir 必须是已存在的绝对目录。
func NewHandler(options Options) (*Handler, error) {
	if options.Resolver == nil {
		return nil, errors.New("pdf: resolver 不能为空")
	}
	if strings.TrimSpace(options.BooksDir) == "" {
		return nil, errors.New("pdf: books 目录不能为空")
	}
	booksDir, err := filepath.Abs(options.BooksDir)
	if err != nil {
		return nil, fmt.Errorf("pdf: books 目录无法解析: %w", err)
	}
	info, err := os.Stat(booksDir)
	if err != nil {
		return nil, fmt.Errorf("pdf: books 目录不可用: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("pdf: books 路径不是目录")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{
		resolver: options.Resolver,
		booksDir: booksDir,
		logger:   logger,
	}, nil
}

// ServeHTTP 实现 http.Handler。认证由外层注入的中间件负责。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		h.writeError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持")
		return
	}

	bookID, fileVersion, ok := parseContentPath(r)
	if !ok {
		h.writeError(w, r, http.StatusNotFound, "not_found", "PDF 原件不存在")
		return
	}

	source, err := h.resolver.ResolveContent(r.Context(), bookID)
	if err != nil {
		switch {
		case errors.Is(err, ErrBookNotFound), errors.Is(err, ErrContentNotFound):
			h.writeError(w, r, http.StatusNotFound, "not_found", "PDF 原件不存在")
		default:
			h.logger.Error("读取 PDF 原件登记失败", "bookId", bookID, "error", err)
			h.writeError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		}
		return
	}
	if !validLowerHex(source.SHA256, 64) || source.ByteSize <= 0 {
		h.logger.Error("PDF 原件登记字段无效", "bookId", bookID)
		h.writeError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if source.SHA256 != fileVersion {
		h.writeError(w, r, http.StatusConflict, "file_version_conflict", "PDF 原件版本已变化，请重新加载书籍")
		return
	}

	file, info, err := h.openSource(source)
	if err != nil {
		if errors.Is(err, errUnsafeContentPath) {
			h.logger.Error("PDF 原件存储路径越界", "bookId", bookID)
			h.writeError(w, r, http.StatusNotFound, "not_found", "PDF 原件不存在")
			return
		}
		h.logger.Error("打开 PDF 原件失败", "bookId", bookID, "error", err)
		h.writeError(w, r, http.StatusServiceUnavailable, "storage_unavailable", "存储暂不可用")
		return
	}
	defer file.Close()

	if info.Size() != source.ByteSize {
		h.logger.Error("PDF 原件大小与登记不一致", "bookId", bookID)
		h.writeError(w, r, http.StatusServiceUnavailable, "storage_unavailable", "存储暂不可用")
		return
	}

	etag := `"` + source.SHA256 + `"`
	w.Header().Set("Content-Type", MediaType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", contentCacheControl)
	w.Header().Del("Content-Encoding")
	w.Header().Del("Content-Disposition")

	if r.Method == http.MethodGet && rejectUnboundedRange(w, r, info.Size(), etag, info.ModTime()) {
		return
	}

	// HEAD 只描述完整表示，不把 Range 当分页传输。ServeContent 自身会为
	// HEAD 解析 Range，因此这里显式去掉 Range，仅保留条件请求语义。
	serveRequest := r
	if r.Method == http.MethodHead {
		serveRequest = r.Clone(r.Context())
		serveRequest.Header.Del("Range")
	}

	http.ServeContent(w, serveRequest, "content.pdf", info.ModTime(), file)
}

func (h *Handler) openSource(source Source) (*os.File, os.FileInfo, error) {
	rel, err := safeRelPath(source.StorageRelPath)
	if err != nil {
		return nil, nil, err
	}

	joined := filepath.Join(h.booksDir, filepath.FromSlash(rel))
	within, err := filepath.Rel(h.booksDir, joined)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return nil, nil, errUnsafeContentPath
	}

	root, err := os.OpenRoot(h.booksDir)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()

	file, err := root.Open(filepath.FromSlash(rel))
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, fmt.Errorf("pdf: 原件不是普通文件")
	}
	return file, info, nil
}

// safeRelPath 只接受 books 根内的相对存储路径。服务端登记路径由 bookId/
// 哈希/扩展名组成，不应出现反斜杠、百分号编码或 ".." 段。
func safeRelPath(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) || strings.ContainsRune(rel, 0) ||
		strings.Contains(rel, `\`) || strings.Contains(rel, "%") {
		return "", errUnsafeContentPath
	}
	for _, segment := range strings.Split(rel, "/") {
		if segment == ".." {
			return "", errUnsafeContentPath
		}
	}
	cleaned := filepath.Clean(rel)
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) ||
		strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errUnsafeContentPath
	}
	for _, segment := range strings.Split(cleaned, string(filepath.Separator)) {
		if segment == ".." || segment == "" {
			return "", errUnsafeContentPath
		}
	}
	return cleaned, nil
}

// parseContentPath 解析并校验路由参数；无效 ID 一律按 404 处理，避免把
// 路径形状或内部状态暴露给客户端。
func parseContentPath(r *http.Request) (string, string, bool) {
	escaped := strings.ToLower(r.URL.EscapedPath())
	if strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") {
		return "", "", false
	}

	const prefix = "/api/v1/books/"
	path := r.URL.Path
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(parts) != 4 || parts[1] != "versions" || parts[3] != "content" {
		return "", "", false
	}
	bookID, fileVersion := parts[0], parts[2]
	if !validLowerHex(bookID, 32) || !validLowerHex(fileVersion, 64) {
		return "", "", false
	}
	return bookID, fileVersion, true
}

func validLowerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

// rejectUnboundedRange 拒绝明显滥用的多段 Range，同时遵守条件请求和
// If-Range 的优先级：条件命中时仍交给 ServeContent 返回 304/412，If-Range
// 不匹配时仍返回完整 200。
func rejectUnboundedRange(w http.ResponseWriter, r *http.Request, size int64, etag string, modTime time.Time) bool {
	rawRange := r.Header.Get("Range")
	if !rangeNeedsLimit(rawRange) {
		return false
	}
	if ifRange := strings.TrimSpace(r.Header.Get("If-Range")); ifRange != "" &&
		!ifRangeMatches(ifRange, etag, modTime) {
		return false
	}
	if preconditionStatus(r, etag, modTime) != 0 {
		return false
	}

	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "请求范围不可满足", http.StatusRequestedRangeNotSatisfiable)
	return true
}

func rangeNeedsLimit(raw string) bool {
	if raw == "" {
		return false
	}
	if len(raw) > maxRangeHeaderBytes {
		return true
	}
	if !strings.HasPrefix(raw, "bytes=") {
		// 交给 ServeContent 按协议返回 416。
		return false
	}
	count := 0
	for _, part := range strings.Split(strings.TrimPrefix(raw, "bytes="), ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		count++
		if count > maxRangeSpecs {
			return true
		}
	}
	return false
}

func ifRangeMatches(value, etag string, modTime time.Time) bool {
	if strings.HasPrefix(value, "W/") {
		return false
	}
	if strings.HasPrefix(value, `"`) {
		return value == etag
	}
	parsed, err := http.ParseTime(value)
	if err != nil {
		return false
	}
	return modTime.UTC().Truncate(time.Second).Equal(parsed.UTC())
}

// preconditionStatus 仅用于多段 Range 拒绝前的条件优先级判断；普通请求
// 仍由 http.ServeContent 完成 RFC 9110 条件处理。
func preconditionStatus(r *http.Request, etag string, modTime time.Time) int {
	modTime = modTime.UTC().Truncate(time.Second)
	if match := r.Header.Get("If-Match"); match != "" {
		if !etagListMatches(match, etag, false) {
			return http.StatusPreconditionFailed
		}
	} else if value := r.Header.Get("If-Unmodified-Since"); value != "" {
		if parsed, err := http.ParseTime(value); err == nil && modTime.After(parsed.UTC()) {
			return http.StatusPreconditionFailed
		}
	}

	if none := r.Header.Get("If-None-Match"); none != "" {
		if etagListMatches(none, etag, true) {
			return http.StatusNotModified
		}
	} else if value := r.Header.Get("If-Modified-Since"); value != "" {
		if parsed, err := http.ParseTime(value); err == nil && !modTime.After(parsed.UTC()) {
			return http.StatusNotModified
		}
	}
	return 0
}

func etagListMatches(header, etag string, weakOK bool) bool {
	header = strings.TrimSpace(header)
	if header == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if strings.HasPrefix(candidate, "W/") {
			if !weakOK {
				continue
			}
			candidate = strings.TrimPrefix(candidate, "W/")
		}
		if candidate == etag {
			return true
		}
	}
	return false
}

func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	payload := struct {
		Error struct {
			Code      string         `json:"code"`
			Message   string         `json:"message"`
			RequestID string         `json:"requestId"`
			Details   map[string]any `json:"details"`
		} `json:"error"`
	}{}
	payload.Error.Code = code
	payload.Error.Message = message
	payload.Error.RequestID = w.Header().Get("X-Request-Id")
	payload.Error.Details = map[string]any{}

	body, err := json.Marshal(payload)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
	_, _ = w.Write([]byte("\n"))
}
