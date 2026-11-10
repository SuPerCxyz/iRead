import { ComicManifestIndex } from "./manifest"
import {
  ComicPageError,
  isAbortError,
  type ComicVariant,
} from "./types"
import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"
import {
  isResourceCancellation,
  type ResourcePriority,
} from "../session/resource-scheduler"
import {
  comicPageKey,
  resourceKeyId,
} from "../cache/resource-key"

export interface LoadedComicPage {
  page: number
  variant: ComicVariant
  url: string
  mediaType: string
  size: number
}

interface InflightRequest {
  controller: AbortController
  promise: Promise<LoadedComicPage>
}

interface ErrorEnvelope {
  code?: unknown
  message?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readErrorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const contentType = response.headers.get("Content-Type") ?? ""
  if (!contentType.includes("json")) {
    return {}
  }
  try {
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !isRecord(payload.error)) {
      return {}
    }
    return payload.error as ErrorEnvelope
  } catch {
    return {}
  }
}

function pageErrorForStatus(
  page: number,
  status: number,
  serverCode: string,
  serverMessage: string,
): ComicPageError {
  if (status === 401) {
    return new ComicPageError(
      "unauthenticated",
      `第 ${page} 页读取失败：登录状态已失效，请重新登录。`,
      { status, retryable: true },
    )
  }
  if (status === 404) {
    return new ComicPageError(
      "not_found",
      `第 ${page} 页资源不存在。`,
      { status, retryable: false },
    )
  }
  if (status === 409) {
    if (serverCode === "variant_unavailable") {
      return new ComicPageError(
        "variant_unavailable",
        `第 ${page} 页不提供原始尺寸，已回退到适屏图片。`,
        { status, retryable: false },
      )
    }
    return new ComicPageError(
      "file_version_conflict",
      "原件版本已变化，请重新打开书籍。",
      { status, retryable: false },
    )
  }
  if (status >= 500) {
    return new ComicPageError(
      serverCode || "storage_unavailable",
      `第 ${page} 页暂时无法读取，请重试。`,
      { status, retryable: true },
    )
  }
  return new ComicPageError(
    serverCode || "http_error",
    serverMessage.length > 0
      ? serverMessage
      : `第 ${page} 页读取失败（HTTP ${status}）。`,
    { status, retryable: status === 429 },
  )
}

export interface ComicPageLoaderOptions {
  fetchImpl?: typeof fetch
  cache?: ReaderCacheRuntime | null
}

/**
 * 有界页资源缓存。
 *
 * - 同页同变体只保留一个在途请求；
 * - 导航离开时 abort 窗口外的在途请求；
 * - object URL 只在可见/预取窗口内保留，释放时 revoke；
 * - screen 是默认变体，original 只由引擎对当前页请求。
 */
export class ComicPageLoader {
  private readonly index: ComicManifestIndex
  private readonly fetchImpl: typeof fetch
  private readonly cache: ReaderCacheRuntime | null
  private readonly loaded = new Map<string, LoadedComicPage>()
  private readonly inflight = new Map<string, InflightRequest>()
  private disposed = false

  constructor(
    index: ComicManifestIndex,
    options: ComicPageLoaderOptions | typeof fetch = {},
  ) {
    this.index = index
    if (typeof options === "function") {
      this.fetchImpl = options
      this.cache = null
    } else {
      this.fetchImpl = options.fetchImpl ?? fetch
      this.cache = options.cache ?? null
    }
  }

  get(page: number, variant: ComicVariant): LoadedComicPage | null {
    return this.loaded.get(this.key(page, variant)) ?? null
  }

  load(
    page: number,
    variant: ComicVariant,
    priority: ResourcePriority = "visible",
  ): Promise<LoadedComicPage> {
    if (this.disposed) {
      return Promise.reject(
        new ComicPageError("disposed", "阅读引擎已释放。", { retryable: false }),
      )
    }
    const key = this.key(page, variant)
    const cached = this.loaded.get(key)
    if (cached !== undefined) {
      return Promise.resolve(cached)
    }
    const existing = this.inflight.get(key)
    if (existing !== undefined) {
      return existing.promise
    }
    const controller = new AbortController()
    const promise = this.resolvePage(page, variant, controller.signal, priority)
      .then((loaded) => {
        if (controller.signal.aborted || this.disposed) {
          URL.revokeObjectURL(loaded.url)
          throw new DOMException("页请求已取消", "AbortError")
        }
        this.loaded.set(key, loaded)
        return loaded
      })
      .finally(() => {
        const current = this.inflight.get(key)
        if (current?.controller === controller) {
          this.inflight.delete(key)
        }
      })
    this.inflight.set(key, { controller, promise })
    return promise
  }

