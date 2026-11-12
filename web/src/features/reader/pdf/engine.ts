import "./pdfjs-compat"
import {
  AnnotationLayer,
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  getDocument,
  version as PDFJS_VERSION,
} from "pdfjs-dist/legacy/build/pdf.mjs"
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist"
import { findPdfPageMatches, PDF_SEARCH_LIMIT as SEARCH_LIMIT, type PdfSearchMatch } from "./search-model"
export type { PdfSearchMatch } from "./search-model"
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import workerCompatSrc from "./pdf.worker.compat.mjs?url&no-inline"

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
  type PdfNetworkRequest,
  type PdfNetworkStats,
} from "./range"
import {
  buildPdfDiagnosticsText,
  isPdfWasmAvailable,
  pdfLoadErrorTitle,
  sanitizePdfErrorMessage,
  sanitizePdfErrorDetail,
  toPdfLoadError,
} from "./load-error"
import { pdfPageKey, renderKeyId } from "../cache/resource-key"
import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"
import {
  CanvasPixelBudget,
  DESKTOP_CANVAS_PIXEL_BUDGET,
  MOBILE_CANVAS_PIXEL_BUDGET,
} from "./canvas-budget"
import {
  computePdfRenderWindow,
  pdfPrefetchWindowFor,
  type PdfRenderWindow,
} from "./render-window"
import {
  PdfOutlineTimeoutError,
  buildPdfOutline,
  withPdfOutlineDeadline,
  type PdfOutlineEntry,
} from "./outline"
import { PdfOpenWatchdog } from "./open-watchdog"

const PDFJS_ASSET_ROOT = `${import.meta.env.BASE_URL}pdfjs/`
const PDFJS_ENGINE_MODE = "legacy"
/**
 * 真实 worker 与 fake worker 都走同一个兼容入口；query 指向 Vite 产出的
 * 带 hash worker 模块，兼容脚本负责在 worker 全局补 withResolvers/try。
 * 兼容入口本身也由 Vite 输出到 /assets，避免反向代理只放行 /assets 时失效。
 */
const PDFJS_WORKER_COMPAT_URL = new URL(workerCompatSrc, import.meta.url)
PDFJS_WORKER_COMPAT_URL.searchParams.set(
  "src",
  new URL(workerSrc, import.meta.url).href,
)
const PDFJS_WORKER_SRC = PDFJS_WORKER_COMPAT_URL.href

GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC
const MAX_CANVAS_PIXELS = 8_000_000
/** 打开 PDF 的绝对上限；真正判断卡死的是下面的停滞看门狗。 */
const OPEN_TIMEOUT_MS = 120_000
/** 连续多久没有新的已读取字节就判定打开停滞。 */
const OPEN_STALL_TIMEOUT_MS = 15_000
const MOBILE_RENDER_CONCURRENCY = 1
const DESKTOP_RENDER_CONCURRENCY = 2
/** 停止滚动后等待多久再安排空闲预取。 */
const IDLE_PREFETCH_DELAY_MS = 150
/** 空闲预取在常规窗口之外额外向前看的页数。 */
const IDLE_PREFETCH_EXTRA_MOBILE = 3
const IDLE_PREFETCH_EXTRA_DESKTOP = 6
const DEFAULT_PAGE_WIDTH = 612
const DEFAULT_PAGE_HEIGHT = 792
const NOTICE_TIMEOUT_MS = 4_000
/** 用户滚动停止后等待多久才允许一次锚定校正。 */
const USER_SCROLL_SETTLE_MS = 150
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

export interface PdfMountOptions {
  /**
   * Shell 已按 profile/全局/旧进度解析出的首帧视图。引擎不再自行读取
   * 设置接口，避免先 fit-width 再恢复造成闪烁与页码回退。
   */
  initialView?: Partial<PdfViewSettings> | undefined
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
  canvasReady: boolean
  pixels: number
  lastUsed: number
}

interface RenderPromiseEntry {
  scaleKey: string
  promise: Promise<void>
  token: number
  resolve: () => void
}

type RenderPriority = "visible" | "prefetch"

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

