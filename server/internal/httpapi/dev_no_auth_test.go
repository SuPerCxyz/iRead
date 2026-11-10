package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"iread/server/internal/auth"
	"iread/server/internal/jobs"
	"iread/server/internal/library"
)

// newDevNoAuthTestEnv 构造显式开启开发免认证的最小 Server。
func newDevNoAuthTestEnv(t *testing.T) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	env.devNoAuth = true
	env.handler = env.newHandler()
	return env
}

// newIntegratedDevNoAuthTestEnv 额外接入书库/任务路由，用于验证上传与阅读 API。
func newIntegratedDevNoAuthTestEnv(t *testing.T) *testEnv {
	t.Helper()
	env := newDevNoAuthTestEnv(t)
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
		DevNoAuth:    true,
		Library:      service,
		Jobs:         manager,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	env.server = server
	env.handler = server.Handler()
	return env
}

func TestDevNoAuthStatus(t *testing.T) {
	env := newDevNoAuthTestEnv(t)
	recorder := env.request(http.MethodGet, authStatusPath, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	status := decodeData[authStatusResponse](t, recorder)
	if !status.Initialized || !status.Authenticated || !status.DevNoAuth {
		t.Fatalf("dev status = %+v", status)
	}
	if status.CSRFToken != devNoAuthCSRFToken {
		t.Fatalf("csrfToken = %q, 期望 %q", status.CSRFToken, devNoAuthCSRFToken)
	}
	if status.SetupTokenRequired {
		t.Fatal("dev 模式不应要求 setup token")
	}
	if !strings.Contains(recorder.Body.String(), `"devNoAuth":true`) {
		t.Fatalf("响应缺少 devNoAuth=true: %s", recorder.Body.String())
	}
	expiresAt, err := time.Parse(time.RFC3339, status.CSRFExpiresAt)
	if err != nil {
		t.Fatalf("csrfExpiresAt = %q: %v", status.CSRFExpiresAt, err)
	}
	if !expiresAt.After(time.Date(2050, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("csrfExpiresAt 不是远未来: %s", status.CSRFExpiresAt)
	}

	for _, name := range []string{sessionCookieName, preAuthCookieName} {
		if cookie := responseCookie(recorder, name); cookie != nil && cookie.Value != "" {
			t.Fatalf("dev status 不应签发 %s Cookie", name)
		}
	}
	exists, err := env.store.AdminExists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("dev status 不应创建管理员")
	}
	if _, found, err := env.store.GetAuthContext(context.Background(), auth.HashToken(status.CSRFToken)); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("dev csrfToken 不应写入 auth_contexts")
	}
}

func TestDevNoAuthAuthEndpoints(t *testing.T) {
	env := newDevNoAuthTestEnv(t)

	setup := env.request(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json")
	if setup.Code != http.StatusConflict {
		t.Fatalf("setup status = %d, body=%s", setup.Code, setup.Body.String())
	}
	if code := decodeAPIError(t, setup).Error.Code; code != "already_initialized" {
		t.Fatalf("setup code = %q", code)
	}

	login := env.request(http.MethodPost, authLoginPath, authPasswordBody(testAdminPassword), "application/json")
	if login.Code != http.StatusOK {
		t.Fatalf("login status = %d, body=%s", login.Code, login.Body.String())
	}
	status := decodeData[authStatusResponse](t, login)
	if !status.DevNoAuth || !status.Authenticated || status.CSRFToken != devNoAuthCSRFToken {
		t.Fatalf("dev login 响应 = %+v", status)
	}
	for _, name := range []string{sessionCookieName, preAuthCookieName} {
		if cookie := responseCookie(login, name); cookie != nil && cookie.Value != "" {
			t.Fatalf("dev login 不应签发 %s Cookie", name)
		}
	}

	logout := env.request(http.MethodPost, authLogoutPath, "", "")
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, body=%s", logout.Code, logout.Body.String())
	}

	exists, err := env.store.AdminExists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("dev setup/login 不应创建管理员")
	}
}

