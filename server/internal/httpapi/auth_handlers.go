package httpapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"iread/server/internal/auth"
	"iread/server/internal/store"
)

type authStatusResponse struct {
	Initialized        bool   `json:"initialized"`
	Authenticated      bool   `json:"authenticated"`
	DevNoAuth          bool   `json:"devNoAuth,omitempty"`
	CSRFToken          string `json:"csrfToken"`
	CSRFExpiresAt      string `json:"csrfExpiresAt"`
	SetupTokenRequired bool   `json:"setupTokenRequired"`
}

type authPasswordRequest struct {
	Password *string `json:"password"`
}

type authSetupRequest struct {
	Password   *string `json:"password"`
	SetupToken *string `json:"setupToken"`
}

// devAuthStatus 返回固定的开发免认证状态；不落库、不签发 Cookie。
func (s *Server) devAuthStatus() authStatusResponse {
	return authStatusResponse{
		Initialized:        true,
		Authenticated:      true,
		DevNoAuth:          true,
		CSRFToken:          devNoAuthCSRFToken,
		CSRFExpiresAt:      devNoAuthCSRFExpiresAt,
		SetupTokenRequired: false,
	}
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, r, "GET")
		return
	}
	state := requestAuthFromContext(r.Context())
	now := s.now()

	if state.devNoAuth {
		// 合成状态：不创建用户/会话，也不轮换真实 CSRF。
		s.writeData(w, http.StatusOK, s.devAuthStatus())
		return
	}

	if state.session != nil {
		csrfToken, expiresAt, err := s.rotateSessionCSRF(r.Context(), state.session, now)
		if err != nil {
			s.internalError(w, r, "刷新会话 CSRF 失败", err)
			return
		}
		s.writeData(w, http.StatusOK, authStatusResponse{
			Initialized:        true,
			Authenticated:      true,
			CSRFToken:          csrfToken,
			CSRFExpiresAt:      expiresAt.UTC().Format(time.RFC3339),
			SetupTokenRequired: s.setupToken != "",
		})
		return
	}

	if _, err := r.Cookie(sessionCookieName); err == nil {
		s.clearSessionCookie(w)
	}

	contextRecord := state.preAuth
	if contextRecord != nil && !now.Add(preAuthRenewWindow).Before(contextRecord.ExpiresAt) {
		// 临近过期的上下文不再复用，避免返回只剩数秒有效期的 CSRF。
		if err := s.store.DeleteAuthContext(r.Context(), contextRecord.ID); err != nil {
			s.logger.Warn("删除即将过期的预认证上下文失败", "error", err, "requestId", requestIDFromRequest(r))
		}
		contextRecord = nil
	}
	if contextRecord == nil {
		if err := s.store.DeleteExpiredAuthContexts(r.Context(), now); err != nil {
			s.logger.Warn("清理过期预认证上下文失败", "error", err, "requestId", requestIDFromRequest(r))
		}
		created, raw, err := s.newPreAuthContext(r.Context(), now)
		if err != nil {
			s.internalError(w, r, "创建预认证上下文失败", err)
			return
		}
		contextRecord = created
		s.setPreAuthCookie(w, raw, now)
	}

	csrfToken, expiresAt, err := s.rotateAuthContextCSRF(r.Context(), contextRecord)
	if err != nil {
		s.internalError(w, r, "刷新预认证 CSRF 失败", err)
		return
	}
	initialized, err := s.store.AdminExists(r.Context())
	if err != nil {
		s.internalError(w, r, "读取管理员初始化状态失败", err)
		return
	}

	s.writeData(w, http.StatusOK, authStatusResponse{
		Initialized:        initialized,
		Authenticated:      false,
		CSRFToken:          csrfToken,
		CSRFExpiresAt:      expiresAt.UTC().Format(time.RFC3339),
		SetupTokenRequired: s.setupToken != "",
	})
}