/** 优先 Clipboard API；远程桌面/非 HTTPS 环境下回退到隐藏 textarea。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被策略拒绝时继续走 execCommand 回退。
  }
  try {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "true")
    area.style.position = "fixed"
    area.style.top = "0"
    area.style.left = "0"
    area.style.width = "1px"
    area.style.height = "1px"
    area.style.opacity = "0"
    document.body.append(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    return copied
  } catch {
    return false
  }
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
 * 生命周期与共享 shell 的 ReaderEngine 对齐；页面、加载/错误层、搜索
 * 命中与内置目录解析留在本模块内，工具栏与面板统一由 shell 负责。
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
  #loading: HTMLDivElement | null = null
  #loadingText: HTMLParagraphElement | null = null
  #errorOverlay: HTMLDivElement | null = null
  #errorTitle: HTMLHeadingElement | null = null
  #errorMessage: HTMLParagraphElement | null = null
  #errorDetail: HTMLParagraphElement | null = null
  #errorCopy: HTMLButtonElement | null = null
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
  /** 目录解析的取消边界，卸载/超时/切换文档时中止。 */
  #outlineAbort: AbortController | null = null
  #sourceUrl: URL | null = null
  #pageCache = new Map<number, PDFPageProxy>()
  #pageElements = new Map<number, HTMLElement>()
  #pageMetrics = new Map<number, PdfPageMetrics>()
  #displaySizes = new Map<number, DisplaySize>()
  #layoutOffsets: { start: number; size: number }[] = []
  #rendered = new Map<number, RenderedPage>()
  #renderPromises = new Map<number, RenderPromiseEntry>()
  #renderTokens = new Map<number, number>()
  #renderTokenSeq = 0
  #renderUseSeq = 0
  #renderQueue: Array<{ pageNumber: number; priority: RenderPriority }> = []
  #activeRenders = new Map<
    number,
    { priority: RenderPriority; token: number }
  >()
  #renderWindow = new Set<number>()
  #visiblePages: number[] = []
  #canvasBudget = new CanvasPixelBudget(DESKTOP_CANVAS_PIXEL_BUDGET)
  #canvasBudgetCoarse: boolean | null = null
  #layoutOffsetsFrame: number | null = null
  #layoutOffsetsDirty = false
  #pendingLayoutAnchor: PdfAnchor | null = null
  #lastUserScrollAt = Number.NEGATIVE_INFINITY
  #userScrollSettleTimer: number | null = null
  #userScrollAnchor: PdfAnchor | null = null
  #deferResizeForScroll = false
  #viewChangeInFlight = false
  #idlePrefetchTimer: number | null = null
  #idlePrefetchHandle: number | null = null
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
  #pinchActive = false
  #pinchBaseScale = 1
  #pinchPreviewFactor = 1
  #pinchOriginX = 0
  #pinchOriginY = 0
  #pinchAnchor: PdfAnchor | null = null
  #pinchLocalX = 0
  #pinchLocalY = 0
  readonly #cache: ReaderCacheRuntime | null

  constructor(options: PdfReaderEngineOptions = {}) {
    this.#options = options
    this.#cache = options.cache ?? null
  }

  async mount(
    host: HTMLElement,
    manifest: ReaderManifest,
    signal: AbortSignal,
    options: PdfMountOptions = {},
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
    this.#view = normalizeView({
      ...DEFAULT_PDF_VIEW,
      ...(options.initialView ?? {}),
    })
    this.#userRotation = 0
    this.#currentPage = 1
    this.#pageCount = 0
    this.#buildDom(host)

    this.#readyPromise = this.#openDocument(contentHref, mountId, signal).catch(
      (error: unknown) => {
        if (mountId !== this.#mountId || signal.aborted || isAbortError(error)) {
          return
        }
        this.#showFatalError(toPdfLoadError(error))
      },
    )
    await this.#readyPromise
  }

  unmount(): void {
    this.#mountId += 1
    this.#navigationEpoch += 1
    this.#clearPinchPreview()
    this.#readyPromise = Promise.resolve()
    this.#cancelFrame()
    this.#cancelIdlePrefetch()
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = null
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
    this.#layoutOffsetsDirty = false
    this.#lastUserScrollAt = Number.NEGATIVE_INFINITY
    this.#userScrollAnchor = null
    this.#pendingLayoutAnchor = null
    this.#viewChangeInFlight = false
    this.#visiblePages = []
    this.#canvasBudgetCoarse = null
    this.#mountedLayout = null
    this.#pageCount = 0
    this.#outlinePromise = null
    this.#outlineAbort?.abort()
    this.#outlineAbort = null
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
    this.#loading = null
    this.#errorOverlay = null
    this.#errorTitle = null
    this.#errorMessage = null
    this.#errorDetail = null
    this.#errorCopy = null
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

  getZoom(): number {
    const base = this.#currentEffectiveScale()
    if (!this.#pinchActive) {
      return base
    }
    return clamp(base * this.#pinchPreviewFactor, PDF_MIN_SCALE, PDF_MAX_SCALE)
  }

  beginPinch(x: number, y: number): void {
    if (this.#pdf === null || this.#pages === null) {
      return
    }
    this.#pinchActive = true
    this.#pinchBaseScale = this.#currentEffectiveScale()
    this.#pinchPreviewFactor = 1
    const rect = this.#pages.getBoundingClientRect()
    this.#pinchOriginX = x - rect.left
    this.#pinchOriginY = y - rect.top
    const viewport = this.#viewport
    if (viewport !== null) {
      const viewportRect = viewport.getBoundingClientRect()
      this.#pinchLocalX = x - viewportRect.left
      this.#pinchLocalY = y - viewportRect.top
      this.#pinchAnchor = this.#anchorAtPoint(
        this.#pinchLocalX,
        this.#pinchLocalY,
      )
    } else {
      this.#pinchAnchor = null
    }
    const pages = this.#pages
    pages.style.transformOrigin = `${this.#pinchOriginX}px ${this.#pinchOriginY}px`
    pages.style.transform = "scale(1)"
    this.#root?.setAttribute("data-pdf-pinching", "")
  }

  updatePinch(scale: number): void {
    const pages = this.#pages
    if (!this.#pinchActive || pages === null || !Number.isFinite(scale)) {
      return
    }
    const base = Math.max(PDF_MIN_SCALE, this.#pinchBaseScale || 1)
    const next = clamp(base * Math.max(0.01, scale), PDF_MIN_SCALE, PDF_MAX_SCALE)
    this.#pinchPreviewFactor = next / base
    pages.style.transform = `scale(${this.#pinchPreviewFactor})`
  }

  endPinch(commit = true): void {
    if (!this.#pinchActive) {
      return
    }
    const next = clamp(
      this.#pinchBaseScale * this.#pinchPreviewFactor,
      PDF_MIN_SCALE,
      PDF_MAX_SCALE,
    )
    const anchor = this.#pinchAnchor
    const localX = this.#pinchLocalX
    const localY = this.#pinchLocalY
    this.#clearPinchPreview()
    if (commit) {
      void this.setView({ zoomMode: "manual", manualScale: next }).then(() => {
        this.#restorePinchScroll(anchor, localX, localY)
      })
    }
    this.#pinchAnchor = null
  }

  resetZoom(): void {
    this.#clearPinchPreview()
    void this.setView({ zoomMode: "manual", manualScale: 1 })
  }

  #currentEffectiveScale(): number {
    const display = this.#displaySizes.get(this.#currentPage)
    if (display !== undefined && Number.isFinite(display.scale) && display.scale > 0) {
      return display.scale
    }
    return this.#currentScaleForZoom > 0 ? this.#currentScaleForZoom : 1
  }

  #clearPinchPreview(): void {
    const pages = this.#pages
    if (pages !== null) {
      pages.style.transform = ""
      pages.style.transformOrigin = ""
    }
    this.#root?.removeAttribute("data-pdf-pinching")
    this.#pinchActive = false
    this.#pinchPreviewFactor = 1
    this.#pinchBaseScale = this.#currentEffectiveScale()
  }

  #anchorAtPoint(localX: number, localY: number): PdfAnchor | null {
    const viewport = this.#viewport
    if (viewport === null) {
      return null
    }
    if (this.#view.layoutMode === "single") {
      const display = this.#displaySizes.get(this.#currentPage)
      if (display === undefined || display.height <= 0) {
        return null
      }
      return {
        page: clamp(this.#currentPage, 1, this.#pageCount),
        pageOffset: clamp(
          (viewport.scrollTop + localY) / display.height,
          0,
          1,
        ),
      }
    }
    const horizontal = this.#view.layoutMode === "horizontal"
    const point =
      (horizontal ? viewport.scrollLeft : viewport.scrollTop) +
      (horizontal ? localX : localY)
    for (let index = 0; index < this.#layoutOffsets.length; index += 1) {
      const entry = this.#layoutOffsets[index]
      if (entry === undefined) {
        continue
      }
      if (point < entry.start + entry.size || index === this.#layoutOffsets.length - 1) {
        if (entry.size <= 0) {
          return null
        }
        return {
          page: index + 1,
          pageOffset: clamp((point - entry.start) / entry.size, 0, 1),
        }
      }
    }
    return null
  }

  #restorePinchScroll(
    anchor: PdfAnchor | null,
    localX: number,
    localY: number,
  ): void {
    const viewport = this.#viewport
    if (anchor === null || viewport === null) {
      return
    }
    const page = clamp(Math.floor(anchor.page), 1, this.#pageCount)
    const offset = clamp(anchor.pageOffset, 0, 1)
    if (this.#view.layoutMode === "single") {
      const display = this.#displaySizes.get(page)
      if (display === undefined || display.height <= 0) {
        return
      }
      viewport.scrollTop = Math.max(0, display.height * offset - localY)
      viewport.scrollLeft = 0
      this.#currentPage = page
      return
    }
    const entry = this.#layoutOffsets[page - 1]
    if (entry === undefined || entry.size <= 0) {
      return
    }
    if (this.#view.layoutMode === "horizontal") {
      viewport.scrollLeft = Math.max(0, entry.start + entry.size * offset - localX)
    } else {
      viewport.scrollTop = Math.max(0, entry.start + entry.size * offset - localY)
    }
    this.#currentPage = page
    this.#emitLocation()
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
    this.#clearPinchPreview()
    const previous = this.#view
    const next = normalizeView({ ...this.#view, ...patch })
    const layoutChanged = next.layoutMode !== previous.layoutMode
    const scaleChanged =
      next.zoomMode !== previous.zoomMode ||
      (next.zoomMode === "manual" && next.manualScale !== previous.manualScale) ||
      next.layoutMode !== previous.layoutMode
    const gapChanged = next.gap !== previous.gap
    const epoch = ++this.#navigationEpoch
    const anchor = layoutChanged
      ? {
          // 布局切换以当前页属性为准。连续/横向滚动 rAF 可能尚未把
          // 已滚到的页写回 scroll 坐标，直接用 scroll 推断会退回相邻页。
          page: clamp(this.#currentPage, 1, Math.max(1, this.#pageCount)),
          pageOffset: this.#pageOffsetFor(
            clamp(this.#currentPage, 1, Math.max(1, this.#pageCount)),
          ),
        }
      : this.#captureAnchor()
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
    this.#viewChangeInFlight = true
    try {
      await this.#reflow(anchor, epoch)
    } finally {
      this.#viewChangeInFlight = false
      if (this.#deferResizeForScroll) {
        this.#deferResizeForScroll = false
        this.#scheduleResize()
      }
    }
  }

  async rotate(degrees = 90): Promise<void> {
    if (this.#pdf === null) {
      return
    }
    this.#clearPinchPreview()
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
    this.#viewChangeInFlight = true
    try {
      await this.#reflow(anchor, epoch)
    } finally {
      this.#viewChangeInFlight = false
      if (this.#deferResizeForScroll) {
        this.#deferResizeForScroll = false
        this.#scheduleResize()
      }
    }
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
        if (!this.#rendered.has(pageNumber) && !this.#renderPromises.has(pageNumber)) page.cleanup()
        if (matches.length >= SEARCH_LIMIT) break
      }
      if (cancelled()) return []
      this.#searchMatches = matches
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
   * - 结果在同一文档内缓存，Shell 目录面板直接消费，不会重复请求 worker；
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

    const errorOverlay = this.#buildErrorOverlay()
    const notice = createElement("div", "iread-pdf__notice")
    notice.setAttribute("role", "status")
    notice.setAttribute("aria-live", "polite")
    this.#notice = notice

    root.append(viewport, loading, errorOverlay, notice)
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

    const markUserScroll = () => {
      this.#markUserScroll()
    }
    viewport.addEventListener("wheel", markUserScroll, { passive: true })
    viewport.addEventListener("touchstart", markUserScroll, { passive: true })
    viewport.addEventListener("touchmove", markUserScroll, { passive: true })
    viewport.addEventListener("pointerdown", markUserScroll, { passive: true })
    viewport.addEventListener("keydown", markUserScroll)
    viewport.addEventListener(
      "scroll",
      () => {
        if (this.#isUserScrolling()) {
          // 惯性滚动持续期间继续顺延，避免在用户尚未停下时校正。
          this.#lastUserScrollAt = performance.now()
          this.#userScrollAnchor = this.#captureAnchor()
          this.#scheduleUserScrollSettle()
        }
        this.#cancelIdlePrefetch()
        this.#scheduleScrollUpdate()
      },
      { passive: true },
    )

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
    const detail = createElement("p", "iread-pdf__error-detail", "")
    detail.hidden = true
    detail.style.cssText =
      "margin:0;max-width:34rem;font-size:12px;line-height:1.5;opacity:.72;word-break:break-word;"
    const actions = createElement("div", "iread-pdf__error-actions")
    const retry = createButton("重试打开 PDF", "重试", "iread-pdf__button iread-pdf__button--primary")
    retry.addEventListener("click", () => {
      void this.#retryMount()
    })
    const copy = createButton(
      "复制 PDF 诊断信息",
      "复制诊断信息",
      "iread-pdf__button iread-pdf__button--small",
    )
    copy.dataset.pdfCopyDiagnostics = "true"
    copy.addEventListener("click", () => {
      const error = this.#lastError
      if (error === null) {
        return
      }
      const detailText =
        error.detail.length > 0
          ? error.detail
          : sanitizePdfErrorDetail(error.cause ?? error)
      const text = buildPdfDiagnosticsText({
        code: error.code,
        detail: detailText,
        pageCount:
          this.#pageCount > 0
            ? this.#pageCount
            : this.#manifest !== null && isPdfManifest(this.#manifest)
              ? this.#manifest.formatData.pageCount
              : 0,
        bookId: this.#manifest?.bookId ?? "",
        pdfjsVersion: PDFJS_VERSION,
        mode: PDFJS_ENGINE_MODE,
      })
      copy.disabled = true
      void copyTextToClipboard(text).then((copied) => {
        copy.textContent = copied ? "已复制诊断信息" : "复制失败"
        copy.dataset.copyState = copied ? "copied" : "failed"
        window.setTimeout(() => {
          copy.textContent = "复制诊断信息"
          copy.disabled = false
          delete copy.dataset.copyState
        }, 2_000)
      })
    })
    const back = createButton("返回书库", "返回", "iread-pdf__button")
    back.hidden = this.#options.onBack === undefined
    back.addEventListener("click", () => {
      this.#options.onBack?.()
    })
    actions.append(retry, copy, back)
    overlay.append(title, message, detail, actions)
    this.#errorOverlay = overlay
    this.#errorTitle = title
    this.#errorMessage = message
    this.#errorDetail = detail
    this.#errorCopy = copy
    return overlay
  }

  #applyViewAttributes(): void {
    const root = this.#root
    if (root === null) {
      return
    }
    root.dataset.layout = this.#view.layoutMode
    root.dataset.zoom = this.#view.zoomMode
    root.dataset.background = this.#view.background
    root.dataset.gap = this.#view.gap
    const pages = this.#pages
    if (pages !== null) {
      pages.dataset.layout = this.#view.layoutMode
    }
    this.#updateZoomIndicator()
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
        this.#showFatalError(toPdfLoadError(error), true)
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
      // 企业策略/CSP 可能整体移除或禁止编译 WebAssembly。PDF.js 6.5 支持
      // useWasm:false，此时图像解码走 JS 回退；先探测再决定，避免打开到
      // 一半才因 wasm 失败。
      useWasm: isPdfWasmAvailable(),
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
    this.#outlineAbort?.abort()
    this.#outlineAbort = null
    // 先量第 1 页，未测量页直接沿用同一 scale=1 尺寸。这样连续布局
    // 首帧的占位高度与真实 DOM 一致，不会用 612×792 累计出数千像素误差。
    await this.#ensurePageMetrics(1)
    if (mountId !== this.#mountId || signal.aborted) {
      return
    }
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
      delete this.#root.dataset.errorDetail
    }
    if (this.#errorOverlay !== null) {
      this.#errorOverlay.hidden = true
    }
    if (this.#errorDetail !== null) {
      this.#errorDetail.hidden = true
      this.#errorDetail.textContent = ""
    }
    if (this.#errorCopy !== null) {
      this.#errorCopy.disabled = false
      this.#errorCopy.textContent = "复制诊断信息"
      delete this.#errorCopy.dataset.copyState
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
    const rawError = error.cause ?? error
    const detail =
      error.detail.length > 0
        ? error.detail
        : sanitizePdfErrorDetail(rawError)
    if (this.#root !== null) {
      this.#root.dataset.pdfState = "error"
      this.#root.dataset.errorCode = error.code
      if (detail.length > 0) {
        this.#root.dataset.errorDetail = detail
      } else {
        delete this.#root.dataset.errorDetail
      }
    }
    // 保留原始异常名/消息，远程桌面用户无权开 DevTools 时也能复制反馈。
    console.error(
      "[iread-pdf]",
      rawError instanceof Error ? rawError.name : error.name,
      sanitizePdfErrorMessage(rawError),
    )
    if (this.#errorTitle !== null) {
      this.#errorTitle.textContent = pdfLoadErrorTitle(error.code, keepContent)
    }
    if (this.#errorMessage !== null) {
      this.#errorMessage.textContent = error.message
    }
    if (this.#errorDetail !== null) {
      this.#errorDetail.textContent = `技术详情：${detail}`
      this.#errorDetail.hidden = detail.length === 0
    }
    if (this.#errorCopy !== null) {
      this.#errorCopy.disabled = false
      this.#errorCopy.textContent = "复制诊断信息"
      delete this.#errorCopy.dataset.copyState
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
    const initialView = { ...this.#view }
    await this.mount(host, manifest, signal, { initialView })
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
    pageElement.dataset.state = "idle"
    pageElement.setAttribute("aria-label", `第 ${pageNumber} 页`)
    const canvasWrap = createElement("div", "iread-pdf__page-canvas")
    const canvas = createElement("canvas")
    canvas.setAttribute("role", "presentation")
    // 未渲染页不要保留浏览器默认 300×150 的后备存储；857 页会白占约 150MB。
    canvas.width = 0
    canvas.height = 0
    canvasWrap.append(canvas)
    const placeholder = createElement("div", "iread-pdf__page-placeholder")
    placeholder.setAttribute("aria-hidden", "true")
    const placeholderChip = createElement(
      "span",
      "iread-pdf__page-placeholder-chip",
      `第 ${pageNumber} 页 · 待渲染`,
    )
    placeholder.append(placeholderChip)
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
      void this.#renderPage(pageNumber, "visible")
    })
    fallback.append(fallbackText, retry)
    pageElement.append(
      canvasWrap,
      placeholder,
      textLayer,
      annotationLayer,
      fallback,
    )
    this.#pageElements.set(pageNumber, pageElement)
    return pageElement
  }

  /** 更新页面状态与占位层文案；canvas-ready 由绘制完成单独控制。 */
  #setPageState(
    pageNumber: number,
    state: "idle" | "prefetching" | "rendering" | "ready" | "error",
  ): void {
    const element = this.#pageElements.get(pageNumber)
    if (element === undefined) {
      return
    }
    element.dataset.state = state
    if (state === "ready") {
      element.dataset.canvasReady = "true"
    } else if (
      state === "idle" ||
      state === "error" ||
      state === "prefetching"
    ) {
      delete element.dataset.canvasReady
    }
    const chip = element.querySelector<HTMLElement>(
      ".iread-pdf__page-placeholder-chip",
    )
    if (chip !== null) {
      chip.textContent =
        state === "rendering"
          ? `第 ${pageNumber} 页 · 正在渲染…`
          : state === "prefetching"
            ? `第 ${pageNumber} 页 · 预取中…`
            : state === "error"
              ? `第 ${pageNumber} 页 · 无法显示`
              : `第 ${pageNumber} 页 · 待渲染`
    }
  }

  /** canvas 画完就隐藏占位，不等文字层与注释层。 */
  #markCanvasReady(pageNumber: number): void {
    const element = this.#pageElements.get(pageNumber)
    if (element !== undefined) {
      element.dataset.canvasReady = "true"
    }
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
    // 第 1 页在打开时必定已测量；其他页尚未测量时先按同一尺寸占位。
    // 混合尺寸页真实尺寸到达后再更新 offsets，并保留当前锚点。
    if (pageNumber !== 1) {
      const firstPage = this.#pageMetrics.get(1)
      if (firstPage !== undefined) {
        return firstPage
      }
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
    const horizontal = this.#view.layoutMode === "horizontal"
    const pages = this.#pages
    // 视口 padding 也属于滚动坐标；offsets 从页面容器实际起点开始，
    // 跳页后目标页顶部才能与视口顶部对齐。
    let cursor = pages === null ? 0 : horizontal ? pages.offsetLeft : pages.offsetTop
    for (let pageNumber = 1; pageNumber <= this.#pageCount; pageNumber += 1) {
      const display = this.#displaySizes.get(pageNumber)
      const metrics = this.#metricsFor(pageNumber)
      const size = this.#scaleFor(metrics)
      const width = display?.width ?? metrics.width * size
      const height = display?.height ?? metrics.height * size
      const dimension = horizontal ? width : height
      this.#layoutOffsets.push({ start: cursor, size: dimension })
      cursor += dimension + gap
    }
  }

  #isUserScrolling(): boolean {
    return (
      performance.now() - this.#lastUserScrollAt < USER_SCROLL_SETTLE_MS
    )
  }

  #markUserScroll(): void {
    if (this.#pdf === null) {
      return
    }
    this.#lastUserScrollAt = performance.now()
    this.#userScrollAnchor = this.#captureAnchor()
    this.#scheduleUserScrollSettle()
  }

  #scheduleUserScrollSettle(): void {
    if (this.#userScrollSettleTimer !== null) {
      window.clearTimeout(this.#userScrollSettleTimer)
    }
    this.#userScrollSettleTimer = window.setTimeout(() => {
      this.#userScrollSettleTimer = null
      if (this.#pdf === null) {
        return
      }
      if (this.#isUserScrolling()) {
        this.#scheduleUserScrollSettle()
        return
      }
      this.#settleUserScroll()
    }, USER_SCROLL_SETTLE_MS)
  }

  /** 用户停止滚动后最多校正一次；期间不写 scrollTop。 */
  #settleUserScroll(): void {
    const anchor = this.#userScrollAnchor ?? this.#captureAnchor()
    this.#userScrollAnchor = null
    if (this.#layoutOffsetsDirty) {
      this.#computeLayoutOffsets()
      this.#layoutOffsetsDirty = false
      this.#scrollToAnchor(anchor)
    }
    if (this.#deferResizeForScroll) {
      this.#deferResizeForScroll = false
      this.#scheduleResize()
    }
    this.#refreshVisible()
    this.#emitLocation()
  }

  /**
   * 真实页尺寸到达后不必每页同步重算 857 个偏移；合并到下一帧，
   * 并按页内相对位置修正滚动，避免当前阅读位置跳动。
   */
  #scheduleLayoutOffsetsUpdate(): void {
    if (this.#view.layoutMode === "single") {
      return
    }
    this.#layoutOffsetsDirty = true
    if (this.#layoutOffsetsFrame !== null) {
      return
    }
    const mountId = this.#mountId
    this.#layoutOffsetsFrame = window.requestAnimationFrame(() => {
      this.#layoutOffsetsFrame = null
      if (
        mountId !== this.#mountId ||
        this.#pdf === null ||
        this.#viewport === null
      ) {
        return
      }
      const viewport = this.#viewport
      const horizontal = this.#view.layoutMode === "horizontal"
      const pendingAnchor = this.#pendingLayoutAnchor
      this.#pendingLayoutAnchor = null
      const anchorPage = pendingAnchor?.page ?? this.#pageFromScroll()
      const anchorOffset =
        pendingAnchor?.pageOffset ?? this.#pageOffsetFor(anchorPage)
      this.#computeLayoutOffsets()
      if (this.#isUserScrolling()) {
        // 浏览器原生 scroll anchoring 已由 CSS 关闭；这里也绝不在用户
        // 滚动期间写 scrollTop，等停止 150ms 后统一校正一次。
        this.#userScrollAnchor =
          this.#userScrollAnchor ?? {
            page: anchorPage,
            pageOffset: anchorOffset,
          }
        this.#scheduleUserScrollSettle()
      } else {
        const entry = this.#layoutOffsets[anchorPage - 1]
        if (entry !== undefined) {
          const target = Math.max(0, entry.start + entry.size * anchorOffset)
          const current = horizontal ? viewport.scrollLeft : viewport.scrollTop
          if (Math.abs(target - current) > 1) {
            if (horizontal) {
              viewport.scrollLeft = target
            } else {
              viewport.scrollTop = target
            }
          }
        }
        this.#layoutOffsetsDirty = false
      }
      this.#refreshVisible()
      this.#emitLocation()
    })
  }

  #coarsePointer(): boolean {
    if (typeof window === "undefined") {
      return false
    }
    if (typeof window.matchMedia === "function") {
      if (window.matchMedia("(pointer: coarse)").matches) {
        return true
      }
      if (window.matchMedia("(max-width: 767px)").matches) {
        return true
      }
    }
    return false
  }

  #renderConcurrency(): number {
    return this.#coarsePointer()
      ? MOBILE_RENDER_CONCURRENCY
      : DESKTOP_RENDER_CONCURRENCY
  }

  #applyCanvasBudgetTier(coarse: boolean): void {
    if (this.#canvasBudgetCoarse === coarse) {
      return
    }
    this.#canvasBudgetCoarse = coarse
    this.#canvasBudget.setMaxPixels(
      coarse ? MOBILE_CANVAS_PIXEL_BUDGET : DESKTOP_CANVAS_PIXEL_BUDGET,
    )
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
    // 横向与连续布局都用视口起点所在页作为当前页。用视口中点判断会
    // 在连续→横向切换后把相邻页误当当前页，破坏“切换布局不翻页”。
    const target = scroll + 1
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
    // 显式初始化/跳页/布局切换优先于此前为尺寸变化排队的自动锚点，
    // 避免迟到的旧页 render 把刚跳到的页拉回。
    this.#pendingLayoutAnchor = null
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
    // 不在重排开始时丢弃所有已渲染页：滚动/缩放期间保留现有 canvas，
    // 仅由 #refreshVisible 按新 scaleKey 替换失效页，避免整屏闪烁。
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
      if (this.#isUserScrolling()) {
        // visualViewport 在滚动中也会触发尺寸通知；滚动期间不做全量重排，
        // 等用户停下后再按锚点恢复一次。
        this.#deferResizeForScroll = true
        this.#scheduleUserScrollSettle()
        return
      }
      if (this.#viewChangeInFlight) {
        // 布局/缩放切换尚未完成时，resize 不能按新布局读取旧 scrollLeft，
        // 否则横向页会误判成第 1 页；等切换完成后再重排。
        this.#deferResizeForScroll = true
        return
      }
      this.#clearPinchPreview()
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
    if (this.#layoutOffsetsFrame !== null) {
      window.cancelAnimationFrame(this.#layoutOffsetsFrame)
      this.#layoutOffsetsFrame = null
    }
    if (this.#userScrollSettleTimer !== null) {
      window.clearTimeout(this.#userScrollSettleTimer)
      this.#userScrollSettleTimer = null
    }
    this.#userScrollAnchor = null
    this.#pendingLayoutAnchor = null
    this.#deferResizeForScroll = false
    this.#layoutOffsetsDirty = false
    this.#viewChangeInFlight = false
  }

  #cancelIdlePrefetch(): void {
    if (this.#idlePrefetchTimer !== null) {
      window.clearTimeout(this.#idlePrefetchTimer)
      this.#idlePrefetchTimer = null
    }
    if (this.#idlePrefetchHandle !== null) {
      const idleWindow = window as Window & {
        cancelIdleCallback?: (handle: number) => void
      }
      idleWindow.cancelIdleCallback?.(this.#idlePrefetchHandle)
      this.#idlePrefetchHandle = null
    }
  }

  /** 滚动停止 150ms 后，用浏览器空闲时间再向前预取一批更远的页。 */
  #scheduleIdlePrefetch(): void {
    this.#cancelIdlePrefetch()
    if (this.#pdf === null || this.#pageCount < 1) {
      return
    }
    this.#idlePrefetchTimer = window.setTimeout(() => {
      this.#idlePrefetchTimer = null
      const idleWindow = window as Window & {
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout: number },
        ) => number
      }
      if (typeof idleWindow.requestIdleCallback === "function") {
        this.#idlePrefetchHandle = idleWindow.requestIdleCallback(
          () => {
            this.#idlePrefetchHandle = null
            this.#runIdlePrefetch()
          },
          { timeout: 1_000 },
        )
        return
      }
      this.#idlePrefetchTimer = window.setTimeout(() => {
        this.#idlePrefetchTimer = null
        this.#runIdlePrefetch()
      }, 0)
    }, IDLE_PREFETCH_DELAY_MS)
  }

  #runIdlePrefetch(): void {
    if (
      this.#pdf === null ||
      this.#pageCount < 1 ||
      this.#renderQueue.length > 0 ||
      this.#activeRenders.size >= this.#renderConcurrency()
    ) {
      return
    }
    const coarse = this.#coarsePointer()
    const base =
      this.#view.layoutMode === "single"
        ? { before: 1, after: 1 }
        : pdfPrefetchWindowFor(coarse)
    const extra = coarse
      ? IDLE_PREFETCH_EXTRA_MOBILE
      : IDLE_PREFETCH_EXTRA_DESKTOP
    const visible =
      this.#visiblePages.length > 0 ? this.#visiblePages : [this.#currentPage]
    const window = computePdfRenderWindow(
      { visible, pageCount: this.#pageCount, coarse },
      { before: base.before, after: base.after + extra },
    )
    let projectedPixels = this.#canvasBudget.totalPixels
    const targets: number[] = []
    for (const pageNumber of window.prefetch) {
      if (
        this.#rendered.has(pageNumber) ||
        this.#renderPromises.has(pageNumber) ||
        this.#activeRenders.has(pageNumber) ||
        this.#pageElements.get(pageNumber)?.dataset.state === "error"
      ) {
        continue
      }
      const estimated = this.#estimatedCanvasPixels(pageNumber)
      if (
        projectedPixels + estimated >
        this.#canvasBudget.maxPixels
      ) {
        continue
      }
      projectedPixels += estimated
      targets.push(pageNumber)
    }
    if (targets.length === 0) {
      return
    }
    for (const pageNumber of targets) {
      this.#renderWindow.add(pageNumber)
      void this.#renderPage(pageNumber, "prefetch")
    }
  }

  // 内部：虚拟渲染

  #refreshVisible(): void {
    if (this.#pdf === null || this.#pages === null) {
      return
    }
    this.#cancelIdlePrefetch()
    const page = clamp(Math.floor(this.#currentPage), 1, this.#pageCount)
    this.#currentPage = page
    const coarse = this.#coarsePointer()
    this.#applyCanvasBudgetTier(coarse)

    let visible: number[]
    if (this.#view.layoutMode === "single") {
      this.#rebuildLayoutDom()
      visible = [page]
    } else {
      const { first, last } = this.#visiblePageRange()
      if (last >= first) {
        visible = []
        for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
          visible.push(pageNumber)
        }
        this.#currentPage =
          this.#view.layoutMode === "horizontal" ? this.#pageFromScroll() : first
      } else {
        visible = [page]
      }
    }
    this.#visiblePages = visible

    const prefetch =
      this.#view.layoutMode === "single"
        ? { before: 1, after: 1 }
        : pdfPrefetchWindowFor(coarse)
    const window = computePdfRenderWindow(
      { visible, pageCount: this.#pageCount, coarse },
      prefetch,
    )
    this.#applyRenderWindow(window)
    this.#updateIndicator()
  }

  #applyRenderWindow(window: PdfRenderWindow): void {
    this.#renderWindow = new Set(window.retain)
    const desired = this.#renderWindow

    this.#renderQueue = this.#renderQueue.filter((entry) =>
      desired.has(entry.pageNumber),
    )
    for (const [pageNumber] of this.#activeRenders) {
      if (!desired.has(pageNumber) && !this.#shouldKeepRendered(pageNumber)) {
        this.#cancelPageRender(pageNumber)
      }
    }
    for (const pageNumber of [...this.#renderPromises.keys()]) {
      if (!desired.has(pageNumber) && !this.#shouldKeepRendered(pageNumber)) {
        this.#cancelPageRender(pageNumber)
      }
    }

    // 先让窗口内页面成为“最近使用”，再按预算淘汰窗口外的旧页。
    // prefetch 从远到近 touch，保证预算不足时先淘汰更远的候选页。
    for (const pageNumber of [...window.prefetch].reverse()) {
      const record = this.#rendered.get(pageNumber)
      if (record !== undefined) {
        this.#touchRendered(pageNumber, record)
      }
    }
    for (const pageNumber of window.visible) {
      const record = this.#rendered.get(pageNumber)
      if (record !== undefined) {
        this.#touchRendered(pageNumber, record)
      }
    }
    this.#enforceCanvasBudget()

    for (const pageNumber of window.visible) {
      const element = this.#pageElements.get(pageNumber)
      if (
        element?.dataset.state === "prefetching" &&
        element.dataset.canvasReady !== "true"
      ) {
        this.#setPageState(pageNumber, "rendering")
      }
    }

    for (const pageNumber of window.visible) {
      if (this.#pageElements.get(pageNumber)?.dataset.state === "error") {
        continue
      }
      void this.#renderPage(pageNumber, "visible")
    }
    // 只把预算装得下的最近 prefetch 页送进队列；更远页保持 idle，
    // 避免每帧“渲染→淘汰→再渲染”的空转。
    let projectedPixels = this.#canvasBudget.totalPixels
    for (const pageNumber of window.visible) {
      if (this.#pageElements.get(pageNumber)?.dataset.state === "error") {
        continue
      }
      const rendered = this.#rendered.get(pageNumber)
      if (
        rendered?.scaleKey === this.#renderKey(pageNumber) ||
        this.#renderPromises.has(pageNumber)
      ) {
        continue
      }
      projectedPixels += this.#estimatedCanvasPixels(pageNumber)
    }
    for (const pageNumber of window.prefetch) {
      if (this.#pageElements.get(pageNumber)?.dataset.state === "error") {
        continue
      }
      const rendered = this.#rendered.get(pageNumber)
      if (rendered?.scaleKey === this.#renderKey(pageNumber)) {
        continue
      }
      if (
        this.#renderPromises.has(pageNumber) ||
        this.#activeRenders.has(pageNumber)
      ) {
        continue
      }
      const estimated = this.#estimatedCanvasPixels(pageNumber)
      if (
        projectedPixels + estimated >
        this.#canvasBudget.maxPixels
      ) {
        continue
      }
      projectedPixels += estimated
      void this.#renderPage(pageNumber, "prefetch")
    }
    this.#pumpRenderQueue()
    this.#scheduleIdlePrefetch()
  }

  #enforceCanvasBudget(): void {
    // 只保护当前可见页；后台正在补文字层/注释层的页如果超出预算，
    // 允许按 lastUsed 淘汰，避免快速滚动时 canvas 像素越积越多。
    const protectedPages = new Set(this.#visiblePages)
    for (const pageNumber of this.#canvasBudget.evict(protectedPages)) {
      this.#disposeRendered(pageNumber)
    }
  }

  #shouldKeepRendered(pageNumber: number): boolean {
    return this.#rendered.get(pageNumber)?.canvasReady === true
  }

  #estimatedCanvasPixels(pageNumber: number): number {
    const metrics = this.#metricsFor(pageNumber)
    const scale = this.#scaleFor(metrics)
    const width = Math.max(1, metrics.width * scale)
    const height = Math.max(1, metrics.height * scale)
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const pixels = width * height * dpr * dpr
    const outputScale =
      pixels <= MAX_CANVAS_PIXELS
        ? dpr
        : clamp(Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), 0.1, dpr)
    return (
      Math.max(1, Math.floor(width * outputScale)) *
      Math.max(1, Math.floor(height * outputScale))
    )
  }

  #canStartPrefetch(pageNumber: number): boolean {
    const current = this.#canvasBudget.pixelsFor(pageNumber)
    return (
      this.#canvasBudget.totalPixels -
        current +
        this.#estimatedCanvasPixels(pageNumber) <=
      this.#canvasBudget.maxPixels
    )
  }

  #cancelPageRender(pageNumber: number): void {
    this.#renderTokens.set(pageNumber, ++this.#renderTokenSeq)
    const pending = this.#renderPromises.get(pageNumber)
    if (pending !== undefined) {
      this.#renderPromises.delete(pageNumber)
      pending.resolve()
    }
    this.#renderQueue = this.#renderQueue.filter(
      (entry) => entry.pageNumber !== pageNumber,
    )
    if (this.#rendered.has(pageNumber)) {
      this.#disposeRendered(pageNumber)
    } else if (!this.#activeRenders.has(pageNumber)) {
      this.#setPageState(pageNumber, "idle")
    }
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

  #renderPage(
    pageNumber: number,
    priority: RenderPriority = "visible",
  ): Promise<void> {
    const key = this.#renderKey(pageNumber)
    const pending = this.#renderPromises.get(pageNumber)
    if (pending !== undefined && pending.scaleKey === key) {
      this.#promoteQueuedRender(pageNumber, priority)
      return pending.promise
    }
    const rendered = this.#rendered.get(pageNumber)
    if (
      rendered !== undefined &&
      rendered.scaleKey === key &&
      rendered.canvasReady
    ) {
      this.#touchRendered(pageNumber, rendered)
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
    if (pending !== undefined) {
      // 缩放/旋转后旧请求的 scale 已失效；先结束旧 promise，避免调用方悬挂。
      this.#renderPromises.delete(pageNumber)
      pending.resolve()
    }
    this.#disposeRendered(pageNumber)
    const token = ++this.#renderTokenSeq
    this.#renderTokens.set(pageNumber, token)
    let resolve: () => void = () => undefined
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    this.#renderPromises.set(pageNumber, {
      scaleKey: key,
      promise,
      token,
      resolve,
    })
    this.#enqueueRender(pageNumber, priority)
    this.#pumpRenderQueue()
    return promise
  }

  #promoteQueuedRender(
    pageNumber: number,
    priority: RenderPriority,
  ): void {
    if (priority !== "visible") {
      return
    }
    const index = this.#renderQueue.findIndex(
      (entry) => entry.pageNumber === pageNumber,
    )
    if (index < 0 || this.#renderQueue[index].priority === "visible") {
      return
    }
    const [entry] = this.#renderQueue.splice(index, 1)
    let insertAt = 0
    while (
      insertAt < this.#renderQueue.length &&
      this.#renderQueue[insertAt].priority === "visible"
    ) {
      insertAt += 1
    }
    this.#renderQueue.splice(insertAt, 0, {
      pageNumber: entry.pageNumber,
      priority: "visible",
    })
    this.#pumpRenderQueue()
  }

  #enqueueRender(pageNumber: number, priority: RenderPriority): void {
    const existing = this.#renderQueue.findIndex(
      (entry) => entry.pageNumber === pageNumber,
    )
    if (existing >= 0) {
      if (
        priority === "visible" &&
        this.#renderQueue[existing].priority !== "visible"
      ) {
        this.#renderQueue.splice(existing, 1)
      } else {
        return
      }
    }
    if (priority === "prefetch") {
      this.#renderQueue.push({ pageNumber, priority })
      return
    }
    let insertAt = 0
    while (
      insertAt < this.#renderQueue.length &&
      this.#renderQueue[insertAt].priority === "visible"
    ) {
      insertAt += 1
    }
    this.#renderQueue.splice(insertAt, 0, { pageNumber, priority })
  }

  #pumpRenderQueue(): void {
    const concurrency = this.#renderConcurrency()
    while (this.#activeRenders.size < concurrency) {
      const entry = this.#renderQueue.shift()
      if (entry === undefined) {
        break
      }
      const { pageNumber } = entry
      if (!this.#renderWindow.has(pageNumber)) {
        const stale = this.#renderPromises.get(pageNumber)
        if (stale !== undefined) {
          this.#renderPromises.delete(pageNumber)
          stale.resolve()
        }
        this.#setPageState(pageNumber, "idle")
        continue
      }
      const pending = this.#renderPromises.get(pageNumber)
      if (pending === undefined) {
        continue
      }
      if (entry.priority === "prefetch" && !this.#canStartPrefetch(pageNumber)) {
        this.#renderPromises.delete(pageNumber)
        pending.resolve()
        if (!this.#rendered.has(pageNumber)) {
          this.#setPageState(pageNumber, "idle")
        }
        continue
      }
      this.#activeRenders.set(pageNumber, {
        priority: entry.priority,
        token: pending.token,
      })
      this.#startPageRender(
        pageNumber,
        pending.token,
        entry.priority,
      )
    }
  }

  #startPageRender(
    pageNumber: number,
    token: number,
    priority: RenderPriority,
  ): void {
    void this.#doRenderPage(pageNumber, token, priority)
      .catch(() => undefined)
      .finally(() => {
        const active = this.#activeRenders.get(pageNumber)
        if (active !== undefined && active.token === token) {
          this.#activeRenders.delete(pageNumber)
        }
        const current = this.#renderPromises.get(pageNumber)
        if (current !== undefined && current.token === token) {
          this.#renderPromises.delete(pageNumber)
          current.resolve()
        }
        this.#enforceCanvasBudget()
        this.#pumpRenderQueue()
        if (
          this.#renderQueue.length === 0 &&
          this.#activeRenders.size === 0
        ) {
          this.#scheduleIdlePrefetch()
        }
      })
  }

  async #doRenderPage(
    pageNumber: number,
    token: number,
    priority: RenderPriority,
  ): Promise<void> {
    const pageElement = this.#pageElement(pageNumber)
    const fallback = pageElement.querySelector<HTMLElement>(
      ".iread-pdf__page-error",
    )
    const fallbackText = pageElement.querySelector<HTMLElement>(
      ".iread-pdf__page-error-text",
    )
    if (!this.#renderWindow.has(pageNumber)) {
      this.#setPageState(pageNumber, "idle")
      return
    }
    const renderState =
      priority === "visible" || this.#visiblePages.includes(pageNumber)
        ? "rendering"
        : "prefetching"
    this.#setPageState(pageNumber, renderState)
    if (fallback !== null) {
      fallback.hidden = true
    }
    try {
      const page = await this.#getPage(pageNumber)
      if (token !== this.#renderTokens.get(pageNumber)) {
        if (!this.#renderPromises.has(pageNumber)) {
          this.#setPageState(pageNumber, "idle")
        }
        return
      }
      // 拿到页面后、改写 canvas 前再确认一次；连续/横向布局同样适用。
      if (!this.#renderWindow.has(pageNumber)) {
        this.#setPageState(pageNumber, "idle")
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
      const previousMetrics = this.#pageMetrics.get(pageNumber)
      this.#pageMetrics.set(pageNumber, metrics)
      const sizeChanged =
        previousMetrics === undefined ||
        previousMetrics.width !== metrics.width ||
        previousMetrics.height !== metrics.height ||
        previousMetrics.totalRotation !== metrics.totalRotation
      // 在真正改 DOM 高度前记录用户当前看到的位置；等 rAF 重算 offsets
      // 后按这个锚点校正，混合尺寸页也不会把阅读位置推走。
      if (sizeChanged && this.#pendingLayoutAnchor === null) {
        this.#pendingLayoutAnchor = this.#captureAnchor()
      }
      const scale = this.#scaleFor(metrics)
      // 真实页面尺寸可能改变 fit-width 比例；用实际 scale 修正渲染键，
      // 否则下一次 refresh 会把同一页误判为新 scale 再渲染一次。
      const effectiveKey = `${scale.toFixed(4)}:${totalRotation}`
      const pendingEntry = this.#renderPromises.get(pageNumber)
      if (pendingEntry?.token === token) {
        pendingEntry.scaleKey = effectiveKey
      }
      this.#updatePageElementSize(pageNumber)
      if (sizeChanged) {
        this.#scheduleLayoutOffsetsUpdate()
      }
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
        scaleKey: effectiveKey,
        page,
        textLayer: null,
        annotationLayer: null,
        renderTask,
        cacheKey: null,
        canvasReady: false,
        pixels: canvas.width * canvas.height,
        lastUsed: 0,
      }
      this.#rendered.set(pageNumber, record)
      await renderTask.promise
      if (token !== this.#renderTokens.get(pageNumber)) {
        if (this.#rendered.get(pageNumber) === record) {
          this.#disposeRendered(pageNumber)
        } else if (!this.#renderPromises.has(pageNumber)) {
          this.#setPageState(pageNumber, "idle")
        }
        return
      }
      // 画布一画完就撤掉占位；文字层/注释层仍可能在继续。
      record.canvasReady = true
      this.#markCanvasReady(pageNumber)
      this.#touchRendered(pageNumber, record)

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
      if (
        token !== this.#renderTokens.get(pageNumber) ||
        this.#rendered.get(pageNumber) !== record
      ) {
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
      if (
        token !== this.#renderTokens.get(pageNumber) ||
        this.#rendered.get(pageNumber) !== record
      ) {
        return
      }
      this.#setPageState(pageNumber, "ready")
      this.#applySearchHighlightsToPage(pageNumber)
      this.#currentScaleForZoom = scale
      this.#updateZoomIndicator()
      const cache = this.#cache
      const manifest = this.#manifest
      if (cache !== null && manifest !== null) {
        const cacheKey = this.#renderCacheKey(pageNumber, effectiveKey)
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
                if (
                  this.#renderWindow.has(pageNumber) &&
                  !this.#renderPromises.has(pageNumber)
                ) {
                  void this.#renderPage(
                    pageNumber,
                    this.#visiblePages.includes(pageNumber)
                      ? "visible"
                      : "prefetch",
                  )
                }
              }
            },
          },
        )
      }
    } catch (error) {
      if (token !== this.#renderTokens.get(pageNumber)) {
        if (!this.#renderPromises.has(pageNumber)) {
          this.#setPageState(pageNumber, "idle")
        }
        return
      }
      if (isAbortError(error) || isRenderingCancelled(error)) {
        this.#disposeRendered(pageNumber)
        this.#setPageState(pageNumber, "idle")
        return
      }
      this.#disposeRendered(pageNumber)
      this.#setPageState(pageNumber, "error")
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

  #touchRendered(pageNumber: number, record: RenderedPage): void {
    if (!record.canvasReady) {
      return
    }
    record.lastUsed = ++this.#renderUseSeq
    record.pixels = Math.max(0, record.pixels)
    this.#canvasBudget.touch(pageNumber, record.pixels)
  }

  #disposeRendered(pageNumber: number, skipRenderCache = false): void {
    const record = this.#rendered.get(pageNumber)
    if (record === undefined) {
      return
    }
    this.#rendered.delete(pageNumber)
    this.#canvasBudget.remove(pageNumber)
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
      delete element.dataset.canvasReady
      if (element.dataset.state !== "error") {
        this.#setPageState(pageNumber, "idle")
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

  #disposeAllRenders(): void {
    if (this.#layoutOffsetsFrame !== null) {
      window.cancelAnimationFrame(this.#layoutOffsetsFrame)
      this.#layoutOffsetsFrame = null
    }
    const pages = new Set<number>([
      ...this.#rendered.keys(),
      ...this.#renderPromises.keys(),
      ...this.#renderTokens.keys(),
    ])
    for (const pageNumber of pages) {
      // 用全局递增 token 作废旧请求；地图本身不清空，避免新旧 token 碰撞。
      this.#renderTokens.set(pageNumber, ++this.#renderTokenSeq)
    }
    for (const pageNumber of [...this.#rendered.keys()]) {
      this.#disposeRendered(pageNumber)
    }
    for (const pageNumber of [...this.#renderPromises.keys()]) {
      const pending = this.#renderPromises.get(pageNumber)
      this.#renderPromises.delete(pageNumber)
      pending?.resolve()
      this.#setPageState(pageNumber, "idle")
    }
    this.#renderPromises.clear()
    this.#renderQueue = []
    this.#activeRenders.clear()
    this.#renderWindow.clear()
    this.#visiblePages = []
    this.#canvasBudget.clear()
    this.#cancelIdlePrefetch()
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

  // 内部：搜索高亮

  async activateSearchMatch(index: number): Promise<number> {
    if (!this.#searchMatches.length) return -1
    const sequence = this.#searchSeq
    const wrapped = ((index % this.#searchMatches.length) + this.#searchMatches.length) % this.#searchMatches.length
    this.#activeSearchIndex = wrapped
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

  // 内部：状态与指示器

  #updateIndicator(): void {
    const page = Math.max(1, this.#currentPage)
    const count = this.#pageCount
    if (this.#root !== null) {
      this.#root.dataset.pdfPage = String(page)
      this.#root.dataset.pdfPageCount = String(count)
    }
  }

  #updateZoomIndicator(): void {
    const scale =
      this.#displaySizes.get(this.#currentPage)?.scale ?? this.#currentScaleForZoom
    if (this.#root !== null) {
      this.#root.dataset.pdfScale = scale.toFixed(4)
    }
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
