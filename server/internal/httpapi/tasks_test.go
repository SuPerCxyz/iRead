package httpapi

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"iread/server/internal/store"
)

type taskAPIEnv struct {
	t      *testing.T
	env    *testEnv
	db     *sql.DB
	mux    *http.ServeMux
	notify atomic.Int64
}

func newTaskAPIEnv(t *testing.T) *taskAPIEnv {
	t.Helper()
	env := newTestEnv(t)
	raw, err := sql.Open("sqlite", taskTestDSN(env.dbPath))
	if err != nil {
		t.Fatal(err)
	}
	raw.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = raw.Close() })
	api := &taskAPIEnv{t: t, env: env, db: raw}
	handlers := &TaskHandlers{
		Store:       env.store,
		RequireAuth: taskTestAuth,
		RequireCSRF: taskTestCSRF,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		Notify:      func() { api.notify.Add(1) },
	}
	api.mux = http.NewServeMux()
	handlers.RegisterTaskRoutes(api.mux)
	return api
}

func taskTestDSN(path string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "foreign_keys(1)")
	u.RawQuery = query.Encode()
	return u.String()
}

func taskTestAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Auth") != "ok" {
			writeJSON(w, http.StatusUnauthorized, errorEnvelope{Error: errorPayload{
				Code: "unauthenticated", Message: "需要登录", RequestID: requestIDFromRequest(r),
				Details: struct{}{},
			}})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func taskTestCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-CSRF-Token") != "token" {
			writeJSON(w, http.StatusForbidden, errorEnvelope{Error: errorPayload{
				Code: "forbidden", Message: "CSRF 校验失败", RequestID: requestIDFromRequest(r),
				Details: map[string]any{"reason": "csrf_invalid"},
			}})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func randomTaskID(t *testing.T) string {
	t.Helper()
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(raw[:])
}

func (e *taskAPIEnv) insertBook(status string) string {
	e.t.Helper()
	bookID := randomTaskID(e.t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := e.db.Exec(`
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, 'Task Book', 'epub', ?, 0, ?, ?)`, bookID, status, now, now); err != nil {
		e.t.Fatal(err)
	}
	return bookID
}

func (e *taskAPIEnv) insertTask(bookID, state string, revision, attempt int64, errorCode string, retryable bool) string {
	e.t.Helper()
	taskID := randomTaskID(e.t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	retryFlag := 0
	if retryable {
		retryFlag = 1
	}
	var errorValue any
	if errorCode != "" {
		errorValue = errorCode
	}
	var startedAt, finishedAt any
	if state == "running" {
		startedAt = now
	}
	if state == "failed" || state == "cancelled" || state == "succeeded" {
		finishedAt = now
	}
	if _, err := e.db.Exec(`
		INSERT INTO background_tasks (
			id, kind, book_id, state, attempt, revision, progress_phase,
			progress_completed, progress_total, error_code, error_message,
			error_retryable, cancellation_requested, created_at, updated_at,
			started_at, finished_at, lease_until
		) VALUES (?, 'book.index', ?, ?, ?, ?, 'queued', 0, NULL, ?, ?, ?, 0, ?, ?, ?, ?, NULL)`,
		taskID, bookID, state, attempt, revision, errorValue,
		errorMessageFor(errorCode), retryFlag, now, now, startedAt, finishedAt); err != nil {
		e.t.Fatal(err)
	}
	return taskID
}

func errorMessageFor(code string) any {
	if code == "" {
		return nil
	}
	return "索引任务失败"
}

func (e *taskAPIEnv) request(method, target, body string, auth, csrf bool) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if auth {
		request.Header.Set("X-Test-Auth", "ok")
	}
	if csrf {
		request.Header.Set("X-CSRF-Token", "token")
	}
	recorder := httptest.NewRecorder()
	e.mux.ServeHTTP(recorder, request)
	return recorder
}

func TestTaskGetRequiresAuthAndReturnsDTO(t *testing.T) {
	api := newTaskAPIEnv(t)
	bookID := api.insertBook("indexing")
	taskID := api.insertTask(bookID, "queued", 1, 1, "", false)

	unauthorized := api.request(http.MethodGet, "/api/v1/tasks/"+taskID, "", false, false)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 status = %d", unauthorized.Code)
	}
	if got := decodeAPIError(t, unauthorized).Error.Code; got != "unauthenticated" {
		t.Fatalf("未认证 code = %q", got)
	}

	unknown := api.request(http.MethodGet, "/api/v1/tasks/"+strings.Repeat("0", 32), "", true, false)
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("未知任务 status = %d", unknown.Code)
	}

	recorder := api.request(http.MethodGet, "/api/v1/tasks/"+taskID, "", true, false)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	dto := decodeData[taskDTO](t, recorder)
	if dto.SchemaVersion != 1 || dto.TaskID != taskID || dto.State != "queued" ||
		dto.Revision != "1" || dto.Attempt != 1 || dto.BookID == nil || *dto.BookID != bookID {
		t.Fatalf("TaskDTO = %+v", dto)
	}
	if dto.Progress.Phase != "queued" || dto.Progress.CompletedUnits != 0 || dto.Progress.TotalUnits != nil {
		t.Fatalf("progress = %+v", dto.Progress)
	}
	if dto.Error != nil || dto.CancellationRequested || dto.CreatedAt == "" || dto.UpdatedAt == "" {
		t.Fatalf("TaskDTO error/time = %+v", dto)
	}

	method := api.request(http.MethodPost, "/api/v1/tasks/"+taskID, "", true, true)
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST task item status = %d", method.Code)
	}
	if got := method.Header().Get("Allow"); got != "GET" {
		t.Fatalf("Allow = %q", got)
	}
}

