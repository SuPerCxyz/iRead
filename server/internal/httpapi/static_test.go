package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestKnownClientRoutesServeIndex(t *testing.T) {
	env := newTestEnv(t)
	routes := []string{"/", "/library", "/settings", "/books/book-1", "/read/book-1"}
	for _, route := range routes {
		recorder := env.request(http.MethodGet, route, "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d", route, recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
			t.Fatalf("%s Content-Type = %q", route, got)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s Cache-Control = %q", route, got)
		}
		if !strings.Contains(recorder.Body.String(), "iread-index-marker") {
			t.Fatalf("%s 未返回 index", route)
		}
	}
}

func TestUnknownClientPathServesIndexWith404(t *testing.T) {
	env := newTestEnv(t)
	for _, route := range []string{"/nope", "/deep/unknown/path", "/books/a/b"} {
		recorder := env.request(http.MethodGet, route, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d", route, recorder.Code)
		}
		if !strings.Contains(recorder.Body.String(), "iread-index-marker") {
			t.Fatalf("%s 应返回 index 作为 404 页面", route)
		}
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
			t.Fatalf("%s Content-Type = %q", route, got)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("%s 404 Cache-Control = %q", route, got)
		}
	}
}

func TestUnknownAssetsAndAPINeverFallBackToSPA(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	for _, target := range []string{"/assets/missing.js", "/missing.js", "/nope.png", "/assets"} {
		recorder := env.request(http.MethodGet, target, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "iread-index-marker") {
			t.Fatalf("%s 错误地返回了 SPA", target)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("%s 404 Cache-Control = %q", target, got)
		}
	}

	api := env.request(http.MethodGet, "/api/v1/nope", "", "")
	if api.Code != http.StatusNotFound {
		t.Fatalf("API status = %d", api.Code)
	}
	if !strings.HasPrefix(api.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("API Content-Type = %q", api.Header().Get("Content-Type"))
	}
}

func TestStaticAssetHeaders(t *testing.T) {
	env := newTestEnv(t)

	asset := env.request(http.MethodGet, "/assets/app-123.js", "", "")
	if asset.Code != http.StatusOK {
		t.Fatalf("asset status = %d", asset.Code)
	}
	assertCommonHeaders(t, asset)
	if got := asset.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("asset Cache-Control = %q", got)
	}
	if got := asset.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
		t.Fatalf("asset Content-Type = %q", got)
	}
	if !strings.Contains(asset.Body.String(), "asset-marker") {
		t.Fatalf("asset body = %q", asset.Body.String())
	}

	serviceWorker := env.request(http.MethodGet, "/sw.js", "", "")
	if serviceWorker.Code != http.StatusOK {
		t.Fatalf("sw status = %d", serviceWorker.Code)
	}
	if got := serviceWorker.Header().Get("Service-Worker-Allowed"); got != "/" {
		t.Fatalf("Service-Worker-Allowed = %q", got)
	}
	if got := serviceWorker.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("sw Cache-Control = %q", got)
	}

	manifest := env.request(http.MethodGet, "/manifest.webmanifest", "", "")
	if manifest.Code != http.StatusOK {
		t.Fatalf("manifest status = %d", manifest.Code)
	}
	if got := manifest.Header().Get("Content-Type"); got != "application/manifest+json" {
		t.Fatalf("manifest Content-Type = %q", got)
	}
	if got := manifest.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("manifest Cache-Control = %q", got)
	}

	icon := env.request(http.MethodGet, "/icons/icon-192.png", "", "")
	if icon.Code != http.StatusOK {
		t.Fatalf("icon status = %d", icon.Code)
	}
	if got := icon.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("icon Cache-Control = %q", got)
	}

	// /assets/ 下即使文件名含 icon 仍是指纹资源，保持 immutable。
	hashedIcon := env.request(http.MethodGet, "/assets/icon-abc.png", "", "")
	if hashedIcon.Code != http.StatusOK {
		t.Fatalf("hashed icon status = %d", hashedIcon.Code)
	}
	if got := hashedIcon.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("hashed icon Cache-Control = %q", got)
	}

	for _, target := range []string{"/favicon.ico", "/apple-touch-icon.png"} {
		recorder := env.request(http.MethodGet, target, "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s Cache-Control = %q", target, got)
		}
	}
}

