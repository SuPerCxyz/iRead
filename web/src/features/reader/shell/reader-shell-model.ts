import type { BookFormat } from "@/features/library/types"
import { describeApiError } from "@/features/library/errors"
import { ApiError } from "@/lib/api"

import {
  progressPercentForPage,
  type ComicPageLocatorPayload,
  type PdfPageLocatorPayload,
  type ReaderLocation,
  type ReaderManifest,
} from "../types"
import { isNotFoundError } from "./reader-api"

export function initialLocationForManifest(
  manifest: ReaderManifest,
): ReaderLocation | null {
  if (manifest.format === "pdf") {
    return {
      locatorType: "pdf-page",
      progressPercent: 0,
      locatorPayload: {
        locatorVersion: 1,
        page: 1,
        pageOffset: 0,
        relativeViewport: null,
        view: null,
      },
    }
  }
  if (manifest.format === "cbz" || manifest.format === "cbr") {
    return {
      locatorType: "comic-page",
      progressPercent: 0,
      locatorPayload: {
        locatorVersion: 1,
        page: 1,
        pageOffset: 0,
        direction: "ltr",
        mode: "single",
        fit: "screen",
      },
    }
  }
  if (manifest.format !== "epub") {
    return null
  }
  const first = manifest.formatData.spine[0]
  if (first === undefined) {
    return null
  }
  return {
    locatorType: "epub-anchor",
    progressPercent: 0,
    locatorPayload: {
      locatorVersion: 1,
      spineIndex: first.index,
      resourceId: first.resourceId,
      href: first.href,
      anchorId: null,
      chapterProgress: 0,
      textQuote: null,
    },
  }
}

export interface ReaderDocumentPageCount { bookId: string; fileVersion: string; pageCount: number }
export function readerPageCount(manifest: ReaderManifest | null, document?: ReaderDocumentPageCount | null): number | null {
  if (!manifest || manifest.format === "epub") return null
  const declared = manifest.formatData.pageCount
  if (Number.isSafeInteger(declared) && declared > 0) return declared
  if (manifest.format === "pdf" && document?.bookId === manifest.bookId && document.fileVersion === manifest.fileVersion && Number.isSafeInteger(document.pageCount) && document.pageCount > 0) return document.pageCount
  return null
}

export function pageLocationForManifest(
  manifest: ReaderManifest,
  page: number,
  current: ReaderLocation | null,
  document?: ReaderDocumentPageCount | null,
): ReaderLocation | null {
  if (manifest.format === "pdf") {
    const pageCount = readerPageCount(manifest, document)
    if (pageCount === null || !Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      return null
    }
    const view =
      current !== null && current.locatorType === "pdf-page"
        ? current.locatorPayload.view
        : null
    const payload: PdfPageLocatorPayload = {
      locatorVersion: 1,
      page,
      pageOffset: 0,
      relativeViewport: null,
      view,
    }
    return {
      locatorType: "pdf-page",
      locatorPayload: payload,
      progressPercent: progressPercentForPage(page, pageCount),
    }
  }
  if (manifest.format === "cbz" || manifest.format === "cbr") {
    const pageCount = manifest.formatData.pageCount
    if (page < 1 || page > pageCount) {
      return null
    }
    const previous =
      current !== null && current.locatorType === "comic-page"
        ? current.locatorPayload
        : null
    const payload: ComicPageLocatorPayload = {
      locatorVersion: 1,
      page,
      pageOffset: 0,
      direction: previous?.direction ?? "ltr",
      mode: previous?.mode ?? "single",
      fit: previous?.fit ?? "screen",
    }
    return {
      locatorType: "comic-page",
      locatorPayload: payload,
      progressPercent: progressPercentForPage(page, pageCount),
    }
  }
  return null
}

export function manifestErrorMessage(error: unknown): string {
  if (isNotFoundError(error)) {
    return "阅读清单接口尚未接入（后端未实现 manifest 端点），当前无法加载目录或正文。"
  }
  if (
    error instanceof ApiError &&
    (error.code === "book_not_readable" || error.status === 409)
  ) {
    return "这本书当前不可阅读，原件可能仍在整理、加密或格式不受支持。"
  }
  return describeApiError(error, { fallback: "无法加载阅读清单。" })
}

export function readerTargetElement(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== "object") return null
  const candidate = target as Element
  return candidate.nodeType === 1 && typeof candidate.closest === "function" ? candidate : null
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  const element = readerTargetElement(target)
  if (element === null) return false
  if ((element as HTMLElement).isContentEditable) {
    return true
  }
  return (
    element.closest("input, textarea, select, [contenteditable='true']") !== null
  )
}

export function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = readerTargetElement(target)
  if (element === null) return false
  return (
    element.closest(
      "a[href], button, input, textarea, select, [contenteditable], [role='slider'], [role='switch'], [role='tab'], [role='combobox']",
    ) !== null
  )
}

export function enginePlaceholderTitle(format: BookFormat | null): string {
  if (format === "epub") {
    return "EPUB 阅读引擎当前不可用"
  }
  if (format === "pdf") {
    return "PDF 阅读引擎当前不可用"
  }
  return "漫画阅读引擎当前不可用"
}
