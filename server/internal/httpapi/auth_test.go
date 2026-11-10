package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"iread/server/internal/auth"
	"iread/server/internal/store"
)

func responseCookie(recorder interface {
	Result() *http.Response
}, name string) *http.Cookie {
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func requireCookie(t *testing.T, cookie *http.Cookie, name string) *http.Cookie {
	t.Helper()
	if cookie == nil {
		t.Fatalf("响应缺少 %s Cookie", name)
	}
	if cookie.Path != "/" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("%s Cookie 属性 = Path:%q HttpOnly:%v SameSite:%v", name, cookie.Path, cookie.HttpOnly, cookie.SameSite)
	}
	return cookie
}

func errorDetails(t *testing.T, recorderBody []byte) map[string]any {
	t.Helper()
	var body apiErrorBody
	if err := json.Unmarshal(recorderBody, &body); err != nil {
		t.Fatalf("解析错误体失败: %v", err)
	}
	var details map[string]any
	if len(body.Error.Details) > 0 {
		if err := json.Unmarshal(body.Error.Details, &details); err != nil {
			t.Fatalf("解析 details 失败: %v", err)
		}
	}
	return details
}

func TestAuthStatusCreatesPreAuthContext(t *testing.T) {
	env := newTestEnv(t)
	recorder := env.request(http.MethodGet, authStatusPath, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	status := decodeData[authStatusResponse](t, recorder)
	if status.Initialized || status.Authenticated || status.CSRFToken == "" {
		t.Fatalf("未初始化状态 = %+v", status)
	}
	if _, err := time.Parse(time.RFC3339, status.CSRFExpiresAt); err != nil {
		t.Fatalf("csrfExpiresAt = %q: %v", status.CSRFExpiresAt, err)
	}

	cookie := requireCookie(t, responseCookie(recorder, preAuthCookieName), preAuthCookieName)
	if cookie.MaxAge != 900 || cookie.Secure {
		t.Fatalf("预认证 Cookie MaxAge/Secure = %d/%v", cookie.MaxAge, cookie.Secure)
	}
	if len(cookie.Value) != 43 {
		t.Fatalf("预认证令牌长度 = %d，期望 43", len(cookie.Value))
	}
	if strings.Contains(recorder.Body.String(), cookie.Value) {
		t.Fatal("响应体不应回显预认证 Cookie 原文")
	}
	if responseCookie(recorder, sessionCookieName) != nil {
		t.Fatal("未认证状态不应设置会话 Cookie")
	}

	record, found, err := env.store.GetAuthContext(context.Background(), auth.HashToken(cookie.Value))
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("auth_contexts 未保存预认证上下文")
	}
	if record.ID == cookie.Value || record.CSRFHash == status.CSRFToken {
		t.Fatal("数据库不应保存原始预认证/CSRF 令牌")
	}
	if !auth.TokenMatches(status.CSRFToken, record.CSRFHash) {
		t.Fatal("CSRF hash 与响应令牌不匹配")
	}

	second := env.fetchStatus()
	if second.CSRFToken == status.CSRFToken {
		t.Fatal("再次 status 应轮换 CSRF 令牌")
	}
}

func TestStatusReportsAuthenticatedSession(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	oldCSRF := env.csrfToken
	recorder := env.request(http.MethodGet, authStatusPath, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	status := decodeData[authStatusResponse](t, recorder)
	if !status.Initialized || !status.Authenticated || status.CSRFToken == "" {
		t.Fatalf("已登录状态 = %+v", status)
	}
	if status.CSRFToken == oldCSRF {
		t.Fatal("已登录 status 应轮换 CSRF")
	}
	if responseCookie(recorder, preAuthCookieName) != nil {
		t.Fatal("已登录 status 不应创建预认证 Cookie")
	}
}

func TestSetupRequiresLoopback(t *testing.T) {
	env := newTestEnv(t)
	env.fetchStatus()
	recorder := env.do(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json",
		func(request *http.Request) {
			request.RemoteAddr = "203.0.113.10:1234"
		})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	errorBody := decodeAPIError(t, recorder)
	if errorBody.Error.Code != "forbidden" {
		t.Fatalf("code = %q", errorBody.Error.Code)
	}
	if details := errorDetails(t, recorder.Body.Bytes()); details["reason"] != setupForbiddenLocal {
		t.Fatalf("details = %v", details)
	}
	exists, err := env.store.AdminExists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("非回环 setup 不应创建管理员")
	}
}