func TestTaskRetryRevisionAndStaleConflict(t *testing.T) {
	api := newTaskAPIEnv(t)
	bookID := api.insertBook("error")
	taskID := api.insertTask(bookID, "failed", 2, 1, "invalid_file", true)

	recorder := api.request(http.MethodPost, "/api/v1/tasks/"+taskID+"/retry", `{"baseRevision":"2"}`, true, true)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("retry status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	dto := decodeData[taskDTO](t, recorder)
	if dto.State != "queued" || dto.Attempt != 2 || dto.Revision != "3" || dto.Error != nil {
		t.Fatalf("retry DTO = %+v", dto)
	}
	if api.notify.Load() == 0 {
		t.Fatal("retry 后应唤醒 worker")
	}

	stale := api.request(http.MethodPost, "/api/v1/tasks/"+taskID+"/retry", `{"baseRevision":"2"}`, true, true)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale status = %d body=%s", stale.Code, stale.Body.String())
	}
	errorBody := decodeAPIError(t, stale)
	if errorBody.Error.Code != "revision_conflict" {
		t.Fatalf("stale code = %q", errorBody.Error.Code)
	}
	var details struct {
		Current taskDTO `json:"current"`
	}
	if err := json.Unmarshal(errorBody.Error.Details, &details); err != nil {
		t.Fatal(err)
	}
	if details.Current.Revision != "3" {
		t.Fatalf("stale current revision = %q", details.Current.Revision)
	}

	state := api.request(http.MethodPost, "/api/v1/tasks/"+taskID+"/retry", `{"baseRevision":"3"}`, true, true)
	if state.Code != http.StatusConflict {
		t.Fatalf("queued retry status = %d", state.Code)
	}
	if got := decodeAPIError(t, state).Error.Code; got != "state_conflict" {
		t.Fatalf("queued retry code = %q", got)
	}

	csrf := api.request(http.MethodPost, "/api/v1/tasks/"+taskID+"/retry", `{"baseRevision":"3"}`, true, false)
	if csrf.Code != http.StatusForbidden {
		t.Fatalf("缺少 CSRF status = %d", csrf.Code)
	}

	number := api.request(http.MethodPost, "/api/v1/tasks/"+taskID+"/retry", `{"baseRevision":3}`, true, true)
	if number.Code != http.StatusBadRequest {
		t.Fatalf("数字 baseRevision status = %d body=%s", number.Code, number.Body.String())
	}
}

