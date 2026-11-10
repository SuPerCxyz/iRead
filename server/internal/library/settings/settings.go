// Package settings 定义书库视图设置（app_settings."group"='library'）的
// 版本化 DTO、默认值与严格校验。该包不访问数据库或 HTTP。
package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

const (
	// SchemaVersion 是书库视图设置 schema 版本。
	SchemaVersion int64 = 1
	// Group 是 app_settings 中书库视图设置的分组键。
	Group = "library"
	// BuiltInVersion 是内置默认值版本；默认字段变化时递增。
	BuiltInVersion int64 = 1
)

// Columns 表示列数：auto 或 2–8 的整数。JSON 输出为 "auto" 或 number。
type Columns struct {
	Auto  bool
	Count int
}

// MarshalJSON 输出契约要求的字符串或 JSON number。
func (c Columns) MarshalJSON() ([]byte, error) {
	if c.Auto {
		return []byte(`"auto"`), nil
	}
	return []byte(strconv.Itoa(c.Count)), nil
}

// UnmarshalJSON 仅接受 "auto" 或 2–8 的 JSON 整数。
func (c *Columns) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if bytes.Equal(trimmed, []byte(`"auto"`)) {
		c.Auto = true
		c.Count = 0
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return fmt.Errorf("columns 必须是 \"auto\" 或 2–8 的整数")
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("columns 必须是单个 JSON 值")
	}
	number, ok := raw.(json.Number)
	if !ok {
		return fmt.Errorf("columns 必须是 \"auto\" 或 2–8 的整数")
	}
	text := number.String()
	if strings.ContainsAny(text, ".eE+") {
		return fmt.Errorf("columns 必须是 \"auto\" 或 2–8 的整数")
	}
	count, err := strconv.Atoi(text)
	if err != nil || count < 2 || count > 8 {
		return fmt.Errorf("columns 必须是 \"auto\" 或 2–8 的整数")
	}
	c.Auto = false
	c.Count = count
	return nil
}

// Valid 报告 Columns 是否处于合法状态。
func (c Columns) Valid() bool {
	if c.Auto {
		return c.Count == 0
	}
	return c.Count >= 2 && c.Count <= 8
}

// Value 是书库视图设置的完整值；所有字段必填。
type Value struct {
	ViewMode     string  `json:"viewMode"`
	Density      string  `json:"density"`
	Columns      Columns `json:"columns"`
	ShowAuthors  bool    `json:"showAuthors"`
	ShowProgress bool    `json:"showProgress"`
	ShowFormat   bool    `json:"showFormat"`
	ShowSubtitle bool    `json:"showSubtitle"`
	CoverRatio   string  `json:"coverRatio"`
	CoverRadius  string  `json:"coverRadius"`
	CardGap      string  `json:"cardGap"`
}

// Record 是 store 层与 DTO 层共用的持久化投影。
type Record struct {
	SchemaVersion int64
	Revision      int64
	UpdatedAt     *time.Time
	Value         json.RawMessage
}

// DTO 是 GET/PUT /api/v1/settings/library 的数据形状。
type DTO struct {
	SchemaVersion int64   `json:"schemaVersion"`
	Revision      string  `json:"revision"`
	UpdatedAt     *string `json:"updatedAt"`
	Value         Value   `json:"value"`
}

// ValidationError 是可安全返回给调用方的设置值错误；HTTP 层通常映射为 422。
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "书库设置值无效"
}

func invalid(field, message string) *ValidationError {
	return &ValidationError{Field: field, Message: message}
}

// DefaultValue 返回书库视图设置默认值。
func DefaultValue() Value {
	return Value{
		ViewMode:     "grid",
		Density:      "standard",
		Columns:      Columns{Auto: true},
		ShowAuthors:  true,
		ShowProgress: true,
		ShowFormat:   true,
		ShowSubtitle: false,
		CoverRatio:   "original",
		CoverRadius:  "md",
		CardGap:      "standard",
	}
}

// DefaultJSON 返回默认值的规范 JSON。
func DefaultJSON() json.RawMessage {
	raw, err := json.Marshal(DefaultValue())
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return raw
}