func TestAuthStatusReportsSetupTokenRequired(t *testing.T) {
	env := newTestEnv(t)
	if status := env.fetchStatus(); status.SetupTokenRequired {
		t.Fatal("未配置 IREAD_SETUP_TOKEN 时 setupTokenRequired 应为 false")
	}

	const token = "status-token-not-for-output"
	tokenEnv := newSetupTokenTestEnv(t, token)
	recorder := tokenEnv.request(http.MethodGet, authStatusPath, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	status := decodeData[authStatusResponse](t, recorder)
	if !status.SetupTokenRequired {
		t.Fatal("配置 IREAD_SETUP_TOKEN 后 setupTokenRequired 应为 true")
	}
	if strings.Contains(recorder.Body.String(), token) {
		t.Fatal("auth/status 不应回显安装令牌")
	}
}

func TestSetupWithConfiguredToken(t *testing.T) {
	const token = "setup-token-correct-value"
	const wrongToken = "setup-token-wrong-value"
	env := newSetupTokenTestEnv(t, token)
	status := env.fetchStatus()
	if !status.SetupTokenRequired {
		t.Fatal("status 未标记 setupTokenRequired")
	}

	// 缺少令牌与错误令牌都必须 403 forbidden/setup_token_invalid，且不创建管理员。
	for _, test := range []struct {
		name     string
		body     string
		provided string
	}{
		{name: "missing", body: authPasswordBody(testAdminPassword)},
		{name: "wrong", body: authSetupBody(testAdminPassword, wrongToken), provided: wrongToken},
	} {
		recorder := env.request(http.MethodPost, authSetupPath, test.body, "application/json")
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("%s token status = %d, body=%s", test.name, recorder.Code, recorder.Body.String())
		}
		if code := decodeAPIError(t, recorder).Error.Code; code != "forbidden" {
			t.Fatalf("%s token code = %q", test.name, code)
		}
		if details := errorDetails(t, recorder.Body.Bytes()); details["reason"] != setupTokenInvalid {
			t.Fatalf("%s token details = %v", test.name, details)
		}
		exists, err := env.store.AdminExists(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("%s token 不应创建管理员", test.name)
		}
		if test.provided != "" &&
			(strings.Contains(recorder.Body.String(), test.provided) ||
				strings.Contains(env.logBuffer.String(), test.provided)) {
			t.Fatalf("%s token 不应出现在响应或日志中", test.name)
		}
	}

	// 正确令牌放在 body 中，成功 201。
	recorder := env.request(http.MethodPost, authSetupPath,
		authSetupBody(testAdminPassword, token), "application/json")
	if recorder.Code != http.StatusCreated {
		t.Fatalf("body token setup status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), token) ||
		strings.Contains(env.logBuffer.String(), token) {
		t.Fatal("安装令牌不应出现在响应或日志中")
	}
}

func TestSetupWithTokenAllowsNonLoopbackAndHeader(t *testing.T) {
	const token = "header-setup-token"
	env := newSetupTokenTestEnv(t, token)
	env.fetchStatus()

	recorder := env.do(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json",
		func(request *http.Request) {
			request.RemoteAddr = "203.0.113.10:1234"
			request.Header.Set(setupTokenHeaderName, token)
		})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("header token non-loopback setup status = %d, body=%s",
			recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), token) ||
		strings.Contains(env.logBuffer.String(), token) {
		t.Fatal("安装令牌不应出现在响应或日志中")
	}
}

func TestSetupWithTokenRejectsWrongHeaderBeforeNonLoopback(t *testing.T) {
	const token = "header-setup-token"
	env := newSetupTokenTestEnv(t, token)
	env.fetchStatus()

	recorder := env.do(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json",
		func(request *http.Request) {
			request.RemoteAddr = "203.0.113.10:1234"
			request.Header.Set(setupTokenHeaderName, "wrong-header-token")
		})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("wrong header token status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if details := errorDetails(t, recorder.Body.Bytes()); details["reason"] != setupTokenInvalid {
		t.Fatalf("wrong header token details = %v", details)
	}
	if strings.Contains(recorder.Body.String(), "wrong-header-token") ||
		strings.Contains(env.logBuffer.String(), "wrong-header-token") {
		t.Fatal("错误令牌不应出现在响应或日志中")
	}
	exists, err := env.store.AdminExists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("错误 header token 不应创建管理员")
	}
}

