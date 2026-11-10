package formats

import (
	"bytes"
	"compress/zlib"
	"context"
	"errors"
	"io"
	"os"
	"regexp"
	"strconv"
)

var (
	pdfObjectHeader = regexp.MustCompile(`^\s*\d+\s+\d+\s+obj\b`)
	pdfRootRef      = regexp.MustCompile(`/Root\s+(\d+)\s+\d+\s+R`)
	pdfPagesRef     = regexp.MustCompile(`/Pages\s+(\d+)\s+\d+\s+R`)
	pdfCountRef     = regexp.MustCompile(`/Count\s+(\d+)\s+\d+\s+R`)
	pdfCountDirect  = regexp.MustCompile(`/Count\s+(\d+)`)
	pdfEncryptKey   = regexp.MustCompile(`/Encrypt([^A-Za-z0-9]|$)`)
	pdfXRefType     = regexp.MustCompile(`/Type\s*/XRef\b`)
	pdfLength       = regexp.MustCompile(`/Length\s+(\d+)`)
	pdfWidths       = regexp.MustCompile(`/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]`)
	pdfIndex        = regexp.MustCompile(`/Index\s*\[([^\]]*)\]`)
	pdfSize         = regexp.MustCompile(`/Size\s+(\d+)`)
)

var errBadPDF = errors.New("formats: bad pdf structure")

func validatePDF(ctx context.Context, f *os.File, size int64) (Result, error) {
	startXRef, err := findPDFStartXRef(ctx, f, size)
	if err != nil {
		return pdfRejection(ctx)
	}
	section, err := readAt(ctx, f, size, startXRef, maxPDFSectionBytes)
	if err != nil {
		return pdfRejection(ctx)
	}

	xref, trailer, err := parsePDFXRefSection(ctx, f, size, startXRef, section)
	if err != nil {
		return pdfRejection(ctx)
	}
	if pdfEncryptKey.Match(trailer) {
		return Result{
			Format:            FormatPDF,
			MediaType:         MediaTypePDF,
			Authors:           []string{},
			Readable:          false,
			UnsupportedReason: UnsupportedPDFEncrypted,
		}, nil
	}

	rootMatch := pdfRootRef.FindSubmatch(trailer)
	if rootMatch == nil {
		return pdfRejection(ctx)
	}
	rootNumber, err := strconv.Atoi(string(rootMatch[1]))
	if err != nil || rootNumber < 0 {
		return pdfRejection(ctx)
	}

	return Result{
		Format:    FormatPDF,
		MediaType: MediaTypePDF,
		PageCount: pdfResolvePageCount(ctx, f, size, xref, rootNumber),
		Authors:   []string{},
		Readable:  true,
	}, nil
}

func pdfRejection(ctx context.Context) (Result, error) {
	if ctx.Err() != nil {
		return timeoutRejection(ctx)
	}
	return rejection(ReasonCorruptContainer, nil)
}

func findPDFStartXRef(ctx context.Context, f *os.File, size int64) (int64, error) {
	tailLen := int64(maxPDFTailBytes)
	if size < tailLen {
		tailLen = size
	}
	tail, err := readAt(ctx, f, size, size-tailLen, tailLen)
	if err != nil {
		return 0, err
	}
	index := bytes.LastIndex(tail, []byte("startxref"))
	if index < 0 {
		return 0, errBadPDF
	}
	value, _, ok := parsePDFUint(tail, index+len("startxref"), size)
	if !ok || value >= size {
		return 0, errBadPDF
	}
	return value, nil
}

// parsePDFXRefSection 解析传统 xref 表或 xref 流对象的字典。返回值中的 xref
// 可能为空（仅表示页数不可解析），但 trailer 必须可解析且包含 /Root。
func parsePDFXRefSection(ctx context.Context, f *os.File, size, base int64, section []byte) (map[int]int64, []byte, error) {
	offset := skipPDFSpace(section, 0)
	if offset >= len(section) {
		return nil, nil, errBadPDF
	}

	if bytes.HasPrefix(section[offset:], []byte("xref")) {
		trailerIndex := bytes.Index(section[offset:], []byte("trailer"))
		if trailerIndex < 0 {
			return nil, nil, errBadPDF
		}
		trailerStart := offset + trailerIndex
		dictStart, dictEnd, ok := pdfFindDict(section[trailerStart:])
		if !ok {
			return nil, nil, errBadPDF
		}
		trailer := section[trailerStart+dictStart : trailerStart+dictEnd]
		xref := parseClassicXRef(section[offset:trailerStart])
		if !pdfRootRef.Match(trailer) {
			return nil, nil, errBadPDF
		}
		return xref, trailer, nil
	}

	objectStart := int64(offset)
	if !pdfObjectHeader.Match(section[offset:]) {
		return nil, nil, errBadPDF
	}
	dictStart, dictEnd, ok := pdfFindDict(section[offset:])
	if !ok {
		return nil, nil, errBadPDF
	}
	trailer := section[offset+dictStart : offset+dictEnd]
	if !pdfXRefType.Match(trailer) || !pdfRootRef.Match(trailer) {
		return nil, nil, errBadPDF
	}
	xref := parseXRefStream(ctx, f, size, base+objectStart, section[offset:], dictEnd)
	return xref, trailer, nil
}

