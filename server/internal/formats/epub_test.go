package formats

import (
	"archive/zip"
	"context"
	"strings"
	"testing"
)

func TestEPUBValid(t *testing.T) {
	path := writeTempFile(t, "book.epub", buildEPUB(t))
	result, err := Validate(context.Background(), path, "EPUB")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !result.Readable || result.UnsupportedReason != "" {
		t.Fatalf("Readable/UnsupportedReason = %v/%q", result.Readable, result.UnsupportedReason)
	}
	if result.Format != FormatEPUB || result.MediaType != MediaTypeEPUB {
		t.Fatalf("format/media = %q/%q", result.Format, result.MediaType)
	}
	if result.Title != "Sample Book" {
		t.Fatalf("Title = %q", result.Title)
	}
	if len(result.Authors) != 2 || result.Authors[0] != "Alice" || result.Authors[1] != "Bob" {
		t.Fatalf("Authors = %#v", result.Authors)
	}
	if !result.HasCover {
		t.Fatal("HasCover = false")
	}
	if result.PageCount != 0 {
		t.Fatalf("PageCount = %d, want 0 for EPUB", result.PageCount)
	}
	if result.ErrorCode != "" {
		t.Fatalf("ErrorCode = %q", result.ErrorCode)
	}
}

func TestEPUBDRMIsPreservedButUnreadable(t *testing.T) {
	path := writeTempFile(t, "book.epub", buildEPUB(t,
		zipSample{name: "META-INF/encryption.xml", data: []byte(`<encryption/>`)},
	))
	result, err := Validate(context.Background(), path, "epub")
	requireUnsupported(t, result, err, UnsupportedDRMProtected)
	if result.Format != FormatEPUB || result.MediaType != MediaTypeEPUB {
		t.Fatalf("format/media = %q/%q", result.Format, result.MediaType)
	}
	if result.Title != "Sample Book" {
		t.Fatalf("metadata should still be parsed, Title = %q", result.Title)
	}
}

func TestEPUBRightsXMLIsUnreadable(t *testing.T) {
	path := writeTempFile(t, "book.epub", buildEPUB(t,
		zipSample{name: "META-INF/rights.xml", data: []byte(`<rights/>`)},
	))
	result, err := Validate(context.Background(), path, "epub")
	requireUnsupported(t, result, err, UnsupportedDRMProtected)
}

