package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"iread/server/internal/jobs"
	"iread/server/internal/library"
)

// newIntegratedTestEnv 构造真实 Server + 真实 library 路由（假格式校验器）+
// 未启动的 jobs.Manager，用于验证 server.go 接线本身。
func newIntegratedTestEnv(t *testing.T) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	service, err := library.NewService(library.Config{
		Store:     env.store,
		BooksDir:  filepath.Join(env.root, "books"),
		CacheDir:  filepath.Join(env.root, "cache"),
		Validator: readableTestValidator(),
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("library.NewService() error = %v", err)
	}
	manager, err := jobs.NewManager(jobs.Options{
		Store:    env.store,
		BooksDir: filepath.Join(env.root, "books"),
		CacheDir: filepath.Join(env.root, "cache"),
		Workers:  1,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("jobs.NewManager() error = %v", err)
	}
	server, err := New(Options{
		Store:        env.store,
		WebDir:       env.webDir,
		Version:      testVersion,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		StorageDirs:  env.dirs,
		PublicOrigin: env.publicOrigin,
		BooksDir:     filepath.Join(env.root, "books"),
		CacheDir:     filepath.Join(env.root, "cache"),
		Library:      service,
		Jobs:         manager,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	env.server = server
	env.handler = server.Handler()
	env.setupAdmin(t, testAdminPassword)
	return env
}

func TestServerRegistersLibraryAndTaskRoutes(t *testing.T) {
	env := newIntegratedTestEnv(t)

	books := env.request(http.MethodGet, "/api/v1/books", "", "")
	if books.Code != http.StatusOK {
		t.Fatalf("GET books status = %d, body=%s", books.Code, books.Body.String())
	}
	var list struct {
		Data []bookDTO `json:"data"`
		Meta struct {
			NextCursor *string `json:"nextCursor"`
			Total      *int64  `json:"total"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(books.Body.Bytes(), &list); err != nil {
		t.Fatalf("解析 books 失败: %v", err)
	}
	if list.Meta.Total == nil || *list.Meta.Total != 0 || len(list.Data) != 0 {
		t.Fatalf("空书库响应 = %+v", list)
	}

	// 上传意图 + 原始字节上传，验证 LibraryHandlers 已真实接线。
	createBody := []byte(`{"clientUploadId":"integration-1","fileName":"book.epub","byteSize":16}`)
	create := env.request(http.MethodPost, "/api/v1/uploads", string(createBody), "application/json")
	if create.Code != http.StatusCreated {
		t.Fatalf("POST uploads status = %d, body=%s", create.Code, create.Body.String())
	}
	intent := decodeData[uploadDTO](t, create)
	if intent.State != library.StateAwaiting {
		t.Fatalf("上传意图 = %+v", intent)
	}

	storedRecorder := env.request(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content",
		"0123456789abcdef", "application/octet-stream")
	if storedRecorder.Code != http.StatusOK {
		t.Fatalf("PUT content status = %d, body=%s", storedRecorder.Code, storedRecorder.Body.String())
	}
	stored := decodeData[uploadDTO](t, storedRecorder)
	if stored.State != library.StateStored || stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果 = %+v", stored)
	}

	taskRecorder := env.request(http.MethodGet, "/api/v1/tasks/"+*stored.TaskID, "", "")
	if taskRecorder.Code != http.StatusOK {
		t.Fatalf("GET task status = %d, body=%s", taskRecorder.Code, taskRecorder.Body.String())
	}
	task := decodeData[taskDTO](t, taskRecorder)
	if task.TaskID != *stored.TaskID || task.State != "queued" || task.Progress.Phase != "queued" {
		t.Fatalf("任务 DTO = %+v", task)
	}

	detailRecorder := env.request(http.MethodGet, "/api/v1/books/"+*stored.BookID, "", "")
	if detailRecorder.Code != http.StatusOK {
		t.Fatalf("GET book status = %d, body=%s", detailRecorder.Code, detailRecorder.Body.String())
	}
	detail := decodeData[bookDetailDTO](t, detailRecorder)
	if detail.Status != "indexing" || detail.IndexTaskID == nil || *detail.IndexTaskID != *stored.TaskID {
		t.Fatalf("书籍详情 = %+v", detail)
	}

	// 写操作仍由 apiGuard 统一要求 CSRF；handler 内 RequireCSRF 不重复消费 body。
	noCSRF := env.do(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content",
		"0123456789abcdef", "application/octet-stream", func(request *http.Request) {
			request.Header.Del(csrfHeaderName)
		})
	if noCSRF.Code != http.StatusForbidden {
		t.Fatalf("无 CSRF status = %d, body=%s", noCSRF.Code, noCSRF.Body.String())
	}
	if details := errorDetails(t, noCSRF.Body.Bytes()); details["reason"] != csrfReasonInvalid {
		t.Fatalf("CSRF details = %v", details)
	}

	unknownTask := env.request(http.MethodGet, "/api/v1/tasks/"+strings.Repeat("0", 32), "", "")
	if unknownTask.Code != http.StatusNotFound {
		t.Fatalf("未知 task status = %d, body=%s", unknownTask.Code, unknownTask.Body.String())
	}

	// manifest 已由阅读器 handler 接管；假校验器保存的不是真实 EPUB，
	// 因此返回 JSON book_not_readable，而不是落回 SPA 或旧书库 404。
	manifest := env.request(http.MethodGet, "/api/v1/books/"+*stored.BookID+"/manifest", "", "")
	if manifest.Code != http.StatusConflict {
		t.Fatalf("manifest status = %d, body=%s", manifest.Code, manifest.Body.String())
	}
	if got := manifest.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("manifest Content-Type = %q", got)
	}
	if decodeAPIError(t, manifest).Error.Code != "book_not_readable" {
		t.Fatalf("manifest code = %q", decodeAPIError(t, manifest).Error.Code)
	}

	// 未认证请求仍由 apiGuard 返回统一 401；放在最后避免清理测试会话 Cookie
	// 影响前面的认证请求。
	unauth := env.do(http.MethodGet, "/api/v1/books", "", "", func(request *http.Request) {
		request.Header.Del("Cookie")
	})
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 books status = %d, body=%s", unauth.Code, unauth.Body.String())
	}
	if decodeAPIError(t, unauth).Error.Code != "unauthenticated" {
		t.Fatalf("未认证 code = %q", decodeAPIError(t, unauth).Error.Code)
	}
}