  /** 只取消窗口外页面的在途请求；当前页请求不受影响。 */
  cancelOutside(keep: (page: number, variant: ComicVariant) => boolean): void {
    for (const [key, request] of this.inflight) {
      const page = this.pageOfKey(key)
      const variant = this.variantOfKey(key)
      if (!keep(page, variant)) {
        request.controller.abort()
        this.inflight.delete(key)
      }
    }
  }

  /** 释放窗口外已加载页的 object URL；返回释放数量。 */
  releaseOutside(keep: (page: number, variant: ComicVariant) => boolean): number {
    let released = 0
    for (const [key, entry] of this.loaded) {
      if (!keep(entry.page, entry.variant)) {
        URL.revokeObjectURL(entry.url)
        this.loaded.delete(key)
        released += 1
      }
    }
    return released
  }

  releasePage(page: number): void {
    for (const [key, entry] of this.loaded) {
      if (entry.page === page) {
        URL.revokeObjectURL(entry.url)
        this.loaded.delete(key)
      }
    }
    for (const [key, request] of this.inflight) {
      if (this.pageOfKey(key) === page) {
        request.controller.abort()
        this.inflight.delete(key)
      }
    }
  }

  cancelAll(): void {
    for (const request of this.inflight.values()) {
      request.controller.abort()
    }
    this.inflight.clear()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.cancelAll()
    for (const entry of this.loaded.values()) {
      URL.revokeObjectURL(entry.url)
    }
    this.loaded.clear()
  }

  private async resolvePage(
    page: number,
    variant: ComicVariant,
    signal: AbortSignal,
    priority: ResourcePriority,
  ): Promise<LoadedComicPage> {
    const cache = this.cache
    if (cache === null) {
      const direct = await this.fetchPageBlob(page, variant, signal)
      return this.toLoaded(page, variant, direct.blob, direct.mediaType)
    }
    const key = comicPageKey(
      cache.bookId,
      cache.fileVersion,
      String(page),
      variant,
    )
    const keyId = resourceKeyId(key)
    const memoryHit = cache.memory.get(keyId)
    if (memoryHit !== null) {
      if (signal.aborted) {
        throw new DOMException("页请求已取消", "AbortError")
      }
      cache.scheduler.recordCacheHit(key, "L1")
      const blob = await this.memoryBlob(memoryHit.value, memoryHit.mediaType)
      return this.toLoaded(page, variant, blob, memoryHit.mediaType)
    }
    const stored = await cache.persistent
      .readResource(key)
      .catch(() => null)
    if (signal.aborted) {
      throw new DOMException("页请求已取消", "AbortError")
    }
    if (stored !== null) {
      cache.scheduler.recordCacheHit(key, "L3")
      cache.memory.set(keyId, stored.blob, {
        mediaType: stored.mediaType,
        version: String(stored.generation),
      })
      return this.toLoaded(
        page,
        variant,
        stored.blob,
        stored.mediaType,
      )
    }
    return cache.scheduler.request(
      key,
      async (jobSignal) => {
        // generation 必须在网络请求前捕获；清理后迟到写入会被 L3 拒绝。
        const generation = await cache.persistent
          .currentGeneration()
          .catch(() => 0)
        const fetched = await this.fetchPageBlob(
          page,
          variant,
          jobSignal,
        )
        if (fetched.status !== 200) {
          throw new ComicPageError(
            "invalid_response",
            `第 ${page} 页未返回完整的 200 图片响应。`,
            { status: fetched.status, retryable: true },
          )
        }
        cache.memory.set(keyId, fetched.blob, {
          mediaType: fetched.mediaType,
        })
        await cache.persistent
          .writeResource({
            key,
            blob: fetched.blob,
            mediaType: fetched.mediaType,
            etag: fetched.etag,
            generation,
          })
          .catch(() => undefined)
        return this.toLoaded(
          page,
          variant,
          fetched.blob,
          fetched.mediaType,
        )
      },
      { signal, priority },
    )
  }

