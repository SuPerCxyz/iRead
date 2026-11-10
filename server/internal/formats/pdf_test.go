package formats

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"fmt"
	"strings"
	"testing"
)

func TestPDFValidPageCount(t *testing.T) {
	path := writeTempFile(t, "book.pdf", buildPDF(t, pdfOptions{pages: 3}))
	result, err := Validate(context.Background(), path, "pdf")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable || result.UnsupportedReason != "" {
		t.Fatalf("Readable/UnsupportedReason = %v/%q", result.Readable, result.UnsupportedReason)
	}
	if result.Format != FormatPDF || result.MediaType != MediaTypePDF {
		t.Fatalf("format/media = %q/%q", result.Format, result.MediaType)
	}
	if result.PageCount != 3 {
		t.Fatalf("PageCount = %d, want 3", result.PageCount)
	}
}

func TestPDFXRefStreamPageCount(t *testing.T) {
	path := writeTempFile(t, "book.pdf", buildPDFXRefStream(t, 4))
	result, err := Validate(context.Background(), path, "pdf")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable {
		t.Fatalf("Readable = false (%q)", result.UnsupportedReason)
	}
	if result.PageCount != 4 {
		t.Fatalf("PageCount = %d, want 4", result.PageCount)
	}
}

func TestPDFXRefStreamPredictorPageCount(t *testing.T) {
	path := writeTempFile(t, "book.pdf", buildPDFPredictorXRef(t, 6))
	result, err := Validate(context.Background(), path, "pdf")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable {
		t.Fatalf("Readable = false (%q)", result.UnsupportedReason)
	}
	if result.PageCount != 6 {
		t.Fatalf("PageCount = %d, want 6", result.PageCount)
	}
}

func TestPDFObjectStreamPageCount(t *testing.T) {
	path := writeTempFile(t, "book.pdf", buildPDFObjectStreamXRef(t, 5))
	result, err := Validate(context.Background(), path, "pdf")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable {
		t.Fatalf("Readable = false (%q)", result.UnsupportedReason)
	}
	if result.PageCount != 5 {
		t.Fatalf("PageCount = %d, want 5", result.PageCount)
	}
}

func TestPDFXRefPrevChainPageCount(t *testing.T) {
	path := writeTempFile(t, "book.pdf", buildPDFPrevChainXRef(t, 5))
	result, err := Validate(context.Background(), path, "pdf")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable {
		t.Fatalf("Readable = false (%q)", result.UnsupportedReason)
	}
	if result.PageCount != 5 {
		t.Fatalf("PageCount = %d, want 5", result.PageCount)
	}
}

func TestPDFPNGUnpredictFilters(t *testing.T) {
	const columns = 4
	rows := [][]byte{
		{1, 2, 3, 4},
		{9, 8, 7, 6},
		{0, 255, 128, 64},
	}
	raw := bytes.Join(rows, nil)
	prev := make([]byte, columns)
	encoded := make([]byte, 0, len(rows)*(columns+1))
	for _, filter := range []byte{0, 1, 2, 3, 4} {
		encoded = encoded[:0]
		copy(prev, make([]byte, columns))
		for _, row := range rows {
			encoded = append(encoded, filter)
			for i := 0; i < columns; i++ {
				left := 0
				upperLeft := 0
				if i > 0 {
					left = int(row[i-1])
					upperLeft = int(prev[i-1])
				}
				var predicted byte
				switch filter {
				case 0:
					predicted = row[i]
				case 1:
					predicted = row[i] - byte(left)
				case 2:
					predicted = row[i] - prev[i]
				case 3:
					predicted = row[i] - byte((left+int(prev[i]))/2)
				case 4:
					predicted = row[i] - byte(pdfPaeth(left, int(prev[i]), upperLeft))
				}
				encoded = append(encoded, predicted)
			}
			copy(prev, row)
		}
		decoded := pdfPNGUnpredict(encoded, 15, columns)
		if !bytes.Equal(decoded, raw) {
			t.Fatalf("filter %d: decoded = %v, want %v", filter, decoded, raw)
		}
	}
}

func TestPDFWithoutPageCountStillReadable(t *testing.T) {
	path := writeTempFile(t, "book.pdf", buildPDF(t, pdfOptions{pages: 2, omitCount: true}))
	result, err := Validate(context.Background(), path, "pdf")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable {
		t.Fatalf("Readable = false (%q)", result.UnsupportedReason)
	}
	if result.PageCount != 0 {
		t.Fatalf("PageCount = %d, want 0 when /Count is absent", result.PageCount)
	}
}

func TestPDFEncryptedIsPreservedButUnreadable(t *testing.T) {
	path := writeTempFile(t, "book.pdf", buildPDF(t, pdfOptions{pages: 2, encrypt: true}))
	result, err := Validate(context.Background(), path, "pdf")
	requireUnsupported(t, result, err, UnsupportedPDFEncrypted)
	if result.Format != FormatPDF || result.MediaType != MediaTypePDF {
		t.Fatalf("format/media = %q/%q", result.Format, result.MediaType)
	}
	if result.PageCount != 0 {
		t.Fatalf("PageCount = %d, want 0 for encrypted PDF", result.PageCount)
	}
}

