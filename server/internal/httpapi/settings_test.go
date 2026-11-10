package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"iread/server/internal/settings"
)

func TestGetAppearanceReturnsDefaultWithoutRow(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	record := decodeData[settings.AppearanceRecord](t, recorder)
	if record.SchemaVersion != 1 || record.Revision != "0" || record.UpdatedAt != nil {
		t.Fatalf("默认记录 = %+v", record)
	}
	if record.Value != settings.DefaultAppearanceValue() {
		t.Fatalf("默认值 = %+v", record.Value)
	}
}

func TestPutAppearanceIncrementsRevision(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	recorder := env.request(http.MethodPut, "/api/v1/settings/appearance",
		validPutBody("0", "#3366cc"), "application/json; charset=utf-8")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	created := decodeData[settings.AppearanceRecord](t, recorder)
	if created.Revision != "1" || created.UpdatedAt == nil {
		t.Fatalf("首次写入 = %+v", created)
	}
	if _, err := time.Parse(time.RFC3339, *created.UpdatedAt); err != nil {
		t.Fatalf("updatedAt 不是 RFC3339: %q", *created.UpdatedAt)
	}
	if created.Value.ThemeMode != "dark" || created.Value.Accent != "#3366cc" ||
		created.Value.ContentWidth.Percent != 80 || !created.Value.NavCompact {
		t.Fatalf("首次写入值 = %+v", created.Value)
	}

	second := strings.Replace(validPutBody("1", "default"), `"themeMode":"dark"`, `"themeMode":"light"`, 1)
	recorder = env.request(http.MethodPut, "/api/v1/settings/appearance", second, "application/json")
	if recorder.Code != http.StatusOK {
		t.Fatalf("第二次 PUT status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	updated := decodeData[settings.AppearanceRecord](t, recorder)
	if updated.Revision != "2" || updated.Value.ThemeMode != "light" || updated.Value.Accent != "default" {
		t.Fatalf("第二次写入 = %+v", updated)
	}

	recorder = env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	got := decodeData[settings.AppearanceRecord](t, recorder)
	if got.Revision != "2" || got.Value.ThemeMode != "light" || got.UpdatedAt == nil {
		t.Fatalf("GET = %+v", got)
	}
}

func TestPutAppearanceRevisionConflict(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	first := env.request(http.MethodPut, "/api/v1/settings/appearance",
		validPutBody("0", "default"), "application/json")
	if first.Code != http.StatusOK {
		t.Fatalf("首次 PUT status = %d", first.Code)
	}
	firstRecord := decodeData[settings.AppearanceRecord](t, first)

	stale := strings.Replace(validPutBody("0", "blue"), `"themeMode":"dark"`, `"themeMode":"light"`, 1)
	recorder := env.request(http.MethodPut, "/api/v1/settings/appearance", stale, "application/json")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	errorBody := decodeAPIError(t, recorder)
	if errorBody.Error.Code != "revision_conflict" {
		t.Fatalf("code = %q", errorBody.Error.Code)
	}
	if errorBody.Error.Message != "设置已在另一处更新" {
		t.Fatalf("message = %q", errorBody.Error.Message)
	}
	if errorBody.Error.RequestID != recorder.Header().Get("X-Request-Id") {
		t.Fatalf("错误体 requestId 与响应头不一致")
	}
	var details struct {
		Current settings.AppearanceRecord `json:"current"`
	}
	if err := json.Unmarshal(errorBody.Error.Details, &details); err != nil {
		t.Fatalf("解析 details 失败: %v", err)
	}
	if details.Current.Revision != firstRecord.Revision || details.Current.Value.ThemeMode != "dark" {
		t.Fatalf("details.current = %+v", details.Current)
	}

	recorder = env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	got := decodeData[settings.AppearanceRecord](t, recorder)
	if got.Revision != "1" || got.Value.ThemeMode != "dark" || got.Value.Accent != "default" {
		t.Fatalf("冲突后记录被改写: %+v", got)
	}
	if got.UpdatedAt == nil || *got.UpdatedAt != *firstRecord.UpdatedAt {
		t.Fatalf("冲突后 updatedAt 变化: %v -> %v", firstRecord.UpdatedAt, got.UpdatedAt)
	}
}

func TestPutAppearanceValidation(t *testing.T) {
	valid := validPutBody("0", "default")
	tests := []struct {
		name string
		body string
	}{
		{"空对象", `{}`},
		{"schemaVersion 缺失", strings.Replace(valid, `"schemaVersion":1,`, "", 1)},
		{"schemaVersion 错误", strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":2`, 1)},
		{"baseRevision 缺失", strings.Replace(valid, `"baseRevision":"0",`, "", 1)},
		{"baseRevision 前导零", strings.Replace(valid, `"baseRevision":"0"`, `"baseRevision":"01"`, 1)},
		{"baseRevision 负数", strings.Replace(valid, `"baseRevision":"0"`, `"baseRevision":"-1"`, 1)},
		{"baseRevision 数字", strings.Replace(valid, `"baseRevision":"0"`, `"baseRevision":0`, 1)},
		{"value 缺失", `{"schemaVersion":1,"baseRevision":"0"}`},
		{"顶层未知字段", strings.Replace(valid, `{`, `{"extra":1,`, 1)},
		{"value 未知字段", strings.Replace(valid, `"navCompact":true`, `"navCompact":true,"extra":1`, 1)},
		{"themeMode 缺失", strings.Replace(valid, `"themeMode":"dark",`, "", 1)},
		{"themeMode 非法", strings.Replace(valid, `"themeMode":"dark"`, `"themeMode":"sepia"`, 1)},
		{"lightPreset 非法", strings.Replace(valid, `"lightPreset":"paper"`, `"lightPreset":"gray"`, 1)},
		{"darkPreset 非法", strings.Replace(valid, `"darkPreset":"midnight"`, `"darkPreset":"black"`, 1)},
		{"accent 枚举非法", strings.Replace(valid, `"accent":"default"`, `"accent":"red"`, 1)},
		{"accent 大写", strings.Replace(valid, `"accent":"default"`, `"accent":"#ABCDEF"`, 1)},
		{"accent 对比度", strings.Replace(valid, `"accent":"default"`, `"accent":"#ffffff"`, 1)},
		{"density 非法", strings.Replace(valid, `"density":"relaxed"`, `"density":"wide"`, 1)},
		{"contentWidth 49", strings.Replace(valid, `"contentWidth":80`, `"contentWidth":49`, 1)},
		{"contentWidth 101", strings.Replace(valid, `"contentWidth":80`, `"contentWidth":101`, 1)},
		{"contentWidth 小数", strings.Replace(valid, `"contentWidth":80`, `"contentWidth":80.5`, 1)},
		{"contentWidth 字符串", strings.Replace(valid, `"contentWidth":80`, `"contentWidth":"80"`, 1)},
		{"contentWidth null", strings.Replace(valid, `"contentWidth":80`, `"contentWidth":null`, 1)},
		{"navCompact 缺失", strings.Replace(valid, `,"navCompact":true`, "", 1)},
		{"navCompact 类型", strings.Replace(valid, `"navCompact":true`, `"navCompact":"true"`, 1)},
		{"非法 JSON", `{"schemaVersion":1`},
	}

	env := newAuthenticatedTestEnv(t)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := env.request(http.MethodPut, "/api/v1/settings/appearance", test.body, "application/json")
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
			}
			errorBody := decodeAPIError(t, recorder)
			if errorBody.Error.Code != "invalid_request" {
				t.Fatalf("code = %q", errorBody.Error.Code)
			}
			if strings.Contains(recorder.Body.String(), env.root) ||
				strings.Contains(strings.ToLower(recorder.Body.String()), "sql") {
				t.Fatalf("错误体泄露路径或 SQL: %s", recorder.Body.String())
			}
		})
	}

	recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	record := decodeData[settings.AppearanceRecord](t, recorder)
	if record.Revision != "0" {
		t.Fatalf("校验失败不应写入，revision = %q", record.Revision)
	}
}

