// Package settings 定义阶段1版本化的应用外观设置模型与严格校验。
package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	// AppearanceGroup 是 app_settings 中外观设置的分组键。
	AppearanceGroup = "appearance"
	// AppearanceSchemaVersion 是阶段1外观设置的 schema 版本。
	AppearanceSchemaVersion = 1
)

// ContentWidth 表示 contentWidth：字符串 "auto" 或 50–100 的整数百分比。
type ContentWidth struct {
	Auto    bool
	Percent int
}

// MarshalJSON 输出契约要求的字符串或 JSON number。
func (c ContentWidth) MarshalJSON() ([]byte, error) {
	if c.Auto {
		return []byte(`"auto"`), nil
	}
	return []byte(strconv.Itoa(c.Percent)), nil
}

// UnmarshalJSON 仅接受 "auto" 或 50–100 的 JSON 整数，拒绝小数、字符串数字与布尔值。
func (c *ContentWidth) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte(`"auto"`)) {
		c.Auto = true
		c.Percent = 0
		return nil
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return fmt.Errorf("contentWidth 必须是 \"auto\" 或 50–100 的整数")
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("contentWidth 必须是单个 JSON 值")
	}

	num, ok := raw.(json.Number)
	if !ok {
		return fmt.Errorf("contentWidth 必须是 \"auto\" 或 50–100 的整数")
	}
	text := num.String()
	if strings.ContainsAny(text, ".eE+") {
		return fmt.Errorf("contentWidth 必须是 \"auto\" 或 50–100 的整数")
	}
	n, err := strconv.Atoi(text)
	if err != nil {
		return fmt.Errorf("contentWidth 必须是 \"auto\" 或 50–100 的整数")
	}
	if n < 50 || n > 100 {
		return fmt.Errorf("contentWidth 必须在 50 到 100 之间")
	}
	c.Auto = false
	c.Percent = n
	return nil
}

// Valid 报告 ContentWidth 是否处于合法状态。
func (c ContentWidth) Valid() bool {
	if c.Auto {
		return c.Percent == 0
	}
	return c.Percent >= 50 && c.Percent <= 100
}

// AppearanceValue 是阶段1完整外观值；所有字段必填。
type AppearanceValue struct {
	ThemeMode    string       `json:"themeMode"`
	LightPreset  string       `json:"lightPreset"`
	DarkPreset   string       `json:"darkPreset"`
	Accent       string       `json:"accent"`
	Density      string       `json:"density"`
	ContentWidth ContentWidth `json:"contentWidth"`
	NavCompact   bool         `json:"navCompact"`
}

// AppearanceRecord 是 API 与存储层共用的版本化记录。
type AppearanceRecord struct {
	SchemaVersion int             `json:"schemaVersion"`
	Revision      string          `json:"revision"`
	UpdatedAt     *string         `json:"updatedAt"`
	Value         AppearanceValue `json:"value"`
}

// ValidationError 表示可安全返回给调用方的输入校验失败。
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "设置值无效"
}

// DefaultAppearanceValue 返回阶段1默认外观。
func DefaultAppearanceValue() AppearanceValue {
	return AppearanceValue{
		ThemeMode:    "system",
		LightPreset:  "template",
		DarkPreset:   "template",
		Accent:       "default",
		Density:      "standard",
		ContentWidth: ContentWidth{Auto: true},
		NavCompact:   false,
	}
}

// DefaultAppearanceRecord 返回无持久化行时的默认记录。
func DefaultAppearanceRecord() AppearanceRecord {
	return AppearanceRecord{
		SchemaVersion: AppearanceSchemaVersion,
		Revision:      "0",
		UpdatedAt:     nil,
		Value:         DefaultAppearanceValue(),
	}
}

// appearanceValueWire 用指针区分“字段缺失”和零值。
type appearanceValueWire struct {
	ThemeMode    *string       `json:"themeMode"`
	LightPreset  *string       `json:"lightPreset"`
	DarkPreset   *string       `json:"darkPreset"`
	Accent       *string       `json:"accent"`
	Density      *string       `json:"density"`
	ContentWidth *ContentWidth `json:"contentWidth"`
	NavCompact   *bool         `json:"navCompact"`
}