func TestTaskRetryCacheClearWithoutBook(t *testing.T) {
	api := newTaskAPIEnv(t)
	taskID := randomTaskID(t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := api.db.Exec(`
		INSERT INTO background_tasks (
			id, kind, book_id, state, attempt, revision, progress_phase,
			error_code, error_message, error_retryable, cancellation_requested,
			created_at, updated_at, finished_at
		) VALUES (?, 'cache.clear', NULL, 'failed', 1, 3, 'clear',
			'cache_clear_failed', '部分缓存未能清理', 1, 0, ?, ?, ?)`,
		taskID, now, now, now); err != nil {
		t.Fatal(err)
	}

	recorder := api.request(http.MethodPost, "/api/v1/tasks/"+taskID+"/retry", `{"baseRevision":"3"}`, true, true)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("cache.clear retry status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	dto := decodeData[taskDTO](t, recorder)
	if dto.Kind != store.TaskKindCacheClear || dto.BookID != nil || dto.State != "queued" ||
		dto.Attempt != 2 || dto.Revision != "4" || dto.Error != nil {
		t.Fatalf("cache.clear retry DTO = %+v", dto)
	}
	if api.notify.Load() == 0 {
		t.Fatal("cache.clear retry 后应唤醒 worker")
	}
	var books int
	if err := api.db.QueryRow(`SELECT COUNT(*) FROM books`).Scan(&books); err != nil {
		t.Fatal(err)
	}
	if books != 0 {
		t.Fatalf("cache.clear retry 不应创建书籍: books=%d", books)
	}
}

func TestTaskRetryRejectsNonRetryableFailure(t *testing.T) {
	api := newTaskAPIEnv(t)
	bookID := api.insertBook("error")
	taskID := api.insertTask(bookID, "failed", 2, 1, "invalid_file", false)
	recorder := api.request(http.MethodPost, "/api/v1/tasks/"+taskID+"/retry", `{"baseRevision":"2"}`, true, true)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := decodeAPIError(t, recorder).Error.Code; got != "state_conflict" {
		t.Fatalf("code = %q", got)
	}
}

func TestTaskCancelQueuedRunningAndTerminal(t *testing.T) {
	api := newTaskAPIEnv(t)

	queuedBook := api.insertBook("indexing")
	queuedTask := api.insertTask(queuedBook, "queued", 1, 1, "", false)
	cancelled := api.request(http.MethodPost, "/api/v1/tasks/"+queuedTask+"/cancel", `{"baseRevision":"1"}`, true, true)
	if cancelled.Code != http.StatusAccepted {
		t.Fatalf("queued cancel status = %d body=%s", cancelled.Code, cancelled.Body.String())
	}
	dto := decodeData[taskDTO](t, cancelled)
	if dto.State != "cancelled" || dto.Revision != "2" || !dto.CancellationRequested ||
		dto.Error == nil || dto.Error.Code != "index_cancelled" || !dto.Error.Retryable {
		t.Fatalf("queued cancel DTO = %+v", dto)
	}
	var status string
	if err := api.db.QueryRow(`SELECT status FROM books WHERE id = ?`, queuedBook).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "error" {
		t.Fatalf("取消后书籍状态 = %s", status)
	}
	repeated := api.request(http.MethodPost, "/api/v1/tasks/"+queuedTask+"/cancel", `{"baseRevision":"2"}`, true, true)
	if repeated.Code != http.StatusOK {
		t.Fatalf("重复取消 status = %d", repeated.Code)
	}
	stale := api.request(http.MethodPost, "/api/v1/tasks/"+queuedTask+"/cancel", `{"baseRevision":"1"}`, true, true)
	if stale.Code != http.StatusConflict || decodeAPIError(t, stale).Error.Code != "revision_conflict" {
		t.Fatalf("stale cancel status/code = %d/%s", stale.Code, decodeAPIError(t, stale).Error.Code)
	}

	runningBook := api.insertBook("indexing")
	runningTask := api.insertTask(runningBook, "running", 2, 1, "", false)
	running := api.request(http.MethodPost, "/api/v1/tasks/"+runningTask+"/cancel", `{"baseRevision":"2"}`, true, true)
	if running.Code != http.StatusAccepted {
		t.Fatalf("running cancel status = %d body=%s", running.Code, running.Body.String())
	}
	runningDTO := decodeData[taskDTO](t, running)
	if runningDTO.State != "running" || !runningDTO.CancellationRequested || runningDTO.Revision != "3" {
		t.Fatalf("running cancel DTO = %+v", runningDTO)
	}

	succeededBook := api.insertBook("ready")
	succeededTask := api.insertTask(succeededBook, "succeeded", 5, 1, "", false)
	terminal := api.request(http.MethodPost, "/api/v1/tasks/"+succeededTask+"/cancel", `{"baseRevision":"5"}`, true, true)
	if terminal.Code != http.StatusConflict {
		t.Fatalf("terminal cancel status = %d body=%s", terminal.Code, terminal.Body.String())
	}
	if got := decodeAPIError(t, terminal).Error.Code; got != "state_conflict" {
		t.Fatalf("terminal cancel code = %q", got)
	}
}

func TestTaskRoutesRejectWrongContentTypeAndMethod(t *testing.T) {
	api := newTaskAPIEnv(t)
	bookID := api.insertBook("indexing")
	taskID := api.insertTask(bookID, "queued", 1, 1, "", false)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/tasks/"+taskID+"/cancel", strings.NewReader(`{"baseRevision":"1"}`))
	request.Header.Set("X-Test-Auth", "ok")
	request.Header.Set("X-CSRF-Token", "token")
	request.Header.Set("Content-Type", "text/plain")
	recorder := httptest.NewRecorder()
	api.mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("content-type status = %d", recorder.Code)
	}

	method := api.request(http.MethodGet, "/api/v1/tasks/"+taskID+"/retry", "", true, false)
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("retry GET status = %d", method.Code)
	}
	if got := method.Header().Get("Allow"); got != "POST" {
		t.Fatalf("Allow = %q", got)
	}
}

func TestTaskInternalErrorDoesNotLeakPathsOrSQL(t *testing.T) {
	api := newTaskAPIEnv(t)
	bookID := api.insertBook("indexing")
	taskID := api.insertTask(bookID, "queued", 1, 1, "", false)
	if err := api.env.store.Close(); err != nil {
		t.Fatal(err)
	}
	recorder := api.request(http.MethodGet, "/api/v1/tasks/"+taskID, "", true, false)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	body := strings.ToLower(recorder.Body.String())
	if strings.Contains(body, strings.ToLower(api.env.root)) || strings.Contains(body, "sql") ||
		strings.Contains(body, "database is closed") {
		t.Fatalf("错误体泄露内部信息: %s", recorder.Body.String())
	}
	if got := decodeAPIError(t, recorder).Error.Code; got != "internal_error" {
		t.Fatalf("code = %q", got)
	}
}
