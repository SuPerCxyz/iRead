package httpapi

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
	"time"

	"iread/server/internal/auth"
	"iread/server/internal/store"
)

const (
	sessionCookieName    = "iread_session"
	preAuthCookieName    = "iread_preauth"
	csrfHeaderName       = "X-CSRF-Token"
	authStatusPath       = "/api/v1/auth/status"
	authSetupPath        = "/api/v1/auth/setup"
	authLoginPath        = "/api/v1/auth/login"
	authLogoutPath       = "/api/v1/auth/logout"
	apiHealthPath        = "/api/v1/health"
	maxAuthBodyBytes     = 64 << 10
	maxUserAgentBytes    = 512
	csrfReasonInvalid    = "csrf_invalid"
	csrfReasonExpired    = "csrf_expired"
	setupForbiddenLocal  = "local_only"
	setupTokenInvalid    = "setup_token_invalid"
	setupTokenHeaderName = "X-Setup-Token"
	preAuthRenewWindow   = 60 * time.Second

	// 开发免认证模式的合成 CSRF 值；不落库、不作为真实会话令牌。
	devNoAuthCSRFToken     = "dev-no-auth"
	devNoAuthCSRFExpiresAt = "2099-12-31T23:59:59Z"
)

type requestAuthStateKey struct{}

type requestAuthState struct {
	session   *store.SessionRecord
	preAuth   *store.AuthContextRecord
	devNoAuth bool
}

func requestAuthFromContext(ctx context.Context) *requestAuthState {
	state, _ := ctx.Value(requestAuthStateKey{}).(*requestAuthState)
	if state == nil {
		return &requestAuthState{}
	}
	return state
}

// apiGuard 对 /api 前缀统一执行会话、来源与 CSRF 门禁。
func (s *Server) apiGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAPIRequest(r.URL.Path) || r.URL.Path == "/healthz" || r.URL.Path == apiHealthPath {
			next.ServeHTTP(w, r)
			return
		}

		// 显式开发免认证模式：不读 Cookie/会话，也不执行 Origin/CSRF 校验，
		// 只注入合成开发上下文；health 与静态资源仍走原有路径。
		if s.devNoAuth {
			ctx := context.WithValue(r.Context(), requestAuthStateKey{}, &requestAuthState{devNoAuth: true})
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		state, err := s.loadRequestAuth(r)
		if err != nil {
			s.internalError(w, r, "读取认证状态失败", err)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), requestAuthStateKey{}, state))

		if !isPublicAPIPath(r.URL.Path) && state.session == nil {
			if r.URL.Path != authLogoutPath || state.preAuth == nil {
				s.clearSessionCookie(w)
				s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "请先登录", nil)
				return
			}
		}

		if isStateChangingMethod(r.Method) {
			if !s.originAllowed(r) {
				s.writeAPIError(w, r, http.StatusForbidden, "invalid_origin", "请求来源不可信", nil)
				return
			}
			if reason := s.csrfFailureReason(r, state); reason != "" {
				s.writeCSRFError(w, r, reason)
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

// RequireAuth 供同一 mux 内注册的受保护路由显式复用；apiGuard 已在外层执行。
// 若被放到 apiGuard 之外，则因缺少认证状态而 fail closed。
func (s *Server) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := requestAuthFromContext(r.Context())
		if !state.devNoAuth && state.session == nil {
			s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "请先登录", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireCSRF 供同一 mux 内的写操作路由显式复用；apiGuard 已在外层执行。
func (s *Server) RequireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := requestAuthFromContext(r.Context())
		if state.devNoAuth {
			next.ServeHTTP(w, r)
			return
		}
		if !s.originAllowed(r) {
			s.writeAPIError(w, r, http.StatusForbidden, "invalid_origin", "请求来源不可信", nil)
			return
		}
		if reason := s.csrfFailureReason(r, state); reason != "" {
			s.writeCSRFError(w, r, reason)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) writeCSRFError(w http.ResponseWriter, r *http.Request, reason string) {
	message := "CSRF 校验失败"
	if reason == csrfReasonExpired {
		message = "CSRF 令牌已过期，请刷新页面后重试"
	}
	s.writeAPIError(w, r, http.StatusForbidden, "forbidden", message, map[string]string{"reason": reason})
}

func isPublicAPIPath(path string) bool {
	switch path {
	case apiHealthPath, authStatusPath, authSetupPath, authLoginPath:
		return true
	default:
		return false
	}
}

func isStateChangingMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

// loadRequestAuth 读取有效会话与预认证上下文；失效 Cookie 不会进入状态。
func (s *Server) loadRequestAuth(r *http.Request) (*requestAuthState, error) {
	state := &requestAuthState{}
	now := s.now()

	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		record, found, err := s.store.GetSession(r.Context(), auth.HashToken(cookie.Value))
		if err != nil {
			return nil, err
		}
		if found && sessionActive(record, now) {
			if now.Sub(record.LastSeenAt) >= auth.TouchInterval {
				idleExpires := now.Add(auth.SessionIdleTTL)
				if idleExpires.After(record.AbsoluteExpiresAt) {
					idleExpires = record.AbsoluteExpiresAt
				}
				if err := s.store.TouchSession(r.Context(), record.ID, now, idleExpires); err != nil {
					return nil, err
				}
				record.LastSeenAt = now
				record.IdleExpiresAt = idleExpires
			}
			state.session = &record
		}
	}

	if cookie, err := r.Cookie(preAuthCookieName); err == nil && cookie.Value != "" {
		record, found, err := s.store.GetAuthContext(r.Context(), auth.HashToken(cookie.Value))
		if err != nil {
			return nil, err
		}
		if found && record.UsedAt == nil && now.Before(record.ExpiresAt) {
			state.preAuth = &record
		}
	}

	return state, nil
}

func sessionActive(record store.SessionRecord, now time.Time) bool {
	return record.RevokedAt == nil &&
		now.Before(record.AbsoluteExpiresAt) &&
		now.Before(record.IdleExpiresAt)
}

// originAllowed 校验 Origin；缺失时仅接受同源 Referer 兜底。
func (s *Server) originAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin != "" {
		if strings.EqualFold(origin, "null") {
			return false
		}
		canonical, _, err := auth.NormalizeOrigin(origin)
		return err == nil && canonical == s.publicOrigin
	}
	referer := strings.TrimSpace(r.Header.Get("Referer"))
	if referer == "" {
		return false
	}
	return auth.SameOrigin(referer, s.publicOrigin)
}

func (s *Server) csrfFailureReason(r *http.Request, state *requestAuthState) string {
	token := r.Header.Get(csrfHeaderName)
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return csrfReasonInvalid
	}

	var storedHash string
	var expiresAt time.Time
	switch {
	case state.session != nil:
		storedHash = state.session.CSRFHash
		expiresAt = state.session.CSRFExpiresAt
	case state.preAuth != nil:
		storedHash = state.preAuth.CSRFHash
		expiresAt = state.preAuth.ExpiresAt
	default:
		return csrfReasonInvalid
	}
	if !auth.TokenMatches(token, storedHash) {
		return csrfReasonInvalid
	}
	if !s.now().Before(expiresAt) {
		return csrfReasonExpired
	}
	return ""
}

