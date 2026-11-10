package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"iread/server/internal/library"
	librarysettings "iread/server/internal/library/settings"
	appsettings "iread/server/internal/settings"
	"iread/server/internal/store"
)

type bookListMeta struct {
	NextCursor *string `json:"nextCursor"`
	Total      *int64  `json:"total"`
}

type bookCursorPayload struct {
	Version      int    `json:"v"`
	Sort         string `json:"sort"`
	Query        string `json:"q,omitempty"`
	Format       string `json:"format,omitempty"`
	ReadingState string `json:"readingState,omitempty"`
	Key          string `json:"key"`
	ID           string `json:"id"`
	HasProgress  bool   `json:"hasProgress,omitempty"`
}

func encodeBookCursor(payload bookCursorPayload) string {
	raw, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeBookCursor(value string) (bookCursorPayload, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return bookCursorPayload{}, false
	}
	var payload bookCursorPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return bookCursorPayload{}, false
	}
	if payload.Version != 1 || payload.ID == "" {
		return bookCursorPayload{}, false
	}
	return payload, true
}

func (h *LibraryHandlers) handleBookCollection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
		return
	}
	h.listBooks(w, r)
}

func (h *LibraryHandlers) listBooks(w http.ResponseWriter, r *http.Request) {
	values := r.URL.Query()
	allowed := map[string]bool{
		"q": true, "format": true, "sort": true, "readingState": true,
		"cursor": true, "limit": true,
	}
	for key := range values {
		if !allowed[key] {
			writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "不支持的查询参数", map[string]any{"field": key})
			return
		}
	}
	readingState := strings.ToLower(strings.TrimSpace(values.Get("readingState")))
	switch readingState {
	case "", "unread", "reading", "finished":
	default:
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request",
			"readingState 仅支持 unread/reading/finished", map[string]any{"field": "readingState"})
		return
	}

	limit := defaultBookListLimit
	if values.Has("limit") {
		raw := values.Get("limit")
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > maxBookListLimit {
			writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "limit 必须在 1 到 100 之间",
				map[string]any{"field": "limit"})
			return
		}
		limit = parsed
	}

	query := strings.TrimSpace(values.Get("q"))
	format := strings.ToLower(strings.TrimSpace(values.Get("format")))
	sortOrder := strings.TrimSpace(values.Get("sort"))
	if sortOrder == "" {
		sortOrder = "recent-added"
	}
	switch sortOrder {
	case "recent-added", "recent-read", "title", "updated":
	default:
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "sort 不受支持",
			map[string]any{"field": "sort"})
		return
	}

	var cursor *library.BookCursor
	if values.Has("cursor") && values.Get("cursor") != "" {
		payload, ok := decodeBookCursor(values.Get("cursor"))
		if !ok {
			writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "cursor 无效", map[string]any{"field": "cursor"})
			return
		}
		if payload.Sort != sortOrder || payload.Query != query || payload.Format != format ||
			payload.ReadingState != readingState {
			writeLibraryError(w, r, http.StatusBadRequest, "invalid_request",
				"cursor 与当前筛选/排序不匹配", map[string]any{"field": "cursor"})
			return
		}
		cursor = &library.BookCursor{Key: payload.Key, ID: payload.ID, HasProgress: payload.HasProgress}
	}

	page, apiErr := h.service.ListBooks(r.Context(), library.BookListParams{
		Query:        query,
		Format:       format,
		ReadingState: readingState,
		Sort:         sortOrder,
		Cursor:       cursor,
		Limit:        limit,
	})
	if apiErr != nil {
		h.writeServiceError(w, r, apiErr)
		return
	}
	books := make([]bookDTO, 0, len(page.Books))
	for _, item := range page.Books {
		dto := bookDTOFrom(item.BookSummary, item.Subtitle, item.ExtractionStatus)
		dto.Progress = progressDTOFromSummary(item.BookSummary)
		books = append(books, dto)
	}
	var nextCursor *string
	if page.NextCursor != nil {
		encoded := encodeBookCursor(bookCursorPayload{
			Version:      1,
			Sort:         sortOrder,
			Query:        query,
			Format:       format,
			ReadingState: readingState,
			Key:          page.NextCursor.Key,
			ID:           page.NextCursor.ID,
			HasProgress:  page.NextCursor.HasProgress,
		})
		if encoded != "" {
			nextCursor = &encoded
		}
	}
	total := page.Total
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, struct {
		Data []bookDTO    `json:"data"`
		Meta bookListMeta `json:"meta"`
	}{
		Data: books,
		Meta: bookListMeta{NextCursor: nextCursor, Total: &total},
	})
}

func (h *LibraryHandlers) handleBookItem(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/api/v1/books/")
	parts := strings.Split(suffix, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeLibraryError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	bookID := parts[0]
	switch {
	case len(parts) == 1:
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
			return
		}
		h.getBook(w, r, bookID)
	case len(parts) == 2 && parts[1] == "cover":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
			return
		}
		h.getCover(w, r, bookID)
	default:
		writeLibraryError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
	}
}

func (h *LibraryHandlers) getBook(w http.ResponseWriter, r *http.Request, bookID string) {
	detail, apiErr := h.service.GetBookDetail(r.Context(), bookID)
	if apiErr != nil {
		h.writeServiceError(w, r, apiErr)
		return
	}
	dto := bookDetailDTOFrom(detail)
	dto.Progress = progressDTOFromSummary(detail.BookSummary)
	writeLibraryData(w, http.StatusOK, dto)
}

