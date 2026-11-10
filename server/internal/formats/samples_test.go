package formats

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

const epubContainerXML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const epubPackageXML = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Sample Book</dc:title>
    <dc:creator>Alice</dc:creator>
    <dc:creator>Bob</dc:creator>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="chapter-1"/>
  </spine>
</package>`

type zipSample struct {
	name   string
	data   []byte
	method uint16
	mode   os.FileMode
	flags  uint16
}

func writeTempFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func buildZIP(t *testing.T, entries []zipSample) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: entry.method, Flags: entry.flags}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("create zip entry %q: %v", entry.name, err)
		}
		if _, err := part.Write(entry.data); err != nil {
			t.Fatalf("write zip entry %q: %v", entry.name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buffer.Bytes()
}

func buildEPUB(t *testing.T, extra ...zipSample) []byte {
	t.Helper()
	entries := []zipSample{
		{name: "mimetype", data: []byte(epubMimetype), method: zip.Store},
		{name: "META-INF/container.xml", data: []byte(epubContainerXML), method: zip.Deflate},
		{name: "OEBPS/content.opf", data: []byte(epubPackageXML), method: zip.Deflate},
		{name: "OEBPS/cover.png", data: tinyPNG(t), method: zip.Store},
	}
	entries = append(entries, extra...)
	return buildZIP(t, entries)
}

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.RGBA{R: 200, G: 30, B: 30, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}

func tinyJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.RGBA{R: 30, G: 30, B: 200, A: 255})
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, img, nil); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buffer.Bytes()
}

// pngHeaderOnly 生成只有 IHDR/IEND 的 PNG，供 DecodeConfig 触发像素限制。
func pngHeaderOnly(width, height uint32) []byte {
	var buffer bytes.Buffer
	buffer.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	writePNGChunk(&buffer, "IHDR", ihdr)
	writePNGChunk(&buffer, "IEND", nil)
	return buffer.Bytes()
}

func writePNGChunk(buffer *bytes.Buffer, name string, data []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	buffer.Write(length[:])
	buffer.WriteString(name)
	buffer.Write(data)
	crcInput := append([]byte(name), data...)
	var checksum [4]byte
	binary.BigEndian.PutUint32(checksum[:], crc32.ChecksumIEEE(crcInput))
	buffer.Write(checksum[:])
}

type pdfOptions struct {
	pages     int
	encrypt   bool
	omitCount bool
}

func buildPDF(t *testing.T, options pdfOptions) []byte {
	t.Helper()
	if options.pages <= 0 {
		options.pages = 1
	}
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	offsets := make([]int, 0, options.pages+2)
	writeObject := func(number int, body string) {
		offsets = append(offsets, buffer.Len())
		fmt.Fprintf(&buffer, "%d 0 obj\n%s\nendobj\n", number, body)
	}

	kids := ""
	for i := 0; i < options.pages; i++ {
		if i > 0 {
			kids += " "
		}
		kids += fmt.Sprintf("%d 0 R", 3+i)
	}
	countClause := fmt.Sprintf(" /Count %d", options.pages)
	if options.omitCount {
		countClause = ""
	}
	writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeObject(2, fmt.Sprintf("<< /Type /Pages /Kids [%s]%s >>", kids, countClause))
	for i := 0; i < options.pages; i++ {
		writeObject(3+i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
	}
	encryptNumber := 0
	if options.encrypt {
		encryptNumber = 3 + options.pages
		writeObject(encryptNumber, "<< /Filter /Standard /V 1 /R 2 >>")
	}

	xrefOffset := buffer.Len()
	fmt.Fprintf(&buffer, "xref\n0 %d\n", len(offsets)+1)
	buffer.WriteString("0000000000 65535 f \n")
	for _, offset := range offsets {
		fmt.Fprintf(&buffer, "%010d 00000 n \n", offset)
	}
	encryptClause := ""
	if options.encrypt {
		encryptClause = fmt.Sprintf(" /Encrypt %d 0 R", encryptNumber)
	}
	fmt.Fprintf(&buffer, "trailer\n<< /Size %d /Root 1 0 R%s >>\nstartxref\n%d\n%%%%EOF\n",
		len(offsets)+1, encryptClause, xrefOffset)
	return buffer.Bytes()
}

// buildPDFXRefStream 生成使用 xref 流的 PDF（无经典 xref/trailer）。
func buildPDFXRefStream(t *testing.T, pages int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	offsets := make([]int, 0, pages+3)
	writeObject := func(number int, body string) {
		offsets = append(offsets, buffer.Len())
		fmt.Fprintf(&buffer, "%d 0 obj\n%s\nendobj\n", number, body)
	}
	kids := ""
	for i := 0; i < pages; i++ {
		if i > 0 {
			kids += " "
		}
		kids += fmt.Sprintf("%d 0 R", 3+i)
	}
	writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeObject(2, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", kids, pages))
	for i := 0; i < pages; i++ {
		writeObject(3+i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
	}

	xrefOffset := buffer.Len()
	xrefNumber := pages + 3
	entries := make([]byte, 0, (xrefNumber+1)*7)
	appendEntry := func(kind byte, offset uint32, generation uint16) {
		entries = append(entries, kind)
		var field [4]byte
		binary.BigEndian.PutUint32(field[:], offset)
		entries = append(entries, field[:]...)
		var gen [2]byte
		binary.BigEndian.PutUint16(gen[:], generation)
		entries = append(entries, gen[:]...)
	}
	appendEntry(0, 0, 65535)
	for _, offset := range offsets {
		appendEntry(1, uint32(offset), 0)
	}
	appendEntry(1, uint32(xrefOffset), 0)

	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write(entries); err != nil {
		t.Fatalf("compress xref: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close xref compression: %v", err)
	}
	fmt.Fprintf(&buffer, "%d 0 obj\n<< /Type /XRef /Size %d /Root 1 0 R /W [1 4 2] /Index [0 %d] /Filter /FlateDecode /Length %d >>\nstream\n",
		xrefNumber, xrefNumber+1, xrefNumber+1, compressed.Len())
	buffer.Write(compressed.Bytes())
	buffer.WriteString("\nendstream\nendobj\n")
	fmt.Fprintf(&buffer, "startxref\n%d\n%%%%EOF\n", xrefOffset)
	return buffer.Bytes()
}

func buildCBZ(t *testing.T) []byte {
	t.Helper()
	return buildZIP(t, []zipSample{
		{name: "page10.png", data: tinyPNG(t), method: zip.Store},
		{name: "page2.jpg", data: tinyJPEG(t), method: zip.Store},
		{name: "page1.png", data: tinyPNG(t), method: zip.Store},
		{name: "notes.txt", data: []byte("ignored")},
	})
}

func sha256File(t *testing.T, path string) [32]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return sha256.Sum256(data)
}