const maxPDFNumber int64 = 1 << 62

func parseClassicXRef(section []byte) map[int]int64 {
	section = bytes.TrimSpace(section)
	if !bytes.HasPrefix(section, []byte("xref")) {
		return nil
	}
	section = section[len("xref"):]
	offsets := make(map[int]int64)
	index := 0
	totalEntries := 0

	for {
		index = skipPDFSpace(section, index)
		if index >= len(section) || bytes.HasPrefix(section[index:], []byte("trailer")) {
			break
		}
		start, next, ok := parsePDFUint(section, index, maxPDFNumber)
		if !ok || start > maxClassicXRefEntries {
			return offsets
		}
		count, next, ok := parsePDFUint(section, next, maxClassicXRefEntries)
		if !ok || count > maxClassicXRefEntries || totalEntries+int(count) > maxClassicXRefEntries {
			return offsets
		}
		index = next
		for i := 0; i < int(count); i++ {
			index = skipPDFSpace(section, index)
			entryOffset, next, ok := parsePDFUint(section, index, maxPDFNumber)
			if !ok {
				return offsets
			}
			index = next
			_, next, ok = parsePDFUint(section, index, maxPDFNumber)
			if !ok {
				return offsets
			}
			index = skipPDFSpace(section, next)
			if index >= len(section) {
				return offsets
			}
			entryType := section[index]
			index++
			if entryType == 'n' && entryOffset > 0 {
				offsets[int(start)+i] = entryOffset
			}
			for index < len(section) && section[index] != '\n' && section[index] != '\r' {
				index++
			}
			if index < len(section) {
				index++
			}
			totalEntries++
		}
	}
	return offsets
}

// parseXRefStream 解码 FlateDecode xref 流中的 type-1 偏移。使用 PNG predictor
// 或其它 filter 时放弃页数解析，不影响“xref 结构可解析”的判断。
func parseXRefStream(ctx context.Context, f *os.File, size, objectBase int64, object []byte, afterDict int) map[int]int64 {
	widths := pdfWidths.FindSubmatch(object[:afterDict])
	if widths == nil {
		return nil
	}
	w0, err0 := strconv.Atoi(string(widths[1]))
	w1, err1 := strconv.Atoi(string(widths[2]))
	w2, err2 := strconv.Atoi(string(widths[3]))
	if err0 != nil || err1 != nil || err2 != nil || w0 > 8 || w1 > 8 || w2 > 8 || w0+w1+w2 == 0 || w0+w1+w2 > 24 {
		return nil
	}
	if bytes.Contains(object[:afterDict], []byte("/DecodeParms")) && bytes.Contains(object[:afterDict], []byte("/Predictor")) {
		return nil
	}
	lengthMatch := pdfLength.FindSubmatch(object[:afterDict])
	if lengthMatch == nil {
		return nil
	}
	length, err := strconv.ParseInt(string(lengthMatch[1]), 10, 64)
	if err != nil || length <= 0 || length > maxXRefStreamBytes {
		return nil
	}

	streamOffset, ok := pdfStreamStart(object, afterDict)
	if !ok {
		return nil
	}
	raw, err := readAt(ctx, f, size, objectBase+int64(streamOffset), length)
	if err != nil || int64(len(raw)) != length {
		return nil
	}

	var decoded []byte
	if bytes.Contains(object[:afterDict], []byte("/FlateDecode")) {
		zr, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil
		}
		decoded, err = io.ReadAll(io.LimitReader(ctxReader{ctx: ctx, r: zr}, maxXRefDecodedBytes+1))
		closeErr := zr.Close()
		if err != nil || closeErr != nil || len(decoded) > maxXRefDecodedBytes {
			return nil
		}
	} else if bytes.Contains(object[:afterDict], []byte("/Filter")) {
		return nil
	} else {
		decoded = raw
	}

	ranges := []int{0, 0}
	if indexMatch := pdfIndex.FindSubmatch(object[:afterDict]); indexMatch != nil {
		ranges = ranges[:0]
		for _, field := range bytes.Fields(indexMatch[1]) {
			value, err := strconv.Atoi(string(field))
			if err != nil || value < 0 {
				return nil
			}
			ranges = append(ranges, value)
		}
		if len(ranges) == 0 || len(ranges)%2 != 0 {
			return nil
		}
	} else {
		sizeMatch := pdfSize.FindSubmatch(object[:afterDict])
		if sizeMatch == nil {
			return nil
		}
		total, err := strconv.Atoi(string(sizeMatch[1]))
		if err != nil || total < 0 {
			return nil
		}
		ranges[1] = total
	}

	rowWidth := w0 + w1 + w2
	offsets := make(map[int]int64)
	position := 0
	entryCount := 0
	for i := 0; i+1 < len(ranges); i += 2 {
		start, count := ranges[i], ranges[i+1]
		if start > maxXRefEntries || count > maxXRefEntries || start+count > 2*maxXRefEntries {
			return offsets
		}
		for n := 0; n < count; n++ {
			if entryCount >= maxXRefEntries || position+rowWidth > len(decoded) {
				return offsets
			}
			row := decoded[position : position+rowWidth]
			position += rowWidth
			entryCount++

			entryType := int64(1)
			if w0 > 0 {
				entryType = int64(pdfField(row[:w0]))
			}
			if entryType != 1 {
				continue
			}
			field2 := pdfField(row[w0 : w0+w1])
			offsets[start+n] = int64(field2)
		}
	}
	return offsets
}

