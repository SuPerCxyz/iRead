package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	readersettings "iread/server/internal/reader/settings"
)

func putGlobalSettingsBody(baseRevision, value string) string {
	return fmt.Sprintf(`{"schemaVersion":1,"baseRevision":%q,"value":%s}`, baseRevision, value)
}

func putBookSettingsBody(fileVersion, baseRevision, overrides string) string {
	return fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"baseRevision":%q,"overrides":%s}`,
		fileVersion, baseRevision, overrides)
}

func TestReaderGlobalSettingsDefaultsAndCAS(t *testing.T) {
	api := newReaderAPIEnv(t)
	target := "/api/v1/settings/reader"

	defaults := api.request(http.MethodGet, target, "", true, false, nil)
	if defaults.Code != http.StatusOK {
		t.Fatalf("默认全局设置 = %d, body=%s", defaults.Code, defaults.Body.String())
	}
	defaultDTO := decodeData[readersettings.GlobalDTO](t, defaults)
	if defaultDTO.SchemaVersion != 1 || defaultDTO.Revision != "0" || defaultDTO.UpdatedAt != nil || len(defaultDTO.Value) != 0 {
		t.Fatalf("默认全局设置 = %+v", defaultDTO)
	}

	first := api.request(http.MethodPut, target, putGlobalSettingsBody("0", `{}`), true, true, nil)
	if first.Code != http.StatusOK {
		t.Fatalf("首次 PUT 全局 = %d, body=%s", first.Code, first.Body.String())
	}
	firstDTO := decodeData[readersettings.GlobalDTO](t, first)
	if firstDTO.Revision != "1" || firstDTO.UpdatedAt == nil || len(firstDTO.Value) != 0 {
		t.Fatalf("首次全局结果 = %+v", firstDTO)
	}

	second := api.request(http.MethodPut, target,
		putGlobalSettingsBody("1", `{"reflow":{"fontSize":20},"pdf":{"toolbarVisible":false}}`), true, true, nil)
	if second.Code != http.StatusOK {
		t.Fatalf("第二次 PUT 全局 = %d, body=%s", second.Code, second.Body.String())
	}
	secondDTO := decodeData[readersettings.GlobalDTO](t, second)
	if secondDTO.Revision != "2" {
		t.Fatalf("第二次全局 revision = %q", secondDTO.Revision)
	}
	reflow, _ := secondDTO.Value["reflow"].(map[string]any)
	if reflow == nil || reflow["fontSize"] != float64(20) {
		t.Fatalf("全局 value = %+v", secondDTO.Value)
	}

	stale := api.request(http.MethodPut, target, putGlobalSettingsBody("1", `{"reflow":{"fontSize":21}}`), true, true, nil)
	if stale.Code != http.StatusConflict || decodeAPIError(t, stale).Error.Code != "revision_conflict" {
		t.Fatalf("过时全局 revision = %d, body=%s", stale.Code, stale.Body.String())
	}
	apiErr := decodeAPIError(t, stale)
	var details struct {
		Current *readersettings.GlobalDTO `json:"current"`
	}
	if err := json.Unmarshal(apiErr.Error.Details, &details); err != nil {
		t.Fatal(err)
	}
	if details.Current == nil || details.Current.Revision != "2" {
		t.Fatalf("全局 conflict current = %+v", details.Current)
	}

	if code := api.request(http.MethodPut, target,
		putGlobalSettingsBody("2", `{"reflow":{"bogus":1}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("未知设置字段 = %d", code)
	}
	if code := api.request(http.MethodPut, target,
		putGlobalSettingsBody("2", `{"reflow":{"fontSize":null}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("null 设置字段 = %d", code)
	}
	if code := api.request(http.MethodPut, target,
		putGlobalSettingsBody("2", `{"reflow":{"fontSize":20},"extra":{}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("未知分组 = %d", code)
	}
	if code := api.request(http.MethodPut, target,
		`{"schemaVersion":1,"baseRevision":"2","value":{"reflow":{"fontSize":20}},"extra":true}`,
		true, true, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("顶层未知字段 = %d", code)
	}
	if code := api.request(http.MethodPut, target,
		`{"schemaVersion":2,"baseRevision":"2","value":{}}`, true, true, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("schemaVersion 2 = %d", code)
	}
	if code := api.request(http.MethodPut, target,
		putGlobalSettingsBody("2", `{}`), true, false, nil).Code; code != http.StatusForbidden {
		t.Fatalf("全局缺 CSRF = %d", code)
	}
}

func TestReaderBookSettingsInheritanceSparseAndRecovery(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	globalTarget := "/api/v1/settings/reader"
	bookTarget := "/api/v1/books/" + bookID + "/reader-settings"

	defaultBook := api.request(http.MethodGet, bookTarget, "", true, false, nil)
	if defaultBook.Code != http.StatusOK {
		t.Fatalf("默认单书设置 = %d, body=%s", defaultBook.Code, defaultBook.Body.String())
	}
	bookDTO := decodeData[readersettings.BookDTO](t, defaultBook)
	if bookDTO.Revision != "0" || bookDTO.UpdatedAt != nil || len(bookDTO.Overrides) != 0 ||
		bookDTO.GlobalRevision != "0" || bookDTO.BuiltInVersion != 1 ||
		settingSource(bookDTO, "reflow", "fontSize") != "built-in" {
		t.Fatalf("默认单书设置 = %+v", bookDTO)
	}
	reflow := bookDTO.EffectiveValues["reflow"].(map[string]any)
	if reflow["fontSize"] != float64(16) {
		t.Fatalf("默认 fontSize = %#v", reflow["fontSize"])
	}

	if code := api.request(http.MethodPut, globalTarget,
		putGlobalSettingsBody("0", `{"reflow":{"fontSize":20,"fontFamily":"serif"}}`), true, true, nil).Code; code != http.StatusOK {
		t.Fatalf("写入全局设置 = %d", code)
	}
	afterGlobal := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, bookTarget, "", true, false, nil))
	if afterGlobal.GlobalRevision != "1" || afterGlobal.Revision != "0" ||
		settingSource(afterGlobal, "reflow", "fontSize") != "global" ||
		settingSource(afterGlobal, "reflow", "fontFamily") != "global" {
		t.Fatalf("全局继承 = %+v", afterGlobal)
	}
	if afterGlobal.EffectiveValues["reflow"].(map[string]any)["fontSize"] != float64(20) {
		t.Fatalf("全局 fontSize 未生效")
	}

	bookPut := api.request(http.MethodPut, bookTarget,
		putBookSettingsBody(fileVersion, "0", `{"reflow":{"fontSize":22,"lineHeight":1.4}}`), true, true, nil)
	if bookPut.Code != http.StatusOK {
		t.Fatalf("写入单书设置 = %d, body=%s", bookPut.Code, bookPut.Body.String())
	}
	bookDTO = decodeData[readersettings.BookDTO](t, bookPut)
	if bookDTO.Revision != "1" || bookDTO.UpdatedAt == nil {
		t.Fatalf("单书 revision = %+v", bookDTO)
	}
	overridesReflow, _ := bookDTO.Overrides["reflow"].(map[string]any)
	if len(bookDTO.Overrides) != 1 || len(overridesReflow) != 2 ||
		overridesReflow["fontSize"] != float64(22) || overridesReflow["lineHeight"] != 1.4 {
		t.Fatalf("稀疏 overrides = %+v", bookDTO.Overrides)
	}
	if bookDTO.EffectiveValues["reflow"].(map[string]any)["fontSize"] != float64(22) ||
		bookDTO.EffectiveValues["reflow"].(map[string]any)["lineHeight"] != 1.4 {
		t.Fatalf("单书 effective = %+v", bookDTO.EffectiveValues)
	}
	if settingSource(bookDTO, "reflow", "fontSize") != "book" ||
		settingSource(bookDTO, "reflow", "lineHeight") != "book" ||
		settingSource(bookDTO, "reflow", "fontFamily") != "global" ||
		settingSource(bookDTO, "reflow", "fontWeight") != "built-in" {
		t.Fatalf("字段来源 = %+v", bookDTO.FieldSources)
	}

	// 全局变化只重算 effectiveValues/fieldSources，不增加单书 revision。
	if code := api.request(http.MethodPut, globalTarget,
		putGlobalSettingsBody("1", `{"reflow":{"fontSize":21,"lineHeight":1.8,"textIndent":1}}`), true, true, nil).Code; code != http.StatusOK {
		t.Fatalf("更新全局设置 = %d", code)
	}
	afterGlobalChange := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, bookTarget, "", true, false, nil))
	if afterGlobalChange.Revision != "1" || afterGlobalChange.GlobalRevision != "2" {
		t.Fatalf("全局更新后 revision = %+v", afterGlobalChange)
	}
	afterReflow := afterGlobalChange.EffectiveValues["reflow"].(map[string]any)
	if afterReflow["fontSize"] != float64(22) || afterReflow["lineHeight"] != 1.4 ||
		afterReflow["textIndent"] != float64(1) {
		t.Fatalf("三级继承 = %+v", afterReflow)
	}

	empty := api.request(http.MethodPut, bookTarget,
		putBookSettingsBody(fileVersion, "1", `{}`), true, true, nil)
	if empty.Code != http.StatusOK {
		t.Fatalf("空对象恢复默认 = %d, body=%s", empty.Code, empty.Body.String())
	}
	emptyDTO := decodeData[readersettings.BookDTO](t, empty)
	emptyReflow := emptyDTO.EffectiveValues["reflow"].(map[string]any)
	if emptyDTO.Revision != "2" || len(emptyDTO.Overrides) != 0 ||
		emptyReflow["fontSize"] != float64(21) || emptyReflow["lineHeight"] != 1.8 ||
		settingSource(emptyDTO, "reflow", "fontSize") != "global" {
		t.Fatalf("空对象恢复结果 = %+v", emptyDTO)
	}
}

