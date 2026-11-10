package progress

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateLocationAcceptsSupportedKinds(t *testing.T) {
	epubCFI := json.RawMessage(`{"locatorVersion":1,"spineIndex":3,"resourceId":"` +
		strings.Repeat("a", 32) + `","href":"OEBPS/ch3.xhtml","cfi":"epubcfi(/6/8!/4/2/2:0)",` +
		`"chapterProgress":0.4,"textQuote":{"exact":"文字","prefix":"前","suffix":"后"}}`)
	if _, err := ValidateLocation("epub", "epub-cfi", epubCFI); err != nil {
		t.Fatalf("epub-cfi: %v", err)
	}
	epubAnchor := json.RawMessage(`{"locatorVersion":1,"spineIndex":1,"href":"ch1.xhtml",` +
		`"anchorId":"p-1","chapterProgress":0.1,"textQuote":null}`)
	if _, err := ValidateLocation("epub", "epub-anchor", epubAnchor); err != nil {
		t.Fatalf("epub-anchor: %v", err)
	}
	pdf := json.RawMessage(`{"locatorVersion":1,"page":128,"pageOffset":0.37,` +
		`"relativeViewport":{"x":0.1,"y":0.2,"width":0.8,"height":0.7},` +
		`"view":{"layoutMode":"single","zoomMode":"manual","manualScale":1.5}}`)
	if _, err := ValidateLocation("pdf", "pdf-page", pdf); err != nil {
		t.Fatalf("pdf-page: %v", err)
	}
	comic := json.RawMessage(`{"locatorVersion":1,"page":37,"pageOffset":0,"direction":"rtl","mode":"double","fit":"width"}`)
	if _, err := ValidateLocation("cbz", "comic-page", comic); err != nil {
		t.Fatalf("comic-page: %v", err)
	}
}

func TestValidateLocationRejectsMismatchAndBadNumbers(t *testing.T) {
	cases := []struct {
		name        string
		format      string
		locatorType string
		payload     string
	}{
		{"format mismatch", "pdf", "epub-cfi", `{"locatorVersion":1,"spineIndex":0,"cfi":"epubcfi(/6/2)","chapterProgress":0}`},
		{"bad cfi", "epub", "epub-cfi", `{"locatorVersion":1,"spineIndex":0,"cfi":"not-a-cfi","chapterProgress":0}`},
		{"page zero", "pdf", "pdf-page", `{"locatorVersion":1,"page":0,"pageOffset":0}`},
		{"offset too big", "pdf", "pdf-page", `{"locatorVersion":1,"page":1,"pageOffset":1.2}`},
		{"capability null", "comic", "comic-page", `{"locatorVersion":1,"page":1,"pageOffset":0,"direction":null,"mode":"single","fit":"screen"}`},
		{"bad fit", "cbz", "comic-page", `{"locatorVersion":1,"page":1,"pageOffset":0,"direction":"ltr","mode":"single","fit":"huge"}`},
		{"array payload", "epub", "epub-cfi", `[]`},
		{"locator version", "epub", "epub-anchor", `{"locatorVersion":2,"spineIndex":0,"anchorId":"a","chapterProgress":0}`},
	}
	for _, testCase := range cases {
		if _, err := ValidateLocation(testCase.format, testCase.locatorType, json.RawMessage(testCase.payload)); err == nil {
			t.Fatalf("%s 期望失败", testCase.name)
		}
	}
}

func TestBookmarkLocatorKeyStableAndLabel(t *testing.T) {
	pdfA := json.RawMessage(`{"locatorVersion":1,"page":128,"pageOffset":0.34561}`)
	pdfB := json.RawMessage(`{"locatorVersion":1,"page":128,"pageOffset":0.34562}`)
	keyA, err := BuildBookmarkLocatorKey("pdf-page", pdfA)
	if err != nil {
		t.Fatal(err)
	}
	keyB, err := BuildBookmarkLocatorKey("pdf-page", pdfB)
	if err != nil {
		t.Fatal(err)
	}
	if keyA != keyB {
		t.Fatalf("相同千分位 offset key 不同: %s != %s", keyA, keyB)
	}
	keyDifferent, err := BuildBookmarkLocatorKey("pdf-page",
		json.RawMessage(`{"locatorVersion":1,"page":128,"pageOffset":0.36}`))
	if err != nil {
		t.Fatal(err)
	}
	if keyA == keyDifferent {
		t.Fatal("不同 offset key 相同")
	}
	if len(keyA) != 64 {
		t.Fatalf("key 长度 = %d", len(keyA))
	}

	epub := json.RawMessage(`{"locatorVersion":1,"spineIndex":2,"cfi":"epubcfi(/6/6!/4/2/2:0)","chapterProgress":0.2,` +
		`"textQuote":{"exact":"  一段   文字  "}}`)
	first, err := BuildBookmarkLocatorKey("epub-cfi", epub)
	if err != nil {
		t.Fatal(err)
	}
	second, err := BuildBookmarkLocatorKey("epub-cfi", epub)
	if err != nil || first != second {
		t.Fatalf("CFI key 不稳定: %v", err)
	}
	if label := DefaultBookmarkLabel("epub-cfi", epub); label != "一段 文字" {
		t.Fatalf("EPUB label = %q", label)
	}
	if label := DefaultBookmarkLabel("pdf-page", pdfA); label != "第 128 页" {
		t.Fatalf("PDF label = %q", label)
	}
	if label := DefaultBookmarkLabel("epub-anchor",
		json.RawMessage(`{"locatorVersion":1,"spineIndex":2,"anchorId":"p1","chapterProgress":0}`)); label != "第 3 节" {
		t.Fatalf("Anchor label = %q", label)
	}
}
