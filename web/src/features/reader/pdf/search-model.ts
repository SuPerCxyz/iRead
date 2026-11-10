/** 与 PDF.js 同版默认搜索行为一致：整页拼接、Unicode 归一化，并保留文字层偏移。 */
export const PDF_SEARCH_LIMIT = 200
export interface PdfSearchSegment { itemIndex: number; start: number; end: number }
export interface PdfSearchMatch {
  page: number; itemIndex: number; start: number; end: number; snippet: string
  segments?: PdfSearchSegment[]
}
export interface PdfSearchTextItem { str: string; hasEOL?: boolean }
interface Character { text: string; segment: PdfSearchSegment | null }
function normalized(characters: Character[]): { text: string; positions: Array<PdfSearchSegment | null> } {
  let text = ""
  const positions: Array<PdfSearchSegment | null> = []
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]
    if (character.text === "\u00ad") continue
    // PDF 页内断词连接；不跨页，也不删除普通连字符。
    if (character.text === "-" && characters[index + 1]?.text === "\n") { index++; continue }
    let value = character.text.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase()
    value = value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—]/g, "-")
    if (/^\s+$/u.test(value)) {
      const previous = characters[index - 1]?.text ?? "", next = characters[index + 1]?.text ?? ""
      if (character.text === "\n" && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(previous) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next)) continue
      if (!text.endsWith(" ")) { text += " "; positions.push(character.segment) }
      continue
    }
    for (let offset = 0; offset < value.length; offset++) { text += value[offset]; positions.push(character.segment) }
  }
  return { text, positions }
}
function queryCharacters(value: string): Character[] { return Array.from(value, text => ({ text, segment: null })) }
export function findPdfPageMatches(items: PdfSearchTextItem[], query: string, page: number, limit = PDF_SEARCH_LIMIT): PdfSearchMatch[] {
  const characters: Character[] = []
  items.forEach((item, itemIndex) => {
    let offset = 0
    for (const text of item.str) { characters.push({ text, segment: { itemIndex, start: offset, end: offset + text.length } }); offset += text.length }
    if (item.hasEOL) characters.push({ text: "\n", segment: null })
  })
  const source = normalized(characters), needle = normalized(queryCharacters(query)).text.trim()
  if (!needle) return []
  const matches: PdfSearchMatch[] = []
  let from = 0
  while (matches.length < limit) {
    const found = source.text.indexOf(needle, from)
    if (found < 0) break
    const segments: PdfSearchSegment[] = []
    for (const segment of source.positions.slice(found, found + needle.length)) {
      if (!segment) continue
      const previous = segments.at(-1)
      if (previous?.itemIndex === segment.itemIndex) previous.end = Math.max(previous.end, segment.end)
      else segments.push({ ...segment })
    }
    if (segments.length) matches.push({ page, itemIndex: segments[0].itemIndex, start: segments[0].start, end: segments.at(-1)!.end, segments, snippet: source.text.slice(Math.max(0, found - 32), Math.min(source.text.length, found + needle.length + 48)) })
    from = found + needle.length
  }
  return matches
}
