package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"iread/server/internal/formats"
	"iread/server/internal/jobs"
	"iread/server/internal/library"
	"iread/server/internal/reader/epub"
	"iread/server/internal/reader/epub/epubtest"
	"iread/server/internal/store"
)

type reindexEnv struct {
	t        *testing.T
	mux      *http.ServeMux
	store    *store.Store
	db       *sql.DB
	service  *library.Service
	manager  *jobs.Manager
	root     string
	booksDir string
	cacheDir string
	started  bool
}

func newReindexEnv(t *testing.T, validator library.Validator, auth, csrf Middleware) *reindexEnv {
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
	dbPath := filepath.Join(dbDir, "iread.db")
	database, err := store.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}
	raw, err := sql.Open("sqlite", readerTestDSN(dbPath))
	if err != nil {
		_ = database.Close()
		t.Fatalf("打开原始数据库连接: %v", err)
	}
	service, err := library.NewService(library.Config{
		Store:     database,
		BooksDir:  booksDir,
		CacheDir:  cacheDir,
		Validator: validator,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		_ = raw.Close()
		_ = database.Close()
		t.Fatalf("NewService() error = %v", err)
	}
	manager, err := jobs.NewManager(jobs.Options{
		Store:    database,
		BooksDir: booksDir,
		CacheDir: cacheDir,
		Workers:  1,
		Poll:     10 * time.Millisecond,
	})
	if err != nil {
		_ = raw.Close()
		_ = database.Close()
		t.Fatalf("NewManager() error = %v", err)
	}
	handlers, err := NewLibraryHandlers(LibraryOptions{
		Service:     service,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequireAuth: auth,
		RequireCSRF: csrf,
	})
	if err != nil {
		_ = raw.Close()
		_ = database.Close()
		t.Fatalf("NewLibraryHandlers() error = %v", err)
	}
	mux := http.NewServeMux()
	handlers.RegisterLibraryRoutes(mux)
	manifestHandlers, err := NewReaderManifestHandlers(ReaderManifestOptions{
		Resolver:    NewReaderManifestStoreResolver(database),
		Store:       database,
		BooksDir:    booksDir,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequireAuth: auth,
	})
	if err != nil {
		_ = raw.Close()
		_ = database.Close()
		t.Fatalf("NewReaderManifestHandlers() error = %v", err)
	}
	manifestHandlers.RegisterReaderManifestRoutes(mux)
	env := &reindexEnv{
		t:        t,
		mux:      mux,
		store:    database,
		db:       raw,
		service:  service,
		manager:  manager,
		root:     root,
		booksDir: booksDir,
		cacheDir: cacheDir,
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = env.stopWorker(stopCtx)
		_ = raw.Close()
		_ = database.Close()
	})
	return env
}

func (e *reindexEnv) startWorker() {
	e.t.Helper()
	if e.started {
		e.t.Fatal("worker 已启动")
	}
	if err := e.manager.Start(context.Background()); err != nil {
		e.t.Fatalf("启动 worker: %v", err)
	}
	e.started = true
}

func (e *reindexEnv) stopWorker(ctx context.Context) error {
	if !e.started {
		return nil
	}
	err := e.manager.Stop(ctx)
	e.started = false
	return err
}

func (e *reindexEnv) request(method, target string, body []byte, contentType string) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(body))
	}
	request := httptest.NewRequest(method, target, reader)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	recorder := httptest.NewRecorder()
	e.mux.ServeHTTP(recorder, request)
	return recorder
}

