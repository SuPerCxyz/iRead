package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"iread/server/internal/library"
)

const (
	maxCreateUploadBodyBytes int64 = 64 << 10
	defaultBookListLimit           = 24
	maxBookListLimit               = 100
	uploadIdleTimeout              = 5 * time.Minute
	uploadTotalTimeout             = 30 * time.Minute
)

// Middleware 是认证/CSRF 依赖的注入形态；由集成方提供真实实现。
type Middleware func(http.Handler) http.Handler

// LibraryOptions 构造书库 HTTP 处理器。
type LibraryOptions struct {
	Service     *library.Service
	Logger      *slog.Logger
	RequireAuth Middleware
	RequireCSRF Middleware
}

// LibraryHandlers 暴露上传与书库只读端点；不修改阶段1 Server 结构。
type LibraryHandlers struct {
	service     *library.Service
	logger      *slog.Logger
	requireAuth Middleware
	requireCSRF Middleware
}

// NewLibraryHandlers 构造处理器；缺失认证/CSRF 依赖时按拒绝一切处理（fail closed）。
func NewLibraryHandlers(options LibraryOptions) (*LibraryHandlers, error) {
	if options.Service == nil {
		return nil, errors.New("httpapi: library service 不能为空")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &LibraryHandlers{
		service:     options.Service,
		logger:      logger,
		requireAuth: options.RequireAuth,
		requireCSRF: options.RequireCSRF,
	}, nil
}

// RegisterLibraryRoutes 在给定 mux 上注册上传与书库路由。
func (h *LibraryHandlers) RegisterLibraryRoutes(mux *http.ServeMux) {
	if h == nil || mux == nil {
		return
	}
	mux.Handle("/api/v1/uploads", h.authenticated(http.HandlerFunc(h.handleUploadCollection)))
	mux.Handle("/api/v1/uploads/", h.authenticated(http.HandlerFunc(h.handleUploadItem)))
	mux.Handle("/api/v1/books", h.authenticated(http.HandlerFunc(h.handleBookCollection)))
	mux.Handle("/api/v1/books/", h.authenticated(http.HandlerFunc(h.handleBookItem)))
	mux.Handle("/api/v1/settings/library", h.authenticated(http.HandlerFunc(h.handleLibrarySettings)))
}

// RegisterLibraryRoutes 是方法版本的包级包装，便于集成方按函数名接线。
func RegisterLibraryRoutes(mux *http.ServeMux, handlers *LibraryHandlers) {
	if handlers != nil {
		handlers.RegisterLibraryRoutes(mux)
	}
}

func (h *LibraryHandlers) authenticated(next http.Handler) http.Handler {
	if h.requireAuth == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeLibraryError(w, r, http.StatusUnauthorized, "unauthenticated", "需要登录", nil)
		})
	}
	return h.requireAuth(next)
}

func (h *LibraryHandlers) mutation(next http.HandlerFunc) http.Handler {
	if h.requireCSRF == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeLibraryError(w, r, http.StatusForbidden, "forbidden", "CSRF 校验失败",
				map[string]any{"reason": "csrf_invalid"})
		})
	}
	return h.requireCSRF(next)
}

func writeLibraryData(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, dataEnvelope{Data: data})
}

func writeLibraryError(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
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

func (h *LibraryHandlers) writeServiceError(w http.ResponseWriter, r *http.Request, apiErr *library.Error) {
	details := map[string]any{}
	if apiErr.Reason != "" {
		details["reason"] = apiErr.Reason
	}
	var payload any = details
	if len(details) == 0 {
		payload = nil
	}
	writeLibraryError(w, r, apiErr.Status, apiErr.Code, apiErr.Message, payload)
}

// ---------- 上传 ----------

type createUploadRequest struct {
	ClientUploadID *string `json:"clientUploadId"`
	FileName       *string `json:"fileName"`
	ByteSize       *int64  `json:"byteSize"`
}

func (h *LibraryHandlers) handleUploadCollection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
		return
	}
	h.mutation(http.HandlerFunc(h.createUpload)).ServeHTTP(w, r)
}

