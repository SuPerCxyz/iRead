package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	readersettings "iread/server/internal/reader/settings"
	appsettings "iread/server/internal/settings"
	"iread/server/internal/store"
)

type putReaderSettingsRequest struct {
	SchemaVersion *int64          `json:"schemaVersion"`
	BaseRevision  *string         `json:"baseRevision"`
	Value         json.RawMessage `json:"value"`
}

type putBookReaderSettingsRequest struct {
	SchemaVersion *int64          `json:"schemaVersion"`
	FileVersion   *string         `json:"fileVersion"`
	BaseRevision  *string         `json:"baseRevision"`
	Overrides     json.RawMessage `json:"overrides"`
}

func (h *ReaderDataHandlers) handleGlobalReaderSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.getGlobalReaderSettings(w, r)
	case http.MethodPut:
		h.mutation(http.HandlerFunc(h.putGlobalReaderSettings)).ServeHTTP(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeReaderError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
	}
}

func (h *ReaderDataHandlers) getGlobalReaderSettings(w http.ResponseWriter, r *http.Request) {
	record, err := h.store.GetReaderSettings(r.Context())
	if err != nil {
		h.internalError(w, r, "读取阅读设置失败", err)
		return
	}
	dto, err := readersettings.GlobalDTOFrom(record)
	if err != nil {
		h.internalError(w, r, "解析阅读设置失败", err)
		return
	}
	writeReaderData(w, http.StatusOK, dto)
}

func (h *ReaderDataHandlers) putGlobalReaderSettings(w http.ResponseWriter, r *http.Request) {
	body, ok := readReaderJSON(w, r)
	if !ok {
		return
	}
	var request putReaderSettingsRequest
	if err := decodeStrictJSON(body, &request); err != nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return
	}
	if request.SchemaVersion == nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少 schemaVersion",
			map[string]string{"field": "schemaVersion"})
		return
	}
	if *request.SchemaVersion != readersettings.SchemaVersion {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "schemaVersion 仅支持 1",
			map[string]string{"field": "schemaVersion"})
		return
	}
	if request.BaseRevision == nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少 baseRevision",
			map[string]string{"field": "baseRevision"})
		return
	}
	baseRevision, err := appsettings.ParseRevision(*request.BaseRevision)
	if err != nil {
		writeReaderSettingsValidation(w, r, err, http.StatusBadRequest)
		return
	}
	if len(bytes.TrimSpace(request.Value)) == 0 {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少 value",
			map[string]string{"field": "value"})
		return
	}
	if _, err := readersettings.ParseGlobalValue(request.Value); err != nil {
		writeReaderSettingsValidation(w, r, err, http.StatusUnprocessableEntity)
		return
	}

	record, err := h.store.PutReaderSettings(r.Context(), baseRevision, request.Value)
	if err != nil {
		h.writeGlobalReaderSettingsStoreError(w, r, err)
		return
	}
	dto, err := readersettings.GlobalDTOFrom(record)
	if err != nil {
		h.internalError(w, r, "解析阅读设置结果失败", err)
		return
	}
	writeReaderData(w, http.StatusOK, dto)
}

func (h *ReaderDataHandlers) writeGlobalReaderSettingsStoreError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *store.ReaderSettingsRevisionConflictError
	if errors.As(err, &conflict) {
		var current any
		if dto, dtoErr := readersettings.GlobalDTOFrom(conflict.Current); dtoErr == nil {
			current = dto
		}
		writeReaderError(w, r, http.StatusConflict, "revision_conflict", "阅读设置已在另一处更新",
			map[string]any{"current": current})
		return
	}
	var limit *store.ReaderSettingsRevisionLimitError
	if errors.As(err, &limit) {
		var current any
		if dto, dtoErr := readersettings.GlobalDTOFrom(limit.Current); dtoErr == nil {
			current = dto
		}
		writeReaderError(w, r, http.StatusConflict, "revision_conflict", "阅读设置 revision 已达上限",
			map[string]any{"current": current})
		return
	}
	if errors.Is(err, store.ErrReaderInvalidInput) {
		writeReaderError(w, r, http.StatusUnprocessableEntity, "invalid_request", "阅读设置值无效", nil)
		return
	}
	h.internalError(w, r, "保存阅读设置失败", err)
}

func (h *ReaderDataHandlers) handleBookReaderSettings(w http.ResponseWriter, r *http.Request) {
	bookID := r.PathValue("bookId")
	if !validReaderID(bookID) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		profile, ok := readerProfileFromRequest(w, r)
		if !ok {
			return
		}
		h.getBookReaderSettings(w, r, bookID, profile)
	case http.MethodPut:
		profile, ok := readerProfileFromRequest(w, r)
		if !ok {
			return
		}
		h.mutation(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.putBookReaderSettings(w, r, bookID, profile)
		})).ServeHTTP(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeReaderError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
	}
}

// readerProfileFromRequest 解析 ?profile=web|mobile；缺省按 web，兼容旧客户端。
func readerProfileFromRequest(w http.ResponseWriter, r *http.Request) (readersettings.Profile, bool) {
	values, present := r.URL.Query()["profile"]
	if !present {
		return readersettings.DefaultProfile, true
	}
	if len(values) == 1 {
		if profile, ok := readersettings.ParseProfile(values[0]); ok {
			return profile, true
		}
	}
	details := map[string]any{"field": "profile"}
	if len(values) == 1 {
		details["profile"] = values[0]
	}
	writeReaderError(w, r, http.StatusUnprocessableEntity, "invalid_request",
		"profile 仅支持 web 或 mobile", details)
	return "", false
}

