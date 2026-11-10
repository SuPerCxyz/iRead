import type {
  EpubReaderManifest,
  EpubResource,
  EpubSpineItem,
} from "../types"
import {
  isResourceCancellation,
  type ResourcePriority,
} from "../session/resource-scheduler"
import {
  epubResourceKey,
  resourceKeyId,
  type ResourceKey,
} from "../cache/resource-key"
import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"
import {
  EpubChapterError,
  EpubResourceError,
} from "./types"

export interface ResolvedArchiveHref {
  path: string
  fragment: string
  external: boolean
}

export interface EpubResourceEntry extends EpubResource {
  resourceId: string
}

export interface ResourcePayload {
  blob: Blob
  mediaType: string
}

/** 网络不可达（区别于服务端 HTTP 错误），用于回退到已预取缓存。 */
class EpubNetworkFailure extends EpubResourceError {}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_DIRECT_RESOURCES = 128

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

function normalizePath(value: string): string {
  let path = value.trim()
  if (path.startsWith("./")) {
    path = path.slice(2)
  }
  if (path.startsWith("/")) {
    path = path.slice(1)
  }
  return safeDecode(path)
}

function isExternalHref(href: string): boolean {
  return (
    href.startsWith("//") ||
    /^(?!blob:)[a-z][a-z0-9+.-]*:/i.test(href)
  )
}

/**
 * 把章节/资源内的 href 解析成规范化归档路径。外部 URI 只做识别，
 * 不拼接服务器地址，也不交给 iframe 直接请求。
 */
export function resolveArchiveHref(
  basePath: string,
  href: string,
): ResolvedArchiveHref | null {
  const raw = href.trim()
  if (raw.length === 0) {
    return { path: basePath, fragment: "", external: false }
  }
  if (isExternalHref(raw)) {
    return { path: raw, fragment: "", external: true }
  }
  if (raw.startsWith("#")) {
    return {
      path: basePath,
      fragment: safeDecode(raw.slice(1)),
      external: false,
    }
  }
  try {
    const base = new URL(
      `https://epub.invalid/${encodePath(basePath)}`,
    )
    const resolved = new URL(raw, base)
    resolved.search = ""
    let path = safeDecode(resolved.pathname)
    if (path.startsWith("/")) {
      path = path.slice(1)
    }
    return {
      path,
      fragment: safeDecode(resolved.hash.startsWith("#") ? resolved.hash.slice(1) : ""),
      external: false,
    }
  } catch {
    return null
  }
}

export function fragmentElement(
  doc: Document,
  fragment: string,
): Element | null {
  if (fragment.length === 0) {
    return null
  }
  const decoded = safeDecode(fragment)
  const direct = doc.getElementById(decoded)
  if (direct !== null) {
    return direct
  }
  try {
    return doc.querySelector(`[id="${CSS.escape(decoded)}"]`)
  } catch {
    return null
  }
}

export class EpubResourceClient {
  private readonly bookId: string
  private readonly fileVersion: string
  private readonly cache: ReaderCacheRuntime | null
  private readonly byId = new Map<string, EpubResourceEntry>()
  private readonly byHref = new Map<string, EpubResourceEntry>()
  private readonly byLowerHref = new Map<string, EpubResourceEntry | null>()
  private readonly byBasename = new Map<string, EpubResourceEntry | null>()
  /** 仅无调度器（独立引擎/单测）时用于合并同资源请求。 */
  private readonly direct = new Map<string, Promise<ResourcePayload>>()
  /** 已预取但尚未被真实阅读消费的资源；首次真实读取会在线校验。 */
  private readonly speculative = new Set<string>()

  constructor(
    manifest: EpubReaderManifest,
    options: { cache?: ReaderCacheRuntime | null } = {},
  ) {
    this.bookId = manifest.bookId
    this.fileVersion = manifest.fileVersion
    this.cache = options.cache ?? null
    for (const [resourceId, resource] of Object.entries(
      manifest.formatData.resources,
    )) {
      const entry: EpubResourceEntry = { ...resource, resourceId }
      this.byId.set(resourceId, entry)
      this.byHref.set(resource.href, entry)
      const lower = resource.href.toLowerCase()
      this.byLowerHref.set(
        lower,
        this.byLowerHref.has(lower) ? null : entry,
      )
      const segments = resource.href.split("/")
      const base = segments[segments.length - 1] ?? ""
      if (base.length > 0) {
        this.byBasename.set(
          base.toLowerCase(),
          this.byBasename.has(base.toLowerCase()) ? null : entry,
        )
      }
    }
  }

  bySpineItem(item: EpubSpineItem): EpubResourceEntry | null {
    return this.byId.get(item.resourceId) ?? null
  }

  byResourceId(resourceId: string): EpubResourceEntry | null {
    return this.byId.get(resourceId) ?? null
  }

