package formats

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// cbrSample 返回只带合法 RAR 签名的原件。formats 层只做签名与大小校验，
// 页数、加密、多卷与损坏内容由 C6 漫画 manifest/索引层真实解析。
func cbrSample(signature []byte) []byte {
	return append(append([]byte(nil), signature...), 0, 1, 2, 3)
}

func TestCBRRar4AndRar5SignaturesAreReadable(t *testing.T) {
	tests := []struct {
		name      string
		signature []byte
		ext       string
	}{
		{name: "rar4", signature: rar4Signature, ext: "cbr"},
		{name: "rar5", signature: rar5Signature, ext: "cbr"},
		{name: "rar4-uppercase-extension", signature: rar4Signature, ext: "CBR"},
		{name: "rar5-dotted-extension", signature: rar5Signature, ext: ".cbr"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "book.cbr", cbrSample(test.signature))
			result, err := Validate(context.Background(), path, test.ext)
			if err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if !result.Readable {
				t.Fatal("Readable = false, want true for valid RAR signature")
			}
			if result.UnsupportedReason != "" {
				t.Fatalf("UnsupportedReason = %q, want empty", result.UnsupportedReason)
			}
			if result.Format != FormatCBR || result.MediaType != MediaTypeCBR {
				t.Fatalf("format/media = %q/%q", result.Format, result.MediaType)
			}
			// formats 层不解析 RAR 内容，页数由漫画索引层给出。
			if result.PageCount != 0 {
				t.Fatalf("PageCount = %d, want 0 until comic index resolves pages", result.PageCount)
			}
			if result.ErrorCode != "" || result.ErrorReason != "" {
				t.Fatalf("unexpected error fields: %q/%q", result.ErrorCode, result.ErrorReason)
			}
		})
	}
}

func TestCBRInvalidSignatureRejected(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{name: "plain-text", data: []byte("not rar at all")},
		{name: "zip", data: buildZIP(t, []zipSample{{name: "page1.png", data: tinyPNG(t)}})},
		{name: "signature-not-at-start", data: []byte("xxRar!\x1a\x07\x00")},
		{name: "truncated-rar5", data: []byte("Rar!\x1a\x07\x01")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "book.cbr", test.data)
			result, err := Validate(context.Background(), path, "cbr")
			requireReason(t, result, err, ReasonMIMEMismatch)
		})
	}
}

func TestCBREmptyFileRejected(t *testing.T) {
	path := writeTempFile(t, "empty.cbr", nil)
	result, err := Validate(context.Background(), path, "cbr")
	requireReason(t, result, err, ReasonEmptyFile)
}

func TestCBRFileTooLargeRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "huge.cbr")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := file.Write(rar5Signature); err != nil {
		t.Fatalf("write signature: %v", err)
	}
	if err := file.Truncate(MaxFileSize + 1); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	result, err := Validate(context.Background(), path, "cbr")
	if !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("err = %v, want ErrFileTooLarge", err)
	}
	if result.ErrorCode != "" || result.ErrorReason != "" {
		t.Fatalf("unexpected error fields: %q/%q", result.ErrorCode, result.ErrorReason)
	}
}

func TestCBRPreservesOriginalBytes(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{name: "valid-rar4", data: cbrSample(rar4Signature)},
		{name: "valid-rar5", data: cbrSample(rar5Signature)},
		// 签名合法但内容损坏：本层接受，C6 索引时再返回 invalid_archive。
		{name: "corrupt-rar5", data: append(append([]byte(nil), rar5Signature...), 0xff, 0x00, 0x7f)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, test.name+".cbr", test.data)
			beforeHash := sha256File(t, path)
			beforeInfo, err := os.Stat(path)
			if err != nil {
				t.Fatalf("stat: %v", err)
			}
			if _, err := Validate(context.Background(), path, "cbr"); err != nil {
				t.Fatalf("Validate: %v", err)
			}
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

// TestCBRDeepValidationDeferredToComicLayer 固定本层与 C6 的职责边界：
// 只有 RAR 签名、没有可解析内容也允许保存，Readable=true 且 PageCount=0；
// 加密、多卷、损坏等真实错误由 comic manifest/索引返回，本层不得假装已
// 验证深度内容。
func TestCBRDeepValidationDeferredToComicLayer(t *testing.T) {
	path := writeTempFile(t, "signature-only.cbr", rar5Signature)
	result, err := Validate(context.Background(), path, "cbr")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable || result.UnsupportedReason != "" || result.PageCount != 0 {
		t.Fatalf("readable/reason/pageCount = %v/%q/%d, want true/empty/0",
			result.Readable, result.UnsupportedReason, result.PageCount)
	}
}
