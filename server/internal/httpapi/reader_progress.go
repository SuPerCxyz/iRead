package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"time"

	"iread/server/internal/reader/progress"
	"iread/server/internal/store"
)

const readerMaxBodyBytes = 1 << 20 // 1 MiB

// ReaderBookRef 是阅读器数据端点的当前原件身份。
type ReaderBookRef struct {
	BookID      string
	FileVersion string
	Format      string
}

// ReaderBookResolver 提供当前原件版本与格式；未知书籍返回 store.ErrBookNotFound。
type ReaderBookResolver interface {
	ResolveReaderBook(ctx context.Context, bookID string) (ReaderBookRef, error)
}

// StoreReaderBookResolver 使用书籍详情中的原件 SHA-256 与格式作为身份。
type StoreReaderBookResolver struct {
	Store *store.Store
}

// ResolveReaderBook 实现 ReaderBookResolver。
func (r StoreReaderBookResolver) ResolveReaderBook(ctx context.Context, bookID string) (ReaderBookRef, error) {
	detail, err := r.Store.GetBookDetail(ctx, bookID)
	if err != nil {
		return ReaderBookRef{}, err
	}
	return ReaderBookRef{
		BookID:      detail.BookID,
		FileVersion: detail.File.SHA256,
		Format:      detail.Format,
	}, nil
}

// ReaderDataOptions 构造阅读器进度/书签/设置 HTTP 处理器。
type ReaderDataOptions struct {
	Store        *store.Store
	BookResolver ReaderBookResolver
	RequireAuth  Middleware
	RequireCSRF  Middleware
	Logger       *slog.Logger
}

// ReaderDataHandlers 只包含阅读器数据端点，不注册阅读引擎/资源/Range。
type ReaderDataHandlers struct {
	store        *store.Store
	bookResolver ReaderBookResolver
	logger       *slog.Logger
	requireAuth  Middleware
	requireCSRF  Middleware
}

// NewReaderDataHandlers 构造处理器；缺失认证/CSRF 依赖时按拒绝一切处理（fail closed）。
func NewReaderDataHandlers(options ReaderDataOptions) (*ReaderDataHandlers, error) {
	if options.Store == nil {
		return nil, errors.New("httpapi: reader store 不能为空")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	resolver := options.BookResolver
	if resolver == nil {
		resolver = StoreReaderBookResolver{Store: options.Store}
	}
	return &ReaderDataHandlers{
		store:        options.Store,
		bookResolver: resolver,
		logger:       logger,
		requireAuth:  options.RequireAuth,
		requireCSRF:  options.RequireCSRF,
	}, nil
}

// RegisterReaderDataRoutes 注册进度、书签、全局与单书阅读设置路由。
// 不修改阶段1 Server；由集成方在 mux 上显式调用。
func (h *ReaderDataHandlers) RegisterReaderDataRoutes(mux *http.ServeMux) {
	if h == nil || mux == nil {
		return
	}
	mux.Handle("/api/v1/settings/reader", h.authenticated(http.HandlerFunc(h.handleGlobalReaderSettings)))
	mux.Handle("/api/v1/books/{bookId}/progress", h.authenticated(http.HandlerFunc(h.handleProgress)))
	mux.Handle("/api/v1/books/{bookId}/bookmarks", h.authenticated(http.HandlerFunc(h.handleBookmarkCollection)))
	mux.Handle("/api/v1/books/{bookId}/bookmarks/{bookmarkId}", h.authenticated(http.HandlerFunc(h.handleBookmarkItem)))
	mux.Handle("/api/v1/books/{bookId}/reader-settings", h.authenticated(http.HandlerFunc(h.handleBookReaderSettings)))
	// 兼容既有阅读器前端与 contracts 早先使用的 /reader-overrides 路径；
	// 两者指向同一稀疏覆盖资源，避免同一本书出现两套设置。
	mux.Handle("/api/v1/books/{bookId}/reader-overrides", h.authenticated(http.HandlerFunc(h.handleBookReaderSettings)))
}

// RegisterReaderDataRoutes 是方法版本的包级包装，便于集成方按函数名接线。
func RegisterReaderDataRoutes(mux *http.ServeMux, handlers *ReaderDataHandlers) {
	if handlers != nil {
		handlers.RegisterReaderDataRoutes(mux)
	}
}

func (h *ReaderDataHandlers) authenticated(next http.Handler) http.Handler {
	if h.requireAuth == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeReaderError(w, r, http.StatusUnauthorized, "unauthenticated", "需要登录", nil)
		})
	}
	return h.requireAuth(next)
}

func (h *ReaderDataHandlers) mutation(next http.Handler) http.Handler {
	if h.requireCSRF == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeReaderError(w, r, http.StatusForbidden, "forbidden", "CSRF 校验失败",
				map[string]string{"reason": "csrf_invalid"})
		})
	}
	return h.requireCSRF(next)
}

func writeReaderData(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, dataEnvelope{Data: data})
}

func writeReaderError(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
	w.Header().Set("Cache-Control", "no-store")
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

func (h *ReaderDataHandlers) internalError(w http.ResponseWriter, r *http.Request, logMessage string, err error) {
	h.logger.Error(logMessage, "error", err, "requestId", requestIDFromRequest(r))
	writeReaderError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
}

func (h *ReaderDataHandlers) resolveBook(ctx context.Context, bookID string) (ReaderBookRef, error) {
	return h.bookResolver.ResolveReaderBook(ctx, bookID)
}

// readReaderJSON 校验 application/json、限制 1 MiB 并返回原始 body。
func readReaderJSON(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeReaderError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type",
			"仅支持 application/json", nil)
		return nil, false
	}
	if r.ContentLength > readerMaxBodyBytes {
		writeReaderError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 1 MiB", nil)
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, readerMaxBodyBytes+1))
	if err != nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "读取请求体失败", nil)
		return nil, false
	}
	if len(body) > readerMaxBodyBytes {
		writeReaderError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 1 MiB", nil)
		return nil, false
	}
	return body, true
}

