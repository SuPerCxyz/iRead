import { ApiError, isRecord } from "@/lib/api"
import type { BookFormat } from "@/features/library/types"

import {
  fetchReaderProgress,
  putReaderProgress,
  type SaveReaderProgressInput,
} from "../shell/reader-api"
import {
  parseReaderProgress,
  type ReaderLocation,
  type ReaderProgress,
} from "../types"
import {
  localProgressRevisionStore,
  localReaderSnapshotStore,
  snapshotFromLocation,
} from "./local-snapshot"
import { classifyProgressSaveError } from "./progress-sync"
import { newClientMutationId } from "./progress-sync"
import {
  ReaderProgressStore,
  pickNewerSnapshot,
  snapshotFromServer,
  type ProgressConflictInfo,
  type ProgressMutation,
  type ProgressPersistence,
  type ProgressSnapshotRecord,
  type ProgressOutboxRecord,
  type SavedLocalProgress,
} from "./progress-store"

/**
 * 进度 outbox 编排：先本地后 PUT、节流、pagehide/visibilitychange
 * keepalive、409 不自动覆盖、Web Locks/BroadcastChannel 多标签协作。
 */

export interface ProgressTransport {
  put(
    input: SaveReaderProgressInput,
    options: { signal?: AbortSignal; keepalive?: boolean },
  ): Promise<ReaderProgress>
  fetch(
    bookId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReaderProgress | null>
}

export type ProgressFlushStatus =
  | "idle"
  | "saved"
  | "pending"
  | "conflict"
  | "auth-required"
  | "error"
  | "skipped"

export interface ProgressFlushResult {
  bookId: string
  status: ProgressFlushStatus
  revision: string | null
  message: string
}

export type ReaderProgressSyncEvent =
  | {
      type: "local-saved"
      bookId: string
      mutationId: string
      timestamp: number
    }
  | {
      type: "syncing"
      bookId: string
      mutationId: string
      timestamp: number
    }
  | {
      type: "saved"
      bookId: string
      revision: string
      timestamp: number
    }
  | {
      type: "conflict"
      bookId: string
      code: string
      currentRevision: string | null
      timestamp: number
    }
  | {
      type: "auth-required"
      bookId: string
      message: string
      timestamp: number
    }
  | {
      type: "retry-scheduled"
      bookId: string
      delayMs: number
      timestamp: number
    }
  | {
      type: "failed"
      bookId: string
      message: string
      timestamp: number
    }
  | {
      type: "remote-change"
      bookId: string
      revision: string | null
      timestamp: number
    }
  | {
      type: "foreground"
      persisted: boolean
      timestamp: number
    }

export type ProgressConflictResolutionChoice =
  | "keep-local"
  | "use-server"

export interface ProgressConflictResolutionResult {
  status: "saved" | "conflict" | "error" | "server-adopted" | "skipped"
  revision: string | null
  message: string
}

export interface ProgressReconcileResult {
  status:
    | "in-sync"
    | "server-newer"
    | "local-newer"
    | "pending"
    | "conflict"
    | "local-only"
    | "server-only"
  bookId: string
  local: ProgressSnapshotRecord | null
  server: ReaderProgress | null
  adopted: boolean
  /** 本次采用的 local 来源；exit 表示 localStorage 退出快照更新。 */
  localSource: "indexeddb" | "exit" | "server" | null
  message: string
}

export interface ProgressReconcileOptions {
  /**
   * localStorage 退出快照。始终与 IndexedDB 快照一起参与对账：
   * 按 savedAt 选择较新者，IndexedDB 里存在旧记录不会屏蔽更新的
   * 退出快照。只有本次选中的退出快照才用于恢复位置。
   */
  fallback?: ProgressSnapshotRecord | null
  /**
   * IndexedDB 里只有旧 fileVersion 的记录时，将其视为不可用，
   * 让当前 fileVersion 的 localStorage 快照参与对账。
   */
  ignoreLocalSnapshot?: boolean
}

export interface ReaderProgressLocation {
  bookId: string
  fileVersion: string
  format: BookFormat
  locator: ReaderLocation
}

export interface BroadcastPayload {
  type: "snapshot-updated" | "progress-saved" | "progress-conflict"
  bookId: string
  revision: string | null
  timestamp: number
}

export interface ProgressChannel {
  postMessage(message: BroadcastPayload): void
  close(): void
  onmessage: ((event: MessageEvent<BroadcastPayload>) => void) | null
}

export interface ProgressLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
}

export interface LifecycleTarget {
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

export interface ReaderProgressSyncOptions {
  store?: ProgressPersistence
  transport?: ProgressTransport
  throttleMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  locks?: ProgressLockManager | null
  lockName?: string
  channel?: ProgressChannel | null
  channelName?: string
  lifecycleTarget?: LifecycleTarget | null
  onlineTarget?: LifecycleTarget | null
  getCsrfToken?: () => string | null
  onEvent?: (event: ReaderProgressSyncEvent) => void
  onForeground?: (bookId?: string) => void
}

const DEFAULT_THROTTLE_MS = 1_500
const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 30_000
const MAX_FLUSH_ITERATIONS = 4

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}