func (h *ReaderDataHandlers) getBookReaderSettings(w http.ResponseWriter, r *http.Request, bookID string, profile readersettings.Profile) {
	book, err := h.resolveBook(r.Context(), bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	if err != nil {
		h.internalError(w, r, "读取书籍原件信息失败", err)
		return
	}
	overrides, err := h.store.GetBookReaderOverrides(r.Context(), bookID)
	if err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
			return
		}
		h.internalError(w, r, "读取单书阅读设置失败", err)
		return
	}
	global, err := h.store.GetReaderSettings(r.Context())
	if err != nil {
		h.internalError(w, r, "读取全局阅读设置失败", err)
		return
	}
	dto, err := readersettings.BookDTOFrom(bookID, book.FileVersion, bookOverridesRecord(overrides), global, profile)
	if err != nil {
		h.internalError(w, r, "解析单书阅读设置失败", err)
		return
	}
	writeReaderData(w, http.StatusOK, dto)
}

func (h *ReaderDataHandlers) putBookReaderSettings(w http.ResponseWriter, r *http.Request, bookID string, profile readersettings.Profile) {
	body, ok := readReaderJSON(w, r)
	if !ok {
		return
	}
	var request putBookReaderSettingsRequest
	if err := decodeStrictJSON(body, &request); err != nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return
	}
	if request.SchemaVersion == nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少 schemaVersion",
			map[string]string{"field": "schemaVersion"})
		return
	}
	if *request.SchemaVersion != readersettings.SchemaVersion {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "schemaVersion 仅支持 1",
			map[string]string{"field": "schemaVersion"})
		return
	}
	if request.FileVersion == nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少 fileVersion",
			map[string]string{"field": "fileVersion"})
		return
	}
	if !validReaderSHA256(*request.FileVersion) {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request",
			"fileVersion 必须是 64 位小写 hex", map[string]string{"field": "fileVersion"})
		return
	}
	if request.BaseRevision == nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少 baseRevision",
			map[string]string{"field": "baseRevision"})
		return
	}
	baseRevision, err := appsettings.ParseRevision(*request.BaseRevision)
	if err != nil {
		writeReaderSettingsValidation(w, r, err, http.StatusBadRequest)
		return
	}
	if len(bytes.TrimSpace(request.Overrides)) == 0 {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少 overrides",
			map[string]string{"field": "overrides"})
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
	if *request.FileVersion != book.FileVersion {
		writeReaderError(w, r, http.StatusConflict, "file_version_conflict", "原件版本已变化，请重新加载", nil)
		return
	}
	if _, err := readersettings.ParseOverrides(request.Overrides); err != nil {
		writeReaderSettingsValidation(w, r, err, http.StatusUnprocessableEntity)
		return
	}

	overrides, err := h.store.PutBookReaderOverrides(r.Context(), store.PutBookReaderOverridesParams{
		BookID:        bookID,
		SchemaVersion: readersettings.SchemaVersion,
		BaseRevision:  baseRevision,
		Profile:       profile,
		Overrides:     request.Overrides,
	})
	if err != nil {
		var conflict *store.ReaderOverridesRevisionConflictError
		if errors.As(err, &conflict) {
			global, globalErr := h.store.GetReaderSettings(r.Context())
			var current any
			if globalErr == nil {
				if dto, dtoErr := readersettings.BookDTOFrom(bookID, book.FileVersion, bookOverridesRecord(conflict.Current), global, profile); dtoErr == nil {
					current = dto
				}
			}
			writeReaderError(w, r, http.StatusConflict, "revision_conflict", "单书阅读设置已在另一处更新",
				map[string]any{"current": current})
			return
		}
		if errors.Is(err, store.ErrReaderRevisionLimit) {
			writeReaderError(w, r, http.StatusConflict, "revision_conflict", "单书阅读设置 revision 已达上限", nil)
			return
		}
		if errors.Is(err, store.ErrBookNotFound) {
			writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
			return
		}
		if errors.Is(err, store.ErrReaderInvalidInput) {
			writeReaderError(w, r, http.StatusUnprocessableEntity, "invalid_request", "单书阅读设置值无效", nil)
			return
		}
		h.internalError(w, r, "保存单书阅读设置失败", err)
		return
	}
	global, err := h.store.GetReaderSettings(r.Context())
	if err != nil {
		h.internalError(w, r, "读取全局阅读设置失败", err)
		return
	}
	dto, err := readersettings.BookDTOFrom(bookID, book.FileVersion, bookOverridesRecord(overrides), global, profile)
	if err != nil {
		h.internalError(w, r, "解析单书阅读设置结果失败", err)
		return
	}
	writeReaderData(w, http.StatusOK, dto)
}

func bookOverridesRecord(record store.BookReaderOverrides) readersettings.Record {
	return readersettings.Record{
		SchemaVersion: record.SchemaVersion,
		Revision:      record.Revision,
		UpdatedAt:     record.UpdatedAt,
		Value:         record.Overrides,
	}
}

func writeReaderSettingsValidation(w http.ResponseWriter, r *http.Request, err error, status int) {
	var validation *readersettings.ValidationError
	if errors.As(err, &validation) {
		details := map[string]any{}
		for key, value := range validation.Details {
			details[key] = value
		}
		if validation.Field != "" {
			details["field"] = validation.Field
		}
		writeReaderError(w, r, status, "invalid_request", validation.Message, details)
		return
	}
	var appValidation *appsettings.ValidationError
	if errors.As(err, &appValidation) {
		details := map[string]any{}
		if appValidation.Field != "" {
			details["field"] = appValidation.Field
		}
		writeReaderError(w, r, status, "invalid_request", appValidation.Message, details)
		return
	}
	writeReaderError(w, r, status, "invalid_request", "请求参数无效", nil)
}