func TestDevNoAuthAllowsAPIWithoutCookieOrCSRF(t *testing.T) {
	env := newIntegratedDevNoAuthTestEnv(t)
	noAuth := func(request *http.Request) {
		request.Header.Del("Cookie")
		request.Header.Del(csrfHeaderName)
		request.Header.Del("Origin")
		request.Header.Del("Referer")
	}

	get := env.do(http.MethodGet, "/api/v1/settings/appearance", "", "", noAuth)
	if get.Code != http.StatusOK {
		t.Fatalf("GET appearance status = %d, body=%s", get.Code, get.Body.String())
	}
	record := decodeData[struct {
		Revision string `json:"revision"`
	}](t, get)
	put := env.do(http.MethodPut, "/api/v1/settings/appearance",
		validPutBody(record.Revision, "blue"), "application/json", noAuth)
	if put.Code != http.StatusOK {
		t.Fatalf("PUT appearance 无 Cookie/CSRF/Origin status = %d, body=%s", put.Code, put.Body.String())
	}

	books := env.do(http.MethodGet, "/api/v1/books", "", "", noAuth)
	if books.Code != http.StatusOK {
		t.Fatalf("GET books status = %d, body=%s", books.Code, books.Body.String())
	}

	create := env.do(http.MethodPost, "/api/v1/uploads",
		`{"clientUploadId":"dev-no-auth-1","fileName":"book.epub","byteSize":16}`,
		"application/json", noAuth)
	if create.Code != http.StatusCreated {
		t.Fatalf("POST uploads status = %d, body=%s", create.Code, create.Body.String())
	}
	intent := decodeData[uploadDTO](t, create)

	content := env.do(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content",
		"0123456789abcdef", "application/octet-stream", noAuth)
	if content.Code != http.StatusOK {
		t.Fatalf("PUT upload content status = %d, body=%s", content.Code, content.Body.String())
	}
	stored := decodeData[uploadDTO](t, content)
	if stored.BookID == nil {
		t.Fatalf("上传结果缺少 bookId: %+v", stored)
	}

	progress := env.do(http.MethodGet, "/api/v1/books/"+*stored.BookID+"/progress", "", "", noAuth)
	if progress.Code != http.StatusOK {
		t.Fatalf("GET progress status = %d, body=%s", progress.Code, progress.Body.String())
	}
	readerSettings := env.do(http.MethodGet, "/api/v1/settings/reader", "", "", noAuth)
	if readerSettings.Code != http.StatusOK {
		t.Fatalf("GET reader settings status = %d, body=%s", readerSettings.Code, readerSettings.Body.String())
	}
}

func TestDevNoAuthDisabledByDefault(t *testing.T) {
	env := newTestEnv(t)
	if status := env.fetchStatus(); status.DevNoAuth {
		t.Fatal("默认环境不应返回 devNoAuth=true")
	}
	unauth := env.request(http.MethodGet, "/api/v1/books", "", "")
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("默认 GET books 无会话 status = %d, body=%s", unauth.Code, unauth.Body.String())
	}
	if code := decodeAPIError(t, unauth).Error.Code; code != "unauthenticated" {
		t.Fatalf("默认 GET books code = %q", code)
	}

	authEnv := newAuthenticatedTestEnv(t)
	noCSRF := authEnv.do(http.MethodPut, "/api/v1/settings/appearance",
		validPutBody("1", "default"), "application/json", func(request *http.Request) {
			request.Header.Del(csrfHeaderName)
		})
	if noCSRF.Code != http.StatusForbidden {
		t.Fatalf("默认环境无 CSRF PUT status = %d, body=%s", noCSRF.Code, noCSRF.Body.String())
	}
	if details := errorDetails(t, noCSRF.Body.Bytes()); details["reason"] != csrfReasonInvalid {
		t.Fatalf("默认环境无 CSRF details = %v", details)
	}
}