func TestPDFCorruptRejected(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{name: "no-xref", data: []byte("%PDF-1.7\nthis is not really a pdf\n")},
		{name: "truncated", data: buildPDF(t, pdfOptions{pages: 2})[:120]},
		{name: "bad-startxref", data: bytes.Replace(
			buildPDF(t, pdfOptions{pages: 1}),
			[]byte("startxref\n"),
			[]byte("startxref\n999999999\n"),
			1,
		)},
		{name: "missing-root", data: bytes.Replace(
			buildPDF(t, pdfOptions{pages: 1}),
			[]byte("/Root 1 0 R"),
			[]byte(strings.Repeat(" ", len("/Root 1 0 R"))),
			1,
		)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "book.pdf", test.data)
			result, err := Validate(context.Background(), path, "pdf")
			requireReason(t, result, err, ReasonCorruptContainer)
		})
	}
}

func TestPDFHeaderWithinFirst1024Bytes(t *testing.T) {
	padded := append(bytes.Repeat([]byte(" "), 64), buildPDF(t, pdfOptions{pages: 1})...)
	// 前移后 xref 偏移失效，只验证文件头嗅探进入 PDF 分支而不是 mime_mismatch。
	path := writeTempFile(t, "book.pdf", padded)
	result, err := Validate(context.Background(), path, "pdf")
	if result.ErrorReason == ReasonMIMEMismatch {
		t.Fatalf("PDF header within 1024 bytes was not sniffed: %+v", result)
	}
	requireReason(t, result, err, ReasonCorruptContainer)
}

// 以下合成 PDF 覆盖 xref 流 Predictor 12、type-2 ObjStm 与 /Prev 增量链。
const (
	testXRefWidth  = 7
	testXRefColumn = testXRefWidth
)

func testXRefRow(kind byte, field2 uint32, field3 uint16) []byte {
	row := make([]byte, testXRefWidth)
	row[0] = kind
	binary.BigEndian.PutUint32(row[1:5], field2)
	binary.BigEndian.PutUint16(row[5:7], field3)
	return row
}

func deflateTestPDF(t *testing.T, data []byte) []byte {
	t.Helper()
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write(data); err != nil {
		t.Fatalf("compress: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close compression: %v", err)
	}
	return compressed.Bytes()
}

func encodeTestPDFPredictor12(t *testing.T, rows [][]byte) []byte {
	t.Helper()
	encoded := make([]byte, 0, len(rows)*(testXRefColumn+1))
	prev := make([]byte, testXRefColumn)
	for _, row := range rows {
		if len(row) != testXRefColumn {
			t.Fatalf("xref row width = %d, want %d", len(row), testXRefColumn)
		}
		encoded = append(encoded, 2) // PNG Up
		for i := 0; i < testXRefColumn; i++ {
			encoded = append(encoded, row[i]-prev[i])
		}
		copy(prev, row)
	}
	return encoded
}

func writeTestPDFXRef(t *testing.T, buffer *bytes.Buffer, number, size, root, indexStart, indexCount int, prev int64, rows [][]byte, predictor bool) int {
	t.Helper()
	if len(rows) != indexCount {
		t.Fatalf("xref rows = %d, want %d", len(rows), indexCount)
	}
	flattened := make([]byte, 0, len(rows)*testXRefWidth)
	for _, row := range rows {
		if len(row) != testXRefWidth {
			t.Fatalf("xref row width = %d, want %d", len(row), testXRefWidth)
		}
		flattened = append(flattened, row...)
	}
	if predictor {
		flattened = encodeTestPDFPredictor12(t, rows)
	}
	compressed := deflateTestPDF(t, flattened)
	offset := buffer.Len()
	dict := fmt.Sprintf("<< /Type /XRef /Size %d /Root %d 0 R /W [1 4 2] /Index [%d %d] /Filter /FlateDecode /Length %d",
		size, root, indexStart, indexCount, len(compressed))
	if predictor {
		dict += fmt.Sprintf(" /DecodeParms << /Columns %d /Predictor 12 >>", testXRefColumn)
	}
	if prev > 0 {
		dict += fmt.Sprintf(" /Prev %d", prev)
	}
	dict += " >>"
	fmt.Fprintf(buffer, "%d 0 obj\n%s\nstream\n", number, dict)
	buffer.Write(compressed)
	buffer.WriteString("\nendstream\nendobj\n")
	return offset
}

func writeTestPDFObject(t *testing.T, buffer *bytes.Buffer, offsets map[int]int, number int, body string) {
	t.Helper()
	offsets[number] = buffer.Len()
	fmt.Fprintf(buffer, "%d 0 obj\n%s\nendobj\n", number, body)
}

