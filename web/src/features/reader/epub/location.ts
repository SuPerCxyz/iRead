import type {
  EpubCfiLocatorPayload,
  EpubReaderManifest,
  EpubTextQuote,
  ReaderLocation,
} from "../types"
import type { FoliateRelocateDetail, FoliateSection } from "../../../vendor/foliate-js/view.js"

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

export function textQuoteFromRange(range: Range | undefined): EpubTextQuote | null {
  if (range === undefined) {
    return null
  }
  const exact = normalizeWhitespace(range.toString()).slice(0, 120)
  if (exact.length === 0) {
    return null
  }
  let prefix = ""
  let suffix = ""
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const text = range.startContainer.textContent ?? ""
    prefix = normalizeWhitespace(
      text.slice(Math.max(0, range.startOffset - 40), range.startOffset),
    ).slice(-40)
  }
  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const text = range.endContainer.textContent ?? ""
    suffix = normalizeWhitespace(
      text.slice(range.endOffset, range.endOffset + 40),
    ).slice(0, 40)
  }
  return { exact, prefix, suffix }
}

/** 全书 fraction（0-1）换算成当前章节内的进度（0-1）。 */
export function chapterProgressFromFractions(
  index: number,
  globalFraction: number,
  sectionFractions: number[],
): number {
  const start = finite(sectionFractions[index])
  const end = finite(sectionFractions[index + 1])
  if (start !== null && end !== null && end > start) {
    return clamp((globalFraction - start) / (end - start), 0, 1)
  }
  return clamp(globalFraction, 0, 1)
}

export interface RelocateFractionState {
  index: number
  fraction?: number
  sectionFractions: number[]
  scrolled: boolean
  page: number
  pages: number
  atEnd: boolean
}

/**
 * 计算当前可见位置对应的全书 fraction（0-1）。
 *
 * foliate 的 relocate.fraction 取的是当前页“结束”位置（SectionProgress 用
 * nextSize 计算），直接使用会让分页章节的末页显示成章节 100%，字号重排改变
 * 页数后同一段落还会明显回退。分页模式改为由 page/pages 取页起点；滚动模式
 * 的 fraction 本身已是起点。全书末页固定返回 1，保证读完最后一页显示 100%。
 */
export function relocateProgressFraction(
  state: RelocateFractionState,
): number | null {
  if (state.atEnd) {
    return 1
  }
  if (state.scrolled) {
    return finite(state.fraction)
  }
  const start = finite(state.sectionFractions[state.index])
  const end = finite(state.sectionFractions[state.index + 1])
  const pageCount = state.pages - 2
  if (start === null || end === null || end <= start) {
    return null
  }
  if (
    !Number.isFinite(state.page) ||
    !Number.isFinite(pageCount) ||
    pageCount <= 0
  ) {
    return null
  }
  const pageStart = clamp((state.page - 1) / pageCount, 0, 1)
  return start + pageStart * (end - start)
}

export function locationFromRelocate(
  detail: FoliateRelocateDetail & { index: number },
  section: EpubSectionLike,
  sectionFractions: number[],
): ReaderLocation {
  const globalFraction =
    finite(detail.fraction) ??
    finite(sectionFractions[detail.index]) ??
    0
  const progressPercent = clamp(globalFraction * 100, 0, 100)
  const chapterProgress = chapterProgressFromFractions(
    detail.index,
    globalFraction,
    sectionFractions,
  )
  const textQuote = textQuoteFromRange(detail.range)
  const cfi = typeof detail.cfi === "string" && detail.cfi.length > 0
    ? detail.cfi
    : ""
  if (cfi.length > 0) {
    const payload: EpubCfiLocatorPayload = {
      locatorVersion: 1,
      spineIndex: detail.index,
      resourceId: section.resourceId,
      href: section.href,
      cfi,
      chapterProgress,
      textQuote,
    }
    return {
      locatorType: "epub-cfi",
      progressPercent,
      locatorPayload: payload,
    }
  }
  return {
    locatorType: "epub-anchor",
    progressPercent,
    locatorPayload: {
      locatorVersion: 1,
      spineIndex: detail.index,
      resourceId: section.resourceId,
      href: section.href,
      anchorId: null,
      chapterProgress,
      textQuote,
    },
  }
}

export interface EpubSectionLike {
  index: number
  resourceId: string
  href: string
  cfiBase: string
}