func (s *Server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, r, "POST")
		return
	}
	state := requestAuthFromContext(r.Context())
	if state.devNoAuth {
		s.writeAPIError(w, r, http.StatusConflict, "already_initialized",
			"开发模式已关闭认证，无需初始化管理员", nil)
		return
	}
	// 未配置安装令牌时保留原有“仅 RemoteAddr 回环”边界；配置令牌后由令牌
	// 取代回环检查，适配反向代理/容器部署。
	if s.setupToken == "" && !isLoopbackRemote(r.RemoteAddr) {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "管理员初始化仅允许本机访问",
			map[string]string{"reason": setupForbiddenLocal})
		return
	}

	initialized, err := s.store.AdminExists(r.Context())
	if err != nil {
		s.internalError(w, r, "读取管理员初始化状态失败", err)
		return
	}
	if state.session != nil || initialized {
		s.writeAPIError(w, r, http.StatusConflict, "already_initialized", "管理员已初始化", nil)
		return
	}

	ip := clientIP(r.RemoteAddr)
	if s.limiter.Blocked(ip) {
		s.writeRateLimited(w, r)
		return
	}

	providedToken := ""
	if s.setupToken != "" {
		providedToken = r.Header.Get(setupTokenHeaderName)
		if providedToken != "" && !setupTokenMatches(providedToken, s.setupToken) {
			s.limiter.RecordFailure(ip)
			s.writeSetupTokenInvalid(w, r)
			return
		}
	}

	request, ok := s.readSetupRequest(w, r)
	if !ok {
		s.limiter.RecordFailure(ip)
		return
	}
	if s.setupToken != "" {
		if providedToken == "" && request.SetupToken != nil {
			providedToken = *request.SetupToken
		}
		if !setupTokenMatches(providedToken, s.setupToken) {
			s.limiter.RecordFailure(ip)
			s.writeSetupTokenInvalid(w, r)
			return
		}
	}
	if request.Password == nil {
		s.limiter.RecordFailure(ip)
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "缺少 password",
			map[string]string{"field": "password"})
		return
	}
	password := *request.Password
	if err := auth.ValidatePassword(password); err != nil {
		s.limiter.RecordFailure(ip)
		message := "密码不符合要求"
		var validation *auth.PasswordValidationError
		if errors.As(err, &validation) && validation.Message != "" {
			message = validation.Message
		}
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", message,
			map[string]string{"field": "password"})
		return
	}

	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		s.internalError(w, r, "生成密码散列失败", err)
		return
	}
	now := s.now()
	session, csrfToken, sessionCookie, err := newSessionRecord(now, r.UserAgent())
	if err != nil {
		s.internalError(w, r, "创建管理员会话失败", err)
		return
	}

	preAuthID := ""
	if state.preAuth != nil {
		preAuthID = state.preAuth.ID
	}
	created, err := s.store.CreateAdminSession(r.Context(), passwordHash, now, session, preAuthID)
	if err != nil {
		s.internalError(w, r, "创建管理员失败", err)
		return
	}
	if !created {
		s.writeAPIError(w, r, http.StatusConflict, "already_initialized", "管理员已初始化", nil)
		return
	}

	s.setSessionCookie(w, sessionCookie, now)
	s.clearPreAuthCookie(w)
	s.limiter.Reset(ip)
	s.writeData(w, http.StatusCreated, authStatusResponse{
		Initialized:        true,
		Authenticated:      true,
		CSRFToken:          csrfToken,
		CSRFExpiresAt:      session.CSRFExpiresAt.UTC().Format(time.RFC3339),
		SetupTokenRequired: s.setupToken != "",
	})
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, r, "POST")
		return
	}
	state := requestAuthFromContext(r.Context())
	if state.devNoAuth {
		// 不校验密码、不查管理员、不签发会话；仅返回合成状态。
		s.clearSessionCookie(w)
		s.clearPreAuthCookie(w)
		s.writeData(w, http.StatusOK, s.devAuthStatus())
		return
	}

	admin, found, err := s.store.GetAdmin(r.Context())
	if err != nil {
		s.internalError(w, r, "读取管理员凭据失败", err)
		return
	}
	if !found {
		s.writeAPIError(w, r, http.StatusConflict, "not_initialized", "管理员尚未初始化", nil)
		return
	}

	ip := clientIP(r.RemoteAddr)
	if s.limiter.Blocked(ip) {
		s.writeRateLimited(w, r)
		return
	}

	password, ok := s.readAuthPassword(w, r)
	if !ok {
		s.limiter.RecordFailure(ip)
		return
	}
	matches, err := auth.VerifyPassword(password, admin.PasswordHash)
	if err != nil {
		s.internalError(w, r, "验证密码失败", err)
		return
	}
	if !matches {
		s.limiter.RecordFailure(ip)
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "密码不正确", nil)
		return
	}

	now := s.now()
	session, csrfToken, sessionCookie, err := newSessionRecord(now, r.UserAgent())
	if err != nil {
		s.internalError(w, r, "创建登录会话失败", err)
		return
	}
	oldSessionID := ""
	if state.session != nil {
		oldSessionID = state.session.ID
	}
	preAuthID := ""
	if state.preAuth != nil {
		preAuthID = state.preAuth.ID
	}
	if err := s.store.CreateSession(r.Context(), session, oldSessionID, preAuthID); err != nil {
		s.internalError(w, r, "保存登录会话失败", err)
		return
	}

	s.setSessionCookie(w, sessionCookie, now)
	s.clearPreAuthCookie(w)
	s.limiter.Reset(ip)
	s.writeData(w, http.StatusOK, authStatusResponse{
		Initialized:        true,
		Authenticated:      true,
		CSRFToken:          csrfToken,
		CSRFExpiresAt:      session.CSRFExpiresAt.UTC().Format(time.RFC3339),
		SetupTokenRequired: s.setupToken != "",
	})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, r, "POST")
		return
	}
	state := requestAuthFromContext(r.Context())
	if state.devNoAuth {
		// 开发模式没有真实会话；仅清理浏览器残留 Cookie。
		s.clearSessionCookie(w)
		s.clearPreAuthCookie(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	now := s.now()

	if state.session != nil {
		if err := s.store.RevokeSession(r.Context(), state.session.ID, now); err != nil {
			s.internalError(w, r, "撤销会话失败", err)
			return
		}
	}
	if state.preAuth != nil {
		if err := s.store.DeleteAuthContext(r.Context(), state.preAuth.ID); err != nil {
			s.internalError(w, r, "删除预认证上下文失败", err)
			return
		}
	}

	s.clearSessionCookie(w)
	s.clearPreAuthCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeRateLimited(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Retry-After", "900")
	s.writeAPIError(w, r, http.StatusTooManyRequests, "rate_limited", "尝试次数过多，请稍后再试",
		map[string]int{"retryAfterSeconds": auth.RateLimitRetryAfter})
}

func (s *Server) writeSetupTokenInvalid(w http.ResponseWriter, r *http.Request) {
	s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "安装令牌无效",
		map[string]string{"reason": setupTokenInvalid})
}

func (s *Server) readAuthPassword(w http.ResponseWriter, r *http.Request) (string, bool) {
	var request authPasswordRequest
	if !s.readAuthJSON(w, r, &request) {
		return "", false
	}
	if request.Password == nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "缺少 password",
			map[string]string{"field": "password"})
		return "", false
	}
	return *request.Password, true
}

