package httpapi

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"iread/server/internal/reader/epub/epubtest"
)

const (
	wantReaderResourceSandboxCSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
	readerTrapSVGPath            = "OEBPS/Images/trap.svg"
)

// newReaderScriptableSample 生成含 <script>、onerror 与 SVG script 的真实 EPUB。
// 资源仍然通过正常 manifest 登记，测试直接请求这些资源验证顶层打开时的响应头。
func newReaderScriptableSample(t *testing.T) (*epubtest.Sample, map[string][]byte) {
	t.Helper()
	sample, err := epubtest.Build(epubtest.Options{Version: 3})
	if err != nil {
		t.Fatalf("生成 EPUB 样本失败: %v", err)
	}
	payloads := map[string][]byte{
		sample.ChapterPaths[0]: []byte(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Trap</title>
<script>fetch('/api/v1/books').then((response) => response.text())</script></head>
<body onload="fetch('/api/v1/auth/status')"><p id="trap">script payload</p>
<img src="missing.png" onerror="fetch('/api/v1/books')"/></body></html>`),
		readerTrapSVGPath: []byte(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="fetch('/api/v1/books')">
<script>fetch('/api/v1/books')</script>
<image href="missing.png" onerror="fetch('/api/v1/auth/status')"/>
<rect width="10" height="10"/>
</svg>`),
	}
	sample.Data = rewriteReaderSecurityEPUB(t, sample.Data, payloads, map[string][]byte{
		readerTrapSVGPath: payloads[readerTrapSVGPath],
	})
	sample.ChapterData[0] = payloads[sample.ChapterPaths[0]]
	return sample, payloads
}

// rewriteReaderSecurityEPUB 替换资源并追加 SVG 条目，同时在 OPF manifest 中
// 登记 SVG，让 manifest 构建器按真实 EPUB 规则接受它。
func rewriteReaderSecurityEPUB(t *testing.T, data []byte, replacements, additions map[string][]byte) []byte {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("读取测试 EPUB 失败: %v", err)
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatalf("打开测试 EPUB 条目 %s 失败: %v", file.Name, err)
		}
		content, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			t.Fatalf("读取测试 EPUB 条目 %s 失败: %v", file.Name, err)
		}
		if replacement, found := replacements[file.Name]; found {
			content = replacement
		}
		if file.Name == "OEBPS/content.opf" {
			if !bytes.Contains(content, []byte("</manifest>")) {
				t.Fatal("测试 EPUB 的 OPF 缺少 manifest 结束标签")
			}
			content = bytes.Replace(content, []byte("</manifest>"),
				[]byte("\n    <item id=\"trap-svg\" href=\"Images/trap.svg\" media-type=\"image/svg+xml\"/>\n  </manifest>"), 1)
		}
		header := &zip.FileHeader{Name: file.Name, Method: file.Method, Modified: file.Modified}
		header.SetMode(file.Mode())
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("写入测试 EPUB 条目 %s 失败: %v", file.Name, err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatalf("写入测试 EPUB 条目 %s 失败: %v", file.Name, err)
		}
	}
	for name, content := range additions {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0o644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("追加测试 EPUB 条目 %s 失败: %v", name, err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatalf("追加测试 EPUB 条目 %s 失败: %v", name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭测试 EPUB 失败: %v", err)
	}
	return buffer.Bytes()
}

func TestReaderResourceScriptableContentIsSandboxed(t *testing.T) {
	sample, payloads := newReaderScriptableSample(t)
	env := newReaderManifestSampleEnvMode(t, sample, false)
	manifest := decodeReaderManifest(t, env.request(http.MethodGet, env.manifestURL()))

	for _, testCase := range []struct {
		href        string
		contentType string
	}{
		{href: sample.ChapterPaths[0], contentType: "application/xhtml+xml"},
		{href: readerTrapSVGPath, contentType: "image/svg+xml"},
	} {
		resourceID := readerManifestResourceID(manifest, testCase.href)
		if resourceID == "" {
			t.Fatalf("manifest 缺少资源 %s", testCase.href)
		}
		get := env.request(http.MethodGet, env.resourceURL(resourceID))
		if get.Code != http.StatusOK {
			t.Fatalf("%s GET status = %d，body=%s", testCase.href, get.Code, get.Body.String())
		}
		if got := get.Header().Get("Content-Type"); got != testCase.contentType {
			t.Fatalf("%s Content-Type = %q", testCase.href, got)
		}
		if got := get.Header().Get("Content-Security-Policy"); got != wantReaderResourceSandboxCSP {
			t.Fatalf("%s CSP = %q", testCase.href, got)
		}
		if !strings.Contains(get.Header().Get("Content-Security-Policy"), "sandbox") ||
			!strings.Contains(get.Header().Get("Content-Security-Policy"), "script-src 'none'") {
			t.Fatalf("%s CSP 缺少 sandbox/script-src none: %q", testCase.href,
				get.Header().Get("Content-Security-Policy"))
		}
		if got := get.Header().Get("Content-Disposition"); got != "inline" {
			t.Fatalf("%s Content-Disposition = %q", testCase.href, got)
		}
		if got := get.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s nosniff = %q", testCase.href, got)
		}
		if got := get.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("%s Cache-Control = %q", testCase.href, got)
		}
		if !bytes.Equal(get.Body.Bytes(), payloads[testCase.href]) {
			t.Fatalf("%s 资源字节被改变", testCase.href)
		}
		if !bytes.Contains(get.Body.Bytes(), []byte("<script>")) {
			t.Fatalf("%s 测试载荷应包含 script", testCase.href)
		}

		head := env.request(http.MethodHead, env.resourceURL(resourceID))
		if head.Code != http.StatusOK || head.Body.Len() != 0 {
			t.Fatalf("%s HEAD status=%d body=%q", testCase.href, head.Code, head.Body.String())
		}
		for _, name := range []string{
			"Content-Type", "Content-Length", "Content-Disposition",
			"Content-Security-Policy", "X-Content-Type-Options", "Cache-Control",
		} {
			if got, want := head.Header().Get(name), get.Header().Get(name); got != want {
				t.Fatalf("%s HEAD %s = %q，GET = %q", testCase.href, name, got, want)
			}
		}
	}
}

