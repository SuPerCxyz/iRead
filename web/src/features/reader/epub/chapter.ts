import type { EpubReaderManifest } from "../types"
import { parseChapterDocument, sanitizeChapter } from "./sanitize"
import {
  chapterResourceEntry,
  isAbortError,
  type EpubResourceClient,
} from "./resources"
import { EpubChapterError } from "./types"

export interface BuiltChapter {
  objectUrl: string
  urls: string[]
  html: string
  contentType: "application/xhtml+xml" | "text/html"
}

export interface BuildChapterInput {
  manifest: EpubReaderManifest
  resources: EpubResourceClient
  index: number
  publisherCssMode: "publisher" | "off"
  signal: AbortSignal
}

export function errorChapterHtml(message: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src blob: data:; font-src blob: data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'">',
    "</head><body><main>",
    "<h1>本章节未能加载</h1>",
    `<p>${escaped}</p>`,
    "<p>请使用阅读器内的“重试”按钮。</p>",
    "</main></body></html>",
  ].join("")
}

export function createErrorChapter(message: string): BuiltChapter {
  const html = errorChapterHtml(message)
  const objectUrl = URL.createObjectURL(
    new Blob([html], { type: "text/html" }),
  )
  return {
    objectUrl,
    urls: [objectUrl],
    html,
    contentType: "text/html",
  }
}

export async function buildChapter(
  input: BuildChapterInput,
): Promise<BuiltChapter> {
  const spine = input.manifest.formatData.spine[input.index]
  if (spine === undefined) {
    throw new EpubChapterError("章节序号不在当前清单中。", input.index, false)
  }
  const entry = chapterResourceEntry(input.resources, spine, input.index)
  let html: string
  try {
    html = await input.resources.getText(entry, input.signal)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new EpubChapterError(
      "章节正文请求失败，请重试。",
      input.index,
      true,
    )
  }
  if (input.signal.aborted) {
    throw new DOMException("章节加载已取消", "AbortError")
  }
  const urls = new Set<string>()
  try {
    const sanitized = await sanitizeChapter({
      html,
      mediaType: entry.mediaType,
      chapterHref: spine.href,
      publisherCssMode: input.publisherCssMode,
      resources: input.resources,
      signal: input.signal,
      urls,
    })
    if (input.signal.aborted) {
      throw new DOMException("章节加载已取消", "AbortError")
    }
    for (const url of sanitized.urls) {
      urls.add(url)
    }
    const objectUrl = URL.createObjectURL(
      new Blob([sanitized.html], { type: sanitized.contentType }),
    )
    urls.add(objectUrl)
    return {
      objectUrl,
      urls: [...urls],
      html: sanitized.html,
      contentType: sanitized.contentType,
    }
  } catch (error) {
    for (const url of urls) {
      URL.revokeObjectURL(url)
    }
    if (isAbortError(error)) {
      throw error
    }
    throw new EpubChapterError(
      "章节内容无法安全解析，请重试。",
      input.index,
      true,
    )
  }
}

export function parseBuiltChapter(
  built: BuiltChapter,
): Promise<Document> {
  const { doc } = parseChapterDocument(built.html, built.contentType)
  return Promise.resolve(doc)
}
