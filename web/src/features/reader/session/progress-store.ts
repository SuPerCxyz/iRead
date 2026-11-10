import type { BookFormat } from "@/features/library/types"

import {
  isReaderLocatorType,
  parseReaderLocation,
  type ReaderLocation,
  type ReaderLocatorPayload,
  type ReaderLocatorType,
  type ReaderProgress,
} from "../types"

/**
 * 进度本地持久层。
 *
 * 独立 IndexedDB `iread-progress-v1`，与可读内容缓存分离：
 * 清理阅读缓存、退出登录都不能删除待同步进度。
 * snapshots 保存最近可确认/本地位置；outbox 每个书一条记录，
 * 内含 pending/queued/inFlight，避免多标签重复使用过期 revision。
 */

export const PROGRESS_DB_NAME = "iread-progress-v1"
export const PROGRESS_DB_VERSION = 1
export const PROGRESS_SNAPSHOT_STORE = "progressSnapshots"
export const PROGRESS_OUTBOX_STORE = "progressOutbox"

export type ProgressOutboxState =
  | "idle"
  | "pending"
  | "syncing"
  | "conflict"
  | "auth-required"
  | "error"

export type ProgressSnapshotSource = "local" | "server" | "conflict"

export interface ProgressMutation {
  mutationId: string
  bookId: string
  fileVersion: string
  format: BookFormat
  baseRevision: string
  locatorType: ReaderLocatorType
  locatorPayload: ReaderLocatorPayload
  progressPercent: number
  createdAt: string
}

export interface ProgressConflictInfo {
  code: string
  message: string
  currentRevision: string | null
  current: ReaderProgress | null
  detectedAt: string
}

export interface ProgressSnapshotRecord {
  schemaVersion: 1
  bookId: string
  fileVersion: string
  format: BookFormat
  locatorType: ReaderLocatorType
  locatorPayload: ReaderLocatorPayload
  progressPercent: number
  revision: string
  updatedAt: string
  savedAt: string
  mutationId: string | null
  source: ProgressSnapshotSource
  conflict: ProgressConflictInfo | null
}

export interface ProgressOutboxRecord {
  bookId: string
  pending: ProgressMutation | null
  queued: ProgressMutation | null
  inFlight: ProgressMutation | null
  state: ProgressOutboxState
  attemptCount: number
  lastError: string
  conflict: ProgressConflictInfo | null
  updatedAt: string
}

export interface SavedLocalProgress {
  snapshot: ProgressSnapshotRecord
  outbox: ProgressOutboxRecord
}

export interface SyncedProgress {
  snapshot: ProgressSnapshotRecord
  outbox: ProgressOutboxRecord
}

/**
 * outbox 编排层只依赖该接口；Node 单测可用内存实现，
 * 浏览器使用 ReaderProgressStore。
 */
