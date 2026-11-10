import type { CacheLayerBudget, CacheTier } from "./budgets"
import { cacheBudgetForTier } from "./budgets"
import { LruCache, type LruCacheStats } from "./lru"
import { trackReaderCache } from "./registry"

/**
 * L1 网络资源内存缓存。只存已经取得的资源字节，
 * 不存 DOM、Canvas 或 React 查询结果。
 */
export type ReaderMemoryValue = Blob | ArrayBuffer | Uint8Array | string

export interface ReaderMemoryEntry {
  value: ReaderMemoryValue
  bytes: number
  mediaType: string
  version: string
  storedAt: number
}

export interface ReaderMemoryCacheStats extends LruCacheStats {
  tier: CacheTier
}

export function byteLengthOf(value: ReaderMemoryValue): number {
  if (typeof value === "string") {
    return new TextEncoder().encode(value).byteLength
  }
  if (value instanceof Blob) {
    return value.size
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength
  }
  return value.byteLength
}

export interface ReaderMemoryCacheOptions {
  tier?: CacheTier
  budget?: CacheLayerBudget
}

export class ReaderMemoryCache {
  readonly #cache: LruCache<string, ReaderMemoryEntry>
  readonly #tier: CacheTier
  readonly #untrack: () => void

  constructor(
    input: CacheTier | CacheLayerBudget | ReaderMemoryCacheOptions = "desktop",
  ) {
    const options: ReaderMemoryCacheOptions =
      typeof input === "string"
        ? { tier: input }
        : "maxBytes" in input
          ? { budget: input }
          : input
    const tier = options.tier ?? "desktop"
    const budget =
      options.budget ?? cacheBudgetForTier(tier).l1
    this.#tier = tier
    this.#cache = new LruCache<string, ReaderMemoryEntry>({
      maxBytes: budget.maxBytes,
      maxEntries: budget.maxEntries,
      maxAgeMs: budget.maxAgeMs,
      sizeOf: (entry) => entry.bytes,
    })
    this.#untrack = trackReaderCache("memory", this)
  }

  get stats(): ReaderMemoryCacheStats {
    return { ...this.#cache.stats(), tier: this.#tier }
  }

  get(key: string): ReaderMemoryEntry | null {
    return this.#cache.get(key)
  }

  set(
    key: string,
    value: ReaderMemoryValue,
    metadata: { mediaType?: string; version?: string } = {},
    options: { protectMs?: number; ttlMs?: number } = {},
  ): ReaderMemoryEntry {
    const entry: ReaderMemoryEntry = {
      value,
      bytes: byteLengthOf(value),
      mediaType: metadata.mediaType ?? "",
      version: metadata.version ?? "",
      storedAt: Date.now(),
    }
    this.#cache.set(key, entry, options)
    return entry
  }

  protect(key: string, durationMs: number): void {
    this.#cache.protect(key, durationMs)
  }

  delete(key: string): boolean {
    return this.#cache.delete(key)
  }

  clear(): void {
    this.#cache.clear()
  }

  prune(): number {
    return this.#cache.prune()
  }

  keys(): string[] {
    return this.#cache.keys()
  }

  /** 清空并停止参与退出登录/设置页的统一清理。 */
  dispose(): void {
    this.clear()
    this.#untrack()
  }
}
