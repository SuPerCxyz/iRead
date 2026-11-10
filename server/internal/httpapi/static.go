package httpapi

import (
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var (
	knownBookRoute = regexp.MustCompile(`^/books/[^/]+$`)
	knownReadRoute = regexp.MustCompile(`^/read/[^/]+$`)
)

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, errorEnvelope{Error: errorPayload{
			Code:      "invalid_request",
			Message:   "请求方法不支持",
			RequestID: requestIDFromRequest(r),
			Details:   struct{}{},
		}})
		return
	}

	urlPath := path.Clean(r.URL.Path)
	if !strings.HasPrefix(urlPath, "/") {
		urlPath = "/" + urlPath
	}

	if urlPath == "/" || urlPath == "/library" || urlPath == "/settings" ||
		knownBookRoute.MatchString(urlPath) || knownReadRoute.MatchString(urlPath) {
		s.serveIndex(w, r, http.StatusOK)
		return
	}

	if s.serveStaticFile(w, r, urlPath) {
		return
	}

	if urlPath == "/assets" || strings.HasPrefix(urlPath, "/assets/") || path.Ext(urlPath) != "" {
		s.staticNotFound(w, r)
		return
	}

	// 未知客户端路径：返回 index.html 但保持 404，由前端渲染 404 页面。
	s.serveIndex(w, r, http.StatusNotFound)
}

func (s *Server) serveStaticFile(w http.ResponseWriter, r *http.Request, urlPath string) bool {
	relative := strings.TrimPrefix(urlPath, "/")
	if relative == "" {
		return false
	}

	root, err := os.OpenRoot(s.webDir)
	if err != nil {
		return false
	}
	defer root.Close()

	file, err := root.Open(filepath.FromSlash(relative))
	if err != nil {
		return false
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if info.Size() == 0 && urlPath == "/index.html" {
		return false
	}

	switch {
	case strings.HasSuffix(urlPath, ".webmanifest"):
		w.Header().Set("Content-Type", "application/manifest+json")
	case strings.HasSuffix(urlPath, ".js"):
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	}
	if urlPath == "/sw.js" {
		w.Header().Set("Service-Worker-Allowed", "/")
	}
	w.Header().Set("Cache-Control", staticCacheControl(urlPath))

	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	return true
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request, status int) {
	root, err := os.OpenRoot(s.webDir)
	if err != nil {
		s.staticNotFound(w, r)
		return
	}
	defer root.Close()

	file, err := root.Open("index.html")
	if err != nil {
		s.staticNotFound(w, r)
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		s.staticNotFound(w, r)
		return
	}

	cacheControl := "no-cache"
	if status != http.StatusOK {
		cacheControl = "no-store"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, file)
	}
}

func (s *Server) staticNotFound(w http.ResponseWriter, r *http.Request) {
	const body = "404 page not found\n"
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusNotFound)
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, body)
	}
}

func staticCacheControl(urlPath string) string {
	base := strings.ToLower(path.Base(urlPath))
	if urlPath == "/sw.js" ||
		urlPath == "/manifest.webmanifest" ||
		urlPath == "/index.html" ||
		strings.HasPrefix(urlPath, "/icons/") ||
		strings.HasPrefix(base, "favicon") ||
		strings.HasPrefix(base, "apple-touch") {
		return "no-cache"
	}
	if strings.HasPrefix(urlPath, "/assets/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}
