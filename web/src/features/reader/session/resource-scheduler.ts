import {
  resourceKeyId,
  type ResourceKey,
} from "../cache/resource-key"

/**
 * 阅读资源统一调度器。
 *
 * 边界：openBook 后的会话内所有网络/解析任务共享该调度器；
 * 同 key 在途请求合并；消费者取消只移除引用，最后一个消费者
 * 离开才中止底层请求。dispose 后拒绝迟到结果。
 */

export const RESOURCE_PRIORITIES = [
  "critical",
  "visible",
  "prefetch",
] as const

export type ResourcePriority = (typeof RESOURCE_PRIORITIES)[number]

const PRIORITY_WEIGHT: Record<ResourcePriority, number> = {
  critical: 0,
  visible: 1,
  prefetch: 2,
}

export class ResourceCancelledError extends Error {
  readonly cancelled = true
  readonly reason: string

  constructor(reason: string) {
    super(`资源请求已取消：${reason}`)
    this.name = "ResourceCancelledError"
    this.reason = reason
  }
}

export class ResourceStaleSessionError extends Error {
  readonly stale = true
  readonly sessionGeneration: number

  constructor(sessionGeneration: number) {
    super("资源请求属于已结束的阅读会话。")
    this.name = "ResourceStaleSessionError"
    this.sessionGeneration = sessionGeneration
  }
}

export interface ResourceJobInfo {
  key: ResourceKey
  keyId: string
  requestId: string
  priority: ResourcePriority
  sessionGeneration: number
  queuedAt: number
  startedAt: number
}

export type ResourceLoader<T> = (
  signal: AbortSignal,
  job: ResourceJobInfo,
) => Promise<T>

export interface ResourceRequestOptions {
  priority?: ResourcePriority
  signal?: AbortSignal
}

interface EventBase {
  sessionGeneration: number
  keyId: string
  bookId: string
  fileVersion: string
  kind: ResourceKey["kind"]
  requestId: string
  priority: ResourcePriority
  timestamp: number
}

export type ReaderResourceSchedulerEvent =
  | (EventBase & { type: "queued" })
  | (EventBase & { type: "started" })
  | {
      type: "hit"
      sessionGeneration: number
      keyId: string
      bookId: string
      fileVersion: string
      kind: ResourceKey["kind"]
      source: "L1" | "L2" | "L3"
      timestamp: number
    }
  | (EventBase & {
      type: "completed"
      durationMs: number
    })
  | (EventBase & {
      type: "cancelled"
      reason: string
    })
  | (EventBase & {
      type: "failed"
      error: string
    })
  | {
      type: "session-disposed"
      sessionGeneration: number
      timestamp: number
    }

export interface ReaderResourceSchedulerStats {
  queued: number
  active: number
  deduped: number
  completed: number
  cancelled: number
  failed: number
  hits: number
  subscribers: number
  concurrency: number
  sessionGeneration: number
}

interface Subscriber<T> {
  id: number
  signal: AbortSignal | null
  resolve: (value: T) => void
  reject: (error: unknown) => void
  onAbort: (() => void) | null
}

interface Job {
  key: ResourceKey
  keyId: string
  requestId: string
  priority: ResourcePriority
  sessionGeneration: number
  queuedAt: number
  startedAt: number | null
  controller: AbortController
  subscribers: Set<Subscriber<unknown>>
  loader: ResourceLoader<unknown>
  settled: boolean
}

export interface ReaderResourceSchedulerOptions {
  sessionGeneration?: number
  concurrency?: number
  now?: () => number
  onEvent?: (event: ReaderResourceSchedulerEvent) => void
}

export class ReaderResourceScheduler {
  readonly #now: () => number
  readonly #onEvent:
    | ((event: ReaderResourceSchedulerEvent) => void)
    | undefined
  readonly #queue: Job[] = []
  readonly #jobs = new Map<string, Job>()
  readonly #active = new Set<Job>()
  readonly #listeners = new Set<
    (event: ReaderResourceSchedulerEvent) => void
  >()
  #sessionGeneration: number
  #concurrency: number
  #disposed = false
  #subscriberId = 1
  #requestId = 1
  #deduped = 0
  #completed = 0
  #cancelled = 0
  #failed = 0
  #hits = 0

