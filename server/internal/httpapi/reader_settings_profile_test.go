package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	readersettings "iread/server/internal/reader/settings"
)

func TestReaderBookSettingsProfilesIsolation(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("pdf")
	base := "/api/v1/books/" + bookID + "/reader-overrides"
	webTarget := base + "?profile=web"
	mobileTarget := base + "?profile=mobile"

	// 省略 profile 默认 web；PDF 无覆盖时为 manual 100%，来源 built-in。
	defaults := api.request(http.MethodGet, base, "", true, false, nil)
	if defaults.Code != http.StatusOK {
		t.Fatalf("默认 GET = %d, body=%s", defaults.Code, defaults.Body.String())
	}
	defaultDTO := decodeData[readersettings.BookDTO](t, defaults)
	if defaultDTO.Profile != "web" || defaultDTO.Revision != "0" || len(defaultDTO.Overrides) != 0 {
		t.Fatalf("默认 profile DTO = %+v", defaultDTO)
	}
	assertPDFManualDefault(t, defaultDTO)

	webPut := api.request(http.MethodPut, webTarget,
		putBookSettingsBody(fileVersion, "0", `{"pdf":{"zoomMode":"fit-page","manualScale":0.75}}`), true, true, nil)
	if webPut.Code != http.StatusOK {
		t.Fatalf("PUT web = %d, body=%s", webPut.Code, webPut.Body.String())
	}
	webDTO := decodeData[readersettings.BookDTO](t, webPut)
	if webDTO.Profile != "web" || webDTO.Revision != "1" ||
		settingSource(webDTO, "pdf", "zoomMode") != "book" {
		t.Fatalf("web PUT DTO = %+v", webDTO)
	}
	webPDF := webDTO.EffectiveValues["pdf"].(map[string]any)
	if webPDF["zoomMode"] != "fit-page" || webPDF["manualScale"] != 0.75 {
		t.Fatalf("web effective = %+v", webPDF)
	}

	// mobile 未写入，必须保持为空覆盖和 built-in 默认，不能看到 web 的值。
	mobileGet := api.request(http.MethodGet, mobileTarget, "", true, false, nil)
	if mobileGet.Code != http.StatusOK {
		t.Fatalf("GET mobile = %d, body=%s", mobileGet.Code, mobileGet.Body.String())
	}
	mobileDTO := decodeData[readersettings.BookDTO](t, mobileGet)
	if mobileDTO.Profile != "mobile" || mobileDTO.Revision != "1" || len(mobileDTO.Overrides) != 0 {
		t.Fatalf("mobile 默认 DTO = %+v", mobileDTO)
	}
	assertPDFManualDefault(t, mobileDTO)

	// 旧别名路径与同一资源、同一 revision。
	alias := "/api/v1/books/" + bookID + "/reader-settings?profile=mobile"
	aliasDTO := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, alias, "", true, false, nil))
	if aliasDTO.Profile != "mobile" || aliasDTO.Revision != "1" || len(aliasDTO.Overrides) != 0 {
		t.Fatalf("别名 mobile DTO = %+v", aliasDTO)
	}

	mobilePut := api.request(http.MethodPut, mobileTarget,
		putBookSettingsBody(fileVersion, "1", `{"reflow":{"fontSize":20}}`), true, true, nil)
	if mobilePut.Code != http.StatusOK {
		t.Fatalf("PUT mobile = %d, body=%s", mobilePut.Code, mobilePut.Body.String())
	}
	mobileDTO = decodeData[readersettings.BookDTO](t, mobilePut)
	if mobileDTO.Profile != "mobile" || mobileDTO.Revision != "2" ||
		settingSource(mobileDTO, "reflow", "fontSize") != "book" {
		t.Fatalf("mobile PUT DTO = %+v", mobileDTO)
	}

	// web 覆盖在 mobile 写入后原样保留，revision 共享为 2。
	webDTO = decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, webTarget, "", true, false, nil))
	webPDF = webDTO.EffectiveValues["pdf"].(map[string]any)
	if webDTO.Revision != "2" || webDTO.Profile != "web" ||
		webPDF["zoomMode"] != "fit-page" || webPDF["manualScale"] != 0.75 ||
		settingSource(webDTO, "reflow", "fontSize") != "built-in" {
		t.Fatalf("mobile 写入后 web DTO = %+v", webDTO)
	}

	// 跨 profile 的过时 baseRevision 共享 CAS，冲突 current 需返回请求的 profile。
	stale := api.request(http.MethodPut, mobileTarget,
		putBookSettingsBody(fileVersion, "1", `{"reflow":{"fontSize":21}}`), true, true, nil)
	if stale.Code != http.StatusConflict {
		t.Fatalf("过时跨 profile PUT = %d, body=%s", stale.Code, stale.Body.String())
	}
	assertNoReaderStorageLeak(t, stale)
	var conflictDetails struct {
		Current *readersettings.BookDTO `json:"current"`
	}
	if err := json.Unmarshal(decodeAPIError(t, stale).Error.Details, &conflictDetails); err != nil {
		t.Fatal(err)
	}
	if conflictDetails.Current == nil || conflictDetails.Current.Profile != "mobile" ||
		conflictDetails.Current.Revision != "2" ||
		conflictDetails.Current.Overrides["reflow"].(map[string]any)["fontSize"] != float64(20) {
		t.Fatalf("冲突 current = %+v", conflictDetails.Current)
	}

	// 空对象只恢复请求 profile，另一个 profile 不受影响。
	empty := api.request(http.MethodPut, webTarget,
		putBookSettingsBody(fileVersion, "2", `{}`), true, true, nil)
	if empty.Code != http.StatusOK {
		t.Fatalf("web 空对象 = %d, body=%s", empty.Code, empty.Body.String())
	}
	emptyDTO := decodeData[readersettings.BookDTO](t, empty)
	if emptyDTO.Revision != "3" || len(emptyDTO.Overrides) != 0 {
		t.Fatalf("web 空对象 DTO = %+v", emptyDTO)
	}
	assertPDFManualDefault(t, emptyDTO)
	mobileDTO = decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, mobileTarget, "", true, false, nil))
	if mobileDTO.Revision != "3" || mobileDTO.Overrides["reflow"].(map[string]any)["fontSize"] != float64(20) {
		t.Fatalf("web 恢复后 mobile DTO = %+v", mobileDTO)
	}
}

