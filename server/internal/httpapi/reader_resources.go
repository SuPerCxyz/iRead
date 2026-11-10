package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"iread/server/internal/reader/epub"
)

func (h *ReaderManifestHandlers) handleResource(w http.ResponseWriter, r *http.Request) {
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

	book, err := h.resolveBook(r.Context(), bookID)
	if err != nil {
		if errors.Is(err, ErrReaderManifestBookNotFound) {
			writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
			return
		}
		h.logger.Error("读取阅读器资源书籍登记失败", "bookId", bookID, "error", err)
		writeReaderManifestError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
		return
	}
	source := book.Source
	if source.Format != epub.FormatEPUB {
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持阅读", map[string]string{"reason": "unsupported_format"})
		return
	}
	if fileVersion != source.FileVersion {
		writeReaderManifestError(w, r, http.StatusConflict, "file_version_conflict",
			"原件版本已变化，请重新加载书籍", map[string]string{"current": source.FileVersion})
		return
	}

	manifest, err := h.ensureManifest(r.Context(), source)
	if err != nil {
		h.writeManifestBuildError(w, r, source.BookID, err)
		return
	}
	stream, err := h.builder.OpenResource(r.Context(), source, manifest, resourceID)
	if err != nil {
		h.writeResourceError(w, r, source.BookID, err)
		return
	}
	defer stream.Close()

	w.Header().Set("Content-Type", stream.ContentType)
	w.Header().Set("Content-Length", strconv.FormatInt(stream.Size, 10))
	w.Header().Set("Cache-Control", "private, no-store")
	setReaderResourceSecurityHeaders(w, stream.ContentType)
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, stream); err != nil {
		// 响应头已发送，无法再改状态；记录服务端错误，客户端会看到截断。
		h.logger.Debug("读取 EPUB 资源中断", "bookId", source.BookID, "error", err)
	}
}

// readerResourceSandboxCSP 是可直接当作文档打开的 EPUB 资源的强制策略。
// 即使攻击者在 EPUB 内放入 <script>、onerror 或 SVG script，直接访问资源 URL
// 时也无法执行脚本、访问应用同源或发起网络请求。Reader 内部的 Blob/iframe
// 渲染仍由客户端自己的 meta CSP 约束，本策略不改变资源字节。
const readerResourceSandboxCSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

// setReaderResourceSecurityHeaders 为成功返回的 EPUB 资源补齐安全响应头。
// 所有资源都禁止 MIME 嗅探并显式 inline；只有浏览器可直接打开并可能执行
// 脚本的类型才附加 sandbox CSP，避免影响图片/字体的缓存与 Content-Type。
func setReaderResourceSecurityHeaders(w http.ResponseWriter, contentType string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	if readerResourceRunsScript(contentType) {
		w.Header().Set("Content-Security-Policy", readerResourceSandboxCSP)
	}
}

// readerResourceRunsScript 判断资源被浏览器直接打开时是否可能执行书内脚本。
// 当前资源端点白名单中的可脚本类型只有 XHTML/HTML 与 SVG；新增白名单类型
// 时必须同步检查这里。
func readerResourceRunsScript(contentType string) bool {
	if index := strings.IndexByte(contentType, ';'); index >= 0 {
		contentType = contentType[:index]
	}
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "application/xhtml+xml", "text/html", "application/html+xml", "image/svg+xml":
		return true
	default:
		return false
	}
}

func (h *ReaderManifestHandlers) writeResourceError(w http.ResponseWriter, r *http.Request, bookID string, err error) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		writeReaderManifestError(w, r, http.StatusServiceUnavailable, "parser_timeout",
			"解析超时，请稍后重试", map[string]string{"reason": "parser_timeout"})
	case errors.Is(err, epub.ErrContentEncrypted), errors.Is(err, epub.ErrObfuscationUnavailable):
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书受加密保护，不能打开", map[string]string{"reason": "drm_protected"})
	case errors.Is(err, epub.ErrResourceNotFound), errors.Is(err, epub.ErrUnsupportedResource):
		writeReaderManifestError(w, r, http.StatusNotFound, "not_found", "资源不存在", nil)
	case errors.Is(err, epub.ErrInvalidBook):
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书无法解析，不能打开", map[string]string{"reason": "invalid_epub"})
	case errors.Is(err, epub.ErrUnsupportedFormat):
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			"该书格式暂不支持阅读", map[string]string{"reason": "unsupported_format"})
	case errors.Is(err, epub.ErrStorageUnavailable):
		writeReaderManifestError(w, r, http.StatusServiceUnavailable, "storage_unavailable",
			"存储暂不可用", nil)
	default:
		h.logger.Error("读取 EPUB 资源失败", "bookId", bookID, "error", err)
		writeReaderManifestError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
	}
}

func parseReaderResourcePath(r *http.Request) (bookID, fileVersion, resourceID string, ok bool) {
	escaped := strings.ToLower(r.URL.EscapedPath())
	if strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") ||
		strings.Contains(escaped, "%00") {
		return "", "", "", false
	}
	const prefix = "/api/v1/books/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		return "", "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, prefix), "/")
	if len(parts) != 5 || parts[1] != "versions" || parts[3] != "resources" {
		return "", "", "", false
	}
	bookID, fileVersion, resourceID = parts[0], parts[2], parts[4]
	if !validReaderManifestHex(bookID, 32) || !validReaderManifestHex(fileVersion, 64) ||
		!validReaderManifestHex(resourceID, 32) {
		return "", "", "", false
	}
	return strings.ToLower(bookID), strings.ToLower(fileVersion), strings.ToLower(resourceID), true
}