  resolve(path: string): EpubResourceEntry | null {
    const normalized = normalizePath(path)
    const exact = this.byHref.get(normalized)
    if (exact !== undefined) {
      return exact
    }
    const lower = this.byLowerHref.get(normalized.toLowerCase())
    if (lower !== undefined) {
      return lower
    }
    const segments = normalized.split("/")
    const base = segments[segments.length - 1] ?? ""
    return this.byBasename.get(base.toLowerCase()) ?? null
  }

  private urlFor(entry: EpubResourceEntry): string {
    return `/api/v1/books/${encodeURIComponent(
      this.bookId,
    )}/versions/${encodeURIComponent(
      this.fileVersion,
    )}/resources/${encodeURIComponent(entry.resourceId)}`
  }

  private keyFor(entry: EpubResourceEntry): ResourceKey {
    return epubResourceKey(
      this.bookId,
      this.fileVersion,
      entry.resourceId,
      entry.href,
    )
  }

  /**
   * 可见章节及其 CSS/图片/字体默认 critical；相邻章节预取显式传 prefetch。
   * 有会话缓存时统一走 scheduler，同 key 在途去重，消费者取消不误伤共享资源。
   *
   * 预取是投机的：预取章节首次真实打开时先尝试网络校验（避免把过期/预取
   * 结果当成已读内容），网络不可达再回退到 L1/L3，因此离线重开仍可用。
   */
  async get(
    entry: EpubResourceEntry,
    signal?: AbortSignal,
    priority: ResourcePriority = "critical",
  ): Promise<ResourcePayload> {
    const cache = this.cache
    if (cache === null) {
      return this.getDirect(entry, signal)
    }
    const key = this.keyFor(entry)
    const keyId = resourceKeyId(key)
    const realRead = priority !== "prefetch"
    if (realRead && this.speculative.has(keyId)) {
      this.speculative.delete(keyId)
      cache.scheduler.cancel(key, "revalidate")
      return this.requestNetworkFirst(entry, signal, priority, cache)
    }
    const cached = await this.readCachedPayload(entry, signal, cache)
    if (cached !== null) {
      return cached
    }
    return this.requestNetworkFirst(entry, signal, priority, cache)
  }

  /** 相邻章节主资源预取；失败静默，翻到该章时仍会按需重试。 */
  async prefetch(entry: EpubResourceEntry): Promise<void> {
    const cache = this.cache
    if (cache === null) {
      return
    }
    const keyId = resourceKeyId(this.keyFor(entry))
    this.speculative.add(keyId)
    try {
      await this.get(entry, undefined, "prefetch")
    } catch {
      this.speculative.delete(keyId)
      // 预取失败不改变当前章节。
    }
  }

  private async readCachedPayload(
    entry: EpubResourceEntry,
    signal: AbortSignal | undefined,
    cache: ReaderCacheRuntime,
  ): Promise<ResourcePayload | null> {
    const key = this.keyFor(entry)
    const keyId = resourceKeyId(key)
    const cached = cache.memory.get(keyId)
    if (cached !== null) {
      cache.scheduler.recordCacheHit(key, "L1")
      if (cached.value instanceof Blob) {
        return {
          blob: cached.value,
          mediaType: cached.mediaType || entry.mediaType,
        }
      }
      if (typeof cached.value === "string") {
        return {
          blob: new Blob([cached.value], {
            type: cached.mediaType || entry.mediaType,
          }),
          mediaType: cached.mediaType || entry.mediaType,
        }
      }
      const bytes =
        cached.value instanceof ArrayBuffer
          ? new Uint8Array(cached.value)
          : cached.value
      return {
        blob: new Blob([bytes.slice()], {
          type: cached.mediaType || entry.mediaType,
        }),
        mediaType: cached.mediaType || entry.mediaType,
      }
    }
    const stored = await cache.persistent
      .readResource(key)
      .catch(() => null)
    if (signal?.aborted === true) {
      throw new DOMException("资源请求已取消", "AbortError")
    }
    if (stored === null) {
      return null
    }
    cache.scheduler.recordCacheHit(key, "L3")
    cache.memory.set(keyId, stored.blob, {
      mediaType: stored.mediaType,
      version: String(stored.generation),
    })
    return {
      blob: stored.blob,
      mediaType: stored.mediaType || entry.mediaType,
    }
  }

  private async requestNetworkFirst(
    entry: EpubResourceEntry,
    signal: AbortSignal | undefined,
    priority: ResourcePriority,
    cache: ReaderCacheRuntime,
  ): Promise<ResourcePayload> {
    const key = this.keyFor(entry)
    try {
      return await cache.scheduler.request(
        key,
        async (jobSignal) => {
          // 必须在发起网络请求前取得 generation；清理后旧任务不得回填。
          const generation = await cache.persistent
            .currentGeneration()
            .catch(() => 0)
          return this.fetchPayload(
            entry,
            jobSignal,
            generation,
            cache,
          )
        },
        { priority, signal },
      )
    } catch (error) {
      if (error instanceof EpubNetworkFailure) {
        const fallback = await this.readCachedPayload(entry, signal, cache)
        if (fallback !== null) {
          return fallback
        }
      }
      throw error
    }
  }