func TestReaderBookSettingsLegacyFallbackAndMigration(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("pdf")
	base := "/api/v1/books/" + bookID + "/reader-overrides"
	legacy := `{"pdf":{"zoomMode":"fit-width","manualScale":1.25},"reflow":{"fontSize":22}}`
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := api.db.Exec(`
		INSERT INTO book_reader_overrides (book_id, schema_version, overrides_json, revision, updated_at)
		VALUES (?, 1, ?, 5, ?)`, bookID, legacy, now); err != nil {
		t.Fatalf("写入 legacy 覆盖: %v", err)
	}

	for _, query := range []string{"?profile=web", "?profile=mobile"} {
		recorder := api.request(http.MethodGet, base+query, "", true, false, nil)
		if recorder.Code != http.StatusOK {
			t.Fatalf("legacy GET %s = %d, body=%s", query, recorder.Code, recorder.Body.String())
		}
		dto := decodeData[readersettings.BookDTO](t, recorder)
		if dto.Revision != "5" || len(dto.Overrides) != 2 ||
			settingSource(dto, "pdf", "zoomMode") != "book" {
			t.Fatalf("legacy %s DTO = %+v", query, dto)
		}
		pdf := dto.EffectiveValues["pdf"].(map[string]any)
		reflow := dto.EffectiveValues["reflow"].(map[string]any)
		if pdf["zoomMode"] != "fit-width" || pdf["manualScale"] != 1.25 || reflow["fontSize"] != float64(22) {
			t.Fatalf("legacy %s effective = %+v / %+v", query, pdf, reflow)
		}
	}

	// 首次按 profile 写入：legacy 值复制到 web/mobile，只替换 web。
	webPut := api.request(http.MethodPut, base+"?profile=web",
		putBookSettingsBody(fileVersion, "5", `{"pdf":{"zoomMode":"fit-page","manualScale":0.5}}`), true, true, nil)
	if webPut.Code != http.StatusOK {
		t.Fatalf("legacy 后 PUT web = %d, body=%s", webPut.Code, webPut.Body.String())
	}
	if dto := decodeData[readersettings.BookDTO](t, webPut); dto.Revision != "6" || dto.Profile != "web" {
		t.Fatalf("legacy 后 web DTO = %+v", dto)
	}
	mobileDTO := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base+"?profile=mobile", "", true, false, nil))
	if mobileDTO.Revision != "6" ||
		mobileDTO.Overrides["pdf"].(map[string]any)["zoomMode"] != "fit-width" ||
		mobileDTO.Overrides["reflow"].(map[string]any)["fontSize"] != float64(22) {
		t.Fatalf("legacy 迁移后 mobile 丢失 = %+v", mobileDTO.Overrides)
	}

	var stored string
	if err := api.db.QueryRow(`SELECT overrides_json FROM book_reader_overrides WHERE book_id = ?`, bookID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, `{"schemaVersion":1,"profiles":`) {
		t.Fatalf("存储形状 = %s", stored)
	}
	var envelope struct {
		SchemaVersion int64                      `json:"schemaVersion"`
		Profiles      map[string]json.RawMessage `json:"profiles"`
	}
	if err := json.Unmarshal([]byte(stored), &envelope); err != nil {
		t.Fatalf("解析存储信封: %v, raw=%s", err, stored)
	}
	if envelope.SchemaVersion != 1 || len(envelope.Profiles) != 2 {
		t.Fatalf("存储信封 = %s", stored)
	}
	var storedWeb, storedMobile map[string]any
	if err := json.Unmarshal(envelope.Profiles["web"], &storedWeb); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(envelope.Profiles["mobile"], &storedMobile); err != nil {
		t.Fatal(err)
	}
	if storedWeb["pdf"].(map[string]any)["zoomMode"] != "fit-page" {
		t.Fatalf("存储 web = %+v", storedWeb)
	}
	if storedMobile["pdf"].(map[string]any)["zoomMode"] != "fit-width" ||
		storedMobile["reflow"].(map[string]any)["fontSize"] != float64(22) {
		t.Fatalf("存储 mobile = %+v", storedMobile)
	}

	// 旧客户端无 profile 按 web 处理，仍不破坏 mobile。
	oldClient := api.request(http.MethodPut, base,
		putBookSettingsBody(fileVersion, "6", `{"reflow":{"fontSize":18}}`), true, true, nil)
	if oldClient.Code != http.StatusOK {
		t.Fatalf("旧客户端 PUT = %d, body=%s", oldClient.Code, oldClient.Body.String())
	}
	if dto := decodeData[readersettings.BookDTO](t, oldClient); dto.Profile != "web" || dto.Revision != "7" {
		t.Fatalf("旧客户端 DTO = %+v", dto)
	}
	mobileDTO = decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base+"?profile=mobile", "", true, false, nil))
	if mobileDTO.Revision != "7" ||
		mobileDTO.Overrides["pdf"].(map[string]any)["zoomMode"] != "fit-width" ||
		mobileDTO.Overrides["reflow"].(map[string]any)["fontSize"] != float64(22) {
		t.Fatalf("旧客户端写入破坏 mobile = %+v", mobileDTO.Overrides)
	}

	// mobile 空对象恢复只清 mobile。
	mobileEmpty := api.request(http.MethodPut, base+"?profile=mobile",
		putBookSettingsBody(fileVersion, "7", `{}`), true, true, nil)
	if mobileEmpty.Code != http.StatusOK {
		t.Fatalf("mobile 空对象 = %d, body=%s", mobileEmpty.Code, mobileEmpty.Body.String())
	}
	mobileDTO = decodeData[readersettings.BookDTO](t, mobileEmpty)
	if mobileDTO.Revision != "8" || len(mobileDTO.Overrides) != 0 {
		t.Fatalf("mobile 空对象 DTO = %+v", mobileDTO)
	}
	assertPDFManualDefault(t, mobileDTO)
	webDTO := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base+"?profile=web", "", true, false, nil))
	if webDTO.Revision != "8" || webDTO.Overrides["reflow"].(map[string]any)["fontSize"] != float64(18) {
		t.Fatalf("mobile 恢复后 web DTO = %+v", webDTO.Overrides)
	}
}