func TestSetupRequiresCSRFAndSameOrigin(t *testing.T) {
	env := newTestEnv(t)
	env.fetchStatus()

	noCSRF := env.do(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json",
		func(request *http.Request) { request.Header.Del(csrfHeaderName) })
	if noCSRF.Code != http.StatusForbidden {
		t.Fatalf("无 CSRF status = %d", noCSRF.Code)
	}
	errorBody := decodeAPIError(t, noCSRF)
	if errorBody.Error.Code != "forbidden" {
		t.Fatalf("无 CSRF code = %q", errorBody.Error.Code)
	}
	if details := errorDetails(t, noCSRF.Body.Bytes()); details["reason"] != csrfReasonInvalid {
		t.Fatalf("无 CSRF details = %v", details)
	}

	for _, origin := range []string{"null", "http://evil.example", ""} {
		recorder := env.do(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json",
			func(request *http.Request) {
				if origin == "" {
					request.Header.Del("Origin")
					request.Header.Del("Referer")
				} else {
					request.Header.Set("Origin", origin)
				}
			})
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("Origin %q status = %d, body=%s", origin, recorder.Code, recorder.Body.String())
		}
		errorBody := decodeAPIError(t, recorder)
		if errorBody.Error.Code != "invalid_origin" {
			t.Fatalf("Origin %q code = %q", origin, errorBody.Error.Code)
		}
	}

	// Origin 缺失时允许同源 Referer 兜底。
	recorder := env.do(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json",
		func(request *http.Request) {
			request.Header.Del("Origin")
			request.Header.Set("Referer", env.publicOrigin+"/settings")
		})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("Referer 兜底 setup status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSetupCreatesAdminSessionAndConsumesPreAuth(t *testing.T) {
	env := newTestEnv(t)
	status := env.fetchStatus()
	preAuthRaw := env.preAuthCookie.Value

	recorder := env.request(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json")
	if recorder.Code != http.StatusCreated {
		t.Fatalf("setup status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	result := decodeData[authStatusResponse](t, recorder)
	if !result.Initialized || !result.Authenticated || result.CSRFToken == "" {
		t.Fatalf("setup 响应 = %+v", result)
	}
	env.setCSRF(result.CSRFToken)
	if result.CSRFToken == status.CSRFToken {
		t.Fatal("setup 成功应轮换 CSRF")
	}

	sessionCookie := requireCookie(t, responseCookie(recorder, sessionCookieName), sessionCookieName)
	if sessionCookie.MaxAge != 2592000 || sessionCookie.Secure {
		t.Fatalf("会话 Cookie MaxAge/Secure = %d/%v", sessionCookie.MaxAge, sessionCookie.Secure)
	}
	if len(sessionCookie.Value) != 43 {
		t.Fatalf("会话令牌长度 = %d，期望 43", len(sessionCookie.Value))
	}
	if strings.Contains(recorder.Body.String(), testAdminPassword) ||
		strings.Contains(recorder.Body.String(), sessionCookie.Value) {
		t.Fatal("setup 响应回显了密码或原始会话令牌")
	}
	if responseCookie(recorder, preAuthCookieName) == nil {
		t.Fatal("setup 成功应清理预认证 Cookie")
	}

	admin, found, err := env.store.GetAdmin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("setup 未创建管理员")
	}
	if !strings.HasPrefix(admin.PasswordHash, "$argon2id$v=19$m=65536,t=3,p=2$") {
		t.Fatalf("密码散列不是 Argon2id PHC: %q", admin.PasswordHash)
	}
	if strings.Contains(admin.PasswordHash, testAdminPassword) {
		t.Fatal("密码散列包含明文密码")
	}
	if ok, err := auth.VerifyPassword(testAdminPassword, admin.PasswordHash); err != nil || !ok {
		t.Fatalf("Argon2id 校验失败: ok=%v err=%v", ok, err)
	}
	if ok, err := auth.VerifyPassword("wrong password", admin.PasswordHash); err != nil || ok {
		t.Fatalf("错误密码不应通过: ok=%v err=%v", ok, err)
	}

	session, found, err := env.store.GetSession(context.Background(), auth.HashToken(sessionCookie.Value))
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("sessions 未保存会话")
	}
	if session.ID == sessionCookie.Value || session.CSRFHash != auth.HashToken(result.CSRFToken) {
		t.Fatal("会话只应保存 token/CSRF 的 hash")
	}
	if session.RevokedAt != nil {
		t.Fatal("新会话不应已撤销")
	}

	if _, found, err := env.store.GetAuthContext(context.Background(), auth.HashToken(preAuthRaw)); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("setup 成功后应删除预认证上下文")
	}

	second := env.request(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json")
	if second.Code != http.StatusConflict {
		t.Fatalf("重复 setup status = %d", second.Code)
	}
	if decodeAPIError(t, second).Error.Code != "already_initialized" {
		t.Fatalf("重复 setup code = %q", decodeAPIError(t, second).Error.Code)
	}
}

func TestConcurrentSetupOnlyOneWins(t *testing.T) {
	env := newTestEnv(t)
	env.fetchStatus()
	const attempts = 4
	body := authPasswordBody(testAdminPassword)

	start := make(chan struct{})
	results := make(chan int, attempts)
	var wait sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- env.request(http.MethodPost, authSetupPath, body, "application/json").Code
		}()
	}
	close(start)
	wait.Wait()
	close(results)

	successes, conflicts := 0, 0
	for status := range results {
		switch status {
		case http.StatusCreated:
			successes++
		case http.StatusConflict:
			conflicts++
		default:
			t.Fatalf("意外状态码 %d", status)
		}
	}
	if successes != 1 || conflicts != attempts-1 {
		t.Fatalf("201=%d, 409=%d，期望 1/%d", successes, conflicts, attempts-1)
	}
	exists, err := env.store.AdminExists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("并发 setup 未创建管理员")
	}
}

