package progress

// Locator 校验供进度与书签共用。这里只校验 locator 的结构、格式与枚举；
// 页号/章节是否存在于同一 fileVersion 的 manifest 由后续 manifest 层负责。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// LocatorType 是受支持的稳定定位类型。
type LocatorType string

const (
	LocatorEPUBCFI    LocatorType = "epub-cfi"
	LocatorEPUBAnchor LocatorType = "epub-anchor"
	LocatorPDFPage    LocatorType = "pdf-page"
	LocatorComicPage  LocatorType = "comic-page"
)

// ValidationError 是可安全返回给调用方的输入错误。Unsupported 为 true 时
// HTTP 层映射为 422 unsupported_locator，否则按普通 400/422 处理。
type ValidationError struct {
	Field       string
	Message     string
	Unsupported bool
}

func (e *ValidationError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "阅读器输入无效"
}

func invalid(field, message string) *ValidationError {
	return &ValidationError{Field: field, Message: message}
}

func unsupported(field, message string) *ValidationError {
	return &ValidationError{Field: field, Message: message, Unsupported: true}
}

func decodeJSONObject(raw json.RawMessage) (map[string]any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, invalid("locatorPayload", "缺少 locatorPayload")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, invalid("locatorPayload", "locatorPayload 不是合法 JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, invalid("locatorPayload", "locatorPayload 后存在多余内容")
	}
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, unsupported("locatorPayload", "locatorPayload 必须是 JSON 对象")
	}
	return object, nil
}

func requireString(object map[string]any, key, field string) (string, error) {
	value, ok := object[key]
	if !ok {
		return "", unsupported(field, "缺少 "+key)
	}
	text, ok := value.(string)
	if !ok {
		return "", unsupported(field, key+" 必须是字符串")
	}
	return text, nil
}

func optionalString(object map[string]any, key, field string) (string, bool, error) {
	value, ok := object[key]
	if !ok || value == nil {
		return "", false, nil
	}
	text, ok := value.(string)
	if !ok {
		return "", false, unsupported(field, key+" 必须是字符串")
	}
	return text, true, nil
}

func requireInt(object map[string]any, key, field string) (int64, error) {
	value, ok := object[key]
	if !ok {
		return 0, unsupported(field, "缺少 "+key)
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, unsupported(field, key+" 必须是整数")
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil {
		return 0, unsupported(field, key+" 必须是整数")
	}
	return parsed, nil
}

func optionalInt(object map[string]any, key, field string) (int64, bool, error) {
	value, ok := object[key]
	if !ok || value == nil {
		return 0, false, nil
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, false, unsupported(field, key+" 必须是整数")
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil {
		return 0, false, unsupported(field, key+" 必须是整数")
	}
	return parsed, true, nil
}

func requireNumber(object map[string]any, key, field string) (float64, error) {
	value, ok := object[key]
	if !ok {
		return 0, unsupported(field, "缺少 "+key)
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, unsupported(field, key+" 必须是数字")
	}
	parsed, err := number.Float64()
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, unsupported(field, key+" 必须是有限数字")
	}
	return parsed, nil
}

func optionalNumber(object map[string]any, key, field string) (float64, bool, error) {
	value, ok := object[key]
	if !ok || value == nil {
		return 0, false, nil
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, false, unsupported(field, key+" 必须是数字")
	}
	parsed, err := number.Float64()
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false, unsupported(field, key+" 必须是有限数字")
	}
	return parsed, true, nil
}

