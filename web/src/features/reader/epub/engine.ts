import * as CFI from "../../../vendor/foliate-js/epubcfi.js"
import {
  View,
  type FoliateLoadDetail,
  type FoliateRelocateDetail,
} from "../../../vendor/foliate-js/view.js"

import type {
  ReaderEngineResult,
  ReaderCapabilities,
  ReaderViewportMetrics,
} from "../shell/engine"
import type {
  EpubReaderManifest,
  ReaderLocation,
  ReaderManifest,
} from "../types"

import {
  ManifestEpubBook,
  fixedLayoutReason,
} from "./book"
import {
  buildChapter,
  createErrorChapter,
  parseBuiltChapter,
  type BuiltChapter,
} from "./chapter"
import {
  anchorForPayload,
  chapterProgressFromFractions,
  locationFromRelocate,
  relocateProgressFraction,
  resolvePayloadIndex,
} from "./location"
import {
  EpubResourceClient,
  isAbortError,
} from "./resources"
import { buildReaderCss, computeLayout, defaultSettings, mergeSettings } from "./settings"
import {
  epubResourceKey,
  resourceKeyId,
} from "../cache/resource-key"
import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"
import {
  EpubReaderError,
  type EpubReaderEngine,
  type EpubContentInput,
  type EpubReaderEngineOptions,
  type EpubReaderSettings,
} from "./types"

const EPUB_UNAVAILABLE_FEATURES = [
  "toc",
  "bookmarks",
  "settings",
  "text-selection",
  "zoom",
] as const

const EPUB_MIN_ZOOM = 0.5
const EPUB_MAX_ZOOM = 3

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.min(EPUB_MAX_ZOOM, Math.max(EPUB_MIN_ZOOM, value))
}

interface ChapterLoadState {
  abort: AbortController
  token: number
}

function defaultCapabilities(): ReaderCapabilities {
  return {
    canRender: true,
    canNavigate: true,
    canSearch: false,
    canZoom: true,
    features: [...EPUB_UNAVAILABLE_FEATURES],
    unavailableReason: "",
  }
}

function abortError(): DOMException {
  return new DOMException("操作已取消", "AbortError")
}

