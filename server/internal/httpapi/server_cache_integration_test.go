package httpapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"iread/server/internal/store"
)

// TestServerRegistersCacheRoutes 验证 CacheHandlers 由真实 Server 接线：
// 认证、CSRF、202/taskId、活动任务复用，以及不与书库路由冲突。
func TestServerRegistersCacheRoutes(t *testing.T) {
	env := newIntegratedTestEnv(t)
	cacheDir := filepath.Join(env.root, "cache")

	for _, file := range []struct {
		path string
		size int
	}{
		{filepath.Join(cacheDir, "covers", "book-integration", "1", "grid.jpg"), 20},
		{filepath.Join(cacheDir, "covers", "book-integration", "1", "detail.jpg"), 12},
		{filepath.Join(cacheDir, "comic", "book-integration", "v1", "page-1.jpg"), 5},
		{filepath.Join(cacheDir, "keep", "unrelated.bin"), 7},
	} {
		if err := os.MkdirAll(filepath.Dir(file.path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file.path, make([]byte, file.size), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	usageRecorder := env.request(http.MethodGet, "/api/v1/cache/usage", "", "")
	if usageRecorder.Code != http.StatusOK {
		t.Fatalf("GET cache/usage = %d body=%s", usageRecorder.Code, usageRecorder.Body.String())
	}
	usage := decodeData[cacheUsageDTO](t, usageRecorder)
	if usage.DerivedBytes != 37 || usage.Entries != 3 {
		t.Fatalf("cache/usage = %+v", usage)
	}
	if usage.ByKind.Covers.Bytes != 32 || usage.ByKind.Covers.Entries != 2 ||
		usage.ByKind.Comic.Bytes != 5 || usage.ByKind.Comic.Entries != 1 {
		t.Fatalf("cache/usage byKind = %+v", usage.ByKind)
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
	task, err := env.store.GetTask(context.Background(), firstTask.TaskID)
	if err != nil {
		t.Fatalf("读取任务 %s 失败: %v", firstTask.TaskID, err)
	}
	if task.Kind != store.TaskKindCacheClear || task.State != store.TaskStateQueued {
		t.Fatalf("缓存清理任务 = %+v", task)
	}

	second := env.request(http.MethodPost, "/api/v1/cache/clear", `{"scope":"reading-derived"}`, "application/json")
	if second.Code != http.StatusAccepted {
		t.Fatalf("重复 POST cache/clear = %d body=%s", second.Code, second.Body.String())
	}
	secondTask := decodeData[cacheClearResponse](t, second)
	if secondTask.TaskID != firstTask.TaskID {
		t.Fatalf("活动任务应复用: first=%s second=%s", firstTask.TaskID, secondTask.TaskID)
	}

	afterRecorder := env.request(http.MethodGet, "/api/v1/cache/usage", "", "")
	if afterRecorder.Code != http.StatusOK {
		t.Fatalf("清理后 GET cache/usage = %d body=%s", afterRecorder.Code, afterRecorder.Body.String())
	}
	after := decodeData[cacheUsageDTO](t, afterRecorder)
	if after.Task == nil || after.Task.TaskID != firstTask.TaskID || after.Task.Kind != store.TaskKindCacheClear {
		t.Fatalf("cache/usage task = %+v", after.Task)
	}

	// cache 路由位于独立子树，不应遮蔽 /api/v1/books/。
	books := env.request(http.MethodGet, "/api/v1/books", "", "")
	if books.Code != http.StatusOK {
		t.Fatalf("GET books = %d body=%s", books.Code, books.Body.String())
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

	// 未认证请求放在最后：apiGuard 会清理会话 Cookie，避免影响上述认证用例。
	for _, request := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/cache/usage", ""},
		{http.MethodPost, "/api/v1/cache/clear", `{"scope":"reading-derived"}`},
	} {
		unauth := env.do(request.method, request.path, request.body, "application/json",
			func(httpRequest *http.Request) {
				httpRequest.Header.Del("Cookie")
			})
		if unauth.Code != http.StatusUnauthorized {
			t.Fatalf("未认证 %s %s status = %d body=%s",
				request.method, request.path, unauth.Code, unauth.Body.String())
		}
		if got := decodeAPIError(t, unauth).Error.Code; got != "unauthenticated" {
			t.Fatalf("未认证 %s code = %q", request.path, got)
		}
	}
}
