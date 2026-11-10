package formats

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func requireReason(t *testing.T, result Result, err error, reason string) {
	t.Helper()
	var validation *ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("expected ValidationError, got %v", err)
	}
	if validation.Reason != reason {
		t.Fatalf("reason = %q, want %q", validation.Reason, reason)
	}
	if result.ErrorCode != ErrorCodeInvalidFile {
		t.Fatalf("ErrorCode = %q, want %q", result.ErrorCode, ErrorCodeInvalidFile)
	}
	if result.ErrorReason != reason {
		t.Fatalf("ErrorReason = %q, want %q", result.ErrorReason, reason)
	}
	if !IsRejection(err) || !errors.Is(err, ErrInvalidFile) {
		t.Fatalf("error should be recognizable as invalid_file: %v", err)
	}
}

func requireUnsupported(t *testing.T, result Result, err error, reason string) {
	t.Helper()
	if err != nil {
		t.Fatalf("unsupported format should not return error: %v", err)
	}
	if result.Readable {
		t.Fatal("Readable = true, want false")
	}
	if result.UnsupportedReason != reason {
		t.Fatalf("UnsupportedReason = %q, want %q", result.UnsupportedReason, reason)
	}
	if result.ErrorCode != "" || result.ErrorReason != "" {
		t.Fatalf("unexpected error fields: %q/%q", result.ErrorCode, result.ErrorReason)
	}
}

func TestValidateEmptyAndExtension(t *testing.T) {
	empty := writeTempFile(t, "empty.epub", nil)
	result, err := Validate(context.Background(), empty, "epub")
	requireReason(t, result, err, ReasonEmptyFile)

	valid := buildEPUB(t)
	path := writeTempFile(t, "book.epub", valid)
	result, err = Validate(context.Background(), path, "txt")
	requireReason(t, result, err, ReasonExtensionNotAllowed)

	result, err = Validate(context.Background(), path, "")
	requireReason(t, result, err, ReasonExtensionNotAllowed)
}

func TestValidateMIMEMismatch(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		ext  string
	}{
		{name: "pdf-as-epub", data: buildPDF(t, pdfOptions{pages: 1}), ext: "epub"},
		{name: "random-as-pdf", data: []byte("not a pdf"), ext: "pdf"},
		{name: "rar-as-cbz", data: append([]byte(nil), rar5Signature...), ext: "cbz"},
		{name: "zip-as-pdf", data: buildEPUB(t), ext: "pdf"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "sample."+test.ext, test.data)
			result, err := Validate(context.Background(), path, test.ext)
			requireReason(t, result, err, ReasonMIMEMismatch)
		})
	}
}

func TestValidateMissingTempFileDoesNotLeakPath(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.epub")
	result, err := Validate(context.Background(), missing, "epub")
	if !errors.Is(err, ErrTempFileUnavailable) {
		t.Fatalf("err = %v, want ErrTempFileUnavailable", err)
	}
	if result.ErrorCode != "" {
		t.Fatalf("unexpected error code %q", result.ErrorCode)
	}
	if strings.Contains(err.Error(), dir) {
		t.Fatalf("error leaks path: %v", err)
	}
}

func TestValidateFileTooLarge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "huge.epub")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := file.Truncate(MaxFileSize + 1); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	_, err = Validate(context.Background(), path, "epub")
	if !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("err = %v, want ErrFileTooLarge", err)
	}
}

func TestValidateCanceledContext(t *testing.T) {
	path := writeTempFile(t, "book.epub", buildEPUB(t))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := Validate(ctx, path, "epub")
	requireReason(t, result, err, ReasonParserTimeout)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err should unwrap context.Canceled: %v", err)
	}
}