  constructor(options: ReaderResourceSchedulerOptions = {}) {
    this.#sessionGeneration = options.sessionGeneration ?? 1
    this.#concurrency = Math.max(1, options.concurrency ?? 3)
    this.#now = options.now ?? (() => Date.now())
    this.#onEvent = options.onEvent
  }

  get sessionGeneration(): number {
    return this.#sessionGeneration
  }

  get concurrency(): number {
    return this.#concurrency
  }

  setConcurrency(value: number): void {
    this.#concurrency = Math.max(1, Math.floor(value))
    this.#pump()
  }

  has(key: ResourceKey): boolean {
    return this.#jobs.has(this.#keyId(key))
  }

  stats(): ReaderResourceSchedulerStats {
    let subscribers = 0
    for (const job of this.#jobs.values()) {
      subscribers += job.subscribers.size
    }
    return {
      queued: this.#queue.length,
      active: this.#active.size,
      deduped: this.#deduped,
      completed: this.#completed,
      cancelled: this.#cancelled,
      failed: this.#failed,
      hits: this.#hits,
      subscribers,
      concurrency: this.#concurrency,
      sessionGeneration: this.#sessionGeneration,
    }
  }

  subscribe(
    listener: (event: ReaderResourceSchedulerEvent) => void,
  ): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 记录一次缓存命中（由 L1/L2/L3 查询方上报），
   * 供性能面板统计命中/未命中，不参与在途合并。
   */
  recordCacheHit(
    key: ResourceKey,
    source: "L1" | "L2" | "L3" = "L1",
  ): void {
    if (this.#disposed) {
      return
    }
    const keyId = this.#keyId(key)
    this.#hits += 1
    this.#dispatch({
      type: "hit",
      sessionGeneration: this.#sessionGeneration,
      keyId,
      bookId: key.bookId,
      fileVersion: key.fileVersion,
      kind: key.kind,
      source,
      timestamp: this.#now(),
    })
  }

  request<T>(
    key: ResourceKey,
    loader: ResourceLoader<T>,
    options: ResourceRequestOptions = {},
  ): Promise<T> {
    const keyId = this.#keyId(key)
    const priority = options.priority ?? "visible"
    if (this.#disposed) {
      return Promise.reject(
        new ResourceStaleSessionError(this.#sessionGeneration),
      )
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(
        new ResourceCancelledError("consumer-aborted"),
      )
    }
    const existing = this.#jobs.get(keyId)
    if (existing !== undefined) {
      this.#deduped += 1
      if (
        PRIORITY_WEIGHT[priority] <
        PRIORITY_WEIGHT[existing.priority]
      ) {
        existing.priority = priority
      }
      return this.#addSubscriber(
        existing,
        options.signal ?? null,
      ) as Promise<T>
    }

    const job: Job = {
      key,
      keyId,
      requestId: `resource-${this.#requestId++}`,
      priority,
      sessionGeneration: this.#sessionGeneration,
      queuedAt: this.#now(),
      startedAt: null,
      controller: new AbortController(),
      subscribers: new Set(),
      loader: loader as ResourceLoader<unknown>,
      settled: false,
    }
    this.#jobs.set(keyId, job)
    this.#queue.push(job)
    this.#emit(job, { type: "queued" })
    if (this.#active.size >= this.#concurrency) {
      this.#preemptFor(job)
    }
    this.#pump()
    return this.#addSubscriber(
      job,
      options.signal ?? null,
    ) as Promise<T>
  }

  /** 取消指定 key 的所有消费者与底层请求。 */
  cancel(key: ResourceKey, reason = "cancelled"): boolean {
    const job = this.#jobs.get(this.#keyId(key))
    if (job === undefined) {
      return false
    }
    this.#cancelJob(job, reason)
    return true
  }

  /**
   * 快速跳页后取消远处预取。keepKeyIds 内的 key 保留；
   * 默认只取消 prefetch，避免误杀可见请求。
   */
  cancelObsolete(
    keepKeyIds: Iterable<string>,
    options: { priorities?: ResourcePriority[] } = {},
  ): number {
    const keep = new Set(keepKeyIds)
    const priorities =
      options.priorities ?? (["prefetch"] as ResourcePriority[])
    let cancelled = 0
    for (const job of [...this.#jobs.values()]) {
      if (!priorities.includes(job.priority) || keep.has(job.keyId)) {
        continue
      }
      this.#cancelJob(job, "obsolete")
      cancelled += 1
    }
    return cancelled
  }

  cancelAll(reason = "cancelled"): number {
    let cancelled = 0
    for (const job of [...this.#jobs.values()]) {
      this.#cancelJob(job, reason)
      cancelled += 1
    }
    return cancelled
  }

  setPriority(
    key: ResourceKey,
    priority: ResourcePriority,
  ): boolean {
    const job = this.#jobs.get(this.#keyId(key))
    if (job === undefined) {
      return false
    }
    job.priority = priority
    if (priority === "critical" && job.startedAt === null) {
      this.#pump()
    }
    return true
  }

  /**
   * 幂等销毁：中止在途/排队任务，拒绝所有消费者，
   * 之后 request 立即返回 stale 错误。
   */
  dispose(reason = "session-disposed"): void {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    this.#sessionGeneration += 1
    for (const job of [...this.#jobs.values()]) {
      this.#cancelJob(job, reason)
    }
    this.#queue.length = 0
    this.#active.clear()
    this.#emitDisposed()
  }

  #keyId(key: ResourceKey): string {
    return resourceKeyId(key)
  }

  #addSubscriber(
    job: Job,
    signal: AbortSignal | null,
  ): Promise<unknown> {
    if (job.settled) {
      return Promise.reject(
        new ResourceCancelledError("job-settled"),
      )
    }
    if (signal?.aborted === true) {
      return Promise.reject(new ResourceCancelledError("consumer-aborted"))
    }
    return new Promise<unknown>((resolve, reject) => {
      const subscriber: Subscriber<unknown> = {
        id: this.#subscriberId++,
        signal,
        resolve,
        reject,
        onAbort: null,
      }
      if (signal !== null) {
        const onAbort = (): void => {
          this.#removeSubscriber(job, subscriber, true)
        }
        subscriber.onAbort = onAbort
        signal.addEventListener("abort", onAbort, { once: true })
      }
      job.subscribers.add(subscriber)
    })
  }

  #removeSubscriber(
    job: Job,
    subscriber: Subscriber<unknown>,
    rejectWithCancel: boolean,
  ): void {
    if (!job.subscribers.delete(subscriber)) {
      return
    }
    if (subscriber.onAbort !== null) {
      subscriber.signal?.removeEventListener(
        "abort",
        subscriber.onAbort,
      )
    }
    if (rejectWithCancel) {
      subscriber.reject(
        new ResourceCancelledError("consumer-aborted"),
      )
    }
    if (job.subscribers.size === 0 && !job.settled) {
      this.#cancelJob(job, "consumers-abandoned")
    }
  }

  #cancelJob(job: Job, reason: string): void {
    if (job.settled) {
      return
    }
    job.settled = true
    job.controller.abort()
    const queueIndex = this.#queue.indexOf(job)
    if (queueIndex >= 0) {
      this.#queue.splice(queueIndex, 1)
    }
    this.#active.delete(job)
    this.#jobs.delete(job.keyId)
    for (const subscriber of [...job.subscribers]) {
      if (subscriber.onAbort !== null) {
        subscriber.signal?.removeEventListener(
          "abort",
          subscriber.onAbort,
        )
      }
      subscriber.reject(new ResourceCancelledError(reason))
    }
    job.subscribers.clear()
    this.#cancelled += 1
    this.#emit(job, { type: "cancelled", reason })
    if (!this.#disposed) {
      this.#pump()
    }
  }

  #preemptFor(incoming: Job): void {
    let victim: Job | null = null
    for (const job of this.#active) {
      if (
        job.priority === "prefetch" &&
        PRIORITY_WEIGHT[incoming.priority] < PRIORITY_WEIGHT[job.priority]
      ) {
        victim = job
        break
      }
    }
    if (victim !== null) {
      this.#cancelJob(victim, "preempted")
    }
  }

  #pump(): void {
    if (this.#disposed) {
      return
    }
    while (this.#active.size < this.#concurrency) {
      const next = this.#takeNext()
      if (next === undefined) {
        return
      }
      this.#start(next)
    }
  }

  #takeNext(): Job | undefined {
    if (this.#queue.length === 0) {
      return undefined
    }
    let bestIndex = 0
    for (let index = 1; index < this.#queue.length; index += 1) {
      const candidate = this.#queue[index]
      const best = this.#queue[bestIndex]
      if (candidate === undefined || best === undefined) {
        continue
      }
      if (
        PRIORITY_WEIGHT[candidate.priority] <
          PRIORITY_WEIGHT[best.priority] ||
        (candidate.priority === best.priority &&
          candidate.queuedAt < best.queuedAt)
      ) {
        bestIndex = index
      }
    }
    return this.#queue.splice(bestIndex, 1)[0]
  }

  #start(job: Job): void {
    if (job.settled) {
      return
    }
    job.startedAt = this.#now()
    this.#active.add(job)
    const info: ResourceJobInfo = {
      key: job.key,
      keyId: job.keyId,
      requestId: job.requestId,
      priority: job.priority,
      sessionGeneration: job.sessionGeneration,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
    }
    this.#emit(job, { type: "started" })
    void job
      .loader(job.controller.signal, info)
      .then((value) => {
        if (job.settled) {
          return
        }
        if (this.#disposed || job.sessionGeneration !== this.#sessionGeneration) {
          this.#settleStale(job)
          return
        }
        this.#finish(job)
        for (const subscriber of [...job.subscribers]) {
          if (subscriber.onAbort !== null) {
            subscriber.signal?.removeEventListener(
              "abort",
              subscriber.onAbort,
            )
          }
          subscriber.resolve(value)
        }
        job.subscribers.clear()
        this.#completed += 1
        this.#emit(job, {
          type: "completed",
          durationMs: Math.max(
            0,
            this.#now() - (job.startedAt ?? job.queuedAt),
          ),
        })
      })
      .catch((error: unknown) => {
        if (job.settled) {
          return
        }
        if (job.controller.signal.aborted) {
          this.#cancelJob(job, "aborted")
          return
        }
        this.#finish(job)
        for (const subscriber of [...job.subscribers]) {
          if (subscriber.onAbort !== null) {
            subscriber.signal?.removeEventListener(
              "abort",
              subscriber.onAbort,
            )
          }
          subscriber.reject(error)
        }
        job.subscribers.clear()
        this.#failed += 1
        this.#emit(job, {
          type: "failed",
          error:
            error instanceof Error ? error.message : String(error),
        })
      })
  }

  #settleStale(job: Job): void {
    if (job.settled) {
      return
    }
    job.settled = true
    job.controller.abort()
    this.#active.delete(job)
    this.#jobs.delete(job.keyId)
    for (const subscriber of [...job.subscribers]) {
      if (subscriber.onAbort !== null) {
        subscriber.signal?.removeEventListener(
          "abort",
          subscriber.onAbort,
        )
      }
      subscriber.reject(
        new ResourceStaleSessionError(job.sessionGeneration),
      )
    }
    job.subscribers.clear()
    this.#cancelled += 1
    this.#emit(job, { type: "cancelled", reason: "stale-session" })
    this.#pump()
  }

  #finish(job: Job): void {
    job.settled = true
    this.#active.delete(job)
    this.#jobs.delete(job.keyId)
    this.#pump()
  }

  #emit(
    job: Job,
    event:
      | { type: "queued" }
      | { type: "started" }
      | { type: "completed"; durationMs: number }
      | { type: "cancelled"; reason: string }
      | { type: "failed"; error: string },
  ): void {
    const payload = {
      sessionGeneration: job.sessionGeneration,
      keyId: job.keyId,
      bookId: job.key.bookId,
      fileVersion: job.key.fileVersion,
      kind: job.key.kind,
      requestId: job.requestId,
      priority: job.priority,
      timestamp: this.#now(),
      ...event,
    } as ReaderResourceSchedulerEvent
    this.#dispatch(payload)
  }

  #emitDisposed(): void {
    this.#dispatch({
      type: "session-disposed",
      sessionGeneration: this.#sessionGeneration,
      timestamp: this.#now(),
    })
  }

  #dispatch(event: ReaderResourceSchedulerEvent): void {
    try {
      this.#onEvent?.(event)
    } catch {
      // 事件订阅方异常不能影响调度。
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

/** 判断错误是否代表可安全忽略的取消。 */
export function isResourceCancellation(error: unknown): boolean {
  return (
    error instanceof ResourceCancelledError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}
