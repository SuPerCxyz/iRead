import type { CacheLayerBudget, CacheTier } from "./budgets"
import { cacheBudgetForTier, detectCacheTier } from "./budgets"
import {
  resourceKeyId,
  type ResourceKey,
  type ResourceRange,
} from "./resource-key"

/**
 * L3 受限持久缓存。
 *
 * - CacheStorage：EPUB 章节/资源、漫画页等完整 200 响应。
 * - IndexedDB：PDF 64KiB Range 块、manifest/meta、内容元数据账本。
 * - cacheGeneration：清理时先推进 generation，旧任务写入被拒绝；
 *   写入完成后再次核对，避免清理与迟到写入竞态。
 *
 * 这里不使用 TanStack Query 的持久化缓存，也不把 Query 结果当资源缓存。
 */

export const READER_CACHE_DB_NAME = "iread-reader-cache"
export const READER_CACHE_DB_VERSION = 1
export const READER_CACHE_META_STORE = "meta"
export const READER_CACHE_CONTENT_STORE = "contentMeta"
export const READER_CACHE_PDF_STORE = "pdfChunks"
export const READER_CACHE_MANIFEST_STORE = "manifests"
export const CACHE_GENERATION_KEY = "cacheGeneration"

export const CONTENT_CACHE_PREFIX = "iread-content-"
export const CONTENT_CACHE_NAME = "iread-content-v1"
export const PDF_CACHE_PREFIX = "iread-pdf-"
export const PDF_CHUNK_SIZE = 65_536

export interface ResourceCacheEntry {
  blob: Blob
  mediaType: string
  etag: string
  generation: number
  storedAt: number
}

export interface PdfChunkEntry {
  bytes: Uint8Array
  totalBytes: number | null
  contentType: string
  etag: string
  generation: number
  storedAt: number
}

export type CacheWriteReason =
  | "stale-generation"
  | "invalid-key"
  | "invalid-chunk"
  | "not-partial-response"
  | "storage-error"

export type CacheWriteResult =
  | { stored: true; bytes: number; generation: number }
  | { stored: false; reason: CacheWriteReason; error?: string }

export interface CacheLayerUsage {
  bytes: number
  entries: number
}

export interface PersistentCacheUsage {
  content: CacheLayerUsage
  pdfChunks: CacheLayerUsage
  manifests: CacheLayerUsage
  total: CacheLayerUsage
  cacheStorageNames: string[]
  generation: number
}

export interface CacheClearFailure {
  area:
    | "cache-storage"
    | "indexeddb"
    | "generation"
    | "memory"
    | "render"
  name: string
  message: string
  retryable: boolean
}

export interface CacheClearResult {
  ok: boolean
  generation: number
  clearedBytes: number
  clearedEntries: number
  remaining: CacheLayerUsage
  failures: CacheClearFailure[]
}

export interface PersistentCacheOptions {
  tier?: CacheTier
  budget?: CacheLayerBudget
  dbName?: string
  factory?: IDBFactory
  cacheStorage?: CacheStorage
  now?: () => number
}

interface ContentMetaRecord {
  key: string
  bookId: string
  fileVersion: string
  kind: string
  resourceId: string
  mediaType: string
  bytes: number
  etag: string
  createdAt: number
  lastAccess: number
  generation: number
}

interface PdfChunkRecord {
  key: string
  bookId: string
  fileVersion: string
  start: number
  end: number
  bytes: Uint8Array
  byteLength: number
  totalBytes: number | null
  contentType: string
  etag: string
  createdAt: number
  lastAccess: number
  generation: number
}

interface ManifestRecord {
  bookId: string
  fileVersion: string
  format: string
  manifest: unknown
  bytes: number
  createdAt: number
  lastAccess: number
  generation: number
}

interface MetaRecord {
  key: string
  value: number
}

interface BudgetEntry {
  store: typeof READER_CACHE_CONTENT_STORE | typeof READER_CACHE_PDF_STORE | typeof READER_CACHE_MANIFEST_STORE
  key: string
  bytes: number
  lastAccess: number
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB 请求失败。"))
    }
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve()
    }
    tx.onerror = () => {
      reject(tx.error ?? new Error("IndexedDB 事务失败。"))
    }
    tx.onabort = () => {
      reject(tx.error ?? new Error("IndexedDB 事务已中止。"))
    }
  })
}