export interface ProgressPersistence {
  open(): Promise<void>
  close(): void
  recover(): Promise<void>
  getSnapshot(bookId: string): Promise<ProgressSnapshotRecord | null>
  getOutbox(bookId: string): Promise<ProgressOutboxRecord | null>
  listOutbox(): Promise<ProgressOutboxRecord[]>
  saveLocal(input: {
    bookId: string
    fileVersion: string
    format: BookFormat
    locator: ReaderLocation
    mutationId: string
    /**
     * 退出 beacon 已经用该 revision 发出请求，本地队列必须保存同一个
     * baseRevision，否则同一 mutationId 的重试会变成 state_conflict。
     */
    baseRevision?: string
  }): Promise<SavedLocalProgress>
  markSyncing(
    bookId: string,
    mutation: ProgressMutation,
  ): Promise<ProgressOutboxRecord>
  markSynced(
    bookId: string,
    mutation: ProgressMutation,
    server: ReaderProgress,
  ): Promise<SyncedProgress>
  markConflict(
    bookId: string,
    mutation: ProgressMutation,
    conflict: ProgressConflictInfo,
  ): Promise<ProgressOutboxRecord>
  markAuthRequired(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord>
  markRetryableFailure(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord>
  markPermanentFailure(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord>
  adoptServer(
    bookId: string,
    server: ReaderProgress,
  ): Promise<ProgressSnapshotRecord>
  /**
   * 页面卸载 beacon 已被服务器接受后确认本地队列：beacon 提交的位置
   * 已经覆盖所有更旧的待同步位置，只保留之后才产生的更新位置。
   */
  markDispatchedSynced(
    bookId: string,
    mutation: ProgressMutation,
    server: ReaderProgress,
    keepMutationIds?: ReadonlySet<string>,
  ): Promise<SyncedProgress>
  /**
   * 用户明确选择“保留本机”后，用冲突响应中的 current revision 重新基于
   * 服务器记录提交；这不是自动覆盖。
   */
  resolveConflictLocally(
    bookId: string,
    baseRevision: string,
  ): Promise<ProgressOutboxRecord | null>
}

type OutboxStoreRecord = ProgressOutboxRecord

type SnapshotStoreRecord = ProgressSnapshotRecord

const BOOK_FORMATS: readonly BookFormat[] = [
  "epub",
  "pdf",
  "cbz",
  "cbr",
]

function isBookFormat(value: unknown): value is BookFormat {
  return (
    typeof value === "string" &&
    (BOOK_FORMATS as readonly string[]).includes(value)
  )
}

function isNonNegativeRevision(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && !Number.isNaN(Date.parse(value))
  )
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

function parseMutation(
  value: unknown,
  bookId: string,
): ProgressMutation | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.mutationId !== "string" ||
    record.mutationId.length === 0 ||
    record.bookId !== bookId ||
    typeof record.fileVersion !== "string" ||
    !isBookFormat(record.format) ||
    !isNonNegativeRevision(record.baseRevision) ||
    !isReaderLocatorType(record.locatorType) ||
    !isIsoTimestamp(record.createdAt)
  ) {
    return null
  }
  try {
    const location = parseReaderLocation(
      record.locatorType,
      record.locatorPayload,
      record.progressPercent,
    )
    return {
      mutationId: record.mutationId,
      bookId,
      fileVersion: record.fileVersion,
      format: record.format,
      baseRevision: record.baseRevision,
      locatorType: location.locatorType,
      locatorPayload: location.locatorPayload,
      progressPercent: location.progressPercent,
      createdAt: record.createdAt,
    }
  } catch {
    return null
  }
}

function parseConflictInfo(
  value: unknown,
): ProgressConflictInfo | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.code !== "string" ||
    typeof record.message !== "string" ||
    !isIsoTimestamp(record.detectedAt)
  ) {
    return null
  }
  return {
    code: record.code,
    message: record.message,
    currentRevision:
      isNonNegativeRevision(record.currentRevision)
        ? record.currentRevision
        : null,
    current:
      typeof record.current === "object" && record.current !== null
        ? (record.current as ReaderProgress)
        : null,
    detectedAt: record.detectedAt,
  }
}

function parseSnapshotRecord(
  value: unknown,
  bookId: string,
): ProgressSnapshotRecord | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    record.bookId !== bookId ||
    typeof record.fileVersion !== "string" ||
    !isBookFormat(record.format) ||
    !isReaderLocatorType(record.locatorType) ||
    !isNonNegativeRevision(record.revision) ||
    !isIsoTimestamp(record.updatedAt) ||
    !isIsoTimestamp(record.savedAt)
  ) {
    return null
  }
  if (
    record.source !== "local" &&
    record.source !== "server" &&
    record.source !== "conflict"
  ) {
    return null
  }
  try {
    const location = parseReaderLocation(
      record.locatorType,
      record.locatorPayload,
      record.progressPercent,
    )
    return {
      schemaVersion: 1,
      bookId,
      fileVersion: record.fileVersion,
      format: record.format,
      locatorType: location.locatorType,
      locatorPayload: location.locatorPayload,
      progressPercent: location.progressPercent,
      revision: record.revision,
      updatedAt: record.updatedAt,
      savedAt: record.savedAt,
      mutationId:
        typeof record.mutationId === "string"
          ? record.mutationId
          : null,
      source: record.source,
      conflict: parseConflictInfo(record.conflict),
    }
  } catch {
    return null
  }
}

