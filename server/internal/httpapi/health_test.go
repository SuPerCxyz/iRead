package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHealthEndpointsHealthy(t *testing.T) {
	env := newTestEnv(t)

	healthz := env.request(http.MethodGet, "/healthz", "", "")
	if healthz.Code != http.StatusOK {
		t.Fatalf("/healthz status = %d, body=%s", healthz.Code, healthz.Body.String())
	}
	assertCommonHeaders(t, healthz)
	var probe struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(healthz.Body.Bytes(), &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Status != "ok" || probe.Version != testVersion {
		t.Fatalf("/healthz = %+v", probe)
	}
	if strings.Contains(healthz.Body.String(), env.root) {
		t.Fatalf("/healthz 泄露路径: %s", healthz.Body.String())
	}

	apiHealth := env.request(http.MethodGet, "/api/v1/health", "", "")
	if apiHealth.Code != http.StatusOK {
		t.Fatalf("/api/v1/health status = %d, body=%s", apiHealth.Code, apiHealth.Body.String())
	}
	assertCommonHeaders(t, apiHealth)
	if got := apiHealth.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("health Cache-Control = %q", got)
	}
	status := decodeData[healthStatus](t, apiHealth)
	if status.Status != "ok" || status.Version != testVersion {
		t.Fatalf("/api/v1/health = %+v", status)
	}
}

func TestHealthEndpointsFailWhenDatabaseUnavailable(t *testing.T) {
	env := newTestEnv(t)
	if err := env.store.Close(); err != nil {
		t.Fatal(err)
	}

	healthz := env.request(http.MethodGet, "/healthz", "", "")
	if healthz.Code != http.StatusServiceUnavailable {
		t.Fatalf("/healthz status = %d", healthz.Code)
	}
	var probe struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(healthz.Body.Bytes(), &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Status != "unavailable" {
		t.Fatalf("/healthz = %s", healthz.Body.String())
	}
	if strings.Contains(healthz.Body.String(), env.root) {
		t.Fatalf("/healthz 泄露路径: %s", healthz.Body.String())
	}

	apiHealth := env.request(http.MethodGet, "/api/v1/health", "", "")
	if apiHealth.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/v1/health status = %d", apiHealth.Code)
	}
	errorBody := decodeAPIError(t, apiHealth)
	if errorBody.Error.Code != "storage_unavailable" {
		t.Fatalf("code = %q", errorBody.Error.Code)
	}
	if strings.Contains(apiHealth.Body.String(), env.root) {
		t.Fatalf("/api/v1/health 泄露路径: %s", apiHealth.Body.String())
	}
}

func TestHealthEndpointsFailWhenStorageDirectoryUnavailable(t *testing.T) {
	env := newTestEnv(t)
	if err := os.RemoveAll(env.dirs[2]); err != nil {
		t.Fatal(err)
	}

	healthz := env.request(http.MethodGet, "/healthz", "", "")
	if healthz.Code != http.StatusServiceUnavailable {
		t.Fatalf("/healthz status = %d", healthz.Code)
	}
	apiHealth := env.request(http.MethodGet, "/api/v1/health", "", "")
	if apiHealth.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/v1/health status = %d", apiHealth.Code)
	}
}

func TestHealthEndpointsFailWhenWebDirectoryMissing(t *testing.T) {
	env := newTestEnv(t)
	if err := os.RemoveAll(env.webDir); err != nil {
		t.Fatal(err)
	}

	healthz := env.request(http.MethodGet, "/healthz", "", "")
	if healthz.Code != http.StatusServiceUnavailable {
		t.Fatalf("/healthz status = %d", healthz.Code)
	}
	apiHealth := env.request(http.MethodGet, "/api/v1/health", "", "")
	if apiHealth.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/v1/health status = %d", apiHealth.Code)
	}
	if strings.Contains(healthz.Body.String(), env.root) || strings.Contains(apiHealth.Body.String(), env.root) {
		t.Fatal("健康检查响应泄露路径")
	}
}

func TestHealthEndpointsFailWhenWebShellMissingOrEmpty(t *testing.T) {
	for _, test := range []struct {
		name   string
		damage func(string) error
	}{
		{"缺失", func(path string) error { return os.Remove(path) }},
		{"空文件", func(path string) error { return os.WriteFile(path, nil, 0o600) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			env := newTestEnv(t)
			if err := test.damage(filepath.Join(env.webDir, "index.html")); err != nil {
				t.Fatal(err)
			}

			healthz := env.request(http.MethodGet, "/healthz", "", "")
			if healthz.Code != http.StatusServiceUnavailable {
				t.Fatalf("/healthz status = %d", healthz.Code)
			}
			if strings.Contains(healthz.Body.String(), env.root) {
				t.Fatalf("/healthz 泄露路径: %s", healthz.Body.String())
			}

			apiHealth := env.request(http.MethodGet, "/api/v1/health", "", "")
			if apiHealth.Code != http.StatusServiceUnavailable {
				t.Fatalf("/api/v1/health status = %d", apiHealth.Code)
			}
			errorBody := decodeAPIError(t, apiHealth)
			if errorBody.Error.Code != "storage_unavailable" {
				t.Fatalf("code = %q", errorBody.Error.Code)
			}
			if strings.Contains(apiHealth.Body.String(), env.root) {
				t.Fatalf("/api/v1/health 泄露路径: %s", apiHealth.Body.String())
			}
		})
	}
}
