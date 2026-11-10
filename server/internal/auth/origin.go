package auth

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

// SameOrigin 判断完整 URL（可为 Referer）是否指向已规范化的公开来源。
func SameOrigin(rawURL, canonical string) bool {
	parsed, err := parseAbsoluteURL(rawURL)
	if err != nil || parsed.User != nil {
		return false
	}
	origin, _, err := NormalizeOrigin(parsed.Scheme + "://" + parsed.Host)
	return err == nil && origin == canonical
}

func parseAbsoluteURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("公开来源不是合法 URL")
	}
	if parsed.Scheme == "" || parsed.Host == "" || parsed.Opaque != "" {
		return nil, errors.New("公开来源必须是绝对 URL")
	}
	return parsed, nil
}

func joinHostPort(host, port string) string {
	if strings.Contains(host, ":") {
		return net.JoinHostPort(host, port)
	}
	return host + ":" + port
}