func validHexID(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// LocatorTypesForFormat 返回格式允许的 locatorType 集合。
func LocatorTypesForFormat(format string) []LocatorType {
	switch format {
	case "epub":
		return []LocatorType{LocatorEPUBCFI, LocatorEPUBAnchor}
	case "pdf":
		return []LocatorType{LocatorPDFPage}
	case "cbz", "cbr":
		return []LocatorType{LocatorComicPage}
	default:
		return nil
	}
}

// ValidateLocation 校验 locatorType 与当前书籍格式匹配，并返回紧凑 JSON。
func ValidateLocation(format, locatorType string, payload json.RawMessage) (json.RawMessage, error) {
	allowed := LocatorTypesForFormat(format)
	if len(allowed) == 0 {
		return nil, unsupported("format", "书籍格式不受阅读器支持")
	}
	matched := false
	for _, candidate := range allowed {
		if string(candidate) == locatorType {
			matched = true
			break
		}
	}
	if !matched {
		return nil, unsupported("locatorType", "locatorType 与书籍格式不匹配")
	}

	object, err := decodeJSONObject(payload)
	if err != nil {
		return nil, err
	}
	switch LocatorType(locatorType) {
	case LocatorEPUBCFI:
		err = validateEPUBCFI(object)
	case LocatorEPUBAnchor:
		err = validateEPUBAnchor(object)
	case LocatorPDFPage:
		err = validatePDFPage(object)
	case LocatorComicPage:
		err = validateComicPage(object)
	default:
		err = unsupported("locatorType", "不支持的 locatorType")
	}
	if err != nil {
		return nil, err
	}
	normalized, marshalErr := json.Marshal(object)
	if marshalErr != nil {
		return nil, unsupported("locatorPayload", "locatorPayload 无法序列化")
	}
	return json.RawMessage(normalized), nil
}

func validateLocatorVersion(object map[string]any) error {
	version, err := requireInt(object, "locatorVersion", "locatorPayload.locatorVersion")
	if err != nil {
		return err
	}
	if version != 1 {
		return unsupported("locatorPayload.locatorVersion", "locatorVersion 仅支持 1")
	}
	return nil
}

func validateTextQuote(object map[string]any, field string) error {
	value, ok := object["textQuote"]
	if !ok || value == nil {
		return nil
	}
	quote, ok := value.(map[string]any)
	if !ok {
		return unsupported(field+".textQuote", "textQuote 必须是对象或 null")
	}
	exact, err := requireString(quote, "exact", field+".textQuote.exact")
	if err != nil {
		return err
	}
	if strings.TrimSpace(exact) == "" {
		return unsupported(field+".textQuote.exact", "textQuote.exact 不能为空")
	}
	if _, _, err := optionalString(quote, "prefix", field+".textQuote.prefix"); err != nil {
		return err
	}
	if _, _, err := optionalString(quote, "suffix", field+".textQuote.suffix"); err != nil {
		return err
	}
	return nil
}

func validateEPUBCommon(object map[string]any, prefix string) error {
	spineIndex, err := requireInt(object, "spineIndex", prefix+".spineIndex")
	if err != nil {
		return err
	}
	if spineIndex < 0 || spineIndex > 1_000_000 {
		return unsupported(prefix+".spineIndex", "spineIndex 超出范围")
	}
	if resourceID, present, err := optionalString(object, "resourceId", prefix+".resourceId"); err != nil {
		return err
	} else if present && resourceID != "" && !validHexID(resourceID, 32) {
		return unsupported(prefix+".resourceId", "resourceId 必须是 32 位 hex")
	}
	if href, present, err := optionalString(object, "href", prefix+".href"); err != nil {
		return err
	} else if present && href == "" {
		return unsupported(prefix+".href", "href 不能为空")
	}
	chapterProgress, err := requireNumber(object, "chapterProgress", prefix+".chapterProgress")
	if err != nil {
		return err
	}
	if chapterProgress < 0 || chapterProgress > 1 {
		return unsupported(prefix+".chapterProgress", "chapterProgress 必须在 0 到 1 之间")
	}
	return validateTextQuote(object, prefix)
}

func validateEPUBCFI(object map[string]any) error {
	if err := validateLocatorVersion(object); err != nil {
		return err
	}
	if err := validateEPUBCommon(object, "locatorPayload"); err != nil {
		return err
	}
	cfi, err := requireString(object, "cfi", "locatorPayload.cfi")
	if err != nil {
		return err
	}
	cfi = strings.TrimSpace(cfi)
	if len(cfi) < 9 || len(cfi) > 4096 || !strings.HasPrefix(cfi, "epubcfi(") ||
		!strings.HasSuffix(cfi, ")") || strings.ContainsAny(cfi, " \t\r\n") {
		return unsupported("locatorPayload.cfi", "cfi 不是合法的 epubcfi")
	}
	return nil
}

func validateEPUBAnchor(object map[string]any) error {
	if err := validateLocatorVersion(object); err != nil {
		return err
	}
	if err := validateEPUBCommon(object, "locatorPayload"); err != nil {
		return err
	}
	anchorID, anchorPresent, err := optionalString(object, "anchorId", "locatorPayload.anchorId")
	if err != nil {
		return err
	}
	exact := ""
	if quote, ok := object["textQuote"].(map[string]any); ok {
		exact, _ = quote["exact"].(string)
	}
	if (!anchorPresent || strings.TrimSpace(anchorID) == "") && strings.TrimSpace(exact) == "" {
		return unsupported("locatorPayload", "epub-anchor 需要 anchorId 或 textQuote.exact")
	}
	return nil
}

func validatePDFPage(object map[string]any) error {
	if err := validateLocatorVersion(object); err != nil {
		return err
	}
	page, err := requireInt(object, "page", "locatorPayload.page")
	if err != nil {
		return err
	}
	if page < 1 || page > 1_000_000 {
		return unsupported("locatorPayload.page", "page 超出范围")
	}
	offset, err := requireNumber(object, "pageOffset", "locatorPayload.pageOffset")
	if err != nil {
		return err
	}
	if offset < 0 || offset > 1 {
		return unsupported("locatorPayload.pageOffset", "pageOffset 必须在 0 到 1 之间")
	}
	if viewportValue, ok := object["relativeViewport"]; ok && viewportValue != nil {
		viewport, ok := viewportValue.(map[string]any)
		if !ok {
			return unsupported("locatorPayload.relativeViewport", "relativeViewport 必须是对象或 null")
		}
		x, err := requireNumber(viewport, "x", "locatorPayload.relativeViewport.x")
		if err != nil {
			return err
		}
		y, err := requireNumber(viewport, "y", "locatorPayload.relativeViewport.y")
		if err != nil {
			return err
		}
		width, err := requireNumber(viewport, "width", "locatorPayload.relativeViewport.width")
		if err != nil {
			return err
		}
		height, err := requireNumber(viewport, "height", "locatorPayload.relativeViewport.height")
		if err != nil {
			return err
		}
		if x < 0 || y < 0 || width <= 0 || height <= 0 ||
			x > 1 || y > 1 || width > 1 || height > 1 ||
			x+width > 1.0001 || y+height > 1.0001 {
			return unsupported("locatorPayload.relativeViewport", "relativeViewport 必须是 0 到 1 的相对矩形")
		}
	}
	if viewValue, ok := object["view"]; ok && viewValue != nil {
		view, ok := viewValue.(map[string]any)
		if !ok {
			return unsupported("locatorPayload.view", "view 必须是对象或 null")
		}
		if layout, present, err := optionalString(view, "layoutMode", "locatorPayload.view.layoutMode"); err != nil {
			return err
		} else if present && layout != "single" && layout != "continuous" && layout != "horizontal" {
			return unsupported("locatorPayload.view.layoutMode", "layoutMode 仅支持 single/continuous/horizontal")
		}
		if zoom, present, err := optionalString(view, "zoomMode", "locatorPayload.view.zoomMode"); err != nil {
			return err
		} else if present && zoom != "fit-width" && zoom != "fit-page" && zoom != "manual" {
			return unsupported("locatorPayload.view.zoomMode", "zoomMode 仅支持 fit-width/fit-page/manual")
		}
		if scale, present, err := optionalNumber(view, "manualScale", "locatorPayload.view.manualScale"); err != nil {
			return err
		} else if present && (scale < 0.25 || scale > 4) {
			return unsupported("locatorPayload.view.manualScale", "manualScale 必须在 0.25 到 4 之间")
		}
	}
	return nil
}

func validateComicPage(object map[string]any) error {
	if err := validateLocatorVersion(object); err != nil {
		return err
	}
	page, err := requireInt(object, "page", "locatorPayload.page")
	if err != nil {
		return err
	}
	if page < 1 || page > 1_000_000 {
		return unsupported("locatorPayload.page", "page 超出范围")
	}
	offset, err := requireNumber(object, "pageOffset", "locatorPayload.pageOffset")
	if err != nil {
		return err
	}
	if offset < 0 || offset > 1 {
		return unsupported("locatorPayload.pageOffset", "pageOffset 必须在 0 到 1 之间")
	}
	direction, err := requireString(object, "direction", "locatorPayload.direction")
	if err != nil {
		return err
	}
	if direction != "ltr" && direction != "rtl" {
		return unsupported("locatorPayload.direction", "direction 仅支持 ltr/rtl")
	}
	mode, err := requireString(object, "mode", "locatorPayload.mode")
	if err != nil {
		return err
	}
	if mode != "single" && mode != "double" && mode != "continuous" {
		return unsupported("locatorPayload.mode", "mode 仅支持 single/double/continuous")
	}
	fit, err := requireString(object, "fit", "locatorPayload.fit")
	if err != nil {
		return err
	}
	if fit != "screen" && fit != "width" && fit != "original" {
		return unsupported("locatorPayload.fit", "fit 仅支持 screen/width/original")
	}
	return nil
}

// BuildBookmarkLocatorKey 按决策生成稳定 locator_key。不得使用百分比。
func BuildBookmarkLocatorKey(locatorType string, payload json.RawMessage) (string, error) {
	object, err := decodeJSONObject(payload)
	if err != nil {
		return "", err
	}
	var canonical string
	switch LocatorType(locatorType) {
	case LocatorEPUBCFI:
		cfi, err := requireString(object, "cfi", "locatorPayload.cfi")
		if err != nil {
			return "", err
		}
		canonical = "epub-cfi\n" + strings.TrimSpace(cfi)
	case LocatorEPUBAnchor:
		resourceID, _, err := optionalString(object, "resourceId", "locatorPayload.resourceId")
		if err != nil {
			return "", err
		}
		anchorID, _, err := optionalString(object, "anchorId", "locatorPayload.anchorId")
		if err != nil {
			return "", err
		}
		exact := ""
		if quote, ok := object["textQuote"].(map[string]any); ok {
			exact, _ = quote["exact"].(string)
		}
		if strings.TrimSpace(anchorID) == "" && strings.TrimSpace(exact) == "" {
			return "", unsupported("locatorPayload", "epub-anchor 需要 anchorId 或 textQuote.exact")
		}
		canonical = "epub-anchor\n" + resourceID + "\n" + anchorID + "\n" + exact
	case LocatorPDFPage:
		page, err := requireInt(object, "page", "locatorPayload.page")
		if err != nil {
			return "", err
		}
		offset, err := requireNumber(object, "pageOffset", "locatorPayload.pageOffset")
		if err != nil {
			return "", err
		}
		canonical = fmt.Sprintf("pdf-page\n%d\n%d", page, int64(math.Round(offset*10000)))
	case LocatorComicPage:
		page, err := requireInt(object, "page", "locatorPayload.page")
		if err != nil {
			return "", err
		}
		canonical = fmt.Sprintf("comic-page\n%d", page)
	default:
		return "", unsupported("locatorType", "不支持的 locatorType")
	}
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:]), nil
}