func buildPDFPredictorXRef(t *testing.T, pages int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	offsets := make(map[int]int)
	kids := make([]string, 0, pages)
	for i := 0; i < pages; i++ {
		kids = append(kids, fmt.Sprintf("%d 0 R", 3+i))
	}
	writeTestPDFObject(t, &buffer, offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeTestPDFObject(t, &buffer, offsets, 2, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pages))
	for i := 0; i < pages; i++ {
		writeTestPDFObject(t, &buffer, offsets, 3+i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
	}

	xrefNumber := pages + 3
	xrefOffset := buffer.Len()
	rows := make([][]byte, xrefNumber+1)
	rows[0] = testXRefRow(0, 0, 65535)
	for number := 1; number < xrefNumber; number++ {
		rows[number] = testXRefRow(1, uint32(offsets[number]), 0)
	}
	rows[xrefNumber] = testXRefRow(1, uint32(xrefOffset), 0)
	writeTestPDFXRef(t, &buffer, xrefNumber, xrefNumber+1, 1, 0, xrefNumber+1, 0, rows, true)
	fmt.Fprintf(&buffer, "startxref\n%d\n%%%%EOF\n", xrefOffset)
	return buffer.Bytes()
}

func buildPDFObjectStreamXRef(t *testing.T, pages int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	offsets := make(map[int]int)
	kids := make([]string, 0, pages)
	for i := 0; i < pages; i++ {
		kids = append(kids, fmt.Sprintf("%d 0 R", 3+i))
	}
	writeTestPDFObject(t, &buffer, offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>")
	for i := 0; i < pages; i++ {
		writeTestPDFObject(t, &buffer, offsets, 3+i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
	}

	objStmNumber := pages + 3
	xrefNumber := pages + 4
	header := "2 0 "
	body := fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pages)
	compressed := deflateTestPDF(t, []byte(header+body))
	offsets[objStmNumber] = buffer.Len()
	fmt.Fprintf(&buffer, "%d 0 obj\n<< /Type /ObjStm /N 1 /First %d /Filter /FlateDecode /Length %d >>\nstream\n",
		objStmNumber, len(header), len(compressed))
	buffer.Write(compressed)
	buffer.WriteString("\nendstream\nendobj\n")

	xrefOffset := buffer.Len()
	rows := make([][]byte, xrefNumber+1)
	rows[0] = testXRefRow(0, 0, 65535)
	for number := 1; number <= pages+2; number++ {
		rows[number] = testXRefRow(1, uint32(offsets[number]), 0)
	}
	rows[2] = testXRefRow(2, uint32(objStmNumber), 0)
	rows[objStmNumber] = testXRefRow(1, uint32(offsets[objStmNumber]), 0)
	rows[xrefNumber] = testXRefRow(1, uint32(xrefOffset), 0)
	writeTestPDFXRef(t, &buffer, xrefNumber, xrefNumber+1, 1, 0, xrefNumber+1, 0, rows, false)
	fmt.Fprintf(&buffer, "startxref\n%d\n%%%%EOF\n", xrefOffset)
	return buffer.Bytes()
}

func buildPDFPrevChainXRef(t *testing.T, pages int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	offsets := make(map[int]int)
	kids := make([]string, 0, pages)
	for i := 0; i < pages; i++ {
		kids = append(kids, fmt.Sprintf("%d 0 R", 3+i))
	}
	writeTestPDFObject(t, &buffer, offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeTestPDFObject(t, &buffer, offsets, 2, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pages))
	for i := 0; i < pages; i++ {
		writeTestPDFObject(t, &buffer, offsets, 3+i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
	}

	mainNumber := pages + 3
	mainOffset := buffer.Len()
	mainRows := make([][]byte, mainNumber+1)
	mainRows[0] = testXRefRow(0, 0, 65535)
	for number := 1; number < mainNumber; number++ {
		mainRows[number] = testXRefRow(1, uint32(offsets[number]), 0)
	}
	mainRows[mainNumber] = testXRefRow(1, uint32(mainOffset), 0)
	writeTestPDFXRef(t, &buffer, mainNumber, mainNumber+1, 1, 0, mainNumber+1, 0, mainRows, true)

	incrementalNumber := mainNumber + 1
	writeTestPDFObject(t, &buffer, offsets, incrementalNumber, "<< /Producer (iread test) >>")
	latestNumber := incrementalNumber + 1
	latestOffset := buffer.Len()
	latestRows := [][]byte{
		testXRefRow(1, uint32(offsets[incrementalNumber]), 0),
		testXRefRow(1, uint32(latestOffset), 0),
	}
	writeTestPDFXRef(t, &buffer, latestNumber, latestNumber+1, 1, incrementalNumber, 2, int64(mainOffset), latestRows, false)
	fmt.Fprintf(&buffer, "startxref\n%d\n%%%%EOF\n", latestOffset)
	return buffer.Bytes()
}