function emptyOutbox(bookId: string): ProgressOutboxRecord {
  return {
    bookId,
    pending: null,
    queued: null,
    inFlight: null,
    state: "idle",
    attemptCount: 0,
    lastError: "",
    conflict: null,
    updatedAt: new Date(0).toISOString(),
  }
}

function parseOutboxRecord(
  value: unknown,
  bookId: string,
): ProgressOutboxRecord | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (record.bookId !== bookId) {
    return null
  }
  const state = record.state
  if (
    state !== "idle" &&
    state !== "pending" &&
    state !== "syncing" &&
    state !== "conflict" &&
    state !== "auth-required" &&
    state !== "error"
  ) {
    return null
  }
  return {
    bookId,
    pending: parseMutation(record.pending, bookId),
    queued: parseMutation(record.queued, bookId),
    inFlight: parseMutation(record.inFlight, bookId),
    state,
    attemptCount:
      typeof record.attemptCount === "number" &&
      Number.isFinite(record.attemptCount) &&
      record.attemptCount >= 0
        ? Math.floor(record.attemptCount)
        : 0,
    lastError:
      typeof record.lastError === "string" ? record.lastError : "",
    conflict: parseConflictInfo(record.conflict),
    updatedAt: isIsoTimestamp(record.updatedAt)
      ? record.updatedAt
      : new Date(0).toISOString(),
  }
}

function mutationFromSnapshot(
  snapshot: ProgressSnapshotRecord,
  mutationId: string,
  baseRevision: string,
  createdAt: string,
): ProgressMutation {
  return {
    mutationId,
    bookId: snapshot.bookId,
    fileVersion: snapshot.fileVersion,
    format: snapshot.format,
    baseRevision,
    locatorType: snapshot.locatorType,
    locatorPayload: snapshot.locatorPayload,
    progressPercent: snapshot.progressPercent,
    createdAt,
  }
}

export function snapshotFromServer(
  bookId: string,
  server: ReaderProgress,
  savedAt: string = server.updatedAt,
): ProgressSnapshotRecord {
  return {
    schemaVersion: 1,
    bookId,
    fileVersion: server.fileVersion,
    format: server.format,
    locatorType: server.locatorType,
    locatorPayload: server.locatorPayload,
    progressPercent: server.progressPercent,
    revision: server.revision,
    updatedAt: server.updatedAt,
    savedAt,
    mutationId: null,
    source: "server",
    conflict: null,
  }
}

/**
 * 快照的“位置时间”。退出快照与 IndexedDB 快照都用它判断谁更新：
 * savedAt 是用户到达该位置的时刻，不能被服务器确认时间覆盖，
 * 否则刚确认的旧位置会反过来压掉更新的退出快照。
 */
export function snapshotFreshnessMs(
  snapshot: ProgressSnapshotRecord,
): number {
  const savedAt = Date.parse(snapshot.savedAt)
  if (Number.isFinite(savedAt)) {
    return savedAt
  }
  const updatedAt = Date.parse(snapshot.updatedAt)
  return Number.isFinite(updatedAt) ? updatedAt : 0
}

/**
 * 选择较新的本机位置。相同时间优先返回 secondary（页面卸载最后写入的
 * 退出快照），避免同毫秒写入时退回 IndexedDB 的旧位置。
 */
export function pickNewerSnapshot(
  primary: ProgressSnapshotRecord | null,
  secondary: ProgressSnapshotRecord | null,
): ProgressSnapshotRecord | null {
  if (primary === null) {
    return secondary
  }
  if (secondary === null) {
    return primary
  }
  return snapshotFreshnessMs(secondary) >= snapshotFreshnessMs(primary)
    ? secondary
    : primary
}

export interface ReaderProgressStoreOptions {
  dbName?: string
  factory?: IDBFactory
  now?: () => number
}

