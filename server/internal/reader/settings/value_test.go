package settings

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestParseColorContrastAcceptsValidPairs(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"text-background", `{"reflow":{"text":"#767676","background":"#ffffff"}}`},
		{"text-background-max", `{"reflow":{"text":"#000000","background":"#ffffff"}}`},
		{"link-background", `{"reflow":{"link":"#1a0dab","background":"#ffffff"}}`},
		{"selection-text", `{"reflow":{"selection":"#000000","text":"#ffffff"}}`},
		{"preset-text", `{"reflow":{"text":"white","background":"#ffffff"}}`},
		{"preset-background", `{"reflow":{"text":"#777777","background":"white"}}`},
		{"preset-selection", `{"reflow":{"selection":"inherit","text":"#777777"}}`},
		{"missing-background", `{"reflow":{"text":"#777777"}}`},
		{"missing-text", `{"reflow":{"selection":"#777777"}}`},
		{"only-background", `{"reflow":{"background":"#777777"}}`},
		{"pdf-background", `{"pdf":{"background":"#777777"}}`},
		{"comic-background", `{"comic":{"background":"#777777"}}`},
	}
	parsers := []struct {
		name  string
		parse func([]byte) (map[string]any, error)
	}{
		{"global", ParseGlobalValue},
		{"overrides", ParseOverrides},
	}
	for _, parser := range parsers {
		for _, tc := range cases {
			t.Run(parser.name+"/"+tc.name, func(t *testing.T) {
				if _, err := parser.parse([]byte(tc.raw)); err != nil {
					t.Fatalf("%s = %v", tc.raw, err)
				}
			})
		}
	}
}

func TestParseColorContrastRejectsLowContrastPairs(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		field string
		pair  []string
	}{
		{
			name:  "text-background",
			raw:   `{"reflow":{"text":"#777777","background":"#ffffff"}}`,
			field: "reflow.text",
			pair:  []string{"reflow.text", "reflow.background"},
		},
		{
			name:  "link-background",
			raw:   `{"reflow":{"link":"#888888","background":"#ffffff"}}`,
			field: "reflow.link",
			pair:  []string{"reflow.link", "reflow.background"},
		},
		{
			name:  "selection-text",
			raw:   `{"reflow":{"selection":"#777777","text":"#ffffff"}}`,
			field: "reflow.selection",
			pair:  []string{"reflow.text", "reflow.selection"},
		},
		{
			name:  "dark-text-dark-background",
			raw:   `{"reflow":{"text":"#000000","background":"#222222"}}`,
			field: "reflow.text",
			pair:  []string{"reflow.text", "reflow.background"},
		},
	}
	parsers := []struct {
		name  string
		parse func([]byte) (map[string]any, error)
	}{
		{"global", ParseGlobalValue},
		{"overrides", ParseOverrides},
	}
	for _, parser := range parsers {
		for _, tc := range cases {
			t.Run(parser.name+"/"+tc.name, func(t *testing.T) {
				_, err := parser.parse([]byte(tc.raw))
				if err == nil {
					t.Fatalf("%s 未被拒绝", tc.raw)
				}
				var validation *ValidationError
				if !errors.As(err, &validation) {
					t.Fatalf("错误类型 = %T, want *ValidationError", err)
				}
				if validation.Field != tc.field {
					t.Fatalf("field = %q, want %q", validation.Field, tc.field)
				}
				if !strings.Contains(validation.Message, "对比度") ||
					!strings.Contains(validation.Message, "4.5") {
					t.Fatalf("message = %q", validation.Message)
				}
				pair, ok := validation.Details["pair"].([]string)
				if !ok || !slices.Equal(pair, tc.pair) {
					t.Fatalf("details.pair = %#v, want %#v", validation.Details["pair"], tc.pair)
				}
				ratio, ok := validation.Details["ratio"].(float64)
				if !ok || ratio <= 0 || ratio >= minimumReaderContrast {
					t.Fatalf("details.ratio = %#v, want (0, %.1f)", validation.Details["ratio"], minimumReaderContrast)
				}
				if minimum, ok := validation.Details["minimum"].(float64); !ok || minimum != minimumReaderContrast {
					t.Fatalf("details.minimum = %#v", validation.Details["minimum"])
				}
			})
		}
	}
}