func (e *reindexEnv) upload(fileName string, data []byte) uploadDTO {
	e.t.Helper()
	body := fmt.Sprintf(`{"clientUploadId":%q,"fileName":%q,"byteSize":%d}`,
		"reindex-"+fileName, fileName, len(data))
	recorder := e.request(http.MethodPost, "/api/v1/uploads", []byte(body), "application/json")
	if recorder.Code != http.StatusCreated {
		e.t.Fatalf("创建上传意图 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	intent := decodeLibraryData[uploadDTO](e.t, recorder)
	recorder = e.request(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content",
		data, "application/octet-stream")
	if recorder.Code != http.StatusOK {
		e.t.Fatalf("上传 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	return decodeLibraryData[uploadDTO](e.t, recorder)
}

func (e *reindexEnv) claimTask(taskID string) {
	e.t.Helper()
	task, ok, err := e.store.ClaimNextTask(context.Background(), time.Minute)
	if err != nil {
		e.t.Fatalf("领取任务: %v", err)
	}
	if !ok || task.ID != taskID {
		e.t.Fatalf("领取任务 = %+v ok=%v，期望 %s", task, ok, taskID)
	}
}

func (e *reindexEnv) completeTask(t *testing.T, taskID string, pageCount *int64, extraction string) {
	t.Helper()
	e.claimTask(taskID)
	if _, err := e.store.FinalizeBookIndexTask(context.Background(), taskID, store.BookIndexData{
		PageCount:        pageCount,
		ExtractionStatus: extraction,
	}); err != nil {
		t.Fatalf("提交索引任务: %v", err)
	}
}

func (e *reindexEnv) failTask(t *testing.T, taskID string) {
	t.Helper()
	e.claimTask(taskID)
	if err := e.store.FailTask(context.Background(), taskID, "invalid_file", "索引失败", false); err != nil {
		t.Fatalf("置任务失败: %v", err)
	}
}

func pointerTo[T any](value T) *T { return &value }

func (e *reindexEnv) detail(bookID string) store.BookDetail {
	e.t.Helper()
	detail, err := e.store.GetBookDetail(context.Background(), bookID)
	if err != nil {
		e.t.Fatalf("读取书籍详情: %v", err)
	}
	return detail
}

func (e *reindexEnv) taskCount(bookID string) int {
	e.t.Helper()
	var count int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM background_tasks WHERE book_id = ?`, bookID).Scan(&count); err != nil {
		e.t.Fatalf("统计任务数: %v", err)
	}
	return count
}

func (e *reindexEnv) waitTask(taskID, state string) store.Task {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		task, err := e.store.GetTask(context.Background(), taskID)
		if err == nil && task.State == state {
			return task
		}
		time.Sleep(20 * time.Millisecond)
	}
	task, err := e.store.GetTask(context.Background(), taskID)
	e.t.Fatalf("任务 %s 未进入 %s: task=%+v err=%v", taskID, state, task, err)
	return store.Task{}
}

func (e *reindexEnv) waitStatus(bookID, status string) store.BookDetail {
	e.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		detail, err := e.store.GetBookDetail(context.Background(), bookID)
		if err == nil && detail.Status == status {
			return detail
		}
		time.Sleep(20 * time.Millisecond)
	}
	detail, err := e.store.GetBookDetail(context.Background(), bookID)
	e.t.Fatalf("书籍 %s 未进入 %s: detail=%+v err=%v", bookID, status, detail, err)
	return store.BookDetail{}
}

func (e *reindexEnv) postReindex(bookID string) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.request(http.MethodPost, "/api/v1/books/"+bookID+"/reindex", nil, "")
}

func TestBookReindexCreatesTaskForReadyPartialAndError(t *testing.T) {
	testCases := []struct {
		name       string
		extraction string
		fail       bool
	}{
		{name: "ready", extraction: "ok"},
		{name: "partial", extraction: "partial"},
		{name: "error", fail: true},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
			stored := env.upload("seed-"+testCase.name+".pdf", []byte("seed-"+testCase.name))
			if stored.BookID == nil || stored.TaskID == nil {
				t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
			}
			bookID, oldTaskID := *stored.BookID, *stored.TaskID
			if testCase.fail {
				env.failTask(t, oldTaskID)
			} else {
				env.completeTask(t, oldTaskID, pointerTo(int64(2)), testCase.extraction)
			}
			before := env.detail(bookID)
			if testCase.fail && before.Status != "error" {
				t.Fatalf("error 书籍状态 = %s", before.Status)
			}
			if !testCase.fail && (before.Status != "ready" || before.Metadata.ExtractionStatus != testCase.extraction) {
				t.Fatalf("ready 书籍状态 = %s/%s", before.Status, before.Metadata.ExtractionStatus)
			}

			recorder := env.postReindex(bookID)
			if recorder.Code != http.StatusAccepted {
				t.Fatalf("POST reindex status = %d，body=%s", recorder.Code, recorder.Body.String())
			}
			payload := decodeLibraryData[reindexTaskDTO](t, recorder)
			if payload.TaskID == "" || payload.TaskID == oldTaskID {
				t.Fatalf("reindex taskId = %q，旧任务 = %q", payload.TaskID, oldTaskID)
			}
			task, err := env.store.GetTask(context.Background(), payload.TaskID)
			if err != nil {
				t.Fatalf("读取新任务: %v", err)
			}
			if task.State != store.TaskStateQueued || task.Kind != store.TaskKindBookIndex ||
				task.BookID == nil || *task.BookID != bookID {
				t.Fatalf("新任务 = %+v", task)
			}
			after := env.detail(bookID)
			if after.Status != "indexing" {
				t.Fatalf("重索引后书籍状态 = %s", after.Status)
			}
			if after.Metadata.ExtractionStatus != "pending" || after.Metadata.ExtractedAt != nil {
				t.Fatalf("重索引后元数据 = %+v", after.Metadata)
			}
			if after.IndexTaskID == nil || *after.IndexTaskID != payload.TaskID {
				t.Fatalf("书籍 indexTaskId = %v，期望 %s", after.IndexTaskID, payload.TaskID)
			}
			if count := env.taskCount(bookID); count != 2 {
				t.Fatalf("任务数 = %d，期望 2（旧任务 + 新任务）", count)
			}
		})
	}
}

func TestBookReindexIsIdempotentForActiveTask(t *testing.T) {
	env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	stored := env.upload("idempotent.pdf", []byte("idempotent"))
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	bookID := *stored.BookID
	env.completeTask(t, *stored.TaskID, pointerTo(int64(2)), "ok")

	first := env.postReindex(bookID)
	if first.Code != http.StatusAccepted {
		t.Fatalf("首次 reindex status = %d，body=%s", first.Code, first.Body.String())
	}
	firstID := decodeLibraryData[reindexTaskDTO](t, first).TaskID

	second := env.postReindex(bookID)
	if second.Code != http.StatusAccepted {
		t.Fatalf("重复 reindex status = %d，body=%s", second.Code, second.Body.String())
	}
	secondID := decodeLibraryData[reindexTaskDTO](t, second).TaskID
	if secondID != firstID {
		t.Fatalf("重复 reindex taskId = %q，期望同一 %q", secondID, firstID)
	}
	if count := env.taskCount(bookID); count != 2 {
		t.Fatalf("任务数 = %d，期望 2（初始 + 一次重索引）", count)
	}
	active, found, err := env.store.ActiveBookIndexTask(context.Background(), bookID)
	if err != nil || !found || active.ID != firstID {
		t.Fatalf("活动任务 = %+v found=%v err=%v", active, found, err)
	}
	detail := env.detail(bookID)
	if detail.Status != "indexing" || detail.Metadata.ExtractionStatus != "pending" {
		t.Fatalf("重复请求不应改变状态: %s/%s", detail.Status, detail.Metadata.ExtractionStatus)
	}
}

func TestBookReindexUnknownAuthAndCSRF(t *testing.T) {
	t.Run("unknown", func(t *testing.T) {
		env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
		recorder := env.postReindex(strings.Repeat("0", 32))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("未知书 status = %d，body=%s", recorder.Code, recorder.Body.String())
		}
		if envelope := decodeLibraryError(t, recorder); envelope.Error.Code != "not_found" {
			t.Fatalf("未知书 code = %q", envelope.Error.Code)
		}
		body := recorder.Body.String()
		for _, forbidden := range []string{env.root, "SELECT", "background_tasks", ".db"} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("错误响应泄露 %q: %s", forbidden, body)
			}
		}
	})

	t.Run("invalid id", func(t *testing.T) {
		env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
		recorder := env.postReindex("not-a-book-id")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("非法 ID status = %d，body=%s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("unauthenticated", func(t *testing.T) {
		env := newReindexEnv(t, readableTestValidator(), nil, allowAllMiddleware)
		recorder := env.postReindex(strings.Repeat("0", 32))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("未认证 status = %d，body=%s", recorder.Code, recorder.Body.String())
		}
		if envelope := decodeLibraryError(t, recorder); envelope.Error.Code != "unauthenticated" {
			t.Fatalf("未认证 code = %q", envelope.Error.Code)
		}
	})

	t.Run("missing csrf", func(t *testing.T) {
		env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
		stored := env.upload("csrf.pdf", []byte("csrf"))
		if stored.BookID == nil || stored.TaskID == nil {
			t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
		}
		env.completeTask(t, *stored.TaskID, pointerTo(int64(2)), "ok")
		csrfHandlers, err := NewLibraryHandlers(LibraryOptions{
			Service:     env.service,
			Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
			RequireAuth: allowAllMiddleware,
			RequireCSRF: denyCSRFMiddleware,
		})
		if err != nil {
			t.Fatalf("NewLibraryHandlers() error = %v", err)
		}
		csrfMux := http.NewServeMux()
		csrfHandlers.RegisterLibraryRoutes(csrfMux)
		request := httptest.NewRequest(http.MethodPost,
			"/api/v1/books/"+*stored.BookID+"/reindex", nil)
		recorder := httptest.NewRecorder()
		csrfMux.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("无 CSRF status = %d，body=%s", recorder.Code, recorder.Body.String())
		}
		envelope := decodeLibraryError(t, recorder)
		if envelope.Error.Code != "forbidden" || envelope.Error.Details["reason"] != "csrf_invalid" {
			t.Fatalf("无 CSRF 错误 = %+v", envelope.Error)
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
		recorder := env.request(http.MethodGet, "/api/v1/books/"+strings.Repeat("0", 32)+"/reindex", nil, "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("GET reindex status = %d，body=%s", recorder.Code, recorder.Body.String())
		}
		if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
			t.Fatalf("Allow = %q", allow)
		}
	})
}

func TestBookReindexUnsupportedIsRejected(t *testing.T) {
	env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	stored := env.upload("unsupported.pdf", []byte("unsupported"))
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	env.failTask(t, *stored.TaskID)
	if _, err := env.db.Exec(`UPDATE books SET status = 'unsupported' WHERE id = ?`, *stored.BookID); err != nil {
		t.Fatalf("更新 unsupported 状态: %v", err)
	}
	if _, err := env.db.Exec(`UPDATE book_metadata SET extraction_status = 'unsupported' WHERE book_id = ?`, *stored.BookID); err != nil {
		t.Fatalf("更新 unsupported 元数据: %v", err)
	}
	recorder := env.postReindex(*stored.BookID)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("unsupported reindex status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	envelope := decodeLibraryError(t, recorder)
	if envelope.Error.Code != "state_conflict" || envelope.Error.Details["reason"] != "book_not_reindexable" {
		t.Fatalf("unsupported reindex 错误 = %+v", envelope.Error)
	}
	if count := env.taskCount(*stored.BookID); count != 1 {
		t.Fatalf("unsupported 不应创建任务，任务数 = %d", count)
	}
}

func TestBookReindexWorkerUpdatesPDFPageCount(t *testing.T) {
	env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	pdfData := buildRealPDF(t, "旧索引 PDF", "测试作者", 3)
	stored := env.upload("old-index.pdf", pdfData)
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	bookID := *stored.BookID
	// 模拟旧索引：状态 ready、pageCount=0、元数据 partial、索引版本 1。
	env.completeTask(t, *stored.TaskID, pointerTo(int64(0)), "partial")
	before := env.detail(bookID)
	if before.Status != "ready" || before.Metadata.PageCount == nil || *before.Metadata.PageCount != 0 ||
		before.Metadata.ExtractionStatus != "partial" || before.IndexVersion != 1 {
		t.Fatalf("旧索引状态 = %s pageCount=%v extraction=%s version=%d",
			before.Status, before.Metadata.PageCount, before.Metadata.ExtractionStatus, before.IndexVersion)
	}

	recorder := env.postReindex(bookID)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("POST reindex status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	taskID := decodeLibraryData[reindexTaskDTO](t, recorder).TaskID
	queued := env.detail(bookID)
	if queued.Status != "indexing" || queued.Metadata.ExtractionStatus != "pending" ||
		queued.Metadata.PageCount == nil || *queued.Metadata.PageCount != 0 {
		t.Fatalf("重索引排队状态 = %s/%s pageCount=%v",
			queued.Status, queued.Metadata.ExtractionStatus, queued.Metadata.PageCount)
	}

	env.startWorker()
	env.waitTask(taskID, store.TaskStateSucceeded)
	after := env.waitStatus(bookID, "ready")
	if after.Metadata.PageCount == nil || *after.Metadata.PageCount != 3 {
		t.Fatalf("重索引后 pageCount = %v，期望 3", after.Metadata.PageCount)
	}
	if after.Metadata.ExtractionStatus != "ok" || after.IndexVersion != 2 {
		t.Fatalf("重索引后元数据 = %s version=%d", after.Metadata.ExtractionStatus, after.IndexVersion)
	}
}

func TestBookReindexWorkerRecoversErrorBook(t *testing.T) {
	env := newReindexEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	pdfData := buildRealPDF(t, "失败后重试 PDF", "测试作者", 4)
	stored := env.upload("error-recover.pdf", pdfData)
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	bookID := *stored.BookID
	env.failTask(t, *stored.TaskID)
	if before := env.detail(bookID); before.Status != "error" {
		t.Fatalf("初始书籍状态 = %s，期望 error", before.Status)
	}

	recorder := env.postReindex(bookID)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("POST reindex status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	taskID := decodeLibraryData[reindexTaskDTO](t, recorder).TaskID
	env.startWorker()
	env.waitTask(taskID, store.TaskStateSucceeded)
	after := env.waitStatus(bookID, "ready")
	if after.Metadata.PageCount == nil || *after.Metadata.PageCount != 4 ||
		after.Metadata.ExtractionStatus != "ok" || after.IndexVersion != 1 {
		t.Fatalf("失败书重索引结果 = pageCount=%v extraction=%s version=%d",
			after.Metadata.PageCount, after.Metadata.ExtractionStatus, after.IndexVersion)
	}
}

func TestBookReindexRebuildsStaleEPUBManifest(t *testing.T) {
	env := newReindexEnv(t, validatorFunc(func(ctx context.Context, tempPath, ext string) (formats.Result, error) {
		return formats.Validate(ctx, tempPath, ext)
	}), allowAllMiddleware, allowAllMiddleware)
	sample, err := epubtest.Build(epubtest.Options{Version: 3})
	if err != nil {
		t.Fatalf("生成 EPUB 样本: %v", err)
	}
	stored := env.upload("manifest.epub", sample.Data)
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	bookID := *stored.BookID
	env.startWorker()
	env.waitTask(*stored.TaskID, store.TaskStateSucceeded)
	env.waitStatus(bookID, "ready")

	manifestURL := "/api/v1/books/" + bookID + "/manifest"
	first := env.request(http.MethodGet, manifestURL, nil, "")
	if first.Code != http.StatusOK {
		t.Fatalf("首次 manifest status = %d，body=%s", first.Code, first.Body.String())
	}
	firstManifest := decodeLibraryData[epub.Manifest](t, first)
	if firstManifest.IndexVersion != 1 {
		t.Fatalf("首次 manifest indexVersion = %d", firstManifest.IndexVersion)
	}
	var storedVersion int64
	if err := env.db.QueryRow(`SELECT index_version FROM book_manifests WHERE book_id = ?`, bookID).
		Scan(&storedVersion); err != nil {
		t.Fatalf("读取持久化 manifest: %v", err)
	}
	if storedVersion != 1 {
		t.Fatalf("首次持久化 manifest indexVersion = %d", storedVersion)
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := env.stopWorker(stopCtx); err != nil {
		t.Fatalf("停止 worker: %v", err)
	}
	recorder := env.postReindex(bookID)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("POST reindex status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	taskID := decodeLibraryData[reindexTaskDTO](t, recorder).TaskID
	repeated := env.postReindex(bookID)
	if repeated.Code != http.StatusAccepted {
		t.Fatalf("重复 POST reindex status = %d，body=%s", repeated.Code, repeated.Body.String())
	}
	if repeatedID := decodeLibraryData[reindexTaskDTO](t, repeated).TaskID; repeatedID != taskID {
		t.Fatalf("重复 reindex taskId = %q，期望 %q", repeatedID, taskID)
	}

	env.startWorker()
	env.waitTask(taskID, store.TaskStateSucceeded)
	env.waitStatus(bookID, "ready")

	second := env.request(http.MethodGet, manifestURL, nil, "")
	if second.Code != http.StatusOK {
		t.Fatalf("重索引后 manifest status = %d，body=%s", second.Code, second.Body.String())
	}
	secondManifest := decodeLibraryData[epub.Manifest](t, second)
	if secondManifest.IndexVersion != 2 {
		t.Fatalf("重索引后 manifest indexVersion = %d，期望 2", secondManifest.IndexVersion)
	}
	var storedJSON string
	if err := env.db.QueryRow(`SELECT index_version, manifest_json FROM book_manifests WHERE book_id = ?`, bookID).
		Scan(&storedVersion, &storedJSON); err != nil {
		t.Fatalf("读取重建后的 manifest: %v", err)
	}
	if storedVersion != 2 {
		t.Fatalf("重建后持久化 manifest indexVersion = %d", storedVersion)
	}
	var persisted epub.Manifest
	if err := json.Unmarshal([]byte(storedJSON), &persisted); err != nil {
		t.Fatalf("解析持久化 manifest: %v", err)
	}
	if persisted.IndexVersion != 2 || persisted.BookID != bookID {
		t.Fatalf("持久化 manifest = indexVersion %d bookId %q", persisted.IndexVersion, persisted.BookID)
	}
}
