package settings

import (
	"reflect"
	"testing"
	"time"
)

func TestDefaultValueAndJSON(t *testing.T) {
	value := DefaultValue()
	if value.ViewMode != "grid" || value.Density != "standard" || !value.Columns.Auto ||
		!value.ShowAuthors || !value.ShowProgress || !value.ShowFormat || value.ShowSubtitle ||
		value.CoverRatio != "original" || value.CoverRadius != "md" || value.CardGap != "standard" {
		t.Fatalf("默认值 = %+v", value)
	}
	parsed, err := ParseValue(DefaultJSON())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(parsed, value) {
		t.Fatalf("默认 JSON 往返 = %+v", parsed)
	}
}

func TestParseValueColumnsAndValidation(t *testing.T) {
	base := `{"viewMode":"grid","density":"standard","columns":%s,"showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`
	for _, test := range []struct {
		name    string
		columns string
		want    Columns
	}{
		{name: "auto", columns: `"auto"`, want: Columns{Auto: true}},
		{name: "min", columns: `2`, want: Columns{Count: 2}},
		{name: "max", columns: `8`, want: Columns{Count: 8}},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := []byte(replaceColumns(base, test.columns))
			value, err := ParseValue(raw)
			if err != nil {
				t.Fatalf("ParseValue() error = %v", err)
			}
			if !reflect.DeepEqual(value.Columns, test.want) {
				t.Fatalf("columns = %+v，期望 %+v", value.Columns, test.want)
			}
		})
	}

	invalid := []string{
		`{"viewMode":"table","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"wide","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"standard","columns":1,"showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"standard","columns":9,"showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"standard","columns":"3","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"standard","columns":3.5,"showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"1:1","coverRadius":"md","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"xl","cardGap":"standard"}`,
		`{"viewMode":"grid","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"wide"}`,
		`{"viewMode":"grid","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"showSubtitle":false,"coverRatio":"original","coverRadius":"md","cardGap":"standard","extra":1}`,
		`{"viewMode":"grid","density":"standard","columns":"auto","showAuthors":true,"showProgress":true,"showFormat":true,"coverRatio":"original","coverRadius":"md","cardGap":"standard"}`,
	}
	for _, raw := range invalid {
		if _, err := ParseValue([]byte(raw)); err == nil {
			t.Fatalf("应当拒绝: %s", raw)
		}
	}
}

func replaceColumns(template, columns string) string {
	result := make([]byte, 0, len(template)+len(columns))
	for i := 0; i < len(template); i++ {
		if i+1 < len(template) && template[i] == '%' && template[i+1] == 's' {
			result = append(result, columns...)
			i++
			continue
		}
		result = append(result, template[i])
	}
	return string(result)
}

func TestRecordDTO(t *testing.T) {
	updated := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	record := Record{SchemaVersion: 1, Revision: 3, UpdatedAt: &updated, Value: DefaultJSON()}
	dto, err := RecordDTO(record)
	if err != nil {
		t.Fatal(err)
	}
	if dto.SchemaVersion != 1 || dto.Revision != "3" || dto.UpdatedAt == nil || *dto.UpdatedAt != "2026-11-10T12:00:00Z" {
		t.Fatalf("DTO = %+v", dto)
	}
	if !reflect.DeepEqual(dto.Value, DefaultValue()) {
		t.Fatalf("DTO value = %+v", dto.Value)
	}
	empty := Record{SchemaVersion: 1, Revision: 0, Value: DefaultJSON()}
	emptyDTO, err := RecordDTO(empty)
	if err != nil {
		t.Fatal(err)
	}
	if emptyDTO.Revision != "0" || emptyDTO.UpdatedAt != nil {
		t.Fatalf("空记录 DTO = %+v", emptyDTO)
	}
}