func TestEPUBMimetypeCompressionAndOrderCompatibility(t *testing.T) {
	tests := []struct {
		name    string
		entries []zipSample
	}{
		{
			name: "stored-first",
			entries: []zipSample{
				{name: "mimetype", data: []byte(epubMimetype), method: zip.Store},
				{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
				{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
			},
		},
		{
			name: "deflated-first",
			entries: []zipSample{
				{name: "mimetype", data: []byte(epubMimetype), method: zip.Deflate},
				{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
				{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
			},
		},
		{
			name: "deflated-last",
			entries: []zipSample{
				{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
				{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
				{name: "mimetype", data: []byte(epubMimetype), method: zip.Deflate},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "book.epub", buildZIP(t, test.entries))
			result, err := Validate(context.Background(), path, "epub")
			if err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if !result.Readable || result.Format != FormatEPUB {
				t.Fatalf("Readable/Format = %v/%q", result.Readable, result.Format)
			}
		})
	}
}

func TestEPUBMimetypeRejections(t *testing.T) {
	tests := []struct {
		name    string
		entries []zipSample
	}{
		{
			name: "missing",
			entries: []zipSample{
				{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
				{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
			},
		},
		{
			name: "wrong-value-deflated",
			entries: []zipSample{
				{name: "mimetype", data: []byte("application/zip"), method: zip.Deflate},
				{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
				{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
			},
		},
		{
			name: "too-long",
			entries: []zipSample{
				{name: "mimetype", data: []byte(epubMimetype + "\n"), method: zip.Deflate},
				{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
				{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
			},
		},
		{
			name: "over-64-bytes",
			entries: []zipSample{
				{name: "mimetype", data: []byte(epubMimetype + strings.Repeat("x", maxMimetypeBytes)), method: zip.Deflate},
				{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
				{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTempFile(t, "book.epub", buildZIP(t, test.entries))
			result, err := Validate(context.Background(), path, "epub")
			requireReason(t, result, err, ReasonCorruptContainer)
		})
	}
}

func TestEPUBMissingContainer(t *testing.T) {
	data := buildZIP(t, []zipSample{
		{name: "mimetype", data: []byte(epubMimetype), method: zip.Store},
		{name: "OEBPS/content.opf", data: []byte(epubPackageXML)},
	})
	path := writeTempFile(t, "book.epub", data)
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonCorruptContainer)
}

func TestEPUBMalformedOPF(t *testing.T) {
	data := buildZIP(t, []zipSample{
		{name: "mimetype", data: []byte(epubMimetype), method: zip.Store},
		{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
		{name: "OEBPS/content.opf", data: []byte(`<package><metadata><dc:title>broken`)},
	})
	path := writeTempFile(t, "book.epub", data)
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonCorruptContainer)
}

func TestEPUBExternalEntityRejected(t *testing.T) {
	opf := `<?xml version="1.0"?>
<!DOCTYPE package [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>&xxe;</dc:title></metadata>
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`
	data := buildZIP(t, []zipSample{
		{name: "mimetype", data: []byte(epubMimetype), method: zip.Store},
		{name: "META-INF/container.xml", data: []byte(epubContainerXML)},
		{name: "OEBPS/content.opf", data: []byte(opf)},
	})
	path := writeTempFile(t, "book.epub", data)
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonCorruptContainer)
	if err != nil && strings.Contains(err.Error(), "passwd") {
		t.Fatalf("error leaks entity content: %v", err)
	}
}

func TestEPUBRootfileTraversalRejected(t *testing.T) {
	container := strings.Replace(epubContainerXML, "OEBPS/content.opf", "../content.opf", 1)
	data := buildZIP(t, []zipSample{
		{name: "mimetype", data: []byte(epubMimetype), method: zip.Store},
		{name: "META-INF/container.xml", data: []byte(container)},
		{name: "content.opf", data: []byte(epubPackageXML)},
	})
	path := writeTempFile(t, "book.epub", data)
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonArchivePathTraversal)
}

func TestEPUBCorruptZIP(t *testing.T) {
	data := buildEPUB(t)
	truncated := data[:len(data)/2]
	path := writeTempFile(t, "book.epub", truncated)
	result, err := Validate(context.Background(), path, "epub")
	requireReason(t, result, err, ReasonCorruptContainer)
}

const (
	epubFontIdentifier = "urn:uuid:0f8b7c1e-1234-4abc-9def-0123456789ab"
	epubFontPackageXML = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Font Only</dc:title>
    <dc:identifier id="book-id">` + epubFontIdentifier + `</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
    <item id="font-1" href="fonts/book.otf" media-type="application/vnd.ms-opentype"/>
  </manifest>
  <spine><itemref idref="chapter-1"/></spine>
</package>`
)

func buildFontEPUB(t *testing.T, opf, encryption string) []byte {
	t.Helper()
	return buildZIP(t, []zipSample{
		{name: "mimetype", data: []byte(epubMimetype), method: zip.Store},
		{name: "META-INF/container.xml", data: []byte(epubContainerXML), method: zip.Deflate},
		{name: "OEBPS/content.opf", data: []byte(opf), method: zip.Deflate},
		{name: "OEBPS/chapter-1.xhtml", data: []byte("<html></html>"), method: zip.Deflate},
		{name: "OEBPS/fonts/book.otf", data: []byte("OTTO font bytes"), method: zip.Store},
		{name: "META-INF/encryption.xml", data: []byte(encryption), method: zip.Deflate},
	})
}

func epubEncryptionEntry(algorithm, target string) string {
	return `<enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="` + algorithm + `"/>
    <enc:CipherData><enc:CipherReference URI="` + target + `"/></enc:CipherData>
  </enc:EncryptedData>`
}

func epubEncryptionXML(entries ...string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
  xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  ` + strings.Join(entries, "\n  ") + `
</encryption>`
}

func TestEPUBFontOnlyObfuscationIsReadable(t *testing.T) {
	tests := []struct {
		name      string
		algorithm string
		target    string
	}{
		{
			name:      "idpf-root-relative",
			algorithm: idpfFontObfuscationAlgorithm,
			target:    "OEBPS/fonts/book.otf",
		},
		{
			name:      "adobe-opf-relative",
			algorithm: adobeFontObfuscationAlgorithm,
			target:    "fonts/book.otf",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := buildFontEPUB(t, epubFontPackageXML,
				epubEncryptionXML(epubEncryptionEntry(test.algorithm, test.target)))
			path := writeTempFile(t, "book.epub", data)
			before := sha256File(t, path)

			result, err := Validate(context.Background(), path, "epub")
			if err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if !result.Readable || result.UnsupportedReason != "" {
				t.Fatalf("Readable/UnsupportedReason = %v/%q, want true/empty", result.Readable, result.UnsupportedReason)
			}
			if result.Title != "Font Only" {
				t.Fatalf("Title = %q", result.Title)
			}
			if after := sha256File(t, path); after != before {
				t.Fatal("validator changed original bytes")
			}
		})
	}
}

func TestEPUBContentEncryptionRemainsUnreadable(t *testing.T) {
	tests := []struct {
		name    string
		entries []string
	}{
		{
			name: "content-only",
			entries: []string{
				epubEncryptionEntry("http://www.w3.org/2001/04/xmlenc#aes256-cbc", "OEBPS/chapter-1.xhtml"),
			},
		},
		{
			name: "font-and-content",
			entries: []string{
				epubEncryptionEntry(idpfFontObfuscationAlgorithm, "OEBPS/fonts/book.otf"),
				epubEncryptionEntry("http://www.w3.org/2001/04/xmlenc#aes256-cbc", "OEBPS/chapter-1.xhtml"),
			},
		},
		{
			name: "font-algorithm-on-content",
			entries: []string{
				epubEncryptionEntry(idpfFontObfuscationAlgorithm, "OEBPS/chapter-1.xhtml"),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := buildFontEPUB(t, epubFontPackageXML, epubEncryptionXML(test.entries...))
			path := writeTempFile(t, "book.epub", data)
			result, err := Validate(context.Background(), path, "epub")
			requireUnsupported(t, result, err, UnsupportedDRMProtected)
		})
	}
}

func TestEPUBUnknownEncryptionAlgorithmIsUnreadable(t *testing.T) {
	data := buildFontEPUB(t, epubFontPackageXML,
		epubEncryptionXML(epubEncryptionEntry(
			"http://www.w3.org/2001/04/xmlenc#aes256-cbc", "OEBPS/fonts/book.otf")))
	path := writeTempFile(t, "book.epub", data)
	result, err := Validate(context.Background(), path, "epub")
	requireUnsupported(t, result, err, UnsupportedDRMProtected)
}

func TestEPUBFontObfuscationWithoutDerivableKeyIsUnreadable(t *testing.T) {
	invalidIdentifierOPF := strings.ReplaceAll(epubFontPackageXML, epubFontIdentifier, "not-a-uuid")
	missingIdentifierOPF := strings.Replace(epubFontPackageXML,
		`<dc:identifier id="book-id">`+epubFontIdentifier+`</dc:identifier>`, "", 1)

	tests := []struct {
		name      string
		opf       string
		algorithm string
	}{
		{
			name:      "adobe-invalid-identifier",
			opf:       invalidIdentifierOPF,
			algorithm: adobeFontObfuscationAlgorithm,
		},
		{
			name:      "idpf-missing-identifier",
			opf:       missingIdentifierOPF,
			algorithm: idpfFontObfuscationAlgorithm,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := buildFontEPUB(t, test.opf,
				epubEncryptionXML(epubEncryptionEntry(test.algorithm, "OEBPS/fonts/book.otf")))
			path := writeTempFile(t, "book.epub", data)
			result, err := Validate(context.Background(), path, "epub")
			requireUnsupported(t, result, err, UnsupportedDRMProtected)
		})
	}
}
