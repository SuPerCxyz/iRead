package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"iread/server/internal/jobs"
	"iread/server/internal/store"
)

type cacheAPIFixture struct {
	bookID      string
	fileVersion string
	original    string
	originalRaw []byte
	coversPath  string
	comicPath   string
}

func setupCacheAPIHandler(t *testing.T, env *testEnv, notifier CacheNotifier) *CacheHandlers {
	t.Helper()
	handlers, err := NewCacheHandlers(CacheOptions{
		Store:       env.store,
		Jobs:        notifier,
		CacheDir:    env.dirs[2],
		RequireAuth: env.server.RequireAuth,
		RequireCSRF: env.server.RequireCSRF,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewCacheHandlers() error = %v", err)
	}
	mux := http.NewServeMux()
	RegisterCacheRoutes(mux, handlers)
	env.handler = env.server.middleware(env.server.apiGuard(mux))
	return handlers
}

func seedCacheAPIFixture(t *testing.T, env *testEnv) cacheAPIFixture {
	t.Helper()
	raw, err := sql.Open("sqlite", taskTestDSN(env.dbPath))
	if err != nil {
		t.Fatal(err)
	}
	raw.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = raw.Close() })

	bookID := randomTaskID(t)
	original := []byte("cache-api-original-must-survive")
	digest := sha256.Sum256(original)
	fileVersion := hex.EncodeToString(digest[:])
	relative := filepath.ToSlash(filepath.Join(bookID, fileVersion+".epub"))
	originalPath := filepath.Join(env.dirs[0], filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(originalPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(originalPath, original, 0o600); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
			VALUES (?, 'Cache API', 'epub', 'ready', 1, ?, ?)`, []any{bookID, now, now}},
		{`INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, 'cache.epub', 'epub', 'application/epub+zip', ?, ?, ?, ?)`,
			[]any{bookID, fileVersion, len(original), relative, now}},
		{`INSERT INTO book_metadata (book_id, extraction_status, updated_at)
			VALUES (?, 'ok', ?)`, []any{bookID, now}},
		{`INSERT INTO reading_progress (
			book_id, file_version, format, locator_type, locator_payload,
			progress_percent, client_mutation_id, revision, updated_at
		) VALUES (?, ?, 'epub', 'epub-cfi', '{"locatorVersion":1,"spineIndex":4}',
			61.5, 'cache-api-progress', 2, ?)`, []any{bookID, fileVersion, now}},
		{`INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, revision, created_at, updated_at
		) VALUES (?, ?, ?, 'epub', 'epub-cfi', '{"locatorVersion":1,"spineIndex":4}',
			'cache-api-locator', '缓存 API 书签', 'cache-api-bookmark', 1, ?, ?)`,
			[]any{randomTaskID(t), bookID, fileVersion, now, now}},
		{`INSERT INTO book_reader_overrides (book_id, schema_version, overrides_json, revision, updated_at)
			VALUES (?, 1, '{"reflow":{"fontSize":20}}', 3, ?)`, []any{bookID, now}},
		{`INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
			VALUES ('appearance', 1, '{"theme":"dark","schemaVersion":1}', 5, ?)`, []any{now}},
	} {
		if _, err := raw.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("seed 失败: %v\n%s", err, statement.query)
		}
	}

	coversPath := filepath.Join(env.dirs[2], "covers", bookID, "1")
	comicPath := filepath.Join(env.dirs[2], "comic", bookID, fileVersion)
	for _, dir := range []string{
		coversPath,
		filepath.Join(env.dirs[2], "covers", bookID, "2"), // 空目录不产生条目
		comicPath,
		filepath.Join(env.dirs[2], "keep"),
	} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []struct {
		path string
		size int
	}{
		{filepath.Join(coversPath, "grid.jpg"), 120},
		{filepath.Join(coversPath, "detail.jpg"), 80},
		{filepath.Join(comicPath, "page-1.jpg"), 50},
		{filepath.Join(env.dirs[2], "keep", "unrelated.bin"), 9},
	} {
		if err := os.WriteFile(file.path, make([]byte, file.size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return cacheAPIFixture{
		bookID:      bookID,
		fileVersion: fileVersion,
		original:    originalPath,
		originalRaw: original,
		coversPath:  coversPath,
		comicPath:   comicPath,
	}
}

func waitCacheTask(t *testing.T, env *testEnv, taskID, state string) store.Task {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		task, err := env.store.GetTask(context.Background(), taskID)
		if err == nil && task.State == state {
			return task
		}
		time.Sleep(20 * time.Millisecond)
	}
	task, err := env.store.GetTask(context.Background(), taskID)
	t.Fatalf("任务 %s 未进入 %s: task=%+v err=%v", taskID, state, task, err)
	return store.Task{}
}

func newCacheTestManager(t *testing.T, env *testEnv) *jobs.Manager {
	t.Helper()
	manager, err := jobs.NewManager(jobs.Options{
		Store:       env.store,
		BooksDir:    env.dirs[0],
		CacheDir:    env.dirs[2],
		Workers:     1,
		Lease:       2 * time.Second,
		Poll:        20 * time.Millisecond,
		TaskTimeout: 10 * time.Second,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("jobs.NewManager() error = %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := manager.Stop(ctx); err != nil {
			t.Errorf("manager.Stop() error = %v", err)
		}
	})
	return manager
}

func TestCacheUsageRequiresAuthentication(t *testing.T) {
	env := newTestEnv(t)
	setupCacheAPIHandler(t, env, nil)

	for _, request := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/cache/usage", ""},
		{http.MethodPost, "/api/v1/cache/clear", `{"scope":"reading-derived"}`},
	} {
		recorder := env.request(request.method, request.path, request.body, "application/json")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s 未认证 status = %d body=%s",
				request.method, request.path, recorder.Code, recorder.Body.String())
		}
		payload := decodeAPIError(t, recorder)
		if payload.Error.Code != "unauthenticated" {
			t.Fatalf("未认证 code = %q", payload.Error.Code)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("未认证 Cache-Control = %q", got)
		}
		if strings.Contains(recorder.Body.String(), env.root) {
			t.Fatalf("错误响应泄露了本地路径: %s", recorder.Body.String())
		}
	}
}

func TestCacheUsageAndClearKeepOriginalsAndUserData(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	fixture := seedCacheAPIFixture(t, env)
	manager := newCacheTestManager(t, env)
	setupCacheAPIHandler(t, env, manager)

	usageRecorder := env.request(http.MethodGet, "/api/v1/cache/usage", "", "")
	if usageRecorder.Code != http.StatusOK {
		t.Fatalf("GET cache/usage = %d body=%s", usageRecorder.Code, usageRecorder.Body.String())
	}
	usage := decodeData[cacheUsageDTO](t, usageRecorder)
	if usage.DerivedBytes != 250 || usage.Entries != 3 {
		t.Fatalf("usage = %+v", usage)
	}
	if usage.ByKind.Covers.Bytes != 200 || usage.ByKind.Covers.Entries != 2 ||
		usage.ByKind.Comic.Bytes != 50 || usage.ByKind.Comic.Entries != 1 {
		t.Fatalf("usage byKind = %+v", usage.ByKind)
	}
	if usage.Task != nil {
		t.Fatalf("初始 task 应为 null: %+v", usage.Task)
	}

	first := env.request(http.MethodPost, "/api/v1/cache/clear", `{"scope":"reading-derived"}`, "application/json")
	if first.Code != http.StatusAccepted {
		t.Fatalf("POST cache/clear = %d body=%s", first.Code, first.Body.String())
	}
	firstTask := decodeData[cacheClearResponse](t, first)
	if firstTask.TaskID == "" {
		t.Fatal("cache/clear 未返回 taskId")
	}
	second := env.request(http.MethodPost, "/api/v1/cache/clear", `{"scope":"reading-derived"}`, "application/json")
	if second.Code != http.StatusAccepted {
		t.Fatalf("重复 POST cache/clear = %d body=%s", second.Code, second.Body.String())
	}
	secondTask := decodeData[cacheClearResponse](t, second)
	if secondTask.TaskID != firstTask.TaskID {
		t.Fatalf("活动任务应复用: first=%s second=%s", firstTask.TaskID, secondTask.TaskID)
	}
	if err := manager.Start(context.Background()); err != nil {
		t.Fatalf("manager.Start() error = %v", err)
	}

	finished := waitCacheTask(t, env, firstTask.TaskID, store.TaskStateSucceeded)
	if finished.Kind != store.TaskKindCacheClear || finished.BookID != nil ||
		finished.ProgressPhase != "done" {
		t.Fatalf("缓存清理任务 = %+v", finished)
	}

	afterRecorder := env.request(http.MethodGet, "/api/v1/cache/usage", "", "")
	if afterRecorder.Code != http.StatusOK {
		t.Fatalf("清理后 GET cache/usage = %d body=%s", afterRecorder.Code, afterRecorder.Body.String())
	}
	after := decodeData[cacheUsageDTO](t, afterRecorder)
	if after.DerivedBytes != 0 || after.Entries != 0 {
		t.Fatalf("清理后 usage = %+v", after)
	}
	if after.Task == nil || after.Task.TaskID != firstTask.TaskID || after.Task.State != store.TaskStateSucceeded {
		t.Fatalf("清理后 task = %+v", after.Task)
	}

	if _, err := os.Stat(fixture.original); err != nil {
		t.Fatalf("原件被删除: %v", err)
	}
	originalBytes, err := os.ReadFile(fixture.original)
	if err != nil || string(originalBytes) != string(fixture.originalRaw) {
		t.Fatalf("原件被修改: err=%v bytes=%q", err, originalBytes)
	}
	if _, err := os.Stat(filepath.Join(env.dirs[2], "keep", "unrelated.bin")); err != nil {
		t.Fatalf("非派生缓存被删除: %v", err)
	}
	if entries, err := os.ReadDir(filepath.Join(env.dirs[2], "covers")); err != nil && !os.IsNotExist(err) {
		t.Fatalf("covers 读取失败: %v", err)
	} else if len(entries) != 0 {
		t.Fatalf("covers 未清空: entries=%d", len(entries))
	}
	if entries, err := os.ReadDir(filepath.Join(env.dirs[2], "comic")); err != nil && !os.IsNotExist(err) {
		t.Fatalf("comic 读取失败: %v", err)
	} else if len(entries) != 0 {
		t.Fatalf("comic 未清空: entries=%d", len(entries))
	}

	raw, err := sql.Open("sqlite", taskTestDSN(env.dbPath))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	raw.SetMaxOpenConns(1)
	var progress, bookmarks, overrides int
	var settings string
	if err := raw.QueryRow(`SELECT COUNT(*) FROM reading_progress WHERE book_id = ?`, fixture.bookID).Scan(&progress); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRow(`SELECT COUNT(*) FROM bookmarks WHERE book_id = ?`, fixture.bookID).Scan(&bookmarks); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRow(`SELECT COUNT(*) FROM book_reader_overrides WHERE book_id = ?`, fixture.bookID).Scan(&overrides); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRow(`SELECT value FROM app_settings WHERE "group" = 'appearance'`).Scan(&settings); err != nil {
		t.Fatal(err)
	}
	if progress != 1 || bookmarks != 1 || overrides != 1 {
		t.Fatalf("清理影响用户数据: progress=%d bookmarks=%d overrides=%d", progress, bookmarks, overrides)
	}
	if settings != `{"theme":"dark","schemaVersion":1}` {
		t.Fatalf("清理修改设置: %s", settings)
	}

	third := env.request(http.MethodPost, "/api/v1/cache/clear", `{"scope":"reading-derived"}`, "application/json")
	if third.Code != http.StatusAccepted {
		t.Fatalf("终态后 POST cache/clear = %d body=%s", third.Code, third.Body.String())
	}
	thirdTask := decodeData[cacheClearResponse](t, third)
	if thirdTask.TaskID == firstTask.TaskID {
		t.Fatalf("终态后应创建新任务，仍为 %s", thirdTask.TaskID)
	}
}

type cacheNotifierStub struct {
	count atomic.Int64
}

func (n *cacheNotifierStub) Notify() { n.count.Add(1) }

func TestCacheClearValidationCSRFAndNoPathLeak(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	notifier := &cacheNotifierStub{}
	setupCacheAPIHandler(t, env, notifier)

	empty := env.request(http.MethodGet, "/api/v1/cache/usage", "", "")
	if empty.Code != http.StatusOK {
		t.Fatalf("空缓存 usage status = %d body=%s", empty.Code, empty.Body.String())
	}
	emptyUsage := decodeData[cacheUsageDTO](t, empty)
	if emptyUsage.DerivedBytes != 0 || emptyUsage.Entries != 0 || emptyUsage.Task != nil {
		t.Fatalf("空缓存 usage = %+v", emptyUsage)
	}

	noCSRF := env.do(http.MethodPost, "/api/v1/cache/clear",
		`{"scope":"reading-derived"}`, "application/json", func(request *http.Request) {
			request.Header.Del(csrfHeaderName)
		})
	if noCSRF.Code != http.StatusForbidden {
		t.Fatalf("无 CSRF status = %d body=%s", noCSRF.Code, noCSRF.Body.String())
	}
	if got := decodeAPIError(t, noCSRF).Error.Code; got != "forbidden" {
		t.Fatalf("无 CSRF code = %q", got)
	}

	invalidBodies := []struct {
		body        string
		contentType string
		status      int
		code        string
	}{
		{`{}`, "application/json", http.StatusBadRequest, "invalid_request"},
		{`{"scope":"all"}`, "application/json", http.StatusBadRequest, "invalid_request"},
		{`{"scope":"reading-derived","extra":true}`, "application/json", http.StatusBadRequest, "invalid_request"},
		{`not-json`, "application/json", http.StatusBadRequest, "invalid_request"},
		{`{"scope":"reading-derived"}`, "text/plain", http.StatusUnsupportedMediaType, "unsupported_media_type"},
	}
	for _, testCase := range invalidBodies {
		recorder := env.request(http.MethodPost, "/api/v1/cache/clear", testCase.body, testCase.contentType)
		if recorder.Code != testCase.status {
			t.Fatalf("body=%q status = %d, 期望 %d, body=%s",
				testCase.body, recorder.Code, testCase.status, recorder.Body.String())
		}
		if got := decodeAPIError(t, recorder).Error.Code; got != testCase.code {
			t.Fatalf("body=%q code = %q, 期望 %q", testCase.body, got, testCase.code)
		}
		if strings.Contains(recorder.Body.String(), env.root) || strings.Contains(recorder.Body.String(), env.dirs[2]) {
			t.Fatalf("错误响应泄露路径: %s", recorder.Body.String())
		}
	}

	getClear := env.request(http.MethodGet, "/api/v1/cache/clear", "", "")
	if getClear.Code != http.StatusMethodNotAllowed || getClear.Header().Get("Allow") != "POST" {
		t.Fatalf("GET cache/clear status=%d Allow=%q", getClear.Code, getClear.Header().Get("Allow"))
	}
	postUsage := env.request(http.MethodPost, "/api/v1/cache/usage", "", "")
	if postUsage.Code != http.StatusMethodNotAllowed || postUsage.Header().Get("Allow") != "GET" {
		t.Fatalf("POST cache/usage status=%d Allow=%q", postUsage.Code, postUsage.Header().Get("Allow"))
	}

	valid := env.request(http.MethodPost, "/api/v1/cache/clear", `{"scope":"reading-derived"}`, "application/json")
	if valid.Code != http.StatusAccepted {
		t.Fatalf("合法清理 status = %d body=%s", valid.Code, valid.Body.String())
	}
	task := decodeData[cacheClearResponse](t, valid)
	if task.TaskID == "" {
		t.Fatal("合法清理未返回 taskId")
	}
	if notifier.count.Load() != 1 {
		t.Fatalf("清理请求未唤醒 worker: notify=%d", notifier.count.Load())
	}
	if strings.Contains(valid.Body.String(), env.root) {
		t.Fatalf("成功响应泄露路径: %s", valid.Body.String())
	}
}
