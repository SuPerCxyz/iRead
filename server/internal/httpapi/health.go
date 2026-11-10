package httpapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"
)

const healthCheckTimeout = 3 * time.Second

type healthStatus struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, r, "GET")
		return
	}
	w.Header().Set("Cache-Control", "no-store")

	ctx, cancel := context.WithTimeout(r.Context(), healthCheckTimeout)
	defer cancel()
	if err := s.checkHealth(ctx); err != nil {
		s.logger.Warn("健康检查失败", "error", err, "requestId", requestIDFromRequest(r))
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, healthStatus{Status: "ok", Version: s.version})
}

func (s *Server) handleAPIHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, r, "GET")
		return
	}
	w.Header().Set("Cache-Control", "no-store")

	ctx, cancel := context.WithTimeout(r.Context(), healthCheckTimeout)
	defer cancel()
	if err := s.checkHealth(ctx); err != nil {
		s.logger.Warn("健康检查失败", "error", err, "requestId", requestIDFromRequest(r))
		s.writeAPIError(w, r, http.StatusServiceUnavailable, "storage_unavailable", "存储不可用", nil)
		return
	}
	s.writeData(w, http.StatusOK, healthStatus{Status: "ok", Version: s.version})
}

// checkHealth 真实检查数据库、Web Shell 与三个存储目录可写，不依赖进程仍存活。
func (s *Server) checkHealth(ctx context.Context) error {
	if err := s.store.Check(ctx); err != nil {
		return err
	}
	if err := s.checkWebShell(); err != nil {
		return err
	}
	for _, dir := range s.storageDirs {
		file, err := os.CreateTemp(dir, ".iread-health-*")
		if err != nil {
			return err
		}
		name := file.Name()
		if err := file.Close(); err != nil {
			_ = os.Remove(name)
			return err
		}
		if err := os.Remove(name); err != nil {
			return err
		}
	}
	return nil
}

// checkWebShell 确认 Web 构建产物入口存在且可读，缺失/空文件视为不可用。
func (s *Server) checkWebShell() error {
	root, err := os.OpenRoot(s.webDir)
	if err != nil {
		return err
	}
	defer root.Close()

	file, err := root.Open("index.html")
	if err != nil {
		return err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return errors.New("web shell 无效")
	}
	return nil
}
