package auth

import (
	"strings"
	"testing"
	"time"
)

func TestValidatePassword(t *testing.T) {
	valid := []string{
		"1234567890",
		"密碼密碼密碼密碼密碼", // 10 个 Unicode 字符
		strings.Repeat("a", 128),
	}
	for _, password := range valid {
		if err := ValidatePassword(password); err != nil {
			t.Fatalf("ValidatePassword(%q) error = %v", password, err)
		}
	}
	invalid := []string{
		"",
		"123456789",
		strings.Repeat("密", 9),
		strings.Repeat("a", 129),
		string([]byte{0xff, 0xfe}),
	}
	for _, password := range invalid {
		if err := ValidatePassword(password); err == nil {
			t.Fatalf("ValidatePassword(%q) 应失败", password)
		}
	}
}

func TestHashPasswordUsesArgon2idAndIsSalted(t *testing.T) {
	password := "correct horse battery staple"
	first, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(first, "$argon2id$v=19$m=65536,t=3,p=2$") {
		t.Fatalf("PHC 前缀 = %q", first)
	}
	if first == second {
		t.Fatal("相同密码应使用独立 salt")
	}
	if !strings.Contains(first, "$") || strings.Contains(first, password) {
		t.Fatalf("PHC 异常: %q", first)
	}

	ok, err := VerifyPassword(password, first)
	if err != nil || !ok {
		t.Fatalf("正确密码校验失败: ok=%v err=%v", ok, err)
	}
	ok, err = VerifyPassword("wrong password", first)
	if err != nil || ok {
		t.Fatalf("错误密码校验异常: ok=%v err=%v", ok, err)
	}

	memory, iterations, parallelism, salt, key, err := decodePHC(first)
	if err != nil {
		t.Fatal(err)
	}
	if memory != Argon2Memory || iterations != Argon2Iterations || parallelism != Argon2Parallelism ||
		len(salt) != Argon2SaltLength || len(key) != Argon2KeyLength {
		t.Fatalf("PHC 参数 = %d/%d/%d salt:%d key:%d", memory, iterations, parallelism, len(salt), len(key))
	}
}

func TestVerifyPasswordRejectsMalformedHash(t *testing.T) {
	for _, encoded := range []string{
		"",
		"plaintext",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=0,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=99,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=0$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$***$aGFzaA",
	} {
		if _, err := VerifyPassword("password", encoded); err == nil {
			t.Fatalf("损坏的 PHC 应失败: %q", encoded)
		}
	}
}

func TestNewTokenAndHash(t *testing.T) {
	raw, hash, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 43 {
		t.Fatalf("base64url 令牌长度 = %d", len(raw))
	}
	if len(hash) != 64 {
		t.Fatalf("SHA-256 hex 长度 = %d", len(hash))
	}
	if hash != strings.ToLower(hash) || strings.Contains(hash, raw) {
		t.Fatalf("hash 格式异常: %q", hash)
	}
	if !TokenMatches(raw, hash) {
		t.Fatal("TokenMatches 未匹配正确令牌")
	}
	if TokenMatches(raw+"x", hash) || TokenMatches("", hash) || TokenMatches(raw, "") {
		t.Fatal("TokenMatches 不应匹配错误令牌")
	}
	if _, secondHash, err := NewToken(); err != nil || secondHash == hash {
		t.Fatalf("两次令牌应不同: %q %q %v", hash, secondHash, err)
	}
}

func TestNormalizeOrigin(t *testing.T) {
	tests := []struct {
		input  string
		origin string
		secure bool
		ok     bool
	}{
		{"http://127.0.0.1:8080", "http://127.0.0.1:8080", false, true},
		{"https://iread.example.com", "https://iread.example.com:443", true, true},
		{"http://iread.example.com/", "http://iread.example.com:80", false, true},
		{"HTTPS://IREAD.EXAMPLE.COM:8443", "https://iread.example.com:8443", true, true},
		{"http://[::1]:8080", "http://[::1]:8080", false, true},
		{"ftp://iread.example.com", "", false, false},
		{"iread.example.com", "", false, false},
		{"http://iread.example.com/path", "", false, false},
		{"http://iread.example.com/?q=1", "", false, false},
		{"http://iread.example.com/#fragment", "", false, false},
		{"http://user:pass@iread.example.com", "", false, false},
		{"http://", "", false, false},
		{"http://iread.example.com:bad", "", false, false},
	}
	for _, test := range tests {
		origin, secure, err := NormalizeOrigin(test.input)
		if test.ok {
			if err != nil || origin != test.origin || secure != test.secure {
				t.Fatalf("NormalizeOrigin(%q) = %q/%v/%v，期望 %q/%v", test.input, origin, secure, err, test.origin, test.secure)
			}
		} else if err == nil {
			t.Fatalf("NormalizeOrigin(%q) 应失败，得到 %q", test.input, origin)
		}
	}
}

func TestSameOrigin(t *testing.T) {
	if !SameOrigin("https://iread.example.com/library?q=1", "https://iread.example.com:443") {
		t.Fatal("同源 Referer 应匹配")
	}
	for _, referer := range []string{
		"https://evil.example/library",
		"http://iread.example.com/library",
		"https://iread.example.com.evil.example/library",
		"not a url",
	} {
		if SameOrigin(referer, "https://iread.example.com:443") {
			t.Fatalf("%q 不应匹配", referer)
		}
	}
}

func TestRateLimiterWindowAndReset(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	limiter := newRateLimiter(func() time.Time { return now })

	for i := 0; i < RateLimitAttempts; i++ {
		if limiter.Blocked("127.0.0.1") {
			t.Fatalf("第 %d 次前不应限流", i+1)
		}
		limiter.RecordFailure("127.0.0.1")
	}
	if !limiter.Blocked("127.0.0.1") {
		t.Fatal("达到上限后应限流")
	}
	if limiter.Blocked("203.0.113.1") {
		t.Fatal("不同 IP 不应共享限流")
	}

	now = now.Add(RateLimitWindow + time.Second)
	if limiter.Blocked("127.0.0.1") {
		t.Fatal("窗口过期后应解除限流")
	}

	limiter.RecordFailure("127.0.0.1")
	limiter.Reset("127.0.0.1")
	if limiter.Blocked("127.0.0.1") {
		t.Fatal("Reset 后不应限流")
	}
}
