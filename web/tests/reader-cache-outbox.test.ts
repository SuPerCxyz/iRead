import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "../src/lib/api"
import type { BookFormat } from "../src/features/library/types"
import type { ReaderLocation, ReaderProgress } from "../src/features/reader/types"
import type { SaveReaderProgressInput } from "../src/features/reader/shell/reader-api"
import { localReaderSnapshotStore } from "../src/features/reader/session/local-snapshot"
import { snapshotFromServer } from "../src/features/reader/session/progress-store"
import {
  ReaderProgressSync,
  createDefaultProgressTransport,
  type BroadcastPayload,
  type ProgressChannel,
  type ProgressLockManager,
  type ProgressTransport,
  type ReaderProgressSyncEvent,
} from "../src/features/reader/session/progress-outbox"
import type {
  ProgressMutation,
  ProgressOutboxRecord,
  ProgressPersistence,
  ProgressSnapshotRecord,
  SavedLocalProgress,
  SyncedProgress,
} from "../src/features/reader/session/progress-store"

const BOOK_ID = "book-1"
const FILE_VERSION = "f".repeat(64)
const FORMAT: BookFormat = "epub"

function location(percent: number): ReaderLocation {
  return {
    locatorType: "epub-cfi",
    locatorPayload: {
      locatorVersion: 1,
      spineIndex: 2,
      resourceId: "r1",
      href: "OEBPS/chapter2.xhtml",
      cfi: "epubcfi(/6/4!/4/2)",
      chapterProgress: 0.5,
      textQuote: null,
    },
    progressPercent: percent,
  }
}

function locationAt(spineIndex: number, percent: number): ReaderLocation {
  return {
    locatorType: "epub-cfi",
    locatorPayload: {
      locatorVersion: 1,
      spineIndex,
      resourceId: `r${spineIndex}`,
      href: `OEBPS/chapter${spineIndex}.xhtml`,
      cfi: `epubcfi(/6/${spineIndex * 2}!/4/2)`,
      chapterProgress: 0.5,
      textQuote: null,
    },
    progressPercent: percent,
  }
}

function serverProgress(
  input: SaveReaderProgressInput,
  revision: string,
): ReaderProgress {
  return {
    schemaVersion: 1,
    bookId: input.bookId,
    fileVersion: input.fileVersion,
    format: input.format,
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    revision,
    locatorType: input.locatorType,
    locatorPayload: input.locatorPayload,
    progressPercent: input.progressPercent,
  } as ReaderProgress
}

