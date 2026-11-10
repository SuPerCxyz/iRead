package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"iread/server/internal/reader/bookmarks"
	"iread/server/internal/reader/progress"
	appsettings "iread/server/internal/settings"
	"iread/server/internal/store"
)

func bookmarkDTO(record store.Bookmark) bookmarks.DTO {
	return bookmarks.DTO{
		SchemaVersion:  bookmarks.SchemaVersion,
		BookmarkID:     record.BookmarkID,
		BookID:         record.BookID,
		FileVersion:    record.FileVersion,
		Format:         record.Format,
		LocatorType:    record.LocatorType,
		LocatorPayload: record.LocatorPayload,
		Label:          record.Label,
		Revision:       formatReaderRevision(record.Revision),
		CreatedAt:      record.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:      record.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func (h *ReaderDataHandlers) handleBookmarkCollection(w http.ResponseWriter, r *http.Request) {
	bookID := r.PathValue("bookId")
	if !validReaderID(bookID) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.listBookmarks(w, r, bookID)
	case http.MethodPost:
		h.mutation(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.createBookmark(w, r, bookID)
		})).ServeHTTP(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeReaderError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
	}
}

func (h *ReaderDataHandlers) handleBookmarkItem(w http.ResponseWriter, r *http.Request) {
	bookID := r.PathValue("bookId")
	bookmarkID := r.PathValue("bookmarkId")
	if !validReaderID(bookID) || !validReaderID(bookmarkID) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书签不存在", nil)
		return
	}
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", "DELETE")
		writeReaderError(w, r, http.StatusMethodNotAllowed, "invalid_request", "请求方法不支持", nil)
		return
	}
	h.mutation(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.deleteBookmark(w, r, bookID, bookmarkID)
	})).ServeHTTP(w, r)
}

func (h *ReaderDataHandlers) listBookmarks(w http.ResponseWriter, r *http.Request, bookID string) {
	book, err := h.resolveBook(r.Context(), bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
		return
	}
	if err != nil {
		h.internalError(w, r, "读取书籍原件信息失败", err)
		return
	}

	values := r.URL.Query()
	for key := range values {
		switch key {
		case "fileVersion", "cursor", "limit":
		default:
			writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "不支持的查询参数",
				map[string]string{"field": key})
			return
		}
	}

	fileVersion := strings.TrimSpace(values.Get("fileVersion"))
	if fileVersion == "" {
		fileVersion = book.FileVersion
	} else if !validReaderSHA256(fileVersion) {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request",
			"fileVersion 必须是 64 位小写 hex", map[string]string{"field": "fileVersion"})
		return
	}

	limit := bookmarks.DefaultListLimit
	if values.Has("limit") {
		parsed, parseErr := strconv.Atoi(values.Get("limit"))
		if parseErr != nil || parsed < 1 || parsed > bookmarks.MaxListLimit {
			writeReaderError(w, r, http.StatusBadRequest, "invalid_request",
				"limit 必须在 1 到 200 之间", map[string]string{"field": "limit"})
			return
		}
		limit = parsed
	}

	query := store.BookmarkListQuery{
		BookID:      bookID,
		FileVersion: fileVersion,
		Limit:       limit,
	}
	if cursorValue := strings.TrimSpace(values.Get("cursor")); cursorValue != "" {
		cursor, ok := bookmarks.ParseCursor(cursorValue, bookID, fileVersion)
		if !ok {
			writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "cursor 无效",
				map[string]string{"field": "cursor"})
			return
		}
		query.HasCursor = true
		query.CursorCreatedAt = cursor.CreatedAt
		query.CursorID = cursor.ID
	}

	result, err := h.store.ListBookmarks(r.Context(), query)
	if err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
			return
		}
		if errors.Is(err, store.ErrReaderInvalidInput) {
			writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "书签查询参数无效", nil)
			return
		}
		h.internalError(w, r, "查询书签失败", err)
		return
	}

	items := make([]bookmarks.DTO, 0, len(result.Bookmarks))
	for _, record := range result.Bookmarks {
		items = append(items, bookmarkDTO(record))
	}
	var nextCursor *string
	if result.HasMore && len(result.Bookmarks) > 0 {
		last := result.Bookmarks[len(result.Bookmarks)-1]
		encoded := bookmarks.EncodeCursor(bookID, fileVersion, last.CreatedAt, last.BookmarkID)
		if encoded != "" {
			nextCursor = &encoded
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, bookmarks.ListResponse{
		Data: items,
		Meta: bookmarks.ListMeta{NextCursor: nextCursor},
	})
}

func (h *ReaderDataHandlers) createBookmark(w http.ResponseWriter, r *http.Request, bookID string) {
	body, ok := readReaderJSON(w, r)
	if !ok {
		return
	}
	input, err := bookmarks.ParseCreate(body)
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
	input, err = input.ValidateForBook(book.Format, book.FileVersion)
	if err != nil {
		var fileVersionConflict *progress.FileVersionConflictError
		if errors.As(err, &fileVersionConflict) {
			writeReaderError(w, r, http.StatusConflict, "file_version_conflict", "原件版本已变化，请重新加载", nil)
			return
		}
		writeReaderValidation(w, r, err)
		return
	}

	record, created, err := h.store.CreateBookmark(r.Context(), store.CreateBookmarkParams{
		BookID:           bookID,
		FileVersion:      input.FileVersion,
		Format:           input.Format,
		LocatorType:      input.LocatorType,
		LocatorPayload:   input.LocatorPayload,
		LocatorKey:       input.LocatorKey,
		Label:            input.Label,
		ClientMutationID: input.ClientMutationID,
	})
	if err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			writeReaderError(w, r, http.StatusNotFound, "not_found", "书籍不存在", nil)
			return
		}
		if errors.Is(err, store.ErrReaderInvalidInput) {
			writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "书签输入无效", nil)
			return
		}
		h.internalError(w, r, "创建书签失败", err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeReaderData(w, status, bookmarkDTO(record))
}

func (h *ReaderDataHandlers) deleteBookmark(w http.ResponseWriter, r *http.Request, bookID, bookmarkID string) {
	revision, err := parseIfMatchRevision(r.Header.Get("If-Match"))
	if err != nil {
		writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "缺少或无效的 If-Match revision",
			map[string]string{"field": "If-Match"})
		return
	}
	if err := h.store.DeleteBookmark(r.Context(), bookID, bookmarkID, revision); err != nil {
		var conflict *store.BookmarkRevisionConflictError
		if errors.As(err, &conflict) {
			writeReaderError(w, r, http.StatusPreconditionFailed, "precondition_failed",
				"书签已在另一处更新", map[string]any{"current": bookmarkDTO(conflict.Current)})
			return
		}
		if errors.Is(err, store.ErrBookmarkNotFound) || errors.Is(err, store.ErrBookNotFound) {
			writeReaderError(w, r, http.StatusNotFound, "not_found", "书签不存在", nil)
			return
		}
		if errors.Is(err, store.ErrReaderInvalidInput) {
			writeReaderError(w, r, http.StatusBadRequest, "invalid_request", "书签输入无效", nil)
			return
		}
		h.internalError(w, r, "删除书签失败", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func parseIfMatchRevision(header string) (int64, error) {
	text := strings.TrimSpace(header)
	if len(text) < 2 || text[0] != '"' || text[len(text)-1] != '"' {
		return 0, errors.New("If-Match 必须是带引号的 revision")
	}
	text = text[1 : len(text)-1]
	if text == "" || strings.ContainsAny(text, `"`) {
		return 0, errors.New("If-Match revision 无效")
	}
	return appsettings.ParseRevision(text)
}

func validReaderSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
