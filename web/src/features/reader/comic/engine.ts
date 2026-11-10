import type {
  ReaderCapabilities,
  ReaderEngineResult,
  ReaderViewportMetrics,
} from "../shell/engine"
import type { BookFormat } from "@/features/library/types"
import type {
  ComicPage,
  ComicReaderManifest,
  ReaderLocation,
  ReaderManifest,
} from "../types"

import { ComicManifestIndex, comicManifestIndex } from "./manifest"
import {
  adjacentPage,
  clampPage,
  comicLocation,
  computeComicBox,
  originalAvailable,
  preloadCandidates,
  progressPercent,
  visiblePages,
  visualSpread,
} from "./pagination"
import { ComicPageLoader, type LoadedComicPage } from "./resources"
import { comicPageKey, renderKeyId } from "../cache/resource-key"
import {
  COMIC_GAP_PIXELS,
  ComicReaderError,
  ComicPageError,
  isAbortError,
  normalizeComicSettings,
  type ComicReaderEngine as ComicReaderEngineContract,
  type ComicReaderEngineOptions,
  type ComicReaderSettings,
  type ComicVariant,
} from "./types"

const CAPABILITIES: ReaderCapabilities = {
  canRender: true,
  canNavigate: true,
  canSearch: false,
  canZoom: false,
  features: ["bookmarks", "settings", "page-navigation"],
  unavailableReason: "",
}

const VIEWPORT_FRAME_DELAY = 90

function fail(reason: string, retryable = false): ReaderEngineResult {
  return { ok: false, reason, retryable }
}

