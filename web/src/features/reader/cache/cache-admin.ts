import {
  CONTENT_CACHE_PREFIX,
  PDF_CACHE_PREFIX,
  ReaderPersistentCache,
  type CacheClearFailure,
  type CacheLayerUsage,
  type PersistentCacheUsage,
} from "./persistent-cache"
import type { ReaderMemoryCache } from "./memory-cache"
import type { ReaderRenderCache } from "./render-cache"
import { clearTrackedReaderCaches } from "./registry"

/**
 * 设置页“阅读缓存用量/清理”的客户端数据层。
 *
 * 只枚举应用管理的 `iread-content-*` / `iread-pdf-*` CacheStorage
 * 与内容 IndexedDB；不碰 Shell precache、进度 outbox、
 * `iread.device-preferences.v1` 或任何原件。
 */

export interface ReaderCacheAdminOptions {
  persistent?: ReaderPersistentCache
  memory?: Pick<ReaderMemoryCache, "clear"> | null
  render?: Pick<ReaderRenderCache, "clear"> | null
  cacheStorage?: CacheStorage | null
  storageManager?: StorageManager | null
  freeze?: () => void | Promise<void>
}

export interface ReaderStorageEstimate {
  usage: number
  quota: number
  persisted: boolean | null
}

export interface ReaderCacheUsageSnapshot {
  generation: number
  content: CacheLayerUsage
  pdfChunks: CacheLayerUsage
  manifests: CacheLayerUsage
  cacheStorage: CacheLayerUsage
  totalMeasured: CacheLayerUsage
  cacheNames: string[]
  /** StorageManager 是整个 origin 的估算，不能当作精确阅读缓存。 */
  estimate: ReaderStorageEstimate | null
  estimateIsApproximate: true
}

export interface ReaderCacheClearSummary {
  ok: boolean
  clearedBytes: number
  clearedEntries: number
  generation: number
  failures: CacheClearFailure[]
  remaining: ReaderCacheUsageSnapshot
}

function isManagedCacheName(name: string): boolean {
  return (
    name.startsWith(CONTENT_CACHE_PREFIX) ||
    name.startsWith(PDF_CACHE_PREFIX)
  )
}

async function measureCacheStorage(
  storage: CacheStorage | null,
): Promise<{ names: string[]; usage: CacheLayerUsage }> {
  if (storage === null) {
    return { names: [], usage: { bytes: 0, entries: 0 } }
  }
  let names: string[]
  try {
    names = (await storage.keys()).filter(isManagedCacheName)
  } catch {
    return { names: [], usage: { bytes: 0, entries: 0 } }
  }
  let bytes = 0
  let entries = 0
  for (const name of names) {
    let cache: Cache
    try {
      cache = await storage.open(name)
    } catch {
      continue
    }
    let requests: readonly Request[]
    try {
      requests = await cache.keys()
    } catch {
      continue
    }
    for (const request of requests) {
      const response = await cache.match(request).catch(() => undefined)
      if (response === undefined) {
        continue
      }
      entries += 1
      bytes += (await response.blob()).size
    }
  }
  return { names, usage: { bytes, entries } }
}

async function readEstimate(
  storageManager: StorageManager | null,
): Promise<ReaderStorageEstimate | null> {
  if (storageManager === null) {
    return null
  }
  try {
    const estimate = await storageManager.estimate()
    let persisted: boolean | null = null
    if (typeof storageManager.persisted === "function") {
      persisted = await storageManager.persisted().catch(() => null)
    }
    return {
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
      persisted,
    }
  } catch {
    return null
  }
}

function defaultCacheStorage(): CacheStorage | null {
  return typeof caches === "undefined" ? null : caches
}

function defaultStorageManager(): StorageManager | null {
  if (typeof navigator === "undefined") {
    return null
  }
  return navigator.storage ?? null
}

function withOrphanCacheBytes(
  persistent: PersistentCacheUsage,
  cacheStorage: CacheLayerUsage,
): CacheLayerUsage {
  const orphanBytes = Math.max(
    0,
    cacheStorage.bytes - persistent.content.bytes,
  )
  const orphanEntries = Math.max(
    0,
    cacheStorage.entries - persistent.content.entries,
  )
  return {
    bytes: persistent.total.bytes + orphanBytes,
    entries: persistent.total.entries + orphanEntries,
  }
}