func TestStoredValueWithLowContrastIsRejectedOnRead(t *testing.T) {
	bad := json.RawMessage(`{"reflow":{"text":"#777777","background":"#ffffff"}}`)
	empty := json.RawMessage(`{}`)

	if _, err := GlobalDTOFrom(Record{SchemaVersion: SchemaVersion, Revision: 1, Value: bad}); err == nil {
		t.Fatal("全局读取未拒绝低对比度颜色")
	} else {
		var validation *ValidationError
		if !errors.As(err, &validation) || validation.Field != "reflow.text" {
			t.Fatalf("全局读取错误 = %v", err)
		}
	}
	if _, err := BookDTOFrom("book", "version", Record{SchemaVersion: SchemaVersion, Value: bad}, Record{SchemaVersion: SchemaVersion, Value: empty}, ProfileWeb); err == nil {
		t.Fatal("单书读取未拒绝低对比度覆盖")
	}
	if _, err := BookDTOFrom("book", "version", Record{SchemaVersion: SchemaVersion, Value: empty}, Record{SchemaVersion: SchemaVersion, Revision: 1, Value: bad}, ProfileWeb); err == nil {
		t.Fatal("单书读取未拒绝低对比度全局值")
	}
}

func TestParseProfile(t *testing.T) {
	for _, value := range []string{"web", "mobile"} {
		profile, ok := ParseProfile(value)
		if !ok || string(profile) != value || !profile.Valid() {
			t.Fatalf("ParseProfile(%q) = %q, %v", value, profile, ok)
		}
	}
	for _, value := range []string{"", "WEB", "tablet", "desktop"} {
		if profile, ok := ParseProfile(value); ok || profile != "" {
			t.Fatalf("ParseProfile(%q) = %q, %v", value, profile, ok)
		}
	}
}

func TestProfileOverridesLegacyAndEnvelope(t *testing.T) {
	legacy := []byte(`{"pdf":{"zoomMode":"fit-width","manualScale":1.25},"reflow":{"fontSize":22}}`)
	for _, profile := range []Profile{ProfileWeb, ProfileMobile} {
		got, err := ProfileOverrides(legacy, profile)
		if err != nil {
			t.Fatalf("ProfileOverrides legacy %s: %v", profile, err)
		}
		if got["pdf"].(map[string]any)["zoomMode"] != "fit-width" ||
			got["reflow"].(map[string]any)["fontSize"] != json.Number("22") {
			t.Fatalf("legacy %s = %+v", profile, got)
		}
	}

	envelope := []byte(`{"schemaVersion":1,"profiles":{"web":{"pdf":{"zoomMode":"fit-page"}},"mobile":{}}}`)
	web, err := ProfileOverrides(envelope, ProfileWeb)
	if err != nil {
		t.Fatal(err)
	}
	if web["pdf"].(map[string]any)["zoomMode"] != "fit-page" {
		t.Fatalf("web envelope = %+v", web)
	}
	mobile, err := ProfileOverrides(envelope, ProfileMobile)
	if err != nil {
		t.Fatal(err)
	}
	if len(mobile) != 0 {
		t.Fatalf("mobile envelope = %+v", mobile)
	}
	missing, err := ProfileOverrides([]byte(`{"schemaVersion":1,"profiles":{"web":{}}}`), ProfileMobile)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 0 {
		t.Fatalf("缺失 profile = %+v", missing)
	}

	if _, err := ProfileOverrides(legacy, Profile("tablet")); err == nil {
		t.Fatal("非法 profile 未被拒绝")
	}
	if _, err := ProfileOverrides([]byte(`{"schemaVersion":1,"profiles":[]}`), ProfileWeb); err == nil {
		t.Fatal("非法 profiles 未被拒绝")
	}
	if _, err := ProfileOverrides([]byte(`{"schemaVersion":2,"profiles":{}}`), ProfileWeb); err == nil {
		t.Fatal("未知信封 schemaVersion 未被拒绝")
	}
}

