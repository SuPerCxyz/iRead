package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"iread/server/internal/reader/pdf"
	"iread/server/internal/store"
)

func newDownloadRenameEnv(t *testing.T, auth, csrf Middleware) *reindexEnv {
	t.Helper()
	env := newReindexEnv(t, readableTestValidator(), auth, csrf)
	handler, err := NewPDFContentHandler(PDFContentOptions{
		Resolver:    pdf.NewStoreResolver(env.store),
		BooksDir:    env.booksDir,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequireAuth: auth,
	})
	if err != nil {
		t.Fatalf("NewPDFContentHandler() error = %v", err)
	}
	handler.RegisterPDFRoutes(env.mux)
	return env
}

func (e *reindexEnv) uploadReady(fileName string, data []byte) (string, store.BookDetail) {
	e.t.Helper()
	stored := e.upload(fileName, data)
	if stored.BookID == nil || stored.TaskID == nil {
		e.t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	e.completeTask(e.t, *stored.TaskID, pointerTo(int64(1)), "ok")
	return *stored.BookID, e.detail(*stored.BookID)
}

func patchBookTitle(env *reindexEnv, bookID, title string) *httptest.ResponseRecorder {
	body, err := json.Marshal(map[string]string{"title": title})
	if err != nil {
		env.t.Fatal(err)
	}
	return env.request(http.MethodPatch, "/api/v1/books/"+bookID, body, "application/json")
}

func TestBookDownloadFourFormatsAndHeaders(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	for _, extension := range []string{"epub", "pdf", "cbz", "cbr"} {
		t.Run(extension, func(t *testing.T) {
			data := []byte("download-content-" + extension)
			stored := env.upload("book."+extension, data)
			if stored.BookID == nil {
				t.Fatalf("上传结果缺少 bookId: %+v", stored)
			}
			detail := env.detail(*stored.BookID)
			recorder := env.request(http.MethodGet, "/api/v1/books/"+*stored.BookID+"/download", nil, "")
			if recorder.Code != http.StatusOK {
				t.Fatalf("下载 status = %d，body=%s", recorder.Code, recorder.Body.String())
			}
			if !bytes.Equal(recorder.Body.Bytes(), data) {
				t.Fatalf("下载内容不一致: %q", recorder.Body.String())
			}
			if got := recorder.Header().Get("Content-Type"); got != testMediaType(extension) {
				t.Fatalf("Content-Type = %q，期望 %q", got, testMediaType(extension))
			}
			if got := recorder.Header().Get("Accept-Ranges"); got != "bytes" {
				t.Fatalf("Accept-Ranges = %q", got)
			}
			if got := recorder.Header().Get("ETag"); got != `"`+detail.File.SHA256+`"` {
				t.Fatalf("ETag = %q", got)
			}
			if got := recorder.Header().Get("Cache-Control"); got != "private, no-cache" {
				t.Fatalf("Cache-Control = %q", got)
			}
			rawDisposition := recorder.Header().Get("Content-Disposition")
			mediaType, params, err := mime.ParseMediaType(rawDisposition)
			if err != nil || mediaType != "attachment" {
				t.Fatalf("Content-Disposition = %q err=%v", rawDisposition, err)
			}
			wantName := "HTTP 示例书." + extension
			if params["filename"] != wantName {
				t.Fatalf("filename = %q，期望 %q", params["filename"], wantName)
			}
			if !strings.Contains(strings.ToLower(rawDisposition), "filename*=") {
				t.Fatalf("中文文件名应使用 filename*: %q", rawDisposition)
			}

			head := env.request(http.MethodHead, "/api/v1/books/"+*stored.BookID+"/download", nil, "")
			if head.Code != http.StatusOK || head.Body.Len() != 0 {
				t.Fatalf("HEAD status = %d body=%d", head.Code, head.Body.Len())
			}
			if got := head.Header().Get("Content-Length"); got != fmt.Sprintf("%d", len(data)) {
				t.Fatalf("HEAD Content-Length = %q", got)
			}
			if got := head.Header().Get("Content-Disposition"); got != rawDisposition {
				t.Fatalf("HEAD Content-Disposition = %q", got)
			}
		})
	}
}

func TestBookDownloadRangeAndSanitizedFileName(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	data := []byte("0123456789abcdefghijklmnopqrstuvwxyz")
	stored := env.upload("range.epub", data)
	bookID := *stored.BookID

	if _, err := env.db.Exec(`UPDATE books SET display_title = ? WHERE id = ?`,
		"bad/\r\n\"name:*.epub", bookID); err != nil {
		t.Fatal(err)
	}
	recorder := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("下载 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	raw := recorder.Header().Get("Content-Disposition")
	if strings.ContainsAny(raw, "\r\n") {
		t.Fatalf("Content-Disposition 含换行: %q", raw)
	}
	mediaType, params, err := mime.ParseMediaType(raw)
	if err != nil || mediaType != "attachment" {
		t.Fatalf("Content-Disposition = %q err=%v", raw, err)
	}
	if params["filename"] != "bad name .epub.epub" {
		t.Fatalf("清洗后 filename = %q", params["filename"])
	}

	rangeRequest := httptest.NewRequest(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil)
	rangeRequest.Header.Set("Range", "bytes=2-5")
	rangeRecorder := httptest.NewRecorder()
	env.mux.ServeHTTP(rangeRecorder, rangeRequest)
	if rangeRecorder.Code != http.StatusPartialContent {
		t.Fatalf("Range status = %d，body=%s", rangeRecorder.Code, rangeRecorder.Body.String())
	}
	if got := rangeRecorder.Header().Get("Content-Range"); got != fmt.Sprintf("bytes 2-5/%d", len(data)) {
		t.Fatalf("Content-Range = %q", got)
	}
	if !bytes.Equal(rangeRecorder.Body.Bytes(), data[2:6]) {
		t.Fatalf("Range body = %q", rangeRecorder.Body.String())
	}

	headRange := httptest.NewRequest(http.MethodHead, "/api/v1/books/"+bookID+"/download", nil)
	headRange.Header.Set("Range", "bytes=0-3")
	headRecorder := httptest.NewRecorder()
	env.mux.ServeHTTP(headRecorder, headRange)
	if headRecorder.Code != http.StatusOK || headRecorder.Body.Len() != 0 {
		t.Fatalf("HEAD Range status = %d body=%d", headRecorder.Code, headRecorder.Body.Len())
	}

	conditional := httptest.NewRequest(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil)
	conditional.Header.Set("If-None-Match", recorder.Header().Get("ETag"))
	conditionalRecorder := httptest.NewRecorder()
	env.mux.ServeHTTP(conditionalRecorder, conditional)
	if conditionalRecorder.Code != http.StatusNotModified || conditionalRecorder.Body.Len() != 0 {
		t.Fatalf("If-None-Match status = %d body=%d", conditionalRecorder.Code, conditionalRecorder.Body.Len())
	}
}

func TestBookDownloadAuthNotFoundAndMethods(t *testing.T) {
	denied := newDownloadRenameEnv(t, nil, allowAllMiddleware)
	if recorder := denied.request(http.MethodGet,
		"/api/v1/books/"+strings.Repeat("a", 32)+"/download", nil, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("未认证下载 status = %d", recorder.Code)
	}

	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	stored := env.upload("missing.epub", []byte("missing-file"))
	bookID := *stored.BookID

	if recorder := env.request(http.MethodGet, "/api/v1/books/"+strings.Repeat("f", 32)+"/download", nil, ""); recorder.Code != http.StatusNotFound {
		t.Fatalf("未知书籍 status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodPost, "/api/v1/books/"+bookID+"/download", nil, ""); recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("POST 下载 status = %d Allow=%q", recorder.Code, recorder.Header().Get("Allow"))
	}
	if recorder := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/download/extra", nil, ""); recorder.Code != http.StatusNotFound {
		t.Fatalf("多余子路径 status = %d", recorder.Code)
	}

	detail := env.detail(bookID)
	if err := os.Remove(filepath.Join(env.booksDir, filepath.FromSlash(detail.File.StorageRelPath))); err != nil {
		t.Fatal(err)
	}
	if recorder := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil, ""); recorder.Code != http.StatusNotFound {
		t.Fatalf("文件缺失 status = %d", recorder.Code)
	}
}

func TestBookDownloadSizeMismatchAndTraversal(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	stored := env.upload("storage.pdf", []byte("%PDF-storage-bytes"))
	bookID := *stored.BookID
	detail := env.detail(bookID)
	storagePath := filepath.Join(env.booksDir, filepath.FromSlash(detail.File.StorageRelPath))

	if err := os.WriteFile(storagePath, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	recorder := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil, "")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("大小不一致 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if envelope := decodeLibraryError(t, recorder); envelope.Error.Code != "storage_unavailable" {
		t.Fatalf("大小不一致 code = %q", envelope.Error.Code)
	}

	secret := filepath.Join(env.root, "secret.pdf")
	if err := os.WriteFile(secret, []byte("top-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`UPDATE book_files SET storage_rel_path = ? WHERE book_id = ?`,
		"../secret.pdf", bookID); err != nil {
		t.Fatal(err)
	}
	traversal := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil, "")
	if traversal.Code != http.StatusNotFound {
		t.Fatalf("路径穿越 status = %d，body=%s", traversal.Code, traversal.Body.String())
	}
	if strings.Contains(traversal.Body.String(), "top-secret") {
		t.Fatal("路径穿越泄露了 books 根外文件")
	}
}

func TestRenameBookHTTPMovesFile(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	data := []byte("rename-http-bytes")
	bookID, before := env.uploadReady("rename.epub", data)
	oldPath := filepath.Join(env.booksDir, filepath.FromSlash(before.File.StorageRelPath))

	recorder := patchBookTitle(env, bookID, "  新 书名  ")
	if recorder.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	dto := decodeLibraryData[bookDetailDTO](t, recorder)
	if dto.Title != "新 书名" || dto.OriginalFileName != "新 书名.epub" || dto.Extension != "epub" {
		t.Fatalf("PATCH DTO = %+v", dto)
	}
	after := env.detail(bookID)
	wantRel := bookID + "/新 书名.epub"
	if after.DisplayTitle != "新 书名" || after.File.OriginalFileName != "新 书名.epub" ||
		after.File.StorageRelPath != wantRel {
		t.Fatalf("数据库登记 = %+v", after.File)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("旧文件仍存在: %v", err)
	}
	newPath := filepath.Join(env.booksDir, filepath.FromSlash(wantRel))
	content, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatalf("新文件不存在: %v", err)
	}
	if !bytes.Equal(content, data) {
		t.Fatal("改名改变了原件字节")
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != after.File.SHA256 || after.File.SHA256 != before.File.SHA256 {
		t.Fatal("改名后 SHA-256 与 fileVersion 不一致")
	}
}

func TestRenameBookValidationAndStatus(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	bookID, _ := env.uploadReady("validation.epub", []byte("validation"))

	cases := []struct {
		name        string
		body        string
		contentType string
		wantStatus  int
		wantCode    string
		wantField   string
		wantReason  string
	}{
		{name: "空书名", body: `{"title":""}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "required"},
		{name: "纯空白", body: `{"title":"   "}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "required"},
		{name: "null", body: `{"title":null}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "required"},
		{name: "超长", body: `{"title":"` + strings.Repeat("长", 501) + `"}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "too_long"},
		{name: "NUL", body: `{"title":"a\u0000b"}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "control_character"},
		{name: "控制字符", body: `{"title":"a\u0001b"}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "control_character"},
		{name: "未知字段", body: `{"title":"ok","extra":1}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "extra", wantReason: "unknown_field"},
		{name: "缺少字段", body: `{}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "required"},
		{name: "类型错误", body: `{"title":123}`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "title", wantReason: "invalid_type"},
		{name: "顶层类型错误", body: `[]`, contentType: "application/json", wantStatus: 422, wantCode: "invalid_request", wantField: "body", wantReason: "invalid_type"},
		{name: "JSON 语法错误", body: `{"title":`, contentType: "application/json", wantStatus: 400, wantCode: "invalid_request"},
		{name: "错误 Content-Type", body: `{"title":"ok"}`, contentType: "text/plain", wantStatus: 415, wantCode: "unsupported_media_type"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := env.request(http.MethodPatch, "/api/v1/books/"+bookID, []byte(testCase.body), testCase.contentType)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
			}
			envelope := decodeLibraryError(t, recorder)
			if envelope.Error.Code != testCase.wantCode {
				t.Fatalf("code = %q，期望 %q", envelope.Error.Code, testCase.wantCode)
			}
			if testCase.wantField != "" {
				if got := envelope.Error.Details["field"]; got != testCase.wantField {
					t.Fatalf("details.field = %v，期望 %q", got, testCase.wantField)
				}
			}
			if testCase.wantReason != "" {
				if got := envelope.Error.Details["reason"]; got != testCase.wantReason {
					t.Fatalf("details.reason = %v，期望 %q", got, testCase.wantReason)
				}
			}
		})
	}

	tooLarge := `{"title":"` + strings.Repeat("a", 70<<10) + `"}`
	if recorder := env.request(http.MethodPatch, "/api/v1/books/"+bookID, []byte(tooLarge), "application/json"); recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超限 body status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodPatch, "/api/v1/books/"+strings.Repeat("f", 32), []byte(`{"title":"x"}`), "application/json"); recorder.Code != http.StatusNotFound {
		t.Fatalf("未知书籍 status = %d", recorder.Code)
	}

	// 500 rune 是允许上限。
	limitTitle := strings.Repeat("长", 500)
	if recorder := patchBookTitle(env, bookID, limitTitle); recorder.Code != http.StatusOK {
		t.Fatalf("500 rune 书名 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}

	// indexing 状态拒绝改名，避免与索引读取原件竞争。
	indexing := env.upload("indexing.epub", []byte("indexing"))
	if recorder := patchBookTitle(env, *indexing.BookID, "新书名"); recorder.Code != http.StatusConflict {
		t.Fatalf("indexing status = %d，body=%s", recorder.Code, recorder.Body.String())
	} else if envelope := decodeLibraryError(t, recorder); envelope.Error.Code != "state_conflict" {
		t.Fatalf("indexing code = %q", envelope.Error.Code)
	}

	// 无 CSRF：复用同一 service，换用拒绝 CSRF 的 handler。
	denyHandlers, err := NewLibraryHandlers(LibraryOptions{
		Service:     env.service,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequireAuth: allowAllMiddleware,
		RequireCSRF: denyCSRFMiddleware,
	})
	if err != nil {
		t.Fatal(err)
	}
	denyMux := http.NewServeMux()
	denyHandlers.RegisterLibraryRoutes(denyMux)
	csrfRequest := httptest.NewRequest(http.MethodPatch, "/api/v1/books/"+bookID, strings.NewReader(`{"title":"x"}`))
	csrfRequest.Header.Set("Content-Type", "application/json")
	csrfRecorder := httptest.NewRecorder()
	denyMux.ServeHTTP(csrfRecorder, csrfRequest)
	if csrfRecorder.Code != http.StatusForbidden {
		t.Fatalf("无 CSRF status = %d，body=%s", csrfRecorder.Code, csrfRecorder.Body.String())
	}
}

func TestRenameBookRepeatAndSuffix(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	bookID, _ := env.uploadReady("repeat.epub", []byte("repeat-suffix"))

	if recorder := patchBookTitle(env, bookID, "第一版"); recorder.Code != http.StatusOK {
		t.Fatalf("首次改名 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	first := env.detail(bookID)
	if recorder := patchBookTitle(env, bookID, "第一版"); recorder.Code != http.StatusOK {
		t.Fatalf("同名重复 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if after := env.detail(bookID); after.File.StorageRelPath != first.File.StorageRelPath {
		t.Fatalf("同名重复改变了路径: %q -> %q", first.File.StorageRelPath, after.File.StorageRelPath)
	}

	blockedPath := filepath.Join(env.booksDir, bookID, "第二版.epub")
	if err := os.WriteFile(blockedPath, []byte("placeholder"), 0o600); err != nil {
		t.Fatal(err)
	}
	if recorder := patchBookTitle(env, bookID, "第二版"); recorder.Code != http.StatusOK {
		t.Fatalf("冲突改名 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	after := env.detail(bookID)
	if after.File.StorageRelPath != bookID+"/第二版 (2).epub" ||
		after.File.OriginalFileName != "第二版 (2).epub" {
		t.Fatalf("冲突后缀登记 = %q / %q", after.File.StorageRelPath, after.File.OriginalFileName)
	}
	placeholder, err := os.ReadFile(blockedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(placeholder) != "placeholder" {
		t.Fatal("冲突目标文件被覆盖")
	}
}

func TestRenameBookRollsBackFileOnDatabaseFailure(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	bookID, before := env.uploadReady("rollback.epub", []byte("rollback-bytes"))
	oldPath := filepath.Join(env.booksDir, filepath.FromSlash(before.File.StorageRelPath))

	if _, err := env.db.Exec(`
		CREATE TRIGGER fail_book_rename BEFORE UPDATE ON book_files
		BEGIN
			SELECT RAISE(ABORT, 'forced rename failure');
		END;`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = env.db.Exec(`DROP TRIGGER IF EXISTS fail_book_rename`) }()

	recorder := patchBookTitle(env, bookID, "数据库 失败")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("DB 失败 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := os.Stat(oldPath); err != nil {
		t.Fatalf("失败后旧文件不存在: %v", err)
	}
	targetPath := filepath.Join(env.booksDir, bookID, "数据库 失败.epub")
	if _, err := os.Stat(targetPath); !os.IsNotExist(err) {
		t.Fatalf("失败后目标文件残留: %v", err)
	}
	after := env.detail(bookID)
	if after.DisplayTitle != before.DisplayTitle || after.File.StorageRelPath != before.File.StorageRelPath ||
		after.File.OriginalFileName != before.File.OriginalFileName {
		t.Fatalf("失败后数据库被部分更新: %+v", after.File)
	}
}

func TestRenameBookKeepsReadingDownloadAndReindex(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	pdfData := []byte("%PDF-1.7\nreading-after-rename\n")
	bookID, before := env.uploadReady("reading.pdf", pdfData)

	recorder := patchBookTitle(env, bookID, "阅读 测试")
	if recorder.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	after := env.detail(bookID)
	if after.File.SHA256 != before.File.SHA256 {
		t.Fatal("改名改变了 fileVersion")
	}

	download := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil, "")
	if download.Code != http.StatusOK || !bytes.Equal(download.Body.Bytes(), pdfData) {
		t.Fatalf("改名后下载 status = %d body=%q", download.Code, download.Body.String())
	}
	_, params, err := mime.ParseMediaType(download.Header().Get("Content-Disposition"))
	if err != nil || params["filename"] != "阅读 测试.pdf" {
		t.Fatalf("改名后下载文件名 = %v err=%v", params, err)
	}

	contentURL := "/api/v1/books/" + bookID + "/versions/" + after.File.SHA256 + "/content"
	content := env.request(http.MethodGet, contentURL, nil, "")
	if content.Code != http.StatusOK || !bytes.Equal(content.Body.Bytes(), pdfData) {
		t.Fatalf("改名后 PDF content status = %d body=%q", content.Code, content.Body.String())
	}
	head := env.request(http.MethodHead, contentURL, nil, "")
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("改名后 PDF HEAD status = %d body=%d", head.Code, head.Body.Len())
	}
	rangeRequest := httptest.NewRequest(http.MethodHead, contentURL, nil)
	rangeRequest.Header.Set("Range", "bytes=0-4")
	rangeRecorder := httptest.NewRecorder()
	env.mux.ServeHTTP(rangeRecorder, rangeRequest)
	if rangeRecorder.Code != http.StatusOK {
		t.Fatalf("改名后 PDF HEAD Range status = %d", rangeRecorder.Code)
	}
	rangeRequest = httptest.NewRequest(http.MethodGet, contentURL, nil)
	rangeRequest.Header.Set("Range", "bytes=0-4")
	rangeRecorder = httptest.NewRecorder()
	env.mux.ServeHTTP(rangeRecorder, rangeRequest)
	if rangeRecorder.Code != http.StatusPartialContent || !bytes.Equal(rangeRecorder.Body.Bytes(), pdfData[:5]) {
		t.Fatalf("改名后 PDF Range status = %d body=%q", rangeRecorder.Code, rangeRecorder.Body.String())
	}

	reindex := env.request(http.MethodPost, "/api/v1/books/"+bookID+"/reindex", nil, "")
	if reindex.Code != http.StatusAccepted {
		t.Fatalf("改名后 reindex status = %d，body=%s", reindex.Code, reindex.Body.String())
	}
}

func TestRenameBookConcurrentDownloads(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	data := []byte("concurrent-http-download")
	bookID, _ := env.uploadReady("concurrent.epub", data)

	var wait sync.WaitGroup
	errorsCh := make(chan string, 32)
	wait.Add(1)
	go func() {
		defer wait.Done()
		for index := 0; index < 15; index++ {
			title := "并发 书名"
			if index%2 == 1 {
				title = "并发 书名 二"
			}
			recorder := patchBookTitle(env, bookID, title)
			if recorder.Code != http.StatusOK {
				errorsCh <- fmt.Sprintf("PATCH status=%d body=%s", recorder.Code, recorder.Body.String())
				return
			}
		}
	}()

	for worker := 0; worker < 3; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for index := 0; index < 20; index++ {
				recorder := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/download", nil, "")
				if recorder.Code != http.StatusOK {
					errorsCh <- fmt.Sprintf("下载 status=%d body=%s", recorder.Code, recorder.Body.String())
					return
				}
				if !bytes.Equal(recorder.Body.Bytes(), data) {
					errorsCh <- "并发下载内容不一致"
					return
				}
			}
		}()
	}
	wait.Wait()
	close(errorsCh)
	for message := range errorsCh {
		t.Fatal(message)
	}
}

func TestRenameBookDoesNotChangeUploadHashNamingBeforeRename(t *testing.T) {
	env := newDownloadRenameEnv(t, allowAllMiddleware, allowAllMiddleware)
	stored := env.upload("hash-name.epub", []byte("hash-name"))
	detail := env.detail(*stored.BookID)
	if detail.File.StorageRelPath != *stored.BookID+"/"+detail.File.SHA256+".epub" {
		t.Fatalf("未改名书籍应保持哈希文件名: %q", detail.File.StorageRelPath)
	}
}