func TestSetupRateLimit(t *testing.T) {
	env := newTestEnv(t)
	env.fetchStatus()

	for i := 0; i < auth.RateLimitAttempts; i++ {
		recorder := env.request(http.MethodPost, authSetupPath, authPasswordBody("123456789"), "application/json")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("第 %d 次 setup status = %d, body=%s", i+1, recorder.Code, recorder.Body.String())
		}
	}
	recorder := env.request(http.MethodPost, authSetupPath, authPasswordBody(testAdminPassword), "application/json")
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("setup 限流 status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Retry-After"); got != "900" {
		t.Fatalf("Retry-After = %q", got)
	}
	if details := errorDetails(t, recorder.Body.Bytes()); details["retryAfterSeconds"] != float64(auth.RateLimitRetryAfter) {
		t.Fatalf("details = %v", details)
	}
	exists, err := env.store.AdminExists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("限流期间不应创建管理员")
	}
}

func TestLoginDeletesPreAuthContext(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	env.logout()
	env.fetchStatus()
	preAuthRaw := env.preAuthCookie.Value

	recorder := env.login(testAdminPassword)
	if recorder.Code != http.StatusOK {
		t.Fatalf("login status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if _, found, err := env.store.GetAuthContext(context.Background(), auth.HashToken(preAuthRaw)); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("登录成功后应删除预认证上下文")
	}
}

func TestSessionLastSeenThrottle(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	ctx := context.Background()

	raw, tokenHash, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	oldSeen := now.Add(-2 * time.Minute)
	record := store.SessionRecord{
		ID:                tokenHash,
		UserID:            "admin",
		CSRFHash:          auth.HashToken("csrf-token"),
		CSRFExpiresAt:     now.Add(time.Hour),
		CreatedAt:         now.Add(-time.Hour),
		LastSeenAt:        oldSeen,
		IdleExpiresAt:     now.Add(6 * 24 * time.Hour),
		AbsoluteExpiresAt: now.Add(29 * 24 * time.Hour),
	}
	if err := env.store.CreateSession(ctx, record, "", ""); err != nil {
		t.Fatal(err)
	}
	env.setSessionCookieValue(raw)

	if recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", ""); recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	updated, found, err := env.store.GetSession(ctx, tokenHash)
	if err != nil || !found {
		t.Fatalf("GetSession = %+v, %v, %v", updated, found, err)
	}
	if !updated.LastSeenAt.After(oldSeen) || time.Since(updated.LastSeenAt) > 5*time.Second {
		t.Fatalf("last_seen_at 未更新: %v", updated.LastSeenAt)
	}
	firstSeen := updated.LastSeenAt

	if recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", ""); recorder.Code != http.StatusOK {
		t.Fatalf("第二次 status = %d", recorder.Code)
	}
	reloaded, found, err := env.store.GetSession(ctx, tokenHash)
	if err != nil || !found {
		t.Fatalf("第二次 GetSession = %+v, %v, %v", reloaded, found, err)
	}
	if !reloaded.LastSeenAt.Equal(firstSeen) {
		t.Fatalf("60 秒内不应重复写 last_seen_at: %v -> %v", firstSeen, reloaded.LastSeenAt)
	}
}