function contentRequest(cacheKey: string): Request {
  return new Request(
    `https://iread.invalid/content/${encodeURIComponent(cacheKey)}`,
    { method: "GET" },
  )
}

function isCacheStorageName(name: string): boolean {
  return (
    name.startsWith(CONTENT_CACHE_PREFIX) ||
    name.startsWith(PDF_CACHE_PREFIX)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}

export class ReaderPersistentCache {
  readonly #tier: CacheTier
  readonly #budget: CacheLayerBudget
  readonly #dbName: string
  readonly #factory: IDBFactory | null
  readonly #cacheStorage: CacheStorage | null
  readonly #now: () => number
  #db: IDBDatabase | null = null
  #opening: Promise<void> | null = null
  #generation = 0
  #closed = false

  constructor(options: PersistentCacheOptions = {}) {
    this.#tier = options.tier ?? detectCacheTier()
    this.#budget =
      options.budget ?? cacheBudgetForTier(this.#tier).l3
    this.#dbName = options.dbName ?? READER_CACHE_DB_NAME
    this.#factory =
      options.factory ??
      (typeof indexedDB === "undefined" ? null : indexedDB)
    this.#cacheStorage =
      options.cacheStorage ??
      (typeof caches === "undefined" ? null : caches)
    this.#now = options.now ?? (() => Date.now())
  }

  get tier(): CacheTier {
    return this.#tier
  }

  get dbName(): string {
    return this.#dbName
  }

  get generation(): number {
    return this.#generation
  }

  async open(): Promise<void> {
    if (this.#closed) {
      throw new Error("阅读缓存已关闭。")
    }
    if (this.#db !== null) {
      return
    }
    if (this.#factory === null) {
      throw new Error("当前环境不支持 IndexedDB。")
    }
    if (this.#opening !== null) {
      return this.#opening
    }
    this.#opening = this.#openInternal()
    try {
      await this.#opening
    } finally {
      this.#opening = null
    }
  }

  async #openInternal(): Promise<void> {
    const factory = this.#factory
    if (factory === null) {
      throw new Error("当前环境不支持 IndexedDB。")
    }
    const request = factory.open(
      this.#dbName,
      READER_CACHE_DB_VERSION,
    )
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(READER_CACHE_META_STORE)) {
        db.createObjectStore(READER_CACHE_META_STORE, {
          keyPath: "key",
        })
      }
      if (!db.objectStoreNames.contains(READER_CACHE_CONTENT_STORE)) {
        const store = db.createObjectStore(
          READER_CACHE_CONTENT_STORE,
          { keyPath: "key" },
        )
        store.createIndex("lastAccess", "lastAccess")
        store.createIndex("book", ["bookId", "fileVersion"])
      }
      if (!db.objectStoreNames.contains(READER_CACHE_PDF_STORE)) {
        const store = db.createObjectStore(READER_CACHE_PDF_STORE, {
          keyPath: "key",
        })
        store.createIndex("lastAccess", "lastAccess")
        store.createIndex("book", ["bookId", "fileVersion"])
      }
      if (!db.objectStoreNames.contains(READER_CACHE_MANIFEST_STORE)) {
        const store = db.createObjectStore(
          READER_CACHE_MANIFEST_STORE,
          { keyPath: "bookId" },
        )
        store.createIndex("lastAccess", "lastAccess")
      }
    }
    const db = await requestToPromise(request)
    this.#db = db
    db.onversionchange = () => {
      db.close()
      this.#db = null
    }
    const tx = db.transaction(READER_CACHE_META_STORE, "readwrite")
    const store = tx.objectStore(READER_CACHE_META_STORE)
    const existing = await requestToPromise<MetaRecord | undefined>(
      store.get(CACHE_GENERATION_KEY),
    )
    if (existing === undefined) {
      const initial: MetaRecord = {
        key: CACHE_GENERATION_KEY,
        value: 0,
      }
      store.put(initial)
      this.#generation = 0
    } else if (
      typeof existing.value === "number" &&
      Number.isFinite(existing.value) &&
      existing.value >= 0
    ) {
      this.#generation = Math.floor(existing.value)
    }
    await transactionDone(tx)
  }

  close(): void {
    this.#closed = true
    this.#db?.close()
    this.#db = null
  }

  dispose(): void {
    this.close()
  }

  async #requireDb(): Promise<IDBDatabase> {
    await this.open()
    if (this.#db === null) {
      throw new Error("阅读缓存数据库不可用。")
    }
    return this.#db
  }

  async currentGeneration(): Promise<number> {
    const db = await this.#requireDb()
    const tx = db.transaction(READER_CACHE_META_STORE, "readonly")
    const store = tx.objectStore(READER_CACHE_META_STORE)
    const record = await requestToPromise<MetaRecord | undefined>(
      store.get(CACHE_GENERATION_KEY),
    )
    await transactionDone(tx)
    if (
      record !== undefined &&
      typeof record.value === "number" &&
      Number.isFinite(record.value) &&
      record.value >= 0
    ) {
      this.#generation = Math.floor(record.value)
    }
    return this.#generation
  }

  async advanceGeneration(): Promise<number> {
    const db = await this.#requireDb()
    const tx = db.transaction(READER_CACHE_META_STORE, "readwrite")
    const store = tx.objectStore(READER_CACHE_META_STORE)
    const record = await requestToPromise<MetaRecord | undefined>(
      store.get(CACHE_GENERATION_KEY),
    )
    const next =
      Math.max(
        this.#generation,
        record !== undefined && typeof record.value === "number"
          ? Math.floor(record.value)
          : 0,
      ) + 1
    store.put({ key: CACHE_GENERATION_KEY, value: next } satisfies MetaRecord)
    await transactionDone(tx)
    this.#generation = next
    return next
  }

  async readResource(
    key: ResourceKey,
  ): Promise<ResourceCacheEntry | null> {
    if (key.kind === "pdf-range") {
      return null
    }
    let keyId: string
    try {
      keyId = resourceKeyId(key)
    } catch {
      return null
    }
    const db = await this.#requireDb()
    await this.currentGeneration()
    const cache = await this.#requireContentCache()
    const meta = await this.#readContentMeta(db, keyId)
    if (
      meta === null ||
      meta.generation !== this.#generation ||
      this.#now() - meta.lastAccess > this.#budget.maxAgeMs
    ) {
      if (meta !== null) {
        await this.#deleteContentEntry(db, cache, keyId)
      }
      return null
    }
    const request = contentRequest(keyId)
    const response = await cache.match(request)
    if (response === undefined) {
      await this.#deleteContentMeta(db, keyId)
      return null
    }
    if (
      response.headers.get("X-Iread-Cache-Key") !== keyId ||
      response.headers.get("X-Iread-Generation") !==
        String(this.#generation)
    ) {
      await this.#deleteContentEntry(db, cache, keyId)
      return null
    }
    const blob = await response.blob()
    const touched = { ...meta, lastAccess: this.#now() }
    void this.#putContentMeta(db, touched).catch(() => undefined)
    return {
      blob,
      mediaType:
        response.headers.get("X-Iread-Media-Type") ??
        meta.mediaType,
      etag: response.headers.get("X-Iread-ETag") ?? meta.etag,
      generation: meta.generation,
      storedAt: meta.createdAt,
    }
  }

  async writeResource(input: {
    key: ResourceKey
    blob: Blob
    mediaType: string
    etag?: string
    /** 必须在发起网络请求前取得；清理推进 generation 后旧值会被拒绝。 */
    generation: number
  }): Promise<CacheWriteResult> {
    if (input.key.kind === "pdf-range") {
      return { stored: false, reason: "invalid-key" }
    }
    let keyId: string
    try {
      keyId = resourceKeyId(input.key)
    } catch (error) {
      return {
        stored: false,
        reason: "invalid-key",
        error: errorMessage(error),
      }
    }
    const db = await this.#requireDb()
    const generation = await this.currentGeneration()
    if (input.generation !== generation) {
      return { stored: false, reason: "stale-generation" }
    }
    const cache = await this.#requireContentCache()
    const request = contentRequest(keyId)
    const headers = new Headers({
      "Content-Type": input.mediaType,
      "X-Iread-Cache-Key": keyId,
      "X-Iread-Generation": String(generation),
      "X-Iread-Media-Type": input.mediaType,
    })
    if (input.etag !== undefined && input.etag.length > 0) {
      headers.set("X-Iread-ETag", input.etag)
    }
    const response = new Response(input.blob, {
      status: 200,
      headers,
    })
    try {
      await cache.put(request, response)
    } catch (error) {
      return {
        stored: false,
        reason: "storage-error",
        error: errorMessage(error),
      }
    }
    // 清理可能发生在 put 之前/期间；迟到结果不得回填新 generation。
    const after = await this.currentGeneration()
    if (after !== generation) {
      await cache.delete(request).catch(() => undefined)
      return { stored: false, reason: "stale-generation" }
    }
    const now = this.#now()
    const record: ContentMetaRecord = {
      key: keyId,
      bookId: input.key.bookId,
      fileVersion: input.key.fileVersion,
      kind: input.key.kind,
      resourceId: input.key.resourceId,
      mediaType: input.mediaType,
      bytes: input.blob.size,
      etag: input.etag ?? "",
      createdAt: now,
      lastAccess: now,
      generation,
    }
    try {
      await this.#putContentMeta(db, record)
    } catch (error) {
      await cache.delete(request).catch(() => undefined)
      return {
        stored: false,
        reason: "storage-error",
        error: errorMessage(error),
      }
    }
    await this.#enforceBudget(db)
    return {
      stored: true,
      bytes: input.blob.size,
      generation,
    }
  }

  async readPdfChunk(key: ResourceKey): Promise<PdfChunkEntry | null> {
    if (key.kind !== "pdf-range" || key.range === undefined) {
      return null
    }
    let keyId: string
    try {
      keyId = resourceKeyId(key)
    } catch {
      return null
    }
    const db = await this.#requireDb()
    await this.currentGeneration()
    const tx = db.transaction(READER_CACHE_PDF_STORE, "readwrite")
    const store = tx.objectStore(READER_CACHE_PDF_STORE)
    const record = await requestToPromise<PdfChunkRecord | undefined>(
      store.get(keyId),
    )
    if (record === undefined) {
      await transactionDone(tx)
      return null
    }
    if (record.generation !== this.#generation) {
      store.delete(keyId)
      await transactionDone(tx)
      return null
    }
    if (this.#now() - record.lastAccess > this.#budget.maxAgeMs) {
      store.delete(keyId)
      await transactionDone(tx)
      return null
    }
    const touched: PdfChunkRecord = {
      ...record,
      lastAccess: this.#now(),
    }
    store.put(touched)
    await transactionDone(tx)
    return {
      bytes: record.bytes,
      totalBytes: record.totalBytes,
      contentType: record.contentType,
      etag: record.etag,
      generation: record.generation,
      storedAt: record.createdAt,
    }
  }

  async writePdfChunk(input: {
    key: ResourceKey
    range: ResourceRange
    bytes: Uint8Array
    status: number
    totalBytes?: number
    contentType?: string
    etag?: string
    /** 必须在发起 Range 请求前取得。 */
    generation: number
  }): Promise<CacheWriteResult> {
    if (input.key.kind !== "pdf-range") {
      return { stored: false, reason: "invalid-key" }
    }
    if (input.status !== 206) {
      // 不把 200 完整响应缓存成可续读的 Range 块。
      return { stored: false, reason: "not-partial-response" }
    }
    const expected = input.range.end - input.range.start + 1
    if (
      input.range.start < 0 ||
      input.range.end < input.range.start ||
      input.bytes.byteLength !== expected ||
      input.bytes.byteLength > PDF_CHUNK_SIZE
    ) {
      return { stored: false, reason: "invalid-chunk" }
    }
    let keyId: string
    try {
      keyId = resourceKeyId(input.key)
    } catch (error) {
      return {
        stored: false,
        reason: "invalid-key",
        error: errorMessage(error),
      }
    }
    const db = await this.#requireDb()
    const now = this.#now()
    const tx = db.transaction(
      [READER_CACHE_META_STORE, READER_CACHE_PDF_STORE],
      "readwrite",
    )
    const metaStore = tx.objectStore(READER_CACHE_META_STORE)
    const generationRecord = await requestToPromise<
      MetaRecord | undefined
    >(metaStore.get(CACHE_GENERATION_KEY))
    const generation =
      generationRecord !== undefined &&
      typeof generationRecord.value === "number"
        ? Math.floor(generationRecord.value)
        : this.#generation
    if (input.generation !== generation) {
      tx.abort()
      return { stored: false, reason: "stale-generation" }
    }
    const record: PdfChunkRecord = {
      key: keyId,
      bookId: input.key.bookId,
      fileVersion: input.key.fileVersion,
      start: input.range.start,
      end: input.range.end,
      bytes: input.bytes,
      byteLength: input.bytes.byteLength,
      totalBytes: input.totalBytes ?? null,
      contentType: input.contentType ?? "",
      etag: input.etag ?? "",
      createdAt: now,
      lastAccess: now,
      generation,
    }
    tx.objectStore(READER_CACHE_PDF_STORE).put(record)
    try {
      await transactionDone(tx)
    } catch (error) {
      return {
        stored: false,
        reason: "storage-error",
        error: errorMessage(error),
      }
    }
    await this.#enforceBudget(db)
    return {
      stored: true,
      bytes: input.bytes.byteLength,
      generation,
    }
  }

  async readManifest<T = unknown>(
    bookId: string,
    fileVersion: string,
  ): Promise<T | null> {
    const db = await this.#requireDb()
    await this.currentGeneration()
    const tx = db.transaction(READER_CACHE_MANIFEST_STORE, "readwrite")
    const store = tx.objectStore(READER_CACHE_MANIFEST_STORE)
    const record = await requestToPromise<ManifestRecord | undefined>(
      store.get(bookId),
    )
    if (
      record === undefined ||
      record.fileVersion !== fileVersion ||
      record.generation !== this.#generation ||
      this.#now() - record.lastAccess > this.#budget.maxAgeMs
    ) {
      if (
        record !== undefined &&
        (record.fileVersion !== fileVersion ||
          record.generation !== this.#generation ||
          this.#now() - record.lastAccess > this.#budget.maxAgeMs)
      ) {
        store.delete(bookId)
      }
      await transactionDone(tx)
      return null
    }
    store.put({ ...record, lastAccess: this.#now() })
    await transactionDone(tx)
    return record.manifest as T
  }

  async writeManifest(input: {
    bookId: string
    fileVersion: string
    format: string
    manifest: unknown
    /** 必须在取得 manifest 前捕获。 */
    generation: number
  }): Promise<CacheWriteResult> {
    const db = await this.#requireDb()
    const now = this.#now()
    const tx = db.transaction(
      [READER_CACHE_META_STORE, READER_CACHE_MANIFEST_STORE],
      "readwrite",
    )
    const metaStore = tx.objectStore(READER_CACHE_META_STORE)
    const generationRecord = await requestToPromise<
      MetaRecord | undefined
    >(metaStore.get(CACHE_GENERATION_KEY))
    const generation =
      generationRecord !== undefined &&
      typeof generationRecord.value === "number"
        ? Math.floor(generationRecord.value)
        : this.#generation
    if (input.generation !== generation) {
      tx.abort()
      return { stored: false, reason: "stale-generation" }
    }
    const bytes = jsonBytes(input.manifest)
    const record: ManifestRecord = {
      bookId: input.bookId,
      fileVersion: input.fileVersion,
      format: input.format,
      manifest: input.manifest,
      bytes,
      createdAt: now,
      lastAccess: now,
      generation,
    }
    tx.objectStore(READER_CACHE_MANIFEST_STORE).put(record)
    try {
      await transactionDone(tx)
    } catch (error) {
      return {
        stored: false,
        reason: "storage-error",
        error: errorMessage(error),
      }
    }
    await this.#enforceBudget(db)
    return { stored: true, bytes, generation }
  }

  async usage(): Promise<PersistentCacheUsage> {
    const db = await this.#requireDb()
    await this.#enforceBudget(db)
    const tx = db.transaction(
      [
        READER_CACHE_CONTENT_STORE,
        READER_CACHE_PDF_STORE,
        READER_CACHE_MANIFEST_STORE,
      ],
      "readonly",
    )
    const [content, chunks, manifests] = await Promise.all([
      requestToPromise<ContentMetaRecord[]>(
        tx.objectStore(READER_CACHE_CONTENT_STORE).getAll(),
      ),
      requestToPromise<PdfChunkRecord[]>(
        tx.objectStore(READER_CACHE_PDF_STORE).getAll(),
      ),
      requestToPromise<ManifestRecord[]>(
        tx.objectStore(READER_CACHE_MANIFEST_STORE).getAll(),
      ),
    ])
    await transactionDone(tx)
    const sum = (
      records: Array<{
        bytes?: number | Uint8Array
        byteLength?: number
      }>,
    ): CacheLayerUsage => ({
      bytes: records.reduce((total, record) => {
        if (typeof record.bytes === "number") {
          return total + record.bytes
        }
        return total + (record.bytes?.byteLength ?? record.byteLength ?? 0)
      }, 0),
      entries: records.length,
    })
    const contentUsage = sum(content)
    const pdfUsage = sum(chunks)
    const manifestUsage = sum(manifests)
    return {
      content: contentUsage,
      pdfChunks: pdfUsage,
      manifests: manifestUsage,
      total: {
        bytes:
          contentUsage.bytes +
          pdfUsage.bytes +
          manifestUsage.bytes,
        entries:
          contentUsage.entries +
          pdfUsage.entries +
          manifestUsage.entries,
      },
      cacheStorageNames: await this.#contentCacheNames(),
      generation: this.#generation,
    }
  }

  /**
   * 清理所有可重建阅读缓存：先推进 generation，再删除应用管理的
   * CacheStorage 与内容 store。进度 outbox/设备偏好不在本类范围内。
   */
  async clearContent(options: {
    freeze?: () => void | Promise<void>
    reason?: string
  } = {}): Promise<CacheClearResult> {
    const failures: CacheClearFailure[] = []
    let beforeBytes = 0
    let beforeEntries = 0
    try {
      const before = await this.usage()
      beforeBytes = before.total.bytes
      beforeEntries = before.total.entries
    } catch (error) {
      failures.push({
        area: "indexeddb",
        name: "usage",
        message: errorMessage(error),
        retryable: true,
      })
    }

    if (options.freeze !== undefined) {
      try {
        await options.freeze()
      } catch (error) {
        failures.push({
          area: "indexeddb",
          name: "freeze",
          message: errorMessage(error),
          retryable: true,
        })
      }
    }

    let generation = this.#generation
    try {
      generation = await this.advanceGeneration()
    } catch (error) {
      failures.push({
        area: "generation",
        name: CACHE_GENERATION_KEY,
        message: errorMessage(error),
        retryable: true,
      })
    }

    if (this.#cacheStorage !== null) {
      let names: string[] = []
      try {
        names = (await this.#cacheStorage.keys()).filter(isCacheStorageName)
      } catch (error) {
        failures.push({
          area: "cache-storage",
          name: "keys",
          message: errorMessage(error),
          retryable: true,
        })
      }
      for (const name of names) {
        try {
          const deleted = await this.#cacheStorage.delete(name)
          if (!deleted) {
            failures.push({
              area: "cache-storage",
              name,
              message: "缓存未被删除。",
              retryable: true,
            })
          }
        } catch (error) {
          failures.push({
            area: "cache-storage",
            name,
            message: errorMessage(error),
            retryable: true,
          })
        }
      }
    }

    try {
      const db = await this.#requireDb()
      const tx = db.transaction(
        [
          READER_CACHE_CONTENT_STORE,
          READER_CACHE_PDF_STORE,
          READER_CACHE_MANIFEST_STORE,
        ],
        "readwrite",
      )
      tx.objectStore(READER_CACHE_CONTENT_STORE).clear()
      tx.objectStore(READER_CACHE_PDF_STORE).clear()
      tx.objectStore(READER_CACHE_MANIFEST_STORE).clear()
      await transactionDone(tx)
    } catch (error) {
      failures.push({
        area: "indexeddb",
        name: "content",
        message: errorMessage(error),
        retryable: true,
      })
    }

    let remaining: CacheLayerUsage = { bytes: 0, entries: 0 }
    try {
      const after = await this.usage()
      remaining = after.total
    } catch (error) {
      failures.push({
        area: "indexeddb",
        name: "usage-after-clear",
        message: errorMessage(error),
        retryable: true,
      })
    }

    return {
      ok: failures.length === 0,
      generation,
      clearedBytes: Math.max(0, beforeBytes - remaining.bytes),
      clearedEntries: Math.max(
        0,
        beforeEntries - remaining.entries,
      ),
      remaining,
      failures,
    }
  }

  async #contentCacheNames(): Promise<string[]> {
    if (this.#cacheStorage === null) {
      return []
    }
    try {
      return (await this.#cacheStorage.keys()).filter(isCacheStorageName)
    } catch {
      return []
    }
  }

  async #requireContentCache(): Promise<Cache> {
    if (this.#cacheStorage === null) {
      throw new Error("当前环境不支持 CacheStorage。")
    }
    return this.#cacheStorage.open(CONTENT_CACHE_NAME)
  }

  async #readContentMeta(
    db: IDBDatabase,
    key: string,
  ): Promise<ContentMetaRecord | null> {
    const tx = db.transaction(READER_CACHE_CONTENT_STORE, "readonly")
    const store = tx.objectStore(READER_CACHE_CONTENT_STORE)
    const record = await requestToPromise<ContentMetaRecord | undefined>(
      store.get(key),
    )
    await transactionDone(tx)
    return record ?? null
  }

  async #putContentMeta(
    db: IDBDatabase,
    record: ContentMetaRecord,
  ): Promise<void> {
    const tx = db.transaction(READER_CACHE_CONTENT_STORE, "readwrite")
    tx.objectStore(READER_CACHE_CONTENT_STORE).put(record)
    await transactionDone(tx)
  }

  async #deleteContentMeta(
    db: IDBDatabase,
    key: string,
  ): Promise<void> {
    const tx = db.transaction(READER_CACHE_CONTENT_STORE, "readwrite")
    tx.objectStore(READER_CACHE_CONTENT_STORE).delete(key)
    await transactionDone(tx)
  }

  async #deleteContentEntry(
    db: IDBDatabase,
    cache: Cache,
    key: string,
  ): Promise<void> {
    await cache.delete(contentRequest(key)).catch(() => undefined)
    await this.#deleteContentMeta(db, key)
  }

  async #enforceBudget(db: IDBDatabase): Promise<void> {
    let entries: BudgetEntry[]
    try {
      const tx = db.transaction(
        [
          READER_CACHE_CONTENT_STORE,
          READER_CACHE_PDF_STORE,
          READER_CACHE_MANIFEST_STORE,
        ],
        "readonly",
      )
      const content = await requestToPromise<ContentMetaRecord[]>(
        tx.objectStore(READER_CACHE_CONTENT_STORE).getAll(),
      )
      const chunks = await requestToPromise<PdfChunkRecord[]>(
        tx.objectStore(READER_CACHE_PDF_STORE).getAll(),
      )
      const manifests = await requestToPromise<ManifestRecord[]>(
        tx.objectStore(READER_CACHE_MANIFEST_STORE).getAll(),
      )
      await transactionDone(tx)
      entries = [
        ...content.map((record): BudgetEntry => ({
          store: READER_CACHE_CONTENT_STORE,
          key: record.key,
          bytes: record.bytes,
          lastAccess: record.lastAccess,
        })),
        ...chunks.map((record): BudgetEntry => ({
          store: READER_CACHE_PDF_STORE,
          key: record.key,
          bytes: record.byteLength,
          lastAccess: record.lastAccess,
        })),
        ...manifests.map((record): BudgetEntry => ({
          store: READER_CACHE_MANIFEST_STORE,
          key: record.bookId,
          bytes: record.bytes,
          lastAccess: record.lastAccess,
        })),
      ]
    } catch {
      return
    }
    let totalBytes = entries.reduce(
      (total, entry) => total + entry.bytes,
      0,
    )
    const now = this.#now()
    const expired = entries.filter(
      (entry) => now - entry.lastAccess > this.#budget.maxAgeMs,
    ).length
    if (
      expired === 0 &&
      totalBytes <= this.#budget.maxBytes &&
      entries.length <= this.#budget.maxEntries
    ) {
      return
    }
    entries.sort((a, b) => a.lastAccess - b.lastAccess)
    const cache =
      this.#cacheStorage === null
        ? null
        : await this.#requireContentCache().catch(() => null)
    for (const entry of entries) {
      const isExpired =
        now - entry.lastAccess > this.#budget.maxAgeMs
      if (
        !isExpired &&
        totalBytes <= this.#budget.maxBytes &&
        entries.length <= this.#budget.maxEntries
      ) {
        break
      }
      try {
        if (entry.store === READER_CACHE_CONTENT_STORE) {
          if (cache !== null) {
            await cache
              .delete(contentRequest(entry.key))
              .catch(() => undefined)
          }
          await this.#deleteContentMeta(db, entry.key)
        } else {
          const tx = db.transaction(entry.store, "readwrite")
          tx.objectStore(entry.store).delete(entry.key)
          await transactionDone(tx)
        }
        totalBytes -= entry.bytes
        entries = entries.filter((candidate) => candidate !== entry)
      } catch {
        // 单条淘汰失败不阻塞其它条目；下次写入再重试。
      }
    }
  }
}
