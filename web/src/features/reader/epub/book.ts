import * as CFI from "../../../vendor/foliate-js/epubcfi.js"
import type {
  EpubCfiIndirection,
  EpubCfiParts,
  EpubCfiStep,
} from "../../../vendor/foliate-js/epubcfi.js"
import type {
  FoliateBook,
  FoliateSection,
  FoliateTocItem,
} from "../../../vendor/foliate-js/view.js"

import type {
  EpubReaderManifest,
  EpubSpineItem,
  ReaderTocItem,
} from "../types"
import { fragmentElement, resolveArchiveHref } from "./resources"

export interface EpubBookCallbacks {
  loadChapter: (index: number) => Promise<string>
  unloadChapter: (index: number) => void
  createDocument: (index: number) => Promise<Document>
}

export interface ResolvedSectionHref {
  index: number
  anchor: ((doc: Document) => Element | number) | undefined
}

function isRangeParts(
  parts: EpubCfiParts,
): parts is { parent: EpubCfiIndirection[]; start: EpubCfiIndirection[]; end: EpubCfiIndirection[] } {
  return !Array.isArray(parts)
}

function cfiTopSteps(cfi: string): EpubCfiIndirection | null {
  try {
    const parsed = CFI.parse(cfi)
    const parts = isRangeParts(parsed) ? parsed.parent : parsed
    return parts[0] ?? null
  } catch {
    return null
  }
}

function spineStep(item: EpubSpineItem): EpubCfiStep | null {
  const top = cfiTopSteps(item.cfiBase)
  if (top === null || top.length < 2) {
    return null
  }
  return top[1] ?? null
}

function tocHref(item: ReaderTocItem): string {
  const fragment = item.fragment.length > 0 ? `#${item.fragment}` : ""
  if (item.href.length > 0) {
    return `${item.href}${fragment}`
  }
  return fragment.length > 0 ? fragment : "#"
}

function toFoliateToc(items: ReaderTocItem[]): FoliateTocItem[] {
  return items.map((item) => {
    const children =
      item.children.length > 0 ? toFoliateToc(item.children) : undefined
    return {
      label: item.title,
      href: tocHref(item),
      ...(children === undefined ? {} : { subitems: children }),
    }
  })
}

function splitHref(href: string): { path: string; fragment: string } | null {
  const resolved = resolveArchiveHref("", href)
  if (resolved === null || resolved.external) {
    return null
  }
  return { path: resolved.path, fragment: resolved.fragment }
}

function resolveSectionHref(sectionHref: string, href: string): string {
  const resolved = resolveArchiveHref(sectionHref, href)
  if (resolved === null || resolved.external) {
    return href
  }
  const fragment = resolved.fragment.length > 0
    ? `#${resolved.fragment}`
    : ""
  return `${resolved.path}${fragment}`
}

export class ManifestEpubBook implements FoliateBook {
  readonly metadata: { title: string; language: string }
  readonly sections: FoliateSection[]
  readonly toc: FoliateTocItem[]
  readonly rendition: {
    layout: string
    flow: string
    spread: string
    direction: string
  }
  readonly dir: string
  private readonly manifest: EpubReaderManifest
  private readonly pathToIndex = new Map<string, number>()
  private readonly lowerPathToIndex = new Map<string, number | null>()
  private readonly basenameToIndex = new Map<string, number | null>()