func TestLoginNotInitialized(t *testing.T) {
	env := newTestEnv(t)
	env.fetchStatus()
	recorder := env.login(testAdminPassword)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if decodeAPIError(t, recorder).Error.Code != "not_initialized" {
		t.Fatalf("code = %q", decodeAPIError(t, recorder).Error.Code)
	}
	if responseCookie(recorder, sessionCookieName) != nil {
		t.Fatal("未初始化 login 不应建立会话")
	}
}

func TestLoginWrongPasswordAndRateLimit(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	if recorder := env.logout(); recorder.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", recorder.Code)
	}
	env.fetchStatus()

	for i := 0; i < auth.RateLimitAttempts; i++ {
		recorder := env.login("wrong password value")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("第 %d 次错误密码 status = %d, body=%s", i+1, recorder.Code, recorder.Body.String())
		}
		if decodeAPIError(t, recorder).Error.Code != "unauthenticated" {
			t.Fatalf("第 %d 次错误密码 code = %q", i+1, decodeAPIError(t, recorder).Error.Code)
		}
		if responseCookie(recorder, sessionCookieName) != nil {
			t.Fatal("密码错误不应设置会话 Cookie")
		}
	}

	recorder := env.login(testAdminPassword)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("限流状态 = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Retry-After"); got != "900" {
		t.Fatalf("Retry-After = %q", got)
	}
	if decodeAPIError(t, recorder).Error.Code != "rate_limited" {
		t.Fatalf("限流 code = %q", decodeAPIError(t, recorder).Error.Code)
	}
	details := errorDetails(t, recorder.Body.Bytes())
	if value, _ := details["retryAfterSeconds"].(float64); int(value) != auth.RateLimitRetryAfter {
		t.Fatalf("details.retryAfterSeconds = %v", details["retryAfterSeconds"])
	}
}