func TestReaderBookSettingsProfileValidation(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	base := "/api/v1/books/" + bookID + "/reader-overrides"

	for _, query := range []string{"?profile=tablet", "?profile=", "?profile=web&profile=mobile"} {
		recorder := api.request(http.MethodGet, base+query, "", true, false, nil)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("非法 profile %q = %d, body=%s", query, recorder.Code, recorder.Body.String())
		}
		if code := decodeAPIError(t, recorder).Error.Code; code != "invalid_request" {
			t.Fatalf("非法 profile code = %s", code)
		}
		assertNoReaderStorageLeak(t, recorder)
		var details map[string]any
		if err := json.Unmarshal(decodeAPIError(t, recorder).Error.Details, &details); err != nil {
			t.Fatal(err)
		}
		if details["field"] != "profile" {
			t.Fatalf("非法 profile details = %+v", details)
		}
		if query == "?profile=tablet" && details["profile"] != "tablet" {
			t.Fatalf("非法 profile 值 = %+v", details)
		}
	}

	invalidPut := api.request(http.MethodPut, base+"?profile=tablet",
		putBookSettingsBody(fileVersion, "0", `{"reflow":{"fontSize":20}}`), true, true, nil)
	if invalidPut.Code != http.StatusUnprocessableEntity {
		t.Fatalf("非法 profile PUT = %d, body=%s", invalidPut.Code, invalidPut.Body.String())
	}
	if dto := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base, "", true, false, nil)); dto.Revision != "0" {
		t.Fatalf("非法 profile 写入后 revision = %+v", dto)
	}

	// profiles 是服务端存储信封，不是客户端可提交的 group。
	if code := api.request(http.MethodPut, base+"?profile=web",
		putBookSettingsBody(fileVersion, "0", `{"profiles":{"web":{}}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("客户端提交 profiles = %d", code)
	}
	if code := api.request(http.MethodPut, base+"?profile=web",
		putBookSettingsBody(fileVersion, "0", `{"pdf":{"zoomMode":null}}`), true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("null 覆盖 = %d", code)
	}

	// 旧客户端无 profile 默认写 web。
	oldClient := api.request(http.MethodPut, base,
		putBookSettingsBody(fileVersion, "0", `{"reflow":{"fontSize":20}}`), true, true, nil)
	if oldClient.Code != http.StatusOK {
		t.Fatalf("旧客户端默认 profile PUT = %d, body=%s", oldClient.Code, oldClient.Body.String())
	}
	if dto := decodeData[readersettings.BookDTO](t, oldClient); dto.Profile != "web" || dto.Revision != "1" {
		t.Fatalf("旧客户端默认 profile DTO = %+v", dto)
	}
	if dto := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base+"?profile=mobile", "", true, false, nil)); len(dto.Overrides) != 0 {
		t.Fatalf("旧客户端写入 mobile = %+v", dto.Overrides)
	}
}

func TestReaderBookSettingsPDFFitWidthStillReadable(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("pdf")
	base := "/api/v1/books/" + bookID + "/reader-overrides"

	globalPut := api.request(http.MethodPut, "/api/v1/settings/reader",
		putGlobalSettingsBody("0", `{"pdf":{"zoomMode":"fit-width","manualScale":1.5}}`), true, true, nil)
	if globalPut.Code != http.StatusOK {
		t.Fatalf("全局 fit-width = %d, body=%s", globalPut.Code, globalPut.Body.String())
	}
	globalDTO := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base, "", true, false, nil))
	if settingSource(globalDTO, "pdf", "zoomMode") != "global" ||
		globalDTO.EffectiveValues["pdf"].(map[string]any)["zoomMode"] != "fit-width" {
		t.Fatalf("旧全局 fit-width = %+v", globalDTO.FieldSources)
	}

	bookPut := api.request(http.MethodPut, base+"?profile=web",
		putBookSettingsBody(fileVersion, "0", `{"pdf":{"zoomMode":"fit-width","manualScale":1.25}}`), true, true, nil)
	if bookPut.Code != http.StatusOK {
		t.Fatalf("单书 fit-width = %d, body=%s", bookPut.Code, bookPut.Body.String())
	}
	bookDTO := decodeData[readersettings.BookDTO](t, bookPut)
	if settingSource(bookDTO, "pdf", "zoomMode") != "book" ||
		bookDTO.EffectiveValues["pdf"].(map[string]any)["manualScale"] != 1.25 {
		t.Fatalf("旧单书 fit-width = %+v", bookDTO.EffectiveValues["pdf"])
	}
}

func TestReaderBookSettingsProfilesConcurrentCAS(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	base := "/api/v1/books/" + bookID + "/reader-overrides"

	statuses := make(chan int, 2)
	for _, profile := range []string{"web", "mobile"} {
		go func(profile string) {
			recorder := api.request(http.MethodPut, base+"?profile="+profile,
				putBookSettingsBody(fileVersion, "0", `{"reflow":{"fontSize":20}}`), true, true, nil)
			statuses <- recorder.Code
		}(profile)
	}
	results := []int{<-statuses, <-statuses}
	okCount, conflictCount := 0, 0
	for _, status := range results {
		switch status {
		case http.StatusOK:
			okCount++
		case http.StatusConflict:
			conflictCount++
		default:
			t.Fatalf("并发 PUT 状态 = %v", results)
		}
	}
	if okCount != 1 || conflictCount != 1 {
		t.Fatalf("并发 PUT 状态 = %v, want 一个 200 一个 409", results)
	}

	webDTO := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base+"?profile=web", "", true, false, nil))
	mobileDTO := decodeData[readersettings.BookDTO](t, api.request(http.MethodGet, base+"?profile=mobile", "", true, false, nil))
	if webDTO.Revision != "1" || mobileDTO.Revision != "1" {
		t.Fatalf("并发后 revision = web %s mobile %s", webDTO.Revision, mobileDTO.Revision)
	}
	if len(webDTO.Overrides)+len(mobileDTO.Overrides) != 1 {
		t.Fatalf("并发后覆盖 = web %+v mobile %+v", webDTO.Overrides, mobileDTO.Overrides)
	}
}

func assertPDFManualDefault(t *testing.T, dto readersettings.BookDTO) {
	t.Helper()
	pdf := dto.EffectiveValues["pdf"].(map[string]any)
	if pdf["zoomMode"] != "manual" || pdf["manualScale"] != float64(1) {
		t.Fatalf("PDF 默认缩放 = %+v", pdf)
	}
	if settingSource(dto, "pdf", "zoomMode") != "built-in" ||
		settingSource(dto, "pdf", "manualScale") != "built-in" {
		t.Fatalf("PDF 默认来源 = %+v", dto.FieldSources["pdf"])
	}
}

func assertNoReaderStorageLeak(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	body := recorder.Body.String()
	for _, forbidden := range []string{"SELECT", "sql:", "overrides_json", "book_reader_overrides", "/iread", "iread.db"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("错误响应泄露 %q: %s", forbidden, body)
		}
	}
}
