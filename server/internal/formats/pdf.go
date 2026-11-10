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
	pdfObjStmType   = regexp.MustCompile(`/Type\s*/ObjStm\b`)
	pdfLength       = regexp.MustCompile(`/Length\s+(\d+)`)
	pdfWidths       = regexp.MustCompile(`/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]`)
	pdfIndex        = regexp.MustCompile(`/Index\s*\[([^\]]*)\]`)
	pdfSize         = regexp.MustCompile(`/Size\s+(\d+)`)
	pdfPrev         = regexp.MustCompile(`/Prev\s+(\d+)`)
	pdfPredictor    = regexp.MustCompile(`/Predictor\s+(\d+)`)
	pdfColumns      = regexp.MustCompile(`/Columns\s+(\d+)`)
	pdfObjStmN      = regexp.MustCompile(`/N\s+(\d+)`)
	pdfObjStmFirst  = regexp.MustCompile(`/First\s+(\d+)`)
)

// PDF 结构解析的内部上限。所有读取仍复用 formats.go 中的字节预算。
const (
	maxPDFXRefSections  = 64
	maxPDFObjStmBytes   = 32 << 20
	maxPDFObjStmObjects = 100_000
	maxPDFObjStmCaches  = 8
)

var errBadPDF = errors.New("formats: bad pdf structure")