  private async fetchPayload(
    entry: EpubResourceEntry,
    signal: AbortSignal,
    generation: number,
    cache: ReaderCacheRuntime,
  ): Promise<ResourcePayload> {
    const timeout = new AbortController()
    const timeoutId = window.setTimeout(() => {
      timeout.abort()
    }, REQUEST_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout.signal])
    try {
      let response: Response
      try {
        response = await fetch(this.urlFor(entry), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "*/*" },
          signal: combined,
        })
      } catch (error) {
        if (
          isAbortError(error) ||
          isResourceCancellation(error) ||
          signal.aborted
        ) {
          throw error
        }
        throw new EpubNetworkFailure(
          "无法连接本机服务，请检查网络后重试。",
          entry.href,
          true,
        )
      }
      if (!response.ok) {
        throw new EpubResourceError(
          `资源请求失败（HTTP ${response.status}）`,
          entry.href,
          response.status >= 500,
        )
      }
      const mediaType =
        (response.headers.get("Content-Type") ?? entry.mediaType)
          .split(";")[0]
          ?.trim() || entry.mediaType
      const blob = await response.blob()
      const key = this.keyFor(entry)
      if (response.status === 200) {
        cache.memory.set(resourceKeyId(key), blob, { mediaType })
        await cache.persistent
          .writeResource({
            key,
            blob,
            mediaType,
            etag: response.headers.get("ETag") ?? "",
            generation,
          })
          .catch(() => undefined)
      }
      return { blob, mediaType }
    } catch (error) {
      if (error instanceof EpubResourceError) {
        throw error
      }
      if (isAbortError(error) || isResourceCancellation(error)) {
        throw error
      }
      throw new EpubResourceError(
        "无法取得章节资源，请检查网络后重试。",
        entry.href,
        true,
      )
    } finally {
      window.clearTimeout(timeoutId)
    }
  }

  /** 无会话缓存时的直连路径，保持独立引擎/单测行为。 */
  private getDirect(
    entry: EpubResourceEntry,
    signal?: AbortSignal,
  ): Promise<ResourcePayload> {
    const cached = this.direct.get(entry.resourceId)
    if (cached !== undefined) {
      return cached
    }
    const timeout = new AbortController()
    const timeoutId = window.setTimeout(() => {
      timeout.abort()
    }, REQUEST_TIMEOUT_MS)
    const combined =
      signal === undefined
        ? timeout.signal
        : AbortSignal.any([signal, timeout.signal])
    const request = (async (): Promise<ResourcePayload> => {
      try {
        const response = await fetch(this.urlFor(entry), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "*/*" },
          signal: combined,
        })
        if (!response.ok) {
          throw new EpubResourceError(
            `资源请求失败（HTTP ${response.status}）`,
            entry.href,
            response.status >= 500,
          )
        }
        const mediaType =
          (response.headers.get("Content-Type") ?? entry.mediaType)
            .split(";")[0]
            ?.trim() || entry.mediaType
        return { blob: await response.blob(), mediaType }
      } catch (error) {
        if (error instanceof EpubResourceError) {
          throw error
        }
        if (isAbortError(error) || isResourceCancellation(error)) {
          throw error
        }
        throw new EpubResourceError(
          "无法取得章节资源，请检查网络后重试。",
          entry.href,
          true,
        )
      } finally {
        window.clearTimeout(timeoutId)
      }
    })()
    this.direct.set(entry.resourceId, request)
    void request.catch(() => {
      this.direct.delete(entry.resourceId)
    })
    if (this.direct.size > MAX_DIRECT_RESOURCES) {
      const first = this.direct.keys().next()
      if (!first.done) {
        this.direct.delete(first.value)
      }
    }
    return request
  }

  async getText(
    entry: EpubResourceEntry,
    signal?: AbortSignal,
    priority: ResourcePriority = "critical",
  ): Promise<string> {
    const payload = await this.get(entry, signal, priority)
    const bytes = new Uint8Array(await payload.blob.arrayBuffer())
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2))
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2))
    }
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3))
    }
    return new TextDecoder("utf-8").decode(bytes)
  }

  async objectUrl(
    entry: EpubResourceEntry,
    urls: Set<string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const payload = await this.get(entry, signal)
    const url = URL.createObjectURL(
      payload.blob.type.length > 0
        ? payload.blob
        : new Blob([payload.blob], { type: payload.mediaType }),
    )
    urls.add(url)
    return url
  }

  clear(): void {
    // L1 由会话运行时持有，unmount 不逐章清空；会话结束由 Shell dispose。
    this.direct.clear()
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    isResourceCancellation(error)
  )
}

export function chapterResourceEntry(
  resources: EpubResourceClient,
  item: EpubSpineItem,
  index: number,
): EpubResourceEntry {
  const entry = resources.bySpineItem(item)
  if (entry === null) {
    throw new EpubChapterError("章节资源不在当前清单中。", index, false)
  }
  return entry
}