func TestLoginSuccessClearsRateLimit(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	env.logout()
	env.fetchStatus()

	for i := 0; i < auth.RateLimitAttempts-1; i++ {
		if recorder := env.login("wrong password value"); recorder.Code != http.StatusUnauthorized {
			t.Fatalf("第 %d 次错误密码 status = %d", i+1, recorder.Code)
		}
	}
	if recorder := env.login(testAdminPassword); recorder.Code != http.StatusOK {
		t.Fatalf("正确密码 status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := env.login("wrong password value"); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("成功登录后计数未清零，status = %d", recorder.Code)
	}
}

func TestLoginRotatesSessionAndCSRF(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	oldSession := env.sessionCookieToken()
	oldCSRF := env.csrfToken
	if oldSession == "" || oldCSRF == "" {
		t.Fatal("setup 未产生会话/CSRF")
	}

	recorder := env.login(testAdminPassword)
	if recorder.Code != http.StatusOK {
		t.Fatalf("login status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	result := decodeData[authStatusResponse](t, recorder)
	if result.CSRFToken == oldCSRF {
		t.Fatal("登录后 CSRF 未轮换")
	}
	newSession := responseCookie(recorder, sessionCookieName)
	if newSession == nil || newSession.Value == oldSession {
		t.Fatal("登录后会话 ID 未轮换")
	}

	oldRecord, found, err := env.store.GetSession(context.Background(), auth.HashToken(oldSession))
	if err != nil {
		t.Fatal(err)
	}
	if !found || oldRecord.RevokedAt == nil {
		t.Fatal("登录成功后旧会话应被撤销")
	}

	env.setCSRF(oldCSRF)
	recorder = env.request(http.MethodPut, "/api/v1/settings/appearance", validPutBody("0", "default"), "application/json")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("旧 CSRF status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if details := errorDetails(t, recorder.Body.Bytes()); details["reason"] != csrfReasonInvalid {
		t.Fatalf("旧 CSRF details = %v", details)
	}
}

func TestSessionIdleAndAbsoluteExpiry(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	ctx := context.Background()

	cases := []struct {
		name     string
		created  time.Time
		idle     time.Time
		absolute time.Time
	}{
		{
			name:     "空闲过期",
			created:  time.Now().Add(-8 * 24 * time.Hour),
			idle:     time.Now().Add(-time.Hour),
			absolute: time.Now().Add(20 * 24 * time.Hour),
		},
		{
			name:     "绝对过期",
			created:  time.Now().Add(-31 * 24 * time.Hour),
			idle:     time.Now().Add(24 * time.Hour),
			absolute: time.Now().Add(-24 * time.Hour),
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			raw, tokenHash, err := auth.NewToken()
			if err != nil {
				t.Fatal(err)
			}
			record := store.SessionRecord{
				ID:                tokenHash,
				UserID:            "admin",
				CSRFHash:          auth.HashToken("csrf-token"),
				CSRFExpiresAt:     time.Now().Add(time.Hour),
				CreatedAt:         test.created,
				LastSeenAt:        test.created,
				IdleExpiresAt:     test.idle,
				AbsoluteExpiresAt: test.absolute,
			}
			if err := env.store.CreateSession(ctx, record, "", ""); err != nil {
				t.Fatal(err)
			}
			env.setSessionCookieValue(raw)
			recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestSessionSurvivesServerRestart(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	env.reopen()

	recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("重启后 status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestLogoutRevokesSessionAndAllowsPreAuth(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	oldSession := env.sessionCookieToken()

	recorder := env.do(http.MethodPost, authLogoutPath, "", "", func(request *http.Request) {
		request.Header.Set(csrfHeaderName, "wrong")
	})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("错误 CSRF logout status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", ""); recorder.Code != http.StatusOK {
		t.Fatalf("错误 CSRF logout 不应撤销会话，status = %d", recorder.Code)
	}

	recorder = env.logout()
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("204 不应有响应体: %q", recorder.Body.String())
	}
	cookie := requireCookie(t, responseCookie(recorder, sessionCookieName), sessionCookieName)
	if cookie.MaxAge >= 0 || cookie.Value != "" {
		t.Fatalf("logout 未清理会话 Cookie: %+v", cookie)
	}

	recorder = env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("退出后 status = %d", recorder.Code)
	}
	oldRecorder := env.do(http.MethodGet, "/api/v1/settings/appearance", "", "", func(request *http.Request) {
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: oldSession})
	})
	if oldRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("撤销会话 Cookie 复用 status = %d", oldRecorder.Code)
	}

	env.fetchStatus()
	preAuthRaw := env.preAuthCookie.Value
	recorder = env.logout()
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("预认证 logout status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if _, found, err := env.store.GetAuthContext(context.Background(), auth.HashToken(preAuthRaw)); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("退出后应删除预认证上下文")
	}
}

func TestUnauthenticatedAPIsReturn401JSON(t *testing.T) {
	env := newTestEnv(t)
	targets := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/settings/appearance"},
		{http.MethodPut, "/api/v1/settings/appearance"},
		{http.MethodGet, "/api/v1/books"},
		{http.MethodGet, "/api/v1/books/book-1"},
		{http.MethodGet, "/api/v1/books/book-1/cover"},
		{http.MethodGet, "/api/v1/uploads"},
		{http.MethodPost, "/api/v1/uploads"},
		{http.MethodGet, "/api/v1/uploads/upload-1"},
		{http.MethodGet, "/api/v1/tasks/task-1"},
		{http.MethodPost, "/api/v1/tasks/task-1/retry"},
		{http.MethodGet, "/api/v1/nope"},
		{http.MethodGet, "/api"},
		{http.MethodGet, "/api/"},
	}
	for _, target := range targets {
		recorder := env.request(target.method, target.path, "{}", "application/json")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, body=%s", target.method, target.path, recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("%s Content-Type = %q", target.path, got)
		}
		if decodeAPIError(t, recorder).Error.Code != "unauthenticated" {
			t.Fatalf("%s code = %q", target.path, decodeAPIError(t, recorder).Error.Code)
		}
		if strings.Contains(recorder.Body.String(), "iread-index-marker") {
			t.Fatalf("%s 返回了 SPA", target.path)
		}
	}
}

