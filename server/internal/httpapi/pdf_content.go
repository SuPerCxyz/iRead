package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"iread/server/internal/reader/pdf"
)

// PDFContentPath 是 PDF 原件流端点，与 pdf.ContentPath 保持一致。
const PDFContentPath = pdf.ContentPath

// PDFContentOptions 构造 PDF 原件 HTTP 处理器。
type PDFContentOptions struct {
	Resolver    pdf.Resolver
	BooksDir    string
	Logger      *slog.Logger
	RequireAuth Middleware
}

// PDFContentHandler 在统一认证门禁后提供 PDF GET/HEAD 原件流。
type PDFContentHandler struct {
	content     *pdf.Handler
	requireAuth Middleware
}

// NewPDFContentHandler 构造处理器；缺失认证依赖时 fail closed。
func NewPDFContentHandler(options PDFContentOptions) (*PDFContentHandler, error) {
	if options.Resolver == nil {
		return nil, errors.New("httpapi: PDF resolver 不能为空")
	}
	content, err := pdf.NewHandler(pdf.Options{
		Resolver: options.Resolver,
		BooksDir: options.BooksDir,
		Logger:   options.Logger,
	})
	if err != nil {
		return nil, err
	}
	return &PDFContentHandler{
		content:     content,
		requireAuth: options.RequireAuth,
	}, nil
}

// RegisterPDFRoutes 注册 GET/HEAD 原件流路由。该模式比书库的
// /api/v1/books/ 前缀更具体，ServeMux 会优先匹配本端点。
func (h *PDFContentHandler) RegisterPDFRoutes(mux *http.ServeMux) {
	if h == nil || mux == nil {
		return
	}
	mux.Handle(PDFContentPath, h)
}

// RegisterPDFRoutes 是包级包装，便于集成方按函数名接线。
func RegisterPDFRoutes(mux *http.ServeMux, handlers *PDFContentHandler) {
	if handlers != nil {
		handlers.RegisterPDFRoutes(mux)
	}
}

// ServeHTTP 执行认证后交给原件处理器；GET/HEAD 不需要 CSRF。
func (h *PDFContentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodHead {
		w = &headResponseWriter{ResponseWriter: w}
	}
	if h == nil || h.content == nil {
		writePDFUnauthenticated(w, r)
		return
	}
	if h.requireAuth == nil {
		writePDFUnauthenticated(w, r)
		return
	}
	h.requireAuth(http.HandlerFunc(h.content.ServeHTTP)).ServeHTTP(w, r)
}

func writePDFUnauthenticated(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusUnauthorized, errorEnvelope{Error: errorPayload{
		Code:      "unauthenticated",
		Message:   "请先登录",
		RequestID: requestIDFromRequest(r),
		Details:   struct{}{},
	}})
}

// headResponseWriter 保证 HEAD 在测试或中间件直接调用时也没有 body；
// 真实 net/http 服务也会丢弃 HEAD body，这里不依赖该行为。
type headResponseWriter struct {
	http.ResponseWriter
}

func (w *headResponseWriter) Write(body []byte) (int, error) {
	return len(body), nil
}

// Unwrap 允许 http.ResponseController 访问底层 ResponseWriter。
func (w *headResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}
