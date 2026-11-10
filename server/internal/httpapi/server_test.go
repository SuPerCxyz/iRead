package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"iread/server/internal/settings"
	"iread/server/internal/store"
)

const (
	testVersion       = "test-version"
	testAdminPassword = "correct horse battery staple"
)

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(data)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type testEnv struct {
	t       *testing.T
	handler http.Handler
	server  *Server
	store   *store.Store
	root    string
	dbPath  string
	webDir  string
	dirs    []string

	publicOrigin  string
	setupToken    string
	devNoAuth     bool
	authMu        sync.Mutex
	sessionCookie *http.Cookie
	preAuthCookie *http.Cookie
	csrfToken     string
	logBuffer     lockedBuffer
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	dbDir := filepath.Join(root, "db")
	cacheDir := filepath.Join(root, "cache")
	webDir := filepath.Join(root, "web")
	for _, dir := range []string{booksDir, dbDir, cacheDir, webDir} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	writeWebFixture(t, webDir)

	dbPath := filepath.Join(dbDir, "iread.db")
	database, err := store.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}

	env := &testEnv{
		t:            t,
		root:         root,
		dbPath:       dbPath,
		webDir:       webDir,
		dirs:         []string{booksDir, dbDir, cacheDir},
		publicOrigin: defaultPublicOrigin,
	}
	env.store = database
	env.handler = env.newHandler()
	t.Cleanup(func() { _ = env.store.Close() })
	return env
}

func newAuthenticatedTestEnv(t *testing.T) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	env.setupAdmin(t, testAdminPassword)
	return env
}

// newSetupTokenTestEnv 构造启用了 IREAD_SETUP_TOKEN 的 Server。
func newSetupTokenTestEnv(t *testing.T, token string) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	env.setupToken = token
	env.handler = env.newHandler()
	return env
}

func (e *testEnv) newHandler() http.Handler {
	e.t.Helper()
	server, err := New(Options{
		Store:        e.store,
		WebDir:       e.webDir,
		Version:      testVersion,
		Logger:       slog.New(slog.NewTextHandler(&e.logBuffer, nil)),
		StorageDirs:  e.dirs,
		PublicOrigin: e.publicOrigin,
		BooksDir:     e.dirs[0],
		CacheDir:     e.dirs[2],
		SetupToken:   e.setupToken,
		DevNoAuth:    e.devNoAuth,
	})
	if err != nil {
		e.t.Fatalf("New() error = %v", err)
	}
	e.server = server
	return server.Handler()
}

func (e *testEnv) reopen() {
	e.t.Helper()
	if err := e.store.Close(); err != nil {
		e.t.Fatal(err)
	}
	database, err := store.Open(context.Background(), e.dbPath)
	if err != nil {
		e.t.Fatalf("重开数据库: %v", err)
	}
	e.store = database
	e.handler = e.newHandler()
}

func (e *testEnv) request(method, target, body, contentType string) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.do(method, target, body, contentType, nil)
}

// do 默认携带当前测试会话/预认证 Cookie、同源 Origin 与 CSRF；mutate 可覆盖异常场景。
func (e *testEnv) do(method, target, body, contentType string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	request.RemoteAddr = "127.0.0.1:54321"
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if isStateChangingMethod(method) {
		request.Header.Set("Origin", e.publicOrigin)
	}

	e.authMu.Lock()
	sessionCookie := e.sessionCookie
	preAuthCookie := e.preAuthCookie
	csrfToken := e.csrfToken
	e.authMu.Unlock()
	if sessionCookie != nil {
		request.AddCookie(sessionCookie)
	} else if preAuthCookie != nil {
		request.AddCookie(preAuthCookie)
	}
	if isStateChangingMethod(method) && csrfToken != "" {
		request.Header.Set(csrfHeaderName, csrfToken)
	}
	if mutate != nil {
		mutate(request)
	}

	recorder := httptest.NewRecorder()
	e.handler.ServeHTTP(recorder, request)
	e.captureCookies(recorder)
	return recorder
}

func (e *testEnv) captureCookies(recorder *httptest.ResponseRecorder) {
	e.authMu.Lock()
	defer e.authMu.Unlock()
	for _, cookie := range recorder.Result().Cookies() {
		stored := *cookie
		switch stored.Name {
		case sessionCookieName:
			if stored.MaxAge < 0 || stored.Value == "" {
				e.sessionCookie = nil
			} else {
				e.sessionCookie = &stored
			}
		case preAuthCookieName:
			if stored.MaxAge < 0 || stored.Value == "" {
				e.preAuthCookie = nil
			} else {
				e.preAuthCookie = &stored
			}
		}
	}
}