func (h *LibraryHandlers) createUpload(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeLibraryError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type", "仅支持 application/json", nil)
		return
	}
	if r.ContentLength > maxCreateUploadBodyBytes {
		writeLibraryError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 64 KiB", nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxCreateUploadBodyBytes+1))
	if err != nil {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "读取请求体失败", nil)
		return
	}
	if int64(len(body)) > maxCreateUploadBodyBytes {
		writeLibraryError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 64 KiB", nil)
		return
	}
	var request createUploadRequest
	if err := decodeStrictJSON(body, &request); err != nil {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return
	}
	details := map[string]any{}
	if request.ClientUploadID == nil || request.FileName == nil || request.ByteSize == nil {
		switch {
		case request.ClientUploadID == nil:
			details["field"] = "clientUploadId"
		case request.FileName == nil:
			details["field"] = "fileName"
		default:
			details["field"] = "byteSize"
		}
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "缺少必要字段", details)
		return
	}
	intent, created, apiErr := h.service.CreateUploadIntent(r.Context(), *request.ClientUploadID, *request.FileName, *request.ByteSize)
	if apiErr != nil {
		h.writeServiceError(w, r, apiErr)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeLibraryData(w, status, uploadDTOFrom(intent))
}

func (h *LibraryHandlers) handleUploadItem(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/api/v1/uploads/")
	parts := strings.Split(suffix, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeLibraryError(w, r, http.StatusNotFound, "not_found", "上传不存在", nil)
		return
	}
	uploadID := parts[0]
	switch {
	case len(parts) == 1:
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
			return
		}
		h.getUpload(w, r, uploadID)
	case len(parts) == 2 && parts[1] == "content":
		if r.Method != http.MethodPut {
			w.Header().Set("Allow", "PUT")
			writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
			return
		}
		h.mutation(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.putUploadContent(w, r, uploadID)
		})).ServeHTTP(w, r)
	case len(parts) == 2 && parts[1] == "cancel":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
			return
		}
		h.mutation(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.cancelUpload(w, r, uploadID)
		})).ServeHTTP(w, r)
	default:
		writeLibraryError(w, r, http.StatusNotFound, "not_found", "上传不存在", nil)
	}
}

func (h *LibraryHandlers) getUpload(w http.ResponseWriter, r *http.Request, uploadID string) {
	intent, apiErr := h.service.GetUpload(r.Context(), uploadID)
	if apiErr != nil {
		h.writeServiceError(w, r, apiErr)
		return
	}
	writeLibraryData(w, http.StatusOK, uploadDTOFrom(intent))
}

func (h *LibraryHandlers) putUploadContent(w http.ResponseWriter, r *http.Request, uploadID string) {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))), "multipart/") {
		writeLibraryError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type",
			"上传接口只接受原始字节流，不接受 multipart", nil)
		return
	}
	controller := http.NewResponseController(w)
	totalDeadline := time.Now().Add(uploadTotalTimeout)
	_ = controller.SetReadDeadline(totalDeadline)
	// 大文件上传可能持续到总时限；延长写截止时间，确保成功响应还能写回。
	_ = controller.SetWriteDeadline(totalDeadline.Add(time.Minute))
	body := &deadlineReader{
		body:     r.Body,
		control:  controller,
		idle:     uploadIdleTimeout,
		deadline: totalDeadline,
	}
	defer func() {
		_ = controller.SetReadDeadline(time.Time{})
		_ = controller.SetWriteDeadline(time.Time{})
	}()

	intent, apiErr := h.service.UploadContent(r.Context(), library.UploadContentInput{
		UploadID:      uploadID,
		ContentLength: r.ContentLength,
		ContentType:   r.Header.Get("Content-Type"),
		Body:          body,
	})
	if apiErr != nil {
		h.writeServiceError(w, r, apiErr)
		return
	}
	writeLibraryData(w, http.StatusOK, uploadDTOFrom(intent))
}

func (h *LibraryHandlers) cancelUpload(w http.ResponseWriter, r *http.Request, uploadID string) {
	intent, apiErr := h.service.CancelUpload(r.Context(), uploadID)
	if apiErr != nil {
		h.writeServiceError(w, r, apiErr)
		return
	}
	writeLibraryData(w, http.StatusOK, uploadDTOFrom(intent))
}

type deadlineReader struct {
	body     io.Reader
	control  *http.ResponseController
	idle     time.Duration
	deadline time.Time
}

func (d *deadlineReader) Read(p []byte) (int, error) {
	next := time.Now().Add(d.idle)
	if !d.deadline.IsZero() && next.After(d.deadline) {
		next = d.deadline
	}
	_ = d.control.SetReadDeadline(next)
	return d.body.Read(p)
}