func TestPublicHealthAndShellRemainPublic(t *testing.T) {
	env := newTestEnv(t)
	for _, target := range []string{"/healthz", "/api/v1/health", "/", "/library"} {
		recorder := env.request(http.MethodGet, target, "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body=%s", target, recorder.Code, recorder.Body.String())
		}
	}
}

func TestCSRFFailures(t *testing.T) {
	env := newAuthenticatedTestEnv(t)

	// 同源 Referer 兜底可通过。
	record := decodeData[struct {
		Revision string `json:"revision"`
	}](t, env.request(http.MethodGet, "/api/v1/settings/appearance", "", ""))
	recorder := env.do(http.MethodPut, "/api/v1/settings/appearance", validPutBody(record.Revision, "default"), "application/json",
		func(request *http.Request) {
			request.Header.Del("Origin")
			request.Header.Set("Referer", env.publicOrigin+"/settings")
		})
	if recorder.Code != http.StatusOK {
		t.Fatalf("Referer 兜底 PUT status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = env.do(http.MethodPut, "/api/v1/settings/appearance", validPutBody("1", "default"), "application/json",
		func(request *http.Request) { request.Header.Del(csrfHeaderName) })
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("缺 CSRF status = %d", recorder.Code)
	}
	if details := errorDetails(t, recorder.Body.Bytes()); details["reason"] != csrfReasonInvalid {
		t.Fatalf("缺 CSRF details = %v", details)
	}
	for _, origin := range []string{"null", "http://evil.example", ""} {
		recorder = env.do(http.MethodPut, "/api/v1/settings/appearance", validPutBody("1", "default"), "application/json",
			func(request *http.Request) {
				if origin == "" {
					request.Header.Del("Origin")
					request.Header.Del("Referer")
				} else {
					request.Header.Set("Origin", origin)
				}
			})
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("Origin %q status = %d", origin, recorder.Code)
		}
		if decodeAPIError(t, recorder).Error.Code != "invalid_origin" {
			t.Fatalf("Origin %q code = %q", origin, decodeAPIError(t, recorder).Error.Code)
		}
	}

	sessionID := auth.HashToken(env.sessionCookieToken())
	expiredToken, expiredHash, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := env.store.RotateSessionCSRF(context.Background(), sessionID, expiredHash, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	env.setCSRF(expiredToken)
	recorder = env.request(http.MethodPut, "/api/v1/settings/appearance", validPutBody("1", "default"), "application/json")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("过期 CSRF status = %d", recorder.Code)
	}
	if details := errorDetails(t, recorder.Body.Bytes()); details["reason"] != csrfReasonExpired {
		t.Fatalf("过期 CSRF details = %v", details)
	}
}

