package auth

import "time"

const (
	// PreAuthTTL 为预认证上下文与 iread_preauth Cookie 的有效期。
	PreAuthTTL = 15 * time.Minute
	// SessionIdleTTL 为会话空闲有效期。
	SessionIdleTTL = 7 * 24 * time.Hour
	// SessionAbsoluteTTL 为会话绝对有效期，同时是会话 Cookie 的 Max-Age。
	SessionAbsoluteTTL = 30 * 24 * time.Hour
	// SessionCSRFTTL 为会话 CSRF 令牌有效期上限。
	SessionCSRFTTL = 30 * time.Minute
	// TouchInterval 为 last_seen_at 的最小写入间隔。
	TouchInterval = 60 * time.Second
)
