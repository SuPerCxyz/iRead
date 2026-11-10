import {
  AnnotationLayer,
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  getDocument,
} from "pdfjs-dist"
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist"
import { findPdfPageMatches, PDF_SEARCH_LIMIT as SEARCH_LIMIT, type PdfSearchMatch } from "./search-model"
export type { PdfSearchMatch } from "./search-model"
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"

import type { BookFormat } from "@/features/library/types"

import type {
  PdfPageLocatorPayload,
  PdfRelativeViewport,
  ReaderLocation,
  ReaderManifest,
} from "../types"
import {
  DEFAULT_PDF_VIEW,
  PDF_GAP_PIXELS,
  PDF_LAYOUT_MODES,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_ZOOM_MODES,
  clamp,
  isPdfManifest,
  normalizeRotation,
  normalizeScale,
  normalizeView,
  pdfContentPath,
  pdfLocation,
  relativeViewport,
  viewFromEffectiveSettings,
  viewFromPdfViewState,
  type PdfAnchor,
  type PdfLayoutMode,
  type PdfViewSettings,
  type PdfZoomMode,
} from "./model"
import {
  HttpPdfRangeTransport,
  PDF_RANGE_CHUNK_SIZE,
  PdfLoadError,
  fetchInitialRange,
  pdfErrorForStatus,
  type PdfNetworkRequest,
  type PdfNetworkStats,
} from "./range"
import { pdfPageKey, renderKeyId } from "../cache/resource-key"
import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"
import {
  PdfOutlineTimeoutError,
  buildPdfOutline,
  countOutlineEntries,
  withPdfOutlineDeadline,
  type PdfOutlineEntry,
} from "./outline"
import { PdfOpenWatchdog } from "./open-watchdog"

GlobalWorkerOptions.workerSrc = workerSrc

const PDFJS_ASSET_ROOT = "/pdfjs/"
const MAX_CANVAS_PIXELS = 8_000_000
/** 打开 PDF 的绝对上限；真正判断卡死的是下面的停滞看门狗。 */
const OPEN_TIMEOUT_MS = 120_000
/** 连续多久没有新的已读取字节就判定打开停滞。 */
const OPEN_STALL_TIMEOUT_MS = 15_000
const MOBILE_CANVAS_COUNT = 2
const DESKTOP_CANVAS_COUNT = 4
const DEFAULT_PAGE_WIDTH = 612
const DEFAULT_PAGE_HEIGHT = 792
const NOTICE_TIMEOUT_MS = 4_000
/** 目录读取上限；PDF.js 的 getOutline() 没有超时，worker 无响应时不能永久卡住面板。 */
const OUTLINE_TIMEOUT_MS = 10_000

export interface PdfOutlineRequestOptions {
  /** 关闭面板/切换文档时取消等待；底层解析结果会被丢弃。 */
  signal?: AbortSignal
  /** 覆盖默认的 10 秒目录读取上限，供测试使用。 */
  timeoutMs?: number
}

export interface PdfPageMetrics {
  width: number
  height: number
  pageRotation: number
  totalRotation: number
}

export type PdfReaderResult =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean }

export interface PdfReaderEngineOptions {
  onBack?: () => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 打开结果变化；Shell 用它在重试成功后清除残留提示并刷新页数。 */
  onOpenStateChange?: (
    state: "ready" | "error",
    detail: { pageCount: number },
  ) => void
  /** Shell 每本书创建的会话缓存运行时；省略时引擎直连网络。 */
  cache?: ReaderCacheRuntime | null
}

interface DisplaySize {
  width: number
  height: number
  scale: number
}

interface RenderedPage {
  scaleKey: string
  page: PDFPageProxy
  textLayer: TextLayer | null
  annotationLayer: AnnotationLayer | null
  renderTask: RenderTask | null
  cacheKey: string | null
}

interface RenderPromiseEntry {
  scaleKey: string
  promise: Promise<void>
}

interface DestinationRef {
  num: number
  gen: number
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className !== undefined && className.length > 0) {
    element.className = className
  }
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

function createButton(
  label: string,
  text: string,
  className = "iread-pdf__button",
): HTMLButtonElement {
  const button = createElement("button", className, text)
  button.type = "button"
  button.setAttribute("aria-label", label)
  return button
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError"
  }
  return error instanceof Error && error.name === "AbortError"
}

function isRenderingCancelled(error: unknown): boolean {
  return (
    error instanceof RenderingCancelledException ||
    (error instanceof Error && error.name === "RenderingCancelledException")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.href)
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    ) {
      return url.href
    }
  } catch {
    return null
  }
  return null
}

function toLoadError(error: unknown): PdfLoadError {
  if (error instanceof PdfLoadError) {
    return error
  }
  if (error instanceof Error) {
    if (error.name === "PasswordException") {
      return new PdfLoadError(
        "password_required",
        "这份 PDF 受密码保护；当前阅读器没有输入密码的入口，请联系书库管理员提供无密码版本。",
        { retryable: false, cause: error },
      )
    }
    if (error.name === "InvalidPDFException") {
      return new PdfLoadError(
        "invalid_pdf",
        "PDF 文件已损坏或结构不受支持，无法显示。",
        { retryable: false, cause: error },
      )
    }
    if (error.name === "MissingPDFException") {
      return new PdfLoadError(
        "missing_pdf",
        "PDF 原件不存在或已被移除。",
        { retryable: false, cause: error },
      )
    }
    if (error.name === "UnexpectedResponseException") {
      const status =
        typeof (error as unknown as { status?: unknown }).status === "number"
          ? (error as unknown as { status: number }).status
          : 0
      if (status > 0) {
        return pdfErrorForStatus(status, "", "")
      }
      return new PdfLoadError(
        "unexpected_response",
        "读取 PDF 时服务器返回了意外响应，请重试。",
        { retryable: true, cause: error },
      )
    }
    if (error.name === "TimeoutError") {
      return new PdfLoadError(
        "timeout",
        "打开 PDF 超时，请检查网络后重试。",
        { retryable: true, cause: error },
      )
    }
  }
  return new PdfLoadError(
    "pdf_load_failed",
    "无法打开这份 PDF。请重试；如果问题持续，请检查原件是否完整。",
    { retryable: true, cause: error },
  )
}

/**
 * 销毁 PDFDocumentLoadingTask。
 *
 * worker 已经终止时 destroy() 可能同步抛错或返回 rejected Promise，超时
 * 路径必须吞掉这些错误，否则会以未处理异常打断错误界面渲染。
 */
function destroyLoadingTask(task: PDFDocumentLoadingTask | null): void {
  if (task === null) {
    return
  }
  try {
    void task.destroy().catch(() => undefined)
  } catch {
    // worker 已退出时忽略销毁异常。
  }
}

async function destroyLoadingTaskAndWait(
  task: PDFDocumentLoadingTask | null,
): Promise<void> {
  if (task === null) {
    return
  }
  try {
    await task.destroy()
  } catch {
    // 同上：销毁失败不应覆盖真正的打开错误。
  }
}

function formatPageText(page: number, pageCount: number): string {
  return `${page} / ${pageCount}`
}

function safeJsonKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

/**
 * PDF 阅读引擎。
 *
 * 生命周期与共享 shell 的 ReaderEngine 对齐；PDF 特有 UI（布局、缩放、
 * 搜索、内置目录）留在本模块内，避免把 PDF.js 细节写进 shell。
 */
export class PdfReaderEngine {
  readonly format: BookFormat = "pdf"
  readonly capabilities = {
    canRender: true,
    canNavigate: true,
    canSearch: true,
    canZoom: true,
    features: [
      "toc",
      "bookmarks",
      "settings",
      "text-selection",
      "search",
      "zoom",
      "pdf-range",
    ],
    unavailableReason: "",
  }

  readonly #options: PdfReaderEngineOptions
  #host: HTMLElement | null = null
  #manifest: ReaderManifest | null = null
  #root: HTMLDivElement | null = null
  #viewport: HTMLDivElement | null = null
  #pages: HTMLDivElement | null = null
  #pageIndicator: HTMLSpanElement | null = null
  #zoomIndicator: HTMLSpanElement | null = null
  #loading: HTMLDivElement | null = null
  #loadingText: HTMLParagraphElement | null = null
  #errorOverlay: HTMLDivElement | null = null
  #errorTitle: HTMLHeadingElement | null = null
  #errorMessage: HTMLParagraphElement | null = null
  #searchPanel: HTMLDivElement | null = null
  #searchInput: HTMLInputElement | null = null
  #searchStatus: HTMLParagraphElement | null = null
  #searchResults: HTMLUListElement | null = null
  #outlinePanel: HTMLDivElement | null = null
  #outlineList: HTMLDivElement | null = null
  #outlineStatus: HTMLParagraphElement | null = null
  #layoutSelect: HTMLSelectElement | null = null
  #notice: HTMLDivElement | null = null