func (s *Server) readSetupRequest(w http.ResponseWriter, r *http.Request) (authSetupRequest, bool) {
	var request authSetupRequest
	if !s.readAuthJSON(w, r, &request) {
		return request, false
	}
	return request, true
}

func (s *Server) readAuthJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		s.writeAPIError(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type", "仅支持 application/json", nil)
		return false
	}

	if r.ContentLength > maxAuthBodyBytes {
		s.writeAPIError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 64 KiB", nil)
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxAuthBodyBytes+1))
	if err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "读取请求体失败", nil)
		return false
	}
	if len(body) > maxAuthBodyBytes {
		s.writeAPIError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 64 KiB", nil)
		return false
	}

	if err := decodeStrictJSON(body, destination); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "请求体不是合法的 JSON", nil)
		return false
	}
	return true
}

// newSessionRecord 生成会话记录，返回 CSRF 原文和会话 Cookie 原文（只写 Cookie，不入库）。
func newSessionRecord(now time.Time, userAgent string) (store.SessionRecord, string, string, error) {
	sessionRaw, sessionHash, err := auth.NewToken()
	if err != nil {
		return store.SessionRecord{}, "", "", err
	}
	csrfRaw, csrfHash, err := auth.NewToken()
	if err != nil {
		return store.SessionRecord{}, "", "", err
	}
	absoluteExpires := now.Add(auth.SessionAbsoluteTTL)
	csrfExpires := now.Add(auth.SessionCSRFTTL)
	if csrfExpires.After(absoluteExpires) {
		csrfExpires = absoluteExpires
	}
	return store.SessionRecord{
		ID:                sessionHash,
		UserID:            "admin",
		CSRFHash:          csrfHash,
		CSRFExpiresAt:     csrfExpires,
		CreatedAt:         now,
		LastSeenAt:        now,
		IdleExpiresAt:     now.Add(auth.SessionIdleTTL),
		AbsoluteExpiresAt: absoluteExpires,
		UserAgent:         normalizeUserAgent(userAgent),
	}, csrfRaw, sessionRaw, nil
}