func (e *testEnv) setCSRF(token string) {
	e.authMu.Lock()
	defer e.authMu.Unlock()
	e.csrfToken = token
}

func (e *testEnv) fetchStatus() authStatusResponse {
	e.t.Helper()
	recorder := e.request(http.MethodGet, authStatusPath, "", "")
	if recorder.Code != http.StatusOK {
		e.t.Fatalf("GET auth/status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	status := decodeData[authStatusResponse](e.t, recorder)
	if status.CSRFToken == "" {
		e.t.Fatal("auth/status 未返回 csrfToken")
	}
	e.setCSRF(status.CSRFToken)
	return status
}

func (e *testEnv) setupAdmin(t *testing.T, password string) authStatusResponse {
	t.Helper()
	status := e.fetchStatus()
	if status.Initialized || status.Authenticated {
		t.Fatalf("新库 auth/status = %+v，期望未初始化", status)
	}
	body, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		t.Fatal(err)
	}
	recorder := e.request(http.MethodPost, authSetupPath, string(body), "application/json")
	if recorder.Code != http.StatusCreated {
		t.Fatalf("POST auth/setup = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	result := decodeData[authStatusResponse](t, recorder)
	if !result.Initialized || !result.Authenticated || result.CSRFToken == "" {
		t.Fatalf("setup 响应 = %+v", result)
	}
	e.setCSRF(result.CSRFToken)
	if e.sessionCookieToken() == "" {
		t.Fatal("setup 未设置 iread_session Cookie")
	}
	return result
}

func (e *testEnv) sessionCookieToken() string {
	e.authMu.Lock()
	defer e.authMu.Unlock()
	if e.sessionCookie == nil {
		return ""
	}
	return e.sessionCookie.Value
}

func (e *testEnv) setSessionCookieValue(raw string) {
	e.authMu.Lock()
	defer e.authMu.Unlock()
	if raw == "" {
		e.sessionCookie = nil
		return
	}
	e.sessionCookie = &http.Cookie{Name: sessionCookieName, Value: raw}
}

func (e *testEnv) login(password string) *httptest.ResponseRecorder {
	e.t.Helper()
	body, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		e.t.Fatal(err)
	}
	recorder := e.request(http.MethodPost, authLoginPath, string(body), "application/json")
	if recorder.Code == http.StatusOK {
		result := decodeData[authStatusResponse](e.t, recorder)
		e.setCSRF(result.CSRFToken)
	}
	return recorder
}

func (e *testEnv) logout() *httptest.ResponseRecorder {
	e.t.Helper()
	return e.request(http.MethodPost, authLogoutPath, "", "")
}

func authPasswordBody(password string) string {
	body, _ := json.Marshal(map[string]string{"password": password})
	return string(body)
}

func authSetupBody(password, setupToken string) string {
	payload := map[string]string{"password": password}
	if setupToken != "" {
		payload["setupToken"] = setupToken
	}
	body, _ := json.Marshal(payload)
	return string(body)
}

func writeWebFixture(t *testing.T, webDir string) {
	t.Helper()
	files := map[string]string{
		"index.html":           "<!doctype html><html><body>iread-index-marker</body></html>",
		"assets/app-123.js":    "console.log('asset-marker');",
		"assets/icon-abc.png":  "asset-icon-marker",
		"sw.js":                "self.addEventListener('install',()=>{});",
		"manifest.webmanifest": `{"name":"iRead","start_url":"/"}`,
		"icons/icon-192.png":   "png-icon-marker",
		"favicon.ico":          "favicon-marker",
		"apple-touch-icon.png": "apple-touch-marker",
		"robots.txt":           "User-agent: *\n",
	}
	for name, content := range files {
		full := filepath.Join(webDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func decodeData[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var envelope struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解析 data 失败: %v, body=%s", err, recorder.Body.String())
	}
	return envelope.Data
}

type apiErrorBody struct {
	Error struct {
		Code      string          `json:"code"`
		Message   string          `json:"message"`
		RequestID string          `json:"requestId"`
		Details   json.RawMessage `json:"details"`
	} `json:"error"`
}

func decodeAPIError(t *testing.T, recorder *httptest.ResponseRecorder) apiErrorBody {
	t.Helper()
	var body apiErrorBody
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析错误体失败: %v, body=%s", err, recorder.Body.String())
	}
	return body
}

var requestIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func assertCommonHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	requestID := recorder.Header().Get("X-Request-Id")
	if !requestIDPattern.MatchString(requestID) {
		t.Fatalf("X-Request-Id = %q", requestID)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := recorder.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q", got)
	}
	if got := recorder.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("不应开放 CORS，得到 %q", got)
	}
}

func validPutBody(baseRevision string, accent string) string {
	return `{"schemaVersion":1,"baseRevision":"` + baseRevision + `","value":{` +
		`"themeMode":"dark","lightPreset":"paper","darkPreset":"midnight",` +
		`"accent":"` + accent + `","density":"relaxed","contentWidth":80,"navCompact":true}}`
}

func TestAPIHeadersAndRequestID(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	first := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	second := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")

	if first.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", first.Code, first.Body.String())
	}
	assertCommonHeaders(t, first)
	if got := first.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("API Cache-Control = %q", got)
	}
	if got := first.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q", got)
	}
	if first.Header().Get("X-Request-Id") == second.Header().Get("X-Request-Id") {
		t.Fatal("两次请求的 X-Request-Id 不应相同")
	}

	notFound := env.request(http.MethodGet, "/api/v1/nope", "", "")
	assertCommonHeaders(t, notFound)
	if got := notFound.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("API 404 Cache-Control = %q", got)
	}

	static := env.request(http.MethodGet, "/", "", "")
	assertCommonHeaders(t, static)
}

