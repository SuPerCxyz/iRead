import type { PdfOutlineEntry } from "../pdf"
import {
  progressPercentForPage,
  type ReaderLocation,
  type ReaderManifest,
  type ReaderTocItem,
} from "../types"

export interface FlatTocEntry {
  id: string
  item: ReaderTocItem
  level: number
}

export interface FlatPdfOutlineEntry {
  id: string
  entry: PdfOutlineEntry
  level: number
}

export function flattenPdfOutline(
  entries: PdfOutlineEntry[],
): FlatPdfOutlineEntry[] {
  const result: FlatPdfOutlineEntry[] = []
  const walk = (items: PdfOutlineEntry[], parentId: string, depth: number) => {
    items.forEach((entry, index) => {
      const id = parentId.length === 0 ? String(index) : `${parentId}.${index}`
      result.push({ id, entry, level: depth })
      if (entry.children.length > 0) {
        walk(entry.children, id, depth + 1)
      }
    })
  }
  walk(entries, "", 0)
  return result
}

export function flattenToc(toc: ReaderTocItem[]): FlatTocEntry[] {
  const result: FlatTocEntry[] = []
  const walk = (items: ReaderTocItem[], parentId: string, depth: number) => {
    items.forEach((item, index) => {
      const id = parentId.length === 0 ? String(index) : `${parentId}.${index}`
      result.push({ id, item, level: depth })
      if (item.children.length > 0) {
        walk(item.children, id, depth + 1)
      }
    })
  }
  walk(toc, "", 0)
  return result
}

function pdfPageFromHref(item: ReaderTocItem): number | null {
  for (const value of [item.href, item.fragment]) {
    if (value.length === 0) {
      continue
    }
    const match = /(?:^|[#?&])page=(\d+)/i.exec(value)
    if (match !== null) {
      const page = Number(match[1])
      return Number.isFinite(page) && page >= 1 ? page : null
    }
    const numericFragment = /^#?(\d+)$/.exec(value)
    if (numericFragment !== null) {
      const page = Number(numericFragment[1])
      return Number.isFinite(page) && page >= 1 ? page : null
    }
  }
  return null
}

function normalizeHref(value: string): string {
  return value.replace(/^\.\//, "").split("#")[0] ?? value
}

function epubResourceMatches(
  item: ReaderTocItem,
  resourceId: string,
  href: string,
): boolean {
  if (item.resourceId.length > 0 && resourceId.length > 0) {
    return item.resourceId === resourceId
  }
  if (item.href.length === 0 || href.length === 0) {
    return false
  }
  return normalizeHref(item.href) === normalizeHref(href)
}

export function findCurrentTocEntry(
  manifest: ReaderManifest | null,
  entries: FlatTocEntry[],
  location: ReaderLocation | null,
): FlatTocEntry | null {
  if (manifest === null || location === null || entries.length === 0) {
    return null
  }

  if (manifest.format === "pdf") {
    if (location.locatorType !== "pdf-page") {
      return null
    }
    const page = location.locatorPayload.page
    let exact: FlatTocEntry | null = null
    let nearest: FlatTocEntry | null = null
    let nearestPage = 0
    for (const entry of entries) {
      const entryPage = pdfPageFromHref(entry.item)
      if (entryPage === null) {
        continue
      }
      if (entryPage === page) {
        exact = entry
      }
      if (entryPage <= page && entryPage >= nearestPage) {
        nearest = entry
        nearestPage = entryPage
      }
    }
    return exact ?? nearest
  }

  if (manifest.format === "epub") {
    if (
      location.locatorType !== "epub-cfi" &&
      location.locatorType !== "epub-anchor"
    ) {
      return null
    }
    const payload = location.locatorPayload
    let match: FlatTocEntry | null = null
    for (const entry of entries) {
      if (epubResourceMatches(entry.item, payload.resourceId, payload.href)) {
        match = entry
        const anchorId =
          location.locatorType === "epub-anchor"
            ? location.locatorPayload.anchorId
            : null
        if (
          anchorId !== null &&
          anchorId.length > 0 &&
          entry.item.fragment.length > 0 &&
          entry.item.fragment === anchorId
        ) {
          return entry
        }
      }
    }
    return match
  }

  return null
}

export function locationForTocEntry(
  manifest: ReaderManifest,
  item: ReaderTocItem,
  current: ReaderLocation | null,
): ReaderLocation | null {
  if (manifest.format === "pdf") {
    const page = pdfPageFromHref(item)
    if (page === null) {
      return null
    }
    const total = manifest.formatData.pageCount
    const view =
      current !== null && current.locatorType === "pdf-page"
        ? current.locatorPayload.view
        : null
    return {
      locatorType: "pdf-page",
      progressPercent: progressPercentForPage(page, total),
      locatorPayload: {
        locatorVersion: 1,
        page,
        pageOffset: 0,
        relativeViewport: null,
        view,
      },
    }
  }

  if (manifest.format === "epub") {
    const spine = manifest.formatData.spine
    const spineIndex = spine.findIndex((entry) =>
      epubResourceMatches(item, entry.resourceId, entry.href),
    )
    const index = spineIndex >= 0 ? spineIndex : 0
    const progressPercent =
      spine.length > 0 ? Math.min(100, (index / spine.length) * 100) : 0
    return {
      locatorType: "epub-anchor",
      progressPercent,
      locatorPayload: {
        locatorVersion: 1,
        spineIndex: index,
        resourceId:
          item.resourceId.length > 0
            ? item.resourceId
            : spine[index]?.resourceId ?? "",
        href: item.href.length > 0 ? item.href : spine[index]?.href ?? "",
        anchorId: item.fragment.length > 0 ? item.fragment : null,
        chapterProgress: 0,
        textQuote: null,
      },
    }
  }

  return null
}