export class ReaderProgressStore implements ProgressPersistence {
  readonly #dbName: string
  readonly #factory: IDBFactory | null
  readonly #now: () => number
  #db: IDBDatabase | null = null
  #opening: Promise<void> | null = null
  #closed = false

  constructor(options: ReaderProgressStoreOptions = {}) {
    this.#dbName = options.dbName ?? PROGRESS_DB_NAME
    this.#factory =
      options.factory ??
      (typeof indexedDB === "undefined" ? null : indexedDB)
    this.#now = options.now ?? (() => Date.now())
  }

  get dbName(): string {
    return this.#dbName
  }

  async open(): Promise<void> {
    if (this.#closed) {
      throw new Error("进度存储已关闭。")
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
    const request = factory.open(this.#dbName, PROGRESS_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROGRESS_SNAPSHOT_STORE)) {
        const store = db.createObjectStore(PROGRESS_SNAPSHOT_STORE, {
          keyPath: "bookId",
        })
        store.createIndex("updatedAt", "updatedAt")
      }
      if (!db.objectStoreNames.contains(PROGRESS_OUTBOX_STORE)) {
        const store = db.createObjectStore(PROGRESS_OUTBOX_STORE, {
          keyPath: "bookId",
        })
        store.createIndex("state", "state")
      }
    }
    const db = await requestToPromise(request)
    this.#db = db
    db.onversionchange = () => {
      db.close()
      this.#db = null
    }
  }

  close(): void {
    this.#closed = true
    this.#db?.close()
    this.#db = null
  }