export function sectionLike(
  manifest: EpubReaderManifest,
  index: number,
): EpubSectionLike | null {
  const item = manifest.formatData.spine[index]
  if (item === undefined) {
    return null
  }
  return {
    index: item.index,
    resourceId: item.resourceId,
    href: item.href,
    cfiBase: item.cfiBase,
  }
}

export interface EpubAnchorPayload {
  spineIndex: number
  resourceId: string
  href: string
  anchorId: string | null
  textQuote: EpubTextQuote | null
  chapterProgress: number
}

export function resolvePayloadIndex(
  book: { indexForPayload: (spineIndex: number, resourceId: string, href: string) => number },
  payload: EpubAnchorPayload,
): number {
  return book.indexForPayload(
    payload.spineIndex,
    payload.resourceId,
    payload.href,
  )
}

export function anchorForPayload(
  payload: EpubAnchorPayload,
): (doc: Document) => Element | Range | number {
  return (doc: Document) => {
    if (payload.anchorId !== null && payload.anchorId.length > 0) {
      const element = findElement(doc, payload.anchorId)
      if (element !== null) {
        return element
      }
    }
    if (payload.textQuote !== null) {
      const range = findTextQuote(doc, payload.textQuote)
      if (range !== null) {
        return range
      }
    }
    return 0
  }
}

function findElement(doc: Document, id: string): Element | null {
  const direct = doc.getElementById(id)
  if (direct !== null) {
    return direct
  }
  const named = doc.getElementsByName(id)
  if (named.length > 0) {
    return named[0]
  }
  return null
}

function collectTextNodes(doc: Document): Text[] {
  const walker = doc.createTreeWalker(doc.body ?? doc, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode() !== null) {
    const node = walker.currentNode
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement
      if (parent === null) {
        continue
      }
      const tag = parent.localName.toLowerCase()
      if (tag === "script" || tag === "style" || tag === "title") {
        continue
      }
      nodes.push(node as Text)
    }
  }
  return nodes
}

/**
 * 文本锚点回退：先在正文文本节点中查找 exact；找不到时退回浏览器的
 * find（仍限制在当前章节文档内），不跨章节、不访问网络。
 */
export function findTextQuote(
  doc: Document,
  quote: EpubTextQuote,
): Range | null {
  const exact = normalizeWhitespace(quote.exact)
  if (exact.length === 0) {
    return null
  }
  const nodes = collectTextNodes(doc)
  const raw = nodes.map((node) => node.data).join("")
  const index = raw.indexOf(quote.exact)
  if (index >= 0) {
    return rangeFromOffsets(nodes, index, index + quote.exact.length, doc)
  }
  const normalizedIndex = normalizeWhitespace(raw).indexOf(exact)
  if (normalizedIndex >= 0) {
    const exactIndex = raw.indexOf(quote.exact)
    if (exactIndex >= 0) {
      return rangeFromOffsets(nodes, exactIndex, exactIndex + quote.exact.length, doc)
    }
  }
  const view = doc.defaultView as
    | (Window & {
        find?: (
          text: string,
          caseSensitive?: boolean,
          backwards?: boolean,
          wrapAround?: boolean,
        ) => boolean
      })
    | null
  if (view !== null && typeof view.find === "function") {
    const found = view.find(quote.exact, false, false, true)
    if (found) {
      const selection = view.getSelection()
      if (selection !== null && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange()
        selection.removeAllRanges()
        return range
      }
    }
  }
  return null
}

function rangeFromOffsets(
  nodes: Text[],
  start: number,
  end: number,
  doc: Document,
): Range | null {
  let offset = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0
  for (const node of nodes) {
    const next = offset + node.data.length
    if (startNode === null && start >= offset && start <= next) {
      startNode = node
      startOffset = start - offset
    }
    if (end >= offset && end <= next) {
      endNode = node
      endOffset = end - offset
      break
    }
    offset = next
  }
  if (startNode === null || endNode === null) {
    return null
  }
  const range = doc.createRange()
  range.setStart(startNode, Math.min(startOffset, startNode.data.length))
  range.setEnd(endNode, Math.min(endOffset, endNode.data.length))
  return range
}

/** 兼容旧调用：从 foliate section 读取定位元数据。 */
export type { FoliateSection }