func writeReaderValidation(w http.ResponseWriter, r *http.Request, err error) {
	var validation *progress.ValidationError
	if errors.As(err, &validation) {
		status := http.StatusBadRequest
		code := "invalid_request"
		if validation.Unsupported {
			status = http.StatusUnprocessableEntity
			code = "unsupported_locator"
		}
		details := map[string]any{}
		if validation.Field != "" {
			details["field"] = validation.Field
		}
		writeReaderError(w, r, status, code, validation.Message, details)
		return
	}
	writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "请求参数无效", nil)
}

func validReaderID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func readingProgressDTO(record store.ReadingProgress) progress.DTO {
	return progress.DTO{
		SchemaVersion:   progress.SchemaVersion,
		BookID:          record.BookID,
		FileVersion:     record.FileVersion,
		Format:          record.Format,
		LocatorType:     record.LocatorType,
		LocatorPayload:  record.LocatorPayload,
		ProgressPercent: record.ProgressPercent,
		UpdatedAt:       record.UpdatedAt.UTC().Format(time.RFC3339),
		Revision:        formatReaderRevision(record.Revision),
	}
}

func formatReaderRevision(revision int64) string {
	return strconv.FormatInt(revision, 10)
}

func (h *ReaderDataHandlers) handleProgress(w http.ResponseWriter, r *http.Request) {
	bookID := r.PathValue("bookId")
	if !validReaderID(bookID) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.getProgress(w, r, bookID)
	case http.MethodPut:
		h.mutation(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.putProgress(w, r, bookID)
		})).ServeHTTP(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeReaderError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
	}
}

func (h *ReaderDataHandlers) getProgress(w http.ResponseWriter, r *http.Request, bookID string) {
	record, err := h.store.GetReadingProgress(r.Context(), bookID)
	if err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
			return
		}
		h.internalError(w, r, "读取阅读进度失败", err)
		return
	}
	var data any
	if record != nil {
		data = readingProgressDTO(*record)
	}
	writeReaderData(w, http.StatusOK, data)
}

func (h *ReaderDataHandlers) putProgress(w http.ResponseWriter, r *http.Request, bookID string) {
	body, ok := readReaderJSON(w, r)
	if !ok {
		return
	}
	input, err := progress.ParsePut(body)
	if err != nil {
		writeReaderValidation(w, r, err)
		return
	}
	book, err := h.resolveBook(r.Context(), bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	if err != nil {
		h.internalError(w, r, "读取书籍原件信息失败", err)
		return
	}
	if err := input.ValidateForBook(book.Format, book.FileVersion); err != nil {
		var fileVersionConflict *progress.FileVersionConflictError
		if errors.As(err, &fileVersionConflict) {
			writeReaderError(w, r, http.StatusConflict, "file_version_conflict", "原件版本已变化，请重新加载", nil)
			return
		}
		writeReaderValidation(w, r, err)
		return
	}
	locator, err := input.NormalizedLocation()
	if err != nil {
		writeReaderValidation(w, r, err)
		return
	}

	record, _, err := h.store.PutReadingProgress(r.Context(), store.PutReadingProgressParams{
		BookID:           bookID,
		FileVersion:      input.FileVersion,
		Format:           input.Format,
		LocatorType:      input.LocatorType,
		LocatorPayload:   locator,
		ProgressPercent:  input.ProgressPercent,
		BaseRevision:     input.BaseRevision,
		ClientMutationID: input.ClientMutationID,
	})
	if err != nil {
		h.writeProgressStoreError(w, r, bookID, err)
		return
	}
	writeReaderData(w, http.StatusOK, readingProgressDTO(record))
}

func (h *ReaderDataHandlers) writeProgressStoreError(w http.ResponseWriter, r *http.Request, bookID string, err error) {
	var revisionConflict *store.ProgressRevisionConflictError
	if errors.As(err, &revisionConflict) {
		var current any
		if revisionConflict.Current != nil {
			current = readingProgressDTO(*revisionConflict.Current)
		}
		writeReaderError(w, r, http.StatusConflict, "revision_conflict", "阅读进度已在另一处更新",
			map[string]any{"current": current})
		return
	}
	var stateConflict *store.ProgressStateConflictError
	if errors.As(err, &stateConflict) {
		var current any
		if stateConflict.Current != nil {
			current = readingProgressDTO(*stateConflict.Current)
		}
		writeReaderError(w, r, http.StatusConflict, "state_conflict", "提交与已记录状态冲突",
			map[string]any{"current": current})
		return
	}
	if errors.Is(err, store.ErrReaderRevisionLimit) {
		current, getErr := h.store.GetReadingProgress(r.Context(), bookID)
		var value any
		if getErr == nil && current != nil {
			value = readingProgressDTO(*current)
		}
		writeReaderError(w, r, http.StatusConflict, "revision_conflict", "阅读进度 revision 已达上限",
			map[string]any{"current": value})
		return
	}
	if errors.Is(err, store.ErrBookNotFound) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	if errors.Is(err, store.ErrReaderInvalidInput) {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "阅读进度输入无效", nil)
		return
	}
	h.internalError(w, r, "保存阅读进度失败", err)
}
