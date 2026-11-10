/**
 * 通用 LRU：同时受字节、对象数与时间上限约束。
 * Map 的插入顺序就是访问顺序；get 会把条目移到末尾。
 */

export type LruEvictionReason =
  | "lru"
  | "expired"
  | "delete"
  | "clear"
  | "replace"

export interface LruEntryView<K, V> {
  key: K
  value: V
  bytes: number
  createdAt: number
  lastAccess: number
  expiresAt: number | null
  protectedUntil: number
}

export interface LruCacheOptions<K, V> {
  maxBytes: number
  maxEntries: number
  maxAgeMs?: number
  sizeOf: (value: V, key: K) => number
  onEvict?: (
    entry: LruEntryView<K, V>,
    reason: LruEvictionReason,
  ) => void
  now?: () => number
}

export interface LruCacheStats {
  entries: number
  bytes: number
  maxEntries: number
  maxBytes: number
  hits: number
  misses: number
  evictions: number
  expirations: number
}

interface LruNode<K, V> {
  key: K
  value: V
  bytes: number
  createdAt: number
  lastAccess: number
  expiresAt: number | null
  protectedUntil: number
}

function toView<K, V>(node: LruNode<K, V>): LruEntryView<K, V> {
  return {
    key: node.key,
    value: node.value,
    bytes: node.bytes,
    createdAt: node.createdAt,
    lastAccess: node.lastAccess,
    expiresAt: node.expiresAt,
    protectedUntil: node.protectedUntil,
  }
}

export class LruCache<K, V> {
  readonly #maxBytes: number
  readonly #maxEntries: number
  readonly #maxAgeMs: number | null
  readonly #sizeOf: (value: V, key: K) => number
  readonly #onEvict:
    | ((entry: LruEntryView<K, V>, reason: LruEvictionReason) => void)
    | undefined
  readonly #now: () => number
  readonly #map = new Map<K, LruNode<K, V>>()
  #bytes = 0
  #hits = 0
  #misses = 0
  #evictions = 0
  #expirations = 0

  constructor(options: LruCacheOptions<K, V>) {
    this.#maxBytes = Math.max(0, options.maxBytes)
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries))
    this.#maxAgeMs =
      options.maxAgeMs === undefined || options.maxAgeMs <= 0
        ? null
        : options.maxAgeMs
    this.#sizeOf = options.sizeOf
    this.#onEvict = options.onEvict
    this.#now = options.now ?? (() => Date.now())
  }

  get size(): number {
    return this.#map.size
  }

  get bytes(): number {
    return this.#bytes
  }

  get(key: K): V | null {
    const node = this.#map.get(key)
    const now = this.#now()
    if (node === undefined) {
      this.#misses += 1
      return null
    }
    if (node.expiresAt !== null && node.expiresAt <= now) {
      this.#misses += 1
      this.#expirations += 1
      this.#remove(node, "expired")
      return null
    }
    this.#hits += 1
    node.lastAccess = now
    this.#map.delete(key)
    this.#map.set(key, node)
    return node.value
  }

  peek(key: K): V | null {
    const node = this.#map.get(key)
    if (node === undefined) {
      return null
    }
    if (node.expiresAt !== null && node.expiresAt <= this.#now()) {
      return null
    }
    return node.value
  }

  has(key: K): boolean {
    return this.peek(key) !== null
  }

  set(
    key: K,
    value: V,
    options: { ttlMs?: number; protectMs?: number } = {},
  ): void {
    const now = this.#now()
    const bytes = Math.max(0, this.#sizeOf(value, key))
    const existing = this.#map.get(key)
    if (existing !== undefined) {
      this.#bytes -= existing.bytes
      this.#map.delete(key)
      this.#onEvict?.(toView(existing), "replace")
    }
    const ttl =
      options.ttlMs ??
      this.#maxAgeMs ??
      null
    const node: LruNode<K, V> = {
      key,
      value,
      bytes,
      createdAt: now,
      lastAccess: now,
      expiresAt: ttl === null || ttl <= 0 ? null : now + ttl,
      protectedUntil:
        options.protectMs !== undefined && options.protectMs > 0
          ? now + options.protectMs
          : 0,
    }
    this.#map.set(key, node)
    this.#bytes += bytes
    this.#enforce(now)
  }

  delete(key: K): boolean {
    const node = this.#map.get(key)
    if (node === undefined) {
      return false
    }
    this.#remove(node, "delete")
    return true
  }

  clear(): void {
    for (const node of [...this.#map.values()]) {
      this.#onEvict?.(toView(node), "clear")
      this.#bytes -= node.bytes
    }
    this.#map.clear()
    if (this.#bytes < 0) {
      this.#bytes = 0
    }
  }

  /** 清理已过期条目；返回清理数量。 */
  prune(): number {
    const now = this.#now()
    let removed = 0
    for (const node of [...this.#map.values()]) {
      if (node.expiresAt !== null && node.expiresAt <= now) {
        this.#remove(node, "expired")
        this.#expirations += 1
        removed += 1
      }
    }
    this.#enforce(now)
    return removed
  }

  protect(key: K, durationMs: number): void {
    const node = this.#map.get(key)
    if (node === undefined || durationMs <= 0) {
      return
    }
    node.protectedUntil = this.#now() + durationMs
  }

  touch(key: K): void {
    const node = this.#map.get(key)
    if (node === undefined) {
      return
    }
    node.lastAccess = this.#now()
    this.#map.delete(key)
    this.#map.set(key, node)
  }

  entries(): LruEntryView<K, V>[] {
    return [...this.#map.values()].map(toView)
  }

  keys(): K[] {
    return [...this.#map.keys()]
  }

  stats(): LruCacheStats {
    return {
      entries: this.#map.size,
      bytes: this.#bytes,
      maxEntries: this.#maxEntries,
      maxBytes: this.#maxBytes,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      expirations: this.#expirations,
    }
  }

  #remove(node: LruNode<K, V>, reason: LruEvictionReason): void {
    if (!this.#map.delete(node.key)) {
      return
    }
    this.#bytes -= node.bytes
    if (this.#bytes < 0) {
      this.#bytes = 0
    }
    if (reason === "lru" || reason === "expired") {
      this.#evictions += 1
    }
    this.#onEvict?.(toView(node), reason)
  }

  #enforce(now: number): void {
    if (this.#maxBytes <= 0 && this.#map.size > 0) {
      // 零字节预算表示禁用该层，但仍允许显式 delete/clear。
      for (const node of [...this.#map.values()]) {
        this.#remove(node, "lru")
      }
      return
    }
    while (
      this.#map.size > this.#maxEntries ||
      this.#bytes > this.#maxBytes
    ) {
      let victim: LruNode<K, V> | null = null
      for (const node of this.#map.values()) {
        if (node.protectedUntil > now) {
          continue
        }
        victim = node
        break
      }
      if (victim === null) {
        // 全部处于离开页保护期；暂时允许超额，保护期结束后 prune 再回收。
        return
      }
      this.#remove(victim, "lru")
    }
  }
}