function isCsrfFailure(error: ApiError): boolean {
  if (error.status !== 403) {
    return false
  }
  if (
    error.code === "csrf_invalid" ||
    error.code === "csrf_expired"
  ) {
    return true
  }
  const reason = error.details.reason
  return reason === "csrf_invalid" || reason === "csrf_expired"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareRevisions(a: string, b: string): number {
  try {
    const left = BigInt(a)
    const right = BigInt(b)
    return left === right ? 0 : left > right ? 1 : -1
  } catch {
    return a === b ? 0 : a > b ? 1 : -1
  }
}

function conflictFromError(error: ApiError): ProgressConflictInfo {
  const currentValue = error.details.current
  let current: ReaderProgress | null = null
  if (isRecord(currentValue)) {
    try {
      current = parseReaderProgress(currentValue)
    } catch {
      current = null
    }
  }
  const revisionFromCurrent =
    current !== null
      ? current.revision
      : isRecord(currentValue) &&
          (typeof currentValue.revision === "string" ||
            typeof currentValue.revision === "number")
        ? String(currentValue.revision)
        : null
  return {
    code: error.code,
    message:
      error.code === "file_version_conflict"
        ? "原件已在别处更新，进度未自动覆盖服务器记录。"
        : error.code === "state_conflict"
          ? "同一进度请求的内容不一致，未自动覆盖服务器记录。"
          : "进度已在别处更新，未自动覆盖服务器记录。",
    currentRevision: revisionFromCurrent,
    current,
    detectedAt: new Date().toISOString(),
  }
}

function progressLocationKey(
  bookId: string,
  locator: ReaderLocation,
): string {
  return `${bookId}:${locator.locatorType}:${JSON.stringify(
    locator.locatorPayload,
  )}`
}

function mutationLocation(mutation: ProgressMutation): ReaderLocation {
  return {
    locatorType: mutation.locatorType,
    locatorPayload: mutation.locatorPayload,
    progressPercent: mutation.progressPercent,
  } as ReaderLocation
}

function progressLocation(progress: ReaderProgress): ReaderLocation {
  return {
    locatorType: progress.locatorType,
    locatorPayload: progress.locatorPayload,
    progressPercent: progress.progressPercent,
  } as ReaderLocation
}

/** 同一个稳定 locator 视为同一阅读位置；progressPercent 由 locator 派生。 */
function sameProgressPosition(
  bookId: string,
  fileVersion: string,
  locator: ReaderLocation,
  progress: ReaderProgress,
): boolean {
  return (
    progress.fileVersion === fileVersion &&
    progressLocationKey(bookId, locator) ===
      progressLocationKey(bookId, progressLocation(progress))
  )
}

function mutationToPutInput(
  mutation: ProgressMutation,
): SaveReaderProgressInput {
  return {
    bookId: mutation.bookId,
    fileVersion: mutation.fileVersion,
    baseRevision: mutation.baseRevision,
    clientMutationId: mutation.mutationId,
    format: mutation.format,
    locatorType: mutation.locatorType,
    locatorPayload: mutation.locatorPayload,
    progressPercent: mutation.progressPercent,
  }
}

function findOutboxMutation(
  outbox: ProgressOutboxRecord,
  mutationId: string,
): ProgressMutation | null {
  for (const candidate of [
    outbox.inFlight,
    outbox.pending,
    outbox.queued,
  ]) {
    if (candidate !== null && candidate.mutationId === mutationId) {
      return candidate
    }
  }
  return null
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * pagehide 的 keepalive 传输。正常路径仍走现有 putReaderProgress，
 * 不改变其 API 形状；这里只补一个 keepalive 发送器。
 *
 * 卸载阶段不能再发起非 keepalive 的 /auth/status 请求：拿不到内存
 * CSRF 令牌时就发送无令牌请求（通常得到 403），本机快照已经在同步
 * 阶段写入 localStorage，失败不会阻塞退出。
 */
async function putProgressKeepalive(
  input: SaveReaderProgressInput,
  getCsrfToken?: () => string | null,
): Promise<ReaderProgress> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  const token = getCsrfToken?.() ?? null
  if (token !== null) {
    headers["X-CSRF-Token"] = token
  }
  const response = await fetch(
    `/api/v1/books/${encodeURIComponent(input.bookId)}/progress`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        fileVersion: input.fileVersion,
        baseRevision: input.baseRevision,
        clientMutationId: input.clientMutationId,
        format: input.format,
        locatorType: input.locatorType,
        locatorPayload: input.locatorPayload,
        progressPercent: input.progressPercent,
      }),
      keepalive: true,
    },
  )
  const payload = await readJson(response)
  if (!response.ok) {
    const envelope =
      isRecord(payload) && isRecord(payload.error)
        ? payload.error
        : null
    throw new ApiError(
      response.status,
      typeof envelope?.code === "string"
        ? envelope.code
        : "http_error",
      typeof envelope?.message === "string"
        ? envelope.message
        : `服务器返回 ${response.status}。`,
      typeof envelope?.requestId === "string"
        ? envelope.requestId
        : response.headers.get("X-Request-Id") ?? "",
      isRecord(envelope?.details) ? envelope.details : {},
    )
  }
  if (!isRecord(payload) || !("data" in payload)) {
    throw new ApiError(0, "protocol_error", "服务器响应格式无效。", "", {})
  }
  return parseReaderProgress(payload.data)
}

export function createDefaultProgressTransport(options: {
  getCsrfToken?: () => string | null
} = {}): ProgressTransport {
  return {
    put(input, requestOptions) {
      if (requestOptions.keepalive === true) {
        return putProgressKeepalive(input, options.getCsrfToken)
      }
      return putReaderProgress(input, requestOptions.signal)
    },
    fetch(bookId, requestOptions) {
      return fetchReaderProgress(bookId, requestOptions?.signal)
    },
  }
}

function createDefaultChannel(
  name: string,
): ProgressChannel | null {
  if (typeof BroadcastChannel === "undefined") {
    return null
  }
  return new BroadcastChannel(name)
}

