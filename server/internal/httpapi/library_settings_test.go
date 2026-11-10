package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	librarysettings "iread/server/internal/library/settings"
	appsettings "iread/server/internal/settings"
)

func librarySettingsBody(t *testing.T, baseRevision string, value librarysettings.Value) []byte {
	t.Helper()
	raw, err := json.Marshal(struct {
		SchemaVersion int                   `json:"schemaVersion"`
		BaseRevision  string                `json:"baseRevision"`
		Value         librarysettings.Value `json:"value"`
	}{SchemaVersion: 1, BaseRevision: baseRevision, Value: value})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func decodeLibrarySettings(t *testing.T, recorder interface {
	Result() *http.Response
}) librarysettings.DTO {
	t.Helper()
	response := recorder.Result()
	defer response.Body.Close()
	var envelope struct {
		Data librarysettings.DTO `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatalf("解析书库设置失败: %v", err)
	}
	return envelope.Data
}

func TestLibrarySettingsDefaultsAndCAS(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)

	get := env.request(http.MethodGet, "/api/v1/settings/library", nil, "")
	if get.Code != http.StatusOK {
		t.Fatalf("默认设置 status = %d，body=%s", get.Code, get.Body.String())
	}
	defaults := decodeLibrarySettings(t, get)
	if defaults.SchemaVersion != 1 || defaults.Revision != "0" || defaults.UpdatedAt != nil {
		t.Fatalf("默认记录 = %+v", defaults)
	}
	if !reflect.DeepEqual(defaults.Value, librarysettings.DefaultValue()) {
		t.Fatalf("默认值 = %+v", defaults.Value)
	}

	value := librarysettings.DefaultValue()
	value.ViewMode = "list"
	value.Density = "compact"
	value.Columns = librarysettings.Columns{Count: 3}
	value.ShowAuthors = false
	value.ShowSubtitle = true
	value.CoverRatio = "2:3"
	value.CoverRadius = "sm"
	value.CardGap = "compact"

	put := env.request(http.MethodPut, "/api/v1/settings/library", librarySettingsBody(t, "0", value), "application/json")
	if put.Code != http.StatusOK {
		t.Fatalf("首次 PUT status = %d，body=%s", put.Code, put.Body.String())
	}
	first := decodeLibrarySettings(t, put)
	if first.Revision != "1" || first.UpdatedAt == nil || !reflect.DeepEqual(first.Value, value) {
		t.Fatalf("首次 PUT = %+v", first)
	}

	again := env.request(http.MethodGet, "/api/v1/settings/library", nil, "")
	if got := decodeLibrarySettings(t, again); got.Revision != "1" || !reflect.DeepEqual(got.Value, value) {
		t.Fatalf("GET 持久化 = %+v", got)
	}

	staleValue := value
	staleValue.ViewMode = "grid"
	stale := env.request(http.MethodPut, "/api/v1/settings/library", librarySettingsBody(t, "0", staleValue), "application/json")
	if stale.Code != http.StatusConflict {
		t.Fatalf("旧 revision status = %d，body=%s", stale.Code, stale.Body.String())
	}
	conflict := decodeLibraryError(t, stale)
	if conflict.Error.Code != "revision_conflict" {
		t.Fatalf("冲突 code = %q", conflict.Error.Code)
	}
	current, ok := conflict.Error.Details["current"].(map[string]any)
	if !ok || current["revision"] != "1" {
		t.Fatalf("冲突 current = %+v", conflict.Error.Details["current"])
	}

	nextValue := librarysettings.DefaultValue()
	nextValue.ViewMode = "list"
	next := env.request(http.MethodPut, "/api/v1/settings/library", librarySettingsBody(t, "1", nextValue), "application/json")
	if next.Code != http.StatusOK {
		t.Fatalf("revision 2 PUT status = %d，body=%s", next.Code, next.Body.String())
	}
	if got := decodeLibrarySettings(t, next); got.Revision != "2" || got.Value.ViewMode != "list" {
		t.Fatalf("revision 2 = %+v", got)
	}

	// 分组独立：写 library 不改变 appearance revision；写 appearance 不改变 library。
	appearanceBefore, err := env.store.GetAppearance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if appearanceBefore.Revision != "0" {
		t.Fatalf("library 写入污染 appearance: %+v", appearanceBefore)
	}
	if _, err := env.store.PutAppearance(context.Background(), 0, appsettings.DefaultAppearanceValue()); err != nil {
		t.Fatal(err)
	}
	libraryAfter, err := env.store.GetLibrarySettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if libraryAfter.Revision != 2 {
		t.Fatalf("appearance 写入污染 library revision: %d", libraryAfter.Revision)
	}
}

func TestLibrarySettingsValidationAndErrors(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)

	badValue := func(mutate func(*librarysettings.Value)) []byte {
		value := librarysettings.DefaultValue()
		mutate(&value)
		return librarySettingsBody(t, "0", value)
	}
	cases := []struct {
		name   string
		body   []byte
		status int
	}{
		{name: "viewMode", body: badValue(func(v *librarysettings.Value) { v.ViewMode = "table" }), status: http.StatusUnprocessableEntity},
		{name: "density", body: badValue(func(v *librarysettings.Value) { v.Density = "wide" }), status: http.StatusUnprocessableEntity},
		{name: "columns-low", body: badValue(func(v *librarysettings.Value) { v.Columns = librarysettings.Columns{Count: 1} }), status: http.StatusUnprocessableEntity},
		{name: "columns-high", body: badValue(func(v *librarysettings.Value) { v.Columns = librarysettings.Columns{Count: 9} }), status: http.StatusUnprocessableEntity},
		{name: "coverRatio", body: badValue(func(v *librarysettings.Value) { v.CoverRatio = "1:1" }), status: http.StatusUnprocessableEntity},
		{name: "coverRadius", body: badValue(func(v *librarysettings.Value) { v.CoverRadius = "xl" }), status: http.StatusUnprocessableEntity},
		{name: "cardGap", body: badValue(func(v *librarysettings.Value) { v.CardGap = "wide" }), status: http.StatusUnprocessableEntity},
		{name: "unknown-value-field", body: []byte(`{"schemaVersion":1,"baseRevision":"0","value":{"viewMode":"grid","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard","extra":1}}`), status: http.StatusUnprocessableEntity},
		{name: "missing-value-field", body: []byte(`{"schemaVersion":1,"baseRevision":"0","value":{"viewMode":"grid","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}}`), status: http.StatusUnprocessableEntity},
		{name: "columns-fraction", body: []byte(`{"schemaVersion":1,"baseRevision":"0","value":{"viewMode":"grid","density":"standard","columns":2.5,"showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}}`), status: http.StatusUnprocessableEntity},
		{name: "columns-string", body: []byte(`{"schemaVersion":1,"baseRevision":"0","value":{"viewMode":"grid","density":"standard","columns":"3","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}}`), status: http.StatusUnprocessableEntity},
		{name: "schema-version", body: []byte(`{"schemaVersion":2,"baseRevision":"0","value":{}}`), status: http.StatusBadRequest},
		{name: "missing-base", body: []byte(`{"schemaVersion":1,"value":{}}`), status: http.StatusBadRequest},
		{name: "bad-base", body: []byte(`{"schemaVersion":1,"baseRevision":"x","value":{}}`), status: http.StatusBadRequest},
		{name: "missing-value", body: []byte(`{"schemaVersion":1,"baseRevision":"0"}`), status: http.StatusBadRequest},
		{name: "malformed", body: []byte(`{"schemaVersion":`), status: http.StatusBadRequest},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			recorder := env.request(http.MethodPut, "/api/v1/settings/library", test.body, "application/json")
			if recorder.Code != test.status {
				t.Fatalf("status = %d，期望 %d，body=%s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}

	wrongType := env.request(http.MethodPut, "/api/v1/settings/library", librarySettingsBody(t, "0", librarysettings.DefaultValue()), "text/plain")
	if wrongType.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("错误 Content-Type status = %d", wrongType.Code)
	}
}

func TestLibrarySettingsAuthAndCSRF(t *testing.T) {
	denyAuth := newLibraryHTTPEnv(t, readableTestValidator(), denyAuthMiddleware, allowAllMiddleware)
	if recorder := denyAuth.request(http.MethodGet, "/api/v1/settings/library", nil, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 GET status = %d", recorder.Code)
	}

	denyCSRF := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, denyCSRFMiddleware)
	if recorder := denyCSRF.request(http.MethodGet, "/api/v1/settings/library", nil, ""); recorder.Code != http.StatusOK {
		t.Fatalf("GET 不应要求 CSRF，status = %d", recorder.Code)
	}
	body := librarySettingsBody(t, "0", librarysettings.DefaultValue())
	recorder := denyCSRF.request(http.MethodPut, "/api/v1/settings/library", body, "application/json")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("PUT 无 CSRF status = %d", recorder.Code)
	}
	if envelope := decodeLibraryError(t, recorder); envelope.Error.Code != "forbidden" {
		t.Fatalf("CSRF code = %q", envelope.Error.Code)
	}
}

func TestLibrarySettingsRouteThroughIntegratedServer(t *testing.T) {
	env := newIntegratedTestEnv(t)
	get := env.request(http.MethodGet, "/api/v1/settings/library", "", "")
	if get.Code != http.StatusOK {
		t.Fatalf("集成 GET status = %d，body=%s", get.Code, get.Body.String())
	}
	dto := decodeLibrarySettings(t, get)
	if dto.Revision != "0" {
		t.Fatalf("集成默认 revision = %q", dto.Revision)
	}
	value := librarysettings.DefaultValue()
	value.ViewMode = "list"
	put := env.request(http.MethodPut, "/api/v1/settings/library", string(librarySettingsBody(t, "0", value)), "application/json")
	if put.Code != http.StatusOK {
		t.Fatalf("集成 PUT status = %d，body=%s", put.Code, put.Body.String())
	}
	if got := decodeLibrarySettings(t, put); got.Revision != "1" || got.Value.ViewMode != "list" {
		t.Fatalf("集成 PUT = %+v", got)
	}
}