export async function getReaderCacheUsage(
  options: ReaderCacheAdminOptions = {},
): Promise<ReaderCacheUsageSnapshot> {
  const persistent =
    options.persistent ?? new ReaderPersistentCache()
  const ownsPersistent = options.persistent === undefined
  const cacheStorage = options.cacheStorage ?? defaultCacheStorage()
  try {
    await persistent.open()
    const usage = await persistent.usage()
    const measured = await measureCacheStorage(cacheStorage)
    const estimate = await readEstimate(
      options.storageManager ?? defaultStorageManager(),
    )
    return {
      generation: usage.generation,
      content: usage.content,
      pdfChunks: usage.pdfChunks,
      manifests: usage.manifests,
      cacheStorage: measured.usage,
      totalMeasured: withOrphanCacheBytes(usage, measured.usage),
      cacheNames: measured.names,
      estimate,
      estimateIsApproximate: true,
    }
  } finally {
    if (ownsPersistent) {
      persistent.close()
    }
  }
}

/**
 * 清理可重建阅读缓存。清理前推进 generation 并冻结旧预取，
 * 清理后重新读取用量；部分失败保留可重试信息。
 */
export async function clearReaderContentCaches(
  options: ReaderCacheAdminOptions & {
    reason?: "settings" | "logout" | "manual"
  } = {},
): Promise<ReaderCacheClearSummary> {
  const persistent =
    options.persistent ?? new ReaderPersistentCache()
  const ownsPersistent = options.persistent === undefined
  const failures: CacheClearFailure[] = []

  try {
    // L1/L2 不依赖 IndexedDB/CacheStorage，先释放内存对象。
    try {
      options.memory?.clear()
    } catch (error) {
      failures.push({
        area: "memory",
        name: "memory-cache",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
    }
    try {
      options.render?.clear()
    } catch (error) {
      failures.push({
        area: "render",
        name: "render-cache",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
    }
    for (const failure of clearTrackedReaderCaches()) {
      failures.push({
        area: failure.kind,
        name: `tracked-${failure.kind}-cache`,
        message: failure.message,
        retryable: true,
      })
    }

    let clearResult: {
      generation: number
      clearedBytes: number
      clearedEntries: number
      failures: CacheClearFailure[]
    }
    try {
      const result = await persistent.clearContent({
        freeze: options.freeze,
        reason: options.reason ?? "manual",
      })
      clearResult = result
      failures.push(...result.failures)
    } catch (error) {
      clearResult = {
        generation: persistent.generation,
        clearedBytes: 0,
        clearedEntries: 0,
        failures: [],
      }
      failures.push({
        area: "indexeddb",
        name: "clear-content",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
    }

    let remaining: ReaderCacheUsageSnapshot
    try {
      remaining = await getReaderCacheUsage({
        persistent,
        cacheStorage: options.cacheStorage ?? defaultCacheStorage(),
        storageManager: options.storageManager ?? defaultStorageManager(),
      })
    } catch (error) {
      failures.push({
        area: "indexeddb",
        name: "usage-after-clear",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
      remaining = {
        generation: clearResult.generation,
        content: { bytes: 0, entries: 0 },
        pdfChunks: { bytes: 0, entries: 0 },
        manifests: { bytes: 0, entries: 0 },
        cacheStorage: { bytes: 0, entries: 0 },
        totalMeasured: { bytes: 0, entries: 0 },
        cacheNames: [],
        estimate: null,
        estimateIsApproximate: true,
      }
    }
    return {
      ok: failures.length === 0,
      clearedBytes: clearResult.clearedBytes,
      clearedEntries: clearResult.clearedEntries,
      generation: clearResult.generation,
      failures,
      remaining,
    }
  } finally {
    if (ownsPersistent) {
      persistent.close()
    }
  }
}

/**
 * 退出登录时清除可读正文/封面等本机资源缓存。
 * 进度 outbox 在独立的 `iread-progress-v1`，本函数不会删除；
 * 设备预加载档位在 localStorage，也不会删除。
 */
export function clearReadableContentOnLogout(
  options: Omit<ReaderCacheAdminOptions, "reason"> = {},
): Promise<ReaderCacheClearSummary> {
  return clearReaderContentCaches({
    ...options,
    reason: "logout",
  })
}
