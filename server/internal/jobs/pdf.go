package jobs

import (
	"bytes"
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

const (
	pdfInfoTailBytes = 4 << 20
	pdfInfoHeadBytes = 1 << 20
)

var (
	pdfInfoRefPattern = regexp.MustCompile(`/Info\s+(\d+)\s+(\d+)\s+R`)
	pdfTitlePattern   = regexp.MustCompile(`/Title`)
	pdfAuthorPattern  = regexp.MustCompile(`/Author`)
)

func extractPDF(ctx context.Context, filePath, displayTitle string, report phaseReporter) (extraction, error) {
	if err := statBookFile(filePath); err != nil {
		return extraction{}, err
	}
	// formats.Validate 已实现 PDF xref/trailer/页数解析；这里复用它，避免在
	// worker 中维护第二套 PDF 结构解析器。
	validated, err := formats.Validate(ctx, filePath, "pdf")
	if err != nil {
		if errors.Is(err, formats.ErrTempFileUnavailable) {
			return extraction{}, fileUnavailable(err)
		}
		if contextDone(ctx, err) {
			return extraction{}, err
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return extraction{}, newIndexError(ErrorCodeTimeout, "PDF 解析超时", true, err)
		}
		return extraction{}, invalidBookFile(err)
	}
	if !validated.Readable {
		return extraction{}, newIndexError(ErrorCodeUnsupported, "该 PDF 当前不可索引", false, nil)
	}

	result := extraction{
		Authors: []string{},
		TOC:     []store.BookTOCEntry{},
	}
	if title := strings.TrimSpace(validated.Title); title != "" {
		result.Title = &title
	}
	for _, author := range validated.Authors {
		if trimmed := strings.TrimSpace(author); trimmed != "" {
			result.Authors = append(result.Authors, trimmed)
		}
	}
	infoTitle, infoAuthor := extractPDFInfo(filePath)
	if result.Title == nil {
		if infoTitle != "" {
			value := infoTitle
			result.Title = &value
		}
	}
	if len(result.Authors) == 0 && infoAuthor != "" {
		result.Authors = []string{infoAuthor}
	}
	if result.Title == nil {
		fallback := strings.TrimSpace(displayTitle)
		if fallback != "" {
			result.Title = &fallback
		}
	}
	if validated.PageCount > 0 {
		pageCount := int64(validated.PageCount)
		result.PageCount = &pageCount
	} else {
		// 页数未知时仍可完成索引，但不能伪造总数。
		result.Partial = true
	}

	if err := report("toc", 1); err != nil {
		return extraction{}, err
	}
	if err := report("cover", 2); err != nil {
		return extraction{}, err
	}
	// 阶段2没有 PDF 渲染器，封面保持 null，不视为部分失败。
	return result, nil
}

func extractPDFInfo(filePath string) (title, author string) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() <= 0 {
		return "", ""
	}

	tail := readPDFWindow(file, info.Size()-minInt64(info.Size(), pdfInfoTailBytes), minInt64(info.Size(), pdfInfoTailBytes))
	head := []byte(nil)
	if info.Size() > pdfInfoTailBytes {
		head = readPDFWindow(file, 0, minInt64(info.Size(), pdfInfoHeadBytes))
	}
	section := locatePDFInfoObject(tail, head)
	if len(section) == 0 {
		section = tail
	}
	title = findPDFTextValue(section, pdfTitlePattern)
	author = findPDFTextValue(section, pdfAuthorPattern)
	if title == "" {
		title = findPDFTextValue(head, pdfTitlePattern)
	}
	if author == "" {
		author = findPDFTextValue(head, pdfAuthorPattern)
	}
	return strings.TrimSpace(title), strings.TrimSpace(author)
}

func readPDFWindow(file *os.File, offset, length int64) []byte {
	if offset < 0 || length <= 0 {
		return nil
	}
	buffer := make([]byte, length)
	read, err := file.ReadAt(buffer, offset)
	if err != nil && read == 0 {
		return nil
	}
	return buffer[:read]
}

func locatePDFInfoObject(tail, head []byte) []byte {
	// 先按 /Info n 0 R 找对象编号，再在尾部/头部查找该对象字典；找不到时
	// 退回尾部扫描，至少不会把错误路径带进响应。
	matches := pdfInfoRefPattern.FindAllSubmatch(tail, -1)
	if len(matches) == 0 {
		return nil
	}
	last := matches[len(matches)-1]
	number := string(last[1])
	generation := string(last[2])
	header := []byte("\n" + number + " " + generation + " obj")
	index := bytes.LastIndex(tail, header)
	if index < 0 {
		index = bytes.Index(tail, []byte(number+" "+generation+" obj"))
	}
	var data []byte
	if index >= 0 {
		data = tail[index:]
	} else if len(head) > 0 {
		if headIndex := bytes.Index(head, []byte(number+" "+generation+" obj")); headIndex >= 0 {
			data = head[headIndex:]
		}
	}
	if len(data) == 0 {
		return nil
	}
	start, end, ok := pdfDictionaryRange(data)
	if !ok {
		return nil
	}
	return data[start:end]
}