  constructor(manifest: EpubReaderManifest, callbacks: EpubBookCallbacks) {
    this.manifest = manifest
    this.metadata = { title: "", language: "" }
    this.rendition = { ...manifest.formatData.rendition }
    this.dir = manifest.formatData.rendition.direction === "rtl" ? "rtl" : "ltr"
    this.toc = toFoliateToc(manifest.toc)
    const spine = manifest.formatData.spine
    spine.forEach((item, index) => {
      this.pathToIndex.set(item.href, index)
      const lower = item.href.toLowerCase()
      this.lowerPathToIndex.set(
        lower,
        this.lowerPathToIndex.has(lower) ? null : index,
      )
      const segments = item.href.split("/")
      const base = segments[segments.length - 1] ?? ""
      if (base.length > 0) {
        this.basenameToIndex.set(
          base.toLowerCase(),
          this.basenameToIndex.has(base.toLowerCase()) ? null : index,
        )
      }
    })
    this.sections = spine.map((item) => ({
      id: item.index,
      size: item.size,
      cfi: item.cfiBase.replace(/!\)$/, ")"),
      linear: item.linear ? "yes" : "no",
      load: () => callbacks.loadChapter(item.index),
      unload: () => callbacks.unloadChapter(item.index),
      createDocument: () => callbacks.createDocument(item.index),
      resolveHref: (href: string) => resolveSectionHref(item.href, href),
    }))
  }

  indexForPath(path: string): number {
    const exact = this.pathToIndex.get(path)
    if (exact !== undefined) {
      return exact
    }
    const lower = this.lowerPathToIndex.get(path.toLowerCase())
    if (lower !== undefined && lower !== null) {
      return lower
    }
    const segments = path.split("/")
    const base = segments[segments.length - 1] ?? ""
    return this.basenameToIndex.get(base.toLowerCase()) ?? -1
  }

  indexForPayload(
    spineIndex: number,
    resourceId: string,
    href: string,
  ): number {
    if (resourceId.length > 0) {
      const found = this.manifest.formatData.spine.findIndex(
        (item) => item.resourceId === resourceId,
      )
      if (found >= 0) {
        return found
      }
    }
    const split = href.length > 0 ? splitHref(href) : null
    if (split !== null) {
      const found = this.indexForPath(split.path)
      if (found >= 0) {
        return found
      }
    }
    return spineIndex >= 0 && spineIndex < this.sections.length
      ? spineIndex
      : -1
  }

  private matchCfiTop(top: EpubCfiIndirection): number {
    if (top.length < 2 || top[0]?.index !== 6) {
      return -1
    }
    const target = top[1]?.index
    if (target === undefined) {
      return -1
    }
    for (let index = 0; index < this.manifest.formatData.spine.length; index += 1) {
      const step = spineStep(this.manifest.formatData.spine[index] as EpubSpineItem)
      if (step?.index === target) {
        return index
      }
    }
    return -1
  }

  resolveHref(href: string): ResolvedSectionHref | null {
    const split = splitHref(href)
    if (split === null) {
      return null
    }
    const index =
      split.path.length === 0 ? 0 : this.indexForPath(split.path)
    if (index < 0) {
      return null
    }
    const fragment = split.fragment
    return {
      index,
      anchor:
        fragment.length === 0
          ? undefined
          : (doc: Document) => fragmentElement(doc, fragment) ?? 0,
    }
  }

  resolveCFI(cfi: string): {
    index: number
    anchor: (doc: Document) => Range
  } | null {
    let parsed: EpubCfiParts
    try {
      parsed = CFI.parse(cfi)
    } catch {
      return null
    }
    const indirections = isRangeParts(parsed) ? parsed.parent : parsed
    const top = indirections[0] ?? []
    const index = this.matchCfiTop(top)
    if (index < 0) {
      return null
    }
    // toRange() 期待内容文档内的分段；去掉指向 OPF 的第一个 indirection，
    // 与 foliate 的 View.resolveCFI 保持同一语义。
    indirections.shift()
    return {
      index,
      anchor: (doc: Document) => CFI.toRange(doc, parsed),
    }
  }

  splitTOCHref(href?: string): [number, string] | [] {
    if (href === undefined || href.length === 0) {
      return []
    }
    const split = splitHref(href)
    if (split === null) {
      return []
    }
    const index =
      split.path.length === 0 ? 0 : this.indexForPath(split.path)
    if (index < 0) {
      return []
    }
    return [index, split.fragment]
  }

  getTOCFragment(doc: Document, id: string): Element | null {
    return fragmentElement(doc, id)
  }

  isExternal(uri: string): boolean {
    return (
      uri.startsWith("//") ||
      /^(?!blob:)[a-z][a-z0-9+.-]*:/i.test(uri)
    )
  }
}

export function fixedLayoutReason(
  manifest: EpubReaderManifest,
): string | null {
  if (manifest.formatData.rendition.layout === "pre-paginated") {
    return "固定布局 EPUB 暂不支持；当前引擎只处理可重排文字书。"
  }
  return null
}