// ParseAppearanceValue 严格解析并校验外观 value，拒绝未知字段、缺失字段与非法值。
func ParseAppearanceValue(raw []byte) (AppearanceValue, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return AppearanceValue{}, &ValidationError{Field: "value", Message: "缺少 value"}
	}

	var wire appearanceValueWire
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&wire); err != nil {
		return AppearanceValue{}, &ValidationError{Field: "value", Message: "value 不是合法的外观对象"}
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return AppearanceValue{}, &ValidationError{Field: "value", Message: "value 后存在多余内容"}
	}

	missing := func(field string) error {
		return &ValidationError{Field: field, Message: "缺少必填字段 " + field}
	}
	if wire.ThemeMode == nil {
		return AppearanceValue{}, missing("themeMode")
	}
	if wire.LightPreset == nil {
		return AppearanceValue{}, missing("lightPreset")
	}
	if wire.DarkPreset == nil {
		return AppearanceValue{}, missing("darkPreset")
	}
	if wire.Accent == nil {
		return AppearanceValue{}, missing("accent")
	}
	if wire.Density == nil {
		return AppearanceValue{}, missing("density")
	}
	if wire.ContentWidth == nil {
		return AppearanceValue{}, missing("contentWidth")
	}
	if wire.NavCompact == nil {
		return AppearanceValue{}, missing("navCompact")
	}

	value := AppearanceValue{
		ThemeMode:    *wire.ThemeMode,
		LightPreset:  *wire.LightPreset,
		DarkPreset:   *wire.DarkPreset,
		Accent:       *wire.Accent,
		Density:      *wire.Density,
		ContentWidth: *wire.ContentWidth,
		NavCompact:   *wire.NavCompact,
	}
	if err := value.Validate(); err != nil {
		return AppearanceValue{}, err
	}
	return value, nil
}

var lowercaseHexColor = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// Validate 校验所有枚举、范围及自定义强调色对比度。
func (v AppearanceValue) Validate() error {
	if !oneOf(v.ThemeMode, "system", "light", "dark") {
		return &ValidationError{Field: "themeMode", Message: "themeMode 仅支持 system/light/dark"}
	}
	if !oneOf(v.LightPreset, "template", "paper", "white") {
		return &ValidationError{Field: "lightPreset", Message: "lightPreset 仅支持 template/paper/white"}
	}
	if !oneOf(v.DarkPreset, "template", "gray", "midnight") {
		return &ValidationError{Field: "darkPreset", Message: "darkPreset 仅支持 template/gray/midnight"}
	}
	switch {
	case oneOf(v.Accent, "default", "blue", "green"):
	case lowercaseHexColor.MatchString(v.Accent):
		if !accentHasContrast(v.Accent) {
			return &ValidationError{Field: "accent", Message: "强调色与背景对比度不足"}
		}
	default:
		return &ValidationError{Field: "accent", Message: "accent 仅支持 default/blue/green 或小写 #rrggbb"}
	}
	if !oneOf(v.Density, "compact", "standard", "relaxed") {
		return &ValidationError{Field: "density", Message: "density 仅支持 compact/standard/relaxed"}
	}
	if !v.ContentWidth.Valid() {
		return &ValidationError{Field: "contentWidth", Message: "contentWidth 必须为 \"auto\" 或 50–100 的整数"}
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

// accentHasContrast 要求强调色与所有固定主题背景的 WCAG 对比度均不低于 3.0。
func accentHasContrast(color string) bool {
	luminance := relativeLuminance(color)
	for _, background := range accentBackgrounds {
		if contrastRatio(luminance, relativeLuminance(background)) < 3.0 {
			return false
		}
	}
	return true
}

// accentBackgrounds 是阶段1模板浅色/深色分支的实际背景色。
var accentBackgrounds = []string{
	"#ffffff", // neutral light
	"#f5f5f4", // stone light（暖纸）
	"#0a0a0a", // neutral dark
	"#18181b", // zinc dark（深灰）
	"#0f172a", // slate dark（深蓝黑）
}

func relativeLuminance(color string) float64 {
	channels := make([]float64, 3)
	for i := 0; i < 3; i++ {
		raw, _ := strconv.ParseInt(color[1+i*2:3+i*2], 16, 64)
		channels[i] = linearize(float64(raw) / 255)
	}
	return 0.2126*channels[0] + 0.7152*channels[1] + 0.0722*channels[2]
}

func linearize(channel float64) float64 {
	if channel <= 0.04045 {
		return channel / 12.92
	}
	return math.Pow((channel+0.055)/1.055, 2.4)
}

func contrastRatio(a, b float64) float64 {
	if a < b {
		a, b = b, a
	}
	return (a + 0.05) / (b + 0.05)
}

// ParseRevision 解析十进制 revision 字符串；拒绝符号、前导零与溢出。
func ParseRevision(text string) (int64, error) {
	if text == "" {
		return 0, &ValidationError{Field: "baseRevision", Message: "缺少 baseRevision"}
	}
	if len(text) > 1 && text[0] == '0' {
		return 0, &ValidationError{Field: "baseRevision", Message: "baseRevision 格式无效"}
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return 0, &ValidationError{Field: "baseRevision", Message: "baseRevision 格式无效"}
		}
	}
	revision, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return 0, &ValidationError{Field: "baseRevision", Message: "baseRevision 超出范围"}
	}
	return revision, nil
}

// FormatRevision 将整数 revision 转为十进制字符串。
func FormatRevision(revision int64) string {
	return strconv.FormatInt(revision, 10)
}