func TestSecureCookiesWhenPublicOriginHTTPS(t *testing.T) {
	env := newTestEnv(t)
	env.publicOrigin = "https://iread.example.com"
	env.handler = env.newHandler()

	statusRecorder := env.request(http.MethodGet, authStatusPath, "", "")
	preAuth := requireCookie(t, responseCookie(statusRecorder, preAuthCookieName), preAuthCookieName)
	if !preAuth.Secure {
		t.Fatal("HTTPS 公开来源下预认证 Cookie 应为 Secure")
	}
	env.setupAdmin(t, testAdminPassword)

	loginRecorder := env.login(testAdminPassword)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("login status = %d", loginRecorder.Code)
	}
	session := requireCookie(t, responseCookie(loginRecorder, sessionCookieName), sessionCookieName)
	if !session.Secure {
		t.Fatal("HTTPS 公开来源下会话 Cookie 应为 Secure")
	}
}

func TestPasswordsAndTokensNotEchoedOrLogged(t *testing.T) {
	env := newTestEnv(t)
	env.fetchStatus()
	const shortSecret = "short"
	recorder := env.request(http.MethodPost, authSetupPath, authPasswordBody(shortSecret), "application/json")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("短密码 status = %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), shortSecret) {
		t.Fatal("错误响应回显了密码")
	}

	env.setupAdmin(t, testAdminPassword)
	sessionToken := env.sessionCookieToken()
	recorder = env.login("definitely-wrong-password")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("错误密码 status = %d", recorder.Code)
	}

	combined := env.logBuffer.String() + recorder.Body.String()
	for _, secret := range []string{shortSecret, testAdminPassword, "definitely-wrong-password", sessionToken} {
		if strings.Contains(combined, secret) {
			t.Fatalf("日志或响应泄露秘密 %q", secret)
		}
	}
}

func TestAuthPasswordValidation(t *testing.T) {
	env := newTestEnv(t)
	env.fetchStatus()

	for _, password := range []string{"123456789", strings.Repeat("a", 129)} {
		recorder := env.request(http.MethodPost, authSetupPath, authPasswordBody(password), "application/json")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("密码长度 %d status = %d, body=%s", len(password), recorder.Code, recorder.Body.String())
		}
	}

	// 10 个 Unicode 字符（30 字节）满足最少字符数，而不是按字节数判断。
	recorder := env.request(http.MethodPost, authSetupPath, authPasswordBody(strings.Repeat("密", 10)), "application/json")
	if recorder.Code != http.StatusCreated {
		t.Fatalf("10 个 Unicode 字符 status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
}