func TestStatusRecorderUnwrap(t *testing.T) {
	recorder := httptest.NewRecorder()
	wrapped := &statusRecorder{ResponseWriter: recorder, status: http.StatusOK}
	if wrapped.Unwrap() != recorder {
		t.Fatal("statusRecorder.Unwrap 未返回底层 ResponseWriter")
	}
}

func TestInternalErrorDoesNotLeakPathsOrSQL(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	if err := env.store.Close(); err != nil {
		t.Fatal(err)
	}

	recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	errorBody := decodeAPIError(t, recorder)
	if errorBody.Error.Code != "internal_error" {
		t.Fatalf("code = %q", errorBody.Error.Code)
	}
	if strings.Contains(body, env.root) {
		t.Fatalf("错误体泄露临时目录: %s", body)
	}
	lower := strings.ToLower(body)
	if strings.Contains(lower, "sql") || strings.Contains(lower, "select") {
		t.Fatalf("错误体泄露 SQL: %s", body)
	}
	if strings.Contains(body, "database is closed") {
		t.Fatalf("错误体泄露底层错误: %s", body)
	}
}

func TestAPINotFoundIsJSON(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	for _, target := range []string{"/api", "/api/", "/api/v1/nope", "/api/v1/settings/library/extra"} {
		recorder := env.request(http.MethodGet, target, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("%s Content-Type = %q", target, got)
		}
		errorBody := decodeAPIError(t, recorder)
		if errorBody.Error.Code != "not_found" {
			t.Fatalf("%s code = %q", target, errorBody.Error.Code)
		}
		if strings.Contains(recorder.Body.String(), "iread-index-marker") {
			t.Fatalf("%s 返回了 SPA", target)
		}
	}
}

func TestMethodNotAllowedIsJSON(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	recorder := env.request(http.MethodPost, "/api/v1/settings/appearance", `{}`, "application/json")
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Allow"); got != "GET, PUT" {
		t.Fatalf("Allow = %q", got)
	}
	errorBody := decodeAPIError(t, recorder)
	if errorBody.Error.Code != "invalid_request" {
		t.Fatalf("code = %q", errorBody.Error.Code)
	}

	health := env.request(http.MethodPost, "/healthz", "", "")
	if health.Code != http.StatusMethodNotAllowed {
		t.Fatalf("healthz status = %d", health.Code)
	}
	if got := health.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("healthz Content-Type = %q", got)
	}
}

func TestUnimplementedSettingsGroupsReturn404(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	// reader 设置已在阶段3/6接入，由 reader_settings 测试覆盖；此处只检查
	// 仍未实现的 library/other 分组不会被伪装成成功。
	for _, group := range []string{"library", "other"} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			recorder := env.request(method, "/api/v1/settings/"+group, `{}`, "application/json")
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("%s %s status = %d", method, group, recorder.Code)
			}
			errorBody := decodeAPIError(t, recorder)
			if errorBody.Error.Code != "not_found" {
				t.Fatalf("%s %s code = %q", method, group, errorBody.Error.Code)
			}
		}
	}
}

func TestAppearancePersistenceAcrossReopen(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	recorder := env.request(http.MethodPut, "/api/v1/settings/appearance",
		validPutBody("0", "#3366cc"), "application/json")
	if recorder.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	env.reopen()

	recorder = env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d", recorder.Code)
	}
	record := decodeData[settings.AppearanceRecord](t, recorder)
	if record.Revision != "1" || record.Value.ThemeMode != "dark" || record.Value.Accent != "#3366cc" {
		t.Fatalf("重开后的记录 = %+v", record)
	}
}