func pdfField(field []byte) uint64 {
	var value uint64
	for _, b := range field {
		value = value<<8 | uint64(b)
	}
	return value
}

func pdfResolvePageCount(ctx context.Context, f *os.File, size int64, xref map[int]int64, rootNumber int) int {
	if len(xref) == 0 {
		return 0
	}
	rootOffset, ok := xref[rootNumber]
	if !ok {
		return 0
	}
	root, err := pdfObjectDictAt(ctx, f, size, rootOffset)
	if err != nil {
		return 0
	}
	pagesMatch := pdfPagesRef.FindSubmatch(root)
	if pagesMatch == nil {
		return 0
	}
	pagesNumber, err := strconv.Atoi(string(pagesMatch[1]))
	if err != nil {
		return 0
	}
	pagesOffset, ok := xref[pagesNumber]
	if !ok {
		return 0
	}
	pages, err := pdfObjectDictAt(ctx, f, size, pagesOffset)
	if err != nil {
		return 0
	}

	if ref := pdfCountRef.FindSubmatch(pages); ref != nil {
		countNumber, err := strconv.Atoi(string(ref[1]))
		if err != nil {
			return 0
		}
		countOffset, ok := xref[countNumber]
		if !ok {
			return 0
		}
		countObject, err := pdfObjectDictAt(ctx, f, size, countOffset)
		if err != nil {
			return 0
		}
		return pdfCountValue(countObject)
	}
	return pdfCountValue(pages)
}

func pdfCountValue(dict []byte) int {
	match := pdfCountDirect.FindSubmatch(dict)
	if match == nil {
		return 0
	}
	value, err := strconv.Atoi(string(match[1]))
	if err != nil || value <= 0 || value > maxPDFPageCount {
		return 0
	}
	return value
}

func pdfObjectDictAt(ctx context.Context, f *os.File, size, offset int64) ([]byte, error) {
	if offset < 0 || offset >= size {
		return nil, errBadPDF
	}
	object, err := readAt(ctx, f, size, offset, maxPDFObjectBytes)
	if err != nil {
		return nil, err
	}
	if !pdfObjectHeader.Match(object) {
		return nil, errBadPDF
	}
	start, end, ok := pdfFindDict(object)
	if !ok {
		return nil, errBadPDF
	}
	return object[start:end], nil
}

func pdfStreamStart(data []byte, after int) (int, bool) {
	index := skipPDFSpace(data, after)
	if !bytes.HasPrefix(data[index:], []byte("stream")) {
		return 0, false
	}
	index += len("stream")
	switch {
	case index < len(data) && data[index] == '\r':
		index++
		if index < len(data) && data[index] == '\n' {
			index++
		}
	case index < len(data) && data[index] == '\n':
		index++
	default:
		return 0, false
	}
	return index, true
}

// pdfFindDict 返回首个字典的 [start,end)（含 << >>），扫描时跳过字符串与注释。
func pdfFindDict(data []byte) (int, int, bool) {
	start := bytes.Index(data, []byte("<<"))
	if start < 0 {
		return 0, 0, false
	}
	depth := 0
	for i := start; i < len(data); i++ {
		switch data[i] {
		case '%':
			for i < len(data) && data[i] != '\n' && data[i] != '\r' {
				i++
			}
		case '(':
			parens := 1
			for i++; i < len(data) && parens > 0; i++ {
				switch data[i] {
				case '\\':
					i++
				case '(':
					parens++
				case ')':
					parens--
				}
			}
			i--
		case '<':
			if i+1 < len(data) && data[i+1] == '<' {
				depth++
				i++
				continue
			}
			for i++; i < len(data) && data[i] != '>'; i++ {
			}
		case '>':
			if i+1 < len(data) && data[i+1] == '>' {
				depth--
				i++
				if depth == 0 {
					return start, i + 1, true
				}
			}
		}
	}
	return 0, 0, false
}

func skipPDFSpace(data []byte, index int) int {
	for index < len(data) {
		switch data[index] {
		case ' ', '\t', '\r', '\n', '\f', 0:
			index++
		default:
			return index
		}
	}
	return index
}

func parsePDFUint(data []byte, index int, limit int64) (int64, int, bool) {
	index = skipPDFSpace(data, index)
	start := index
	for index < len(data) && data[index] >= '0' && data[index] <= '9' {
		index++
	}
	if start == index || index-start > 18 {
		return 0, index, false
	}
	value, err := strconv.ParseInt(string(data[start:index]), 10, 64)
	if err != nil || value < 0 || value > limit {
		return 0, index, false
	}
	return value, index, true
}
