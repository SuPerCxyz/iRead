package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"time"

	"iread/server/internal/store"
)

const (
	taskSchemaVersion     = 1
	maxTaskMutationBytes  = 64 << 10
	taskCacheControlValue = "no-store"
)

// TaskOptions 构造任务 API 处理器。认证与 CSRF 由调用方注入，阶段2不在此
// 包内实现 session；未注入时按失败关闭处理。
type TaskOptions struct {
	Store       *store.Store
	RequireAuth Middleware
	RequireCSRF Middleware
	Logger      *slog.Logger
	Notify      func()
}

// TaskHandlers 是任务 API 的处理器集合。
type TaskHandlers struct {
	Store       *store.Store
	RequireAuth Middleware
	RequireCSRF Middleware
	Logger      *slog.Logger
	Notify      func()
}

// NewTaskHandlers 校验依赖并构造处理器。
func NewTaskHandlers(options TaskOptions) (*TaskHandlers, error) {
	if options.Store == nil {
		return nil, errors.New("httpapi: task store 不能为空")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &TaskHandlers{
		Store:       options.Store,
		RequireAuth: options.RequireAuth,
		RequireCSRF: options.RequireCSRF,
		Logger:      logger,
		Notify:      options.Notify,
	}, nil
}

type taskDTO struct {
	SchemaVersion         int             `json:"schemaVersion"`
	TaskID                string          `json:"taskId"`
	Kind                  string          `json:"kind"`
	BookID                *string         `json:"bookId"`
	State                 string          `json:"state"`
	Attempt               int64           `json:"attempt"`
	Revision              string          `json:"revision"`
	CancellationRequested bool            `json:"cancellationRequested"`
	Progress              taskProgressDTO `json:"progress"`
	Error                 *taskErrorDTO   `json:"error"`
	CreatedAt             string          `json:"createdAt"`
	UpdatedAt             string          `json:"updatedAt"`
}

type taskProgressDTO struct {
	Phase          string `json:"phase"`
	CompletedUnits int64  `json:"completedUnits"`
	TotalUnits     *int64 `json:"totalUnits"`
}

type taskErrorDTO struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type taskMutationRequest struct {
	BaseRevision *string `json:"baseRevision"`
}

// RegisterTaskRoutes 注册任务读取、重试与取消路由。路径使用 ServeMux 1.22
// 的 {id} 通配符；方法校验在 handler 内完成，以便返回统一 405 包络。
func (h *TaskHandlers) RegisterTaskRoutes(mux *http.ServeMux) {
	if h == nil || mux == nil {
		return
	}
	mux.Handle("/api/v1/tasks/{id}", h.secured(h.handleGetTask, false))
	mux.Handle("/api/v1/tasks/{id}/retry", h.secured(h.handleRetryTask, true))
	mux.Handle("/api/v1/tasks/{id}/cancel", h.secured(h.handleCancelTask, true))
}

// RegisterTaskRoutes 是便于集成的包级入口。
func RegisterTaskRoutes(mux *http.ServeMux, handlers *TaskHandlers) {
	if handlers != nil {
		handlers.RegisterTaskRoutes(mux)
	}
}

func (h *TaskHandlers) secured(next http.HandlerFunc, csrf bool) http.Handler {
	var handler http.Handler = next
	if csrf {
		handler = h.withCSRF(handler)
	}
	handler = h.withAuth(handler)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", taskCacheControlValue)
		handler.ServeHTTP(w, r)
	})
}

func (h *TaskHandlers) withAuth(next http.Handler) http.Handler {
	if h == nil || h.RequireAuth == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.writeTaskError(w, r, http.StatusUnauthorized, "unauthenticated", "需要登录", nil)
		})
	}
	return h.RequireAuth(next)
}

func (h *TaskHandlers) withCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 只读方法不改变状态，交给方法校验返回 405；与全局 apiGuard 的语义一致。
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if h == nil || h.RequireCSRF == nil {
			h.writeTaskError(w, r, http.StatusForbidden, "forbidden", "CSRF 校验失败",
				map[string]any{"reason": "csrf_invalid"})
			return
		}
		h.RequireCSRF(next).ServeHTTP(w, r)
	})
}

func (h *TaskHandlers) handleGetTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, r, "GET")
		return
	}
	if h == nil || h.Store == nil {
		h.internalError(w, r, "任务存储未配置", errors.New("task store is nil"))
		return
	}
	task, err := h.Store.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		h.writeTaskStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, dataEnvelope{Data: toTaskDTO(task)})
}

func (h *TaskHandlers) handleRetryTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, r, "POST")
		return
	}
	if h == nil || h.Store == nil {
		h.internalError(w, r, "任务存储未配置", errors.New("task store is nil"))
		return
	}
	baseRevision, ok := h.readBaseRevision(w, r)
	if !ok {
		return
	}
	task, err := h.Store.RetryTask(r.Context(), r.PathValue("id"), baseRevision)
	if err != nil {
		h.writeTaskStoreError(w, r, err)
		return
	}
	if h.Notify != nil {
		h.Notify()
	}
	writeJSON(w, http.StatusAccepted, dataEnvelope{Data: toTaskDTO(task)})
}

