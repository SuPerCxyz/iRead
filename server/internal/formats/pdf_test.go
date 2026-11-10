package formats

import (
	"bytes"
	"context"
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
