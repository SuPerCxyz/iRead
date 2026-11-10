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
	if _, err := BookDTOFrom("book", "version", Record{SchemaVersion: SchemaVersion, Value: bad}, Record{SchemaVersion: SchemaVersion, Value: empty}); err == nil {
		t.Fatal("单书读取未拒绝低对比度覆盖")
	}
	if _, err := BookDTOFrom("book", "version", Record{SchemaVersion: SchemaVersion, Value: empty}, Record{SchemaVersion: SchemaVersion, Revision: 1, Value: bad}); err == nil {
		t.Fatal("单书读取未拒绝低对比度全局值")
	}
}