function describeError(error: unknown): string {
  if (error instanceof ComicReaderError || error instanceof ComicPageError) {
    return error.message
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  return "未知错误，请重试。"
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

interface PageSlot {
  element: HTMLElement
  page: number
  pending: HTMLElement | null
  error: HTMLElement | null
  image: HTMLImageElement | null
  variant: ComicVariant | null
  renderKey: string | null
}

interface PointerCandidate {
  pointerId: number
  x: number
  y: number
  startedAt: number
}

export class ComicReaderEngine implements ComicReaderEngineContract {
  private formatValue: "cbz" | "cbr"
  readonly capabilities: ReaderCapabilities = { ...CAPABILITIES }
  private settings: ComicReaderSettings
  private readonly options: ComicReaderEngineOptions
  private initialLocation: ReaderLocation | null
  private index: ComicManifestIndex | null = null
  private loader: ComicPageLoader | null = null
  private host: HTMLElement | null = null
  private root: HTMLElement | null = null
  private viewport: HTMLElement | null = null
  private status: HTMLElement | null = null
  private slots = new Map<number, PageSlot>()
  private page = 1
  private lastLocation: ReaderLocation | null = null
  private lastEmittedKey = ""
  private listeners = new Set<(location: ReaderLocation) => void>()
  private metrics: ReaderViewportMetrics | null = null
  private mounted = false
  private disposed = false
  private mountAbort: AbortController | null = null
  private mountSignal: AbortSignal | null = null
  private renderGeneration = 0
  private continuousRendered = false
  private scrollObserver: IntersectionObserver | null = null
  private viewportTimer: number | null = null
  private mobileQuery: MediaQueryList | null = null
  private pointer: PointerCandidate | null = null
  private suppressScrollUntil = 0
  private readonly onSignalAbort = (): void => {
    this.unmount()
  }

  constructor(options: ComicReaderEngineOptions | "cbz" | "cbr" = {}) {
    this.options = typeof options === "string" ? { format: options } : options
    this.formatValue = this.options.format ?? "cbz"
    this.settings = normalizeComicSettings(this.options.settings ?? null)
    this.initialLocation = this.options.initialLocation ?? null
  }

  get format(): BookFormat {
    return this.formatValue
  }

  getSettings(): ComicReaderSettings {
    return { ...this.settings }
  }

  getLocation(): ReaderLocation | null {
    return this.lastLocation
  }

  async mount(
    host: HTMLElement,
    manifest: ReaderManifest,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.disposed) {
      throw new ComicReaderError("阅读引擎已释放，不能继续挂载。", false)
    }
    if (signal.aborted) {
      throw new DOMException("挂载已取消", "AbortError")
    }
    if (manifest.format !== "cbz" && manifest.format !== "cbr") {
      throw new ComicReaderError("当前引擎只支持 CBZ/CBR 漫画。", false)
    }
    if (this.mounted) {
      this.unmount()
    }
    const index = comicManifestIndex(manifest)
    this.index = index
    this.formatValue = manifest.format
    this.host = host
    this.mounted = true
    this.mountAbort = new AbortController()
    this.mountSignal = signal
    signal.addEventListener("abort", this.onSignalAbort, { once: true })
    this.loader = new ComicPageLoader(index, {
      fetchImpl: this.options.fetchImpl ?? fetch,
      cache: this.options.cache ?? null,
    })
    this.buildDom()
    this.page = this.initialPage(manifest as ComicReaderManifest)
    this.initialLocation = null
    this.lastLocation = null
    this.lastEmittedKey = ""
    this.updateAttributes()
    this.attachInteraction()
    await this.renderCurrent()
    if (!this.mounted || signal.aborted) {
      this.unmount()
      return
    }
    this.emitLocation()
  }

  unmount(): void {
    if (!this.mounted && this.root === null) {
      return
    }
    this.mounted = false
    this.mountAbort?.abort()
    this.mountAbort = null
    this.mountSignal?.removeEventListener("abort", this.onSignalAbort)
    this.mountSignal = null
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer)
      this.viewportTimer = null
    }
    this.scrollObserver?.disconnect()
    this.scrollObserver = null
    this.root?.removeEventListener("keydown", this.handleKeyDown)
    this.root?.removeEventListener("pointerdown", this.handlePointerDown)
    this.root?.removeEventListener("pointerup", this.handlePointerUp)
    this.root?.removeEventListener("pointercancel", this.handlePointerCancel)
    window.removeEventListener("scroll", this.handleScroll, true)
    this.pointer = null
    this.loader?.dispose()
    this.loader = null
    for (const slot of this.slots.values()) {
      this.clearSlot(slot)
    }
    this.root?.remove()
    this.root = null
    this.viewport = null
    this.status = null
    this.slots.clear()
    this.host = null
    this.index = null
    this.continuousRendered = false
    this.renderGeneration += 1
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.unmount()
    this.disposed = true
    this.listeners.clear()
  }

  async restore(location: ReaderLocation): Promise<ReaderEngineResult> {
    return this.navigateTo(location)
  }

  async navigateTo(location: ReaderLocation): Promise<ReaderEngineResult> {
    if (!this.ensureMounted()) {
      return fail("阅读引擎尚未挂载。", true)
    }
    if (location.locatorType !== "comic-page") {
      return fail("当前引擎不接受该定位类型。", false)
    }
    const index = this.index
    if (index === null) {
      return fail("阅读引擎尚未就绪。", true)
    }
    const page = Math.floor(location.locatorPayload.page)
    if (!Number.isInteger(page) || page < 1 || page > index.pageCount) {
      return fail(
        `目标页码超出范围（1–${index.pageCount}）。`,
        false,
      )
    }
    this.initialLocation = null
    if (this.settings.mode === "continuous" && this.continuousRendered) {
      this.setCurrentPage(page)
      this.scrollToPage(page)
      return { ok: true }
    }
    this.page = page
    await this.renderCurrent()
    return { ok: true }
  }

  async advance(direction: "previous" | "next"): Promise<ReaderEngineResult> {
    if (!this.ensureMounted()) {
      return fail("阅读引擎尚未挂载。", true)
    }
    const index = this.index
    if (index === null) {
      return fail("阅读引擎尚未就绪。", true)
    }
    const target = adjacentPage(
      this.page,
      index.pageCount,
      this.settings.mode,
      direction === "next" ? 1 : -1,
    )
    if (target === this.page) {
      return fail(
        direction === "next" ? "已经是最后一页。" : "已经是第一页。",
        false,
      )
    }
    if (this.settings.mode === "continuous" && this.continuousRendered) {
      this.setCurrentPage(target)
      this.scrollToPage(target)
      return { ok: true }
    }
    this.page = target
    await this.renderCurrent()
    return { ok: true }
  }

  subscribeLocation(listener: (location: ReaderLocation) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  handleViewportChange(metrics: ReaderViewportMetrics): void {
    const previous = this.metrics
    this.metrics = { ...metrics }
    if (!this.mounted || this.root === null) {
      return
    }
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer)
    }
    this.viewportTimer = window.setTimeout(() => {
      this.viewportTimer = null
      if (!this.mounted) {
        return
      }
      const sizeChanged =
        previous === null ||
        previous.width !== metrics.width ||
        previous.height !== metrics.height
      this.applyViewportLayout()
      if (this.settings.mode === "continuous" && sizeChanged) {
        this.scrollToPage(this.page)
      }
    }, VIEWPORT_FRAME_DELAY)
  }

  applySettings(
    patch: Partial<ComicReaderSettings>,
  ): ComicReaderSettings {
    const previous = this.settings
    const merged: ComicReaderSettings = {
      direction:
        patch.direction === "ltr" || patch.direction === "rtl"
          ? patch.direction
          : previous.direction,
      mode:
        patch.mode === "single" ||
        patch.mode === "double" ||
        patch.mode === "continuous"
          ? patch.mode
          : previous.mode,
      fit:
        patch.fit === "screen" ||
        patch.fit === "width" ||
        patch.fit === "original"
          ? patch.fit
          : previous.fit,
      gap:
        patch.gap === "compact" ||
        patch.gap === "standard" ||
        patch.gap === "relaxed"
          ? patch.gap
          : previous.gap,
      background:
        patch.background === "inherit" ||
        patch.background === "paper" ||
        patch.background === "white" ||
        patch.background === "gray" ||
        patch.background === "midnight"
          ? patch.background
          : previous.background,
    }
    const changed = (Object.keys(merged) as (keyof ComicReaderSettings)[]).some(
      (key) => merged[key] !== previous[key],
    )
    if (!changed) {
      return this.getSettings()
    }
    this.settings = merged
    this.updateAttributes()
    if (this.mounted) {
      const modeChanged = previous.mode !== merged.mode
      const directionChanged = previous.direction !== merged.direction
      const fitChanged = previous.fit !== merged.fit
      const gapChanged = previous.gap !== merged.gap
      if (
        modeChanged ||
        directionChanged ||
        fitChanged ||
        gapChanged ||
        this.settings.mode === "continuous"
      ) {
        void this.renderCurrent()
      } else {
        this.applyViewportLayout()
      }
      this.emitLocation()
    }
    return this.getSettings()
  }

  async retry(page?: number): Promise<ReaderEngineResult> {
    if (!this.ensureMounted()) {
      return fail("阅读引擎尚未挂载。", true)
    }
    const target = clampPage(page ?? this.page, this.index?.pageCount ?? 1)
    this.loader?.releasePage(target)
    const slot = this.slots.get(target)
    if (this.settings.mode === "continuous" && slot !== undefined) {
      this.clearSlot(slot)
      await this.loadSlot(slot, this.renderGeneration)
      return { ok: true }
    }
    this.page = target
    await this.renderCurrent()
    return { ok: true }
  }

  private ensureMounted(): boolean {
    return (
      this.mounted &&
      this.root !== null &&
      this.viewport !== null &&
      this.index !== null &&
      this.loader !== null
    )
  }

  private initialPage(manifest: ComicReaderManifest): number {
    const initial = this.initialLocation
    if (
      initial !== null &&
      initial.locatorType === "comic-page" &&
      Number.isFinite(initial.locatorPayload.page)
    ) {
      return clampPage(initial.locatorPayload.page, manifest.formatData.pageCount)
    }
    return 1
  }

  private buildDom(): void {
    const host = this.host
    if (host === null) {
      return
    }
    const root = createElement("div", "iread-comic-reader")
    root.tabIndex = 0
    root.setAttribute("role", "region")
    root.setAttribute("aria-label", "漫画阅读")
    const viewport = createElement("div", "iread-comic-reader__viewport")
    viewport.setAttribute("data-reader-comic-viewport", "")
    root.append(viewport)
    host.replaceChildren(root)
    this.root = root
    this.viewport = viewport
  }

  private updateAttributes(): void {
    const root = this.root
    if (root === null) {
      return
    }
    root.setAttribute("data-direction", this.settings.direction)
    root.setAttribute("data-mode", this.settings.mode)
    root.setAttribute("data-fit", this.settings.fit)
    root.setAttribute("data-gap", this.settings.gap)
    root.setAttribute("data-background", this.settings.background)
    root.setAttribute("data-current-page", String(this.page))
    root.setAttribute("data-page-count", String(this.index?.pageCount ?? 0))
    root.setAttribute("data-mobile", this.isMobile() ? "true" : "false")
  }

  private isMobile(): boolean {
    if (this.mobileQuery === null) {
      this.mobileQuery = window.matchMedia("(pointer: coarse)")
    }
    return this.mobileQuery.matches || navigator.maxTouchPoints > 0
  }

  private viewportSize(): { width: number; height: number } {
    const metrics = this.metrics
    const rect = this.host?.getBoundingClientRect()
    const width =
      metrics !== null && metrics.width > 0
        ? metrics.width
        : rect !== undefined && rect.width > 0
          ? rect.width
          : window.innerWidth
    const height =
      metrics !== null && metrics.height > 0
        ? metrics.height
        : rect !== undefined && rect.height > 0
          ? rect.height
          : window.innerHeight
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    }
  }

  private async renderCurrent(): Promise<void> {
    if (!this.ensureMounted()) {
      return
    }
    const generation = ++this.renderGeneration
    this.updateAttributes()
    this.setStatus(null)
    this.maybeOriginalNotice()
    if (this.settings.mode === "continuous") {
      await this.renderContinuous(generation)
    } else {
      await this.renderStatic(generation)
    }
    if (generation === this.renderGeneration) {
      this.releaseFarPages()
      this.emitLocation()
    }
  }

  private async renderStatic(generation: number): Promise<void> {
    const index = this.index
    const viewport = this.viewport
    if (index === null || viewport === null) {
      return
    }
    this.scrollObserver?.disconnect()
    this.scrollObserver = null
    this.continuousRendered = false
    const pages =
      this.settings.mode === "double"
        ? visualSpread(this.page, index.pageCount, this.settings.direction)
        : [this.page]
    const spread = createElement("div", "iread-comic-reader__spread")
    spread.setAttribute("data-spread-start", String(Math.min(...pages)))
    spread.setAttribute("data-spread-end", String(Math.max(...pages)))
    for (const slot of this.slots.values()) {
      this.clearSlot(slot)
    }
    this.slots.clear()
    const loads: Promise<void>[] = []
    for (const page of pages) {
      const slot = this.createSlot(page, generation)
      spread.append(slot.element)
      this.slots.set(page, slot)
      loads.push(this.loadSlot(slot, generation))
    }
    viewport.replaceChildren(spread)
    this.cancelFarInFlight()
    this.prefetchNeighbors()
    await Promise.all(loads)
  }

  private async renderContinuous(generation: number): Promise<void> {
    const index = this.index
    const viewport = this.viewport
    if (index === null || viewport === null) {
      return
    }
    this.scrollObserver?.disconnect()
    for (const slot of this.slots.values()) {
      this.clearSlot(slot)
    }
    this.slots.clear()
    const container = createElement("div", "iread-comic-reader__continuous")
    for (let page = 1; page <= index.pageCount; page += 1) {
      const slot = this.createSlot(page, generation)
      container.append(slot.element)
      this.slots.set(page, slot)
    }
    viewport.replaceChildren(container)
    this.continuousRendered = true
    this.updateCurrentMarker()
    this.observeContinuous(container, generation)
    await this.loadContinuousWindow(generation, true)
    if (this.page > 1) {
      this.scrollToPage(this.page)
    }
  }

  private observeContinuous(container: HTMLElement, generation: number): void {
    if (typeof IntersectionObserver === "undefined") {
      return
    }
    const viewport = this.viewport
    if (viewport === null) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (generation !== this.renderGeneration) {
          return
        }
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page)
          const slot = this.slots.get(page)
          if (slot !== undefined) {
            slot.element.setAttribute(
              "data-visible",
              entry.isIntersecting ? "true" : "false",
            )
            if (entry.isIntersecting && slot.image === null) {
              void this.loadSlot(slot, generation)
            }
          }
        }
        this.releaseFarPages()
      },
      { root: null, rootMargin: "100% 0px" },
    )
    this.scrollObserver = observer
    for (const slot of this.slots.values()) {
      observer.observe(slot.element)
    }
    container.setAttribute("data-observer", "on")
  }

  private async loadContinuousWindow(
    generation: number,
    includeCurrent: boolean,
  ): Promise<void> {
    const index = this.index
    if (index === null) {
      return
    }
    const candidates = new Set(
      preloadCandidates(
        this.page,
        index.pageCount,
        this.settings,
        !this.isMobile(),
      ),
    )
    if (includeCurrent) {
      candidates.add(this.page)
    }
    this.cancelFarInFlight()
    const loads: Promise<void>[] = []
    for (const page of candidates) {
      const slot = this.slots.get(page)
      if (slot !== undefined && slot.image === null) {
        loads.push(this.loadSlot(slot, generation))
      }
    }
    await Promise.all(loads)
  }

  private createSlot(page: number, generation: number): PageSlot {
    const element = createElement("div", "iread-comic-reader__page")
    element.setAttribute("data-page", String(page))
    element.setAttribute("data-state", "pending")
    element.setAttribute("data-generation", String(generation))
    const pending = this.createPendingElement(page)
    element.append(pending)
    return {
      element,
      page,
      pending,
      error: null,
      image: null,
      variant: null,
      renderKey: null,
    }
  }

  private createPendingElement(page: number): HTMLElement {
    const pending = createElement(
      "div",
      "iread-comic-reader__page-pending",
      `正在加载第 ${page} 页…`,
    )
    pending.setAttribute("role", "status")
    const spacer = this.createPlaceholderSpacer(page)
    if (spacer !== null) {
      pending.append(spacer)
    }
    return pending
  }

  private resetSlotToPending(slot: PageSlot): void {
    this.clearSlot(slot)
    slot.variant = null
    slot.element.removeAttribute("data-variant")
    slot.element.setAttribute("data-state", "pending")
    const pending = this.createPendingElement(slot.page)
    slot.pending = pending
    slot.element.append(pending)
  }

  /**
   * 连续模式的未加载页必须有真实高度，否则 IntersectionObserver 会把
   * 全部占位视为首屏可见并预取整本。这里用无网络、无样式的空 SVG
   * 只预留布局高度，不伪造页面内容。
   */
  private createPlaceholderSpacer(page: number): SVGSVGElement | null {
    const manifestPage = this.index?.pageAt(page) ?? null
    if (manifestPage === null) {
      return null
    }
    const size = this.viewportSize()
    const box = computeComicBox(
      manifestPage,
      {
        ...this.settings,
        fit: this.fitForVariant(this.variantForPage(manifestPage)),
      },
      size.width,
      size.height,
      COMIC_GAP_PIXELS[this.settings.gap],
    )
    const spacer = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    )
    spacer.setAttribute("class", "iread-comic-reader__page-placeholder")
    spacer.setAttribute("aria-hidden", "true")
    spacer.setAttribute("focusable", "false")
    spacer.setAttribute("width", "1")
    spacer.setAttribute("height", String(box.height))
    spacer.setAttribute("data-placeholder-height", String(box.height))
    return spacer
  }

  private async loadSlot(slot: PageSlot, generation: number): Promise<void> {
    const index = this.index
    const loader = this.loader
    if (index === null || loader === null) {
      return
    }
    if (generation !== this.renderGeneration) {
      return
    }
    const manifestPage = index.pageAt(slot.page)
    if (manifestPage === null) {
      this.showSlotError(
        slot,
        `漫画清单缺少第 ${slot.page} 页。`,
        false,
      )
      return
    }
    const variant = this.variantForPage(manifestPage)
    if (slot.image !== null && slot.variant === variant) {
      const cache = this.options.cache
      if (cache !== null && cache !== undefined) {
        cache.scheduler.recordCacheHit(
          comicPageKey(
            cache.bookId,
            cache.fileVersion,
            String(slot.page),
            variant,
          ),
          "L2",
        )
      }
      return
    }
    slot.variant = variant
    try {
      const loaded = await loader.load(
        slot.page,
        variant,
        slot.page === this.page ? "critical" : "visible",
      )
      if (
        generation !== this.renderGeneration ||
        slot.element.dataset.generation !== String(generation) ||
        !slot.element.isConnected
      ) {
        return
      }
      this.applyLoadedPage(slot, loaded, manifestPage)
    } catch (error) {
      if (isAbortError(error) || generation !== this.renderGeneration) {
        return
      }
      if (
        variant === "original" &&
        error instanceof ComicPageError &&
        error.code === "variant_unavailable"
      ) {
        this.setStatus(
          `第 ${slot.page} 页不提供原始尺寸，已使用适屏图片。`,
        )
        try {
          const fallback = await loader.load(slot.page, "screen")
          if (generation !== this.renderGeneration) {
            return
          }
          this.applyLoadedPage(slot, fallback, manifestPage)
          return
        } catch (fallbackError) {
          if (
            isAbortError(fallbackError) ||
            generation !== this.renderGeneration
          ) {
            return
          }
          this.showSlotError(slot, describeError(fallbackError), true)
          return
        }
      }
      this.showSlotError(
        slot,
        describeError(error),
        error instanceof ComicPageError ? error.retryable : true,
      )
    }
  }

  private variantForPage(page: ComicPage): ComicVariant {
    if (
      this.settings.fit === "original" &&
      page.page === this.page &&
      originalAvailable(page)
    ) {
      return "original"
    }
    return "screen"
  }

  private fitForVariant(variant: ComicVariant): ComicReaderSettings["fit"] {
    if (variant === "original") {
      return "original"
    }
    return this.settings.fit === "original" ? "screen" : this.settings.fit
  }

  private applyLoadedPage(
    slot: PageSlot,
    loaded: LoadedComicPage,
    manifestPage: ComicPage,
  ): void {
    const image = document.createElement("img")
    image.className = "iread-comic-reader__image"
    image.alt = `第 ${slot.page} 页`
    image.draggable = false
    image.decoding = "async"
    image.loading = "eager"
    image.setAttribute("data-variant", loaded.variant)
    image.src = loaded.url
    image.addEventListener("error", () => {
      if (slot.image !== image || !slot.element.isConnected) {
        return
      }
      this.loader?.releasePage(slot.page)
      this.showSlotError(slot, `第 ${slot.page} 页图片解码失败。`, true)
    })
    this.applyImageBox(image, manifestPage, loaded.variant)
    this.clearSlot(slot)
    slot.image = image
    slot.variant = loaded.variant
    slot.element.setAttribute("data-state", "ready")
    slot.element.setAttribute("data-variant", loaded.variant)
    slot.element.append(image)
    this.registerRenderedPage(
      slot,
      image,
      Math.max(1, image.width * image.height * 4),
    )
    this.updateCurrentMarker()
  }

  /**
   * 把当前可见/邻页已解码的 <img> 注册进 L2。释放时移除 src 与元素，
   * 让浏览器尽早回收解码位图；object URL 仍由 ComicPageLoader 管理。
   */
  private registerRenderedPage(
    slot: PageSlot,
    image: HTMLImageElement,
    bytes: number,
  ): void {
    const cache = this.options.cache
    if (cache === null || cache === undefined) {
      return
    }
    const variant = slot.variant ?? "screen"
    const key = renderKeyId({
      resource: comicPageKey(
        cache.bookId,
        cache.fileVersion,
        String(slot.page),
        variant,
      ),
      styleRevision: `${this.settings.mode}:${this.settings.direction}:${this.settings.fit}`,
      viewport: {
        width: this.metrics?.width ?? this.host?.clientWidth ?? 0,
        height: this.metrics?.height ?? this.host?.clientHeight ?? 0,
      },
      zoom: 1,
    })
    slot.renderKey = key
    cache.render.register(
      key,
      { page: slot.page },
      {
        bytes,
        kind: "comic-page",
        protectMs: cache.budget.departureProtectionMs,
        release: () => {
          if (slot.image !== image) {
            return
          }
          slot.image = null
          image.removeAttribute("src")
          image.remove()
        },
      },
    )
  }

  private applyImageBox(
    image: HTMLImageElement,
    page: ComicPage,
    variant: ComicVariant,
  ): void {
    const size = this.viewportSize()
    const box = computeComicBox(
      page,
      { ...this.settings, fit: this.fitForVariant(variant) },
      size.width,
      size.height,
      COMIC_GAP_PIXELS[this.settings.gap],
    )
    image.width = box.width
    image.height = box.height
    image.setAttribute("data-rendered-width", String(box.width))
    image.setAttribute("data-rendered-height", String(box.height))
  }

  private clearSlot(slot: PageSlot): void {
    if (slot.renderKey !== null) {
      const key = slot.renderKey
      slot.renderKey = null
      const cache = this.options.cache
      cache?.render.release(key)
    }
    slot.pending?.remove()
    slot.pending = null
    slot.error?.remove()
    slot.error = null
    slot.image?.remove()
    slot.image = null
  }

  private showSlotError(
    slot: PageSlot,
    message: string,
    retryable: boolean,
  ): void {
    this.clearSlot(slot)
    const error = createElement("div", "iread-comic-reader__page-error")
    error.setAttribute("role", "alert")
    error.setAttribute("data-page", String(slot.page))
    const text = createElement("p", "iread-comic-reader__page-error-text", message)
    error.append(text)
    if (retryable) {
      const retry = createElement("button", "iread-comic-reader__retry", "重试")
      retry.type = "button"
      retry.setAttribute("data-page", String(slot.page))
      retry.addEventListener("click", () => {
        void this.retry(slot.page)
      })
      error.append(retry)
    }
    slot.error = error
    slot.element.removeAttribute("data-variant")
    slot.element.setAttribute("data-state", "error")
    slot.element.append(error)
  }

  private updateCurrentMarker(): void {
    for (const [page, slot] of this.slots) {
      if (page === this.page) {
        slot.element.setAttribute("data-current", "true")
        slot.element.setAttribute("aria-current", "page")
      } else {
        slot.element.removeAttribute("data-current")
        slot.element.removeAttribute("aria-current")
      }
    }
    this.root?.setAttribute("data-current-page", String(this.page))
    const current = this.slots.get(this.page)
    if (current?.variant !== null && current?.variant !== undefined) {
      this.root?.setAttribute("data-variant", current.variant)
    } else {
      this.root?.removeAttribute("data-variant")
    }
  }

  private applyViewportLayout(): void {
    const index = this.index
    if (index === null) {
      return
    }
    for (const slot of this.slots.values()) {
      const page = index.pageAt(slot.page)
      if (page === null) {
        continue
      }
      if (slot.image !== null) {
        this.applyImageBox(slot.image, page, slot.variant ?? "screen")
      } else {
        const spacer = slot.element.querySelector(
          ".iread-comic-reader__page-placeholder",
        )
        if (spacer !== null) {
          const size = this.viewportSize()
          const box = computeComicBox(
            page,
            {
              ...this.settings,
              fit: this.fitForVariant(this.variantForPage(page)),
            },
            size.width,
            size.height,
            COMIC_GAP_PIXELS[this.settings.gap],
          )
          spacer.setAttribute("height", String(box.height))
          spacer.setAttribute("data-placeholder-height", String(box.height))
        }
      }
    }
    this.updateCurrentMarker()
  }

  private releaseFarPages(): void {
    const index = this.index
    const loader = this.loader
    if (index === null || loader === null) {
      return
    }
    const keep = this.keepPages()
    if (this.settings.mode === "continuous") {
      for (const [page, slot] of this.slots) {
        if (page !== this.page && slot.image !== null && !keep.has(page)) {
          this.resetSlotToPending(slot)
        }
      }
    }
    const keepOriginal = (page: number): boolean =>
      page === this.page || this.slots.get(page)?.variant === "original"
    loader.releaseOutside((page, variant) =>
      variant === "screen" ? keep.has(page) : keepOriginal(page),
    )
    loader.cancelOutside((page, variant) =>
      variant === "screen" ? keep.has(page) : keepOriginal(page),
    )
  }

  private cancelFarInFlight(): void {
    const index = this.index
    const loader = this.loader
    if (index === null || loader === null) {
      return
    }
    const keep = this.keepPages()
    const keepOriginal = (page: number): boolean =>
      page === this.page || this.slots.get(page)?.variant === "original"
    loader.cancelOutside((page, variant) =>
      variant === "screen" ? keep.has(page) : keepOriginal(page),
    )
  }

  /** 屏幕内页 + 前后预取窗口 + 上一页；original 变体只保留当前页。 */
  private keepPages(): Set<number> {
    const index = this.index
    if (index === null) {
      return new Set()
    }
    const keep = new Set(
      preloadCandidates(
        this.page,
        index.pageCount,
        this.settings,
        !this.isMobile(),
      ),
    )
    keep.add(this.page)
    const previous = adjacentPage(
      this.page,
      index.pageCount,
      this.settings.mode,
      -1,
    )
    if (previous !== this.page) {
      for (const page of visiblePages(
        previous,
        index.pageCount,
        this.settings.mode,
        this.settings.direction,
      )) {
        keep.add(page)
      }
    }
    if (this.settings.mode === "continuous") {
      for (const slot of this.slots.values()) {
        if (slot.element.dataset.visible === "true") {
          keep.add(slot.page)
        }
      }
    }
    return keep
  }

  private prefetchNeighbors(): void {
    const index = this.index
    const loader = this.loader
    if (index === null || loader === null) {
      return
    }
    const visible = new Set(
      visiblePages(
        this.page,
        index.pageCount,
        this.settings.mode,
        this.settings.direction,
      ),
    )
    for (const page of preloadCandidates(
      this.page,
      index.pageCount,
      this.settings,
      !this.isMobile(),
    )) {
      if (visible.has(page) || index.pageAt(page) === null) {
        continue
      }
      void loader.load(page, "screen", "prefetch").catch(() => {
        // 预取失败不改变当前页显示；用户翻到该页时会得到局部重试。
      })
    }
  }

  private maybeOriginalNotice(): void {
    if (this.settings.fit !== "original") {
      return
    }
    const page = this.index?.pageAt(this.page) ?? null
    if (page !== null && !originalAvailable(page)) {
      this.setStatus(
        `第 ${this.page} 页超过原始尺寸限制，已使用适屏图片。`,
      )
    }
  }

  private setStatus(message: string | null): void {
    if (this.status !== null) {
      this.status.remove()
      this.status = null
    }
    const root = this.root
    if (message === null || root === null) {
      root?.removeAttribute("data-status")
      return
    }
    const status = createElement("p", "iread-comic-reader__status", message)
    status.setAttribute("role", "status")
    root.prepend(status)
    root.setAttribute("data-status", "notice")
    this.status = status
  }

  private scrollToPage(page: number): void {
    const slot = this.slots.get(page)
    if (slot === undefined) {
      return
    }
    // 程序化滚动期间的异步 scroll 事件可能带着旧布局；先让目标页稳定下来，
    // 避免把用户刚跳到的页又“读”回中间页。
    this.suppressScrollUntil = performance.now() + 500
    let node = slot.element.parentElement
    let scrolled = false
    while (node !== null) {
      const overflowY = window.getComputedStyle(node).overflowY
      if (overflowY === "auto" || overflowY === "scroll") {
        const current = slot.element.getBoundingClientRect()
        const container = node.getBoundingClientRect()
        node.scrollTop += current.top - container.top
        scrolled = true
      }
      node = node.parentElement
    }
    if (!scrolled) {
      slot.element.scrollIntoView({ block: "start", inline: "nearest" })
    }
  }

  private emitLocation(): void {
    const index = this.index
    if (index === null) {
      return
    }
    const location = comicLocation(this.page, index.pageCount, this.settings)
    this.lastLocation = location
    if (location.locatorType !== "comic-page") {
      return
    }
    const payload = location.locatorPayload
    const key = [
      payload.page,
      payload.direction,
      payload.mode,
      payload.fit,
      progressPercent(this.page, index.pageCount).toFixed(3),
    ].join(":")
    if (key === this.lastEmittedKey) {
      return
    }
    this.lastEmittedKey = key
    for (const listener of this.listeners) {
      try {
        listener(location)
      } catch {
        // 订阅方错误不得中断阅读引擎。
      }
    }
  }

  private setCurrentPage(page: number): void {
    const index = this.index
    if (index === null) {
      return
    }
    const normalized = clampPage(page, index.pageCount)
    if (normalized === this.page) {
      this.updateCurrentMarker()
      return
    }
    const previous = this.page
    this.page = normalized
    this.updateCurrentMarker()
    this.emitLocation()
    if (this.settings.mode === "continuous") {
      this.setStatus(null)
      this.maybeOriginalNotice()
      if (this.settings.fit === "original") {
        this.refreshOriginalForPageChange(previous)
      }
      void this.loadContinuousWindow(this.renderGeneration, false)
      this.releaseFarPages()
    }
  }

  private refreshOriginalForPageChange(previous: number): void {
    const index = this.index
    const loader = this.loader
    if (index === null || loader === null) {
      return
    }
    const previousPage = index.pageAt(previous)
    const previousSlot = this.slots.get(previous)
    if (
      previousPage !== null &&
      previousSlot !== undefined &&
      previousSlot.variant === "original"
    ) {
      void loader
        .load(previous, "screen")
        .then((loaded) => {
          if (
            previousSlot.element.isConnected &&
            previousSlot.variant === "original"
          ) {
            this.applyLoadedPage(previousSlot, loaded, previousPage)
          }
        })
        .catch(() => {
          // 降级屏幕图失败时保留原错误/占位，不伪造页面。
        })
    }
    const currentPage = index.pageAt(this.page)
    const currentSlot = this.slots.get(this.page)
    if (currentPage !== null && currentSlot !== undefined) {
      const variant = this.variantForPage(currentPage)
      if (variant === currentSlot.variant && currentSlot.image !== null) {
        return
      }
      void loader
        .load(this.page, variant)
        .then((loaded) => {
          if (currentSlot.element.isConnected) {
            this.applyLoadedPage(currentSlot, loaded, currentPage)
          }
        })
        .catch(() => {
          // 局部加载失败由重试按钮处理。
        })
    }
  }

  private handleScrolled(): void {
    if (
      this.settings.mode !== "continuous" ||
      this.slots.size === 0 ||
      performance.now() < this.suppressScrollUntil
    ) {
      return
    }
    const host = this.host
    if (host === null) {
      return
    }
    const hostRect = host.getBoundingClientRect()
    const visibleTop = hostRect.top + Math.min(80, hostRect.height * 0.2)
    let bestPage = this.page
    let bestDistance = Number.POSITIVE_INFINITY
    for (const [page, slot] of this.slots) {
      const rect = slot.element.getBoundingClientRect()
      const visible =
        rect.bottom > hostRect.top && rect.top < hostRect.bottom
      slot.element.setAttribute("data-visible", visible ? "true" : "false")
      const distance = Math.abs(rect.top - visibleTop)
      if (rect.bottom > hostRect.top && distance < bestDistance) {
        bestDistance = distance
        bestPage = page
      }
    }
    if (bestPage !== this.page) {
      this.setCurrentPage(bestPage)
    }
  }

  private readonly handleScroll = (): void => {
    this.handleScrolled()
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (
      this.options.keyboardNavigation === false ||
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return
    }
    const target = event.target
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, button, a[href], [contenteditable='true']") !== null
    ) {
      return
    }
    const rtl = this.settings.direction === "rtl"
    let direction: "previous" | "next"
    switch (event.key) {
      case "ArrowLeft":
        direction = rtl ? "next" : "previous"
        break
      case "ArrowRight":
        direction = rtl ? "previous" : "next"
        break
      case "ArrowDown":
      case "PageDown":
        direction = "next"
        break
      case "ArrowUp":
      case "PageUp":
        direction = "previous"
        break
      case " ":
        direction = event.shiftKey ? "previous" : "next"
        break
      case "Home":
        this.page = 1
        void this.renderCurrent()
        event.preventDefault()
        return
      case "End":
        this.page = this.index?.pageCount ?? 1
        void this.renderCurrent()
        event.preventDefault()
        return
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    this.requestNavigate(direction)
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (
      this.options.tapNavigation !== true ||
      event.pointerType === "mouse" && event.button !== 0
    ) {
      return
    }
    this.pointer = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: Date.now(),
    }
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const candidate = this.pointer
    this.pointer = null
    if (candidate === null || candidate.pointerId !== event.pointerId) {
      return
    }
    if (Date.now() - candidate.startedAt > 600) {
      return
    }
    if (
      Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > 12
    ) {
      return
    }
    const target = event.target
    if (
      target instanceof Element &&
      target.closest("button, a[href], input, textarea, select, [role='button']") !== null
    ) {
      return
    }
    const rect = this.root?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0) {
      return
    }
    const ratio = (event.clientX - rect.left) / rect.width
    if (ratio < 0.3) {
      this.requestNavigate(
        this.settings.direction === "rtl" ? "next" : "previous",
      )
    } else if (ratio > 0.7) {
      this.requestNavigate(
        this.settings.direction === "rtl" ? "previous" : "next",
      )
    } else {
      this.options.onToggleToolbarsRequest?.()
    }
  }

  private readonly handlePointerCancel = (): void => {
    this.pointer = null
  }

  private attachInteraction(): void {
    const root = this.root
    if (root === null) {
      return
    }
    root.addEventListener("keydown", this.handleKeyDown)
    root.addEventListener("pointerdown", this.handlePointerDown)
    root.addEventListener("pointerup", this.handlePointerUp)
    root.addEventListener("pointercancel", this.handlePointerCancel)
    window.addEventListener("scroll", this.handleScroll, true)
  }

  private requestNavigate(direction: "previous" | "next"): void {
    if (this.options.onNavigateRequest !== undefined) {
      this.options.onNavigateRequest(direction)
      return
    }
    void this.advance(direction)
  }
}

export function createComicReaderEngine(
  options?: ComicReaderEngineOptions | "cbz" | "cbr",
): ComicReaderEngineContract {
  return new ComicReaderEngine(options)
}