function describeError(error: unknown): string {
  if (error instanceof EpubReaderError) {
    return error.message
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  return "未知错误，请重试。"
}

function fail(reason: string, retryable = true): ReaderEngineResult {
  return { ok: false, reason, retryable }
}


export class EpubEngine implements EpubReaderEngine {
  readonly format = "epub" as const
  readonly capabilities: ReaderCapabilities

  private settings: EpubReaderSettings
  private initialLocation: ReaderLocation | null
  private manifest: EpubReaderManifest | null = null
  private host: HTMLElement | null = null
  private view: View | null = null
  private book: ManifestEpubBook | null = null
  private resources: EpubResourceClient | null = null
  private mountAbort: AbortController | null = null
  private mounted = false
  private disposed = false
  private viewport: ReaderViewportMetrics | null = null
  private listeners = new Set<(location: ReaderLocation) => void>()
  private contentListeners = new Set<(input: EpubContentInput) => void>()
  private contentDocuments = new Map<Document, { index: number; cleanup: () => void }>()
  private lastLocation: ReaderLocation | null = null
  private lastEmittedKey = ""
  private chapterLoads = new Map<number, ChapterLoadState>()
  private chapterTokens = new Map<number, number>()
  private builtChapters = new Map<number, BuiltChapter>()
  private chapterErrors = new Map<number, string>()
  private overlay: HTMLElement | null = null
  private zoomLayer: HTMLElement | null = null
  private zoom = 1
  private panX = 0
  private panY = 0
  private pinchActive = false
  private pinchBaseZoom = 1
  private pinchBasePanX = 0
  private pinchBasePanY = 0
  private pinchContentX = 0
  private pinchContentY = 0
  private layoutResetDepth = 0
  private pointerCount = 0
  private pan: {
    pointerId: number
    startX: number
    startY: number
    panX: number
    panY: number
  } | null = null
  private suppressClickUntil = 0
  private zoomGuardUntil = 0
  private navigationQueue: Promise<void> = Promise.resolve()
  private navigationEpoch = 0
  private reflowTimer: number | null = null
  private readonly cache: ReaderCacheRuntime | null
  private prefetchIndex = -1
  private prefetchNextIndex = -1

  constructor(options?: EpubReaderEngineOptions) {
    this.settings = defaultSettings(options?.settings)
    this.initialLocation = options?.initialLocation ?? null
    this.cache = options?.cache ?? null
    this.capabilities = defaultCapabilities()
  }

  subscribeContentInput(listener: (input: EpubContentInput) => void): () => void {
    this.contentListeners.add(listener)
    return () => { this.contentListeners.delete(listener) }
  }

  getZoom(): number {
    return this.zoomEnabled() ? this.zoom : 1
  }

  beginPinch(x: number, y: number): void {
    if (!this.zoomEnabled() || this.zoomLayer === null || !this.ensureMounted()) {
      return
    }
    this.cancelPan()
    this.pinchActive = true
    this.pinchBaseZoom = this.zoom
    this.pinchBasePanX = this.panX
    this.pinchBasePanY = this.panY
    const rect = this.zoomLayer.getBoundingClientRect()
    const localX = x - rect.left
    const localY = y - rect.top
    this.pinchContentX = (localX - this.panX) / this.zoom
    this.pinchContentY = (localY - this.panY) / this.zoom
    this.zoomGuardUntil = performance.now() + 1200
    this.clearContentSelection()
  }

  updatePinch(scale: number, x: number, y: number): void {
    const layer = this.zoomLayer
    if (!this.pinchActive || layer === null || !Number.isFinite(scale)) {
      return
    }
    const next = clampZoom(this.pinchBaseZoom * Math.max(0.01, scale))
    const rect = layer.getBoundingClientRect()
    const localX = x - rect.left
    const localY = y - rect.top
    this.zoom = next
    this.panX = localX - this.pinchContentX * next
    this.panY = localY - this.pinchContentY * next
    this.normalizePan()
    this.applyZoomTransform()
  }

  endPinch(commit = true): void {
    if (!this.pinchActive) {
      return
    }
    this.pinchActive = false
    this.suppressClickUntil = performance.now() + 200
    this.zoomGuardUntil = performance.now() + 300
    if (!commit) {
      this.zoom = this.pinchBaseZoom
      this.panX = this.pinchBasePanX
      this.panY = this.pinchBasePanY
      this.normalizePan()
    }
    this.applyZoomTransform()
    this.clearContentSelection()
  }

  resetZoom(): void {
    if (!this.zoomEnabled()) {
      return
    }
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.applyZoomTransform()
    this.clearContentSelection()
  }

  private zoomEnabled(): boolean {
    return this.settings.pagination === "pagination"
  }

  private attachViewLayer(view: View): void {
    const host = this.host
    if (host === null) {
      return
    }
    const layer = document.createElement("div")
    layer.className = "iread-epub-zoom"
    layer.append(view)
    host.replaceChildren(layer)
    this.zoomLayer = layer
    this.applyZoomTransform()
    this.guardRenderer(view)
  }

  private applyZoomTransform(): void {
    const view = this.view
    const layer = this.zoomLayer
    if (view === null || layer === null) {
      return
    }
    if (!this.zoomEnabled()) {
      this.zoom = 1
      this.panX = 0
      this.panY = 0
      view.style.transform = ""
      layer.removeAttribute("data-zoom")
      return
    }
    this.normalizePan()
    view.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.zoom})`
    layer.dataset.zoom = this.zoom.toFixed(2)
  }

  private normalizePan(): void {
    const layer = this.zoomLayer
    if (layer === null) {
      this.panX = 0
      this.panY = 0
      return
    }
    const width = Math.max(1, layer.clientWidth)
    const height = Math.max(1, layer.clientHeight)
    const spanX = width * this.zoom
    const spanY = height * this.zoom
    this.panX =
      spanX <= width
        ? (width - spanX) / 2
        : Math.min(0, Math.max(width - spanX, this.panX))
    this.panY =
      spanY <= height
        ? (height - spanY) / 2
        : Math.min(0, Math.max(height - spanY, this.panY))
  }

  /**
   * paginator 的 #beforeRender 通过父文档 getBoundingClientRect 测量容器。
   * 祖先 transform 会污染测量，因此布局/翻页/换章期间临时把缩放层还原为 1，
   * 操作完成后再恢复用户缩放。只包裹真正会触发布局的 renderer 方法。
   */
  private enterLayoutReset(): void {
    this.layoutResetDepth += 1
    if (this.layoutResetDepth === 1 && this.view !== null && this.zoom !== 1) {
      this.view.style.transform = "none"
    }
  }

  private exitLayoutReset(): void {
    if (this.layoutResetDepth === 0) {
      return
    }
    this.layoutResetDepth -= 1
    if (this.layoutResetDepth === 0) {
      this.applyZoomTransform()
    }
  }

  private guardRenderer(view: View): void {
    const renderer = view.renderer
    if (renderer === undefined || renderer === null) {
      return
    }
    const target = renderer as unknown as Record<string, unknown>
    if (target.__ireadZoomGuarded === true) {
      return
    }
    target.__ireadZoomGuarded = true
    const wrap = (name: string): void => {
      const original = target[name]
      if (typeof original !== "function") {
        return
      }
      const method = original as (...args: unknown[]) => unknown
      target[name] = (...args: unknown[]): unknown => {
        this.enterLayoutReset()
        let result: unknown
        try {
          result = method.apply(renderer, args)
        } catch (error) {
          this.exitLayoutReset()
          throw error
        }
        if (
          result !== null &&
          typeof result === "object" &&
          typeof (result as Promise<unknown>).then === "function"
        ) {
          return (result as Promise<unknown>).finally(() => {
            this.exitLayoutReset()
          })
        }
        this.exitLayoutReset()
        return result
      }
    }
    wrap("render")
    wrap("goTo")
    wrap("next")
    wrap("prev")
  }

  private clearContentSelection(): void {
    for (const doc of this.contentDocuments.keys()) {
      try {
        doc.getSelection()?.removeAllRanges()
      } catch {
        // 跨 realm 取消失败不影响缩放。
      }
    }
  }

  private cancelPan(): void {
    this.pan = null
  }

  private bindContentDocument(doc: Document, index: number): void {
    if (this.contentDocuments.has(doc)) return
    for (const entry of [...this.contentDocuments.values()]) {
      if (entry.index === index) entry.cleanup()
    }
    const emit = (input: EpubContentInput) => {
      if (!this.mounted || this.disposed || !input.event.isTrusted) return
      for (const listener of this.contentListeners) listener(input)
    }
    const keydown = (event: KeyboardEvent) => emit({ kind: "keydown", event, document: doc })
    const pointer = (event: PointerEvent) => {
      const frame = doc.defaultView?.frameElement
      if (frame === null || frame === undefined) return
      const rect = frame.getBoundingClientRect()
      emit({ kind: event.type as "pointerdown" | "pointermove" | "pointerup" | "pointercancel", event, document: doc,
        clientX: rect.left + event.clientX * rect.width / Math.max(1, doc.documentElement.clientWidth),
        clientY: rect.top + event.clientY * rect.height / Math.max(1, doc.documentElement.clientHeight) })
    }
    const targetElement = (event: Event): Element | null => {
      const target = event.target
      return target !== null && typeof target === "object" && "closest" in target
        ? (target as Element)
        : null
    }
    const interactiveTarget = (event: Event): boolean => {
      const target = targetElement(event)
      return (
        target?.closest(
          "a[href],button,input,textarea,select,label,[contenteditable],[role='button'],[role='slider']",
        ) != null
      )
    }
    const pointerDown = (event: PointerEvent) => {
      this.pointerCount += 1
      const selection = doc.getSelection()
      if (
        this.pointerCount > 1 ||
        this.pinchActive ||
        this.zoom <= 1 ||
        !this.zoomEnabled() ||
        interactiveTarget(event) ||
        (selection !== null && !selection.isCollapsed)
      ) {
        this.pan = null
        return
      }
      this.pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: this.panX,
        panY: this.panY,
      }
    }
    const pointerMove = (event: PointerEvent) => {
      const pan = this.pan
      if (
        pan === null ||
        pan.pointerId !== event.pointerId ||
        this.pinchActive
      ) {
        return
      }
      const selection = doc.getSelection()
      if (selection !== null && !selection.isCollapsed) {
        this.pan = null
        return
      }
      const dx = event.clientX - pan.startX
      const dy = event.clientY - pan.startY
      if (Math.hypot(dx, dy) > 3) {
        this.panX = pan.panX + dx
        this.panY = pan.panY + dy
        this.normalizePan()
        this.applyZoomTransform()
        event.preventDefault()
      }
    }
    const pointerEnd = () => {
      this.pointerCount = Math.max(0, this.pointerCount - 1)
      this.pan = null
    }
    const touch = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        // 双指期间必须阻断 foliate paginator 自己的 touch 手势/吸附；
        // 捕获阶段处理，避免它的 doc 监听器先收到多指事件。
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (this.zoomEnabled()) {
        // 分页模式完全由 Shell 的 pointer 手势驱动；分页不需要原生滚动，
        // 阻断 paginator 的单指 touchmove/snap，防止捏合过程中被它误翻页。
        if (event.type === "touchmove") {
          event.preventDefault()
        }
        event.stopImmediatePropagation()
      }
    }
    const click = (event: MouseEvent) => {
      if (performance.now() < this.suppressClickUntil) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const cleanup = () => {
      doc.removeEventListener("keydown", keydown)
      doc.removeEventListener("pointerdown", pointer)
      doc.removeEventListener("pointermove", pointer)
      doc.removeEventListener("pointerup", pointer)
      doc.removeEventListener("pointercancel", pointer)
      doc.removeEventListener("pointerdown", pointerDown)
      doc.removeEventListener("pointermove", pointerMove)
      doc.removeEventListener("pointerup", pointerEnd)
      doc.removeEventListener("pointercancel", pointerEnd)
      doc.removeEventListener("touchstart", touch, true)
      doc.removeEventListener("touchmove", touch, true)
      doc.removeEventListener("touchend", touch, true)
      doc.removeEventListener("click", click, true)
      doc.defaultView?.removeEventListener("pagehide", cleanup)
      this.contentDocuments.delete(doc)
    }
    this.contentDocuments.set(doc, { index, cleanup })
    doc.addEventListener("keydown", keydown)
    doc.addEventListener("pointerdown", pointer)
    doc.addEventListener("pointermove", pointer)
    doc.addEventListener("pointerup", pointer)
    doc.addEventListener("pointercancel", pointer)
    doc.addEventListener("pointerdown", pointerDown)
    doc.addEventListener("pointermove", pointerMove)
    doc.addEventListener("pointerup", pointerEnd)
    doc.addEventListener("pointercancel", pointerEnd)
    doc.addEventListener("touchstart", touch, {
      passive: false,
      capture: true,
    })
    doc.addEventListener("touchmove", touch, {
      passive: false,
      capture: true,
    })
    doc.addEventListener("touchend", touch, { passive: false, capture: true })
    doc.addEventListener("click", click, true)
    doc.defaultView?.addEventListener("pagehide", cleanup, { once: true })
    this.applyContentTouchAction(doc)
  }

  private applyContentTouchAction(doc: Document): void {
    doc.documentElement.style.touchAction = this.zoomEnabled() ? "none" : "pan-y"
  }

  getSettings(): EpubReaderSettings {
    return { ...this.settings }
  }

  getLocation(): ReaderLocation | null {
    return this.lastLocation
  }

  applySettings(patch: Partial<EpubReaderSettings>): void {
    const previous = this.settings
    const previousPublisher = this.settings.publisherCSSMode
    this.settings = mergeSettings(this.settings, patch)
    const layoutKeys: (keyof EpubReaderSettings)[] = [
      "fontFamily",
      "fontSize",
      "lineHeight",
      "paragraphSpacing",
      "textIndent",
      "align",
      "horizontalMargin",
      "verticalMargin",
      "maxWidth",
      "pagination",
      "columns",
      "publisherCSSMode",
    ]
    const layoutChanged = layoutKeys.some(
      (key) => previous[key] !== this.settings[key],
    )
    if (previous.pagination !== this.settings.pagination) {
      this.zoom = 1
      this.panX = 0
      this.panY = 0
      this.pinchActive = false
    }
    if (layoutChanged) {
      // 改字号/排版只失效 L2 渲染对象，L1/L3 网络资源保持可复用。
      this.cache?.render.clear()
    }
    if (this.view === null) {
      return
    }
    const reflowTarget = this.lastLocation
    this.applyViewAttributes()
    this.applyReaderStyles()
    this.applyZoomTransform()
    if (previousPublisher !== this.settings.publisherCSSMode) {
      const index = this.currentIndex()
      if (index >= 0) {
        void this.rebuildSection(index)
      }
      return
    }
    this.scheduleReflowRestore(reflowTarget)
  }

  async mount(
    host: HTMLElement,
    manifest: ReaderManifest,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.disposed) {
      throw new EpubReaderError("阅读引擎已释放，不能继续挂载。", false)
    }
    if (manifest.format !== "epub") {
      throw new EpubReaderError("当前引擎只支持 EPUB。", false)
    }
    if (signal.aborted) {
      throw abortError()
    }
    if (this.mounted) {
      this.unmount()
    }
    Object.assign(this.capabilities, defaultCapabilities())
    const fixedReason = fixedLayoutReason(manifest)
    if (fixedReason !== null) {
      this.capabilities.canRender = false
      this.capabilities.canNavigate = false
      this.capabilities.features = []
      this.capabilities.unavailableReason = fixedReason
      throw new EpubReaderError(fixedReason, false)
    }
    this.manifest = manifest
    this.host = host
    this.mounted = true
    this.lastLocation = null
    this.lastEmittedKey = ""
    this.mountAbort = new AbortController()
    const onAbort = () => {
      this.mountAbort?.abort()
      this.unmount()
    }
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      this.resources = new EpubResourceClient(manifest, {
        cache: this.cache,
      })
      this.book = new ManifestEpubBook(manifest, {
        loadChapter: (index) => this.loadChapter(index),
        unloadChapter: (index) => this.unloadChapter(index),
        createDocument: (index) => this.createDocument(index),
      })
      const view = new View()
      this.view = view
      view.style.width = "100%"
      view.style.height = "100%"
      view.style.display = "block"
      view.style.transformOrigin = "0 0"
      view.style.willChange = "transform"
      view.addEventListener("relocate", this.handleRelocate)
      view.addEventListener("load", this.handleLoad)
      view.addEventListener("external-link", this.handleExternalLink)
      this.attachViewLayer(view)
      this.applyViewAttributes()
      await view.open(this.book)
      if (signal.aborted) {
        throw abortError()
      }
      this.guardRenderer(view)
      this.applyViewAttributes()
      this.applyReaderStyles()
      const initial = this.initialLocation
      await view.init({
        lastLocation:
          initial !== null && initial.locatorType === "epub-cfi"
            ? initial.locatorPayload.cfi
            : undefined,
        showTextStart: initial === null,
      })
      if (signal.aborted) {
        throw abortError()
      }
      if (initial !== null) {
        const result = await this.restore(initial)
        if (!result.ok) {
          this.showOverlay(result.reason)
        }
      }
      this.applyViewAttributes()
      this.applyReaderStyles()
      this.prefetchAdjacent(this.currentIndex(), 0)
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.unmount()
        return
      }
      this.unmount()
      throw error
    }
  }

  unmount(): void {
    this.mounted = false
    for (const entry of [...this.contentDocuments.values()]) entry.cleanup()
    this.mountAbort?.abort()
    this.mountAbort = null
    this.cancelReflowRestore()
    for (const state of this.chapterLoads.values()) {
      state.abort.abort()
    }
    this.chapterLoads.clear()
    const view = this.view
    this.view = null
    if (view !== null) {
      view.removeEventListener("relocate", this.handleRelocate)
      view.removeEventListener("load", this.handleLoad)
      view.removeEventListener("external-link", this.handleExternalLink)
      try {
        view.close()
      } catch {
        // 未完成 open 的 view 可能没有 renderer；清理仍需继续。
      }
      view.remove()
    }
    this.hideOverlay()
    this.releaseAllChapters()
    this.resources?.clear()
    this.resources = null
    this.book = null
    this.manifest = null
    this.host = null
    this.zoomLayer?.remove()
    this.zoomLayer = null
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.pinchActive = false
    this.pan = null
    this.pointerCount = 0
    this.layoutResetDepth = 0
    this.chapterErrors.clear()
    this.prefetchIndex = -1
    this.prefetchNextIndex = -1
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.unmount()
    this.disposed = true
    this.listeners.clear()
    this.contentListeners.clear()
  }

  async restore(location: ReaderLocation): Promise<ReaderEngineResult> {
    // 新的导航优先于尚未执行的重排恢复，避免迟到的 restore 覆盖新位置。
    this.cancelReflowRestore()
    this.zoomGuardUntil = 0
    return this.enqueueNavigation(async (epoch) => {
      if (epoch !== this.navigationEpoch) {
        return fail("位置已被新的导航取代。", true)
      }
      if (!this.ensureMounted()) {
        return fail("阅读引擎尚未挂载。", true)
      }
      if (location.locatorType === "epub-cfi") {
        const book = this.book
        const view = this.view
        if (book === null || view === null) {
          return fail("阅读引擎尚未就绪。", true)
        }
        const resolved = book.resolveCFI(location.locatorPayload.cfi)
        if (resolved !== null) {
          const previousDocument = this.currentContentDocument()
          const moved = await view.goTo(location.locatorPayload.cfi)
          // foliate 在 load 事件里写入样式时，renderer 尚未切换 #view，
          // 样式会落到旧文档；只有章节文档真的换了才重新注入，避免
          // 同章跳转触发无谓的 expand/reflow。
          if (this.currentContentDocument() !== previousDocument) {
            this.applyReaderStyles()
          }
          if (
            moved !== undefined &&
            !this.chapterErrors.has(resolved.index)
          ) {
            return { ok: true }
          }
        }
        return this.goToAnchor({
          ...location.locatorPayload,
          anchorId: null,
        })
      }
      if (location.locatorType === "epub-anchor") {
        return this.goToAnchor(location.locatorPayload)
      }
      return fail("当前引擎不接受该定位类型。", false)
    })
  }

  async navigateTo(location: ReaderLocation): Promise<ReaderEngineResult> {
    if (location.locatorType !== "epub-cfi" && location.locatorType !== "epub-anchor") {
      return fail("当前引擎不接受该定位类型。", false)
    }
    const result = await this.restore(location)
    if (result.ok && this.lastLocation === null) {
      this.emitLocation(location)
    }
    return result
  }

  async advance(direction: "previous" | "next"): Promise<ReaderEngineResult> {
    this.cancelReflowRestore()
    this.zoomGuardUntil = 0
    if (!this.ensureMounted()) {
      return fail("阅读引擎尚未挂载。", true)
    }
    const view = this.view
    if (view === null) {
      return fail("阅读引擎尚未就绪。", true)
    }
    try {
      const previousDocument = this.currentContentDocument()
      if (direction === "next") {
        await view.next()
      } else {
        await view.prev()
      }
      // 翻到新章节时 foliate 会重建 iframe；load 阶段写入的样式落在旧文档，
      // 章节文档变化后对新的当前文档再应用一次。页内翻页不触发重排。
      if (this.currentContentDocument() !== previousDocument) {
        this.applyReaderStyles()
      }
      return { ok: true }
    } catch (error) {
      if (isAbortError(error)) {
        return fail("翻页已取消。", true)
      }
      return fail(describeError(error), true)
    }
  }

  subscribeLocation(listener: (location: ReaderLocation) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  handleViewportChange(metrics: ReaderViewportMetrics): void {
    this.viewport = metrics
    if (this.view === null) {
      return
    }
    const reflowTarget = this.lastLocation
    this.applyViewAttributes()
    this.applyZoomTransform()
    this.cancelReflowRestore()
    this.reflowTimer = window.setTimeout(() => {
      this.reflowTimer = null
      const view = this.view
      if (view === null) {
        return
      }
      try {
        view.renderer.render()
      } catch {
        // renderer 尚未完成首章加载时没有可重排内容。
      }
      this.scheduleReflowRestore(reflowTarget)
    }, 120)
  }

  async retrySection(index?: number): Promise<ReaderEngineResult> {
    const target = index ?? this.currentIndex()
    if (target < 0) {
      return fail("没有可重试的章节。", true)
    }
    return this.enqueueNavigation(async (epoch) => {
      if (epoch !== this.navigationEpoch) {
        return fail("重试已被新的导航取代。", true)
      }
      if (!this.ensureMounted()) {
        return fail("阅读引擎尚未挂载。", true)
      }
      await this.rebuildSection(target)
      return this.chapterErrors.has(target)
        ? fail(this.chapterErrors.get(target) ?? "章节仍未能加载。", true)
        : { ok: true }
    })
  }

  private ensureMounted(): boolean {
    return this.mounted && this.view !== null && this.book !== null
  }

  private enqueueNavigation(
    operation: (epoch: number) => Promise<ReaderEngineResult>,
  ): Promise<ReaderEngineResult> {
    const epoch = ++this.navigationEpoch
    const run = this.navigationQueue.then(
      () => operation(epoch),
      () => operation(epoch),
    )
    this.navigationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async goToAnchor(
    payload: {
      spineIndex: number
      resourceId: string
      href: string
      anchorId: string | null
      textQuote: { exact: string; prefix: string; suffix: string } | null
      chapterProgress: number
    },
  ): Promise<ReaderEngineResult> {
    const book = this.book
    const view = this.view
    if (book === null || view === null) {
      return fail("阅读引擎尚未就绪。", true)
    }
    const index = resolvePayloadIndex(book, payload)
    if (index < 0) {
      return fail("定位指向的章节不在当前清单中。", false)
    }
    try {
      const previousDocument = this.currentContentDocument()
      await view.renderer.goTo({
        index,
        anchor: anchorForPayload(payload),
      })
      // 同 restore：跨章节 goTo 后 renderer 的当前文档已经切换，
      // 需要重新注入阅读样式（字号/字重/颜色）。
      if (this.currentContentDocument() !== previousDocument) {
        this.applyReaderStyles()
      }
      if (this.chapterErrors.has(index)) {
        return fail(this.chapterErrors.get(index) ?? "章节加载失败。", true)
      }
      return { ok: true }
    } catch (error) {
      return fail(describeError(error), true)
    }
  }

  private currentContentDocument(): Document | null {
    const contents = this.view?.renderer?.getContents?.() ?? []
    return contents[0]?.doc ?? null
  }

  private currentIndex(): number {
    const contents = this.view?.renderer?.getContents?.() ?? []
    const index = contents[0]?.index
    if (typeof index === "number" && index >= 0) {
      return index
    }
    const location = this.lastLocation
    if (
      location !== null &&
      (location.locatorType === "epub-cfi" ||
        location.locatorType === "epub-anchor")
    ) {
      return location.locatorPayload.spineIndex
    }
    return -1
  }

  private async loadChapter(index: number): Promise<string> {
    const manifest = this.manifest
    const resources = this.resources
    if (manifest === null || resources === null) {
      const fallback = createErrorChapter("阅读引擎尚未挂载。")
      return fallback.objectUrl
    }
    const token = (this.chapterTokens.get(index) ?? 0) + 1
    this.chapterTokens.set(index, token)
    this.abortChapter(index)
    const controller = new AbortController()
    this.chapterLoads.set(index, { abort: controller, token })
    for (const [otherIndex, state] of this.chapterLoads) {
      if (otherIndex !== index) {
        state.abort.abort()
        this.chapterLoads.delete(otherIndex)
      }
    }
    try {
      const built = await buildChapter({
        manifest,
        resources,
        index,
        publisherCssMode: this.settings.publisherCSSMode,
        signal: controller.signal,
      })
      if (
        controller.signal.aborted ||
        token !== this.chapterTokens.get(index)
      ) {
        this.releaseBuilt(built)
        throw abortError()
      }
      const previous = this.builtChapters.get(index)
      if (previous !== undefined) {
        this.releaseBuilt(previous)
      }
      this.builtChapters.set(index, built)
      this.chapterErrors.delete(index)
      if (this.currentIndex() === index) {
        this.hideOverlay()
      }
      return built.objectUrl
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      const message = describeError(error)
      this.chapterErrors.set(index, message)
      this.showOverlay(message, index)
      const previous = this.builtChapters.get(index)
      if (previous !== undefined) {
        this.releaseBuilt(previous)
      }
      const fallback = createErrorChapter(message)
      this.builtChapters.set(index, fallback)
      return fallback.objectUrl
    } finally {
      const state = this.chapterLoads.get(index)
      if (state?.token === token) {
        this.chapterLoads.delete(index)
      }
    }
  }

  private abortChapter(index: number): void {
    const state = this.chapterLoads.get(index)
    if (state !== undefined) {
      state.abort.abort()
      this.chapterLoads.delete(index)
    }
  }

  private unloadChapter(index: number): void {
    for (const entry of [...this.contentDocuments.values()]) { if (entry.index === index) entry.cleanup() }
    this.chapterTokens.set(index, (this.chapterTokens.get(index) ?? 0) + 1)
    this.abortChapter(index)
    const built = this.builtChapters.get(index)
    if (built !== undefined) {
      this.releaseBuilt(built)
      this.builtChapters.delete(index)
    }
    this.chapterErrors.delete(index)
  }

  private releaseBuilt(built: BuiltChapter): void {
    for (const url of built.urls) {
      URL.revokeObjectURL(url)
    }
  }

  /**
   * 当前可见章节由 buildChapter 以 critical 请求；上一章立即预取，下一章在
   * 章节后段（>=80%）再预取，避免打开即下载整段相邻内容。导航后取消离开窗口
   * 的 prefetch，避免快速翻页堆积。
   */
  private prefetchAdjacent(index: number, chapterProgress: number): void {
    const cache = this.cache
    const manifest = this.manifest
    const resources = this.resources
    if (cache === null || manifest === null || resources === null) {
      return
    }
    if (index < 0) {
      return
    }
    if (index !== this.prefetchIndex) {
      this.prefetchIndex = index
      this.prefetchNextIndex = -1
    }
    const targets = new Set<number>([index - 1])
    if (chapterProgress >= 0.8 && this.prefetchNextIndex !== index) {
      targets.add(index + 1)
      this.prefetchNextIndex = index
    }
    const keep: string[] = []
    for (const target of targets) {
      const section = manifest.formatData.spine[target]
      if (section === undefined) {
        continue
      }
      const entry = resources.bySpineItem(section)
      if (entry === null) {
        continue
      }
      keep.push(
        resourceKeyId(
          epubResourceKey(
            manifest.bookId,
            manifest.fileVersion,
            entry.resourceId,
            entry.href,
          ),
        ),
      )
      void resources.prefetch(entry)
    }
    cache.scheduler.cancelObsolete(keep, { priorities: ["prefetch"] })
  }

  private releaseAllChapters(): void {
    for (const built of this.builtChapters.values()) {
      this.releaseBuilt(built)
    }
    this.builtChapters.clear()
    this.chapterTokens.clear()
  }

  private createDocument(index: number): Promise<Document> {
    const built = this.builtChapters.get(index)
    if (built !== undefined) {
      return parseBuiltChapter(built)
    }
    return Promise.reject(new Error("章节尚未加载"))
  }

  private async rebuildSection(index: number): Promise<void> {
    const failed = this.chapterErrors.has(index)
    this.unloadChapter(index)
    this.hideOverlay()
    if (this.view === null) {
      return
    }
    const location = failed
      ? this.anchorLocation(index)
      : this.lastLocation ?? this.anchorLocation(index)
    try {
      await this.reopenView(location)
    } catch (error) {
      this.showOverlay(describeError(error), index)
    }
  }

  private anchorLocation(index: number): ReaderLocation | null {
    const section = this.manifest?.formatData.spine[index]
    if (section === undefined) {
      return null
    }
    return {
      locatorType: "epub-anchor",
      progressPercent: 0,
      locatorPayload: {
        locatorVersion: 1,
        spineIndex: index,
        resourceId: section.resourceId,
        href: section.href,
        anchorId: null,
        chapterProgress: 0,
        textQuote: null,
      },
    }
  }

  private async reopenView(location: ReaderLocation | null): Promise<void> {
    const view = this.view
    const book = this.book
    const host = this.host
    if (view === null || book === null || host === null) {
      return
    }
    view.removeEventListener("relocate", this.handleRelocate)
    view.removeEventListener("load", this.handleLoad)
    view.removeEventListener("external-link", this.handleExternalLink)
    try {
      view.close()
    } catch {
      // 损坏的 renderer 仍需重建。
    }
    view.remove()
    const next = new View()
    this.view = next
    next.style.width = "100%"
    next.style.height = "100%"
    next.style.display = "block"
    next.style.transformOrigin = "0 0"
    next.style.willChange = "transform"
    next.addEventListener("relocate", this.handleRelocate)
    next.addEventListener("load", this.handleLoad)
    next.addEventListener("external-link", this.handleExternalLink)
    this.attachViewLayer(next)
    this.applyViewAttributes()
    await next.open(book)
    this.guardRenderer(next)
    this.applyViewAttributes()
    this.applyReaderStyles()
    await next.init({
      lastLocation:
        location !== null && location.locatorType === "epub-cfi"
          ? location.locatorPayload.cfi
          : undefined,
      showTextStart: location === null,
    })
    // init 完成后 renderer 才持有新 iframe；此时再注入一次样式。
    this.applyReaderStyles()
    if (location !== null && location.locatorType === "epub-anchor") {
      const index = this.book?.indexForPayload(
        location.locatorPayload.spineIndex,
        location.locatorPayload.resourceId,
        location.locatorPayload.href,
      )
      if (index !== undefined && index >= 0) {
        await next.renderer.goTo({
          index,
          anchor: anchorForPayload(location.locatorPayload),
        })
        this.applyReaderStyles()
      }
    }
  }

  private cancelReflowRestore(): void {
    if (this.reflowTimer !== null) {
      window.clearTimeout(this.reflowTimer)
      this.reflowTimer = null
    }
  }

  private scheduleReflowRestore(target?: ReaderLocation | null): void {
    this.cancelReflowRestore()
    const location = target === undefined ? this.lastLocation : target
    this.reflowTimer = window.setTimeout(() => {
      this.reflowTimer = null
      const view = this.view
      if (view === null) {
        return
      }
      try {
        view.renderer.render()
      } catch {
        return
      }
      if (location === null) {
        return
      }
      void this.restore(location)
    }, 160)
  }

  private applyViewAttributes(): void {
    const view = this.view
    if (view === null) {
      return
    }
    const renderer = view.renderer
    if (renderer === undefined) {
      return
    }
    const hostWidth =
      this.host?.getBoundingClientRect().width ??
      this.viewport?.width ??
      0
    const hostHeight =
      this.host?.getBoundingClientRect().height ??
      this.viewport?.height ??
      0
    const width = hostWidth > 0 ? hostWidth : 720
    const height = hostHeight > 0 ? hostHeight : 960
    const layout = computeLayout(this.settings, width, height)
    view.setAttribute(
      "flow",
      this.settings.pagination === "scroll" ? "scrolled" : "paginated",
    )
    if (this.settings.animation === "light") {
      view.setAttribute("animated", "")
    } else {
      view.removeAttribute("animated")
    }
    renderer.setAttribute("flow", this.settings.pagination === "scroll" ? "scrolled" : "paginated")
    renderer.setAttribute("margin", `${layout.margin}px`)
    renderer.setAttribute("max-inline-size", `${layout.maxInlineSize}px`)
    if (layout.maxBlockSize !== null) {
      renderer.setAttribute("max-block-size", `${layout.maxBlockSize}px`)
    } else {
      renderer.removeAttribute("max-block-size")
    }
    renderer.setAttribute("max-column-count", String(layout.columns))
    renderer.setAttribute("gap", `${layout.gapPercent}%`)
    for (const doc of this.contentDocuments.keys()) {
      this.applyContentTouchAction(doc)
    }
  }

  private applyReaderStyles(): void {
    const renderer = this.view?.renderer
    if (renderer === undefined) {
      return
    }
    renderer.setStyles(["", buildReaderCss(this.settings)])
  }

  private readonly handleRelocate = (event: Event): void => {
    const detail = (event as CustomEvent<FoliateRelocateDetail>).detail
    const manifest = this.manifest
    const index =
      typeof detail.index === "number"
        ? detail.index
        : detail.section?.current
    if (manifest === null || typeof index !== "number") {
      return
    }
    const section = manifest.formatData.spine[index]
    if (section === undefined) {
      return
    }
    const fractions = this.view?.getSectionFractions() ?? []
    const renderer = this.view?.renderer
    // foliate 的 detail.fraction 是当前页终点；进度必须用页起点，否则末页会
    // 虚高到章节 100%，重排改变页数后同一段落还会回退。
    const visibleFraction =
      renderer === undefined
        ? null
        : relocateProgressFraction({
            index,
            fraction: detail.fraction,
            sectionFractions: fractions,
            scrolled: renderer.scrolled,
            page: renderer.page,
            pages: renderer.pages,
            atEnd: renderer.atEnd,
          })
    const relocateDetail =
      visibleFraction === null
        ? { ...detail, index }
        : { ...detail, index, fraction: visibleFraction }
    const location = locationFromRelocate(
      relocateDetail,
      {
        index: section.index,
        resourceId: section.resourceId,
        href: section.href,
        cfiBase: section.cfiBase,
      },
      fractions,
    )
    if (performance.now() < this.zoomGuardUntil) {
      // 缩放期间 paginator 的 page/pages 会因祖先 transform 漂移，scroll 事件
      // 可能算出错误的 fraction 和内部锚点；此时不发布位置，保留旧 CFI。
      return
    }
    this.lastLocation = location
    this.emitLocation(location)
    const chapterProgress =
      location.locatorType === "epub-cfi" ||
      location.locatorType === "epub-anchor"
        ? location.locatorPayload.chapterProgress
        : 0
    // 预取仍按“当前页读完”的位置判断，短章节在最后一页也能预取下一章。
    const endChapterProgress =
      typeof detail.fraction === "number"
        ? chapterProgressFromFractions(index, detail.fraction, fractions)
        : 0
    this.prefetchAdjacent(index, Math.max(chapterProgress, endChapterProgress))
  }

  private readonly handleLoad = (event: Event): void => {
    const detail = (event as CustomEvent<FoliateLoadDetail>).detail
    this.applyReaderStyles()
    if (detail.doc.querySelector("script, iframe, object, embed, base, form") !== null) {
      this.showOverlay("章节包含未清理的活动内容，已停止显示。", detail.index)
      return
    }
    this.bindContentDocument(detail.doc, detail.index)
    if (this.chapterErrors.has(detail.index)) {
      this.showOverlay(
        this.chapterErrors.get(detail.index) ?? "章节加载失败。",
        detail.index,
      )
    } else {
      this.hideOverlay()
    }
  }

  private readonly handleExternalLink = (event: Event): void => {
    event.preventDefault()
  }

  private emitLocation(location: ReaderLocation): void {
    let key: string
    if (location.locatorType === "epub-cfi") {
      key = `${location.locatorPayload.spineIndex}:${location.locatorPayload.cfi}:${Math.round(location.progressPercent * 10)}`
    } else if (location.locatorType === "epub-anchor") {
      key = `${location.locatorPayload.spineIndex}:${location.locatorPayload.chapterProgress}:${Math.round(location.progressPercent * 10)}`
    } else {
      key = `${location.locatorType}:${Math.round(location.progressPercent * 10)}`
    }
    if (key === this.lastEmittedKey) {
      return
    }
    this.lastEmittedKey = key
    if (this.host !== null) {
      if (location.locatorType === "epub-cfi") {
        this.host.dataset.epubCfi = location.locatorPayload.cfi
      } else {
        delete this.host.dataset.epubCfi
      }
      this.host.dataset.epubProgress = location.progressPercent.toFixed(3)
    }
    for (const listener of this.listeners) {
      try {
        listener(location)
      } catch {
        // 订阅方错误不得中断阅读引擎。
      }
    }
  }

  private showOverlay(message: string, index?: number): void {
    const host = this.host
    if (host === null) {
      return
    }
    this.hideOverlay()
    const overlay = document.createElement("div")
    overlay.setAttribute("role", "alert")
    overlay.style.position = "absolute"
    overlay.style.inset = "0"
    overlay.style.display = "flex"
    overlay.style.flexDirection = "column"
    overlay.style.alignItems = "center"
    overlay.style.justifyContent = "center"
    overlay.style.gap = "0.75rem"
    overlay.style.padding = "1.5rem"
    overlay.style.textAlign = "center"
    overlay.style.background = "var(--background, Canvas)"
    overlay.style.color = "var(--foreground, CanvasText)"
    overlay.style.zIndex = "5"
    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative"
    }
    const title = document.createElement("p")
    title.textContent = "本章节未能加载"
    title.style.margin = "0"
    title.style.fontWeight = "600"
    const description = document.createElement("p")
    description.textContent = message
    description.style.margin = "0"
    description.style.maxWidth = "32rem"
    const retry = document.createElement("button")
    retry.type = "button"
    retry.textContent = "重试"
    retry.style.border = "1px solid var(--border, currentColor)"
    retry.style.borderRadius = "0.5rem"
    retry.style.padding = "0.4rem 0.9rem"
    retry.style.background = "var(--card, transparent)"
    retry.style.color = "inherit"
    retry.style.cursor = "pointer"
    retry.addEventListener("click", () => {
      const target = index ?? this.currentIndex()
      if (target >= 0) {
        void this.retrySection(target)
      }
    })
    overlay.append(title, description, retry)
    host.append(overlay)
    this.overlay = overlay
  }

  private hideOverlay(): void {
    this.overlay?.remove()
    this.overlay = null
  }
}

export function createEpubReaderEngine(
  options?: EpubReaderEngineOptions,
): EpubReaderEngine {
  return new EpubEngine(options)
}

/** 供集成方在渲染前判断固定布局；不触发任何网络请求。 */
export function isEpubFixedLayout(manifest: EpubReaderManifest): boolean {
  return fixedLayoutReason(manifest) !== null
}

export function epubCfiIsValid(cfi: string): boolean {
  if (!CFI.isCFI.test(cfi)) {
    return false
  }
  try {
    CFI.parse(cfi)
    return true
  } catch {
    return false
  }
}
