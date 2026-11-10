package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	readersettings "iread/server/internal/reader/settings"
)

func TestReaderBookSettingsAcceptsFrontendShapeAndAlias(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	target := "/api/v1/books/" + bookID + "/reader-overrides"
	legacy := "/api/v1/books/" + bookID + "/reader-settings"
	overrides := `{"reflow":{"fontFamily":"serif","fontSize":17,"lineHeight":1.7,` +
		`"paragraphSpacing":0.2,"textIndent":0.5,"align":"justify","horizontalMargin":7,` +
		`"verticalMargin":5,"maxWidth":"60","pagination":"scroll","columns":"2",` +
		`"animation":"light","publisherCSSMode":"off"},` +
		`"pdf":{"layoutMode":"continuous","zoomMode":"manual","manualScale":1.25,` +
		`"gap":"compact","toolbarVisible":false,"background":"paper"},` +
		`"comic":{"direction":"rtl","mode":"double","fit":"width","gap":"relaxed","background":"white"}}`

	created := api.request(http.MethodPut, target, putBookSettingsBody(fileVersion, "0", overrides), true, true, nil)
	if created.Code != http.StatusOK {
		t.Fatalf("前端形状 PUT = %d, body=%s", created.Code, created.Body.String())
	}
	dto := decodeData[readersettings.BookDTO](t, created)
	if dto.Revision != "1" {
		t.Fatalf("前端形状 revision = %q", dto.Revision)
	}
	if settingSource(dto, "reflow", "align") != "book" ||
		settingSource(dto, "reflow", "columns") != "book" ||
		settingSource(dto, "pdf", "manualScale") != "book" ||
		settingSource(dto, "comic", "direction") != "book" {
		t.Fatalf("前端形状来源 = %+v", dto.FieldSources)
	}
	reflow := dto.EffectiveValues["reflow"].(map[string]any)
	if reflow["fontSize"] != float64(17) || reflow["columns"] != "2" ||
		reflow["maxWidth"] != "60" || reflow["pagination"] != "scroll" ||
		reflow["publisherCSSMode"] != "off" || reflow["align"] != "justify" {
		t.Fatalf("前端形状 effective = %+v", reflow)
	}
	pdf := dto.EffectiveValues["pdf"].(map[string]any)
	if pdf["manualScale"] != 1.25 || pdf["toolbarVisible"] != false || pdf["background"] != "paper" {
		t.Fatalf("PDF effective = %+v", pdf)
	}

	// 旧路径与任务指定路径共享同一资源，GET 返回同一 revision。
	legacyGet := api.request(http.MethodGet, legacy, "", true, false, nil)
	if legacyGet.Code != http.StatusOK {
		t.Fatalf("兼容路径 GET = %d", legacyGet.Code)
	}
	if legacyDTO := decodeData[readersettings.BookDTO](t, legacyGet); legacyDTO.Revision != "1" {
		t.Fatalf("兼容路径 revision = %q", legacyDTO.Revision)
	}

	reset := api.request(http.MethodPut, legacy, putBookSettingsBody(fileVersion, "1", `{}`), true, true, nil)
	if reset.Code != http.StatusOK {
		t.Fatalf("兼容路径空对象 = %d, body=%s", reset.Code, reset.Body.String())
	}
	var resetEnvelope struct {
		Data readersettings.BookDTO `json:"data"`
	}
	if err := json.Unmarshal(reset.Body.Bytes(), &resetEnvelope); err != nil {
		t.Fatal(err)
	}
	if resetEnvelope.Data.Revision != "2" || len(resetEnvelope.Data.Overrides) != 0 {
		t.Fatalf("空对象结果 = %+v", resetEnvelope.Data)
	}
}