export class ReaderProgressSync {
  readonly #store: ProgressPersistence
  readonly #ownsStore: boolean
  readonly #transport: ProgressTransport
  readonly #throttleMs: number
  readonly #retryBaseMs: number
  readonly #retryMaxMs: number
  readonly #now: () => number
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #lockName: string
  readonly #channelName: string
  readonly #lifecycleTarget: LifecycleTarget | null
  readonly #onlineTarget: LifecycleTarget | null
  readonly #onEvent:
    | ((event: ReaderProgressSyncEvent) => void)
    | undefined
  readonly #onForeground: ((bookId?: string) => void) | undefined
  readonly #timers = new Map<string, unknown>()
  readonly #retryTimers = new Map<string, unknown>()
  readonly #listeners = new Set<
    (event: ReaderProgressSyncEvent) => void
  >()
  #locks: ProgressLockManager | null
  #channel: ProgressChannel | null
  #opened = false
  #closed = false
  #foregroundBookId: string | null = null
  #currentLocation: ReaderProgressLocation | null = null
  #lastRecordedKey: string | null = null
  #lastDispatchedKey: string | null = null
  #lastDispatch: {
    key: string
    keep: Set<string>
  } | null = null
  #baseRevision = "0"
  #currentLocationSince = 0
  #wasHidden = false
  #bound = false
  #onVisibility: (() => void) | null = null
  #onPageHide: (() => void) | null = null
  #onOnline: (() => void) | null = null
  #onPageShow: ((event: Event) => void) | null = null

  constructor(options: ReaderProgressSyncOptions = {}) {
    this.#ownsStore = options.store === undefined
    this.#store = options.store ?? new ReaderProgressStore()
    this.#transport =
      options.transport ??
      createDefaultProgressTransport({
        getCsrfToken: options.getCsrfToken,
      })
    this.#throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS)
    this.#retryBaseMs = Math.max(
      0,
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    )
    this.#retryMaxMs = Math.max(
      this.#retryBaseMs,
      options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    )
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer =
      options.setTimer ??
      ((callback, delayMs) =>
        globalThis.setTimeout(callback, delayMs))
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        globalThis.clearTimeout(
          handle as ReturnType<typeof setTimeout>,
        )
      })
    this.#locks =
      options.locks !== undefined
        ? options.locks
        : typeof navigator !== "undefined" &&
            "locks" in navigator
          ? (navigator.locks as ProgressLockManager)
          : null
    this.#lockName = options.lockName ?? "iread-progress-sync-v1"
    this.#channelName = options.channelName ?? "iread-progress-v1"
    this.#channel =
      options.channel !== undefined
        ? options.channel
        : createDefaultChannel(this.#channelName)
    this.#lifecycleTarget =
      options.lifecycleTarget !== undefined
        ? options.lifecycleTarget
        : typeof window === "undefined"
          ? null
          : window
    this.#onlineTarget =
      options.onlineTarget !== undefined
        ? options.onlineTarget
        : typeof window === "undefined"
          ? null
          : window
    this.#onEvent = options.onEvent
    this.#onForeground = options.onForeground
    this.#attachChannel()
  }

  get store(): ProgressPersistence {
    return this.#store
  }

  get opened(): boolean {
    return this.#opened
  }

  subscribe(
    listener: (event: ReaderProgressSyncEvent) => void,
  ): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async open(
    options: { bindLifecycle?: boolean } = {},
  ): Promise<void> {
    if (this.#closed) {
      throw new Error("进度同步器已关闭。")
    }
    if (this.#opened) {
      return
    }
    const bind =
      options.bindLifecycle ??
      (typeof window !== "undefined")
    // 先绑定生命周期：IndexedDB 打不开时仍要保证 pagehide 的
    // localStorage 快照与 keepalive 尝试可用。
    if (bind) {
      this.#bindLifecycle()
    }
    await this.#store.open()
    await this.#store.recover()
    this.#opened = true
  }

  setActiveBook(bookId: string | null): void {
    this.#foregroundBookId = bookId
  }

  /**
   * Shell 在每次可持久化位置变化时登记当前 locator。退出生命周期
   * 回调会直接用它落 localStorage 快照并立即发 keepalive PUT，不再
   * 等待 600ms 节流窗口，也不再先读 IndexedDB。
   */
  setCurrentLocation(location: ReaderProgressLocation | null): void {
    const previousKey =
      this.#currentLocation === null
        ? null
        : progressLocationKey(
            this.#currentLocation.bookId,
            this.#currentLocation.locator,
          )
    this.#currentLocation = location
    const nextKey =
      location === null
        ? null
        : progressLocationKey(location.bookId, location.locator)
    if (nextKey !== previousKey) {
      // 位置变化后允许下一次卸载重新发送；同一位置的
      // visibilitychange → pagehide 连续触发仍只发一次。
      this.#lastDispatchedKey = null
      this.#currentLocationSince = this.#now()
    }
  }

  /**
   * 先写本地 snapshot + outbox，再按需触发 PUT。
   * 返回时本地记录已经落库；服务端结果由事件/后续 flush 通知。
   */
  async record(
    input: ReaderProgressLocation,
    options: {
      mutationId?: string
      immediate?: boolean
      baseRevision?: string
    } = {},
  ): Promise<{
    snapshot: ProgressSnapshotRecord
    outbox: ProgressOutboxRecord
    mutationId: string
  }> {
    this.setCurrentLocation(input)
    await this.#ensureOpen()
    const mutationId =
      options.mutationId ?? newClientMutationId()
    // beacon 之后才产生的位置不能被 beacon 的确认流程丢弃。
    this.#lastDispatch?.keep.add(mutationId)
    const key = progressLocationKey(input.bookId, input.locator)
    const previousKey = this.#lastRecordedKey
    this.#lastRecordedKey = key
    const baseRevision =
      options.baseRevision ??
      this.#freshBaseRevision(input.bookId, input.fileVersion)
    let saved: SavedLocalProgress
    try {
      saved = await this.#store.saveLocal({
        bookId: input.bookId,
        fileVersion: input.fileVersion,
        format: input.format,
        locator: input.locator,
        mutationId,
        baseRevision,
      })
    } catch (error) {
      this.#lastRecordedKey = previousKey
      throw error
    }
    this.#baseRevision = saved.snapshot.revision
    this.#emit({
      type: "local-saved",
      bookId: input.bookId,
      mutationId,
      timestamp: this.#now(),
    })
    this.#postChannel({
      type: "snapshot-updated",
      bookId: input.bookId,
      revision: saved.snapshot.revision,
      timestamp: this.#now(),
    })
    if (options.immediate === true) {
      await this.flushBook(input.bookId)
    } else {
      this.#schedule(input.bookId)
    }
    return { ...saved, mutationId }
  }

  /**
   * pagehide/visibilitychange：同步写 localStorage 后立即发 keepalive PUT。
   * 请求在读取 IndexedDB、获取 Web Lock、markSyncing 之前发出；outbox
   * 补写与结果确认全部异步进行，页面销毁不会阻塞请求。
   */
  flushNow(
    options: { keepalive?: boolean; reason?: string } = {},
  ): Promise<ProgressFlushResult | null> {
    const current = this.#currentLocation
    if (current === null) {
      return this.flush(options).then((results) => results[0] ?? null)
    }
    // 在任何 await 之前完成同步写；真正卸载时这是唯一有保证的落盘。
    this.#writeLocalSnapshot(current)
    const key = progressLocationKey(current.bookId, current.locator)
    if (this.#lastDispatchedKey === key) {
      // visibilitychange 后紧接 pagehide：同一位置已经在发送。
      return Promise.resolve(null)
    }
    this.#lastDispatchedKey = key
    const dispatch = { key, keep: new Set<string>() }
    this.#lastDispatch = dispatch
    void this.#dispatchKeepalive(current, dispatch).catch(() => undefined)
    return Promise.resolve(null)
  }

  #dispatchKeepalive(
    location: ReaderProgressLocation,
    dispatch: { key: string; keep: Set<string> },
  ): Promise<void> {
    const mutationId = newClientMutationId()
    const input: SaveReaderProgressInput = {
      bookId: location.bookId,
      fileVersion: location.fileVersion,
      baseRevision: this.#freshBaseRevision(
        location.bookId,
        location.fileVersion,
      ),
      clientMutationId: mutationId,
      format: location.format,
      locatorType: location.locator.locatorType,
      locatorPayload: location.locator.locatorPayload,
      progressPercent: location.locator.progressPercent,
    }
    // transport.put 在返回前同步调用 fetch(..., { keepalive: true })；
    // 这里之前不能出现任何 await。
    const request = this.#transport.put(input, { keepalive: true })
    return this.#persistDispatched(
      location,
      input,
      request,
      dispatch,
    )
  }

  async #persistDispatched(
    location: ReaderProgressLocation,
    input: SaveReaderProgressInput,
    request: Promise<ReaderProgress>,
    dispatch: { key: string; keep: Set<string> },
  ): Promise<void> {
    const bookId = location.bookId
    const mutationId = input.clientMutationId
    let saved: SavedLocalProgress | null = null
    try {
      await this.#ensureOpen()
      saved = await this.#store.saveLocal({
        bookId,
        fileVersion: location.fileVersion,
        format: location.format,
        locator: location.locator,
        mutationId,
        baseRevision: input.baseRevision,
      })
      this.#baseRevision = saved.snapshot.revision
      this.#emit({
        type: "local-saved",
        bookId,
        mutationId,
        timestamp: this.#now(),
      })
      this.#postChannel({
        type: "snapshot-updated",
        bookId,
        revision: saved.snapshot.revision,
        timestamp: this.#now(),
      })
    } catch {
      // IndexedDB 不可用：localStorage 已同步写入，退出后仍可恢复。
    }
    let server: ReaderProgress | null = null
    try {
      server = await request
    } catch (error) {
      // 旧页面刚完成 keepalive 时，新页面的内存 baseRevision 可能落后。
      // 只有冲突响应里的服务器位置与本机 locator 完全相同（同一位置，
      // 只是 revision 过期）才允许用当前 revision 自愈重发；不同位置
      // 必须保留 conflict/outbox，交给用户选择，不能用客户端时间与
      // 服务器时间做跨时钟覆盖。
      if (
        error instanceof ApiError &&
        error.status === 409
      ) {
        const conflict = conflictFromError(error)
        if (
          conflict.current !== null &&
          sameProgressPosition(
            location.bookId,
            location.fileVersion,
            location.locator,
            conflict.current,
          )
        ) {
          const retryInput: SaveReaderProgressInput = {
            ...input,
            baseRevision: conflict.current.revision,
            clientMutationId: newClientMutationId(),
          }
          try {
            server = await this.#transport.put(retryInput, {
              keepalive: true,
            })
          } catch {
            server = null
          }
        }
      }
      if (server === null) {
        if (this.#lastDispatch === dispatch) {
          this.#lastDispatch = null
        }
        if (!this.#closed && saved !== null) {
          // 失败保留 pending outbox；页面仍存活时按退避重试。
          this.#scheduleRetry(bookId, 1)
        }
        return
      }
    }
    this.#baseRevision = server.revision
    this.#writeRevisionHint(server)
    if (saved === null) {
      if (this.#lastDispatch === dispatch) {
        this.#lastDispatch = null
      }
      return
    }
    try {
      const mutation =
        findOutboxMutation(saved.outbox, mutationId) ?? {
          mutationId,
          bookId,
          fileVersion: location.fileVersion,
          format: location.format,
          baseRevision: input.baseRevision,
          locatorType: location.locator.locatorType,
          locatorPayload: location.locator.locatorPayload,
          progressPercent: location.locator.progressPercent,
          createdAt: new Date(this.#now()).toISOString(),
        }
      const synced = await this.#store.markDispatchedSynced(
        bookId,
        mutation,
        server,
        dispatch.keep,
      )
      if (this.#lastDispatch === dispatch) {
        this.#lastDispatch = null
      }
      if (synced.outbox.state === "conflict") {
        return
      }
      this.#clearBookTimers(bookId)
      this.#emit({
        type: "saved",
        bookId,
        revision: server.revision,
        timestamp: this.#now(),
      })
      this.#postChannel({
        type: "progress-saved",
        bookId,
        revision: server.revision,
        timestamp: this.#now(),
      })
      if (
        synced.outbox.pending !== null ||
        synced.outbox.queued !== null
      ) {
        void this.flushBook(bookId).catch(() => undefined)
      }
    } catch {
      // 确认失败不阻塞退出；下一次 reconcile/flush 会继续。
      if (this.#lastDispatch === dispatch) {
        this.#lastDispatch = null
      }
    }
  }

  /** 尽力立即提交；keepalive 用于 pagehide/visibilitychange。 */
  async flush(
    options: { keepalive?: boolean; reason?: string } = {},
  ): Promise<ProgressFlushResult[]> {
    await this.#ensureOpen()
    const records = await this.#store.listOutbox()
    const results: ProgressFlushResult[] = []
    for (const record of records) {
      if (
        record.state === "conflict" ||
        record.state === "auth-required" ||
        record.state === "error"
      ) {
        continue
      }
      results.push(
        await this.flushBook(record.bookId, options),
      )
    }
    return results
  }

  async flushBook(
    bookId: string,
    options: { keepalive?: boolean; reason?: string } = {},
  ): Promise<ProgressFlushResult> {
    await this.#ensureOpen()
    return this.#withBookLock(bookId, async () => {
      let last: ProgressFlushResult = {
        bookId,
        status: "idle",
        revision: null,
        message: "",
      }
      for (
        let iteration = 0;
        iteration < MAX_FLUSH_ITERATIONS;
        iteration += 1
      ) {
        const record = await this.#store.getOutbox(bookId)
        if (record === null) {
          return last
        }
        if (record.state === "conflict") {
          return {
            bookId,
            status: "conflict",
            revision: record.conflict?.currentRevision ?? null,
            message: record.conflict?.message ?? "进度冲突未解决。",
          }
        }
        if (record.state === "auth-required") {
          return {
            bookId,
            status: "auth-required",
            revision: null,
            message:
              record.lastError || "登录状态失效，等待重新认证。",
          }
        }
        if (record.state === "error") {
          return {
            bookId,
            status: "error",
            revision: null,
            message: record.lastError || "进度同步失败。",
          }
        }
        const mutation = record.pending ?? record.inFlight
        if (mutation === null) {
          return last.status === "idle"
            ? { ...last, status: "idle" }
            : last
        }
        await this.#store.markSyncing(bookId, mutation)
        this.#emit({
          type: "syncing",
          bookId,
          mutationId: mutation.mutationId,
          timestamp: this.#now(),
        })
        try {
          const server = await this.#transport.put(
            mutationToPutInput(mutation),
            {
              keepalive: options.keepalive === true,
            },
          )
          const synced = await this.#store.markSynced(
            bookId,
            mutation,
            server,
          )
          this.#baseRevision = server.revision
          this.#writeRevisionHint(server)
          this.#clearBookTimers(bookId)
          last = {
            bookId,
            status: "saved",
            revision: server.revision,
            message: "",
          }
          this.#emit({
            type: "saved",
            bookId,
            revision: server.revision,
            timestamp: this.#now(),
          })
          this.#postChannel({
            type: "progress-saved",
            bookId,
            revision: server.revision,
            timestamp: this.#now(),
          })
          if (
            synced.outbox.pending === null &&
            synced.outbox.queued === null &&
            synced.outbox.inFlight === null
          ) {
            return last
          }
        } catch (error) {
          return await this.#handleFailure(
            bookId,
            mutation,
            error,
          )
        }
      }
      return last
    })
  }

  /**
   * 网络恢复/重新认证后继续待同步队列。不会自动覆盖 conflict；
   * 需要用户明确选择后由 resolveConflict 重新入队。
   */
  async resume(
    options: { includeErrors?: boolean } = {},
  ): Promise<ProgressFlushResult[]> {
    await this.#ensureOpen()
    const records = await this.#store.listOutbox()
    const results: ProgressFlushResult[] = []
    for (const record of records) {
      const canResume =
        record.state === "auth-required" ||
        (options.includeErrors === true && record.state === "error")
      if (canResume) {
        const mutation = record.pending ?? record.inFlight
        if (mutation !== null) {
          await this.#store.markRetryableFailure(
            record.bookId,
            mutation,
            record.lastError,
          )
        }
      }
      if (
        record.state === "conflict" ||
        record.state === "error"
      ) {
        continue
      }
      results.push(await this.flushBook(record.bookId))
    }
    return results
  }

  /**
   * 用户对 409 的明确选择。keep-local 会用冲突响应里的 current revision
   * 重新提交本机位置；use-server 载入服务器记录并清除待同步队列。
   * 不在后台自动调用。
   */
  async resolveConflict(
    bookId: string,
    choice: ProgressConflictResolutionChoice,
  ): Promise<ProgressConflictResolutionResult> {
    await this.#ensureOpen()
    if (choice === "use-server") {
      try {
        const server = await this.#transport.fetch(bookId)
        if (server === null) {
          return {
            status: "error",
            revision: null,
            message: "服务器没有可载入的进度记录。",
          }
        }
        this.#baseRevision = server.revision
        this.#writeRevisionHint(server)
        await this.#store.adoptServer(bookId, server)
        this.#postChannel({
          type: "progress-saved",
          bookId,
          revision: server.revision,
          timestamp: this.#now(),
        })
        return {
          status: "server-adopted",
          revision: server.revision,
          message: "已载入服务器进度。",
        }
      } catch (error) {
        return {
          status: "error",
          revision: null,
          message: errorMessage(error),
        }
      }
    }
    const record = await this.#store.getOutbox(bookId)
    if (record === null || record.conflict === null) {
      return {
        status: "error",
        revision: null,
        message: "当前没有待处理的进度冲突。",
      }
    }
    const baseRevision = record.conflict.currentRevision
    if (baseRevision === null) {
      return {
        status: "error",
        revision: null,
        message: "冲突响应缺少当前 revision，无法安全地重新提交。",
      }
    }
    const rebased = await this.#store.resolveConflictLocally(
      bookId,
      baseRevision,
    )
    if (rebased === null) {
      return {
        status: "error",
        revision: null,
        message: "待同步的本机位置不存在。",
      }
    }
    const flushed = await this.flushBook(bookId)
    return {
      status:
        flushed.status === "saved"
          ? "saved"
          : flushed.status === "conflict"
            ? "conflict"
            : flushed.status === "skipped"
              ? "skipped"
              : "error",
      revision: flushed.revision,
      message: flushed.message,
    }
  }

  /**
   * 前台恢复/打开书籍时对账。先返回本地可确认位置，再与服务端
   * revision 比较；有本地待同步/冲突时不覆盖本地。
   *
   * IndexedDB 不可用或没有记录时，可传入 localStorage 退出快照作为
   * fallback 初始 locator；fallback 不会写入本机库，也不会覆盖比它新的
   * 服务器位置。
   */
  async reconcile(
    bookId: string,
    options: ProgressReconcileOptions = {},
  ): Promise<ProgressReconcileResult> {
    if (this.#closed) {
      throw new Error("进度同步器已关闭。")
    }
    if (!this.#opened) {
      try {
        await this.open({ bindLifecycle: false })
      } catch {
        // 本机存储不可用时仍与服务器对账；只跳过需要 IndexedDB 的写入。
      }
    }
    let storedLocal: ProgressSnapshotRecord | null
    let outbox: ProgressOutboxRecord | null
    let outboxReadable = true
    try {
      storedLocal = await this.#store.getSnapshot(bookId)
    } catch {
      storedLocal = null
    }
    if (storedLocal !== null) {
      this.#baseRevision = storedLocal.revision
    }
    try {
      outbox = await this.#store.getOutbox(bookId)
    } catch {
      outbox = null
      outboxReadable = false
    }
    const indexedLocal =
      options.ignoreLocalSnapshot === true ? null : storedLocal
    const fallback =
      options.fallback !== undefined &&
      options.fallback !== null &&
      options.fallback.bookId === bookId
        ? options.fallback
        : null
    // localStorage 退出快照与 IndexedDB 快照始终都参与对账，按位置时间
    // 选较新者；IndexedDB 里的旧记录不能屏蔽更新的退出快照。
    const local = pickNewerSnapshot(indexedLocal, fallback)
    const localSource: "indexeddb" | "exit" | null =
      local === null
        ? null
        : local === fallback
          ? "exit"
          : "indexeddb"

    let server: ReaderProgress | null
    try {
      server = await this.#transport.fetch(bookId)
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      return {
        status: "local-only",
        bookId,
        local,
        localSource,
        server: null,
        adopted: false,
        message:
          local === null
            ? "服务器进度暂不可读，且本机没有可恢复的进度。"
            : "服务器进度暂不可读，保留本机位置。",
      }
    }
    if (server !== null) {
      this.#baseRevision = server.revision
      this.#writeRevisionHint(server)
    }
    const hasPending =
      outbox !== null &&
      (outbox.pending !== null ||
        outbox.queued !== null ||
        outbox.inFlight !== null ||
        outbox.state === "conflict" ||
        outbox.state === "auth-required" ||
        outbox.state === "error")
    if (server === null) {
      return {
        status: "local-only",
        bookId,
        local,
        localSource,
        server: null,
        adopted: false,
        message:
          local === null
            ? "服务器与本机都没有进度。"
            : "服务器暂无进度，保留本机位置。",
      }
    }
    // 本机待同步/冲突（或 outbox 不可读但本机有记录）时不自动用服务器覆盖。
    if (hasPending || (!outboxReadable && local !== null)) {
      return {
        status:
          outbox?.state === "conflict" ? "conflict" : "pending",
        bookId,
        local,
        localSource,
        server,
        adopted: false,
        message: "本机有未同步/冲突位置，未自动覆盖。",
      }
    }
    if (local === null) {
      return this.#adoptServerForReconcile(
        bookId,
        server,
        "采用服务器进度。",
        "server-only",
      )
    }
    if (local.fileVersion !== server.fileVersion) {
      return this.#adoptServerForReconcile(
        bookId,
        server,
        "原件版本已变化，采用服务器当前进度。",
      )
    }
    if (localSource === "exit") {
      // IndexedDB revision 是判断“服务器是否在本地位置之后又写过”的可靠
      // 依据，优先使用。旧版本退出快照可能把关闭时间写进 savedAt，
      // 因此只有拿不到可用 revision 时才退回到达时间比较。
      const indexedRevision =
        indexedLocal !== null &&
        indexedLocal.fileVersion === server.fileVersion
          ? indexedLocal.revision
          : null
      if (indexedRevision !== null) {
        const indexedComparison = compareRevisions(
          indexedRevision,
          server.revision,
        )
        if (indexedComparison < 0) {
          return this.#adoptServerForReconcile(
            bookId,
            server,
            "采用服务器进度（服务器 revision 更新）。",
          )
        }
        if (indexedComparison > 0) {
          return {
            status: "local-newer",
            bookId,
            local,
            localSource,
            server,
            adopted: false,
            message: "本机退出快照的 revision 更高，保留本机位置。",
          }
        }
      }
      const arrivalTime = Date.parse(local.savedAt)
      const serverTime = Date.parse(server.updatedAt)
      if (
        Number.isFinite(arrivalTime) &&
        Number.isFinite(serverTime) &&
        arrivalTime > serverTime
      ) {
        return {
          status: "local-newer",
          bookId,
          local,
          localSource,
          server,
          adopted: false,
          message: "本机退出快照到达时间更新，保留本机位置。",
        }
      }
      return this.#adoptServerForReconcile(
        bookId,
        server,
        "采用服务器进度（本机退出快照较旧）。",
      )
    }
    const comparison = compareRevisions(
      local.revision,
      server.revision,
    )
    if (comparison < 0) {
      return this.#adoptServerForReconcile(
        bookId,
        server,
        "服务器进度更新，已对账采用。",
      )
    }
    if (comparison > 0) {
      return {
        status: "local-newer",
        bookId,
        local,
        localSource,
        server,
        adopted: false,
        message: "本机 revision 更高，保留本机位置。",
      }
    }
    return {
      status: "in-sync",
      bookId,
      local,
      localSource,
      server,
      adopted: false,
      message: "本机与服务器进度一致。",
    }
  }

  async #adoptServerForReconcile(
    bookId: string,
    server: ReaderProgress,
    message: string,
    status: "server-only" | "server-newer" = "server-newer",
  ): Promise<ProgressReconcileResult> {
    this.#baseRevision = server.revision
    try {
      const adopted = await this.#store.adoptServer(bookId, server)
      return {
        status,
        bookId,
        local: adopted,
        localSource: "server",
        server,
        adopted: true,
        message,
      }
    } catch {
      return {
        status,
        bookId,
        local: snapshotFromServer(bookId, server),
        localSource: "server",
        server,
        adopted: false,
        message: `${message}（本机存储不可用，本次仅用于显示。）`,
      }
    }
  }

  async handleForeground(
    bookId?: string | null,
  ): Promise<ProgressReconcileResult | null> {
    const target = bookId ?? this.#foregroundBookId
    this.#emit({
      type: "foreground",
      persisted: true,
      timestamp: this.#now(),
    })
    this.#onForeground?.(target ?? undefined)
    if (target === null || target === undefined) {
      return null
    }
    return this.reconcile(target)
  }

  /**
   * 退出登录：停止发送并保留不可读 outbox，等待重新认证后 resume。
   * 不删除快照或待同步记录。
   */
  async suspendForLogout(): Promise<void> {
    // 退出后 pagehide/visibilitychange 不能再把未认证位置写回队列。
    this.#currentLocation = null
    this.#lastDispatchedKey = null
    await this.#ensureOpen()
    const records = await this.#store.listOutbox()
    for (const record of records) {
      const mutation = record.pending ?? record.inFlight
      if (mutation === null) {
        continue
      }
      await this.#store.markAuthRequired(
        record.bookId,
        mutation,
        "已退出登录，待重新认证后同步。",
      )
    }
    for (const handle of this.#timers.values()) {
      this.#clearTimer(handle)
    }
    this.#timers.clear()
    for (const handle of this.#retryTimers.values()) {
      this.#clearTimer(handle)
    }
    this.#retryTimers.clear()
  }

  dispose(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#currentLocation = null
    this.#lastDispatchedKey = null
    for (const handle of this.#timers.values()) {
      this.#clearTimer(handle)
    }
    this.#timers.clear()
    for (const handle of this.#retryTimers.values()) {
      this.#clearTimer(handle)
    }
    this.#retryTimers.clear()
    this.#unbindLifecycle()
    if (this.#channel !== null) {
      this.#channel.close()
      this.#channel = null
    }
    if (this.#ownsStore) {
      this.#store.close()
    }
  }

  #writeLocalSnapshot(location: ReaderProgressLocation): void {
    try {
      // 退出快照记录“到达该位置”的时间，而不是页面关闭时间：
      // 同一 locator 的 visibilitychange/pagehide 不会刷新 savedAt。
      const capturedAt =
        this.#currentLocationSince > 0
          ? this.#currentLocationSince
          : this.#now()
      localReaderSnapshotStore.write(
        snapshotFromLocation(
          {
            bookId: location.bookId,
            fileVersion: location.fileVersion,
            format: location.format,
          },
          location.locator,
          capturedAt,
        ),
      )
    } catch {
      // localStorage 被禁用时静默降级，不能阻塞退出。
    }
  }

  /**
   * 同步读取跨页面 revision 提示。旧页面刚完成的 keepalive 会把服务器
   * revision 写入 localStorage，新页面不必依赖自己的内存值。
   */
  #freshBaseRevision(bookId: string, fileVersion: string): string {
    let revision = this.#baseRevision
    try {
      const hint = localProgressRevisionStore.read(bookId)
      if (
        hint !== null &&
        hint.fileVersion === fileVersion &&
        compareRevisions(hint.revision, revision) > 0
      ) {
        revision = hint.revision
      }
    } catch {
      // 提示不可用时退回内存 revision。
    }
    return revision
  }

  #writeRevisionHint(server: ReaderProgress): void {
    try {
      localProgressRevisionStore.write({
        schemaVersion: 1,
        bookId: server.bookId,
        fileVersion: server.fileVersion,
        revision: server.revision,
        updatedAt: server.updatedAt,
      })
    } catch {
      // 仅用于跨页面优化。
    }
  }

  async #ensureOpen(): Promise<void> {
    if (this.#closed) {
      throw new Error("进度同步器已关闭。")
    }
    if (!this.#opened) {
      await this.open({ bindLifecycle: false })
    }
  }

  #schedule(bookId: string): void {
    if (this.#timers.has(bookId) || this.#retryTimers.has(bookId)) {
      return
    }
    const handle = this.#setTimer(() => {
      this.#timers.delete(bookId)
      void this.flushBook(bookId).catch(() => undefined)
    }, this.#throttleMs)
    this.#timers.set(bookId, handle)
  }

  #scheduleRetry(
    bookId: string,
    attemptCount: number,
  ): number {
    const existing = this.#retryTimers.get(bookId)
    if (existing !== undefined) {
      this.#clearTimer(existing)
      this.#retryTimers.delete(bookId)
    }
    const delayMs = Math.min(
      this.#retryMaxMs,
      this.#retryBaseMs * 2 ** Math.min(attemptCount, 5),
    )
    const handle = this.#setTimer(() => {
      this.#retryTimers.delete(bookId)
      void this.flushBook(bookId).catch(() => undefined)
    }, delayMs)
    this.#retryTimers.set(bookId, handle)
    this.#emit({
      type: "retry-scheduled",
      bookId,
      delayMs,
      timestamp: this.#now(),
    })
    return delayMs
  }

  #clearBookTimers(bookId: string): void {
    const scheduled = this.#timers.get(bookId)
    if (scheduled !== undefined) {
      this.#clearTimer(scheduled)
      this.#timers.delete(bookId)
    }
    const retry = this.#retryTimers.get(bookId)
    if (retry !== undefined) {
      this.#clearTimer(retry)
      this.#retryTimers.delete(bookId)
    }
  }

  async #handleFailure(
    bookId: string,
    mutation: ProgressMutation,
    error: unknown,
  ): Promise<ProgressFlushResult> {
    if (isAbortError(error)) {
      await this.#store.markRetryableFailure(
        bookId,
        mutation,
        "请求已取消，等待重试。",
      )
      return {
        bookId,
        status: "pending",
        revision: null,
        message: "请求已取消，等待重试。",
      }
    }
    if (error instanceof ApiError) {
      if (isCsrfFailure(error)) {
        // 内存令牌缺失/轮换失败时不能把 outbox 标成永久错误；
        // 保留待同步，前台恢复或重新认证后可继续。
        const message = "登录校验令牌失效，位置已保存在本机，等待重试。"
        await this.#store.markRetryableFailure(
          bookId,
          mutation,
          message,
        )
        return {
          bookId,
          status: "pending",
          revision: null,
          message,
        }
      }
      if (error.status === 409) {
        const conflict = conflictFromError(error)
        // 同一位置已经由另一个标签/卸载 beacon 写入：这不是内容冲突，
        // 按幂等成功确认，避免重复上报同一位置时弹出冲突。
        if (
          conflict.current !== null &&
          conflict.current.fileVersion === mutation.fileVersion &&
          progressLocationKey(
            bookId,
            mutationLocation(mutation),
          ) ===
            progressLocationKey(
              bookId,
              progressLocation(conflict.current),
            ) &&
          Math.abs(
            conflict.current.progressPercent -
              mutation.progressPercent,
          ) < 0.000001
        ) {
          try {
            await this.#store.markSynced(
              bookId,
              mutation,
              conflict.current,
            )
            this.#baseRevision = conflict.current.revision
            this.#writeRevisionHint(conflict.current)
            this.#clearBookTimers(bookId)
            return {
              bookId,
              status: "saved",
              revision: conflict.current.revision,
              message: "",
            }
          } catch {
            // 确认失败时继续按冲突处理，避免丢失服务器位置。
          }
        }
        await this.#store.markConflict(bookId, mutation, conflict)
        this.#emit({
          type: "conflict",
          bookId,
          code: conflict.code,
          currentRevision: conflict.currentRevision,
          timestamp: this.#now(),
        })
        this.#postChannel({
          type: "progress-conflict",
          bookId,
          revision: conflict.currentRevision,
          timestamp: this.#now(),
        })
        return {
          bookId,
          status: "conflict",
          revision: conflict.currentRevision,
          message: conflict.message,
        }
      }
      if (error.status === 401) {
        const message =
          error.message || "登录状态失效，等待重新认证。"
        await this.#store.markAuthRequired(
          bookId,
          mutation,
          message,
        )
        this.#emit({
          type: "auth-required",
          bookId,
          message,
          timestamp: this.#now(),
        })
        return {
          bookId,
          status: "auth-required",
          revision: null,
          message,
        }
      }
      if (error.status === 422) {
        const message =
          classifyProgressSaveError(error).message
        await this.#store.markPermanentFailure(
          bookId,
          mutation,
          message,
        )
        this.#emit({
          type: "failed",
          bookId,
          message,
          timestamp: this.#now(),
        })
        return {
          bookId,
          status: "error",
          revision: null,
          message,
        }
      }
      if (
        error.status === 0 ||
        error.status === 404 ||
        error.status === 429 ||
        error.status >= 500
      ) {
        const message = classifyProgressSaveError(error).message
        const record = await this.#store.getOutbox(bookId)
        await this.#store.markRetryableFailure(
          bookId,
          mutation,
          message,
        )
        this.#scheduleRetry(
          bookId,
          record?.attemptCount ?? 1,
        )
        return {
          bookId,
          status: "pending",
          revision: null,
          message,
        }
      }
      const message = classifyProgressSaveError(error).message
      await this.#store.markPermanentFailure(
        bookId,
        mutation,
        message,
      )
      this.#emit({
        type: "failed",
        bookId,
        message,
        timestamp: this.#now(),
      })
      return {
        bookId,
        status: "error",
        revision: null,
        message,
      }
    }
    const message = errorMessage(error)
    await this.#store.markRetryableFailure(
      bookId,
      mutation,
      message,
    )
    this.#scheduleRetry(bookId, 1)
    return {
      bookId,
      status: "pending",
      revision: null,
      message,
    }
  }

  async #withBookLock<T>(
    bookId: string,
    task: () => Promise<T>,
  ): Promise<T | ProgressFlushResult> {
    if (this.#locks === null) {
      return task()
    }
    let ran = false
    let result: T | undefined
    await this.#locks.request(
      `${this.#lockName}:${bookId}`,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          return
        }
        ran = true
        result = await task()
      },
    )
    if (!ran) {
      return {
        bookId,
        status: "skipped",
        revision: null,
        message: "另一个标签正在同步进度。",
      }
    }
    return result as T
  }

  #attachChannel(): void {
    if (this.#channel === null) {
      return
    }
    this.#channel.onmessage = (
      event: MessageEvent<BroadcastPayload>,
    ) => {
      const payload = event.data
      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof payload.bookId !== "string"
      ) {
        return
      }
      this.#emit({
        type: "remote-change",
        bookId: payload.bookId,
        revision:
          typeof payload.revision === "string"
            ? payload.revision
            : null,
        timestamp: this.#now(),
      })
    }
  }

  #postChannel(payload: BroadcastPayload): void {
    try {
      this.#channel?.postMessage(payload)
    } catch {
      // 多标签通知失败不影响本地持久化。
    }
  }

  #bindLifecycle(): void {
    if (this.#bound || this.#lifecycleTarget === null) {
      return
    }
    this.#bound = true
    this.#onVisibility = () => {
      const documentValue = (
        globalThis as { document?: Document }
      ).document
      if (documentValue?.visibilityState === "hidden") {
        this.#wasHidden = true
        // 先同步写退出快照/当前 locator，再 keepalive flush；
        // flushNow 在第一个 await 前完成 localStorage 写入。
        void this.flushNow({
          keepalive: true,
          reason: "visibilitychange",
        }).catch(() => undefined)
        return
      }
      if (this.#wasHidden) {
        this.#wasHidden = false
        void this.handleForeground().catch(() => undefined)
      }
    }
    this.#onPageHide = () => {
      void this.flushNow({
        keepalive: true,
        reason: "pagehide",
      }).catch(() => undefined)
    }
    this.#onPageShow = (event: Event) => {
      const persisted = (event as PageTransitionEvent).persisted
      if (!persisted) {
        return
      }
      void this.handleForeground().catch(() => undefined)
    }
    this.#lifecycleTarget.addEventListener(
      "visibilitychange",
      this.#onVisibility,
    )
    this.#lifecycleTarget.addEventListener(
      "pagehide",
      this.#onPageHide,
    )
    this.#lifecycleTarget.addEventListener(
      "pageshow",
      this.#onPageShow,
    )
    if (this.#onlineTarget !== null) {
      this.#onOnline = () => {
        void this.resume().catch(() => undefined)
      }
      this.#onlineTarget.addEventListener("online", this.#onOnline)
    }
  }

  #unbindLifecycle(): void {
    if (!this.#bound || this.#lifecycleTarget === null) {
      return
    }
    this.#bound = false
    if (this.#onVisibility !== null) {
      this.#lifecycleTarget.removeEventListener(
        "visibilitychange",
        this.#onVisibility,
      )
    }
    if (this.#onPageHide !== null) {
      this.#lifecycleTarget.removeEventListener(
        "pagehide",
        this.#onPageHide,
      )
    }
    if (this.#onPageShow !== null) {
      this.#lifecycleTarget.removeEventListener(
        "pageshow",
        this.#onPageShow,
      )
    }
    if (
      this.#onlineTarget !== null &&
      this.#onOnline !== null
    ) {
      this.#onlineTarget.removeEventListener("online", this.#onOnline)
    }
  }

  #emit(event: ReaderProgressSyncEvent): void {
    try {
      this.#onEvent?.(event)
    } catch {
      // 订阅方异常不能影响同步。
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // 同上。
      }
    }
  }
}