func (h *TaskHandlers) handleCancelTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, r, "POST")
		return
	}
	if h == nil || h.Store == nil {
		h.internalError(w, r, "任务存储未配置", errors.New("task store is nil"))
		return
	}
	baseRevision, ok := h.readBaseRevision(w, r)
	if !ok {
		return
	}
	task, accepted, err := h.Store.CancelTask(r.Context(), r.PathValue("id"), baseRevision)
	if err != nil {
		h.writeTaskStoreError(w, r, err)
		return
	}
	if h.Notify != nil {
		h.Notify()
	}
	status := http.StatusOK
	if accepted {
		status = http.StatusAccepted
	}
	writeJSON(w, status, dataEnvelope{Data: toTaskDTO(task)})
}

func (h *TaskHandlers) readBaseRevision(w http.ResponseWriter, r *http.Request) (int64, bool) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		h.writeTaskError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type",
			"仅支持 application/json", nil)
		return 0, false
	}
	if r.ContentLength > maxTaskMutationBytes {
		h.writeTaskError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large",
			"请求体超过 64 KiB", nil)
		return 0, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxTaskMutationBytes+1))
	if err != nil {
		h.writeTaskError(w, r, http.StatusBadRequest, "invalid_request", "读取请求体失败", nil)
		return 0, false
	}
	if len(body) > maxTaskMutationBytes {
		h.writeTaskError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large",
			"请求体超过 64 KiB", nil)
		return 0, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var request taskMutationRequest
	if err := decoder.Decode(&request); err != nil {
		h.writeTaskError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return 0, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		h.writeTaskError(w, r, http.StatusBadRequest, "invalid_request", "JSON 后存在多余内容", nil)
		return 0, false
	}
	if request.BaseRevision == nil {
		h.writeTaskError(w, r, http.StatusBadRequest, "invalid_request", "缺少 baseRevision",
			map[string]any{"field": "baseRevision"})
		return 0, false
	}
	baseRevision, err := parseTaskRevision(*request.BaseRevision)
	if err != nil {
		h.writeTaskError(w, r, http.StatusBadRequest, "invalid_request", "baseRevision 无效",
			map[string]any{"field": "baseRevision"})
		return 0, false
	}
	return baseRevision, true
}

func parseTaskRevision(value string) (int64, error) {
	if value == "" || value[0] < '1' || value[0] > '9' || len(value) > 19 {
		return 0, errors.New("invalid revision")
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return 0, errors.New("invalid revision")
		}
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 1 {
		return 0, errors.New("invalid revision")
	}
	return parsed, nil
}

func (h *TaskHandlers) writeTaskStoreError(w http.ResponseWriter, r *http.Request, err error) {
	var notFound *store.TaskNotFoundError
	if errors.As(err, &notFound) {
		h.writeTaskError(w, r, http.StatusNotFound, "not_found", "任务不存在", nil)
		return
	}
	var revisionConflict *store.TaskRevisionConflictError
	if errors.As(err, &revisionConflict) {
		h.writeTaskError(w, r, http.StatusConflict, "revision_conflict", "任务 revision 已变化",
			map[string]any{"current": toTaskDTO(revisionConflict.Current)})
		return
	}
	var stateConflict *store.TaskStateConflictError
	if errors.As(err, &stateConflict) {
		h.writeTaskError(w, r, http.StatusConflict, "state_conflict", "任务状态不允许当前操作",
			map[string]any{"current": toTaskDTO(stateConflict.Current)})
		return
	}
	h.internalError(w, r, "任务操作失败", err)
}

func (h *TaskHandlers) writeTaskError(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
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

func (h *TaskHandlers) internalError(w http.ResponseWriter, r *http.Request, logMessage string, err error) {
	logger := slog.Default()
	if h != nil && h.Logger != nil {
		logger = h.Logger
	}
	logger.Error(logMessage, "error", err, "requestId", requestIDFromRequest(r))
	h.writeTaskError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
}

func toTaskDTO(task store.Task) taskDTO {
	progress := taskProgressDTO{
		Phase:          task.ProgressPhase,
		CompletedUnits: task.ProgressCompleted,
		TotalUnits:     task.ProgressTotal,
	}
	var taskError *taskErrorDTO
	if task.ErrorCode != nil {
		message := ""
		if task.ErrorMessage != nil {
			message = *task.ErrorMessage
		}
		taskError = &taskErrorDTO{
			Code:      *task.ErrorCode,
			Message:   message,
			Retryable: task.ErrorRetryable,
		}
	}
	return taskDTO{
		SchemaVersion:         taskSchemaVersion,
		TaskID:                task.ID,
		Kind:                  task.Kind,
		BookID:                task.BookID,
		State:                 task.State,
		Attempt:               task.Attempt,
		Revision:              strconv.FormatInt(task.Revision, 10),
		CancellationRequested: task.CancellationRequested,
		Progress:              progress,
		Error:                 taskError,
		CreatedAt:             task.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:             task.UpdatedAt.UTC().Format(time.RFC3339),
	}
}
