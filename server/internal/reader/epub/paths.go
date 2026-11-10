package epub

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"
	"unicode/utf16"
)

const (
	maxContainerBytes  = 1 << 20
	maxPackageBytes    = 8 << 20
	maxTOCBytes        = 8 << 20
	maxEncryptionBytes = 1 << 20
	maxTOCEntries      = 5000
)

var (
	errInvalidReference = errors.New("epub: invalid archive reference")
	errUnsafePath       = errors.New("epub: unsafe archive path")
)

// normalizeArchiveRef 把 baseDir 内的 EPUB 相对引用解析为规范化归档路径。
// 规则与 jobs/epub.resolveArchiveRef 保持一致：拒绝外部 URI、绝对路径、
// 反斜杠开头、盘符、NUL 与越界 ".."；返回的路径不带 fragment。
func normalizeArchiveRef(baseDir, href string) (archivePath, fragment string, err error) {
	href = strings.TrimSpace(href)
	if href == "" || strings.ContainsRune(href, 0) {
		return "", "", errInvalidReference
	}
	if strings.Contains(href, "://") || strings.HasPrefix(href, "//") {
		return "", "", errInvalidReference
	}
	if strings.HasPrefix(href, "/") || strings.HasPrefix(href, `\`) {
		return "", "", errInvalidReference
	}
	if len(href) >= 2 && isASCIILetter(href[0]) && href[1] == ':' {
		return "", "", errInvalidReference
	}

	pathPart := href
	if index := strings.IndexByte(pathPart, '#'); index >= 0 {
		fragment = pathPart[index+1:]
		pathPart = pathPart[:index]
	}
	if index := strings.IndexByte(pathPart, '?'); index >= 0 {
		pathPart = pathPart[:index]
	}
	if pathPart == "" {
		return "", fragment, errInvalidReference
	}
	if decoded, decodeErr := url.PathUnescape(pathPart); decodeErr == nil {
		pathPart = decoded
	}
	if strings.ContainsRune(pathPart, 0) {
		return "", "", errInvalidReference
	}
	joined := path.Clean(path.Join(baseDir, pathPart))
	if joined == "." || joined == "" || joined == ".." ||
		strings.HasPrefix(joined, "../") || strings.HasPrefix(joined, "/") {
		return "", "", errInvalidReference
	}
	return joined, fragment, nil
}

// normalizeTOCRef 与 normalizeArchiveRef 相同，但允许只有 fragment 的目录项：
// 它指向目录文档自身。
func normalizeTOCRef(baseFile, href string) (archivePath, fragment string, err error) {
	href = strings.TrimSpace(href)
	if href == "" || strings.ContainsRune(href, 0) {
		return "", "", errInvalidReference
	}
	if strings.HasPrefix(href, "#") {
		return baseFile, href[1:], nil
	}
	return normalizeArchiveRef(archiveDir(baseFile), href)
}

// normalizeZipEntryName 返回 ZIP 条目的规范化归档路径。目录、绝对路径、
// 盘符、NUL 与越界条目返回 ok=false。
func normalizeZipEntryName(name string) (string, bool) {
	if name == "" || strings.ContainsRune(name, 0) || strings.HasSuffix(name, "/") {
		return "", false
	}
	if strings.HasPrefix(name, "/") || strings.HasPrefix(name, `\`) {
		return "", false
	}
	if len(name) >= 2 && isASCIILetter(name[0]) && name[1] == ':' {
		return "", false
	}
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") ||
		strings.HasPrefix(cleaned, "/") {
		return "", false
	}
	return cleaned, true
}

// validNormalizedArchivePath 校验服务端 manifest 中保存的 href，避免把
// 客户端输入或损坏记录当成路径使用。
func validNormalizedArchivePath(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsRune(value, 0) {
		return false
	}
	if strings.ContainsAny(value, `?#\`) || strings.HasPrefix(value, "/") {
		return false
	}
	if len(value) >= 2 && isASCIILetter(value[0]) && value[1] == ':' {
		return false
	}
	cleaned := path.Clean(value)
	return cleaned == value && cleaned != "." && cleaned != ".." &&
		!strings.HasPrefix(cleaned, "../")
}

func archiveDir(archivePath string) string {
	dir := path.Dir(archivePath)
	if dir == "." || dir == "/" {
		return ""
	}
	return dir
}

func isASCIILetter(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
}