function exitSnapshotAt(
  percent: number,
  savedAtMs: number,
): ProgressSnapshotRecord {
  const savedAt = new Date(savedAtMs).toISOString()
  return {
    schemaVersion: 1,
    bookId: BOOK_ID,
    fileVersion: FILE_VERSION,
    format: FORMAT,
    locatorType: "epub-cfi",
    locatorPayload: location(percent).locatorPayload,
    progressPercent: percent,
    revision: "0",
    updatedAt: savedAt,
    savedAt,
    mutationId: null,
    source: "local",
    conflict: null,
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

function mutationFrom(
  snapshot: ProgressSnapshotRecord,
  mutationId: string,
  baseRevision: string,
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
    createdAt: new Date(1_700_000_000_000).toISOString(),
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

class MemoryProgressStore implements ProgressPersistence {
  readonly snapshots = new Map<string, ProgressSnapshotRecord>()
  readonly outbox = new Map<string, ProgressOutboxRecord>()
  saveCalls = 0

  async open(): Promise<void> {
    return
  }

  close(): void {
    return
  }

  async recover(): Promise<void> {
    for (const [bookId, record] of this.outbox) {
      if (record.inFlight === null) {
        continue
      }
      this.outbox.set(bookId, {
        ...record,
        inFlight: null,
        pending: record.inFlight,
        queued: record.pending ?? record.queued,
        state:
          record.state === "conflict" ? "conflict" : "pending",
      })
    }
  }

  async getSnapshot(
    bookId: string,
  ): Promise<ProgressSnapshotRecord | null> {
    return this.snapshots.get(bookId) ?? null
  }

  async getOutbox(
    bookId: string,
  ): Promise<ProgressOutboxRecord | null> {
    return this.outbox.get(bookId) ?? null
  }

  async listOutbox(): Promise<ProgressOutboxRecord[]> {
    return [...this.outbox.values()]
  }

  async saveLocal(input: {
    bookId: string
    fileVersion: string
    format: BookFormat
    locator: ReaderLocation
    mutationId: string
    baseRevision?: string
  }): Promise<SavedLocalProgress> {
    this.saveCalls += 1
    const existing = this.snapshots.get(input.bookId) ?? null
    const baseRevision =
      input.baseRevision ?? existing?.revision ?? "0"
    const snapshot: ProgressSnapshotRecord = {
      schemaVersion: 1,
      bookId: input.bookId,
      fileVersion: input.fileVersion,
      format: input.format,
      locatorType: input.locator.locatorType,
      locatorPayload: input.locator.locatorPayload,
      progressPercent: input.locator.progressPercent,
      revision: baseRevision,
      updatedAt:
        existing?.updatedAt ?? new Date(1_700_000_000_000).toISOString(),
      savedAt: new Date(1_700_000_000_000).toISOString(),
      mutationId: input.mutationId,
      source: "local",
      conflict: existing?.conflict ?? null,
    }
    const mutation = mutationFrom(
      snapshot,
      input.mutationId,
      snapshot.revision,
    )
    const current =
      this.outbox.get(input.bookId) ?? emptyOutbox(input.bookId)
    const nextOutbox =
      current.pending !== null || current.inFlight !== null
        ? { ...current, queued: mutation, state: current.state === "idle" ? "pending" : current.state }
        : { ...current, pending: mutation, state: current.state === "idle" ? "pending" : current.state }
    this.snapshots.set(input.bookId, snapshot)
    this.outbox.set(input.bookId, nextOutbox)
    return { snapshot, outbox: nextOutbox }
  }

  async markSyncing(
    bookId: string,
    mutation: ProgressMutation,
  ): Promise<ProgressOutboxRecord> {
    const record = this.outbox.get(bookId) ?? emptyOutbox(bookId)
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
    }
    this.outbox.set(bookId, next)
    return next
  }

  async markSynced(
    bookId: string,
    mutation: ProgressMutation,
    server: ReaderProgress,
  ): Promise<SyncedProgress> {
    const existing = this.snapshots.get(bookId) ?? null
    const snapshot: ProgressSnapshotRecord =
      existing === null
        ? {
            schemaVersion: 1,
            bookId,
            fileVersion: server.fileVersion,
            format: server.format,
            locatorType: server.locatorType,
            locatorPayload: server.locatorPayload,
            progressPercent: server.progressPercent,
            revision: server.revision,
            updatedAt: server.updatedAt,
            savedAt: server.updatedAt,
            mutationId: null,
            source: "server",
            conflict: null,
          }
        : existing.mutationId === mutation.mutationId
          ? {
              ...existing,
              locatorType: server.locatorType,
              locatorPayload: server.locatorPayload,
              progressPercent: server.progressPercent,
              revision: server.revision,
              updatedAt: server.updatedAt,
              mutationId: null,
              source: "server",
            }
          : {
              ...existing,
              revision: server.revision,
              updatedAt: server.updatedAt,
            }
    const record = this.outbox.get(bookId) ?? emptyOutbox(bookId)
    const queued = record.queued
    const outbox: ProgressOutboxRecord = {
      ...record,
      inFlight: null,
      pending:
        queued === null
          ? null
          : { ...queued, baseRevision: server.revision },
      queued: null,
      state: queued === null ? "idle" : "pending",
      lastError: "",
    }
    this.snapshots.set(bookId, snapshot)
    this.outbox.set(bookId, outbox)
    return { snapshot, outbox }
  }

  async markDispatchedSynced(
    bookId: string,
    mutation: ProgressMutation,
    server: ReaderProgress,
    keepMutationIds?: ReadonlySet<string>,
  ): Promise<SyncedProgress> {
    const existing = this.snapshots.get(bookId) ?? null
    const record = this.outbox.get(bookId) ?? emptyOutbox(bookId)
    if (record.state === "conflict") {
      return {
        snapshot: existing ?? snapshotFromServer(bookId, server),
        outbox: record,
      }
    }
    const snapshot: ProgressSnapshotRecord =
      existing === null
        ? snapshotFromServer(bookId, server)
        : existing.mutationId === mutation.mutationId
          ? {
              ...snapshotFromServer(bookId, server),
              savedAt: existing.savedAt,
            }
          : {
              ...existing,
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
        return (
          Number.isFinite(beaconTime) &&
          Number.isFinite(candidateTime) &&
          candidateTime > beaconTime
        )
      })
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      )
    const outbox: ProgressOutboxRecord = {
      ...record,
      pending: remaining[0] ?? null,
      queued: remaining[1] ?? null,
      inFlight: null,
      state: remaining.length === 0 ? "idle" : "pending",
      lastError: "",
    }
    this.snapshots.set(bookId, snapshot)
    this.outbox.set(bookId, outbox)
    return { snapshot, outbox }
  }

  async markConflict(
    bookId: string,
    mutation: ProgressMutation,
    conflict: ProgressOutboxRecord["conflict"],
  ): Promise<ProgressOutboxRecord> {    const record = this.outbox.get(bookId) ?? emptyOutbox(bookId)
    const next: ProgressOutboxRecord = {
      ...record,
      pending:
        record.inFlight?.mutationId === mutation.mutationId
          ? (record.pending ?? record.inFlight)
          : record.pending,
      inFlight: null,
      state: "conflict",
      conflict,
    }
    this.outbox.set(bookId, next)
    const snapshot = this.snapshots.get(bookId)
    if (snapshot !== undefined) {
      this.snapshots.set(bookId, {
        ...snapshot,
        source: "conflict",
        conflict,
      })
    }
    return next
  }

  async markAuthRequired(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord> {
    return this.#failure(bookId, mutation, "auth-required", message)
  }

  async markRetryableFailure(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord> {
    return this.#failure(bookId, mutation, "pending", message)
  }

  async markPermanentFailure(
    bookId: string,
    mutation: ProgressMutation,
    message: string,
  ): Promise<ProgressOutboxRecord> {
    return this.#failure(bookId, mutation, "error", message)
  }

  async adoptServer(
    bookId: string,
    server: ReaderProgress,
  ): Promise<ProgressSnapshotRecord> {
    const snapshot: ProgressSnapshotRecord = {
      schemaVersion: 1,
      bookId,
      fileVersion: server.fileVersion,
      format: server.format,
      locatorType: server.locatorType,
      locatorPayload: server.locatorPayload,
      progressPercent: server.progressPercent,
      revision: server.revision,
      updatedAt: server.updatedAt,
      savedAt: server.updatedAt,
      mutationId: null,
      source: "server",
      conflict: null,
    }
    this.snapshots.set(bookId, snapshot)
    this.outbox.delete(bookId)
    return snapshot
  }

  async resolveConflictLocally(
    bookId: string,
    baseRevision: string,
  ): Promise<ProgressOutboxRecord | null> {
    const record = this.outbox.get(bookId)
    if (record === undefined || record.pending === null) {
      return null
    }
    const next: ProgressOutboxRecord = {
      ...record,
      pending: { ...record.pending, baseRevision },
      state: "pending",
      conflict: null,
      lastError: "",
    }
    this.outbox.set(bookId, next)
    return next
  }

  #failure(
    bookId: string,
    mutation: ProgressMutation,
    state: ProgressOutboxRecord["state"],
    message: string,
  ): ProgressOutboxRecord {
    const record = this.outbox.get(bookId) ?? emptyOutbox(bookId)
    const next: ProgressOutboxRecord = {
      ...record,
      pending:
        record.inFlight?.mutationId === mutation.mutationId
          ? (record.pending ?? record.inFlight)
          : record.pending,
      inFlight: null,
      state,
      lastError: message,
    }
    this.outbox.set(bookId, next)
    return next
  }
}

class FakeTransport implements ProgressTransport {
  readonly putCalls: SaveReaderProgressInput[] = []
  readonly keepalive: boolean[] = []
  fetchResult: ReaderProgress | null = null
  fetchCalls = 0
  putImpl: (
    input: SaveReaderProgressInput,
    options: { signal?: AbortSignal; keepalive?: boolean },
  ) => Promise<ReaderProgress> = async (input) =>
    serverProgress(input, "1")

  async put(
    input: SaveReaderProgressInput,
    options: { signal?: AbortSignal; keepalive?: boolean },
  ): Promise<ReaderProgress> {
    this.putCalls.push(input)
    this.keepalive.push(options.keepalive === true)
    return this.putImpl(input, options)
  }

  async fetch(): Promise<ReaderProgress | null> {
    this.fetchCalls += 1
    return this.fetchResult
  }
}

class FakeChannel implements ProgressChannel {
  readonly posted: BroadcastPayload[] = []
  onmessage:
    | ((event: MessageEvent<BroadcastPayload>) => void)
    | null = null
  postMessage(message: BroadcastPayload): void {
    this.posted.push(message)
  }
  close(): void {
    return
  }
  receive(payload: BroadcastPayload): void {
    this.onmessage?.({ data: payload } as MessageEvent<BroadcastPayload>)
  }
}

function timerHarness(): {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
  runAll: () => void
  count: () => number
} {
  const timers = new Map<number, () => void>()
  let next = 0
  return {
    setTimer: (callback) => {
      const id = ++next
      timers.set(id, callback)
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    runAll: () => {
      const callbacks = [...timers.values()]
      timers.clear()
      for (const callback of callbacks) {
        callback()
      }
    },
    count: () => timers.size,
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("等待条件超时")
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function createSync(options: {
  store?: MemoryProgressStore
  transport?: FakeTransport
  timers?: ReturnType<typeof timerHarness>
  channel?: ProgressChannel | null
  locks?: ProgressLockManager | null
  lifecycleTarget?: {
    addEventListener(type: string, listener: (event: Event) => void): void
    removeEventListener(type: string, listener: (event: Event) => void): void
  }
  events?: ReaderProgressSyncEvent[]
  now?: () => number
} = {}): {
  sync: ReaderProgressSync
  store: MemoryProgressStore
  transport: FakeTransport
  timers: ReturnType<typeof timerHarness>
} {
  const store = options.store ?? new MemoryProgressStore()
  const transport = options.transport ?? new FakeTransport()
  const timers = options.timers ?? timerHarness()
  const sync = new ReaderProgressSync({
    store,
    transport,
    channel: options.channel ?? null,
    locks: options.locks ?? null,
    lifecycleTarget: options.lifecycleTarget ?? null,
    onlineTarget: null,
    throttleMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 20,
    now: options.now ?? (() => 1_700_000_000_000),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onEvent: (event) => options.events?.push(event),
  })
  return { sync, store, transport, timers }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ReaderProgressSync outbox", () => {
  it("writes locally before any PUT and throttles the flush", async () => {
    const { sync, store, transport, timers } = createSync()
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(12),
      },
      { mutationId: "m1" },
    )
    expect(transport.putCalls).toHaveLength(0)
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(12)
    expect(store.outbox.get(BOOK_ID)?.state).toBe("pending")
    timers.runAll()
    await waitFor(() => transport.putCalls.length === 1)
    expect(store.snapshots.get(BOOK_ID)?.revision).toBe("1")
    expect(store.outbox.get(BOOK_ID)?.state).toBe("idle")
    sync.dispose()
  })

  it("coalesces rapid updates but sends each confirmed mutation in order", async () => {
    const { sync, store, transport, timers } = createSync()
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(10),
      },
      { mutationId: "m1" },
    )
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(20),
      },
      { mutationId: "m2" },
    )
    timers.runAll()
    await waitFor(() => transport.putCalls.length === 2)
    expect(transport.putCalls[0]?.baseRevision).toBe("0")
    expect(transport.putCalls[1]?.baseRevision).toBe("1")
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(20)
    sync.dispose()
  })

  it("keeps a newer local position when an older PUT resolves late", async () => {
    const { sync, store, transport, timers } = createSync()
    const firstGate: { release: (() => void) | null } = {
      release: null,
    }
    let callCount = 0
    transport.putImpl = (input) => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<ReaderProgress>((resolve) => {
          firstGate.release = () => resolve(serverProgress(input, "1"))
        })
      }
      return Promise.resolve(serverProgress(input, String(callCount)))
    }
    const first = sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(10),
      },
      { mutationId: "m1", immediate: true },
    )
    await waitFor(() => transport.putCalls.length === 1)
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(30),
      },
      { mutationId: "m2" },
    )
    expect(firstGate.release).not.toBeNull()
    firstGate.release?.()
    await first
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(30)
    timers.runAll()
    await waitFor(() => transport.putCalls.length === 2)
    expect(transport.putCalls[1]?.baseRevision).toBe("1")
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(30)
    sync.dispose()
  })

  it("does not auto-overwrite a 409 conflict and preserves both sides", async () => {
    const { sync, store, transport, timers } = createSync()
    const current = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(80).locatorPayload,
        progressPercent: 80,
      },
      "9",
    )
    transport.putImpl = async () => {
      throw new ApiError(
        409,
        "revision_conflict",
        "进度已在别处更新。",
        "",
        { current },
      )
    }
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(40),
      },
      { mutationId: "m1", immediate: true },
    )
    const outbox = store.outbox.get(BOOK_ID)
    expect(outbox?.state).toBe("conflict")
    expect(outbox?.conflict?.currentRevision).toBe("9")
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(40)
    const flushed = await sync.flushBook(BOOK_ID)
    expect(flushed.status).toBe("conflict")
    await sync.resume()
    expect(transport.putCalls).toHaveLength(1)
    expect(timers.count()).toBe(0)
    transport.putImpl = async (input) => serverProgress(input, "10")
    const resolved = await sync.resolveConflict(BOOK_ID, "keep-local")
    expect(resolved.status).toBe("saved")
    expect(transport.putCalls.at(-1)?.baseRevision).toBe("9")
    expect(store.outbox.get(BOOK_ID)?.state).toBe("idle")
    sync.dispose()
  })

  it("waits for re-authentication instead of dropping the outbox", async () => {
    const { sync, store, transport, timers } = createSync()
    transport.putImpl = async () => {
      throw new ApiError(401, "unauthenticated", "请重新登录。", "", {})
    }
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(25),
      },
      { mutationId: "m1", immediate: true },
    )
    expect(store.outbox.get(BOOK_ID)?.state).toBe("auth-required")
    transport.putImpl = async (input) => serverProgress(input, "2")
    await sync.resume()
    expect(store.outbox.get(BOOK_ID)?.state).toBe("idle")
    expect(store.snapshots.get(BOOK_ID)?.revision).toBe("2")
    sync.dispose()
    expect(timers.count()).toBe(0)
  })

  it("retries retryable network failures with backoff", async () => {
    const { sync, store, transport, timers } = createSync()
    let attempts = 0
    transport.putImpl = async (input) => {
      attempts += 1
      if (attempts === 1) {
        throw new ApiError(0, "network_error", "离线。", "", {})
      }
      return serverProgress(input, "1")
    }
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(50),
      },
      { mutationId: "m1", immediate: true },
    )
    expect(store.outbox.get(BOOK_ID)?.state).toBe("pending")
    expect(timers.count()).toBe(1)
    timers.runAll()
    await waitFor(() => attempts === 2)
    expect(store.outbox.get(BOOK_ID)?.state).toBe("idle")
    sync.dispose()
  })

  it("reconciles server-newer progress and respects pending local work", async () => {
    const { sync, store, transport } = createSync()
    transport.fetchResult = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(70).locatorPayload,
        progressPercent: 70,
      },
      "5",
    )
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(20),
      },
      { mutationId: "m1" },
    )
    const pendingResult = await sync.reconcile(BOOK_ID)
    expect(pendingResult.status).toBe("pending")
    expect(pendingResult.adopted).toBe(false)
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(20)
    // 清掉待同步后，服务器 revision 更高才可采纳。
    await sync.store.markSynced(
      BOOK_ID,
      mutationFrom(store.snapshots.get(BOOK_ID)!, "m1", "0"),
      serverProgress(
        {
          bookId: BOOK_ID,
          fileVersion: FILE_VERSION,
          format: FORMAT,
          baseRevision: "0",
          clientMutationId: "m1",
          locatorType: "epub-cfi",
          locatorPayload: location(20).locatorPayload,
          progressPercent: 20,
        },
        "1",
      ),
    )
    const adopted = await sync.reconcile(BOOK_ID)
    expect(adopted.status).toBe("server-newer")
    expect(adopted.adopted).toBe(true)
    expect(store.snapshots.get(BOOK_ID)?.revision).toBe("5")
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(70)
    sync.dispose()
  })

  it("returns local-only when the server has no progress", async () => {
    const { sync, store, transport } = createSync()
    transport.fetchResult = null
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(33),
      },
      { mutationId: "m1" },
    )
    const result = await sync.reconcile(BOOK_ID)
    expect(result.status).toBe("local-only")
    expect(result.local?.progressPercent).toBe(33)
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(33)
    sync.dispose()
  })

  it("skips when another tab holds the Web Lock", async () => {
    const locks: ProgressLockManager = {
      async request(_name, _options, callback) {
        return callback(null)
      },
    }
    const { sync, store, transport } = createSync({ locks })
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(15),
      },
      { mutationId: "m1", immediate: true },
    )
    expect(transport.putCalls).toHaveLength(0)
    expect(store.outbox.get(BOOK_ID)?.state).toBe("pending")
    sync.dispose()
  })

  it("broadcasts local/synced/conflict changes without locator payloads", async () => {
    const channel = new FakeChannel()
    const events: ReaderProgressSyncEvent[] = []
    const { sync } = createSync({ channel, events })
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(18),
      },
      { mutationId: "m1", immediate: true },
    )
    expect(channel.posted.map((payload) => payload.type)).toEqual([
      "snapshot-updated",
      "progress-saved",
    ])
    expect(JSON.stringify(channel.posted)).not.toContain("epubcfi")
    channel.receive({
      type: "snapshot-updated",
      bookId: BOOK_ID,
      revision: "3",
      timestamp: 1,
    })
    expect(
      events.some((event) => event.type === "remote-change"),
    ).toBe(true)
    sync.dispose()
  })

  it("uses keepalive on pagehide and keeps the outbox after logout", async () => {
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const { sync, store, transport } = createSync({
      lifecycleTarget: target,
    })
    await sync.open({ bindLifecycle: true })
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(60),
      },
      { mutationId: "m1" },
    )
    listeners.get("pagehide")?.({} as Event)
    await waitFor(() => transport.putCalls.length === 1)
    expect(transport.keepalive).toEqual([true])
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(61),
      },
      { mutationId: "m2" },
    )
    await sync.suspendForLogout()
    expect(store.outbox.get(BOOK_ID)?.state).toBe("auth-required")
    expect(store.outbox.get(BOOK_ID)?.pending).not.toBeNull()
    sync.dispose()
  })

  it("uses a newer localStorage exit snapshot when IndexedDB has no record", async () => {
    const { sync, store, transport } = createSync()
    transport.fetchResult = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(70).locatorPayload,
        progressPercent: 70,
      },
      "5",
    )
    const fallback = exitSnapshotAt(80, 1_700_000_100_000)
    const result = await sync.reconcile(BOOK_ID, { fallback })
    expect(result.status).toBe("local-newer")
    expect(result.adopted).toBe(false)
    expect(result.local?.progressPercent).toBe(80)
    // fallback 只用于恢复，不写回 IndexedDB 覆盖位置。
    expect(store.snapshots.get(BOOK_ID)).toBeUndefined()
    sync.dispose()
  })

  it("prefers a newer exit snapshot over an older IndexedDB snapshot", async () => {
    const { sync, store, transport } = createSync()
    const indexed = exitSnapshotAt(19.87, 1_700_000_000_000)
    store.snapshots.set(BOOK_ID, {
      ...indexed,
      revision: "7",
      source: "server",
    })
    transport.fetchResult = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(19.87).locatorPayload,
        progressPercent: 19.87,
      },
      "7",
    )
    // 页面在 600ms 节流窗口内 reload：IndexedDB 还是旧位置 19.87%，
    // localStorage 退出快照已经是新位置 33.15%。
    const fallback = exitSnapshotAt(33.15, 1_700_000_100_000)
    const result = await sync.reconcile(BOOK_ID, { fallback })
    expect(result.status).toBe("local-newer")
    expect(result.localSource).toBe("exit")
    expect(result.local?.progressPercent).toBe(33.15)
    // 对账本身不写回 IndexedDB；由调用方显式补写。
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(19.87)
    sync.dispose()
  })

  it("uses the IndexedDB revision over a later-looking exit snapshot timestamp", async () => {
    const { sync, store, transport } = createSync()
    store.snapshots.set(BOOK_ID, {
      ...exitSnapshotAt(10, 1_700_000_000_000),
      revision: "5",
      source: "server",
    })
    transport.fetchResult = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(80).locatorPayload,
        progressPercent: 80,
      },
      "9",
    )
    // 旧版退出快照把关闭时间写进了 savedAt，看起来比服务器记录更晚；
    // IndexedDB revision 明确落后，必须采用服务器位置。
    const fallback = exitSnapshotAt(10, 1_700_000_100_000)
    const result = await sync.reconcile(BOOK_ID, { fallback })
    expect(result.status).toBe("server-newer")
    expect(result.adopted).toBe(true)
    expect(result.local?.progressPercent).toBe(80)
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(80)
    sync.dispose()
  })

  it("keeps a newer exit snapshot when its arrival is after the server record", async () => {
    const { sync, store, transport } = createSync()
    store.snapshots.set(BOOK_ID, {
      ...exitSnapshotAt(10, 1_700_000_000_000),
      revision: "9",
      source: "server",
    })
    transport.fetchResult = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(10).locatorPayload,
        progressPercent: 10,
      },
      "9",
    )
    // revision 相同说明服务器在本地基线之后没有新写入；此时才用
    // 退出快照的“到达时间”判断，本机确实到达得更晚则保留本机。
    const fallback = exitSnapshotAt(55, 1_700_000_100_000)
    const result = await sync.reconcile(BOOK_ID, { fallback })
    expect(result.localSource).toBe("exit")
    expect(result.status).toBe("local-newer")
    expect(result.adopted).toBe(false)
    expect(result.local?.progressPercent).toBe(55)
    sync.dispose()
  })

  it("keeps a newer IndexedDB snapshot over an older exit snapshot", async () => {
    const { sync, store, transport } = createSync()
    const indexed = exitSnapshotAt(55, 1_700_000_100_000)
    store.snapshots.set(BOOK_ID, {
      ...indexed,
      revision: "7",
      source: "server",
    })
    transport.fetchResult = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(55).locatorPayload,
        progressPercent: 55,
      },
      "7",
    )
    const fallback = exitSnapshotAt(19.87, 1_700_000_000_000)
    const result = await sync.reconcile(BOOK_ID, { fallback })
    expect(result.status).toBe("in-sync")
    expect(result.localSource).toBe("indexeddb")
    expect(result.local?.progressPercent).toBe(55)
    sync.dispose()
  })

  it("dispatches the keepalive before writing IndexedDB", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const { sync, store, transport } = createSync({
      lifecycleTarget: target,
    })
    transport.putImpl = async (input) => serverProgress(input, "1")
    await sync.open({ bindLifecycle: true })
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(20),
      },
      { mutationId: "seed", immediate: true },
    )
    store.saveCalls = 0
    transport.putCalls.length = 0
    transport.keepalive.length = 0
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: location(64),
    })
    listeners.get("pagehide")?.({} as Event)
    // pagehide 同一次调用栈内必须已经发起 PUT，且还没开始写 IndexedDB。
    expect(transport.putCalls).toHaveLength(1)
    expect(transport.keepalive).toEqual([true])
    expect(transport.putCalls[0]?.baseRevision).toBe("1")
    expect(store.saveCalls).toBe(0)
    expect(localReaderSnapshotStore.read(BOOK_ID)?.progressPercent).toBe(64)
    await waitFor(() => store.saveCalls === 1)
    sync.dispose()
  })

  it("keeps a retryable outbox when the keepalive fails", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const { sync, store, transport } = createSync({
      lifecycleTarget: target,
    })
    transport.putImpl = async () => {
      throw new ApiError(0, "network_error", "离线。", "", {})
    }
    await sync.open({ bindLifecycle: true })
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: location(64),
    })
    listeners.get("pagehide")?.({} as Event)
    expect(localReaderSnapshotStore.read(BOOK_ID)?.progressPercent).toBe(64)
    await waitFor(
      () => store.outbox.get(BOOK_ID)?.state === "pending",
    )
    expect(
      store.outbox.get(BOOK_ID)?.pending?.progressPercent,
    ).toBe(64)
    expect(transport.putCalls).toHaveLength(1)
    sync.dispose()
  })

  it("does not self-heal a keepalive 409 for a different locator", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const { sync, store, transport, timers } = createSync({
      lifecycleTarget: target,
    })
    await sync.open({ bindLifecycle: true })
    const serverAt80 = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: locationAt(8, 80).locatorPayload,
        progressPercent: 80,
      },
      "9",
    )
    transport.putImpl = async () => {
      throw new ApiError(
        409,
        "revision_conflict",
        "进度已在别处更新。",
        "",
        { current: serverAt80 },
      )
    }
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: locationAt(3, 40),
    })
    listeners.get("pagehide")?.({} as Event)
    await waitFor(
      () => store.outbox.get(BOOK_ID)?.pending?.progressPercent === 40,
    )
    // 服务器记录是另一个设备的不同位置：不能用它的 revision 覆盖。
    expect(transport.putCalls).toHaveLength(1)
    expect(transport.putCalls[0]?.baseRevision).toBe("0")
    timers.runAll()
    await waitFor(() => store.outbox.get(BOOK_ID)?.state === "conflict")
    expect(
      transport.putCalls.every((call) => call.baseRevision !== "9"),
    ).toBe(true)
    expect(store.outbox.get(BOOK_ID)?.conflict?.currentRevision).toBe("9")
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(40)
    sync.dispose()
  })

  it("retries a keepalive 409 when the server already has the same locator", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const { sync, store, transport } = createSync({
      lifecycleTarget: target,
    })
    await sync.open({ bindLifecycle: true })
    const samePosition: SaveReaderProgressInput = {
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      baseRevision: "0",
      clientMutationId: "server",
      locatorType: "epub-cfi",
      locatorPayload: locationAt(3, 40).locatorPayload,
      progressPercent: 40,
    }
    let attempts = 0
    transport.putImpl = async (input) => {
      attempts += 1
      if (attempts === 1) {
        throw new ApiError(
          409,
          "revision_conflict",
          "进度已在别处更新。",
          "",
          { current: serverProgress(samePosition, "9") },
        )
      }
      return serverProgress(input, "10")
    }
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: locationAt(3, 40),
    })
    listeners.get("pagehide")?.({} as Event)
    await waitFor(
      () => store.outbox.get(BOOK_ID)?.state === "idle",
    )
    expect(transport.putCalls).toHaveLength(2)
    expect(transport.putCalls[0]?.baseRevision).toBe("0")
    expect(transport.putCalls[1]?.baseRevision).toBe("9")
    expect(transport.putCalls[1]?.clientMutationId).not.toBe(
      transport.putCalls[0]?.clientMutationId,
    )
    expect(transport.keepalive).toEqual([true, true])
    expect(store.snapshots.get(BOOK_ID)?.revision).toBe("10")
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(40)
    sync.dispose()
  })

  it("drops superseded pending work after the keepalive is accepted", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const { sync, store, transport } = createSync({
      lifecycleTarget: target,
    })
    transport.putImpl = async (input) => serverProgress(input, "1")
    await sync.open({ bindLifecycle: true })
    await sync.record(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        locator: location(20),
      },
      { mutationId: "old-position" },
    )
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: location(64),
    })
    listeners.get("pagehide")?.({} as Event)
    await waitFor(
      () => store.outbox.get(BOOK_ID)?.state === "idle",
    )
    expect(store.outbox.get(BOOK_ID)?.pending).toBeNull()
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(64)
    expect(store.snapshots.get(BOOK_ID)?.revision).toBe("1")
    sync.dispose()
  })

  it("adopts newer server progress over an older exit snapshot", async () => {
    const { sync, store, transport } = createSync()
    transport.fetchResult = serverProgress(
      {
        bookId: BOOK_ID,
        fileVersion: FILE_VERSION,
        format: FORMAT,
        baseRevision: "0",
        clientMutationId: "server",
        locatorType: "epub-cfi",
        locatorPayload: location(70).locatorPayload,
        progressPercent: 70,
      },
      "5",
    )
    const fallback = exitSnapshotAt(10, 1_699_999_000_000)
    const result = await sync.reconcile(BOOK_ID, { fallback })
    expect(result.status).toBe("server-newer")
    expect(result.adopted).toBe(true)
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(70)
    sync.dispose()
  })

  it("ignores a stale fileVersion IDB snapshot in favor of the exit snapshot", async () => {
    const { sync, store, transport } = createSync()
    store.snapshots.set(BOOK_ID, {
      ...exitSnapshotAt(30, 1_700_000_000_000),
      fileVersion: "a".repeat(64),
    })
    transport.fetchResult = null
    const fallback = exitSnapshotAt(44, 1_700_000_100_000)
    const result = await sync.reconcile(BOOK_ID, {
      fallback,
      ignoreLocalSnapshot: true,
    })
    expect(result.status).toBe("local-only")
    expect(result.local?.progressPercent).toBe(44)
    expect(result.local?.fileVersion).toBe(FILE_VERSION)
    sync.dispose()
  })

  it("recovers from localStorage when the IndexedDB snapshot read fails", async () => {
    const store = new MemoryProgressStore()
    store.getSnapshot = async () => {
      throw new Error("IndexedDB snapshot 不可用")
    }
    store.getOutbox = async () => {
      throw new Error("IndexedDB outbox 不可用")
    }
    const { sync, transport } = createSync({ store })
    transport.fetchResult = null
    const fallback = exitSnapshotAt(44, 1_700_000_000_000)
    const result = await sync.reconcile(BOOK_ID, { fallback })
    expect(result.status).toBe("local-only")
    expect(result.adopted).toBe(false)
    expect(result.local?.progressPercent).toBe(44)
    sync.dispose()
  })

  it("writes the current locator snapshot synchronously and flushes keepalive on pagehide", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const { sync, store, transport } = createSync({
      lifecycleTarget: target,
    })
    await sync.open({ bindLifecycle: true })
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: location(64),
    })
    listeners.get("pagehide")?.({} as Event)
    // localStorage 在页面卸载同一次调用栈内完成，不依赖 IndexedDB。
    expect(localReaderSnapshotStore.read(BOOK_ID)?.progressPercent).toBe(64)
    await waitFor(() => transport.putCalls.length === 1)
    expect(transport.keepalive).toEqual([true])
    expect(transport.putCalls[0]?.progressPercent).toBe(64)
    expect(store.snapshots.get(BOOK_ID)?.progressPercent).toBe(64)
    // visibilitychange 后紧接 pagehide 时同一 locator 不重复入队，
    // 但仍同步刷新 localStorage 退出快照。
    storage.clear()
    listeners.get("pagehide")?.({} as Event)
    expect(localReaderSnapshotStore.read(BOOK_ID)?.progressPercent).toBe(64)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(transport.putCalls).toHaveLength(1)
    sync.dispose()
  })

  it("keeps the locator arrival time in the exit snapshot across repeated pagehide", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    let now = 1_700_000_000_000
    const { sync, transport } = createSync({
      lifecycleTarget: target,
      now: () => now,
    })
    await sync.open({ bindLifecycle: true })
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: locationAt(3, 20),
    })
    listeners.get("pagehide")?.({} as Event)
    const arrival = new Date(now).toISOString()
    expect(localReaderSnapshotStore.read(BOOK_ID)?.savedAt).toBe(arrival)
    // 同一 locator 的 visibilitychange → pagehide 不能刷新 savedAt。
    now += 60_000
    listeners.get("pagehide")?.({} as Event)
    expect(localReaderSnapshotStore.read(BOOK_ID)?.savedAt).toBe(arrival)
    // 真正到达新位置后，savedAt 才更新为新的到达时间。
    now += 60_000
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: locationAt(8, 45),
    })
    listeners.get("pagehide")?.({} as Event)
    expect(localReaderSnapshotStore.read(BOOK_ID)?.savedAt).toBe(
      new Date(now).toISOString(),
    )
    await waitFor(() => transport.putCalls.length === 2)
    sync.dispose()
  })

  it("does not block pagehide when IndexedDB cannot be opened", async () => {
    const storage = memoryStorage()
    vi.stubGlobal("window", { localStorage: storage })
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    class UnavailableStore extends MemoryProgressStore {
      override async open(): Promise<void> {
        throw new Error("IndexedDB 不可用")
      }
    }
    const { sync } = createSync({
      store: new UnavailableStore(),
      lifecycleTarget: target,
    })
    await expect(
      sync.open({ bindLifecycle: true }),
    ).rejects.toThrow("IndexedDB 不可用")
    sync.setCurrentLocation({
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      format: FORMAT,
      locator: location(31),
    })
    expect(() => listeners.get("pagehide")?.({} as Event)).not.toThrow()
    expect(localReaderSnapshotStore.read(BOOK_ID)?.progressPercent).toBe(31)
    await new Promise((resolve) => setTimeout(resolve, 20))
    sync.dispose()
  })
})