func TestReaderBookSettingsConflictsAndValidation(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	target := "/api/v1/books/" + bookID + "/reader-settings"

	wrongVersion := api.request(http.MethodPut, target,
		putBookSettingsBody(strings.Repeat("b", 64), "0", `{"reflow":{"fontSize":20}}`), true, true, nil)
	if wrongVersion.Code != http.StatusConflict || decodeAPIError(t, wrongVersion).Error.Code != "file_version_conflict" {
		t.Fatalf("fileVersion 失配 = %d, body=%s", wrongVersion.Code, wrongVersion.Body.String())
	}

	if code := api.request(http.MethodPut, target,
		putBookSettingsBody(fileVersion, "0", `{"reflow":{"fontSize":null}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("null override = %d", code)
	}
	if code := api.request(http.MethodPut, target,
		putBookSettingsBody(fileVersion, "0", `{"reflow":{"unknown":1}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("未知 override = %d", code)
	}
	if code := api.request(http.MethodPut, target,
		putBookSettingsBody(fileVersion, "0", `{"effectiveValues":{}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("回写 effectiveValues = %d", code)
	}

	first := api.request(http.MethodPut, target,
		putBookSettingsBody(fileVersion, "0", `{"reflow":{"fontSize":22}}`), true, true, nil)
	if first.Code != http.StatusOK {
		t.Fatalf("创建单书设置 = %d", first.Code)
	}
	stale := api.request(http.MethodPut, target,
		putBookSettingsBody(fileVersion, "0", `{"reflow":{"fontSize":23}}`), true, true, nil)
	if stale.Code != http.StatusConflict {
		t.Fatalf("过时单书 revision = %d, body=%s", stale.Code, stale.Body.String())
	}
	apiErr := decodeAPIError(t, stale)
	var details struct {
		Current *readersettings.BookDTO `json:"current"`
	}
	if err := json.Unmarshal(apiErr.Error.Details, &details); err != nil {
		t.Fatal(err)
	}
	if details.Current == nil || details.Current.Revision != "1" ||
		details.Current.Overrides["reflow"].(map[string]any)["fontSize"] != float64(22) {
		t.Fatalf("单书 conflict current = %+v", details.Current)
	}
}

func settingSource(dto readersettings.BookDTO, group, field string) string {
	groupSources, ok := dto.FieldSources[group]
	if !ok {
		return ""
	}
	return groupSources[field]
}

func TestReaderSettingsInternalErrorDoesNotLeakStorage(t *testing.T) {
	api := newReaderAPIEnv(t)
	if err := api.store.Close(); err != nil {
		t.Fatalf("关闭 store: %v", err)
	}
	recorder := api.request(http.MethodGet, "/api/v1/settings/reader", "", true, false, nil)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("关闭数据库后 GET = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, forbidden := range []string{"/iread.db", "SELECT", "sql:", "app_settings"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("错误响应泄露 %q: %s", forbidden, body)
		}
	}
	if decodeAPIError(t, recorder).Error.Code != "internal_error" {
		t.Fatalf("错误 code = %s", body)
	}
}