func (h *LibraryHandlers) getCover(w http.ResponseWriter, r *http.Request, bookID string) {
	values := r.URL.Query()
	for key := range values {
		if key != "variant" && key != "v" {
			writeLibraryError(w, r, http.StatusBadRequest, "invalid_request",
				"封面接口只接受 variant 与 v", map[string]any{"field": key})
			return
		}
	}
	variant := values.Get("variant")
	if variant != "grid" && variant != "detail" {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request",
			"variant 仅支持 grid/detail", map[string]any{"field": "variant"})
		return
	}
	versionRaw := values.Get("v")
	version, err := strconv.ParseInt(versionRaw, 10, 64)
	if err != nil || version < 0 {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request",
			"v 必须是非负整数", map[string]any{"field": "v"})
		return
	}
	cover, apiErr := h.service.OpenCover(r.Context(), bookID, variant, version)
	if apiErr != nil {
		h.writeServiceError(w, r, apiErr)
		return
	}
	defer cover.File.Close()
	w.Header().Set("Content-Type", cover.MediaType)
	w.Header().Set("ETag", cover.ETag)
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, cover.Name, cover.ModTime, cover.File)
}

func progressDTOFromSummary(summary store.BookSummary) *progressDTO {
	if summary.ProgressPercent == nil || summary.ProgressUpdatedAt == nil {
		return nil
	}
	return &progressDTO{
		ProgressPercent: *summary.ProgressPercent,
		UpdatedAt:       apiTime(*summary.ProgressUpdatedAt),
	}
}

const maxLibrarySettingsBodyBytes int64 = 64 << 10

type putLibrarySettingsRequest struct {
	SchemaVersion *int64          `json:"schemaVersion"`
	BaseRevision  *string         `json:"baseRevision"`
	Value         json.RawMessage `json:"value"`
}

func (h *LibraryHandlers) handleLibrarySettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.getLibrarySettings(w, r)
	case http.MethodPut:
		h.mutation(http.HandlerFunc(h.putLibrarySettings)).ServeHTTP(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeLibraryError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
	}
}

func (h *LibraryHandlers) getLibrarySettings(w http.ResponseWriter, r *http.Request) {
	record, apiErr := h.service.GetLibrarySettings(r.Context())
	if apiErr != nil {
		h.writeLibrarySettingsError(w, r, apiErr)
		return
	}
	dto, err := librarysettings.RecordDTO(record)
	if err != nil {
		writeLibraryError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
		return
	}
	writeLibraryData(w, http.StatusOK, dto)
}

func (h *LibraryHandlers) putLibrarySettings(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeLibraryError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type", "仅支持 application/json", nil)
		return
	}
	if r.ContentLength > maxLibrarySettingsBodyBytes {
		writeLibraryError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 64 KiB", nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxLibrarySettingsBodyBytes+1))
	if err != nil {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "读取请求体失败", nil)
		return
	}
	if int64(len(body)) > maxLibrarySettingsBodyBytes {
		writeLibraryError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 64 KiB", nil)
		return
	}
	var request putLibrarySettingsRequest
	if err := decodeStrictJSON(body, &request); err != nil {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return
	}
	if request.SchemaVersion == nil {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "缺少 schemaVersion",
			map[string]any{"field": "schemaVersion"})
		return
	}
	if *request.SchemaVersion != librarysettings.SchemaVersion {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "schemaVersion 仅支持 1",
			map[string]any{"field": "schemaVersion"})
		return
	}
	if request.BaseRevision == nil {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "缺少 baseRevision",
			map[string]any{"field": "baseRevision"})
		return
	}
	baseRevision, err := appsettings.ParseRevision(*request.BaseRevision)
	if err != nil {
		details := map[string]any{}
		var validation *appsettings.ValidationError
		if errors.As(err, &validation) && validation.Field != "" {
			details["field"] = validation.Field
		}
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "baseRevision 无效", details)
		return
	}
	if len(strings.TrimSpace(string(request.Value))) == 0 {
		writeLibraryError(w, r, http.StatusBadRequest, "invalid_request", "缺少 value",
			map[string]any{"field": "value"})
		return
	}
	if _, err := librarysettings.ParseValue(request.Value); err != nil {
		details := map[string]any{}
		message := "书库设置值无效"
		var validation *librarysettings.ValidationError
		if errors.As(err, &validation) {
			if validation.Field != "" {
				details["field"] = validation.Field
			}
			if validation.Message != "" {
				message = validation.Message
			}
		}
		writeLibraryError(w, r, http.StatusUnprocessableEntity, "invalid_request", message, details)
		return
	}

	record, apiErr := h.service.PutLibrarySettings(r.Context(), baseRevision, request.Value)
	if apiErr != nil {
		h.writeLibrarySettingsError(w, r, apiErr)
		return
	}
	dto, err := librarysettings.RecordDTO(record)
	if err != nil {
		writeLibraryError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误", nil)
		return
	}
	writeLibraryData(w, http.StatusOK, dto)
}

func (h *LibraryHandlers) writeLibrarySettingsError(w http.ResponseWriter, r *http.Request, apiErr *library.SettingsError) {
	details := map[string]any{}
	if apiErr.Field != "" {
		details["field"] = apiErr.Field
	}
	if apiErr.Current != nil {
		if dto, err := librarysettings.RecordDTO(*apiErr.Current); err == nil {
			details["current"] = dto
		}
	}
	var payload any = details
	if len(details) == 0 {
		payload = nil
	}
	writeLibraryError(w, r, apiErr.Status, apiErr.Code, apiErr.Message, payload)
}