func TestAccentValidationDetailsField(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	body := strings.Replace(validPutBody("0", "default"), `"accent":"default"`, `"accent":"#ffffff"`, 1)
	recorder := env.request(http.MethodPut, "/api/v1/settings/appearance", body, "application/json")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}
	errorBody := decodeAPIError(t, recorder)
	var details map[string]any
	if err := json.Unmarshal(errorBody.Error.Details, &details); err != nil {
		t.Fatal(err)
	}
	if details["field"] != "accent" {
		t.Fatalf("details.field = %v", details["field"])
	}
}

func TestPutAppearanceRejectsLargeBody(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	body := strings.Repeat("a", maxAppearanceBodyBytes+1)
	recorder := env.request(http.MethodPut, "/api/v1/settings/appearance", body, "application/json")
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	errorBody := decodeAPIError(t, recorder)
	if errorBody.Error.Code != "payload_too_large" {
		t.Fatalf("code = %q", errorBody.Error.Code)
	}

	// 无 Content-Length（分块/未知长度）时也必须由读取上限拦截。
	streamed := env.do(http.MethodPut, "/api/v1/settings/appearance", body, "application/json",
		func(request *http.Request) {
			request.ContentLength = -1
			request.Body = io.NopCloser(strings.NewReader(body))
		})
	if streamed.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("未知长度 status = %d, body=%s", streamed.Code, streamed.Body.String())
	}
}

func TestConcurrentPutAppearanceOnlyOneWins(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	const attempts = 10
	body := validPutBody("0", "default")

	start := make(chan struct{})
	results := make(chan int, attempts)
	var wait sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			recorder := env.request(http.MethodPut, "/api/v1/settings/appearance", body, "application/json")
			results <- recorder.Code
		}()
	}
	close(start)
	wait.Wait()
	close(results)

	successes, conflicts := 0, 0
	for status := range results {
		switch status {
		case http.StatusOK:
			successes++
		case http.StatusConflict:
			conflicts++
		default:
			t.Fatalf("意外状态码 %d", status)
		}
	}
	if successes != 1 || conflicts != attempts-1 {
		t.Fatalf("200=%d, 409=%d，期望 1/%d", successes, conflicts, attempts-1)
	}

	recorder := env.request(http.MethodGet, "/api/v1/settings/appearance", "", "")
	record := decodeData[settings.AppearanceRecord](t, recorder)
	if record.Revision != "1" {
		t.Fatalf("并发写入后 revision = %q", record.Revision)
	}
}

func TestPutAppearanceRejectsWrongContentType(t *testing.T) {
	env := newAuthenticatedTestEnv(t)
	for _, contentType := range []string{"", "text/plain", "application/x-www-form-urlencoded"} {
		recorder := env.request(http.MethodPut, "/api/v1/settings/appearance", validPutBody("0", "default"), contentType)
		if recorder.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("Content-Type %q status = %d", contentType, recorder.Code)
		}
		errorBody := decodeAPIError(t, recorder)
		if errorBody.Error.Code != "unsupported_media_type" {
			t.Fatalf("Content-Type %q code = %q", contentType, errorBody.Error.Code)
		}
	}
}
