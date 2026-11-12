package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"iread/server/internal/formats"
	"iread/server/internal/library"
	"iread/server/internal/store"
)

type libraryTestClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *libraryTestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

type validatorFunc func(ctx context.Context, tempPath, ext string) (formats.Result, error)

func (f validatorFunc) Validate(ctx context.Context, tempPath, ext string) (formats.Result, error) {
	return f(ctx, tempPath, ext)
}

func readableTestValidator() library.Validator {
	return validatorFunc(func(_ context.Context, _ string, ext string) (formats.Result, error) {
		return formats.Result{
			Format:    ext,
			MediaType: testMediaType(ext),
			Readable:  true,
			HasCover:  true,
			Title:     "HTTP 示例书",
			Authors:   []string{"HTTP 作者"},
			PageCount: 2,
		}, nil
	})
}

func testMediaType(ext string) string {
	switch ext {
	case "epub":
		return formats.MediaTypeEPUB
	case "pdf":
		return formats.MediaTypePDF
	case "cbz":
		return formats.MediaTypeCBZ
	case "cbr":
		return formats.MediaTypeCBR
	default:
		return "application/octet-stream"
	}
}

func allowAllMiddleware(next http.Handler) http.Handler { return next }

func denyAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeLibraryError(w, r, http.StatusUnauthorized, "unauthenticated", "需要登录", nil)
	})
}

func denyCSRFMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeLibraryError(w, r, http.StatusForbidden, "forbidden", "CSRF 校验失败",
			map[string]any{"reason": "csrf_invalid"})
	})
}

type libraryHTTPEnv struct {
	t        *testing.T
	mux      *http.ServeMux
	store    *store.Store
	service  *library.Service
	booksDir string
	cacheDir string
	clock    *libraryTestClock
}

func newLibraryHTTPEnv(t *testing.T, validator library.Validator, auth, csrf Middleware) *libraryHTTPEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	cacheDir := filepath.Join(root, "cache")
	dbDir := filepath.Join(root, "db")
	for _, dir := range []string{booksDir, cacheDir, dbDir} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	database, err := store.Open(context.Background(), filepath.Join(dbDir, "iread.db"))
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}
	clock := &libraryTestClock{now: time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)}
	service, err := library.NewService(library.Config{
		Store:     database,
		BooksDir:  booksDir,
		CacheDir:  cacheDir,
		Now:       clock.Now,
		Validator: validator,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		_ = database.Close()
		t.Fatalf("NewService() error = %v", err)
	}
	handlers, err := NewLibraryHandlers(LibraryOptions{
		Service:     service,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequireAuth: auth,
		RequireCSRF: csrf,
	})
	if err != nil {
		_ = database.Close()
		t.Fatalf("NewLibraryHandlers() error = %v", err)
	}
	mux := http.NewServeMux()
	handlers.RegisterLibraryRoutes(mux)
	env := &libraryHTTPEnv{
		t:        t,
		mux:      mux,
		store:    database,
		service:  service,
		booksDir: booksDir,
		cacheDir: cacheDir,
		clock:    clock,
	}
	t.Cleanup(func() { _ = env.store.Close() })
	return env
}

func (e *libraryHTTPEnv) request(method, target string, body []byte, contentType string) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	recorder := httptest.NewRecorder()
	e.mux.ServeHTTP(recorder, request)
	return recorder
}

type libraryErrorEnvelope struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		RequestID string         `json:"requestId"`
		Details   map[string]any `json:"details"`
	} `json:"error"`
}

func decodeLibraryError(t *testing.T, recorder *httptest.ResponseRecorder) libraryErrorEnvelope {
	t.Helper()
	var envelope libraryErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解码错误包络失败: %v，body=%s", err, recorder.Body.String())
	}
	return envelope
}

func decodeLibraryData[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var envelope struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解码 data 失败: %v，body=%s", err, recorder.Body.String())
	}
	return envelope.Data
}

