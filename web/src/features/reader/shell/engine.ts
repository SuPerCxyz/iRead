import type { BookFormat } from "@/features/library/types"

import {
  ComicReaderEngine,
  createComicReaderEngine as createRealComicReaderEngine,
  type ComicReaderEngineContract,
  type ComicReaderEngineOptions,
} from "../comic"
import {
  createEpubReaderEngine as createRealEpubReaderEngine,
  type EpubReaderEngine,
  type EpubReaderEngineOptions,
} from "../epub"
import {
  PdfReaderEngine,
  createPdfReaderEngine as createRealPdfReaderEngine,
  type PdfMountOptions,
  type PdfReaderEngineOptions,
} from "../pdf"
import type { ReaderLocation, ReaderManifest } from "../types"

/**
 * 格式引擎适配器接口。共享 Shell 只依赖这些方法，
 * 不把 EPUB/PDF/漫画的正文、缓存或 worker 细节写进 Shell。
 */
export interface ReaderCapabilities {
  canRender: boolean
  canNavigate: boolean
  canSearch: boolean
  canZoom: boolean
  features: string[]
  unavailableReason: string
}

export interface ReaderViewportMetrics {
  width: number
  height: number
  visualWidth: number
  visualHeight: number
  offsetTop: number
  offsetLeft: number
  scale: number
  devicePixelRatio: number
}

export type ReaderEngineResult =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean }

export interface ReaderEngine {
  readonly format: BookFormat
  readonly capabilities: ReaderCapabilities
  mount(
    host: HTMLElement,
    manifest: ReaderManifest,
    signal: AbortSignal,
    options?: PdfMountOptions,
  ): Promise<void>
  unmount(): void
  restore(location: ReaderLocation): Promise<ReaderEngineResult>
  navigateTo(location: ReaderLocation): Promise<ReaderEngineResult>
  advance(direction: "previous" | "next"): Promise<ReaderEngineResult>
  subscribeLocation(listener: (location: ReaderLocation) => void): () => void
  handleViewportChange(metrics: ReaderViewportMetrics): void
  dispose(): void
  /** 双指整体缩放；未实现的引擎可以省略，Shell 会退化为普通点击/翻页。 */
  getZoom?(): number
  beginPinch?(x: number, y: number): void
  updatePinch?(scale: number, x: number, y: number): void
  endPinch?(commit?: boolean): void
  resetZoom?(): void
}

const UNAVAILABLE_REASONS: Record<BookFormat, string> = {
  epub: "EPUB 阅读引擎当前不可用。",
  pdf: "PDF 阅读引擎当前不可用。",
  cbz: "漫画阅读引擎当前不可用。",
  cbr: "漫画阅读引擎当前不可用。",
}

export function createEpubReaderEngine(
  options?: EpubReaderEngineOptions,
): EpubReaderEngine {
  return createRealEpubReaderEngine(options)
}

export function createPdfReaderEngine(
  options?: PdfReaderEngineOptions,
): PdfReaderEngine {
  return createRealPdfReaderEngine(options)
}

export type ReaderEngineOptions = PdfReaderEngineOptions &
  ComicReaderEngineOptions

/** 兼容 `createComicReaderEngine("cbz"|"cbr")` 与对象参数两种调用。 */
export function createComicReaderEngine(
  format: "cbz" | "cbr",
  options?: ComicReaderEngineOptions,
): ComicReaderEngineContract
export function createComicReaderEngine(
  options?: ComicReaderEngineOptions,
): ComicReaderEngineContract
export function createComicReaderEngine(
  formatOrOptions: "cbz" | "cbr" | ComicReaderEngineOptions = {},
  options: ComicReaderEngineOptions = {},
): ComicReaderEngineContract {
  if (typeof formatOrOptions === "string") {
    return createRealComicReaderEngine({
      ...options,
      format: formatOrOptions,
    })
  }
  return createRealComicReaderEngine(formatOrOptions)
}

export function createReaderEngine(
  format: BookFormat,
  options?: ReaderEngineOptions,
): ReaderEngine {
  if (format === "epub") {
    return createEpubReaderEngine(options)
  }
  if (format === "pdf") {
    return createPdfReaderEngine(options)
  }
  return createComicReaderEngine(format, options)
}

export function isEpubReaderEngine(
  engine: ReaderEngine | null,
): engine is EpubReaderEngine {
  return engine !== null && engine.format === "epub"
}

export function isPdfReaderEngine(
  engine: ReaderEngine | null,
): engine is PdfReaderEngine {
  return engine instanceof PdfReaderEngine
}

export function isComicReaderEngine(
  engine: ReaderEngine | null,
): engine is ComicReaderEngineContract {
  return engine instanceof ComicReaderEngine
}

export function readerEngineUnavailableMessage(format: BookFormat): string {
  return UNAVAILABLE_REASONS[format]
}