// canonicalMediaType 返回资源端点允许输出的 Content-Type 基类型。白名单
// 外的类型返回 ok=false，资源端点按不存在处理。
func canonicalMediaType(declared, archivePath string) (string, bool) {
	base := normalizeMediaType(declared)
	switch base {
	case "application/xhtml+xml", "text/html", "application/html+xml":
		return "application/xhtml+xml", true
	case "text/css":
		return "text/css", true
	case "image/jpeg", "image/jpg":
		return "image/jpeg", true
	case "image/png":
		return "image/png", true
	case "image/gif":
		return "image/gif", true
	case "image/svg+xml":
		return "image/svg+xml", true
	case "font/woff", "application/font-woff", "application/x-font-woff":
		return "font/woff", true
	case "font/woff2", "application/font-woff2", "application/x-font-woff2":
		return "font/woff2", true
	case "font/ttf", "application/x-font-ttf", "application/x-font-truetype":
		return "font/ttf", true
	case "font/otf", "application/vnd.ms-opentype", "application/x-font-opentype",
		"application/x-font-otf":
		return "font/otf", true
	case "application/font-sfnt":
		return inferMediaType(archivePath)
	}
	if base == "" || base == "application/octet-stream" || base == "binary/octet-stream" {
		return inferMediaType(archivePath)
	}
	return "", false
}

func inferMediaType(archivePath string) (string, bool) {
	switch strings.ToLower(path.Ext(archivePath)) {
	case ".xhtml", ".xht", ".html", ".htm":
		return "application/xhtml+xml", true
	case ".css":
		return "text/css", true
	case ".jpg", ".jpeg", ".jpe":
		return "image/jpeg", true
	case ".png":
		return "image/png", true
	case ".gif":
		return "image/gif", true
	case ".svg", ".svgz":
		return "image/svg+xml", true
	case ".woff":
		return "font/woff", true
	case ".woff2":
		return "font/woff2", true
	case ".ttf", ".ttc":
		return "font/ttf", true
	case ".otf":
		return "font/otf", true
	default:
		return "", false
	}
}

func normalizeMediaType(value string) string {
	value = strings.TrimSpace(value)
	if index := strings.IndexByte(value, ';'); index >= 0 {
		value = value[:index]
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func isFontMediaType(mediaType, archivePath string) bool {
	if strings.HasPrefix(normalizeMediaType(mediaType), "font/") {
		return true
	}
	switch normalizeMediaType(mediaType) {
	case "application/font-woff", "application/x-font-woff",
		"application/font-woff2", "application/x-font-woff2",
		"application/x-font-ttf", "application/x-font-truetype",
		"application/vnd.ms-opentype", "application/x-font-opentype",
		"application/x-font-otf", "application/font-sfnt":
		return true
	}
	switch strings.ToLower(path.Ext(archivePath)) {
	case ".ttf", ".otf", ".woff", ".woff2", ".ttc":
		return true
	default:
		return false
	}
}

func hasToken(value, token string) bool {
	for _, field := range strings.Fields(value) {
		if field == token {
			return true
		}
	}
	return false
}

func firstTrimmed(values []string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func decodeStrictXML(data []byte, target any) error {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	decoder.CharsetReader = charsetReader
	return decoder.Decode(target)
}

func decodeXHTML(data []byte, target any) error {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = false
	decoder.AutoClose = xml.HTMLAutoClose
	decoder.Entity = xml.HTMLEntity
	decoder.CharsetReader = charsetReader
	return decoder.Decode(target)
}

// charsetReader 只支持 EPUB 常见编码；Go 标准库不会下载外部实体或 DTD。
func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	data, err := io.ReadAll(io.LimitReader(input, maxPackageBytes))
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "", "utf-8", "utf8":
		return bytes.NewReader(data), nil
	case "utf-16", "utf16":
		bigEndian := true
		if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
			bigEndian = false
			data = data[2:]
		} else if len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF {
			data = data[2:]
		}
		return strings.NewReader(decodeUTF16(data, bigEndian)), nil
	case "utf-16le":
		if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
			data = data[2:]
		}
		return strings.NewReader(decodeUTF16(data, false)), nil
	case "utf-16be":
		if len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF {
			data = data[2:]
		}
		return strings.NewReader(decodeUTF16(data, true)), nil
	case "iso-8859-1", "latin1", "latin-1":
		runes := make([]rune, len(data))
		for index, value := range data {
			runes[index] = rune(value)
		}
		return strings.NewReader(string(runes)), nil
	default:
		return nil, fmt.Errorf("epub: unsupported XML charset %q", charset)
	}
}

func decodeUTF16(raw []byte, bigEndian bool) string {
	if len(raw)%2 != 0 {
		raw = raw[:len(raw)-1]
	}
	units := make([]uint16, 0, len(raw)/2)
	for index := 0; index+1 < len(raw); index += 2 {
		if bigEndian {
			units = append(units, uint16(raw[index])<<8|uint16(raw[index+1]))
		} else {
			units = append(units, uint16(raw[index+1])<<8|uint16(raw[index]))
		}
	}
	return strings.TrimRight(string(utf16.Decode(units)), "\x00")
}