  async #requireDb(): Promise<IDBDatabase> {
    await this.open()
    if (this.#db === null) {
      throw new Error("进度存储不可用。")
    }
    return this.#db
  }

  async recover(): Promise<void> {
    const db = await this.#requireDb()
    const tx = db.transaction(PROGRESS_OUTBOX_STORE, "readwrite")
    const store = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const records = await requestToPromise<OutboxStoreRecord[]>(
      store.getAll(),
    )
    for (const record of records) {
      if (record.inFlight === null) {
        continue
      }
      // 页面在请求返回前被杀死：同一个 mutationId 重试是幂等的，
      // 但不能丢弃期间产生的更新位置。
      const retry = record.inFlight
      store.put({
        ...record,
        inFlight: null,
        // 先重试在途 mutation 确认服务端结果；期间的新位置进 queued。
        pending: retry,
        queued: record.pending ?? record.queued,
        state:
          record.state === "conflict"
            ? "conflict"
            : record.state === "auth-required"
              ? "auth-required"
              : record.state === "error"
                ? "error"
                : "pending",
        updatedAt: new Date(this.#now()).toISOString(),
      } satisfies OutboxStoreRecord)
    }
    await transactionDone(tx)
  }

  async getSnapshot(
    bookId: string,
  ): Promise<ProgressSnapshotRecord | null> {
    const db = await this.#requireDb()
    const tx = db.transaction(PROGRESS_SNAPSHOT_STORE, "readonly")
    const store = tx.objectStore(PROGRESS_SNAPSHOT_STORE)
    const record = await requestToPromise<SnapshotStoreRecord | undefined>(
      store.get(bookId),
    )
    await transactionDone(tx)
    return record === undefined
      ? null
      : parseSnapshotRecord(record, bookId)
  }

  async getOutbox(
    bookId: string,
  ): Promise<ProgressOutboxRecord | null> {
    const db = await this.#requireDb()
    const tx = db.transaction(PROGRESS_OUTBOX_STORE, "readonly")
    const store = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const record = await requestToPromise<OutboxStoreRecord | undefined>(
      store.get(bookId),
    )
    await transactionDone(tx)
    return record === undefined
      ? null
      : parseOutboxRecord(record, bookId)
  }

  async listOutbox(): Promise<ProgressOutboxRecord[]> {
    const db = await this.#requireDb()
    const tx = db.transaction(PROGRESS_OUTBOX_STORE, "readonly")
    const records = await requestToPromise<OutboxStoreRecord[]>(
      tx.objectStore(PROGRESS_OUTBOX_STORE).getAll(),
    )
    await transactionDone(tx)
    return records
      .map((record) => parseOutboxRecord(record, record.bookId))
      .filter((record): record is ProgressOutboxRecord => record !== null)
  }

  async saveLocal(input: {
    bookId: string
    fileVersion: string
    format: BookFormat
    locator: ReaderLocation
    mutationId: string
    baseRevision?: string
  }): Promise<SavedLocalProgress> {
    const db = await this.#requireDb()
    const nowIso = new Date(this.#now()).toISOString()
    const tx = db.transaction(
      [PROGRESS_SNAPSHOT_STORE, PROGRESS_OUTBOX_STORE],
      "readwrite",
    )
    const snapshotStore = tx.objectStore(PROGRESS_SNAPSHOT_STORE)
    const outboxStore = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const [existingSnapshot, existingOutbox] = await Promise.all([
      requestToPromise<SnapshotStoreRecord | undefined>(
        snapshotStore.get(input.bookId),
      ),
      requestToPromise<OutboxStoreRecord | undefined>(
        outboxStore.get(input.bookId),
      ),
    ])
    const snapshot =
      existingSnapshot === undefined
        ? null
        : parseSnapshotRecord(existingSnapshot, input.bookId)
    const outbox =
      existingOutbox === undefined
        ? null
        : parseOutboxRecord(existingOutbox, input.bookId)
    const baseRevision =
      input.baseRevision ?? snapshot?.revision ?? "0"
    const nextSnapshot: ProgressSnapshotRecord = {
      schemaVersion: 1,
      bookId: input.bookId,
      fileVersion: input.fileVersion,
      format: input.format,
      locatorType: input.locator.locatorType,
      locatorPayload: input.locator.locatorPayload,
      progressPercent: input.locator.progressPercent,
      revision: baseRevision,
      updatedAt: snapshot?.updatedAt ?? nowIso,
      savedAt: nowIso,
      mutationId: input.mutationId,
      source: "local",
      conflict: outbox?.conflict ?? null,
    }
    const mutation = mutationFromSnapshot(
      nextSnapshot,
      input.mutationId,
      baseRevision,
      nowIso,
    )
    let nextOutbox: ProgressOutboxRecord
    if (outbox === null) {
      nextOutbox = {
        ...emptyOutbox(input.bookId),
        pending: mutation,
        state: "pending",
        updatedAt: nowIso,
      }
    } else if (outbox.inFlight !== null || outbox.pending !== null) {
      nextOutbox = {
        ...outbox,
        queued: mutation,
        state:
          outbox.state === "conflict" ||
          outbox.state === "auth-required" ||
          outbox.state === "error"
            ? outbox.state
            : outbox.state === "idle"
              ? "pending"
              : outbox.state,
        updatedAt: nowIso,
      }
    } else {
      nextOutbox = {
        ...outbox,
        pending: mutation,
        state:
          outbox.state === "conflict" ||
          outbox.state === "auth-required" ||
          outbox.state === "error"
            ? outbox.state
            : "pending",
        updatedAt: nowIso,
      }
    }
    snapshotStore.put(
      nextSnapshot as unknown as SnapshotStoreRecord,
    )
    outboxStore.put(nextOutbox as unknown as OutboxStoreRecord)
    await transactionDone(tx)
    return { snapshot: nextSnapshot, outbox: nextOutbox }
  }

  async markSyncing(
    bookId: string,
    mutation: ProgressMutation,
  ): Promise<ProgressOutboxRecord> {
    const db = await this.#requireDb()
    const tx = db.transaction(PROGRESS_OUTBOX_STORE, "readwrite")
    const store = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const existing = await requestToPromise<
      OutboxStoreRecord | undefined
    >(store.get(bookId))
    const record =
      existing === undefined
        ? emptyOutbox(bookId)
        : parseOutboxRecord(existing, bookId) ?? emptyOutbox(bookId)
    const next: ProgressOutboxRecord = {
      ...record,
      pending:
        record.pending?.mutationId === mutation.mutationId
          ? null
          : record.pending,
      inFlight: mutation,
      state: "syncing",
      attemptCount: record.attemptCount + 1,
      lastError: "",
      updatedAt: new Date(this.#now()).toISOString(),
    }
    store.put(next as unknown as OutboxStoreRecord)
    await transactionDone(tx)
    return next
  }

  async markSynced(
    bookId: string,
    mutation: ProgressMutation,
    server: ReaderProgress,
  ): Promise<SyncedProgress> {
    const db = await this.#requireDb()
    const nowIso = new Date(this.#now()).toISOString()
    const tx = db.transaction(
      [PROGRESS_SNAPSHOT_STORE, PROGRESS_OUTBOX_STORE],
      "readwrite",
    )
    const snapshotStore = tx.objectStore(PROGRESS_SNAPSHOT_STORE)
    const outboxStore = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const [existingSnapshot, existingOutbox] = await Promise.all([
      requestToPromise<SnapshotStoreRecord | undefined>(
        snapshotStore.get(bookId),
      ),
      requestToPromise<OutboxStoreRecord | undefined>(
        outboxStore.get(bookId),
      ),
    ])
    const snapshot =
      existingSnapshot === undefined
        ? null
        : parseSnapshotRecord(existingSnapshot, bookId)
    const record =
      existingOutbox === undefined
        ? emptyOutbox(bookId)
        : parseOutboxRecord(existingOutbox, bookId) ?? emptyOutbox(bookId)
    let nextSnapshot: ProgressSnapshotRecord
    if (snapshot === null) {
      nextSnapshot = snapshotFromServer(bookId, server)
    } else if (snapshot.mutationId === mutation.mutationId) {
      // 位置没变，只确认服务器 revision；保留用户到达该位置的 savedAt，
      // 避免服务器确认时间反过来压掉更新的退出快照。
      nextSnapshot = {
        ...snapshotFromServer(bookId, server),
        savedAt: snapshot.savedAt,
      }
    } else {
      // 本地已有更新位置：只确认新 revision，不回退位置。
      nextSnapshot = {
        ...snapshot,
        revision: server.revision,
        updatedAt: server.updatedAt,
        source: "local",
      }
    }
    const nextQueued = record.queued
    const nextOutbox: ProgressOutboxRecord = {
      ...record,
      inFlight:
        record.inFlight?.mutationId === mutation.mutationId
          ? null
          : record.inFlight,
      pending:
        nextQueued === null
          ? null
          : { ...nextQueued, baseRevision: server.revision },
      queued: null,
      state: nextQueued === null ? "idle" : "pending",
      lastError: "",
      updatedAt: nowIso,
    }
    snapshotStore.put(
      nextSnapshot as unknown as SnapshotStoreRecord,
    )
    outboxStore.put(nextOutbox as unknown as OutboxStoreRecord)
    await transactionDone(tx)
    return { snapshot: nextSnapshot, outbox: nextOutbox }
  }

  /**
   * 页面卸载 beacon 走的是“先发请求、后写 IndexedDB”的路径，不能复用
   * markSyncing/markSynced：beacon mutation 可能还在 queued，而
   * markSynced 会把它当成待发送位置重新入队并改写 baseRevision。
   * 这里直接确认 beacon 位置，并丢弃被它覆盖的更旧位置。
   */
  async markDispatchedSynced(
    bookId: string,
    mutation: ProgressMutation,
    server: ReaderProgress,
    keepMutationIds?: ReadonlySet<string>,
  ): Promise<SyncedProgress> {
    const db = await this.#requireDb()
    const nowIso = new Date(this.#now()).toISOString()
    const tx = db.transaction(
      [PROGRESS_SNAPSHOT_STORE, PROGRESS_OUTBOX_STORE],
      "readwrite",
    )
    const snapshotStore = tx.objectStore(PROGRESS_SNAPSHOT_STORE)
    const outboxStore = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const [existingSnapshot, existingOutbox] = await Promise.all([
      requestToPromise<SnapshotStoreRecord | undefined>(
        snapshotStore.get(bookId),
      ),
      requestToPromise<OutboxStoreRecord | undefined>(
        outboxStore.get(bookId),
      ),
    ])
    const snapshot =
      existingSnapshot === undefined
        ? null
        : parseSnapshotRecord(existingSnapshot, bookId)
    const record =
      existingOutbox === undefined
        ? emptyOutbox(bookId)
        : parseOutboxRecord(existingOutbox, bookId) ?? emptyOutbox(bookId)
    if (record.state === "conflict") {
      // 冲突未由用户解决前不自动覆盖队列或快照。
      await transactionDone(tx)
      return {
        snapshot:
          snapshot ?? snapshotFromServer(bookId, server),
        outbox: record,
      }
    }
    const nextSnapshot: ProgressSnapshotRecord =
      snapshot === null
        ? snapshotFromServer(bookId, server)
        : snapshot.mutationId === mutation.mutationId
          ? {
              ...snapshotFromServer(bookId, server),
              savedAt: snapshot.savedAt,
            }
          : {
              ...snapshot,
              revision: server.revision,
              updatedAt: server.updatedAt,
              source: "local",
            }
    const beaconTime = Date.parse(mutation.createdAt)
    const remaining = [
      record.inFlight,
      record.pending,
      record.queued,
    ]
      .filter(
        (candidate): candidate is ProgressMutation =>
          candidate !== null &&
          candidate.mutationId !== mutation.mutationId,
      )
      .filter((candidate) => {
        if (keepMutationIds?.has(candidate.mutationId) === true) {
          return true
        }
        const candidateTime = Date.parse(candidate.createdAt)
        if (!Number.isFinite(beaconTime) || !Number.isFinite(candidateTime)) {
          return false
        }
        // 只保留 beacon 之后才产生的更新位置。
        return candidateTime > beaconTime
      })
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      )
    const nextOutbox: ProgressOutboxRecord = {
      ...record,
      pending: remaining[0] ?? null,
      queued: remaining[1] ?? null,
      inFlight: null,
      state: remaining.length === 0 ? "idle" : "pending",
      lastError: "",
      updatedAt: nowIso,
    }
    snapshotStore.put(
      nextSnapshot as unknown as SnapshotStoreRecord,
    )
    outboxStore.put(nextOutbox as unknown as OutboxStoreRecord)
    await transactionDone(tx)
    return { snapshot: nextSnapshot, outbox: nextOutbox }
  }

  async markConflict(
    bookId: string,
    mutation: ProgressMutation,
    conflict: ProgressConflictInfo,
  ): Promise<ProgressOutboxRecord> {
    const db = await this.#requireDb()
    const nowIso = new Date(this.#now()).toISOString()
    const tx = db.transaction(
      [PROGRESS_SNAPSHOT_STORE, PROGRESS_OUTBOX_STORE],
      "readwrite",
    )
    const snapshotStore = tx.objectStore(PROGRESS_SNAPSHOT_STORE)
    const outboxStore = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const [existingSnapshot, existingOutbox] = await Promise.all([
      requestToPromise<SnapshotStoreRecord | undefined>(
        snapshotStore.get(bookId),
      ),
      requestToPromise<OutboxStoreRecord | undefined>(
        outboxStore.get(bookId),
      ),
    ])
    const snapshot =
      existingSnapshot === undefined
        ? null
        : parseSnapshotRecord(existingSnapshot, bookId)
    const record =
      existingOutbox === undefined
        ? emptyOutbox(bookId)
        : parseOutboxRecord(existingOutbox, bookId) ?? emptyOutbox(bookId)
    const nextOutbox: ProgressOutboxRecord = {
      ...record,
      pending:
        record.inFlight?.mutationId === mutation.mutationId
          ? (record.pending ?? record.inFlight)
          : record.pending,
      inFlight: null,
      state: "conflict",
      conflict,
      lastError: conflict.message,
      updatedAt: nowIso,
    }
    if (snapshot !== null) {
      snapshotStore.put({
        ...snapshot,
        source: "conflict",
        conflict,
      } as unknown as SnapshotStoreRecord)
    }
    outboxStore.put(nextOutbox as unknown as OutboxStoreRecord)
    await transactionDone(tx)
    return nextOutbox
  }

  async markAuthRequired(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord> {
    return this.#markFailure(bookId, mutation, "auth-required", message)
  }

  async markRetryableFailure(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord> {
    return this.#markFailure(bookId, mutation, "pending", message)
  }

  async markPermanentFailure(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord> {
    return this.#markFailure(bookId, mutation, "error", message)
  }

  async #markFailure(
    bookId: string,
    mutation: ProgressMutation,
    state: ProgressOutboxState,
    message: string,
  ): Promise<ProgressOutboxRecord> {
    const db = await this.#requireDb()
    const tx = db.transaction(PROGRESS_OUTBOX_STORE, "readwrite")
    const store = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const existing = await requestToPromise<
      OutboxStoreRecord | undefined
    >(store.get(bookId))
    const record =
      existing === undefined
        ? emptyOutbox(bookId)
        : parseOutboxRecord(existing, bookId) ?? emptyOutbox(bookId)
    const next: ProgressOutboxRecord = {
      ...record,
      pending:
        record.inFlight?.mutationId === mutation.mutationId
          ? (record.pending ?? record.inFlight)
          : record.pending,
      inFlight: null,
      state,
      lastError: message,
      updatedAt: new Date(this.#now()).toISOString(),
    }
    store.put(next as unknown as OutboxStoreRecord)
    await transactionDone(tx)
    return next
  }

  async adoptServer(
    bookId: string,
    server: ReaderProgress,
  ): Promise<ProgressSnapshotRecord> {
    const db = await this.#requireDb()
    const tx = db.transaction(
      [PROGRESS_SNAPSHOT_STORE, PROGRESS_OUTBOX_STORE],
      "readwrite",
    )
    const snapshot = snapshotFromServer(bookId, server)
    tx.objectStore(PROGRESS_SNAPSHOT_STORE).put(
      snapshot as unknown as SnapshotStoreRecord,
    )
    tx.objectStore(PROGRESS_OUTBOX_STORE).delete(bookId)
    await transactionDone(tx)
    return snapshot
  }

  async resolveConflictLocally(
    bookId: string,
    baseRevision: string,
  ): Promise<ProgressOutboxRecord | null> {
    const db = await this.#requireDb()
    const nowIso = new Date(this.#now()).toISOString()
    const tx = db.transaction(
      [PROGRESS_SNAPSHOT_STORE, PROGRESS_OUTBOX_STORE],
      "readwrite",
    )
    const outboxStore = tx.objectStore(PROGRESS_OUTBOX_STORE)
    const snapshotStore = tx.objectStore(PROGRESS_SNAPSHOT_STORE)
    const [existing, snapshot] = await Promise.all([
      requestToPromise<OutboxStoreRecord | undefined>(
        outboxStore.get(bookId),
      ),
      requestToPromise<SnapshotStoreRecord | undefined>(
        snapshotStore.get(bookId),
      ),
    ])
    const record =
      existing === undefined
        ? null
        : parseOutboxRecord(existing, bookId)
    if (record === null || record.pending === null) {
      await transactionDone(tx)
      return null
    }
    const next: ProgressOutboxRecord = {
      ...record,
      pending: { ...record.pending, baseRevision },
      state: "pending",
      conflict: null,
      lastError: "",
      updatedAt: nowIso,
    }
    outboxStore.put(next as unknown as OutboxStoreRecord)
    if (snapshot !== undefined) {
      const parsed = parseSnapshotRecord(snapshot, bookId)
      if (parsed !== null) {
        snapshotStore.put({
          ...parsed,
          source: "local",
          conflict: null,
        } as unknown as SnapshotStoreRecord)
      }
    }
    await transactionDone(tx)
    return next
  }
}
