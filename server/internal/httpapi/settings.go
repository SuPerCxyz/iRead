package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"iread/server/internal/settings"
	"iread/server/internal/store"
)

const maxAppearanceBodyBytes = 1 << 20 // 1 MiB

type putAppearanceRequest struct {
	SchemaVersion *int64          `json:"schemaVersion"`
	BaseRevision  *string         `json:"baseRevision"`
	Value         json.RawMessage `json:"value"`
}

func (s *Server) handleAppearance(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getAppearance(w, r)
	case http.MethodPut:
		s.putAppearance(w, r)
	default:
		methodNotAllowed(w, r, "GET, PUT")
	}
}

func (s *Server) getAppearance(w http.ResponseWriter, r *http.Request) {
	record, err := s.store.GetAppearance(r.Context())
	if err != nil {
		s.internalError(w, r, "读取外观设置失败", err)
		return
	}
	s.writeData(w, http.StatusOK, record)
}

func (s *Server) putAppearance(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		s.writeAPIError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type", "仅支持 application/json", nil)
		return
	}

	body, ok := s.readLimitedBody(w, r)
	if !ok {
		return
	}

	var request putAppearanceRequest
	if err := decodeStrictJSON(body, &request); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return
	}

	if request.SchemaVersion == nil {
		s.writeValidationError(w, r, &settings.ValidationError{Field: "schemaVersion", Message: "缺少 schemaVersion"})
		return
	}
	if *request.SchemaVersion != settings.AppearanceSchemaVersion {
		s.writeValidationError(w, r, &settings.ValidationError{Field: "schemaVersion", Message: "schemaVersion 仅支持 1"})
		return
	}
	if request.BaseRevision == nil {
		s.writeValidationError(w, r, &settings.ValidationError{Field: "baseRevision", Message: "缺少 baseRevision"})
		return
	}
	baseRevision, err := settings.ParseRevision(*request.BaseRevision)
	if err != nil {
		s.writeValidationError(w, r, err)
		return
	}
	if len(request.Value) == 0 {
		s.writeValidationError(w, r, &settings.ValidationError{Field: "value", Message: "缺少 value"})
		return
	}
	value, err := settings.ParseAppearanceValue(request.Value)
	if err != nil {
		s.writeValidationError(w, r, err)
		return
	}

	record, err := s.store.PutAppearance(r.Context(), baseRevision, value)
	if err != nil {
		var conflict *store.RevisionConflictError
		if errors.As(err, &conflict) {
			s.writeAPIError(w, r, http.StatusConflict, "revision_conflict", "设置已在另一处更新",
				map[string]any{"current": conflict.Current})
			return
		}
		var limit *store.RevisionLimitError
		if errors.As(err, &limit) {
			s.writeAPIError(w, r, http.StatusConflict, "revision_conflict", "设置 revision 已达上限",
				map[string]any{"current": limit.Current})
			return
		}
		s.internalError(w, r, "保存外观设置失败", err)
		return
	}
	s.writeData(w, http.StatusOK, record)
}

func (s *Server) handleOtherSettings(w http.ResponseWriter, r *http.Request) {
	// 阶段1只接入 appearance；library/reader/other 等分组如实返回 404。
	s.writeAPIError(w, r, http.StatusNotFound, "not_found", "设置分组尚未接入", nil)
}

func (s *Server) readLimitedBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.ContentLength > maxAppearanceBodyBytes {
		s.writeAPIError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 1 MiB", nil)
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxAppearanceBodyBytes+1))
	if err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "读取请求体失败", nil)
		return nil, false
	}
	if len(body) > maxAppearanceBodyBytes {
		s.writeAPIError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 1 MiB", nil)
		return nil, false
	}
	return body, true
}

func decodeStrictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON 后存在多余内容")
		}
		return err
	}
	return nil
}