func (e *libraryHTTPEnv) createIntent(fileName string, size int64) uploadDTO {
	e.t.Helper()
	body := fmt.Sprintf(`{"clientUploadId":%q,"fileName":%q,"byteSize":%d}`, "client-"+fileName, fileName, size)
	recorder := e.request(http.MethodPost, "/api/v1/uploads", []byte(body), "application/json")
	if recorder.Code != http.StatusCreated {
		e.t.Fatalf("创建意图 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	return decodeLibraryData[uploadDTO](e.t, recorder)
}

func (e *libraryHTTPEnv) upload(fileName string, data []byte) uploadDTO {
	e.t.Helper()
	intent := e.createIntent(fileName, int64(len(data)))
	recorder := e.request(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content", data, "application/octet-stream")
	if recorder.Code != http.StatusOK {
		e.t.Fatalf("上传 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	return decodeLibraryData[uploadDTO](e.t, recorder)
}

func TestLibraryRoutesFailClosedWithoutAuth(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), nil, allowAllMiddleware)
	for _, target := range []string{
		"/api/v1/books",
		"/api/v1/uploads/" + strings.Repeat("a", 32),
		"/api/v1/books/" + strings.Repeat("a", 32) + "/cover?variant=grid&v=0",
	} {
		recorder := env.request(http.MethodGet, target, nil, "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d，期望 401", target, recorder.Code)
		}
		if envelope := decodeLibraryError(t, recorder); envelope.Error.Code != "unauthenticated" {
			t.Fatalf("%s code = %q", target, envelope.Error.Code)
		}
	}
	recorder := env.request(http.MethodPost, "/api/v1/uploads", []byte(`{}`), "application/json")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 POST status = %d，期望 401", recorder.Code)
	}

	denyEnv := newLibraryHTTPEnv(t, readableTestValidator(), denyAuthMiddleware, allowAllMiddleware)
	if recorder := denyEnv.request(http.MethodGet, "/api/v1/books", nil, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("注入认证拒绝 status = %d", recorder.Code)
	}
}

func TestLibraryMutationsRequireCSRF(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, denyCSRFMiddleware)
	recorder := env.request(http.MethodPost, "/api/v1/uploads", []byte(`{"clientUploadId":"c","fileName":"a.epub","byteSize":1}`), "application/json")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("POST 无 CSRF status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	envelope := decodeLibraryError(t, recorder)
	if envelope.Error.Code != "forbidden" || envelope.Error.Details["reason"] != "csrf_invalid" {
		t.Fatalf("CSRF 错误 = %+v", envelope)
	}
	if recorder := env.request(http.MethodGet, "/api/v1/books", nil, ""); recorder.Code != http.StatusOK {
		t.Fatalf("GET 不应要求 CSRF，status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodPut, "/api/v1/uploads/"+strings.Repeat("a", 32)+"/content", []byte("x"), "application/octet-stream"); recorder.Code != http.StatusForbidden {
		t.Fatalf("PUT 无 CSRF status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodPost, "/api/v1/uploads/"+strings.Repeat("a", 32)+"/cancel", nil, ""); recorder.Code != http.StatusForbidden {
		t.Fatalf("cancel 无 CSRF status = %d", recorder.Code)
	}
}

func TestLibraryUploadAndBookFlow(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	data := []byte("0123456789abcdefgh")

	intent := env.createIntent("book.epub", int64(len(data)))
	if intent.State != library.StateAwaiting || intent.BookID != nil || intent.TaskID != nil {
		t.Fatalf("创建意图 = %+v", intent)
	}
	repeatBody := fmt.Sprintf(`{"clientUploadId":%q,"fileName":"book.epub","byteSize":%d}`, "client-book.epub", len(data))
	repeat := env.request(http.MethodPost, "/api/v1/uploads", []byte(repeatBody), "application/json")
	if repeat.Code != http.StatusOK {
		t.Fatalf("幂等创建 status = %d", repeat.Code)
	}
	if repeated := decodeLibraryData[uploadDTO](t, repeat); repeated.UploadID != intent.UploadID {
		t.Fatalf("幂等 uploadId = %s，期望 %s", repeated.UploadID, intent.UploadID)
	}

	content := env.request(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content", data, "application/octet-stream")
	if content.Code != http.StatusOK {
		t.Fatalf("上传 status = %d，body=%s", content.Code, content.Body.String())
	}
	stored := decodeLibraryData[uploadDTO](t, content)
	if stored.State != library.StateStored || stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果 = %+v", stored)
	}
	if got := env.request(http.MethodGet, "/api/v1/uploads/"+intent.UploadID, nil, ""); got.Code != http.StatusOK {
		t.Fatalf("GET 上传 status = %d", got.Code)
	} else if dto := decodeLibraryData[uploadDTO](t, got); dto.State != library.StateStored {
		t.Fatalf("GET 上传状态 = %q", dto.State)
	}

	detailRecorder := env.request(http.MethodGet, "/api/v1/books/"+*stored.BookID, nil, "")
	if detailRecorder.Code != http.StatusOK {
		t.Fatalf("详情 status = %d，body=%s", detailRecorder.Code, detailRecorder.Body.String())
	}
	detail := decodeLibraryData[bookDetailDTO](t, detailRecorder)
	if detail.Status != "indexing" || len(detail.FileVersion) != 64 || detail.OriginalFileName != "book.epub" || detail.Extension != "epub" {
		t.Fatalf("详情 = %+v", detail)
	}
	if detail.IndexTaskID == nil || *detail.IndexTaskID != *stored.TaskID {
		t.Fatalf("indexTaskId = %v", detail.IndexTaskID)
	}
	if detail.ReadingCapabilities.CanRead || detail.ReadingCapabilities.UnavailableReason != "not_ready" {
		t.Fatalf("readingCapabilities = %+v", detail.ReadingCapabilities)
	}
	if detail.Cover != nil || detail.Progress != nil {
		t.Fatalf("阶段2不应有假封面/进度: cover=%+v progress=%+v", detail.Cover, detail.Progress)
	}
	if detail.Metadata == nil || detail.Metadata.ExtractionStatus != "pending" {
		t.Fatalf("metadata = %+v", detail.Metadata)
	}

	duplicateIntent := env.createIntent("copy.epub", int64(len(data)))
	duplicateRecorder := env.request(http.MethodPut, "/api/v1/uploads/"+duplicateIntent.UploadID+"/content", data, "application/octet-stream")
	if duplicateRecorder.Code != http.StatusOK {
		t.Fatalf("重复上传 status = %d，body=%s", duplicateRecorder.Code, duplicateRecorder.Body.String())
	}
	duplicate := decodeLibraryData[uploadDTO](t, duplicateRecorder)
	if duplicate.State != library.StateDuplicate || duplicate.BookID == nil ||
		duplicate.DuplicateOfBookID == nil || *duplicate.BookID != *stored.BookID ||
		*duplicate.DuplicateOfBookID != *stored.BookID || duplicate.TaskID != nil {
		t.Fatalf("重复上传 DTO = %+v", duplicate)
	}

	cancel := env.request(http.MethodPost, "/api/v1/uploads/"+intent.UploadID+"/cancel", nil, "")
	if cancel.Code != http.StatusConflict {
		t.Fatalf("已保存取消 status = %d", cancel.Code)
	}
	if envelope := decodeLibraryError(t, cancel); envelope.Error.Code != "upload_completed" {
		t.Fatalf("已保存取消 code = %q", envelope.Error.Code)
	}

	cover := env.request(http.MethodGet, "/api/v1/books/"+*stored.BookID+"/cover?variant=grid&v=0", nil, "")
	if cover.Code != http.StatusNotFound {
		t.Fatalf("无封面 status = %d", cover.Code)
	}
	badVariant := env.request(http.MethodGet, "/api/v1/books/"+*stored.BookID+"/cover?variant=thumb&v=0", nil, "")
	if badVariant.Code != http.StatusBadRequest {
		t.Fatalf("非法 variant status = %d", badVariant.Code)
	}
	if missing := env.request(http.MethodGet, "/api/v1/books/"+strings.Repeat("f", 32), nil, ""); missing.Code != http.StatusNotFound {
		t.Fatalf("未知书籍 status = %d", missing.Code)
	}

	listRecorder := env.request(http.MethodGet, "/api/v1/books", nil, "")
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("列表 status = %d", listRecorder.Code)
	}
	var listEnvelope struct {
		Data []bookDTO `json:"data"`
		Meta struct {
			NextCursor *string `json:"nextCursor"`
			Total      *int64  `json:"total"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &listEnvelope); err != nil {
		t.Fatal(err)
	}
	if len(listEnvelope.Data) != 1 || listEnvelope.Meta.Total == nil || *listEnvelope.Meta.Total != 1 || listEnvelope.Meta.NextCursor != nil {
		t.Fatalf("列表 = %+v", listEnvelope)
	}
}

func TestBookListPaginationAndCursorBinding(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	ids := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		intent := env.upload(fmt.Sprintf("book-%d.epub", i), []byte(fmt.Sprintf("content-%d", i)))
		ids = append(ids, *intent.BookID)
	}

	first := env.request(http.MethodGet, "/api/v1/books?limit=2", nil, "")
	if first.Code != http.StatusOK {
		t.Fatalf("第一页 status = %d，body=%s", first.Code, first.Body.String())
	}
	var page1 struct {
		Data []bookDTO `json:"data"`
		Meta struct {
			NextCursor *string `json:"nextCursor"`
			Total      *int64  `json:"total"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &page1); err != nil {
		t.Fatal(err)
	}
	if len(page1.Data) != 2 || page1.Meta.Total == nil || *page1.Meta.Total != 3 || page1.Meta.NextCursor == nil {
		t.Fatalf("第一页 = %+v", page1)
	}
	second := env.request(http.MethodGet, "/api/v1/books?limit=2&cursor="+*page1.Meta.NextCursor, nil, "")
	if second.Code != http.StatusOK {
		t.Fatalf("第二页 status = %d，body=%s", second.Code, second.Body.String())
	}
	var page2 struct {
		Data []bookDTO `json:"data"`
		Meta struct {
			NextCursor *string `json:"nextCursor"`
			Total      *int64  `json:"total"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &page2); err != nil {
		t.Fatal(err)
	}
	if len(page2.Data) != 1 || page2.Meta.NextCursor != nil || *page2.Meta.Total != 3 {
		t.Fatalf("第二页 = %+v", page2)
	}
	seen := map[string]bool{}
	for _, book := range append(page1.Data, page2.Data...) {
		if seen[book.BookID] {
			t.Fatalf("分页重复书籍 %s", book.BookID)
		}
		seen[book.BookID] = true
	}
	for _, id := range ids {
		if !seen[id] {
			t.Fatalf("分页遗漏书籍 %s", id)
		}
	}

	for _, target := range []string{
		"/api/v1/books?limit=2&sort=title&cursor=" + *page1.Meta.NextCursor,
		"/api/v1/books?limit=2&q=other&cursor=" + *page1.Meta.NextCursor,
		"/api/v1/books?limit=2&format=pdf&cursor=" + *page1.Meta.NextCursor,
	} {
		if recorder := env.request(http.MethodGet, target, nil, ""); recorder.Code != http.StatusBadRequest {
			t.Fatalf("cursor 绑定 status = %d，target=%s", recorder.Code, target)
		}
	}
	special := env.request(http.MethodGet, "/api/v1/books?q=%25", nil, "")
	if special.Code != http.StatusOK {
		t.Fatalf("特殊字符搜索 status = %d，body=%s", special.Code, special.Body.String())
	}
	var specialPage struct {
		Meta struct {
			Total *int64 `json:"total"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(special.Body.Bytes(), &specialPage); err != nil {
		t.Fatal(err)
	}
	if specialPage.Meta.Total == nil || *specialPage.Meta.Total != 0 {
		t.Fatalf("百分号应按字面搜索，total = %v", specialPage.Meta.Total)
	}
	for _, target := range []string{
		"/api/v1/books?limit=0",
		"/api/v1/books?limit=101",
		"/api/v1/books?limit=abc",
		"/api/v1/books?format=docx",
		"/api/v1/books?readingState=bogus",
		"/api/v1/books?unknown=1",
		"/api/v1/books?cursor=not-base64",
	} {
		if recorder := env.request(http.MethodGet, target, nil, ""); recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d，期望 400", target, recorder.Code)
		}
	}
}

func TestEmptyLibraryIsRealEmptyList(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	recorder := env.request(http.MethodGet, "/api/v1/books", nil, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("空库 status = %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"data":[]`) {
		t.Fatalf("空库 data 应为 []，body=%s", recorder.Body.String())
	}
}

func TestUnsupportedBookDetailHasNoTask(t *testing.T) {
	validator := validatorFunc(func(_ context.Context, _ string, ext string) (formats.Result, error) {
		if ext == "cbr" {
			return formats.Result{
				Format:            formats.FormatCBR,
				MediaType:         formats.MediaTypeCBR,
				Readable:          false,
				UnsupportedReason: formats.UnsupportedCBRDeferred,
			}, nil
		}
		return formats.Result{Format: ext, MediaType: testMediaType(ext), Readable: true}, nil
	})
	env := newLibraryHTTPEnv(t, validator, allowAllMiddleware, allowAllMiddleware)
	stored := env.upload("comic.cbr", []byte("rar-content"))
	if stored.TaskID != nil {
		t.Fatalf("unsupported 不应有任务")
	}
	recorder := env.request(http.MethodGet, "/api/v1/books/"+*stored.BookID, nil, "")
	detail := decodeLibraryData[bookDetailDTO](t, recorder)
	if detail.Status != "unsupported" || detail.IndexTaskID != nil {
		t.Fatalf("unsupported 详情 = %+v", detail)
	}
}

func TestUploadValidationFailurePersistsAndReturnsReason(t *testing.T) {
	reason := formats.ReasonArchivePathTraversal
	validator := validatorFunc(func(_ context.Context, _ string, _ string) (formats.Result, error) {
		return formats.Result{
			ErrorCode:   formats.ErrorCodeInvalidFile,
			ErrorReason: reason,
		}, &formats.ValidationError{Reason: reason}
	})
	env := newLibraryHTTPEnv(t, validator, allowAllMiddleware, allowAllMiddleware)
	intent := env.createIntent("evil.epub", 4)

	content := env.request(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content", []byte("data"), "application/octet-stream")
	if content.Code != http.StatusUnprocessableEntity {
		t.Fatalf("上传 status = %d，body=%s", content.Code, content.Body.String())
	}
	envelope := decodeLibraryError(t, content)
	if envelope.Error.Code != "invalid_file" || envelope.Error.Details["reason"] != reason {
		t.Fatalf("错误包络 = %+v", envelope)
	}

	stored, err := env.store.GetUploadIntent(context.Background(), intent.UploadID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ErrorReason == nil || *stored.ErrorReason != reason {
		t.Fatalf("落库 ErrorReason = %v，期望 %q", stored.ErrorReason, reason)
	}

	get := env.request(http.MethodGet, "/api/v1/uploads/"+intent.UploadID, nil, "")
	if get.Code != http.StatusOK {
		t.Fatalf("GET 上传 status = %d", get.Code)
	}
	dto := decodeLibraryData[uploadDTO](t, get)
	if dto.State != library.StateFailed || dto.Error == nil || dto.Error.Reason != reason {
		t.Fatalf("GET 上传 DTO = %+v", dto)
	}
}

func TestUploadHTTPErrors(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)

	badExtension := env.request(http.MethodPost, "/api/v1/uploads",
		[]byte(`{"clientUploadId":"c1","fileName":"a.txt","byteSize":1}`), "application/json")
	if badExtension.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("非法扩展名 status = %d", badExtension.Code)
	}
	oversize := env.request(http.MethodPost, "/api/v1/uploads",
		[]byte(fmt.Sprintf(`{"clientUploadId":"c2","fileName":"a.pdf","byteSize":%d}`, library.MaxFileSize+1)), "application/json")
	if oversize.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超限 status = %d", oversize.Code)
	}
	badJSON := env.request(http.MethodPost, "/api/v1/uploads", []byte(`{"clientUploadId":`), "application/json")
	if badJSON.Code != http.StatusBadRequest {
		t.Fatalf("坏 JSON status = %d", badJSON.Code)
	}
	unknownField := env.request(http.MethodPost, "/api/v1/uploads",
		[]byte(`{"clientUploadId":"c3","fileName":"a.pdf","byteSize":1,"extra":1}`), "application/json")
	if unknownField.Code != http.StatusBadRequest {
		t.Fatalf("未知字段 status = %d", unknownField.Code)
	}
	wrongType := env.request(http.MethodPost, "/api/v1/uploads",
		[]byte(`{"clientUploadId":"c4","fileName":"a.pdf","byteSize":1}`), "text/plain")
	if wrongType.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("错误 Content-Type status = %d", wrongType.Code)
	}

	intent := env.createIntent("flow.epub", 4)
	conflict := env.request(http.MethodPost, "/api/v1/uploads",
		[]byte(`{"clientUploadId":"client-flow.epub","fileName":"flow.epub","byteSize":5}`), "application/json")
	if conflict.Code != http.StatusConflict {
		t.Fatalf("元信息冲突 status = %d", conflict.Code)
	}
	multipart := env.request(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content",
		[]byte("data"), "multipart/form-data; boundary=x")
	if multipart.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("multipart status = %d", multipart.Code)
	}
	if recorder := env.request(http.MethodGet, "/api/v1/uploads/"+strings.Repeat("a", 32), nil, ""); recorder.Code != http.StatusNotFound {
		t.Fatalf("未知上传 status = %d", recorder.Code)
	}

	missingLength := httptest.NewRequest(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content", strings.NewReader("data"))
	missingLength.ContentLength = -1
	missingLength.Header.Set("Content-Type", "application/octet-stream")
	missingRecorder := httptest.NewRecorder()
	env.mux.ServeHTTP(missingRecorder, missingLength)
	if missingRecorder.Code != http.StatusBadRequest {
		t.Fatalf("缺 Content-Length status = %d，body=%s", missingRecorder.Code, missingRecorder.Body.String())
	}
}

func TestCoverServesETagAndRejectsOldVersion(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	stored := env.upload("covered.epub", []byte("cover-source-bytes"))
	task, ok, err := env.store.ClaimNextTask(context.Background(), time.Minute)
	if err != nil || !ok {
		t.Fatalf("ClaimNextTask() = %v, %v", ok, err)
	}
	title := "封面书"
	version, err := env.store.FinalizeBookIndexTask(context.Background(), task.ID, store.BookIndexData{
		Title:            &title,
		ExtractionStatus: "ok",
		CoverGenerated:   true,
	})
	if err != nil {
		t.Fatalf("FinalizeBookIndexTask() error = %v", err)
	}
	coverDir := filepath.Join(env.cacheDir, "covers", *stored.BookID, fmt.Sprintf("%d", version))
	if err := os.MkdirAll(coverDir, 0o750); err != nil {
		t.Fatal(err)
	}
	gridPath := filepath.Join(coverDir, "grid.jpg")
	if err := os.WriteFile(gridPath, []byte{0xff, 0xd8, 0xff, 0xd9}, 0o600); err != nil {
		t.Fatal(err)
	}

	recorder := env.request(http.MethodGet,
		fmt.Sprintf("/api/v1/books/%s/cover?variant=grid&v=%d", *stored.BookID, version), nil, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("封面 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	etag := recorder.Header().Get("ETag")
	if etag == "" {
		t.Fatal("封面缺少 ETag")
	}
	if cache := recorder.Header().Get("Cache-Control"); cache != "private, no-cache" {
		t.Fatalf("Cache-Control = %q", cache)
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "image/jpeg" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	conditional := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/v1/books/%s/cover?variant=grid&v=%d", *stored.BookID, version), nil)
	conditional.Header.Set("If-None-Match", etag)
	conditionalRecorder := httptest.NewRecorder()
	env.mux.ServeHTTP(conditionalRecorder, conditional)
	if conditionalRecorder.Code != http.StatusNotModified {
		t.Fatalf("条件请求 status = %d，期望 304", conditionalRecorder.Code)
	}
	if conditionalRecorder.Body.Len() != 0 {
		t.Fatalf("304 不应有 body，got %q", conditionalRecorder.Body.String())
	}
	if cache := conditionalRecorder.Header().Get("Cache-Control"); cache != "private, no-cache" {
		t.Fatalf("304 Cache-Control = %q", cache)
	}
	old := env.request(http.MethodGet,
		fmt.Sprintf("/api/v1/books/%s/cover?variant=grid&v=%d", *stored.BookID, version-1), nil, "")
	if old.Code != http.StatusNotFound {
		t.Fatalf("旧版本封面 status = %d，期望 404", old.Code)
	}
}

func TestBookListTitleSortPagination(t *testing.T) {
	validator := validatorFunc(func(_ context.Context, _ string, ext string) (formats.Result, error) {
		return formats.Result{Format: ext, MediaType: testMediaType(ext), Readable: true}, nil
	})
	env := newLibraryHTTPEnv(t, validator, allowAllMiddleware, allowAllMiddleware)
	for _, name := range []string{"alpha.epub", "bravo.epub", "charlie.epub"} {
		env.upload(name, []byte("title-"+name))
	}
	first := env.request(http.MethodGet, "/api/v1/books?sort=title&limit=2", nil, "")
	if first.Code != http.StatusOK {
		t.Fatalf("title 排序 status = %d", first.Code)
	}
	var page1 struct {
		Data []bookDTO `json:"data"`
		Meta struct {
			NextCursor *string `json:"nextCursor"`
			Total      *int64  `json:"total"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &page1); err != nil {
		t.Fatal(err)
	}
	if len(page1.Data) != 2 || page1.Data[0].Title != "alpha" || page1.Data[1].Title != "bravo" || page1.Meta.NextCursor == nil {
		t.Fatalf("title 第一页 = %+v", page1)
	}
	second := env.request(http.MethodGet, "/api/v1/books?sort=title&limit=2&cursor="+*page1.Meta.NextCursor, nil, "")
	if second.Code != http.StatusOK {
		t.Fatalf("title 第二页 status = %d，body=%s", second.Code, second.Body.String())
	}
	var page2 struct {
		Data []bookDTO `json:"data"`
		Meta struct {
			NextCursor *string `json:"nextCursor"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &page2); err != nil {
		t.Fatal(err)
	}
	if len(page2.Data) != 1 || page2.Data[0].Title != "charlie" || page2.Meta.NextCursor != nil {
		t.Fatalf("title 第二页 = %+v", page2)
	}
}