func (s *Server) setSessionCookie(w http.ResponseWriter, raw string, now time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    raw,
		Path:     "/",
		MaxAge:   int(auth.SessionAbsoluteTTL / time.Second),
		Expires:  now.Add(auth.SessionAbsoluteTTL).UTC(),
		HttpOnly: true,
		Secure:   s.secureCookies,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) setPreAuthCookie(w http.ResponseWriter, raw string, now time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     preAuthCookieName,
		Value:    raw,
		Path:     "/",
		MaxAge:   int(auth.PreAuthTTL / time.Second),
		Expires:  now.Add(auth.PreAuthTTL).UTC(),
		HttpOnly: true,
		Secure:   s.secureCookies,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	s.clearCookie(w, sessionCookieName)
}

func (s *Server) clearPreAuthCookie(w http.ResponseWriter) {
	s.clearCookie(w, preAuthCookieName)
}

func (s *Server) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0).UTC(),
		HttpOnly: true,
		Secure:   s.secureCookies,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) rotateSessionCSRF(ctx context.Context, record *store.SessionRecord, now time.Time) (string, time.Time, error) {
	raw, hash, err := auth.NewToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expiresAt := now.Add(auth.SessionCSRFTTL)
	if expiresAt.After(record.AbsoluteExpiresAt) {
		expiresAt = record.AbsoluteExpiresAt
	}
	if err := s.store.RotateSessionCSRF(ctx, record.ID, hash, expiresAt); err != nil {
		return "", time.Time{}, err
	}
	record.CSRFHash = hash
	record.CSRFExpiresAt = expiresAt
	return raw, expiresAt, nil
}

func (s *Server) rotateAuthContextCSRF(ctx context.Context, record *store.AuthContextRecord) (string, time.Time, error) {
	raw, hash, err := auth.NewToken()
	if err != nil {
		return "", time.Time{}, err
	}
	if err := s.store.RotateAuthContextCSRF(ctx, record.ID, hash, record.ExpiresAt); err != nil {
		return "", time.Time{}, err
	}
	record.CSRFHash = hash
	return raw, record.ExpiresAt, nil
}

func (s *Server) newPreAuthContext(ctx context.Context, now time.Time) (*store.AuthContextRecord, string, error) {
	raw, hash, err := auth.NewToken()
	if err != nil {
		return nil, "", err
	}
	record := store.AuthContextRecord{
		ID:        hash,
		CreatedAt: now,
		ExpiresAt: now.Add(auth.PreAuthTTL),
	}
	if err := s.store.CreateAuthContext(ctx, record); err != nil {
		return nil, "", err
	}
	return &record, raw, nil
}

func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	if ip == nil {
		if host == "" {
			return "unknown"
		}
		return host
	}
	return ip.String()
}

func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// setupTokenMatches 在固定长度摘要上做常量时间比较，避免长度差提前返回。
func setupTokenMatches(provided, expected string) bool {
	if provided == "" || expected == "" {
		return false
	}
	providedHash := auth.HashToken(provided)
	expectedHash := auth.HashToken(expected)
	return subtle.ConstantTimeCompare([]byte(providedHash), []byte(expectedHash)) == 1
}

func normalizeUserAgent(value string) string {
	if len(value) <= maxUserAgentBytes {
		return value
	}
	return value[:maxUserAgentBytes]
}