// DefaultBookmarkLabel 由文本锚点/章节/页码生成纯文本标签。
func DefaultBookmarkLabel(locatorType string, payload json.RawMessage) string {
	object, err := decodeJSONObject(payload)
	if err != nil {
		return "书签"
	}
	switch LocatorType(locatorType) {
	case LocatorEPUBCFI, LocatorEPUBAnchor:
		if quote, ok := object["textQuote"].(map[string]any); ok {
			if exact, ok := quote["exact"].(string); ok {
				if label := sanitizeLabel(exact); label != "" {
					return label
				}
			}
		}
		if spineIndex, ok := object["spineIndex"].(json.Number); ok {
			if parsed, err := strconv.ParseInt(spineIndex.String(), 10, 64); err == nil && parsed >= 0 {
				return fmt.Sprintf("第 %d 节", parsed+1)
			}
		}
	case LocatorPDFPage, LocatorComicPage:
		if page, ok := object["page"].(json.Number); ok {
			if parsed, err := strconv.ParseInt(page.String(), 10, 64); err == nil && parsed >= 1 {
				return fmt.Sprintf("第 %d 页", parsed)
			}
		}
	}
	return "书签"
}

func sanitizeLabel(value string) string {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	label := strings.Join(strings.Fields(cleaned), " ")
	if utf8.RuneCountInString(label) > 200 {
		runes := []rune(label)
		label = string(runes[:200])
	}
	return label
}