type valueWire struct {
	ViewMode     *string  `json:"viewMode"`
	Density      *string  `json:"density"`
	Columns      *Columns `json:"columns"`
	ShowAuthors  *bool    `json:"showAuthors"`
	ShowProgress *bool    `json:"showProgress"`
	ShowFormat   *bool    `json:"showFormat"`
	ShowSubtitle *bool    `json:"showSubtitle"`
	CoverRatio   *string  `json:"coverRatio"`
	CoverRadius  *string  `json:"coverRadius"`
	CardGap      *string  `json:"cardGap"`
}

// ParseValue 严格解析并校验完整 value，拒绝未知字段、缺失字段与非法值。
func ParseValue(raw []byte) (Value, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Value{}, invalid("value", "缺少 value")
	}
	var wire valueWire
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&wire); err != nil {
		return Value{}, invalid("value", "value 不是合法的书库设置对象")
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Value{}, invalid("value", "value 后存在多余内容")
	}
	missing := func(field string) error {
		return invalid(field, "缺少必填字段 "+field)
	}
	if wire.ViewMode == nil {
		return Value{}, missing("viewMode")
	}
	if wire.Density == nil {
		return Value{}, missing("density")
	}
	if wire.Columns == nil {
		return Value{}, missing("columns")
	}
	if wire.ShowAuthors == nil {
		return Value{}, missing("showAuthors")
	}
	if wire.ShowProgress == nil {
		return Value{}, missing("showProgress")
	}
	if wire.ShowFormat == nil {
		return Value{}, missing("showFormat")
	}
	if wire.ShowSubtitle == nil {
		return Value{}, missing("showSubtitle")
	}
	if wire.CoverRatio == nil {
		return Value{}, missing("coverRatio")
	}
	if wire.CoverRadius == nil {
		return Value{}, missing("coverRadius")
	}
	if wire.CardGap == nil {
		return Value{}, missing("cardGap")
	}
	value := Value{
		ViewMode:     *wire.ViewMode,
		Density:      *wire.Density,
		Columns:      *wire.Columns,
		ShowAuthors:  *wire.ShowAuthors,
		ShowProgress: *wire.ShowProgress,
		ShowFormat:   *wire.ShowFormat,
		ShowSubtitle: *wire.ShowSubtitle,
		CoverRatio:   *wire.CoverRatio,
		CoverRadius:  *wire.CoverRadius,
		CardGap:      *wire.CardGap,
	}
	if err := value.Validate(); err != nil {
		return Value{}, err
	}
	return value, nil
}

// Validate 校验全部枚举与 columns 范围。
func (v Value) Validate() error {
	if !oneOf(v.ViewMode, "grid", "list") {
		return invalid("viewMode", "viewMode 仅支持 grid/list")
	}
	if !oneOf(v.Density, "compact", "standard", "relaxed") {
		return invalid("density", "density 仅支持 compact/standard/relaxed")
	}
	if !v.Columns.Valid() {
		return invalid("columns", "columns 仅支持 \"auto\" 或 2–8 的整数")
	}
	if !oneOf(v.CoverRatio, "original", "2:3", "3:4") {
		return invalid("coverRatio", "coverRatio 仅支持 original/2:3/3:4")
	}
	if !oneOf(v.CoverRadius, "none", "sm", "md", "lg") {
		return invalid("coverRadius", "coverRadius 仅支持 none/sm/md/lg")
	}
	if !oneOf(v.CardGap, "compact", "standard", "relaxed") {
		return invalid("cardGap", "cardGap 仅支持 compact/standard/relaxed")
	}
	return nil
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

// NormalizeStoredValue 解析并重新序列化，保证落库 JSON 稳定且已校验。
func NormalizeStoredValue(raw []byte) (json.RawMessage, error) {
	value, err := ParseValue(raw)
	if err != nil {
		return nil, err
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("书库设置序列化失败: %w", err)
	}
	return normalized, nil
}

// RecordDTO 把持久化记录转为 API DTO。
func RecordDTO(record Record) (DTO, error) {
	value, err := ParseValue(record.Value)
	if err != nil {
		return DTO{}, err
	}
	dto := DTO{
		SchemaVersion: record.SchemaVersion,
		Revision:      strconv.FormatInt(record.Revision, 10),
		Value:         value,
	}
	if record.UpdatedAt != nil {
		formatted := record.UpdatedAt.UTC().Format(time.RFC3339)
		dto.UpdatedAt = &formatted
	}
	return dto, nil
}