  #view: PdfViewSettings = { ...DEFAULT_PDF_VIEW }
  #userRotation = 0
  #pdf: PDFDocumentProxy | null = null
  #loadingTask: PDFDocumentLoadingTask | null = null
  #openWatchdog: PdfOpenWatchdog | null = null
  #transport: HttpPdfRangeTransport | null = null
  #pageCount = 0
  #currentPage = 1
  #navigationEpoch = 0
  #mountId = 0
  #mountSignal: AbortSignal | null = null
  #readyPromise: Promise<void> = Promise.resolve()
  #lastError: PdfLoadError | null = null
  #uiAbort: AbortController | null = null
  #resizeObserver: ResizeObserver | null = null
  #resizeFrame: number | null = null
  #scrollFrame: number | null = null
  #noticeTimer: number | null = null
  #searchController: AbortController | null = null
  #searchSeq = 0
  #searchMatches: PdfSearchMatch[] = []
  #activeSearchIndex = -1
  #searchNavigationEpoch: number | null = null
  #outlinePromise: Promise<PdfOutlineEntry[]> | null = null
  /** 当前文档的目录是否已经渲染进内部面板；与“是否已调用 getOutline”解耦。 */
  #outlineRendered = false
  /** 目录解析的取消边界，卸载/超时/切换文档时中止。 */
  #outlineAbort: AbortController | null = null
  /** 内部面板本次打开对应的等待；关闭面板时中止。 */
  #outlineRequest: AbortController | null = null
  #sourceUrl: URL | null = null
  #pageCache = new Map<number, PDFPageProxy>()
  #pageElements = new Map<number, HTMLElement>()
  #pageMetrics = new Map<number, PdfPageMetrics>()
  #displaySizes = new Map<number, DisplaySize>()
  #layoutOffsets: { start: number; size: number }[] = []
  #rendered = new Map<number, RenderedPage>()
  #renderPromises = new Map<number, RenderPromiseEntry>()
  #renderTokens = new Map<number, number>()
  #renderWindow = new Set<number>()
  #lastEmittedKey = ""
  #listeners = new Set<(location: ReaderLocation) => void>()
  #stats: PdfNetworkStats = {
    requestCount: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    requests: [],
    fullBodyResponse: false,
  }
  #hostPosition = ""
  #viewportFallback = { width: 0, height: 0 }
  #mountedLayout: PdfLayoutMode | null = null
  #destinationHashes = new Map<string, string>()
  readonly #cache: ReaderCacheRuntime | null

  constructor(options: PdfReaderEngineOptions = {}) {
    this.#options = options
    this.#cache = options.cache ?? null
  }

  async mount(
    host: HTMLElement,
    manifest: ReaderManifest,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isPdfManifest(manifest)) {
      throw new Error("PDF 阅读引擎只能挂载 PDF 清单。")
    }
    const contentHref = pdfContentPath(manifest)
    if (contentHref === null) {
      throw new Error("PDF 清单缺少 contentHref。")
    }

    this.unmount()
    const mountId = ++this.#mountId
    this.#host = host
    this.#manifest = manifest
    this.#mountSignal = signal
    this.#lastError = null
    this.#stats = {
      requestCount: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      requests: [],
      fullBodyResponse: false,
    }
    this.#view = { ...DEFAULT_PDF_VIEW }
    this.#userRotation = 0
    this.#currentPage = 1
    this.#pageCount = 0
    this.#buildDom(host)
    this.#bindUi()

    const settings = await this.#readViewSettings(manifest.bookId, signal)
    if (mountId !== this.#mountId || signal.aborted) {
      return
    }
    if (settings !== null) {
      this.#applyView(settings)
    }

    this.#readyPromise = this.#openDocument(contentHref, mountId, signal).catch(
      (error: unknown) => {
        if (mountId !== this.#mountId || signal.aborted || isAbortError(error)) {
          return
        }
        this.#showFatalError(toLoadError(error))
      },
    )
    await this.#readyPromise
  }

  unmount(): void {
    this.#mountId += 1
    this.#navigationEpoch += 1
    this.#readyPromise = Promise.resolve()
    this.#cancelFrame()
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = null
    this.#uiAbort?.abort()
    this.#uiAbort = null
    this.#searchController?.abort()
    this.#searchController = null
    this.#searchSeq += 1
    this.#disposeAllRenders()
    for (const page of this.#pageCache.values()) {
      try {
        page.cleanup()
      } catch {
        // 页面已随 document 销毁时 cleanup 可能失败，忽略。
      }
    }
    this.#pageCache.clear()
    this.#pageMetrics.clear()
    this.#displaySizes.clear()
    this.#pageElements.clear()
    this.#layoutOffsets = []
    this.#mountedLayout = null
    this.#pageCount = 0
    this.#outlinePromise = null
    this.#outlineRendered = false
    this.#outlineAbort?.abort()
    this.#outlineAbort = null
    this.#outlineRequest?.abort()
    this.#outlineRequest = null
    this.#searchMatches = []
    this.#activeSearchIndex = -1
    this.#destinationHashes.clear()
    this.#transport?.abort()
    this.#transport = null
    this.#openWatchdog?.dispose()
    this.#openWatchdog = null
    const task = this.#loadingTask
    this.#loadingTask = null
    destroyLoadingTask(task)
    const pdf = this.#pdf
    this.#pdf = null
    if (pdf !== null) {
      void pdf.cleanup().catch(() => undefined)
    }
    if (this.#noticeTimer !== null) {
      window.clearTimeout(this.#noticeTimer)
      this.#noticeTimer = null
    }
    this.#root?.remove()
    this.#root = null
    this.#viewport = null
    this.#pages = null
    this.#pageIndicator = null
    this.#zoomIndicator = null
    this.#loading = null
    this.#errorOverlay = null
    this.#searchPanel = null
    this.#searchInput = null
    this.#searchStatus = null
    this.#searchResults = null
    this.#outlinePanel = null
    this.#outlineList = null
    this.#outlineStatus = null
    this.#layoutSelect = null
    this.#notice = null
    if (this.#host !== null) {
      delete this.#host.dataset.ireadPdf
      this.#host.style.position = this.#hostPosition
    }
    this.#host = null
    this.#manifest = null
    this.#mountSignal = null
    this.#lastEmittedKey = ""
    this.#viewportFallback = { width: 0, height: 0 }
    this.#sourceUrl = null
  }

  dispose(): void {
    this.unmount()
    this.#listeners.clear()
  }

  async restore(location: ReaderLocation): Promise<PdfReaderResult> {
    if (location.locatorType !== "pdf-page") {
      return {
        ok: false,
        reason: "当前位置不是 PDF 定位。",
        retryable: false,
      }
    }
    await this.#readyPromise
    if (this.#pdf === null) {
      return {
        ok: false,
        reason: this.#lastError?.message ?? "PDF 尚未打开。",
        retryable: this.#lastError?.retryable ?? true,
      }
    }
    return this.navigateTo(location)
  }

  async navigateTo(location: ReaderLocation): Promise<PdfReaderResult> {
    const epoch = ++this.#navigationEpoch
    if (location.locatorType !== "pdf-page") {
      return {
        ok: false,
        reason: "目标不是 PDF 页码定位。",
        retryable: false,
      }
    }
    await this.#readyPromise
    if (epoch !== this.#navigationEpoch) {
      return { ok: false, reason: "阅读位置已被更新的目标取代。", retryable: false }
    }
    if (this.#pdf === null) {
      return {
        ok: false,
        reason: this.#lastError?.message ?? "PDF 尚未打开。",
        retryable: this.#lastError?.retryable ?? true,
      }
    }
    const payload: PdfPageLocatorPayload = (
      location as Extract<ReaderLocation, { locatorType: "pdf-page" }>
    ).locatorPayload
    const page = Math.floor(payload.page)
    if (!Number.isSafeInteger(page) || page < 1 || page > this.#pageCount) {
      return {
        ok: false,
        reason: `页码 ${payload.page} 超出当前 PDF 的 1–${this.#pageCount} 页范围。`,
        retryable: false,
      }
    }
    const offset = clamp(payload.pageOffset, 0, 1)
    const viewPatch = viewFromPdfViewState(payload.view)
    const viewChanged =
      viewPatch !== null &&
      (viewPatch.layoutMode !== undefined ||
        viewPatch.zoomMode !== undefined ||
        viewPatch.manualScale !== undefined)
    if (viewPatch !== null) {
      this.#view = normalizeView({ ...this.#view, ...viewPatch })
      this.#applyViewAttributes()
    }
    if (epoch !== this.#navigationEpoch) {
      return { ok: false, reason: "阅读位置已被更新的目标取代。", retryable: false }
    }
    this.#currentPage = page
    if (viewChanged) {
      await this.#reflow({ page, pageOffset: offset }, epoch)
    } else {
      await this.#goToPage(page, offset, false, epoch)
    }
    if (epoch !== this.#navigationEpoch) {
      return { ok: false, reason: "阅读位置已被更新的目标取代。", retryable: false }
    }
    return { ok: true }
  }

  async advance(direction: "previous" | "next"): Promise<PdfReaderResult> {
    const epoch = ++this.#navigationEpoch
    await this.#readyPromise
    if (epoch !== this.#navigationEpoch) {
      return { ok: false, reason: "阅读位置已被更新的目标取代。", retryable: false }
    }
    if (this.#pdf === null) {
      return {
        ok: false,
        reason: this.#lastError?.message ?? "PDF 尚未打开。",
        retryable: this.#lastError?.retryable ?? true,
      }
    }
    const target = this.#currentPage + (direction === "next" ? 1 : -1)
    if (target < 1) {
      return { ok: false, reason: "已经是第一页。", retryable: false }
    }
    if (target > this.#pageCount) {
      return { ok: false, reason: "已经是最后一页。", retryable: false }
    }
    await this.#goToPage(target, 0, false, epoch)
    if (epoch !== this.#navigationEpoch) {
      return { ok: false, reason: "阅读位置已被更新的目标取代。", retryable: false }
    }
    return { ok: true }
  }

  subscribeLocation(
    listener: (location: ReaderLocation) => void,
  ): () => void {
    this.#listeners.add(listener)
    if (this.#pdf !== null && this.#pageCount > 0) {
      const location = this.getLocation()
      if (location !== null) {
        listener(location)
      }
    }
    return () => {
      this.#listeners.delete(listener)
    }
  }

  handleViewportChange(metrics: {
    width: number
    height: number
  }): void {
    if (metrics.width > 0 && metrics.height > 0) {
      this.#viewportFallback = {
        width: metrics.width,
        height: metrics.height,
      }
    }
    this.#scheduleResize()
  }

  // PDF 专用公开方法，便于 E2E 与后续格式设置面板调用。

  getPageCount(): number {
    return this.#pageCount
  }

  getView(): PdfViewSettings {
    return { ...this.#view }
  }

  getNetworkStats(): PdfNetworkStats {
    return {
      ...this.#stats,
      requests: this.#stats.requests.map((request) => ({ ...request })),
    }
  }

  getLocation(): ReaderLocation | null {
    if (this.#pdf === null || this.#pageCount < 1) {
      return null
    }
    const anchor = this.#captureAnchor()
    return pdfLocation(
      anchor.page,
      anchor.pageOffset,
      this.#pageCount,
      this.#relativeViewportForPage(anchor.page),
      this.#view,
    )
  }

  async setLayout(layoutMode: PdfLayoutMode): Promise<void> {
    if (!PDF_LAYOUT_MODES.includes(layoutMode)) {
      return
    }
    await this.setView({ layoutMode })
  }

  async setZoomMode(zoomMode: PdfZoomMode): Promise<void> {
    if (!PDF_ZOOM_MODES.includes(zoomMode)) {
      return
    }
    await this.setView({ zoomMode })
  }

  async setManualScale(scale: number): Promise<void> {
    await this.setView({
      zoomMode: "manual",
      manualScale: normalizeScale(scale),
    })
  }

  async setView(patch: Partial<PdfViewSettings>): Promise<void> {
    const previous = this.#view
    const next = normalizeView({ ...this.#view, ...patch })
    const layoutChanged = next.layoutMode !== previous.layoutMode
    const scaleChanged =
      next.zoomMode !== previous.zoomMode ||
      (next.zoomMode === "manual" && next.manualScale !== previous.manualScale) ||
      next.layoutMode !== previous.layoutMode
    const gapChanged = next.gap !== previous.gap
    const epoch = ++this.#navigationEpoch
    const anchor = this.#captureAnchor()
    this.#view = next
    this.#applyViewAttributes()
    if (this.#pdf === null) {
      return
    }
    if (!layoutChanged && !scaleChanged && !gapChanged) {
      return
    }
    if (layoutChanged) {
      this.#currentPage = anchor.page
    }
    await this.#reflow(anchor, epoch)
  }

  async rotate(degrees = 90): Promise<void> {
    if (this.#pdf === null) {
      return
    }
    const epoch = ++this.#navigationEpoch
    const anchor = this.#captureAnchor()
    const nextRotation = normalizeRotation(this.#userRotation + degrees)
    for (const [pageNumber, metrics] of this.#pageMetrics) {
      const totalRotation = normalizeRotation(metrics.pageRotation + nextRotation)
      const swapped =
        (metrics.totalRotation % 180 === 0) !== (totalRotation % 180 === 0)
      this.#pageMetrics.set(pageNumber, {
        ...metrics,
        width: swapped ? metrics.height : metrics.width,
        height: swapped ? metrics.width : metrics.height,
        totalRotation,
      })
    }
    this.#userRotation = nextRotation
    await this.#reflow(anchor, epoch)
  }

  clearSearch(): void {
    if (this.#searchNavigationEpoch === this.#navigationEpoch) this.#navigationEpoch++
    this.#searchNavigationEpoch = null
    this.#searchController?.abort()
    this.#searchController = null
    this.#searchSeq += 1
    this.#searchMatches = []
    this.#activeSearchIndex = -1
    this.#clearSearchHighlights()
    this.#renderSearchResults()
    this.#setSearchStatus("输入关键词后开始搜索。")
  }

  async search(query: string, externalSignal?: AbortSignal): Promise<PdfSearchMatch[]> {
    this.clearSearch()
    const normalized = query.trim()
    if (!normalized) return []
    const controller = new AbortController(), sequence = this.#searchSeq
    this.#searchController = controller
    const abortExternal = () => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    else externalSignal?.addEventListener("abort", abortExternal, { once: true })
    const cancelled = () => sequence !== this.#searchSeq || controller.signal.aborted
    const matches: PdfSearchMatch[] = []
    try {
      await this.#readyPromise
      if (cancelled() || !this.#pdf || this.#pageCount < 1) return []
      for (let pageNumber = 1; pageNumber <= this.#pageCount; pageNumber++) {
        if (cancelled()) return []
        const page = await this.#getPage(pageNumber)
        if (cancelled()) return []
        const textContent = await page.getTextContent()
        if (cancelled()) return []
        const items = textContent.items.filter((item): item is typeof item & { str: string; hasEOL?: boolean } => "str" in item)
        matches.push(...findPdfPageMatches(items, normalized, pageNumber, SEARCH_LIMIT - matches.length))
        this.#setSearchStatus(`正在搜索第 ${pageNumber} / ${this.#pageCount} 页…`)
        if (!this.#rendered.has(pageNumber) && !this.#renderPromises.has(pageNumber)) page.cleanup()
        if (matches.length >= SEARCH_LIMIT) break
      }
      if (cancelled()) return []
      this.#searchMatches = matches
      this.#renderSearchResults()
      this.#setSearchStatus(matches.length ? `找到 ${matches.length} 处${matches.length >= SEARCH_LIMIT ? `（已达到 ${SEARCH_LIMIT} 条上限）` : ""}。` : `没有找到“${normalized}”。`)
      this.#applySearchHighlights()
      return matches
    } finally {
      externalSignal?.removeEventListener("abort", abortExternal)
      if (this.#searchController === controller) this.#searchController = null
    }
  }

  getSearchMatches(): PdfSearchMatch[] {
    return this.#searchMatches.map((match) => ({ ...match }))
  }

  /**
   * 读取 PDF 内置目录。
   *
   * - 结果在同一文档内缓存，Shell 与引擎内部面板共享，不会重复请求 worker；
   * - 有超时与取消边界，不会因为 PDF.js 无响应而永久 pending；
   * - 调用方取消（关闭面板）只影响本次等待，不破坏缓存；
   * - 超时或失败会清空缓存，下一次打开可以重试。
   */
  async getOutline(
    options: PdfOutlineRequestOptions = {},
  ): Promise<PdfOutlineEntry[]> {
    const mountId = this.#mountId
    const operation = (async (): Promise<PdfOutlineEntry[]> => {
      await this.#readyPromise
      if (mountId !== this.#mountId || this.#pdf === null) {
        return []
      }
      return (
        this.#outlinePromise ??
        this.#beginOutlineLoad(this.#pdf, mountId)
      )
    })()
    try {
      return await withPdfOutlineDeadline(operation, {
        timeoutMs: options.timeoutMs ?? OUTLINE_TIMEOUT_MS,
        signal: options.signal,
      })
    } catch (error) {
      if (
        error instanceof PdfOutlineTimeoutError &&
        mountId === this.#mountId
      ) {
        // 超时后不再复用无响应的 promise，下次打开重新尝试。
        if (this.#outlinePromise !== null) {
          this.#outlineAbort?.abort()
          this.#outlineAbort = null
          this.#outlinePromise = null
        }
      }
      throw error
    }
  }

  #beginOutlineLoad(
    pdf: PDFDocumentProxy,
    mountId: number,
  ): Promise<PdfOutlineEntry[]> {
    this.#outlineAbort?.abort()
    const controller = new AbortController()
    this.#outlineAbort = controller
    const load = buildPdfOutline(pdf, { signal: controller.signal })
    this.#outlinePromise = load
    // 失败/中止后清空缓存，避免下一次永久复用 rejected promise。
    load.catch(() => {
      if (this.#outlinePromise === load && mountId === this.#mountId) {
        this.#outlinePromise = null
      }
      if (this.#outlineAbort === controller) {
        this.#outlineAbort = null
      }
    })
    return load
  }

  // 内部：DOM 与 UI

  #buildDom(host: HTMLElement): void {
    this.#hostPosition = host.style.position
    if (window.getComputedStyle(host).position === "static") {
      host.style.position = "relative"
    }
    host.dataset.ireadPdf = "mounted"

    const root = createElement("div", "iread-pdf")
    root.setAttribute("role", "region")
    root.setAttribute("aria-label", "PDF 阅读器")
    root.dataset.pdfReady = "false"

    const toolbar = createElement("div", "iread-pdf__toolbar")
    toolbar.setAttribute("role", "toolbar")
    toolbar.setAttribute("aria-label", "PDF 工具栏")

    const pageNav = createElement("div", "iread-pdf__group")
    const previous = createButton("上一页", "‹")
    previous.addEventListener("click", () => {
      void this.advance("previous").then((result) => {
        if (!result.ok) this.#showNotice(result.reason)
      })
    })
    const indicator = createElement("span", "iread-pdf__page-indicator", "1 / –")
    indicator.dataset.pdfPage = "1"
    indicator.dataset.pdfPageCount = "0"
    this.#pageIndicator = indicator
    const next = createButton("下一页", "›")
    next.addEventListener("click", () => {
      void this.advance("next").then((result) => {
        if (!result.ok) this.#showNotice(result.reason)
      })
    })
    pageNav.append(previous, indicator, next)

    const zoomGroup = createElement("div", "iread-pdf__group")
    const zoomOut = createButton("缩小", "−")
    zoomOut.addEventListener("click", () => {
      void this.#stepManualScale(1 / 1.15)
    })
    const zoom = createElement("span", "iread-pdf__zoom-indicator", "100%")
    this.#zoomIndicator = zoom
    const zoomIn = createButton("放大", "+")
    zoomIn.addEventListener("click", () => {
      void this.#stepManualScale(1.15)
    })
    const fitWidth = createButton("适应宽度", "宽")
    fitWidth.addEventListener("click", () => {
      void this.setZoomMode("fit-width")
    })
    const fitPage = createButton("适应页面", "页")
    fitPage.addEventListener("click", () => {
      void this.setZoomMode("fit-page")
    })
    const rotate = createButton("旋转 90 度", "↻")
    rotate.addEventListener("click", () => {
      void this.rotate(90)
    })
    zoomGroup.append(zoomOut, zoom, zoomIn, fitWidth, fitPage, rotate)

    const layoutGroup = createElement("div", "iread-pdf__group")
    const layoutSelect = createElement("select", "iread-pdf__select")
    layoutSelect.setAttribute("aria-label", "页面布局")
    const layoutLabels: Record<PdfLayoutMode, string> = {
      single: "单页",
      continuous: "连续",
      horizontal: "横向",
    }
    for (const mode of PDF_LAYOUT_MODES) {
      const option = createElement("option", undefined, layoutLabels[mode])
      option.value = mode
      layoutSelect.append(option)
    }
    layoutSelect.addEventListener("change", () => {
      void this.setLayout(layoutSelect.value as PdfLayoutMode)
    })
    this.#layoutSelect = layoutSelect
    layoutGroup.append(layoutSelect)

    const toolGroup = createElement("div", "iread-pdf__group iread-pdf__group--end")
    const searchButton = createButton("搜索 PDF", "搜索")
    searchButton.addEventListener("click", () => {
      this.#toggleSearchPanel()
    })
    const outlineButton = createButton("PDF 内置目录", "目录")
    outlineButton.addEventListener("click", () => {
      void this.#toggleOutlinePanel()
    })
    toolGroup.append(searchButton, outlineButton)

    const status = createElement("div", "iread-pdf__toolbar-status")
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    toolbar.append(pageNav, zoomGroup, layoutGroup, toolGroup, status)

    const viewport = createElement("div", "iread-pdf__viewport")
    viewport.tabIndex = 0
    this.#viewport = viewport
    const pages = createElement("div", "iread-pdf__pages")
    pages.dataset.layout = this.#view.layoutMode
    this.#pages = pages
    viewport.append(pages)

    const loading = createElement("div", "iread-pdf__loading")
    loading.setAttribute("role", "status")
    const loadingText = createElement(
      "p",
      "iread-pdf__loading-text",
      "正在准备按需读取 PDF…",
    )
    loading.append(loadingText)
    this.#loading = loading
    this.#loadingText = loadingText

    const searchPanel = this.#buildSearchPanel()
    const outlinePanel = this.#buildOutlinePanel()
    const errorOverlay = this.#buildErrorOverlay()
    const notice = createElement("div", "iread-pdf__notice")
    notice.setAttribute("role", "status")
    notice.setAttribute("aria-live", "polite")
    this.#notice = notice

    root.append(toolbar, viewport, searchPanel, outlinePanel, loading, errorOverlay, notice)
    host.append(root)
    this.#root = root
    this.#applyViewAttributes()
    this.#updateIndicator()

    const observer = new ResizeObserver(() => {
      this.#scheduleResize()
    })
    observer.observe(root)
    observer.observe(viewport)
    this.#resizeObserver = observer

    viewport.addEventListener(
      "scroll",
      () => {
        this.#scheduleScrollUpdate()
      },
      { passive: true },
    )

  }

  #buildSearchPanel(): HTMLDivElement {
    const panel = createElement("div", "iread-pdf__search")
    panel.hidden = true
    const header = createElement("div", "iread-pdf__panel-header")
    const title = createElement("h2", "iread-pdf__panel-title", "搜索")
    const close = createButton("关闭搜索", "关闭", "iread-pdf__button iread-pdf__button--quiet")
    close.addEventListener("click", () => {
      panel.hidden = true
    })
    header.append(title, close)

    const form = createElement("form", "iread-pdf__search-form")
    const input = createElement("input", "iread-pdf__search-input")
    input.type = "search"
    input.placeholder = "在 PDF 中搜索"
    input.setAttribute("aria-label", "在 PDF 中搜索")
    input.autocomplete = "off"
    input.addEventListener("input", () => this.clearSearch())
    this.#searchInput = input
    const submit = createButton("执行搜索", "搜索", "iread-pdf__button iread-pdf__button--primary")
    submit.type = "submit"
    form.append(input, submit)
    form.addEventListener("submit", (event) => {
      event.preventDefault()
      void this.#runSearchFromUi()
    })

    const controls = createElement("div", "iread-pdf__search-controls")
    const previous = createButton("上一个搜索结果", "上一个")
    previous.addEventListener("click", () => {
      void this.#activateSearchResult(this.#activeSearchIndex - 1)
    })
    const next = createButton("下一个搜索结果", "下一个")
    next.addEventListener("click", () => {
      void this.#activateSearchResult(this.#activeSearchIndex + 1)
    })
    controls.append(previous, next)

    const status = createElement("p", "iread-pdf__search-status", "输入关键词后开始搜索。")
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    this.#searchStatus = status
    const results = createElement("ul", "iread-pdf__search-results")
    this.#searchResults = results

    panel.append(header, form, controls, status, results)
    this.#searchPanel = panel
    return panel
  }

  #buildOutlinePanel(): HTMLDivElement {
    const panel = createElement("div", "iread-pdf__outline")
    panel.hidden = true
    panel.dataset.outlineState = "idle"
    const header = createElement("div", "iread-pdf__panel-header")
    const title = createElement("h2", "iread-pdf__panel-title", "PDF 内置目录")
    const close = createButton("关闭 PDF 目录", "关闭", "iread-pdf__button iread-pdf__button--quiet")
    close.addEventListener("click", () => {
      this.#closeOutlinePanel()
    })
    header.append(title, close)
    const status = createElement("p", "iread-pdf__outline-status", "")
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    this.#outlineStatus = status
    const list = createElement("div", "iread-pdf__outline-list")
    this.#outlineList = list
    panel.append(header, status, list)
    this.#outlinePanel = panel
    return panel
  }

  #buildErrorOverlay(): HTMLDivElement {
    const overlay = createElement("div", "iread-pdf__error")
    overlay.hidden = true
    overlay.setAttribute("role", "alert")
    const title = createElement("h2", "iread-pdf__error-title", "无法打开 PDF")
    const message = createElement(
      "p",
      "iread-pdf__error-message",
      "请重试；如果问题持续，请返回书库。",
    )
    const actions = createElement("div", "iread-pdf__error-actions")
    const retry = createButton("重试打开 PDF", "重试", "iread-pdf__button iread-pdf__button--primary")
    retry.addEventListener("click", () => {
      void this.#retryMount()
    })
    const back = createButton("返回书库", "返回", "iread-pdf__button")
    back.hidden = this.#options.onBack === undefined
    back.addEventListener("click", () => {
      this.#options.onBack?.()
    })
    actions.append(retry, back)
    overlay.append(title, message, actions)
    this.#errorOverlay = overlay
    this.#errorTitle = title
    this.#errorMessage = message
    return overlay
  }

  #bindUi(): void {
    this.#uiAbort?.abort()
    const controller = new AbortController()
    this.#uiAbort = controller
    const root = this.#root
    if (root === null) {
      return
    }
    root.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing) {
          return
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault()
          this.#openSearchPanel()
          return
        }
        if (event.key === "Escape") {
          const searchOpen = this.#searchPanel?.hidden === false
          const outlineOpen = this.#outlinePanel?.hidden === false
          if (searchOpen || outlineOpen) {
            event.preventDefault()
            event.stopPropagation()
            if (this.#searchPanel !== null) this.#searchPanel.hidden = true
            this.#closeOutlinePanel()
          }
        }
      },
      { signal: controller.signal },
    )
  }

  #applyViewAttributes(): void {
    const root = this.#root
    if (root === null) {
      return
    }
    root.dataset.layout = this.#view.layoutMode
    root.dataset.zoom = this.#view.zoomMode
    root.dataset.background = this.#view.background
    root.dataset.toolbar = this.#view.toolbarVisible ? "visible" : "hidden"
    if (this.#layoutSelect !== null) {
      this.#layoutSelect.value = this.#view.layoutMode
    }
    const pages = this.#pages
    if (pages !== null) {
      pages.dataset.layout = this.#view.layoutMode
    }
    this.#updateZoomIndicator()
  }

  #applyView(settings: PdfViewSettings): void {
    const changed =
      settings.layoutMode !== this.#view.layoutMode ||
      settings.zoomMode !== this.#view.zoomMode ||
      settings.manualScale !== this.#view.manualScale ||
      settings.gap !== this.#view.gap ||
      settings.background !== this.#view.background ||
      settings.toolbarVisible !== this.#view.toolbarVisible
    this.#view = settings
    this.#applyViewAttributes()
    if (changed && this.#pdf !== null) {
      void this.#reflow(this.#captureAnchor())
    }
  }

  async #readViewSettings(
    bookId: string,
    signal: AbortSignal,
  ): Promise<PdfViewSettings | null> {
    const request = async (path: string): Promise<unknown> => {
      try {
        const response = await fetch(path, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal,
        })
        if (!response.ok) {
          return null
        }
        const payload: unknown = await response.json()
        if (!isRecord(payload) || !isRecord(payload.data)) {
          return null
        }
        return payload.data
      } catch {
        return null
      }
    }
    const [globalValue, overrides] = await Promise.all([
      request("/api/v1/settings/reader"),
      request(`/api/v1/books/${encodeURIComponent(bookId)}/reader-overrides`),
    ])
    if (signal.aborted) {
      return null
    }
    let view = normalizeView(null)
    const globalPartial = isRecord(globalValue)
      ? viewFromEffectiveSettings(globalValue.value)
      : null
    if (globalPartial !== null) {
      view = normalizeView({ ...view, ...globalPartial })
    }
    if (isRecord(overrides)) {
      const overridePartial =
        viewFromEffectiveSettings(overrides.effectiveValues) ??
        viewFromEffectiveSettings(overrides.overrides)
      if (overridePartial !== null) {
        view = normalizeView({ ...view, ...overridePartial })
      }
    }
    return view
  }

  // 内部：打开文档与 Range

  async #openDocument(
    contentHref: string,
    mountId: number,
    signal: AbortSignal,
  ): Promise<void> {
    const manifest = this.#manifest
    if (manifest === null || manifest.format !== "pdf") {
      return
    }
    this.#setLoadingText("正在按需读取 PDF…")
    const initial = await fetchInitialRange(
      contentHref,
      manifest.formatData.byteSize,
      {
        signal,
        fetchImpl: this.#options.fetchImpl,
        cache: this.#cache ?? undefined,
        onRequest: (request) => {
          this.#recordRequest(request)
        },
      },
    )
    if (mountId !== this.#mountId || signal.aborted) {
      return
    }
    this.#stats.totalBytes = initial.totalBytes
    this.#sourceUrl = new URL(
      contentHref,
      typeof window === "undefined" ? "http://localhost/" : window.location.href,
    )
    const transport = new HttpPdfRangeTransport(this.#sourceUrl, {
      length: initial.totalBytes,
      initialData: initial.data,
      fetchImpl: this.#options.fetchImpl,
      signal,
      cache: this.#cache ?? undefined,
      onRequest: (request) => {
        this.#recordRequest(request)
      },
      onError: (error: unknown) => {
        this.#showFatalError(toLoadError(error), true)
      },
    })
    this.#transport = transport
    this.#setLoadingText("正在解析 PDF…")
    const task = getDocument({
      url: this.#sourceUrl.href,
      range: transport,
      withCredentials: true,
      rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
      disableRange: false,
      disableStream: false,
      disableAutoFetch: true,
      isEvalSupported: false,
      enableXfa: false,
      enableScripting: false,
      useSystemFonts: true,
      maxImageSize: 100_000_000,
      cMapUrl: `${PDFJS_ASSET_ROOT}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_ASSET_ROOT}standard_fonts/`,
      wasmUrl: `${PDFJS_ASSET_ROOT}wasm/`,
      iccUrl: `${PDFJS_ASSET_ROOT}iccs/`,
    } as Parameters<typeof getDocument>[0])
    this.#loadingTask = task
    const timeoutMs = this.#options.timeoutMs ?? OPEN_TIMEOUT_MS
    const watchdog = new PdfOpenWatchdog({
      timeoutMs,
      stallMs: Math.min(OPEN_STALL_TIMEOUT_MS, timeoutMs),
      onTimeout: () => {
        destroyLoadingTask(task)
      },
    })
    this.#openWatchdog = watchdog
    let opened = false
    task.onProgress = (progress: { loaded: number; total?: number }) => {
      watchdog.progress(progress.loaded)
      // 文档已经 ready 后，迟到的进度事件不得把 loading 重新显示出来。
      if (opened || mountId !== this.#mountId || this.#pdf !== null) {
        return
      }
      const total =
        progress.total && progress.total > 0
          ? progress.total
          : this.#stats.totalBytes
      if (total > 0) {
        this.#stats.totalBytes = total
      }
      this.#stats.downloadedBytes = Math.max(
        this.#stats.downloadedBytes,
        progress.loaded,
      )
      const percent =
        total > 0 ? Math.min(100, Math.round((progress.loaded / total) * 100)) : 0
      this.#setLoadingText(`正在按需读取 PDF… ${percent}%`)
    }

    const pdf = await watchdog.wait(task.promise)
    opened = true
    if (this.#openWatchdog === watchdog) {
      this.#openWatchdog = null
    }
    if (mountId !== this.#mountId || signal.aborted) {
      await destroyLoadingTaskAndWait(task)
      return
    }
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) {
      await destroyLoadingTaskAndWait(task)
      throw new PdfLoadError("empty_pdf", "这份 PDF 没有可显示的页面。", {
        retryable: false,
      })
    }
    this.#pdf = pdf
    this.#pageCount = pdf.numPages
    this.#currentPage = 1
    this.#outlinePromise = null
    this.#outlineRendered = false
    this.#outlineAbort?.abort()
    this.#outlineAbort = null
    this.#outlineRequest?.abort()
    this.#outlineRequest = null
    this.#clearOpenTransientState()
    if (this.#root !== null) {
      this.#root.dataset.pdfReady = "true"
      this.#root.dataset.pdfState = "ready"
      this.#root.dataset.pdfPageCount = String(this.#pageCount)
    }
    this.#options.onOpenStateChange?.("ready", {
      pageCount: this.#pageCount,
    })
    this.#updateIndicator()
    this.#updateZoomIndicator()
    this.#rebuildLayoutDom()
    await this.#ensurePageMetrics(1)
    if (mountId !== this.#mountId) {
      return
    }
    this.#updateAllPageSizes()
    this.#computeLayoutOffsets()
    this.#scrollToAnchor({ page: 1, pageOffset: 0 })
    this.#refreshVisible()
    this.#emitLocation()
  }

  #recordRequest(request: PdfNetworkRequest): void {
    this.#stats.requestCount += 1
    this.#stats.downloadedBytes += request.bytes
    this.#stats.requests.push(request)
    if (request.status === 200) {
      this.#stats.fullBodyResponse = true
    }
  }

  /**
   * 打开或重试成功后清理所有临时状态：错误遮罩、错误码、loading 与
   * 引擎内 notice，避免成功页面残留上一次失败的信息。
   */
  #clearOpenTransientState(): void {
    this.#lastError = null
    if (this.#root !== null) {
      delete this.#root.dataset.errorCode
    }
    if (this.#errorOverlay !== null) {
      this.#errorOverlay.hidden = true
    }
    if (this.#noticeTimer !== null) {
      window.clearTimeout(this.#noticeTimer)
      this.#noticeTimer = null
    }
    if (this.#notice !== null) {
      this.#notice.textContent = ""
    }
    this.#setLoadingText("")
  }

  #showFatalError(error: PdfLoadError, keepContent = false): void {
    this.#lastError = error
    this.#options.onOpenStateChange?.("error", {
      pageCount: this.#pageCount,
    })
    this.#openWatchdog?.dispose()
    this.#openWatchdog = null
    if (this.#loading !== null) {
      this.#loading.hidden = true
    }
    if (this.#root !== null) {
      this.#root.dataset.pdfState = "error"
      this.#root.dataset.errorCode = error.code
    }
    if (this.#errorTitle !== null) {
      this.#errorTitle.textContent =
        error.code === "unauthenticated"
          ? "登录状态已失效"
          : error.code === "file_version_conflict"
            ? "PDF 原件已更新"
            : error.code === "password_required"
              ? "PDF 受密码保护"
              : keepContent
                ? "PDF 内容加载中断"
                : "无法打开 PDF"
    }
    if (this.#errorMessage !== null) {
      this.#errorMessage.textContent = error.message
    }
    if (this.#errorOverlay !== null) {
      this.#errorOverlay.hidden = false
    }
    this.#setLoadingText("")
  }

  async #retryMount(): Promise<void> {
    const host = this.#host
    const manifest = this.#manifest
    if (host === null || manifest === null) {
      return
    }
    const signal = this.#mountSignal
    if (signal === null || signal.aborted) {
      return
    }
    await this.mount(host, manifest, signal)
  }

  #setLoadingText(text: string): void {
    if (this.#loadingText !== null) {
      this.#loadingText.textContent = text
    }
    if (this.#loading !== null) {
      this.#loading.hidden = text.length === 0
    }
  }

  // 内部：页面尺寸、布局与滚动

  #pageElement(pageNumber: number): HTMLElement {
    const existing = this.#pageElements.get(pageNumber)
    if (existing !== undefined) {
      return existing
    }
    const pageElement = createElement("div", "iread-pdf__page")
    pageElement.dataset.pdfPage = String(pageNumber)
    pageElement.setAttribute("aria-label", `第 ${pageNumber} 页`)
    const canvasWrap = createElement("div", "iread-pdf__page-canvas")
    const canvas = createElement("canvas")
    canvas.setAttribute("role", "presentation")
    canvasWrap.append(canvas)
    const textLayer = createElement("div", "textLayer")
    const annotationLayer = createElement("div", "annotationLayer")
    const fallback = createElement("div", "iread-pdf__page-error")
    fallback.hidden = true
    const fallbackText = createElement("p", "iread-pdf__page-error-text")
    const retry = createButton(
      "重试当前页",
      "重试",
      "iread-pdf__button iread-pdf__button--small",
    )
    retry.addEventListener("click", () => {
      this.#disposeRendered(pageNumber)
      void this.#renderPage(pageNumber)
    })
    fallback.append(fallbackText, retry)
    pageElement.append(canvasWrap, textLayer, annotationLayer, fallback)
    this.#pageElements.set(pageNumber, pageElement)
    return pageElement
  }

  #updatePageElementSize(pageNumber: number): void {
    const element = this.#pageElements.get(pageNumber)
    if (element === undefined) {
      return
    }
    const metrics = this.#metricsFor(pageNumber)
    const scale = this.#scaleFor(metrics)
    const width = Math.max(1, metrics.width * scale)
    const height = Math.max(1, metrics.height * scale)
    element.style.cssText = `--scale-factor:${scale};--total-scale-factor:${scale};width:${width}px;height:${height}px;`
    element.dataset.scale = scale.toFixed(4)
    this.#displaySizes.set(pageNumber, { width, height, scale })
  }

  #updateAllPageSizes(): void {
    for (let pageNumber = 1; pageNumber <= this.#pageCount; pageNumber += 1) {
      if (this.#pageElements.has(pageNumber)) {
        this.#updatePageElementSize(pageNumber)
      }
    }
    const currentScale = this.#displaySizes.get(this.#currentPage)?.scale
    if (currentScale !== undefined) {
      this.#currentScaleForZoom = currentScale
      this.#updateZoomIndicator()
    }
  }

  #currentScaleForZoom = 1

  #metricsFor(pageNumber: number): PdfPageMetrics {
    const cached = this.#pageMetrics.get(pageNumber)
    if (cached !== undefined) {
      return cached
    }
    const totalRotation = normalizeRotation(this.#userRotation)
    const swapped = totalRotation % 180 !== 0
    return {
      width: swapped ? DEFAULT_PAGE_HEIGHT : DEFAULT_PAGE_WIDTH,
      height: swapped ? DEFAULT_PAGE_WIDTH : DEFAULT_PAGE_HEIGHT,
      pageRotation: 0,
      totalRotation,
    }
  }

  #scaleFor(metrics: PdfPageMetrics): number {
    const size = this.#viewportContentSize()
    if (this.#view.zoomMode === "manual") {
      return normalizeScale(this.#view.manualScale)
    }
    const widthScale = size.width / Math.max(1, metrics.width)
    if (this.#view.zoomMode === "fit-width") {
      return clamp(widthScale, 0.05, 8)
    }
    const heightScale = size.height / Math.max(1, metrics.height)
    return clamp(Math.min(widthScale, heightScale), 0.05, 8)
  }

  #viewportContentSize(): { width: number; height: number } {
    const viewport = this.#viewport
    if (viewport === null) {
      return {
        width: Math.max(1, this.#viewportFallback.width),
        height: Math.max(1, this.#viewportFallback.height),
      }
    }
    const style = window.getComputedStyle(viewport)
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
    const paddingRight = Number.parseFloat(style.paddingRight) || 0
    const paddingTop = Number.parseFloat(style.paddingTop) || 0
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0
    const width =
      viewport.clientWidth - paddingLeft - paddingRight > 0
        ? viewport.clientWidth - paddingLeft - paddingRight
        : this.#viewportFallback.width
    const height =
      viewport.clientHeight - paddingTop - paddingBottom > 0
        ? viewport.clientHeight - paddingTop - paddingBottom
        : this.#viewportFallback.height
    return { width: Math.max(1, width), height: Math.max(1, height) }
  }

  #rebuildLayoutDom(): void {
    const pages = this.#pages
    if (pages === null) {
      return
    }
    pages.dataset.layout = this.#view.layoutMode
    if (this.#view.layoutMode === "single") {
      const target = this.#pageElement(this.#currentPage)
      if (pages.firstElementChild !== target) {
        pages.replaceChildren(target)
      }
      this.#mountedLayout = "single"
      return
    }
    if (
      this.#mountedLayout !== this.#view.layoutMode ||
      pages.childElementCount !== this.#pageCount
    ) {
      const fragment = document.createDocumentFragment()
      for (let pageNumber = 1; pageNumber <= this.#pageCount; pageNumber += 1) {
        fragment.append(this.#pageElement(pageNumber))
      }
      pages.replaceChildren(fragment)
    }
    this.#mountedLayout = this.#view.layoutMode
  }

  #computeLayoutOffsets(): void {
    this.#layoutOffsets = []
    if (this.#view.layoutMode === "single") {
      return
    }
    const gap = PDF_GAP_PIXELS[this.#view.gap]
    let cursor = 0
    for (let pageNumber = 1; pageNumber <= this.#pageCount; pageNumber += 1) {
      const display = this.#displaySizes.get(pageNumber)
      const metrics = this.#metricsFor(pageNumber)
      const size = this.#scaleFor(metrics)
      const width = display?.width ?? metrics.width * size
      const height = display?.height ?? metrics.height * size
      const dimension =
        this.#view.layoutMode === "horizontal" ? width : height
      this.#layoutOffsets.push({ start: cursor, size: dimension })
      cursor += dimension + gap
    }
  }

  #captureAnchor(): PdfAnchor {
    if (this.#pdf === null || this.#pageCount < 1) {
      return { page: 1, pageOffset: 0 }
    }
    const page = this.#view.layoutMode === "single"
      ? clamp(this.#currentPage, 1, this.#pageCount)
      : this.#pageFromScroll()
    const pageOffset = this.#pageOffsetFor(page)
    return { page, pageOffset }
  }

  #pageFromScroll(): number {
    const viewport = this.#viewport
    if (viewport === null || this.#layoutOffsets.length === 0) {
      return this.#currentPage
    }
    const horizontal = this.#view.layoutMode === "horizontal"
    const scroll = horizontal ? viewport.scrollLeft : viewport.scrollTop
    const size = horizontal ? viewport.clientWidth : viewport.clientHeight
    const target = scroll + (horizontal ? size * 0.5 : 1)
    let low = 0
    let high = this.#layoutOffsets.length - 1
    let result = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const offset = this.#layoutOffsets[middle]
      if (target < offset.start + offset.size) {
        result = middle
        high = middle - 1
      } else {
        low = middle + 1
      }
    }
    return clamp(result + 1, 1, this.#pageCount)
  }

  #pageOffsetFor(pageNumber: number): number {
    const viewport = this.#viewport
    if (viewport === null || this.#pdf === null) {
      return 0
    }
    if (this.#view.layoutMode === "single") {
      const display = this.#displaySizes.get(pageNumber)
      if (display === undefined || display.height <= 0) {
        return 0
      }
      return clamp(viewport.scrollTop / display.height, 0, 1)
    }
    const offset = this.#layoutOffsets[pageNumber - 1]
    if (offset === undefined || offset.size <= 0) {
      return 0
    }
    const scroll =
      this.#view.layoutMode === "horizontal"
        ? viewport.scrollLeft
        : viewport.scrollTop
    return clamp((scroll - offset.start) / offset.size, 0, 1)
  }

  #scrollToAnchor(anchor: PdfAnchor): void {
    const viewport = this.#viewport
    if (viewport === null || this.#pdf === null) {
      return
    }
    const page = clamp(Math.floor(anchor.page), 1, this.#pageCount)
    const offset = clamp(anchor.pageOffset, 0, 1)
    if (this.#view.layoutMode === "single") {
      this.#currentPage = page
      this.#rebuildLayoutDom()
      this.#updatePageElementSize(page)
      const display = this.#displaySizes.get(page)
      viewport.scrollTop = display === undefined ? 0 : display.height * offset
      viewport.scrollLeft = 0
      return
    }
    const entry = this.#layoutOffsets[page - 1]
    if (entry === undefined) {
      return
    }
    if (this.#view.layoutMode === "horizontal") {
      viewport.scrollLeft = entry.start + entry.size * offset
    } else {
      viewport.scrollTop = entry.start + entry.size * offset
    }
  }

  async #goToPage(
    pageNumber: number,
    pageOffset: number,
    reflow: boolean,
    epoch = ++this.#navigationEpoch,
  ): Promise<void> {
    if (epoch !== this.#navigationEpoch) {
      return
    }
    if (pageNumber !== this.#currentPage) {
      // 旧页尚未完成的 Range 不再需要；新页请求会在下面重新发起。
      this.#transport?.cancelPending()
    }
    this.#currentPage = pageNumber
    if (reflow) {
      await this.#reflow({ page: pageNumber, pageOffset }, epoch)
      return
    }
    await this.#ensurePageMetrics(pageNumber)
    if (epoch !== this.#navigationEpoch) {
      return
    }
    if (this.#view.layoutMode === "single") {
      this.#rebuildLayoutDom()
      this.#updatePageElementSize(pageNumber)
    } else {
      this.#updatePageElementSize(pageNumber)
      this.#computeLayoutOffsets()
    }
    this.#scrollToAnchor({ page: pageNumber, pageOffset })
    this.#refreshVisible()
    this.#emitLocation()
  }

  async #ensurePageMetrics(pageNumber: number): Promise<PdfPageMetrics> {
    const cached = this.#pageMetrics.get(pageNumber)
    if (cached !== undefined) {
      return cached
    }
    const page = await this.#getPage(pageNumber)
    const totalRotation = normalizeRotation(page.rotate + this.#userRotation)
    const viewport = page.getViewport({ scale: 1, rotation: totalRotation })
    const metrics: PdfPageMetrics = {
      width: viewport.width,
      height: viewport.height,
      pageRotation: page.rotate,
      totalRotation,
    }
    this.#pageMetrics.set(pageNumber, metrics)
    return metrics
  }

  async #getPage(pageNumber: number): Promise<PDFPageProxy> {
    const cached = this.#pageCache.get(pageNumber)
    if (cached !== undefined) {
      return cached
    }
    const pdf = this.#pdf
    if (pdf === null) {
      throw new PdfLoadError("not_ready", "PDF 尚未打开。", {
        retryable: true,
      })
    }
    const page = await pdf.getPage(pageNumber)
    this.#pageCache.set(pageNumber, page)
    return page
  }

  async #reflow(
    anchor: PdfAnchor,
    epoch = ++this.#navigationEpoch,
  ): Promise<void> {
    if (this.#pdf === null) {
      return
    }
    if (anchor.page !== this.#currentPage) {
      this.#transport?.cancelPending()
    }
    this.#disposeAllRenders()
    await this.#ensurePageMetrics(anchor.page)
    if (epoch !== this.#navigationEpoch) {
      return
    }
    this.#rebuildLayoutDom()
    this.#updateAllPageSizes()
    this.#computeLayoutOffsets()
    this.#currentPage = clamp(anchor.page, 1, this.#pageCount)
    this.#scrollToAnchor(anchor)
    this.#refreshVisible()
    this.#emitLocation()
  }

  #scheduleResize(): void {
    if (this.#resizeFrame !== null) {
      return
    }
    this.#resizeFrame = window.requestAnimationFrame(() => {
      this.#resizeFrame = null
      if (this.#pdf === null) {
        return
      }
      const anchor = this.#captureAnchor()
      void this.#reflow(anchor)
    })
  }

  #scheduleScrollUpdate(): void {
    if (this.#scrollFrame !== null) {
      return
    }
    this.#scrollFrame = window.requestAnimationFrame(() => {
      this.#scrollFrame = null
      if (this.#pdf === null) {
        return
      }
      if (this.#view.layoutMode !== "single") {
        this.#currentPage = this.#pageFromScroll()
      }
      this.#refreshVisible()
      this.#emitLocation()
    })
  }

  #cancelFrame(): void {
    if (this.#resizeFrame !== null) {
      window.cancelAnimationFrame(this.#resizeFrame)
      this.#resizeFrame = null
    }
    if (this.#scrollFrame !== null) {
      window.cancelAnimationFrame(this.#scrollFrame)
      this.#scrollFrame = null
    }
  }

  // 内部：虚拟渲染

  #refreshVisible(): void {
    if (this.#pdf === null || this.#pages === null) {
      return
    }
    const page = clamp(Math.floor(this.#currentPage), 1, this.#pageCount)
    this.#currentPage = page
    if (this.#view.layoutMode === "single") {
      this.#rebuildLayoutDom()
      const windowPages = this.#renderWindowFor(page)
      this.#renderWindow = new Set(windowPages)
      for (const pageNumber of windowPages) {
        void this.#renderPage(pageNumber)
      }
      this.#disposeOutsideWindow()
      this.#updateIndicator()
      return
    }

    const { first, last } = this.#visiblePageRange()
    if (last >= first) {
      this.#currentPage = this.#view.layoutMode === "horizontal"
        ? this.#pageFromScroll()
        : first
    }
    const windowPages = this.#renderWindowFor(this.#currentPage, first, last)
    this.#renderWindow = new Set(windowPages)
    for (const pageNumber of windowPages) {
      void this.#renderPage(pageNumber)
    }
    this.#disposeOutsideWindow()
    this.#updateIndicator()
  }

  #renderWindowFor(
    anchorPage: number,
    firstVisible = anchorPage,
    lastVisible = anchorPage,
  ): number[] {
    const coarse = window.matchMedia("(pointer: coarse)").matches
    const limit = coarse ? MOBILE_CANVAS_COUNT : DESKTOP_CANVAS_COUNT
    const result = new Set<number>()
    for (let page = firstVisible; page <= lastVisible; page += 1) {
      result.add(clamp(page, 1, this.#pageCount))
      if (result.size >= limit) break
    }
    if (result.size === 0) {
      result.add(clamp(anchorPage, 1, this.#pageCount))
    }
    if (result.size < limit) {
      result.add(clamp(anchorPage + 1, 1, this.#pageCount))
    }
    if (result.size < limit) {
      result.add(clamp(anchorPage - 1, 1, this.#pageCount))
    }
    if (result.size < limit && limit >= DESKTOP_CANVAS_COUNT) {
      result.add(clamp(anchorPage + 2, 1, this.#pageCount))
    }
    return [...result].sort((left, right) => left - right)
  }

  #visiblePageRange(): { first: number; last: number } {
    const viewport = this.#viewport
    if (viewport === null || this.#layoutOffsets.length === 0) {
      return { first: this.#currentPage, last: this.#currentPage }
    }
    const horizontal = this.#view.layoutMode === "horizontal"
    const scroll = horizontal ? viewport.scrollLeft : viewport.scrollTop
    const size = horizontal ? viewport.clientWidth : viewport.clientHeight
    const end = scroll + size
    let first = this.#layoutOffsets.length
    let last = -1
    for (let index = 0; index < this.#layoutOffsets.length; index += 1) {
      const entry = this.#layoutOffsets[index]
      if (entry.start + entry.size > scroll && entry.start < end) {
        if (index < first) first = index
        if (index > last) last = index
      }
      if (entry.start >= end) {
        break
      }
    }
    if (last < first) {
      return { first: this.#currentPage, last: this.#currentPage }
    }
    return { first: first + 1, last: last + 1 }
  }

  #renderKey(pageNumber: number): string {
    const metrics = this.#metricsFor(pageNumber)
    const scale = this.#scaleFor(metrics)
    return `${scale.toFixed(4)}:${metrics.totalRotation}`
  }

  #renderCacheKey(pageNumber: number, scaleKey: string): string {
    const metrics = this.#metricsFor(pageNumber)
    const scale = this.#scaleFor(metrics)
    return renderKeyId({
      resource: pdfPageKey(
        this.#manifest?.bookId ?? "",
        this.#manifest?.fileVersion ?? "",
        pageNumber,
      ),
      styleRevision: scaleKey,
      viewport: {
        width: metrics.width * scale,
        height: metrics.height * scale,
        rotation: metrics.totalRotation,
      },
      zoom: scale,
      rotation: metrics.totalRotation,
    })
  }

  #renderPage(pageNumber: number): Promise<void> {
    const key = this.#renderKey(pageNumber)
    const pending = this.#renderPromises.get(pageNumber)
    if (pending !== undefined && pending.scaleKey === key) {
      return pending.promise
    }
    const rendered = this.#rendered.get(pageNumber)
    if (rendered !== undefined && rendered.scaleKey === key) {
      if (this.#manifest !== null) {
        this.#cache?.scheduler.recordCacheHit(
          pdfPageKey(
            this.#manifest.bookId,
            this.#manifest.fileVersion,
            pageNumber,
          ),
          "L2",
        )
      }
      return Promise.resolve()
    }
    this.#disposeRendered(pageNumber)
    const token = (this.#renderTokens.get(pageNumber) ?? 0) + 1
    this.#renderTokens.set(pageNumber, token)
    const promise = this.#doRenderPage(pageNumber, key, token).finally(() => {
      const current = this.#renderPromises.get(pageNumber)
      if (current?.promise === promise) {
        this.#renderPromises.delete(pageNumber)
      }
    })
    this.#renderPromises.set(pageNumber, { scaleKey: key, promise })
    return promise
  }

  async #doRenderPage(
    pageNumber: number,
    key: string,
    token: number,
  ): Promise<void> {
    const pageElement = this.#pageElement(pageNumber)
    const fallback = pageElement.querySelector<HTMLElement>(
      ".iread-pdf__page-error",
    )
    const fallbackText = pageElement.querySelector<HTMLElement>(
      ".iread-pdf__page-error-text",
    )
    pageElement.dataset.state = "rendering"
    if (fallback !== null) {
      fallback.hidden = true
    }
    try {
      const page = await this.#getPage(pageNumber)
      if (token !== this.#renderTokens.get(pageNumber)) {
        return
      }
      const totalRotation = normalizeRotation(page.rotate + this.#userRotation)
      const metrics: PdfPageMetrics = {
        width: 0,
        height: 0,
        pageRotation: page.rotate,
        totalRotation,
      }
      const baseViewport = page.getViewport({ scale: 1, rotation: totalRotation })
      metrics.width = baseViewport.width
      metrics.height = baseViewport.height
      this.#pageMetrics.set(pageNumber, metrics)
      const scale = this.#scaleFor(metrics)
      this.#updatePageElementSize(pageNumber)
      const viewport = page.getViewport({
        scale,
        rotation: totalRotation,
      })

      const canvas = pageElement.querySelector<HTMLCanvasElement>("canvas")
      if (canvas === null) {
        return
      }
      const outputScale = this.#outputScale(viewport)
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
      const context = canvas.getContext("2d", { alpha: false })
      if (context === null) {
        throw new Error("无法创建 Canvas 2D 上下文。")
      }
      context.save()
      context.fillStyle = "white"
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.restore()

      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform:
          outputScale === 1
            ? undefined
            : [outputScale, 0, 0, outputScale, 0, 0],
        background: "white",
      })
      const record: RenderedPage = {
        scaleKey: key,
        page,
        textLayer: null,
        annotationLayer: null,
        renderTask,
        cacheKey: null,
      }
      this.#rendered.set(pageNumber, record)
      await renderTask.promise
      if (
        token !== this.#renderTokens.get(pageNumber) ||
        !this.#renderWindow.has(pageNumber) && this.#view.layoutMode === "single"
      ) {
        if (this.#rendered.get(pageNumber) === record) {
          this.#disposeRendered(pageNumber)
        }
        return
      }

      const textContainer = pageElement.querySelector<HTMLElement>(".textLayer")
      if (textContainer !== null) {
        textContainer.replaceChildren()
        try {
          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent({
              includeMarkedContent: true,
            }),
            container: textContainer,
            viewport,
          })
          record.textLayer = textLayer
          await textLayer.render()
        } catch (error) {
          if (!isAbortError(error) && !isRenderingCancelled(error)) {
            textContainer.replaceChildren()
          }
        }
      }
      if (token !== this.#renderTokens.get(pageNumber)) {
        return
      }

      const annotationContainer =
        pageElement.querySelector<HTMLElement>(".annotationLayer")
      if (annotationContainer !== null) {
        annotationContainer.replaceChildren()
        try {
          const annotations = await page.getAnnotations({ intent: "display" })
          if (token === this.#renderTokens.get(pageNumber)) {
            const annotationLayer = new AnnotationLayer({
              div: annotationContainer,
              accessibilityManager: undefined,
              annotationCanvasMap: undefined,
              annotationEditorUIManager: undefined,
              page,
              viewport,
              structTreeLayer: undefined,
              commentManager: undefined,
              linkService: this.#linkService() as never,
              annotationStorage: undefined,
            } as never)
            record.annotationLayer = annotationLayer
            await annotationLayer.render({
              viewport,
              div: annotationContainer as HTMLDivElement,
              annotations,
              page,
              linkService: this.#linkService() as never,
              renderForms: false,
              enableScripting: false,
              enableAnnotationEditing: false,
            })
          }
        } catch {
          annotationContainer.replaceChildren()
        }
      }
      if (token !== this.#renderTokens.get(pageNumber)) {
        return
      }
      pageElement.dataset.state = "ready"
      this.#applySearchHighlightsToPage(pageNumber)
      this.#currentScaleForZoom = scale
      this.#updateZoomIndicator()
      const cache = this.#cache
      const manifest = this.#manifest
      if (cache !== null && manifest !== null) {
        const cacheKey = this.#renderCacheKey(pageNumber, key)
        record.cacheKey = cacheKey
        cache.render.register(
          cacheKey,
          { pageNumber },
          {
            bytes: Math.max(
              1,
              canvas.width * canvas.height * 4 + 4_096,
            ),
            kind: "pdf-page",
            protectMs: cache.budget.departureProtectionMs,
            release: () => {
              if (this.#rendered.get(pageNumber) === record) {
                this.#disposeRendered(pageNumber, true)
              }
            },
          },
        )
      }
    } catch (error) {
      if (
        isAbortError(error) ||
        isRenderingCancelled(error) ||
        token !== this.#renderTokens.get(pageNumber)
      ) {
        return
      }
      this.#disposeRendered(pageNumber)
      pageElement.dataset.state = "error"
      if (fallbackText !== null) {
        fallbackText.textContent = `第 ${pageNumber} 页暂时无法显示；其余页面仍可继续阅读。`
      }
      if (fallback !== null) {
        fallback.hidden = false
      }
    }
  }

  #outputScale(viewport: PageViewport): number {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const pixels = viewport.width * viewport.height * dpr * dpr
    if (pixels <= MAX_CANVAS_PIXELS) {
      return dpr
    }
    return clamp(
      Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
      0.1,
      dpr,
    )
  }

  #disposeRendered(pageNumber: number, skipRenderCache = false): void {
    const record = this.#rendered.get(pageNumber)
    if (record === undefined) {
      return
    }
    this.#rendered.delete(pageNumber)
    const cacheKey = record.cacheKey
    record.cacheKey = null
    if (!skipRenderCache && cacheKey !== null) {
      this.#cache?.render.release(cacheKey)
    }
    try {
      record.renderTask?.cancel()
    } catch {
      // 已完成或已取消的 RenderTask 再次取消可能抛错。
    }
    try {
      record.textLayer?.cancel()
    } catch {
      // TextLayer 已取消。
    }
    try {
      record.annotationLayer?.destroy()
    } catch {
      // 注释层可能已销毁。
    }
    const element = this.#pageElements.get(pageNumber)
    if (element !== undefined) {
      const canvas = element.querySelector<HTMLCanvasElement>("canvas")
      if (canvas !== null) {
        canvas.width = 0
        canvas.height = 0
      }
      const text = element.querySelector<HTMLElement>(".textLayer")
      text?.replaceChildren()
      const annotation = element.querySelector<HTMLElement>(".annotationLayer")
      annotation?.replaceChildren()
      if (element.dataset.state !== "error") {
        element.dataset.state = "idle"
      }
    }
    if (this.#searchController === null) {
      try {
        record.page.cleanup()
      } catch {
        // 页面已清理。
      }
    }
  }

  #disposeOutsideWindow(): void {
    for (const pageNumber of [...this.#rendered.keys()]) {
      if (!this.#renderWindow.has(pageNumber)) {
        this.#disposeRendered(pageNumber)
      }
    }
  }

  #disposeAllRenders(): void {
    for (const pageNumber of [...this.#rendered.keys()]) {
      this.#disposeRendered(pageNumber)
    }
    this.#renderPromises.clear()
    this.#renderTokens.clear()
    this.#renderWindow.clear()
  }

  // 内部：目录、链接与位置

  #linkService(): {
    eventBus?: undefined
    addLinkAttributes: (link: HTMLAnchorElement, url: string, newWindow?: boolean) => void
    getDestinationHash: (destination: unknown) => string
    goToDestination: (destination: unknown) => void
    getAnchorUrl: (hash: string) => string
    executeNamedAction: (action: string) => void
    getAttachmentContent: (id: string) => Promise<null>
    executeSetOCGState: () => void
  } {
    return {
      eventBus: undefined,
      addLinkAttributes: (link, url, newWindow) => {
        const safe = safeExternalUrl(url)
        if (safe === null) {
          link.href = "#"
          link.addEventListener("click", (event) => {
            event.preventDefault()
          })
          return
        }
        link.href = safe
        if (newWindow === true) {
          link.target = "_blank"
          link.rel = "noopener noreferrer"
        }
      },
      getDestinationHash: (destination) => {
        return this.#destinationHashes.get(safeJsonKey(destination)) ?? "#page=1"
      },
      goToDestination: (destination) => {
        void this.#goToDestination(destination)
      },
      getAnchorUrl: (hash) => (hash.startsWith("#") ? hash : `#${hash}`),
      executeNamedAction: (action) => {
        this.#executeNamedAction(action)
      },
      getAttachmentContent: async () => null,
      executeSetOCGState: () => {
        // 不执行可选内容组脚本。
      },
    }
  }

  async #destinationPage(destination: unknown): Promise<number | null> {
    const pdf = this.#pdf
    if (pdf === null) {
      return null
    }
    try {
      let dest = destination
      if (typeof dest === "string") {
        dest = await pdf.getDestination(dest)
      }
      if (!Array.isArray(dest) || dest.length === 0) {
        return null
      }
      const ref = dest[0]
      if (!isRecord(ref) || typeof ref.num !== "number" || typeof ref.gen !== "number") {
        return null
      }
      const index = await pdf.getPageIndex(ref as unknown as DestinationRef)
      if (!Number.isSafeInteger(index) || index < 0) {
        return null
      }
      return index + 1
    } catch {
      return null
    }
  }

  async #goToDestination(destination: unknown): Promise<void> {
    const page = await this.#destinationPage(destination)
    if (page === null) {
      this.#showNotice("这个 PDF 链接没有可用的内部页码。")
      return
    }
    this.#destinationHashes.set(safeJsonKey(destination), `#page=${page}`)
    if (page < 1 || page > this.#pageCount) {
      this.#showNotice("这个 PDF 链接指向的页面不存在。")
      return
    }
    await this.#goToPage(page, 0, false)
  }

  #executeNamedAction(action: string): void {
    switch (action) {
      case "FirstPage":
        void this.#goToPage(1, 0, false)
        break
      case "LastPage":
        void this.#goToPage(this.#pageCount, 0, false)
        break
      case "NextPage":
        void this.advance("next")
        break
      case "PrevPage":
        void this.advance("previous")
        break
      default:
        break
    }
  }

  // 内部：搜索 UI 与高亮

  #openSearchPanel(): void {
    const panel = this.#searchPanel
    if (panel === null) {
      return
    }
    if (this.#outlinePanel !== null) {
      this.#closeOutlinePanel()
    }
    panel.hidden = false
    this.#searchInput?.focus()
    this.#searchInput?.select()
  }

  #toggleSearchPanel(): void {
    const panel = this.#searchPanel
    if (panel === null) {
      return
    }
    if (panel.hidden) {
      this.#openSearchPanel()
    } else {
      panel.hidden = true
      this.clearSearch()
    }
  }

  async #runSearchFromUi(): Promise<void> {
    const query = this.#searchInput?.value ?? ""
    const matches = await this.search(query)
    if (matches.length > 0) {
      await this.#activateSearchResult(0)
    }
  }

  #setSearchStatus(text: string): void {
    if (this.#searchStatus !== null) {
      this.#searchStatus.textContent = text
    }
  }

  #renderSearchResults(): void {
    const list = this.#searchResults
    if (list === null) {
      return
    }
    list.replaceChildren()
    for (let index = 0; index < this.#searchMatches.length; index += 1) {
      const match = this.#searchMatches[index]
      const item = createElement("li", "iread-pdf__search-result")
      const button = createButton(
        `跳转到搜索结果：第 ${match.page} 页`,
        `第 ${match.page} 页 · ${match.snippet}`,
        "iread-pdf__search-result-button",
      )
      button.dataset.resultIndex = String(index)
      button.addEventListener("click", () => {
        void this.#activateSearchResult(index)
      })
      if (index === this.#activeSearchIndex) {
        button.dataset.active = "true"
      }
      item.append(button)
      list.append(item)
    }
  }

  async activateSearchMatch(index: number): Promise<number> {
    if (!this.#searchMatches.length) return -1
    const sequence = this.#searchSeq
    const wrapped = ((index % this.#searchMatches.length) + this.#searchMatches.length) % this.#searchMatches.length
    this.#activeSearchIndex = wrapped
    this.#renderSearchResults()
    const match = this.#searchMatches[wrapped]
    const epoch = ++this.#navigationEpoch
    this.#searchNavigationEpoch = epoch
    await this.#goToPage(match.page, 0, false, epoch)
    if (sequence !== this.#searchSeq || this.#activeSearchIndex !== wrapped || epoch !== this.#navigationEpoch) return -1
    await this.#renderPage(match.page)
    if (sequence !== this.#searchSeq || this.#activeSearchIndex !== wrapped || epoch !== this.#navigationEpoch) return -1
    this.#applySearchHighlights()
    const mark = this.#pageElements.get(match.page)?.querySelector<HTMLElement>(`[data-pdf-search-hits~="${wrapped}"]`)
    mark?.scrollIntoView({ block: "center", inline: "nearest" })
    this.#emitLocation()
    if (this.#searchNavigationEpoch === epoch) this.#searchNavigationEpoch = null
    return wrapped
  }

  async #activateSearchResult(index: number): Promise<void> { await this.activateSearchMatch(index) }

  #applySearchHighlights(): void {
    for (const pageNumber of this.#rendered.keys()) this.#applySearchHighlightsToPage(pageNumber)
  }

  #applySearchHighlightsToPage(pageNumber: number): void {
    const layer = this.#rendered.get(pageNumber)?.textLayer
    if (!layer) return
    const ranges = new Map<number, Array<{ start: number; end: number; hit: number }>>()
    this.#searchMatches.forEach((match, hit) => {
      if (match.page !== pageNumber) return
      for (const segment of match.segments ?? [match]) {
        const entries = ranges.get(segment.itemIndex) ?? []
        entries.push({ start: segment.start, end: segment.end, hit }); ranges.set(segment.itemIndex, entries)
      }
    })
    layer.textDivs.forEach((span, itemIndex) => {
      const source = layer.textContentItemsStr[itemIndex] ?? ""
      const entries = ranges.get(itemIndex) ?? []
      const boundaries = [...new Set([0, source.length, ...entries.flatMap(entry => [entry.start, entry.end])])].sort((a, b) => a - b)
      const fragment = document.createDocumentFragment()
      for (let n = 0; n < boundaries.length - 1; n++) {
        const start = boundaries[n], end = boundaries[n + 1]
        const hits = entries.filter(entry => entry.start < end && entry.end > start).map(entry => entry.hit)
        if (!hits.length) fragment.append(document.createTextNode(source.slice(start, end)))
        else {
          const mark = document.createElement("mark")
          mark.className = "iread-pdf__text-hit"
          mark.dataset.pdfSearchHits = hits.join(" ")
          if (hits.includes(this.#activeSearchIndex)) mark.dataset.active = "true"
          mark.textContent = source.slice(start, end); fragment.append(mark)
        }
      }
      span.replaceChildren(fragment)
    })
  }

  #clearSearchHighlights(): void {
    for (const rendered of this.#rendered.values()) {
      const layer = rendered.textLayer
      if (layer) layer.textDivs.forEach((span, index) => { span.textContent = layer.textContentItemsStr[index] ?? "" })
    }
  }

  // 内部：内置目录 UI

  async #toggleOutlinePanel(): Promise<void> {
    const panel = this.#outlinePanel
    if (panel === null) {
      return
    }
    if (!panel.hidden) {
      this.#closeOutlinePanel()
      return
    }
    if (this.#searchPanel !== null) {
      this.#searchPanel.hidden = true
    }
    panel.hidden = false
    // 面板内容可能已经由上一次打开渲染；直接复用，不能停留在
    // “正在读取目录…”的占位状态（Shell 预加载只缓存结果，不负责渲染面板）。
    if (this.#outlineRendered) {
      return
    }
    const mountId = this.#mountId
    const controller = new AbortController()
    this.#outlineRequest?.abort()
    this.#outlineRequest = controller
    this.#setOutlineState("loading", "正在读取目录…")
    let entries: PdfOutlineEntry[] = []
    let failed = false
    try {
      entries = await this.getOutline({ signal: controller.signal })
    } catch {
      if (controller.signal.aborted) {
        return
      }
      failed = true
    } finally {
      if (this.#outlineRequest === controller) {
        this.#outlineRequest = null
      }
    }
    // 迟到响应不得覆盖已关闭的面板或新文档。
    if (
      controller.signal.aborted ||
      mountId !== this.#mountId ||
      panel.hidden
    ) {
      return
    }
    this.#renderOutline(entries)
    if (failed) {
      // 失败与“没有目录”使用同一句提示，但保留状态标记便于诊断/测试。
      panel.dataset.outlineState = "error"
    }
    // 失败时不锁定，重新打开面板可以再试一次。
    this.#outlineRendered = !failed
  }

  #closeOutlinePanel(): void {
    if (this.#outlinePanel !== null) {
      this.#outlinePanel.hidden = true
    }
    this.#outlineRequest?.abort()
    this.#outlineRequest = null
  }

  #setOutlineState(
    state: "idle" | "loading" | "ready" | "empty" | "error",
    text?: string,
  ): void {
    if (this.#outlinePanel !== null) {
      this.#outlinePanel.dataset.outlineState = state
    }
    if (this.#outlineStatus !== null && text !== undefined) {
      this.#outlineStatus.textContent = text
    }
  }

  #renderOutline(entries: PdfOutlineEntry[]): void {
    const list = this.#outlineList
    if (list === null) {
      return
    }
    list.replaceChildren()
    if (entries.length === 0) {
      this.#setOutlineState("empty", "这份 PDF 没有内置目录。")
      return
    }
    this.#setOutlineState(
      "ready",
      `共 ${countOutlineEntries(entries)} 个目录项。`,
    )
    const renderLevel = (
      values: PdfOutlineEntry[],
      container: HTMLElement,
    ): void => {
      for (const entry of values) {
        const row = createElement("div", "iread-pdf__outline-item")
        row.dataset.level = String(entry.level)
        if (entry.page !== null) {
          const button = createButton(
            `跳转到目录：${entry.title}`,
            entry.title,
            "iread-pdf__outline-button",
          )
          button.addEventListener("click", () => {
            void this.#goToPage(entry.page ?? 1, 0, false)
          })
          row.append(button)
        } else {
          const label = createElement(
            "span",
            "iread-pdf__outline-label",
            entry.title,
          )
          row.append(label)
        }
        if (entry.url !== null) {
          const safe = safeExternalUrl(entry.url)
          if (safe !== null) {
            const link = createElement("a", "iread-pdf__outline-link", "外部链接")
            link.href = safe
            link.target = "_blank"
            link.rel = "noopener noreferrer"
            row.append(link)
          }
        }
        container.append(row)
        if (entry.children.length > 0) {
          const childContainer = createElement("div", "iread-pdf__outline-children")
          renderLevel(entry.children, childContainer)
          container.append(childContainer)
        }
      }
    }
    renderLevel(entries, list)
  }

  // 内部：状态与指示器

  #updateIndicator(): void {
    const page = Math.max(1, this.#currentPage)
    const count = this.#pageCount
    if (this.#pageIndicator !== null) {
      this.#pageIndicator.textContent =
        count > 0 ? formatPageText(page, count) : "1 / –"
      this.#pageIndicator.dataset.pdfPage = String(page)
      this.#pageIndicator.dataset.pdfPageCount = String(count)
    }
    if (this.#root !== null) {
      this.#root.dataset.pdfPage = String(page)
      this.#root.dataset.pdfPageCount = String(count)
    }
  }

  #updateZoomIndicator(): void {
    const scale =
      this.#displaySizes.get(this.#currentPage)?.scale ?? this.#currentScaleForZoom
    const percent = Math.round(scale * 100)
    if (this.#zoomIndicator !== null) {
      this.#zoomIndicator.textContent = `${percent}%`
    }
    if (this.#root !== null) {
      this.#root.dataset.pdfScale = scale.toFixed(4)
    }
  }

  async #stepManualScale(factor: number): Promise<void> {
    if (this.#pdf === null) {
      return
    }
    const current =
      this.#displaySizes.get(this.#currentPage)?.scale ??
      this.#currentScaleForZoom
    const next = clamp(
      current * factor,
      PDF_MIN_SCALE,
      PDF_MAX_SCALE,
    )
    await this.setManualScale(next)
  }

  #showNotice(message: string): void {
    if (this.#notice === null) {
      return
    }
    this.#notice.textContent = message
    if (this.#noticeTimer !== null) {
      window.clearTimeout(this.#noticeTimer)
    }
    this.#noticeTimer = window.setTimeout(() => {
      if (this.#notice !== null) {
        this.#notice.textContent = ""
      }
      this.#noticeTimer = null
    }, NOTICE_TIMEOUT_MS)
  }

  #relativeViewportForPage(pageNumber: number): PdfRelativeViewport | null {
    const viewport = this.#viewport
    if (viewport === null || this.#pdf === null) {
      return null
    }
    const viewportSize = this.#viewportContentSize()
    const display = this.#displaySizes.get(pageNumber)
    if (display === undefined) {
      return null
    }
    let pageLeft: number
    let pageTop: number
    if (this.#view.layoutMode === "single") {
      pageLeft = Math.max(0, (viewportSize.width - display.width) / 2)
      pageTop = 0
    } else if (this.#view.layoutMode === "continuous") {
      pageLeft = Math.max(0, (viewportSize.width - display.width) / 2)
      const offset = this.#layoutOffsets[pageNumber - 1]
      pageTop = offset?.start ?? 0
    } else {
      const offset = this.#layoutOffsets[pageNumber - 1]
      pageLeft = offset?.start ?? 0
      pageTop = Math.max(0, (viewportSize.height - display.height) / 2)
    }
    return relativeViewport(
      pageLeft,
      pageTop,
      display.width,
      display.height,
      viewport.scrollLeft,
      viewport.scrollTop,
      viewportSize.width,
      viewportSize.height,
    )
  }

  #emitLocation(): void {
    if (this.#pdf === null || this.#pageCount < 1) {
      return
    }
    const anchor = this.#captureAnchor()
    const relative = this.#relativeViewportForPage(anchor.page)
    const location = pdfLocation(
      anchor.page,
      anchor.pageOffset,
      this.#pageCount,
      relative,
      this.#view,
    )
    const payload = location.locatorPayload as PdfPageLocatorPayload
    if (this.#root !== null) {
      this.#root.dataset.pdfPageOffset = payload.pageOffset.toFixed(4)
      this.#root.dataset.pdfRelativeViewport = JSON.stringify(
        payload.relativeViewport,
      )
      this.#root.dataset.pdfView = JSON.stringify(payload.view)
    }
    const key = `${payload.page}:${Math.round(
      payload.pageOffset * 10_000,
    )}:${payload.view?.layoutMode}:${
      payload.view?.zoomMode
    }:${this.#view.manualScale}`
    if (key === this.#lastEmittedKey) {
      return
    }
    this.#lastEmittedKey = key
    for (const listener of this.#listeners) {
      listener(location)
    }
  }
}

export function createPdfReaderEngine(
  options: PdfReaderEngineOptions = {},
): PdfReaderEngine {
  return new PdfReaderEngine(options)
}