// pdfDictionaryRange 找到首个 PDF 字典 <<...>> 的范围，跳过字符串与注释。
func pdfDictionaryRange(data []byte) (int, int, bool) {
	start := bytes.Index(data, []byte("<<"))
	if start < 0 {
		return 0, 0, false
	}
	depth := 0
	for index := start; index < len(data); index++ {
		switch data[index] {
		case '%':
			for index < len(data) && data[index] != '\n' && data[index] != '\r' {
				index++
			}
		case '(':
			parens := 1
			for index++; index < len(data) && parens > 0; index++ {
				switch data[index] {
				case '\\':
					index++
				case '(':
					parens++
				case ')':
					parens--
				}
			}
			index--
		case '<':
			if index+1 < len(data) && data[index+1] == '<' {
				depth++
				index++
				continue
			}
			for index++; index < len(data) && data[index] != '>'; index++ {
			}
		case '>':
			if index+1 < len(data) && data[index+1] == '>' {
				depth--
				index++
				if depth == 0 {
					return start, index + 1, true
				}
			}
		}
	}
	return 0, 0, false
}

func findPDFTextValue(section []byte, pattern *regexp.Regexp) string {
	if len(section) == 0 {
		return ""
	}
	locations := pattern.FindAllIndex(section, -1)
	for index := len(locations) - 1; index >= 0; index-- {
		position := locations[index][1]
		if value, ok := parsePDFTextAt(section, position); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func parsePDFTextAt(data []byte, position int) (string, bool) {
	for position < len(data) && isPDFWhitespace(data[position]) {
		position++
	}
	if position >= len(data) {
		return "", false
	}
	switch data[position] {
	case '(':
		raw, ok := parsePDFLiteralString(data, position)
		if !ok {
			return "", false
		}
		return decodePDFText(raw), true
	case '<':
		if position+1 < len(data) && data[position+1] == '<' {
			return "", false
		}
		end := bytes.IndexByte(data[position+1:], '>')
		if end < 0 {
			return "", false
		}
		raw, ok := decodePDFHexString(data[position+1 : position+1+end])
		if !ok {
			return "", false
		}
		return decodePDFText(raw), true
	default:
		return "", false
	}
}

func parsePDFLiteralString(data []byte, position int) ([]byte, bool) {
	// position 指向 '('。
	depth := 1
	result := make([]byte, 0, 64)
	for index := position + 1; index < len(data); index++ {
		switch data[index] {
		case '\\':
			index++
			if index >= len(data) {
				return nil, false
			}
			switch data[index] {
			case 'n':
				result = append(result, '\n')
			case 'r':
				result = append(result, '\r')
			case 't':
				result = append(result, '\t')
			case 'b':
				result = append(result, '\b')
			case 'f':
				result = append(result, '\f')
			case '(', ')', '\\':
				result = append(result, data[index])
			case '\r':
				if index+1 < len(data) && data[index+1] == '\n' {
					index++
				}
			case '\n':
				// 行续接，不输出。
			default:
				if data[index] >= '0' && data[index] <= '7' {
					value := int(data[index] - '0')
					for count := 1; count < 3 && index+1 < len(data); count++ {
						next := data[index+1]
						if next < '0' || next > '7' {
							break
						}
						index++
						value = value*8 + int(next-'0')
					}
					result = append(result, byte(value))
				} else {
					result = append(result, data[index])
				}
			}
		case '(':
			depth++
			result = append(result, '(')
		case ')':
			depth--
			if depth == 0 {
				return result, true
			}
			result = append(result, ')')
		default:
			result = append(result, data[index])
		}
	}
	return nil, false
}

func decodePDFHexString(data []byte) ([]byte, bool) {
	cleaned := make([]byte, 0, len(data)/2)
	for _, value := range data {
		if isPDFWhitespace(value) {
			continue
		}
		if !isHexDigit(value) {
			return nil, false
		}
		cleaned = append(cleaned, value)
	}
	if len(cleaned)%2 != 0 {
		cleaned = append(cleaned, '0')
	}
	result := make([]byte, 0, len(cleaned)/2)
	for index := 0; index < len(cleaned); index += 2 {
		high := hexValue(cleaned[index])
		low := hexValue(cleaned[index+1])
		result = append(result, high<<4|low)
	}
	return result, true
}

func decodePDFText(raw []byte) string {
	if len(raw) >= 2 && raw[0] == 0xFE && raw[1] == 0xFF {
		return decodeUTF16(raw[2:], true)
	}
	if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
		return decodeUTF16(raw[2:], false)
	}
	if utf8.Valid(raw) {
		return strings.TrimRight(string(raw), "\x00")
	}
	runes := make([]rune, 0, len(raw))
	for _, value := range raw {
		runes = append(runes, rune(value))
	}
	return strings.TrimRight(string(runes), "\x00")
}

func decodeUTF16(raw []byte, bigEndian bool) string {
	if len(raw)%2 != 0 {
		raw = raw[:len(raw)-1]
	}
	units := make([]uint16, 0, len(raw)/2)
	for index := 0; index+1 < len(raw); index += 2 {
		if bigEndian {
			units = append(units, uint16(raw[index])<<8|uint16(raw[index+1]))
		} else {
			units = append(units, uint16(raw[index+1])<<8|uint16(raw[index]))
		}
	}
	return strings.TrimRight(string(utf16.Decode(units)), "\x00")
}

func isPDFWhitespace(value byte) bool {
	switch value {
	case ' ', '\t', '\r', '\n', '\f', 0:
		return true
	default:
		return false
	}
}

func isHexDigit(value byte) bool {
	return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F')
}

func hexValue(value byte) byte {
	switch {
	case value >= '0' && value <= '9':
		return value - '0'
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10
	default:
		return value - 'A' + 10
	}
}

func minInt64(first, second int64) int64 {
	if first < second {
		return first
	}
	return second
}
