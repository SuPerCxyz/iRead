package formats

import (
	"archive/zip"
	"context"
	"sort"
	"testing"
)

func TestCBZValid(t *testing.T) {
	path := writeTempFile(t, "comic.cbz", buildCBZ(t))
	result, err := Validate(context.Background(), path, "cbz")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable || result.UnsupportedReason != "" {
		t.Fatalf("Readable/UnsupportedReason = %v/%q", result.Readable, result.UnsupportedReason)
	}
	if result.Format != FormatCBZ || result.MediaType != MediaTypeCBZ {
		t.Fatalf("format/media = %q/%q", result.Format, result.MediaType)
	}
	if result.PageCount != 3 {
		t.Fatalf("PageCount = %d, want 3 image entries", result.PageCount)
	}
	if !result.HasCover {
		t.Fatal("HasCover = false, want first image as cover")
	}
}

func TestCBZNoImagesRejected(t *testing.T) {
	path := writeTempFile(t, "comic.cbz", buildZIP(t, []zipSample{
		{name: "readme.txt", data: []byte("no pages")},
	}))
	result, err := Validate(context.Background(), path, "cbz")
	requireReason(t, result, err, ReasonCorruptContainer)
}

func TestCBZBrokenImageRejected(t *testing.T) {
	path := writeTempFile(t, "comic.cbz", buildZIP(t, []zipSample{
		{name: "page1.png", data: []byte("not a png")},
	}))
	result, err := Validate(context.Background(), path, "cbz")
	requireReason(t, result, err, ReasonCorruptContainer)
}

func TestCBZPixelLimit(t *testing.T) {
	tests := []struct {
		name          string
		width, height uint32
	}{
		{name: "total-pixels", width: 20_000, height: 20_000},
		{name: "single-side", width: 32_768, height: 10},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "comic.cbz", buildZIP(t, []zipSample{
				{name: "page1.png", data: pngHeaderOnly(test.width, test.height), method: zip.Store},
			}))
			result, err := Validate(context.Background(), path, "cbz")
			requireReason(t, result, err, ReasonImagePixelLimit)
		})
	}
}

func TestCBZIgnoresNonImageAndAppleDouble(t *testing.T) {
	path := writeTempFile(t, "comic.cbz", buildZIP(t, []zipSample{
		{name: "page1.png", data: tinyPNG(t), method: zip.Store},
		{name: "__MACOSX/._page1.png", data: []byte("appledouble"), method: zip.Store},
		{name: "notes.txt", data: []byte("ignored"), method: zip.Store},
	}))
	result, err := Validate(context.Background(), path, "cbz")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if result.PageCount != 1 {
		t.Fatalf("PageCount = %d, want 1", result.PageCount)
	}
}

func TestNaturalSortOrder(t *testing.T) {
	input := []string{
		"page10.png",
		"page2.png",
		"page1.png",
		"page11.png",
		"page02.png",
		"page01.png",
		"page9.png",
		"cover.png",
	}
	sort.Slice(input, func(i, j int) bool { return naturalLess(input[i], input[j]) })
	want := []string{
		"cover.png",
		"page1.png",
		"page01.png",
		"page2.png",
		"page02.png",
		"page9.png",
		"page10.png",
		"page11.png",
	}
	for i := range want {
		if input[i] != want[i] {
			t.Fatalf("natural order = %v, want %v", input, want)
		}
	}
}
