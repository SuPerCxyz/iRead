// Package epubtest 生成测试用 EPUB 2/3 样本。它不是生产代码，只被阅读器
// 测试用来验证真实 ZIP 解析、字体混淆与资源读取。
package epubtest

import (
	"archive/zip"
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// Options 控制样本版本与保护方式。
type Options struct {
	// Version 为 2 或 3；零值按 3 处理。
	Version int
	// ObfuscateFont 为 "idpf"、"adobe" 或空。
	ObfuscateFont string
	// EncryptContent 为 true 时对第一章声明 AES 内容加密。
	EncryptContent bool
	// MimetypeMethod 控制 mimetype 条目的压缩方法；零值按 zip.Store。
	MimetypeMethod uint16
}

// Sample 是生成的 EPUB 字节与测试期望值。
type Sample struct {
	Data       []byte
	Version    int
	Identifier string

	NavPath string
	NCXPath string

	ChapterPaths []string
	ChapterData  [][]byte

	CSSPath string
	CSSData []byte

	ImagePath string
	ImageData []byte

	CoverPath string
	CoverData []byte

	FontPath      string
	FontMediaType string
	FontPlain     []byte

	AudioPath string
	AudioData []byte

	ContentEncryptPath string
}

const (
	epub3Identifier = "urn:uuid:12345678-1234-1234-1234-123456789abc"
	epub2Identifier = "urn:uuid:87654321-4321-4321-4321-cba987654321"
)

// Build 生成可被 archive/zip 正常打开的最小 EPUB。
func Build(options Options) (*Sample, error) {
	version := options.Version
	if version == 0 {
		version = 3
	}
	if version != 2 && version != 3 {
		return nil, errors.New("epubtest: version 必须是 2 或 3")
	}
	switch options.ObfuscateFont {
	case "", "idpf", "adobe":
	default:
		return nil, errors.New("epubtest: 不支持的字体混淆算法")
	}

	sample := &Sample{
		Version:       version,
		Identifier:    epub3Identifier,
		CSSPath:       "OEBPS/Styles/style.css",
		CSSData:       []byte("body { color: #123456; }\n"),
		ImagePath:     "OEBPS/Images/pic.png",
		ImageData:     samplePNG(),
		CoverPath:     "OEBPS/Images/cover.png",
		CoverData:     samplePNG(),
		FontPath:      "OEBPS/Fonts/book.otf",
		FontMediaType: "application/vnd.ms-opentype",
		AudioPath:     "OEBPS/Media/sample.mp3",
		AudioData:     []byte{0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00},
	}
	if version == 2 {
		sample.Identifier = epub2Identifier
		sample.NCXPath = "OEBPS/toc.ncx"
	} else {
		sample.NavPath = "OEBPS/nav.xhtml"
	}
	sample.ChapterPaths = []string{"OEBPS/Text/ch1.xhtml", "OEBPS/Text/ch2.xhtml"}
	sample.ChapterData = [][]byte{
		[]byte(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>
<body><h1 id="start">Chapter 1</h1><p id="part">Hello EPUB.</p></body></html>`),
		[]byte(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 2</title></head>
<body><h1 id="second">Chapter 2</h1><p>Second chapter.</p></body></html>`),
	}
	if options.EncryptContent {
		sample.ContentEncryptPath = sample.ChapterPaths[0]
	}

	fontPlain := make([]byte, 2500)
	copy(fontPlain, "OTTO")
	for index := 4; index < len(fontPlain); index++ {
		fontPlain[index] = byte((index*37 + 11) % 251)
	}
	sample.FontPlain = fontPlain
	fontStored := append([]byte(nil), fontPlain...)
	if options.ObfuscateFont != "" {
		if err := obfuscateFont(fontStored, options.ObfuscateFont, sample.Identifier); err != nil {
			return nil, err
		}
	}

	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	mimetypeMethod := options.MimetypeMethod
	if mimetypeMethod == 0 {
		mimetypeMethod = zip.Store
	}
	if err := writeZIPEntry(writer, "mimetype", []byte("application/epub+zip"), mimetypeMethod); err != nil {
		return nil, err
	}
	container := `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
	if err := writeZIPEntry(writer, "META-INF/container.xml", []byte(container), zip.Deflate); err != nil {
		return nil, err
	}
	if err := writeZIPEntry(writer, "OEBPS/content.opf", []byte(packageXML(sample, version)), zip.Deflate); err != nil {
		return nil, err
	}
	if version == 3 {
		if err := writeZIPEntry(writer, sample.NavPath, []byte(epub3Nav()), zip.Deflate); err != nil {
			return nil, err
		}
	} else {
		if err := writeZIPEntry(writer, sample.NCXPath, []byte(epub2NCX()), zip.Deflate); err != nil {
			return nil, err
		}
	}
	for index, chapterPath := range sample.ChapterPaths {
		if err := writeZIPEntry(writer, chapterPath, sample.ChapterData[index], zip.Deflate); err != nil {
			return nil, err
		}
	}
	if err := writeZIPEntry(writer, sample.CSSPath, sample.CSSData, zip.Deflate); err != nil {
		return nil, err
	}
	if err := writeZIPEntry(writer, sample.ImagePath, sample.ImageData, zip.Deflate); err != nil {
		return nil, err
	}
	if err := writeZIPEntry(writer, sample.CoverPath, sample.CoverData, zip.Deflate); err != nil {
		return nil, err
	}
	if err := writeZIPEntry(writer, sample.FontPath, fontStored, zip.Deflate); err != nil {
		return nil, err
	}
	if err := writeZIPEntry(writer, sample.AudioPath, sample.AudioData, zip.Deflate); err != nil {
		return nil, err
	}
	if options.ObfuscateFont != "" || options.EncryptContent {
		encryption := encryptionXML(options, sample)
		if err := writeZIPEntry(writer, "META-INF/encryption.xml", []byte(encryption), zip.Deflate); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	sample.Data = buffer.Bytes()
	return sample, nil
}

func writeZIPEntry(writer *zip.Writer, name string, data []byte, method uint16) error {
	header := &zip.FileHeader{Name: name, Method: method}
	header.SetMode(0o644)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = entry.Write(data)
	return err
}

func packageXML(sample *Sample, version int) string {
	items := make([]string, 0, 9)
	spineTOC := ""
	if version == 3 {
		items = append(items, `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`)
	} else {
		items = append(items, `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`)
		spineTOC = ` toc="ncx"`
	}
	items = append(items,
		`<item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>`,
		`<item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>`,
		`<item id="css" href="Styles/style.css" media-type="text/css"/>`,
		`<item id="pic" href="Images/pic.png" media-type="image/png"/>`,
		`<item id="cover-image" href="Images/cover.png" media-type="image/png"`+coverProperty(version)+`/>`,
		`<item id="font" href="Fonts/book.otf" media-type="`+sample.FontMediaType+`"/>`,
		`<item id="audio" href="Media/sample.mp3" media-type="audio/mpeg"/>`,
	)
	metadata := `<dc:title>Sample Book</dc:title>
    <dc:identifier id="bookid">` + sample.Identifier + `</dc:identifier>
    <dc:language>en</dc:language>`
	if version == 3 {
		metadata += `
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
    <meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:flow">paginated</meta>
    <meta property="rendition:spread">auto</meta>`
	} else {
		metadata += `
    <meta name="cover" content="cover-image"/>`
	}
	progression := ""
	if version == 3 {
		progression = ` page-progression-direction="rtl"`
	}
	return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="` + fmt.Sprintf("%d.0", version) + `" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ` + metadata + `
  </metadata>
  <manifest>
    ` + strings.Join(items, "\n    ") + `
  </manifest>
  <spine` + spineTOC + progression + `>
    <itemref idref="ch1"/>
    <itemref idref="ch2" linear="no"/>
  </spine>
</package>`
}

func coverProperty(version int) string {
	if version == 3 {
		return ` properties="cover-image"`
	}
	return ""
}

func epub3Nav() string {
	return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="Text/ch1.xhtml#start">Chapter 1</a></li>
      <li><span>Part One</span>
        <ol><li><a href="Text/ch2.xhtml">Chapter 2</a></li></ol>
      </li>
    </ol>
  </nav>
</body>
</html>`
}

func epub2NCX() string {
	return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="p1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="Text/ch1.xhtml#start"/>
      <navPoint id="p1a" playOrder="2">
        <navLabel><text>Section 1.1</text></navLabel>
        <content src="Text/ch1.xhtml#part"/>
      </navPoint>
    </navPoint>
    <navPoint id="p2" playOrder="3">
      <navLabel><text>Chapter 2</text></navLabel>
      <content src="Text/ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
}

func encryptionXML(options Options, sample *Sample) string {
	entries := make([]string, 0, 2)
	if options.ObfuscateFont == "idpf" {
		entries = append(entries, encryptionEntry(
			"http://www.idpf.org/2008/embedding", sample.FontPath))
	}
	if options.ObfuscateFont == "adobe" {
		entries = append(entries, encryptionEntry(
			"http://ns.adobe.com/pdf/enc#RC", sample.FontPath))
	}
	if options.EncryptContent {
		entries = append(entries, encryptionEntry(
			"http://www.w3.org/2001/04/xmlenc#aes256-cbc", sample.ContentEncryptPath))
	}
	return `<?xml version="1.0" encoding="utf-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
  xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  ` + strings.Join(entries, "\n  ") + `
</encryption>`
}

func encryptionEntry(algorithm, uri string) string {
	return `<enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="` + algorithm + `"/>
    <enc:CipherData><enc:CipherReference URI="` + uri + `"/></enc:CipherData>
  </enc:EncryptedData>`
}

func obfuscateFont(data []byte, algorithm, identifier string) error {
	var key []byte
	switch algorithm {
	case "idpf":
		normalized := strings.Join(strings.Fields(identifier), "")
		sum := sha1.Sum([]byte(normalized))
		key = sum[:]
	case "adobe":
		value := strings.TrimPrefix(identifier, "urn:uuid:")
		value = strings.ReplaceAll(value, "-", "")
		decoded, err := hex.DecodeString(value)
		if err != nil {
			return err
		}
		key = decoded
	default:
		return errors.New("epubtest: 不支持的字体混淆算法")
	}
	limit := 1040
	if algorithm == "adobe" {
		limit = 1024
	}
	if len(data) < limit {
		limit = len(data)
	}
	for index := 0; index < limit; index++ {
		data[index] ^= key[index%len(key)]
	}
	return nil
}

func samplePNG() []byte {
	return []byte{
		0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
		0x89, 0x00, 0x00, 0x00, 0x00, 'I', 'E', 'N', 'D',
		0xae, 0x42, 0x60, 0x82,
	}
}
