package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"iread/server/internal/settings"
)

type contextKey int

const requestIDContextKey contextKey = 0

type errorEnvelope struct {
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
	Details   any    `json:"details"`
}

type dataEnvelope struct {
	Data any `json:"data"`
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
	_, _ = w.Write([]byte("\n"))
}

func (s *Server) writeData(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, dataEnvelope{Data: data})
}

func (s *Server) writeAPIError(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
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

func (s *Server) writeValidationError(w http.ResponseWriter, r *http.Request, err error) {
	details := map[string]any{}
	message := "请求参数无效"
	var validation *settings.ValidationError
	if errors.As(err, &validation) {
		if validation.Field != "" {
			details["field"] = validation.Field
		}
		if validation.Message != "" {
			message = validation.Message
		}
	}
	s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", message, details)
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, logMessage string, err error) {
	s.logger.Error(logMessage, "error", err, "requestId", requestIDFromRequest(r))
	s.writeAPIError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
}

func requestIDFromContext(ctx context.Context) string {
	value, _ := ctx.Value(requestIDContextKey).(string)
	return value
}

func requestIDFromRequest(r *http.Request) string {
	return requestIDFromContext(r.Context())
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request, allow string) {
	w.Header().Set("Allow", allow)
	writeJSON(w, http.StatusMethodNotAllowed, errorEnvelope{Error: errorPayload{
		Code:      "invalid_request",
		Message:   "请求方法不支持",
		RequestID: requestIDFromRequest(r),
		Details:   struct{}{},
	}})
}