func validatePDF(ctx context.Context, f *os.File, size int64) (Result, error) {
	startXRef, err := findPDFStartXRef(ctx, f, size)
	if err != nil {
		return pdfRejection(ctx)
	}

	xref, trailer, err := loadPDFXRef(ctx, f, size, startXRef)
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

const (
	pdfXRefEntryDirect     = 1
	pdfXRefEntryCompressed = 2
)

// pdfXRefEntry 统一表示 type-1 直接对象和 type-2 压缩对象。压缩对象的 field2
// 指向 /Type /ObjStm 对象号，field3 是该对象在流中的序号。
type pdfXRefEntry struct {
	kind   int
	offset int64
	stream int
	index  int
}

type pdfXRef struct {
	entries map[int]pdfXRefEntry
}

func newPDFXRef() *pdfXRef {
	return &pdfXRef{entries: make(map[int]pdfXRefEntry)}
}

// add 保留先写入的条目。调用方按 startxref → /Prev 的顺序合并，较新的
// 增量 xref 优先于旧 xref。
func (x *pdfXRef) add(number int, entry pdfXRefEntry) {
	if number < 0 || number > 2*maxXRefEntries {
		return
	}
	if _, exists := x.entries[number]; exists {
		return
	}
	if len(x.entries) >= maxXRefEntries {
		return
	}
	x.entries[number] = entry
}

func (x *pdfXRef) merge(other *pdfXRef) {
	if other == nil {
		return
	}
	for number, entry := range other.entries {
		x.add(number, entry)
	}
}

// loadPDFXRef 从 startxref 开始读取 xref 段，并沿 /Prev 链合并增量更新。
// trailer 使用最新一段的字典，用于 /Root、/Encrypt 判定。
func loadPDFXRef(ctx context.Context, f *os.File, size, start int64) (*pdfXRef, []byte, error) {
	xref := newPDFXRef()
	var trailer []byte
	seen := make(map[int64]struct{})
	current := start

	for depth := 0; ; depth++ {
		if current <= 0 || current >= size {
			return nil, nil, errBadPDF
		}
		if _, exists := seen[current]; exists {
			return nil, nil, errBadPDF
		}
		seen[current] = struct{}{}

		section, err := readAt(ctx, f, size, current, maxPDFSectionBytes)
		if err != nil {
			return nil, nil, err
		}
		part, partTrailer, err := parsePDFXRefSection(ctx, f, size, current, section)
		if err != nil {
			return nil, nil, err
		}
		if trailer == nil {
			trailer = partTrailer
		}
		xref.merge(part)

		prev, hasPrev := pdfPrevOffset(partTrailer)
		if !hasPrev {
			break
		}
		if prev <= 0 || prev >= size {
			return nil, nil, errBadPDF
		}
		if depth+1 >= maxPDFXRefSections {
			break
		}
		current = prev
	}

	if trailer == nil || !pdfRootRef.Match(trailer) {
		return nil, nil, errBadPDF
	}
	return xref, trailer, nil
}

func pdfPrevOffset(trailer []byte) (int64, bool) {
	match := pdfPrev.FindSubmatchIndex(trailer)
	if match == nil {
		return 0, false
	}
	value, _, ok := parsePDFUint(trailer, match[2], maxPDFNumber)
	if !ok {
		return 0, true
	}
	return value, true
}

// parsePDFXRefSection 解析传统 xref 表或 xref 流对象的字典。单段 xref 可能不含
// /Root（增量更新只在最新 trailer 中保证），因此 /Root 由 loadPDFXRef 校验。
func parsePDFXRefSection(ctx context.Context, f *os.File, size, base int64, section []byte) (*pdfXRef, []byte, error) {
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
		return classicXRef(parseClassicXRef(section[offset:trailerStart])), trailer, nil
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
	if !pdfXRefType.Match(trailer) {
		return nil, nil, errBadPDF
	}
	return parseXRefStream(ctx, f, size, base+objectStart, section[offset:], dictEnd), trailer, nil
}

func classicXRef(offsets map[int]int64) *pdfXRef {
	xref := newPDFXRef()
	for number, offset := range offsets {
		xref.add(number, pdfXRefEntry{kind: pdfXRefEntryDirect, offset: offset})
	}
	return xref
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

// parseXRefStream 解码 FlateDecode xref 流，支持 PNG predictor（含 Predictor
// 12）以及 type-2 压缩对象条目。无法解析时返回 nil，不影响“xref 结构可解析”
// 的判定，只是页数可能降级为 0。
func parseXRefStream(ctx context.Context, f *os.File, size, objectBase int64, object []byte, afterDict int) *pdfXRef {
	dict := object[:afterDict]
	widths := pdfWidths.FindSubmatch(dict)
	if widths == nil {
		return nil
	}
	w0, err0 := strconv.Atoi(string(widths[1]))
	w1, err1 := strconv.Atoi(string(widths[2]))
	w2, err2 := strconv.Atoi(string(widths[3]))
	if err0 != nil || err1 != nil || err2 != nil || w0 > 8 || w1 > 8 || w2 > 8 || w0+w1+w2 == 0 || w0+w1+w2 > 24 {
		return nil
	}
	rowWidth := w0 + w1 + w2

	predictor, columns := 0, 0
	if match := pdfPredictor.FindSubmatch(dict); match != nil {
		value, err := strconv.Atoi(string(match[1]))
		if err != nil {
			return nil
		}
		predictor = value
		if predictor != 1 {
			if predictor < 10 || predictor > 15 {
				return nil
			}
			columnMatch := pdfColumns.FindSubmatch(dict)
			if columnMatch == nil {
				return nil
			}
			columns, err = strconv.Atoi(string(columnMatch[1]))
			if err != nil || columns <= 0 || columns != rowWidth {
				return nil
			}
		}
	}

	lengthMatch := pdfLength.FindSubmatch(dict)
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
	if bytes.Contains(dict, []byte("/FlateDecode")) {
		zr, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil
		}
		decoded, err = io.ReadAll(io.LimitReader(ctxReader{ctx: ctx, r: zr}, maxXRefDecodedBytes+1))
		closeErr := zr.Close()
		if err != nil || closeErr != nil || len(decoded) > maxXRefDecodedBytes {
			return nil
		}
	} else if bytes.Contains(dict, []byte("/Filter")) {
		return nil
	} else {
		decoded = raw
	}
	if predictor > 1 {
		decoded = pdfPNGUnpredict(decoded, predictor, columns)
		if decoded == nil {
			return nil
		}
	}

	ranges := []int{0, 0}
	if indexMatch := pdfIndex.FindSubmatch(dict); indexMatch != nil {
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
		sizeMatch := pdfSize.FindSubmatch(dict)
		if sizeMatch == nil {
			return nil
		}
		total, err := strconv.Atoi(string(sizeMatch[1]))
		if err != nil || total < 0 {
			return nil
		}
		ranges[1] = total
	}

	xref := newPDFXRef()
	position := 0
	entryCount := 0
	for i := 0; i+1 < len(ranges); i += 2 {
		start, count := ranges[i], ranges[i+1]
		if start > maxXRefEntries || count > maxXRefEntries || start+count > 2*maxXRefEntries {
			return xref
		}
		for n := 0; n < count; n++ {
			if entryCount >= maxXRefEntries || position+rowWidth > len(decoded) {
				return xref
			}
			row := decoded[position : position+rowWidth]
			position += rowWidth
			entryCount++

			entryType := int64(1)
			if w0 > 0 {
				entryType = int64(pdfField(row[:w0]))
			}
			switch entryType {
			case pdfXRefEntryDirect:
				xref.add(start+n, pdfXRefEntry{
					kind:   pdfXRefEntryDirect,
					offset: int64(pdfField(row[w0 : w0+w1])),
				})
			case pdfXRefEntryCompressed:
				streamField := pdfField(row[w0 : w0+w1])
				indexField := pdfField(row[w0+w1 : rowWidth])
				if streamField == 0 || streamField > 2*maxXRefEntries || indexField > maxXRefEntries {
					continue
				}
				xref.add(start+n, pdfXRefEntry{
					kind:   pdfXRefEntryCompressed,
					stream: int(streamField),
					index:  int(indexField),
				})
			}
		}
	}
	return xref
}

// pdfPNGUnpredict 解码 PDF PNG predictor 流。Predictor 10–15 的每一行都带一个
// 过滤类型字节；xref 流按字节预测，左邻字节即 1 字节前。
func pdfPNGUnpredict(decoded []byte, predictor, columns int) []byte {
	if predictor < 10 || predictor > 15 || columns <= 0 || columns > 24<<10 {
		return nil
	}
	if len(decoded)%(columns+1) != 0 {
		return nil
	}
	rows := len(decoded) / (columns + 1)
	out := make([]byte, rows*columns)
	prev := make([]byte, columns)
	position := 0
	for row := 0; row < rows; row++ {
		filter := decoded[position]
		position++
		current := out[row*columns : (row+1)*columns]
		copy(current, decoded[position:position+columns])
		position += columns
		switch filter {
		case 0:
			// None.
		case 1:
			for i := 1; i < columns; i++ {
				current[i] += current[i-1]
			}
		case 2:
			for i := 0; i < columns; i++ {
				current[i] += prev[i]
			}
		case 3:
			for i := 0; i < columns; i++ {
				left := 0
				if i > 0 {
					left = int(current[i-1])
				}
				current[i] += byte((left + int(prev[i])) / 2)
			}
		case 4:
			for i := 0; i < columns; i++ {
				left := 0
				upperLeft := 0
				if i > 0 {
					left = int(current[i-1])
					upperLeft = int(prev[i-1])
				}
				current[i] += byte(pdfPaeth(left, int(prev[i]), upperLeft))
			}
		default:
			return nil
		}
		copy(prev, current)
	}
	return out
}

func pdfPaeth(left, up, upperLeft int) int {
	p := left + up - upperLeft
	pa := absInt(p - left)
	pb := absInt(p - up)
	pc := absInt(p - upperLeft)
	switch {
	case pa <= pb && pa <= pc:
		return left
	case pb <= pc:
		return up
	default:
		return upperLeft
	}
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func pdfField(field []byte) uint64 {
	var value uint64
	for _, b := range field {
		value = value<<8 | uint64(b)
	}
	return value
}

func pdfResolvePageCount(ctx context.Context, f *os.File, size int64, xref *pdfXRef, rootNumber int) int {
	if xref == nil || len(xref.entries) == 0 {
		return 0
	}
	resolver := &pdfObjectResolver{
		ctx:    ctx,
		f:      f,
		size:   size,
		xref:   xref,
		objStm: make(map[int]map[int][]byte),
	}
	root, err := resolver.objectDict(rootNumber)
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
	pages, err := resolver.objectDict(pagesNumber)
	if err != nil {
		return 0
	}

	if ref := pdfCountRef.FindSubmatch(pages); ref != nil {
		countNumber, err := strconv.Atoi(string(ref[1]))
		if err != nil {
			return 0
		}
		countObject, err := resolver.object(countNumber)
		if err != nil {
			return 0
		}
		return pdfCountRaw(countObject)
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

func pdfCountRaw(object []byte) int {
	value, _, ok := parsePDFUint(object, 0, maxPDFPageCount)
	if !ok || value <= 0 {
		return 0
	}
	return int(value)
}

// pdfObjectResolver 按 xref 条目读取直接对象或 /Type /ObjStm 内的压缩对象。
type pdfObjectResolver struct {
	ctx    context.Context
	f      *os.File
	size   int64
	xref   *pdfXRef
	objStm map[int]map[int][]byte
}

func (r *pdfObjectResolver) objectDict(number int) ([]byte, error) {
	object, err := r.object(number)
	if err != nil {
		return nil, err
	}
	start, end, ok := pdfFindDict(object)
	if !ok {
		return nil, errBadPDF
	}
	return object[start:end], nil
}

// object 返回对象正文（去掉 "n g obj" 头）；压缩对象返回 ObjStm 中的正文。
func (r *pdfObjectResolver) object(number int) ([]byte, error) {
	entry, ok := r.xref.entries[number]
	if !ok {
		return nil, errBadPDF
	}
	switch entry.kind {
	case pdfXRefEntryDirect:
		if entry.offset < 0 || entry.offset >= r.size {
			return nil, errBadPDF
		}
		object, err := readAt(r.ctx, r.f, r.size, entry.offset, maxPDFObjectBytes)
		if err != nil {
			return nil, err
		}
		header := pdfObjectHeader.FindIndex(object)
		if header == nil {
			return nil, errBadPDF
		}
		return bytes.TrimSpace(object[header[1]:]), nil
	case pdfXRefEntryCompressed:
		objects, err := r.loadObjectStream(entry.stream)
		if err != nil {
			return nil, err
		}
		object, ok := objects[number]
		if !ok {
			return nil, errBadPDF
		}
		return bytes.TrimSpace(object), nil
	default:
		return nil, errBadPDF
	}
}

func (r *pdfObjectResolver) loadObjectStream(number int) (map[int][]byte, error) {
	if cached, ok := r.objStm[number]; ok {
		return cached, nil
	}
	if len(r.objStm) >= maxPDFObjStmCaches {
		return nil, errBadPDF
	}
	entry, ok := r.xref.entries[number]
	if !ok || entry.kind != pdfXRefEntryDirect || entry.offset < 0 || entry.offset >= r.size {
		return nil, errBadPDF
	}
	header, err := readAt(r.ctx, r.f, r.size, entry.offset, maxPDFObjectBytes)
	if err != nil {
		return nil, err
	}
	if !pdfObjectHeader.Match(header) {
		return nil, errBadPDF
	}
	dictStart, dictEnd, ok := pdfFindDict(header)
	if !ok {
		return nil, errBadPDF
	}
	dict := header[dictStart:dictEnd]
	if !pdfObjStmType.Match(dict) {
		return nil, errBadPDF
	}
	lengthMatch := pdfLength.FindSubmatch(dict)
	nMatch := pdfObjStmN.FindSubmatch(dict)
	firstMatch := pdfObjStmFirst.FindSubmatch(dict)
	if lengthMatch == nil || nMatch == nil || firstMatch == nil {
		return nil, errBadPDF
	}
	length, err := strconv.ParseInt(string(lengthMatch[1]), 10, 64)
	if err != nil || length <= 0 || length > maxPDFObjStmBytes {
		return nil, errBadPDF
	}
	count, err := strconv.Atoi(string(nMatch[1]))
	if err != nil || count <= 0 || count > maxPDFObjStmObjects {
		return nil, errBadPDF
	}
	first, err := strconv.Atoi(string(firstMatch[1]))
	if err != nil || first <= 0 {
		return nil, errBadPDF
	}
	streamOffset, ok := pdfStreamStart(header, dictEnd)
	if !ok {
		return nil, errBadPDF
	}
	raw, err := readAt(r.ctx, r.f, r.size, entry.offset+int64(streamOffset), length)
	if err != nil || int64(len(raw)) != length {
		return nil, errBadPDF
	}

	var decoded []byte
	if bytes.Contains(dict, []byte("/FlateDecode")) {
		zr, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, errBadPDF
		}
		decoded, err = io.ReadAll(io.LimitReader(ctxReader{ctx: r.ctx, r: zr}, maxPDFObjStmBytes+1))
		closeErr := zr.Close()
		if err != nil || closeErr != nil || len(decoded) > maxPDFObjStmBytes {
			return nil, errBadPDF
		}
	} else if bytes.Contains(dict, []byte("/Filter")) {
		return nil, errBadPDF
	} else {
		decoded = raw
	}
	if first > len(decoded) {
		return nil, errBadPDF
	}

	index := decoded[:first]
	position := 0
	numbers := make([]int, count)
	offsets := make([]int, count)
	for i := 0; i < count; i++ {
		objectNumber, next, ok := parsePDFUint(index, position, maxPDFNumber)
		if !ok || objectNumber <= 0 || objectNumber > 2*maxXRefEntries {
			return nil, errBadPDF
		}
		objectOffset, next, ok := parsePDFUint(index, next, maxPDFNumber)
		if !ok || objectOffset > int64(len(decoded)-first) {
			return nil, errBadPDF
		}
		position = next
		numbers[i] = int(objectNumber)
		offsets[i] = int(objectOffset)
	}

	objects := make(map[int][]byte, count)
	for i, objectNumber := range numbers {
		start := first + offsets[i]
		end := len(decoded)
		if i+1 < count {
			end = first + offsets[i+1]
		}
		if start < first || end < start || end > len(decoded) {
			return nil, errBadPDF
		}
		objects[objectNumber] = decoded[start:end]
	}
	r.objStm[number] = objects
	return objects, nil
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
