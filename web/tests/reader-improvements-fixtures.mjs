// 无私有书籍的可重复阅读器样本，所有文件只写入调用方的临时目录。
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const local=[], central=[]; let offset=0
  for (const [name,text] of entries) {
    const filename=Buffer.from(name), data=Buffer.from(text), crc=crc32(data)
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26)
    local.push(header,filename,data)
    const index=Buffer.alloc(46);index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt32LE(crc,16);index.writeUInt32LE(data.length,20);index.writeUInt32LE(data.length,24);index.writeUInt16LE(filename.length,28);index.writeUInt32LE(offset,42)
    central.push(index,filename);offset+=header.length+filename.length+data.length
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...local,directory,end])
}
export function buildReaderEpub() {
  const chapters=Array.from({length:4},(_,i)=>i+1)
  const paragraph='这是可重复测试生成的正文，用于检查分页、视口、设置和定位。This generated text tests reading layout and navigation. '
  return zip([
    ['mimetype','application/epub+zip'],
    ['META-INF/container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/book.opf',`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">iread-reader-improvements</dc:identifier><dc:title>阅读器回归样本</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-11-10T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map(i=>`<item id="c${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map(i=>`<itemref idref="c${i}"/>`).join('')}</spine></package>`],
    ['OEBPS/nav.xhtml',`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${chapters.map(i=>`<li><a href="chapter${i}.xhtml">第${i}章</a></li>`).join('')}</ol></nav></body></html>`],
    ...chapters.map(i=>[`OEBPS/chapter${i}.xhtml`,`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${i}章</title></head><body><h1>第${i}章</h1>${Array.from({length:150},(_,n)=>`<p id="p${n}">${paragraph.repeat(3)}</p>`).join('')}</body></html>`]),
  ])
}
