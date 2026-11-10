package auth

import (
	"sync"
	"time"
)

const (
	// RateLimitAttempts 为窗口内允许的失败次数。
	RateLimitAttempts = 5
	// RateLimitWindow 为失败计数窗口。
	RateLimitWindow = 15 * time.Minute
	// RateLimitRetryAfter 为超限响应统一声明的重试秒数。
	RateLimitRetryAfter = 15 * 60
)

// RateLimiter 是按客户端 IP 统计失败次数的进程内滑动窗口。
type RateLimiter struct {
	mu       sync.Mutex
	now      func() time.Time
	failures map[string][]time.Time
}

// NewRateLimiter 创建使用系统时钟的限流器。
func NewRateLimiter() *RateLimiter {
	return newRateLimiter(time.Now)
}

func newRateLimiter(now func() time.Time) *RateLimiter {
	return &RateLimiter{now: now, failures: make(map[string][]time.Time)}
}

// Blocked 返回该来源是否已超过失败上限。
func (l *RateLimiter) Blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	active := l.activeLocked(key, now)
	if len(active) >= RateLimitAttempts {
		l.failures[key] = active
		return true
	}
	if len(active) == 0 {
		delete(l.failures, key)
	} else {
		l.failures[key] = active
	}
	return false
}

// RecordFailure 记录一次失败；达到上限后由 Blocked 拒绝后续尝试。
func (l *RateLimiter) RecordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	active := l.activeLocked(key, now)
	active = append(active, now)
	l.failures[key] = active
}

// Reset 在成功认证后清除该来源的失败记录。
func (l *RateLimiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, key)
}

func (l *RateLimiter) activeLocked(key string, now time.Time) []time.Time {
	cutoff := now.Add(-RateLimitWindow)
	existing := l.failures[key]
	active := existing[:0]
	for _, at := range existing {
		if at.After(cutoff) {
			active = append(active, at)
		}
	}
	return active
}