  private async memoryBlob(
    value: Blob | ArrayBuffer | Uint8Array | string,
    mediaType: string,
  ): Promise<Blob> {
    if (value instanceof Blob) {
      return value.type.length > 0
        ? value
        : new Blob([value], { type: mediaType })
    }
    if (typeof value === "string") {
      return new Blob([value], { type: mediaType })
    }
    return new Blob(
      [
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : value.slice(),
      ],
      { type: mediaType },
    )
  }

  private toLoaded(
    page: number,
    variant: ComicVariant,
    blob: Blob,
    mediaType: string,
  ): LoadedComicPage {
    return {
      page,
      variant,
      url: URL.createObjectURL(
        blob.type.length > 0
          ? blob
          : new Blob([blob], { type: mediaType }),
      ),
      mediaType: mediaType || blob.type,
      size: blob.size,
    }
  }

  private async fetchPageBlob(
    page: number,
    variant: ComicVariant,
    signal: AbortSignal,
  ): Promise<{
    blob: Blob
    mediaType: string
    status: number
    etag: string
  }> {
    const manifestPage = this.index.pageAt(page)
    if (manifestPage === null) {
      throw new ComicPageError(
        "page_not_in_manifest",
        `漫画清单缺少第 ${page} 页。`,
        { retryable: false },
      )
    }
    let url: string
    try {
      url = this.index.resourceUrl(manifestPage, variant)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `第 ${page} 页资源地址无效。`
      throw new ComicPageError("invalid_resource", message, {
        retryable: false,
        cause: error,
      })
    }
    let response: Response
    try {
      const fetchImpl = this.fetchImpl
      response = await fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "image/*" },
        signal,
      })
    } catch (error) {
      if (
        isAbortError(error) ||
        isResourceCancellation(error) ||
        signal.aborted
      ) {
        throw new DOMException("页请求已取消", "AbortError")
      }
      throw new ComicPageError(
        "network_error",
        `第 ${page} 页网络请求失败，请重试。`,
        { retryable: true, cause: error },
      )
    }
    if (!response.ok) {
      const envelope = await readErrorEnvelope(response)
      const code = typeof envelope.code === "string" ? envelope.code : ""
      const message =
        typeof envelope.message === "string" ? envelope.message : ""
      throw pageErrorForStatus(page, response.status, code, message)
    }
    const mediaType = (response.headers.get("Content-Type") ?? "").toLowerCase()
    if (mediaType.length > 0 && !mediaType.startsWith("image/")) {
      throw new ComicPageError(
        "invalid_content_type",
        `第 ${page} 页返回的内容不是图片。`,
        { status: response.status, retryable: false },
      )
    }
    let blob: Blob
    try {
      blob = await response.blob()
    } catch (error) {
      if (
        isAbortError(error) ||
        isResourceCancellation(error) ||
        signal.aborted
      ) {
        throw new DOMException("页请求已取消", "AbortError")
      }
      throw new ComicPageError(
        "network_error",
        `第 ${page} 页读取中断，请重试。`,
        { retryable: true, cause: error },
      )
    }
    if (signal.aborted) {
      throw new DOMException("页请求已取消", "AbortError")
    }
    if (blob.size === 0) {
      throw new ComicPageError(
        "empty_resource",
        `第 ${page} 页返回了空图片。`,
        { retryable: true },
      )
    }
    return {
      blob,
      mediaType: mediaType || blob.type,
      status: response.status,
      etag: response.headers.get("ETag") ?? "",
    }
  }

  private key(page: number, variant: ComicVariant): string {
    return `${page}:${variant}`
  }

  private pageOfKey(key: string): number {
    const separator = key.indexOf(":")
    const page = Number(key.slice(0, separator))
    return Number.isFinite(page) ? page : -1
  }

  private variantOfKey(key: string): ComicVariant {
    return key.endsWith(":original") ? "original" : "screen"
  }
}
