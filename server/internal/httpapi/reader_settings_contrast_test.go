package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	readersettings "iread/server/internal/reader/settings"
)

func TestReaderSettingsRejectsLowContrastColors(t *testing.T) {
	cases := []struct {
		name  string
		value string
		field string
		pair  []string
	}{
		{
			name:  "text-background",
			value: `{"reflow":{"text":"#777777","background":"#ffffff"}}`,
			field: "reflow.text",
			pair:  []string{"reflow.text", "reflow.background"},
		},
		{
			name:  "link-background",
			value: `{"reflow":{"link":"#888888","background":"#ffffff"}}`,
			field: "reflow.link",
			pair:  []string{"reflow.link", "reflow.background"},
		},
		{
			name:  "selection-text",
			value: `{"reflow":{"selection":"#777777","text":"#ffffff"}}`,
			field: "reflow.selection",
			pair:  []string{"reflow.text", "reflow.selection"},
		},
	}
	for _, tc := range cases {
		t.Run("global/"+tc.name, func(t *testing.T) {
			api := newReaderAPIEnv(t)
			response := api.request(http.MethodPut, "/api/v1/settings/reader",
				putGlobalSettingsBody("0", tc.value), true, true, nil)
			assertContrastRejected(t, response, tc.field, tc.pair)

			current := decodeData[readersettings.GlobalDTO](t,
				api.request(http.MethodGet, "/api/v1/settings/reader", "", true, false, nil))
			if current.Revision != "0" || len(current.Value) != 0 {
				t.Fatalf("被拒绝的全局颜色仍被写入: %+v", current)
			}
		})
		t.Run("book/"+tc.name, func(t *testing.T) {
			api := newReaderAPIEnv(t)
			bookID, fileVersion := api.insertBook("epub")
			target := "/api/v1/books/" + bookID + "/reader-settings"
			response := api.request(http.MethodPut, target,
				putBookSettingsBody(fileVersion, "0", tc.value), true, true, nil)
			assertContrastRejected(t, response, tc.field, tc.pair)

			current := decodeData[readersettings.BookDTO](t,
				api.request(http.MethodGet, target, "", true, false, nil))
			if current.Revision != "0" || len(current.Overrides) != 0 {
				t.Fatalf("被拒绝的单书颜色仍被写入: %+v", current)
			}
		})
	}
}

func TestReaderSettingsAcceptsSufficientContrastAndPresets(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{
			name:  "hex-pairs",
			value: `{"reflow":{"background":"#ffffff","text":"#767676","link":"#1a0dab","selection":"#000000"}}`,
		},
		{
			name:  "preset-background",
			value: `{"reflow":{"background":"white","text":"#777777","link":"#888888"}}`,
		},
		{
			name:  "preset-text",
			value: `{"reflow":{"text":"white","background":"#ffffff","selection":"#777777"}}`,
		},
		{
			name:  "preset-link",
			value: `{"reflow":{"link":"inherit","background":"#ffffff"}}`,
		},
		{
			name:  "preset-selection",
			value: `{"reflow":{"selection":"#777777","text":"white"}}`,
		},
	}
	for _, tc := range cases {
		t.Run("global/"+tc.name, func(t *testing.T) {
			api := newReaderAPIEnv(t)
			response := api.request(http.MethodPut, "/api/v1/settings/reader",
				putGlobalSettingsBody("0", tc.value), true, true, nil)
			if response.Code != http.StatusOK {
				t.Fatalf("合法全局颜色 = %d, body=%s", response.Code, response.Body.String())
			}
		})
		t.Run("book/"+tc.name, func(t *testing.T) {
			api := newReaderAPIEnv(t)
			bookID, fileVersion := api.insertBook("epub")
			target := "/api/v1/books/" + bookID + "/reader-settings"
			response := api.request(http.MethodPut, target,
				putBookSettingsBody(fileVersion, "0", tc.value), true, true, nil)
			if response.Code != http.StatusOK {
				t.Fatalf("合法单书颜色 = %d, body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestReaderSettingsReadDoesNotApplyLowContrastStoredValue(t *testing.T) {
	const badValue = `{"reflow":{"text":"#777777","background":"#ffffff"}}`
	forbidden := []string{"#777777", "reflow.text", "/iread.db", "SELECT", "sql:", "app_settings"}

	t.Run("global", func(t *testing.T) {
		api := newReaderAPIEnv(t)
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if _, err := api.db.Exec(`
			INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
			VALUES ('reader', 1, ?, 1, ?)`, badValue, now); err != nil {
			t.Fatalf("插入低对比度全局设置: %v", err)
		}
		assertReadRejected(t, api.request(http.MethodGet, "/api/v1/settings/reader", "", true, false, nil), forbidden)
	})

	t.Run("book", func(t *testing.T) {
		api := newReaderAPIEnv(t)
		bookID, _ := api.insertBook("epub")
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if _, err := api.db.Exec(`
			INSERT INTO book_reader_overrides (book_id, schema_version, overrides_json, revision, updated_at)
			VALUES (?, 1, ?, 1, ?)`, bookID, badValue, now); err != nil {
			t.Fatalf("插入低对比度单书覆盖: %v", err)
		}
		assertReadRejected(t, api.request(http.MethodGet, "/api/v1/books/"+bookID+"/reader-settings", "", true, false, nil), forbidden)
	})
}

func assertContrastRejected(t *testing.T, response *httptest.ResponseRecorder, field string, pair []string) {
	t.Helper()
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("低对比度颜色状态码 = %d, body=%s", response.Code, response.Body.String())
	}
	apiErr := decodeAPIError(t, response)
	if apiErr.Error.Code != "invalid_request" {
		t.Fatalf("错误码 = %q, body=%s", apiErr.Error.Code, response.Body.String())
	}
	var details struct {
		Field   string   `json:"field"`
		Pair    []string `json:"pair"`
		Ratio   float64  `json:"ratio"`
		Minimum float64  `json:"minimum"`
	}
	if err := json.Unmarshal(apiErr.Error.Details, &details); err != nil {
		t.Fatalf("解析 details: %v, body=%s", err, response.Body.String())
	}
	if details.Field != field {
		t.Fatalf("details.field = %q, want %q", details.Field, field)
	}
	if !slices.Equal(details.Pair, pair) {
		t.Fatalf("details.pair = %#v, want %#v", details.Pair, pair)
	}
	if details.Ratio <= 0 || details.Ratio >= 4.5 {
		t.Fatalf("details.ratio = %v", details.Ratio)
	}
	if details.Minimum != 4.5 {
		t.Fatalf("details.minimum = %v", details.Minimum)
	}
	for _, text := range []string{"/iread.db", "SELECT", "sql:", "app_settings"} {
		if strings.Contains(response.Body.String(), text) {
			t.Fatalf("错误响应泄露 %q: %s", text, response.Body.String())
		}
	}
}

func assertReadRejected(t *testing.T, response *httptest.ResponseRecorder, forbidden []string) {
	t.Helper()
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("读取低对比度设置状态码 = %d, body=%s", response.Code, response.Body.String())
	}
	if code := decodeAPIError(t, response).Error.Code; code != "internal_error" {
		t.Fatalf("读取错误码 = %q, body=%s", code, response.Body.String())
	}
	for _, text := range forbidden {
		if strings.Contains(response.Body.String(), text) {
			t.Fatalf("读取错误响应泄露 %q: %s", text, response.Body.String())
		}
	}
}