func TestStaticRangeAndHead(t *testing.T) {
	env := newTestEnv(t)

	request := httptest.NewRequest(http.MethodGet, "/assets/app-123.js", nil)
	request.Header.Set("Range", "bytes=0-3")
	recorder := httptest.NewRecorder()
	env.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusPartialContent {
		t.Fatalf("Range status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recordedRange := recorder.Header().Get("Content-Range"); !strings.HasPrefix(recordedRange, "bytes 0-3/") {
		t.Fatalf("Content-Range = %q", recordedRange)
	}
	if recorder.Body.String() != "cons" {
		t.Fatalf("Range body = %q", recorder.Body.String())
	}

	head := env.request(http.MethodHead, "/assets/app-123.js", "", "")
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d", head.Code)
	}
	if head.Body.Len() != 0 {
		t.Fatalf("HEAD body 应被省略，得到 %q", head.Body.String())
	}
	if head.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD 应返回 Content-Length")
	}

	indexHead := env.request(http.MethodHead, "/", "", "")
	if indexHead.Code != http.StatusOK || indexHead.Body.Len() != 0 {
		t.Fatalf("index HEAD status=%d body=%q", indexHead.Code, indexHead.Body.String())
	}
	if got := indexHead.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Fatalf("index HEAD Content-Type = %q", got)
	}

	for _, target := range []string{"/manifest.webmanifest", "/sw.js", "/icons/icon-192.png"} {
		head := env.request(http.MethodHead, target, "", "")
		if head.Code != http.StatusOK {
			t.Fatalf("%s HEAD status = %d", target, head.Code)
		}
		if head.Body.Len() != 0 {
			t.Fatalf("%s HEAD body 应为空", target)
		}
		if head.Header().Get("Content-Length") == "" {
			t.Fatalf("%s HEAD 缺少 Content-Length", target)
		}
	}
}

func TestActualWebDistIfPresent(t *testing.T) {
	dist, err := filepath.Abs(filepath.Join("..", "..", "..", "web", "dist"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
		t.Skipf("本机暂无真实 web/dist：%v", err)
	}

	env := newTestEnv(t)
	env.webDir = dist
	env.handler = env.newHandler()

	index := env.request(http.MethodGet, "/", "", "")
	if index.Code != http.StatusOK {
		t.Fatalf("真实 dist index status = %d", index.Code)
	}
	assets := regexp.MustCompile(`(?:src|href)="(/assets/[^"]+)"`).FindAllStringSubmatch(index.Body.String(), -1)
	if len(assets) == 0 {
		t.Fatal("真实 dist index 未引用 /assets 资源")
	}
	for _, match := range assets {
		recorder := env.request(http.MethodGet, match[1], "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("真实 dist 资源 %s status = %d", match[1], recorder.Code)
		}
	}
	for _, name := range []string{"/manifest.webmanifest", "/sw.js"} {
		if _, err := os.Stat(filepath.Join(dist, strings.TrimPrefix(name, "/"))); err != nil {
			t.Logf("真实 dist 暂无 %s，由 fixture 测试覆盖", name)
			continue
		}
		recorder := env.request(http.MethodGet, name, "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("真实 dist %s status = %d", name, recorder.Code)
		}
	}
}

func TestStaticPathTraversalDoesNotEscapeWebRoot(t *testing.T) {
	env := newTestEnv(t)
	secret := filepath.Join(env.root, "secret.txt")
	if err := os.WriteFile(secret, []byte("secret-marker"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{"/../secret.txt", "/assets/../secret.txt", "/assets/%2e%2e/secret.txt"} {
		recorder := env.request(http.MethodGet, target, "", "")
		if recorder.Code == http.StatusOK {
			t.Fatalf("%s 不应成功返回", target)
		}
		if strings.Contains(recorder.Body.String(), "secret-marker") {
			t.Fatalf("%s 泄露了 Web 根外文件", target)
		}
	}
}

func TestEmptyIndexReturns404ForClientRoutes(t *testing.T) {
	env := newTestEnv(t)
	if err := os.WriteFile(filepath.Join(env.webDir, "index.html"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	routes := []string{"/", "/library", "/settings", "/books/x", "/read/x", "/index.html"}
	for _, route := range routes {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			recorder := env.request(method, route, "", "")
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("%s %s status = %d，期望 404", method, route, recorder.Code)
			}
			if recorder.Code == http.StatusOK {
				t.Fatalf("%s %s 返回了 200", method, route)
			}
			if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("%s %s Cache-Control = %q", method, route, got)
			}
			if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/plain") {
				t.Fatalf("%s %s Content-Type = %q", method, route, got)
			}
			if got := recorder.Header().Get("Content-Length"); got != "19" {
				t.Fatalf("%s %s Content-Length = %q", method, route, got)
			}
			if method == http.MethodGet && recorder.Body.String() != "404 page not found\n" {
				t.Fatalf("%s 404 body = %q", route, recorder.Body.String())
			}
			if method == http.MethodHead && recorder.Body.Len() != 0 {
				t.Fatalf("%s HEAD body 应为空，得到 %q", route, recorder.Body.String())
			}
		}
	}
}

func TestMissingIndexReturns404ForClientRoutes(t *testing.T) {
	env := newTestEnv(t)
	if err := os.Remove(filepath.Join(env.webDir, "index.html")); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/", "/library", "/settings", "/books/x", "/read/x", "/index.html"} {
		recorder := env.request(http.MethodGet, route, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d，期望 404", route, recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "iread-index-marker") {
			t.Fatalf("%s 不应返回 SPA index", route)
		}
	}
}

func TestStaticNoDirectoryListing(t *testing.T) {
	env := newTestEnv(t)
	for _, target := range []string{"/", "/icons/", "/assets/"} {
		recorder := env.request(http.MethodGet, target, "", "")
		if target == "/" {
			if recorder.Code != http.StatusOK {
				t.Fatalf("/ status = %d", recorder.Code)
			}
			continue
		}
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
	}
}
