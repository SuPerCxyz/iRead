package jobs

import (
	"archive/zip"
	"fmt"
	"testing"
)

type epubSampleOptions struct {
	nav            bool
	ncx            bool
	cover          bool
	coverSize      pngOptions
	brokenCover    bool
	nonce          int
	encryptionXML  []byte
	mimetypeMethod uint16
}

func buildEPUB(t *testing.T, options epubSampleOptions) []byte {
	t.Helper()
	manifest := []string{
		`<item id="chapter1" href="ch1.xhtml" media-type="application/xhtml+xml"/>`,
		`<item id="chapter2" href="ch2.xhtml" media-type="application/xhtml+xml"/>`,
	}
	spineToc := ""
	if options.nav {
		manifest = append(manifest, `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`)
	}
	if options.ncx {
		manifest = append(manifest, `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`)
		spineToc = ` toc="ncx"`
	}
	if options.cover {
		manifest = append(manifest, `<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>`)
	}
	opf := fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Sample Book</dc:title>
    <dc:creator>Alice</dc:creator>
    <dc:creator>Bob</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>Test Press</dc:publisher>
    <dc:date>2024-01-02</dc:date>
    <dc:identifier id="uid">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>
  </metadata>
  <manifest>
    %s
  </manifest>
  <spine%s>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>`, joinLines(manifest), spineToc)

	entries := []zipEntry{
		{name: "mimetype", data: []byte("application/epub+zip"), method: options.mimetypeMethod},
		{name: "META-INF/container.xml", data: []byte(`<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`), method: zip.Deflate},
		{name: "OEBPS/content.opf", data: []byte(opf), method: zip.Deflate},
		{name: "OEBPS/ch1.xhtml", data: []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1</h1></body></html>`), method: zip.Deflate},
		{name: "OEBPS/ch2.xhtml", data: []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 2</h1></body></html>`), method: zip.Deflate},
	}
	if options.nav {
		entries = append(entries, zipEntry{name: "OEBPS/nav.xhtml", data: []byte(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="ch1.xhtml#start">Chapter 1</a>
        <ol><li><a href="ch1.xhtml#section-1">Section 1.1</a></li></ol>
      </li>
      <li><a href="ch2.xhtml">Chapter 2</a></li>
    </ol>
  </nav>
</body>
</html>`), method: zip.Deflate})
	}
	if options.ncx {
		entries = append(entries, zipEntry{name: "OEBPS/toc.ncx", data: []byte(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>NCX One</text></navLabel><content src="ch1.xhtml#start"/>
      <navPoint id="n1-1"><navLabel><text>NCX One A</text></navLabel><content src="ch1.xhtml#section-1"/></navPoint>
    </navPoint>
    <navPoint id="n2"><navLabel><text>NCX Two</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`), method: zip.Deflate})
	}
	if options.encryptionXML != nil {
		entries = append(entries, zipEntry{
			name:   "META-INF/encryption.xml",
			data:   options.encryptionXML,
			method: zip.Deflate,
		})
	}
	if options.nonce > 0 {
		entries = append(entries, zipEntry{
			name:   fmt.Sprintf("OEBPS/nonce-%d.txt", options.nonce),
			data:   []byte("nonce"),
			method: zip.Deflate,
		})
	}
	if options.cover {
		coverData := makePNG(t, options.coverSize)
		if options.brokenCover {
			coverData = []byte("not a decodable image")
		}
		entries = append(entries, zipEntry{
			name:   "OEBPS/images/cover.png",
			data:   coverData,
			method: zip.Deflate,
		})
	}
	return buildZIP(t, entries)
}

func joinLines(lines []string) string {
	result := ""
	for index, line := range lines {
		if index > 0 {
			result += "\n    "
		}
		result += line
	}
	return result
}

func buildPDF(t *testing.T, title, author string, pages int) []byte {
	t.Helper()
	if pages < 1 {
		pages = 1
	}
	objects := make([]string, 0, pages+3)
	objects = append(objects, `<< /Type /Catalog /Pages 2 0 R >>`)
	kids := ""
	for page := 0; page < pages; page++ {
		if page > 0 {
			kids += " "
		}
		kids += fmt.Sprintf("%d 0 R", page+3)
	}
	objects = append(objects, fmt.Sprintf(`<< /Type /Pages /Kids [%s] /Count %d >>`, kids, pages))
	for page := 0; page < pages; page++ {
		objects = append(objects, fmt.Sprintf(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>`))
	}
	infoNumber := pages + 3
	info := "<<"
	if title != "" {
		info += " /Title (" + title + ")"
	}
	if author != "" {
		info += " /Author (" + author + ")"
	}
	info += " >>"
	objects = append(objects, info)

	return renderPDF(t, objects, infoNumber)
}

func renderPDF(t *testing.T, objects []string, infoNumber int) []byte {
	t.Helper()
	buffer := []byte("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = len(buffer)
		buffer = append(buffer, []byte(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", index+1, object))...)
	}
	xrefOffset := len(buffer)
	buffer = append(buffer, []byte(fmt.Sprintf("xref\n0 %d\n", len(objects)+1))...)
	buffer = append(buffer, []byte("0000000000 65535 f \n")...)
	for index := 1; index <= len(objects); index++ {
		buffer = append(buffer, []byte(fmt.Sprintf("%010d 00000 n \n", offsets[index]))...)
	}
	buffer = append(buffer, []byte(fmt.Sprintf(
		"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n",
		len(objects)+1, infoNumber, xrefOffset))...)
	return buffer
}

func buildCBZ(t *testing.T, pageSizes []pngOptions) []byte {
	t.Helper()
	entries := make([]zipEntry, 0, len(pageSizes))
	for index, size := range pageSizes {
		name := fmt.Sprintf("pages/page%d.png", index+1)
		entries = append(entries, zipEntry{name: name, data: makePNG(t, size), method: zip.Deflate})
	}
	return buildZIP(t, entries)
}
