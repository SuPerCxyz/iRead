// Package auth 提供密码散列、随机令牌、来源规范化与认证限流等安全原语。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	// Argon2Memory 为 Argon2id 使用的内存（KiB）。
	Argon2Memory = 64 * 1024
	// Argon2Iterations 为 Argon2id 迭代次数。
	Argon2Iterations = 3
	// Argon2Parallelism 为 Argon2id 并行度。
	Argon2Parallelism = 2
	// Argon2SaltLength 为每个密码独立生成的 salt 字节数。
	Argon2SaltLength = 16
	// Argon2KeyLength 为派生 key 的字节数。
	Argon2KeyLength = 32
	// MinPasswordRunes 为密码最少 Unicode 字符数。
	MinPasswordRunes = 10
	// MaxPasswordBytes 为密码最多字节数。
	MaxPasswordBytes = 128
	// TokenLength 为会话/预认证/CSRF 原始令牌的随机字节数。
	TokenLength = 32
)

// PasswordValidationError 表示密码未满足长度约束。
type PasswordValidationError struct {
	Message string
}

func (e *PasswordValidationError) Error() string {
	return e.Message
}

// ErrInvalidPasswordHash 表示数据库中的 PHC 字符串无法安全解析。
var ErrInvalidPasswordHash = errors.New("密码散列格式无效")

// ValidatePassword 校验密码至少 10 个 Unicode 字符且最多 128 字节；不做裁剪。
func ValidatePassword(password string) error {
	if !utf8.ValidString(password) {
		return &PasswordValidationError{Message: "密码必须是合法的 Unicode 文本"}
	}
	if utf8.RuneCountInString(password) < MinPasswordRunes {
		return &PasswordValidationError{Message: "密码至少需要 10 个字符"}
	}
	if len(password) > MaxPasswordBytes {
		return &PasswordValidationError{Message: "密码不能超过 128 字节"}
	}
	return nil
}

// HashPassword 使用固定参数的 Argon2id 生成标准 PHC 字符串。
func HashPassword(password string) (string, error) {
	salt := make([]byte, Argon2SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("生成密码 salt 失败: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, Argon2Iterations, Argon2Memory, Argon2Parallelism, Argon2KeyLength)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		Argon2Memory,
		Argon2Iterations,
		Argon2Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword 解析 PHC 字符串并以常量时间比较派生 key。
func VerifyPassword(password, encoded string) (bool, error) {
	memory, iterations, parallelism, salt, key, err := decodePHC(encoded)
	if err != nil {
		return false, err
	}
	candidate := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(key)))
	return subtle.ConstantTimeCompare(candidate, key) == 1, nil
}

func decodePHC(encoded string) (uint32, uint32, uint8, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
	}
	if parts[2] != fmt.Sprintf("v=%d", argon2.Version) {
		return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
	}

	var memory, iterations uint32
	var parallelism uint8
	params := strings.Split(parts[3], ",")
	if len(params) != 3 {
		return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
	}
	for _, param := range params {
		key, value, ok := strings.Cut(param, "=")
		if !ok {
			return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
		}
		parsed, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
		}
		switch key {
		case "m":
			memory = uint32(parsed)
		case "t":
			iterations = uint32(parsed)
		case "p":
			if parsed > 255 {
				return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
			}
			parallelism = uint8(parsed)
		default:
			return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
		}
	}
	// 即使数据库被篡改，也不允许解析出会拖垮进程的极端参数。
	if memory < 8*1024 || memory > 256*1024 || iterations < 1 || iterations > 10 ||
		parallelism < 1 || parallelism > 16 {
		return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
	}

	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
	}
	key, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil || len(key) < 16 || len(key) > 64 {
		return 0, 0, 0, nil, nil, ErrInvalidPasswordHash
	}
	return memory, iterations, parallelism, salt, key, nil
}

// NewToken 生成 32 字节随机令牌并返回 base64url 原文与其 SHA-256 hex。
func NewToken() (raw string, tokenHash string, err error) {
	random := make([]byte, TokenLength)
	if _, err := rand.Read(random); err != nil {
		return "", "", fmt.Errorf("生成安全令牌失败: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(random)
	return raw, HashToken(raw), nil
}

// HashToken 返回令牌的 SHA-256 小写十六进制，数据库只保存该值。
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// TokenMatches 以常量时间比较原始令牌与已保存的 SHA-256 hex。
func TokenMatches(raw, storedHash string) bool {
	computed := HashToken(raw)
	return subtle.ConstantTimeCompare([]byte(computed), []byte(strings.ToLower(storedHash))) == 1
}

// NormalizeOrigin 校验并规范化公开来源，返回显式端口的 scheme://host。
func NormalizeOrigin(raw string) (origin string, secure bool, err error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", false, errors.New("公开来源不能为空")
	}
	parsed, err := parseAbsoluteURL(value)
	if err != nil {
		return "", false, err
	}
	if parsed.User != nil {
		return "", false, errors.New("公开来源不能包含用户信息")
	}
	if (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false, errors.New("公开来源不能包含路径、查询或片段")
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false, errors.New("公开来源仅支持 http/https")
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", false, errors.New("公开来源缺少主机名")
	}
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return "", false, errors.New("公开来源端口无效")
	}
	return scheme + "://" + joinHostPort(host, port), scheme == "https", nil
}