func TestReaderResourceBinaryAndFontHeadersStayCompatible(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 3})
	manifest := decodeReaderManifest(t, env.request(http.MethodGet, env.manifestURL()))

	for _, testCase := range []struct {
		href        string
		contentType string
		payload     []byte
	}{
		{href: env.sample.ImagePath, contentType: "image/png", payload: env.sample.ImageData},
		{href: env.sample.FontPath, contentType: "font/otf", payload: env.sample.FontPlain},
	} {
		resourceID := readerManifestResourceID(manifest, testCase.href)
		if resourceID == "" {
			t.Fatalf("manifest 缺少资源 %s", testCase.href)
		}
		recorder := env.request(http.MethodGet, env.resourceURL(resourceID))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d", testCase.href, recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); got != testCase.contentType {
			t.Fatalf("%s Content-Type = %q", testCase.href, got)
		}
		if got := recorder.Header().Get("Content-Disposition"); got != "inline" {
			t.Fatalf("%s Content-Disposition = %q", testCase.href, got)
		}
		if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s nosniff = %q", testCase.href, got)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("%s Cache-Control = %q", testCase.href, got)
		}
		if got := recorder.Header().Get("Content-Security-Policy"); got != "" {
			t.Fatalf("%s 非脚本资源不应附加 CSP，得到 %q", testCase.href, got)
		}
		if !bytes.Equal(recorder.Body.Bytes(), testCase.payload) {
			t.Fatalf("%s 资源字节被改变", testCase.href)
		}
	}
}

func TestReaderResourceSecurityHeadersClassifyContentTypes(t *testing.T) {
	for _, contentType := range []string{
		"application/xhtml+xml",
		"text/html",
		"text/html; charset=utf-8",
		"application/html+xml",
		"image/svg+xml",
	} {
		recorder := httptest.NewRecorder()
		setReaderResourceSecurityHeaders(recorder, contentType)
		if got := recorder.Header().Get("Content-Security-Policy"); got != wantReaderResourceSandboxCSP {
			t.Fatalf("%s CSP = %q", contentType, got)
		}
		if got := recorder.Header().Get("Content-Disposition"); got != "inline" {
			t.Fatalf("%s Content-Disposition = %q", contentType, got)
		}
		if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s nosniff = %q", contentType, got)
		}
	}
	for _, contentType := range []string{"text/css", "image/png", "font/otf"} {
		recorder := httptest.NewRecorder()
		setReaderResourceSecurityHeaders(recorder, contentType)
		if got := recorder.Header().Get("Content-Security-Policy"); got != "" {
			t.Fatalf("%s 不应附加 CSP，得到 %q", contentType, got)
		}
		if got := recorder.Header().Get("Content-Disposition"); got != "inline" {
			t.Fatalf("%s Content-Disposition = %q", contentType, got)
		}
	}
}

func TestReaderResourceSecurityHeadersDoNotChangeAuthAndVersionErrors(t *testing.T) {
	sample, _ := newReaderScriptableSample(t)
	env := newReaderManifestSampleEnvMode(t, sample, false)
	manifest := decodeReaderManifest(t, env.request(http.MethodGet, env.manifestURL()))
	resourceID := readerManifestResourceID(manifest, sample.ChapterPaths[0])
	if resourceID == "" {
		t.Fatal("manifest 缺少章节资源")
	}

	noAuthMux := http.NewServeMux()
	env.noAuth.RegisterReaderManifestRoutes(noAuthMux)
	unauth := httptest.NewRecorder()
	noAuthMux.ServeHTTP(unauth, httptest.NewRequest(http.MethodGet, env.resourceURL(resourceID), nil))
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("未认证资源 status = %d，body=%s", unauth.Code, unauth.Body.String())
	}
	if got := unauth.Header().Get("Content-Security-Policy"); got != "" {
		t.Fatalf("未认证响应不应带资源 CSP，得到 %q", got)
	}
	if got := unauth.Header().Get("Content-Disposition"); got != "" {
		t.Fatalf("未认证响应不应带 Content-Disposition，得到 %q", got)
	}

	oldVersion := strings.Repeat("0", 64)
	if oldVersion == env.fileVersion {
		oldVersion = strings.Repeat("1", 64)
	}
	old := env.request(http.MethodGet,
		"/api/v1/books/"+env.bookID+"/versions/"+oldVersion+"/resources/"+resourceID)
	if old.Code != http.StatusConflict {
		t.Fatalf("旧 fileVersion status = %d，body=%s", old.Code, old.Body.String())
	}
	if got := old.Header().Get("Content-Security-Policy"); got != "" {
		t.Fatalf("旧版本响应不应带资源 CSP，得到 %q", got)
	}
	if got := old.Header().Get("Content-Disposition"); got != "" {
		t.Fatalf("旧版本响应不应带 Content-Disposition，得到 %q", got)
	}
}