func TestValidatePreservesOriginalBytes(t *testing.T) {
	samples := []struct {
		name string
		ext  string
		data []byte
	}{
		{name: "valid.epub", ext: "epub", data: buildEPUB(t)},
		{name: "valid.pdf", ext: "pdf", data: buildPDF(t, pdfOptions{pages: 2})},
		{name: "valid.cbz", ext: "cbz", data: buildCBZ(t)},
		{name: "valid.cbr", ext: "cbr", data: append(append([]byte(nil), rar4Signature...), 0, 1, 2, 3)},
		{name: "drm.epub", ext: "epub", data: buildEPUB(t, zipSample{name: "META-INF/encryption.xml", data: []byte("<encryption/>")})},
		{name: "traversal.cbz", ext: "cbz", data: buildZIP(t, []zipSample{{name: "../page.png", data: tinyPNG(t)}})},
	}
	for _, sample := range samples {
		t.Run(sample.name, func(t *testing.T) {
			path := writeTempFile(t, sample.name, sample.data)
			beforeHash := sha256File(t, path)
			beforeInfo, err := os.Stat(path)
			if err != nil {
				t.Fatalf("stat: %v", err)
			}
			_, _ = Validate(context.Background(), path, sample.ext)
			afterHash := sha256File(t, path)
			afterInfo, err := os.Stat(path)
			if err != nil {
				t.Fatalf("stat after: %v", err)
			}
			if beforeHash != afterHash {
				t.Fatal("validator changed original bytes")
			}
			if beforeInfo.Size() != afterInfo.Size() {
				t.Fatal("validator changed original size")
			}
		})
	}
}

func TestArchivePathRejections(t *testing.T) {
	tests := []struct {
		name   string
		entry  string
		reason string
	}{
		{name: "parent", entry: "../evil.png", reason: ReasonArchivePathTraversal},
		{name: "nested-parent", entry: "pages/../../evil.png", reason: ReasonArchivePathTraversal},
		{name: "absolute", entry: "/etc/passwd", reason: ReasonArchivePathTraversal},
		{name: "drive", entry: `C:\windows\evil.png`, reason: ReasonArchivePathTraversal},
		{name: "nul", entry: "page\x00.png", reason: ReasonArchivePathTraversal},
		{name: "too-long", entry: strings.Repeat("a", maxArchivePathBytes+1), reason: ReasonArchiveEntryLimit},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "book.epub", buildEPUB(t, zipSample{name: test.entry, data: []byte("x")}))
			result, err := Validate(context.Background(), path, "epub")
			requireReason(t, result, err, test.reason)
			if strings.Contains(err.Error(), "evil") || strings.Contains(err.Error(), "passwd") {
				t.Fatalf("error leaks entry name: %v", err)
			}
			if strings.Contains(err.Error(), filepath.Dir(path)) {
				t.Fatalf("error leaks temporary path: %v", err)
			}
		})
	}
}

func TestZipSymlinkRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("ZIP symlink mode is not meaningful on Windows")
	}
	path := writeTempFile(t, "book.epub", buildEPUB(t, zipSample{
		name: "link.png",
		data: []byte("page.png"),
		mode: os.ModeSymlink | 0o777,
	}))
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonArchiveSymlink)
}

func TestZipEncryptedRejected(t *testing.T) {
	data := buildEPUB(t, zipSample{name: "OEBPS/extra.txt", data: []byte("x")})
	data = forceZipEncryptionFlag(data)
	path := writeTempFile(t, "book.epub", data)
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonEncryptedArchive)
}

func TestZipDuplicateEntryRejected(t *testing.T) {
	path := writeTempFile(t, "book.epub", buildEPUB(t,
		zipSample{name: "OEBPS/duplicate.txt", data: []byte("one")},
		zipSample{name: "OEBPS/duplicate.txt", data: []byte("two")},
	))
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonCorruptContainer)
}

func TestZipEntryLimitRejected(t *testing.T) {
	entries := make([]zipSample, 0, MaxArchiveEntries+1)
	for i := 0; i <= MaxArchiveEntries; i++ {
		entries = append(entries, zipSample{name: "empty/" + itoa(i), method: zip.Store})
	}
	path := writeTempFile(t, "book.epub", buildZIP(t, entries))
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonArchiveEntryLimit)
}

func TestZipCompressionBombRejected(t *testing.T) {
	bomb := make([]byte, 17<<20)
	path := writeTempFile(t, "book.epub", buildEPUB(t, zipSample{
		name:   "OEBPS/bomb.xml",
		data:   bomb,
		method: zip.Deflate,
	}))
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonArchiveCompressionRatio)
}

func forceZipEncryptionFlag(data []byte) []byte {
	patched := append([]byte(nil), data...)
	for i := 0; i+10 < len(patched); i++ {
		if bytes.HasPrefix(patched[i:], []byte{0x50, 0x4b, 0x03, 0x04}) {
			patched[i+6] |= 1
		}
		if bytes.HasPrefix(patched[i:], []byte{0x50, 0x4b, 0x01, 0x02}) {
			patched[i+8] |= 1
		}
	}
	return patched
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}