describe("createDefaultProgressTransport keepalive", () => {
  const input: SaveReaderProgressInput = {
    bookId: BOOK_ID,
    fileVersion: FILE_VERSION,
    baseRevision: "0",
    clientMutationId: "m-keepalive",
    format: FORMAT,
    locatorType: "epub-cfi",
    locatorPayload: location(52).locatorPayload,
    progressPercent: 52,
  }

  it("sends keepalive PUT with the in-memory CSRF token and no status request", async () => {
    const fetchMock = vi.fn(
      async (requestUrl: RequestInfo | URL, init?: RequestInit) => {
        void requestUrl
        void init
        return new Response(
          JSON.stringify({ data: serverProgress(input, "1") }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      },
    )
    vi.stubGlobal("fetch", fetchMock)
    const transport = createDefaultProgressTransport({
      getCsrfToken: () => "csrf-token-1",
    })
    await transport.put(input, { keepalive: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    expect(init?.keepalive).toBe(true)
    expect(
      (init?.headers as Record<string, string>)["X-CSRF-Token"],
    ).toBe("csrf-token-1")
  })

  it("still attempts the keepalive PUT without a token and never fetches auth status", async () => {
    const fetchMock = vi.fn(
      async (requestUrl: RequestInfo | URL, init?: RequestInit) => {
        void requestUrl
        void init
        return new Response(
          JSON.stringify({ data: serverProgress(input, "1") }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      },
    )
    vi.stubGlobal("fetch", fetchMock)
    const transport = createDefaultProgressTransport({
      getCsrfToken: () => null,
    })
    await transport.put(input, { keepalive: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).not.toContain("/auth/status")
    expect(init?.keepalive).toBe(true)
    expect(
      (init?.headers as Record<string, string>)["X-CSRF-Token"],
    ).toBeUndefined()
  })
})
