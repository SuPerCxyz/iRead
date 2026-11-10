package settings

import (
	"encoding/json"
	"errors"
	"testing"
)

const validAppearanceJSON = `{
	"themeMode":"system",
	"lightPreset":"template",
	"darkPreset":"template",
	"accent":"default",
	"density":"standard",
	"contentWidth":"auto",
	"navCompact":false
}`

func TestParseAppearanceValueValid(t *testing.T) {
	value, err := ParseAppearanceValue([]byte(validAppearanceJSON))
	if err != nil {
		t.Fatalf("ParseAppearanceValue() error = %v", err)
	}
	if value.ThemeMode != "system" || !value.ContentWidth.Auto || value.NavCompact {
		t.Fatalf("解析结果不符合预期: %+v", value)
	}

	custom := `{
		"themeMode":"dark",
		"lightPreset":"paper",
		"darkPreset":"midnight",
		"accent":"#3366cc",
		"density":"relaxed",
		"contentWidth":75,
		"navCompact":true
	}`
	value, err = ParseAppearanceValue([]byte(custom))
	if err != nil {
		t.Fatalf("自定义值被拒绝: %v", err)
	}
	if value.ContentWidth.Auto || value.ContentWidth.Percent != 75 || !value.NavCompact {
		t.Fatalf("自定义值解析错误: %+v", value)
	}

	for _, width := range []string{`50`, `100`} {
		raw := `{"themeMode":"light","lightPreset":"white","darkPreset":"gray","accent":"blue","density":"compact","contentWidth":` + width + `,"navCompact":true}`
		if _, err := ParseAppearanceValue([]byte(raw)); err != nil {
			t.Fatalf("contentWidth %s 被拒绝: %v", width, err)
		}
	}

	highContrast := `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"#2563eb","density":"standard","contentWidth":"auto","navCompact":false}`
	if _, err := ParseAppearanceValue([]byte(highContrast)); err != nil {
		t.Fatalf("高对比度自定义强调色被拒绝: %v", err)
	}
}

func TestParseAppearanceValueRejectsMissingFields(t *testing.T) {
	fields := []string{"themeMode", "lightPreset", "darkPreset", "accent", "density", "contentWidth", "navCompact"}
	for _, field := range fields {
		var document map[string]any
		if err := json.Unmarshal([]byte(validAppearanceJSON), &document); err != nil {
			t.Fatal(err)
		}
		delete(document, field)
		raw, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseAppearanceValue(raw); err == nil {
			t.Fatalf("缺失 %s 未被拒绝", field)
		}
	}
}

func TestParseAppearanceValueRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{"未知字段", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":"auto","navCompact":false,"extra":1}`},
		{"themeMode", `{"themeMode":"sepia","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"lightPreset", `{"themeMode":"system","lightPreset":"gray","darkPreset":"template","accent":"default","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"darkPreset", `{"themeMode":"system","lightPreset":"template","darkPreset":"black","accent":"default","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"accent 枚举", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"red","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"accent 大写", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"#ABCDEF","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"accent 短格式", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"#fff","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"accent 与白色对比度不足", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"#ffffff","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"accent 与多主题背景对比度不足", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"#5f5f5f","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"accent 与近黑对比度不足", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"#0000ff","density":"standard","contentWidth":"auto","navCompact":false}`},
		{"density", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"wide","contentWidth":"auto","navCompact":false}`},
		{"contentWidth 49", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":49,"navCompact":false}`},
		{"contentWidth 101", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":101,"navCompact":false}`},
		{"contentWidth 小数", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":50.5,"navCompact":false}`},
		{"contentWidth 字符串数字", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":"50","navCompact":false}`},
		{"contentWidth null", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":null,"navCompact":false}`},
		{"navCompact 类型", `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":"auto","navCompact":"false"}`},
		{"value 不是对象", `[]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ParseAppearanceValue([]byte(test.raw)); err == nil {
				t.Fatalf("非法值未被拒绝: %s", test.raw)
			}
		})
	}
}

func TestAccentContrastErrorField(t *testing.T) {
	raw := `{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"#ffffff","density":"standard","contentWidth":"auto","navCompact":false}`
	_, err := ParseAppearanceValue([]byte(raw))
	var validation *ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("错误类型 = %T", err)
	}
	if validation.Field != "accent" {
		t.Fatalf("field = %q", validation.Field)
	}
}

func TestDefaultAppearanceRecord(t *testing.T) {
	record := DefaultAppearanceRecord()
	if record.SchemaVersion != 1 || record.Revision != "0" || record.UpdatedAt != nil {
		t.Fatalf("默认记录元数据错误: %+v", record)
	}
	if err := record.Value.Validate(); err != nil {
		t.Fatalf("默认值非法: %v", err)
	}
	marshaled, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	const expected = `{"schemaVersion":1,"revision":"0","updatedAt":null,"value":{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":"auto","navCompact":false}}`
	if string(marshaled) != expected {
		t.Fatalf("默认记录 JSON = %s", marshaled)
	}
}

func TestRevisionParsing(t *testing.T) {
	valid := map[string]int64{"0": 0, "1": 1, "17": 17, "9223372036854775807": 9223372036854775807}
	for text, expected := range valid {
		revision, err := ParseRevision(text)
		if err != nil || revision != expected {
			t.Fatalf("ParseRevision(%q) = %d, %v", text, revision, err)
		}
	}
	for _, text := range []string{"", "-1", "+1", "01", "1.0", "1e3", "abc", "9223372036854775808"} {
		if _, err := ParseRevision(text); err == nil {
			t.Fatalf("ParseRevision(%q) 未拒绝", text)
		}
	}
}
