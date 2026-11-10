import type { CacheLayerBudget, CacheTier } from "./budgets"
import { cacheBudgetForTier } from "./budgets"
import { LruCache, type LruCacheStats } from "./lru"
import { trackReaderCache } from "./registry"

/**
 * L2 渲染缓存。引擎把 Canvas/ImageBitmap/object URL 等短期对象注册进来，
 * 并提供释放函数；LRU 淘汰或清理时必须调用 release，避免内存泄漏。
 *
 * 网络资源与渲染缓存分开失效：改字号只清理渲染键，不重复下载章节。
 */
export interface RenderCacheEntry<T> {
  value: T
  bytes: number
  release?: (value: T) => void
  kind: string
}

export interface RenderCacheStats extends LruCacheStats {
  tier: CacheTier
  releases: number
}

export class ReaderRenderCache<T = unknown> {
  readonly #cache: LruCache<string, RenderCacheEntry<T>>
  readonly #tier: CacheTier
  readonly #untrack: () => void
  #releases = 0

  constructor(
    tierOrBudget: CacheTier | CacheLayerBudget = "desktop",
    tier: CacheTier = "desktop",
  ) {
    const budget =
      typeof tierOrBudget === "string"
        ? cacheBudgetForTier(tierOrBudget).l2
        : tierOrBudget
    this.#tier = typeof tierOrBudget === "string" ? tierOrBudget : tier
    this.#cache = new LruCache<string, RenderCacheEntry<T>>({
      maxBytes: budget.maxBytes,
      maxEntries: budget.maxEntries,
      maxAgeMs: budget.maxAgeMs,
      sizeOf: (entry) => entry.bytes,
      onEvict: (entry) => {
        this.#release(entry.value)
      },
    })
    this.#untrack = trackReaderCache("render", this)
  }

  get stats(): RenderCacheStats {
    return {
      ...this.#cache.stats(),
      tier: this.#tier,
      releases: this.#releases,
    }
  }

  get(key: string): T | null {
    return this.#cache.get(key)?.value ?? null
  }

  register(
    key: string,
    value: T,
    options: {
      bytes: number
      release?: (value: T) => void
      kind?: string
      protectMs?: number
      ttlMs?: number
    },
  ): void {
    this.#cache.set(
      key,
      {
        value,
        bytes: Math.max(0, options.bytes),
        release: options.release,
        kind: options.kind ?? "",
      },
      options,
    )
  }

  /** 引擎主动释放单个渲染对象。 */
  release(key: string): boolean {
    return this.#cache.delete(key)
  }

  protect(key: string, durationMs: number): void {
    this.#cache.protect(key, durationMs)
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

  /** 释放全部渲染对象并停止参与统一清理。 */
  dispose(): void {
    this.clear()
    this.#untrack()
  }

  #release(entry: RenderCacheEntry<T>): void {
    if (entry.release === undefined) {
      return
    }
    this.#releases += 1
    try {
      entry.release(entry.value)
    } catch {
      // 释放函数异常不能阻塞缓存淘汰。
    }
  }
}
