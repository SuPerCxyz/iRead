import type {
  ReaderEngine,
  ReaderEngineResult,
  ReaderCapabilities,
} from "../shell/engine"
import type { ReaderLocation } from "../types"
import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"

/**
 * EPUB 重排引擎的公开设置。字段与共享阅读设置面板的 reflow 分组一致；
 * 这里保持独立类型，避免 Shell 与格式引擎互相依赖实现细节。
 */
export const EPUB_FONT_FAMILIES = [
  "publisher",
  "system-sans",
  "serif",
  "chinese-system",
] as const
export type EpubFontFamily = (typeof EPUB_FONT_FAMILIES)[number]

export const EPUB_ALIGNS = ["start", "justify"] as const
export type EpubAlign = (typeof EPUB_ALIGNS)[number]

export const EPUB_PAGINATIONS = ["pagination", "scroll"] as const
export type EpubPagination = (typeof EPUB_PAGINATIONS)[number]

export const EPUB_COLUMNS = ["1", "2"] as const
export type EpubColumns = (typeof EPUB_COLUMNS)[number]

export const EPUB_ANIMATIONS = ["none", "light"] as const
export type EpubAnimation = (typeof EPUB_ANIMATIONS)[number]

export const EPUB_PUBLISHER_CSS_MODES = ["publisher", "off"] as const
export type EpubPublisherCssMode = (typeof EPUB_PUBLISHER_CSS_MODES)[number]

export interface EpubReaderSettings {
  fontFamily: EpubFontFamily
  fontSize: number
  fontWeight: number
  lineHeight: number
  paragraphSpacing: number
  textIndent: number
  align: EpubAlign
  horizontalMargin: number
  verticalMargin: number
  maxWidth: string
  pagination: EpubPagination
  columns: EpubColumns
  animation: EpubAnimation
  publisherCSSMode: EpubPublisherCssMode
  background: string | null
  textColor: string | null
  linkColor: string | null
  selectionColor: string | null
}

export const EPUB_DEFAULT_SETTINGS: EpubReaderSettings = {
  fontFamily: "publisher",
  fontSize: 16,
  fontWeight: 400,
  lineHeight: 1.6,
  paragraphSpacing: 0,
  textIndent: 0,
  align: "start",
  horizontalMargin: 6,
  verticalMargin: 4,
  maxWidth: "auto",
  pagination: "pagination",
  columns: "1",
  animation: "none",
  publisherCSSMode: "publisher",
  background: null,
  textColor: null,
  linkColor: null,
  selectionColor: null,
}

export interface EpubReaderEngineOptions {
  settings?: Partial<EpubReaderSettings>
  initialLocation?: ReaderLocation | null
  /** Shell 每本书创建的会话缓存运行时；省略时引擎直连网络。 */
  cache?: ReaderCacheRuntime | null
}

export type EpubContentInput =
  | { kind: "keydown"; event: KeyboardEvent; document: Document }
  | {
      kind: "pointerdown" | "pointermove" | "pointerup" | "pointercancel"
      event: PointerEvent
      document: Document
      clientX: number
      clientY: number
    }

export interface EpubReaderEngine extends ReaderEngine {
  subscribeContentInput(listener: (input: EpubContentInput) => void): () => void
  readonly format: "epub"
  readonly capabilities: ReaderCapabilities
  /**
   * 应用重排设置。只失效受影响的排版，不重新下载已取得的章节资源。
   */
  applySettings(settings: Partial<EpubReaderSettings>): void
  getSettings(): EpubReaderSettings
  /** 最近一次 relocate 上报的稳定位置；尚未渲染时为 null。 */
  getLocation(): ReaderLocation | null
  /**
   * 当前章节加载失败时重试。index 省略时使用当前章节。
   * 会保留最近一次稳定位置，成功后回到原位置附近。
   */
  retrySection(index?: number): Promise<ReaderEngineResult>
}

export class EpubReaderError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = true) {
    super(message)
    this.name = "EpubReaderError"
    this.retryable = retryable
  }
}

export class EpubResourceError extends EpubReaderError {
  readonly resourceHref: string

  constructor(message: string, resourceHref: string, retryable = true) {
    super(message, retryable)
    this.name = "EpubResourceError"
    this.resourceHref = resourceHref
  }
}

export class EpubChapterError extends EpubReaderError {
  readonly index: number

  constructor(message: string, index: number, retryable = true) {
    super(message, retryable)
    this.name = "EpubChapterError"
    this.index = index
  }
}