func TestMergeProfileOverridesLegacyCopiesBothProfiles(t *testing.T) {
	legacy := []byte(`{"pdf":{"zoomMode":"fit-width","manualScale":1.25},"reflow":{"fontSize":22}}`)
	merged, err := MergeProfileOverrides(legacy, ProfileWeb,
		[]byte(`{"pdf":{"zoomMode":"manual","manualScale":1.5}}`))
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		SchemaVersion int64                      `json:"schemaVersion"`
		Profiles      map[string]json.RawMessage `json:"profiles"`
	}
	if err := json.Unmarshal(merged, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.SchemaVersion != SchemaVersion || len(envelope.Profiles) != 2 {
		t.Fatalf("合并信封 = %s", merged)
	}
	var web, mobile map[string]any
	if err := json.Unmarshal(envelope.Profiles["web"], &web); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(envelope.Profiles["mobile"], &mobile); err != nil {
		t.Fatal(err)
	}
	if web["pdf"].(map[string]any)["zoomMode"] != "manual" {
		t.Fatalf("web = %+v", web)
	}
	if mobile["pdf"].(map[string]any)["zoomMode"] != "fit-width" ||
		mobile["reflow"].(map[string]any)["fontSize"] != float64(22) {
		t.Fatalf("mobile = %+v", mobile)
	}

	// 第二次写入 mobile 不得改动 web；空对象只清 mobile。
	merged, err = MergeProfileOverrides(merged, ProfileMobile, []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(merged, &envelope); err != nil {
		t.Fatal(err)
	}
	var webAgain, mobileAgain map[string]any
	if err := json.Unmarshal(envelope.Profiles["web"], &webAgain); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(envelope.Profiles["mobile"], &mobileAgain); err != nil {
		t.Fatal(err)
	}
	if webAgain["pdf"].(map[string]any)["zoomMode"] != "manual" || len(mobileAgain) != 0 {
		t.Fatalf("二次合并 = web %+v mobile %+v", webAgain, mobileAgain)
	}

	if _, err := MergeProfileOverrides(legacy, ProfileWeb, []byte(`{"pdf":{"zoomMode":null}}`)); err == nil {
		t.Fatal("null 覆盖未被拒绝")
	}
	if _, err := MergeProfileOverrides([]byte(`{"profiles":null}`), ProfileWeb, []byte(`{}`)); err == nil {
		t.Fatal("null profiles 未被拒绝")
	}
}

func TestBookDTOFromProfileAndBuiltInDefault(t *testing.T) {
	global := Record{SchemaVersion: SchemaVersion, Value: json.RawMessage(`{}`)}
	legacy := Record{SchemaVersion: SchemaVersion, Value: json.RawMessage(`{"pdf":{"zoomMode":"fit-width"}}`)}
	for _, profile := range []Profile{ProfileWeb, ProfileMobile} {
		dto, err := BookDTOFrom("book", "version", legacy, global, profile)
		if err != nil {
			t.Fatal(err)
		}
		if dto.Profile != string(profile) ||
			dto.EffectiveValues["pdf"].(map[string]any)["zoomMode"] != "fit-width" ||
			dto.FieldSources["pdf"]["zoomMode"] != "book" {
			t.Fatalf("%s legacy DTO = %+v", profile, dto)
		}
	}
	dto, err := BookDTOFrom("book", "version", Record{SchemaVersion: SchemaVersion, Value: json.RawMessage(`{}`)}, global, "")
	if err != nil {
		t.Fatal(err)
	}
	pdf := dto.EffectiveValues["pdf"].(map[string]any)
	if dto.Profile != "web" || pdf["zoomMode"] != "manual" || pdf["manualScale"] != 1.0 ||
		dto.FieldSources["pdf"]["zoomMode"] != "built-in" ||
		dto.FieldSources["pdf"]["manualScale"] != "built-in" {
		t.Fatalf("默认 PDF DTO = %+v", dto)
	}
}
