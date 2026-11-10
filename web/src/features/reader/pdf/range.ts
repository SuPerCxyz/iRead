import { PDFDataRangeTransport } from "pdfjs-dist"

import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"
import type { ResourcePriority } from "../session/resource-scheduler"
import {
  pdfRangeKey,
  resourceKeyId,
  type ResourceRange,
} from "../cache/resource-key"

/**
 * PDF 原件 Range 传输。
 *
 * 第一阶段只读取 PDF.js 解析所需的首个字节块，之后由 PDF.js 的
 * PDFDataRangeTransport 按需请求页对象。这里不缓存整本文件，也不把
 * 200 响应包装成可继续读取的“伪 Range”；服务端必须返回真实 206。
 */
export const PDF_RANGE_CHUNK_SIZE = 65_536

export interface PdfNetworkRequest {
  begin: number
  end: number
  status: number
  bytes: number
}

export interface PdfNetworkStats {
  requestCount: number
  downloadedBytes: number
  totalBytes: number
  requests: PdfNetworkRequest[]
  fullBodyResponse: boolean
}

export class PdfLoadError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = "PdfLoadError"
    this.code = code
    this.status = options.status ?? 0
    this.retryable = options.retryable ?? false
  }
}

export interface InitialRange {
  data: Uint8Array
  totalBytes: number
  request: PdfNetworkRequest
}

interface ErrorEnvelope {
  code?: unknown
  message?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readErrorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const contentType = response.headers.get("Content-Type") ?? ""
  if (!contentType.includes("json")) {
    return {}
  }
  try {
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !isRecord(payload.error)) {
      return {}
    }
    return payload.error as ErrorEnvelope
  } catch {
    return {}
  }
}

export function pdfErrorForStatus(
  status: number,
  serverCode: string,
  serverMessage: string,
): PdfLoadError {
  if (status === 401) {
    return new PdfLoadError(
      "unauthenticated",
      "登录状态已失效，请重新登录后再打开这本书。",
      { status, retryable: true },
    )
  }
  if (status === 409) {
    return new PdfLoadError(
      "file_version_conflict",
      "PDF 原件已在别处更新，请重新打开书籍以取得当前版本。",
      { status, retryable: false },
    )
  }
  if (status === 404) {
    return new PdfLoadError(
      "not_found",
      "PDF 原件不存在或已被移除。",
      { status, retryable: false },
    )
  }
  if (status === 416) {
    return new PdfLoadError(
      "range_not_satisfiable",
      "服务器无法返回所需的 PDF 字节范围，请重试或检查代理缓存。",
      { status, retryable: true },
    )
  }
  if (status === 403) {
    return new PdfLoadError(
      "forbidden",
      "当前会话没有读取这份 PDF 的权限。",
      { status, retryable: false },
    )
  }
  if (status >= 500) {
    return new PdfLoadError(
      serverCode || "storage_unavailable",
      "PDF 存储暂不可用，请稍后重试。",
      { status, retryable: true },
    )
  }
  return new PdfLoadError(
    serverCode || "http_error",
    serverMessage.length > 0
      ? serverMessage
      : `读取 PDF 失败（HTTP ${status}）。`,
    { status, retryable: status === 429 },
  )
}

function parseContentRange(
  value: string | null,
): { begin: number; end: number; total: number } | null {
  if (value === null) {
    return null
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim())
  if (match === null) {
    return null
  }
  const begin = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (
    !Number.isSafeInteger(begin) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    begin < 0 ||
    end < begin ||
    total <= end
  ) {
    return null
  }
  return { begin, end, total }
}

export interface PdfChunkPayload {
  bytes: Uint8Array
  begin: number
  end: number
  totalBytes: number
  contentType: string
  etag: string
}

/** 单个 PDF 会话最多同时挂起的 IndexedDB 写入数。 */
export const PDF_WRITE_BEHIND_LIMIT = 8

type PdfChunkWriteInput = Omit<
  Parameters<ReaderCacheRuntime["persistent"]["writePdfChunk"]>[0],
  "generation"
> & {
  /**
   * 在发起 Range 请求时就开始读取 generation，但不阻塞字节返回；
   * 真正写入前再等待结果，写入层仍会校验 generation 是否前进。
   */
  generation: number | Promise<number>
}

export interface PdfWriteBehindStats {
  pending: number
  stored: number
  failed: number
  dropped: number
}

const writeBehindQueues = new WeakMap<
  ReaderCacheRuntime["persistent"],
  PdfChunkWriteBehind
>()

/**
 * PDF Range 块的持久化写队列。
 *
 * PDF.js 只关心拿到的字节；IndexedDB 写入是尽力而为的旁路。若每次读取
 * 都 `await writePdfChunk`，缓存层的预算整理或慢磁盘会直接拖住首开。
 * 这里限制同时挂起的写入数量，超出时丢弃新写入（内存缓存仍然有效），
 * 写入失败或 generation 过期也只记入统计，不影响本次读取。
 */
export class PdfChunkWriteBehind {
  readonly #persistent: ReaderCacheRuntime["persistent"]
  readonly #limit: number
  readonly #pending = new Set<Promise<void>>()
  readonly #idleWaiters: Array<() => void> = []
  #stored = 0
  #failed = 0
  #dropped = 0

  constructor(
    persistent: ReaderCacheRuntime["persistent"],
    limit = PDF_WRITE_BEHIND_LIMIT,
  ) {
    this.#persistent = persistent
    this.#limit = Math.max(1, limit)
  }

  /** 入队并立即返回；队列饱和时丢弃本次写入并返回 false。 */
  enqueue(input: PdfChunkWriteInput): boolean {
    if (this.#pending.size >= this.#limit) {
      this.#dropped += 1
      return false
    }
    const job = this.#run(input)
    this.#pending.add(job)
    void job.finally(() => {
      this.#pending.delete(job)
      if (this.#pending.size === 0) {
        for (const resolve of this.#idleWaiters.splice(0)) {
          resolve()
        }
      }
    })
    return true
  }

  stats(): PdfWriteBehindStats {
    return {
      pending: this.#pending.size,
      stored: this.#stored,
      failed: this.#failed,
      dropped: this.#dropped,
    }
  }

  /** 等待当前队列清空；测试或卸载前的可选钩子。 */
  async idle(): Promise<void> {
    if (this.#pending.size === 0) {
      return
    }
    await new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve)
    })
  }

  async #run(input: PdfChunkWriteInput): Promise<void> {
    try {
      const { generation, ...rest } = input
      const result = await this.#persistent.writePdfChunk({
        ...rest,
        generation: await generation,
      })
      if (result.stored) {
        this.#stored += 1
        return
      }
      // generation 前进后旧块被拒绝是正常淘汰，不计为失败。
      if (result.reason !== "stale-generation") {
        this.#failed += 1
      }
    } catch {
      this.#failed += 1
    }
  }
}

/** 同一持久缓存实例共享一个有界写队列。 */
export function pdfChunkWriteBehind(
  persistent: ReaderCacheRuntime["persistent"],
): PdfChunkWriteBehind {
  let queue = writeBehindQueues.get(persistent)
  if (queue === undefined) {
    queue = new PdfChunkWriteBehind(persistent)
    writeBehindQueues.set(persistent, queue)
  }
  return queue
}

/** 把任意请求区间切成稳定的 64KiB 块，供 L1/L3 键复用。 */
export function pdfChunkRanges(
  begin: number,
  end: number,
  length: number,
): ResourceRange[] {
  if (end <= begin || length <= 0) {
    return []
  }
  const last = Math.min(end - 1, length - 1)
  const ranges: ResourceRange[] = []
  let cursor = Math.floor(Math.max(0, begin) / PDF_RANGE_CHUNK_SIZE) *
    PDF_RANGE_CHUNK_SIZE
  while (cursor <= last) {
    ranges.push({
      start: cursor,
      end: Math.min(cursor + PDF_RANGE_CHUNK_SIZE - 1, length - 1),
    })
    cursor += PDF_RANGE_CHUNK_SIZE
  }
  return ranges
}

function memoryBytes(
  value: Blob | ArrayBuffer | Uint8Array | string,
): Uint8Array | null {
  if (typeof value === "string") {
    return new TextEncoder().encode(value)
  }
  if (value instanceof Blob) {
    return null
  }
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value
}

/**
 * 读取一个 64KiB 块：L1 → L3 → scheduler 网络请求。
 * 只接受 206 + 匹配的 Content-Range；200 完整响应会被拒绝。
 *
 * `revalidate` 用于首块：已有缓存仍先向服务器校验（让 409/权限错误可见），
 * 只有网络不可达时才回退缓存；因此离线重开仍可用。
 */
export async function loadPdfChunk(
  cache: ReaderCacheRuntime,
  contentUrl: URL,
  range: ResourceRange,
  options: {
    signal: AbortSignal
    fetchImpl?: typeof fetch
    onRequest?: (request: PdfNetworkRequest) => void
    priority?: ResourcePriority
    revalidate?: boolean
  },
): Promise<PdfChunkPayload> {
  const key = pdfRangeKey(
    cache.bookId,
    cache.fileVersion,
    range.start,
    range.end,
  )
  const keyId = resourceKeyId(key)
  const cached = await readPdfChunkCache(cache, key, keyId, options.signal)
  if (cached !== null && options.revalidate !== true) {
    cache.scheduler.recordCacheHit(key, cached.source)
    return cached.payload
  }
  try {
    return await cache.scheduler.request(
      key,
      async (jobSignal) => {
        // 读取 generation 用于写入前校验，但不要阻塞首块字节；慢/不可用的
        // IndexedDB 只影响缓存写入，不应拖住打开 PDF。
        const generation = cache.persistent
          .currentGeneration()
          .catch(() => 0)
        return fetchPdfChunk(
          key,
          contentUrl,
          range,
          generation,
          jobSignal,
          cache,
          options,
        )
      },
      {
        signal: options.signal,
        priority: options.priority ?? "visible",
      },
    )
  } catch (error) {
    if (
      options.revalidate === true &&
      cached !== null &&
      error instanceof PdfLoadError &&
      error.code === "network_error"
    ) {
      cache.scheduler.recordCacheHit(key, cached.source)
      return cached.payload
    }
    throw error
  }
}

async function readPdfChunkCache(
  cache: ReaderCacheRuntime,
  key: ReturnType<typeof pdfRangeKey>,
  keyId: string,
  signal: AbortSignal,
): Promise<{
  payload: PdfChunkPayload
  source: "L1" | "L3"
} | null> {
  const cached = cache.memory.get(keyId)
  if (cached !== null) {
    const bytes =
      memoryBytes(cached.value) ??
      new Uint8Array(await (cached.value as Blob).arrayBuffer())
    const total = Number(cached.version)
    return {
      source: "L1",
      payload: {
        bytes,
        begin: key.range?.start ?? 0,
        end: key.range?.end ?? 0,
        totalBytes:
          Number.isSafeInteger(total) && total > 0 ? total : 0,
        contentType: cached.mediaType || "application/pdf",
        etag: "",
      },
    }
  }
  const stored = await cache.persistent
    .readPdfChunk(key)
    .catch(() => null)
  if (signal.aborted) {
    throw new DOMException("Range 请求已取消", "AbortError")
  }
  if (stored === null) {
    return null
  }
  cache.memory.set(keyId, stored.bytes, {
    mediaType: stored.contentType || "application/pdf",
    version: String(stored.totalBytes ?? 0),
  })
  return {
    source: "L3",
    payload: {
      bytes: stored.bytes,
      begin: key.range?.start ?? 0,
      end: key.range?.end ?? 0,
      totalBytes: stored.totalBytes ?? 0,
      contentType: stored.contentType || "application/pdf",
      etag: stored.etag,
    },
  }
}

async function fetchPdfChunk(
  key: ReturnType<typeof pdfRangeKey>,
  contentUrl: URL,
  range: ResourceRange,
  generation: number | Promise<number>,
  signal: AbortSignal,
  cache: ReaderCacheRuntime,
  options: {
    fetchImpl?: typeof fetch
    onRequest?: (request: PdfNetworkRequest) => void
  },
): Promise<PdfChunkPayload> {
  let response: Response
  try {
    const fetchImpl = options.fetchImpl ?? fetch
    response = await fetchImpl(contentUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/pdf",
        Range: `bytes=${range.start}-${range.end}`,
      },
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new PdfLoadError(
      "network_error",
      "读取 PDF 字节范围时网络中断，请重试。",
      { retryable: true, cause: error },
    )
  }
  if (!response.ok && response.status !== 206) {
    const envelope = await readErrorEnvelope(response)
    throw pdfErrorForStatus(
      response.status,
      typeof envelope.code === "string" ? envelope.code : "",
      typeof envelope.message === "string" ? envelope.message : "",
    )
  }
  validateContentType(response)
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => undefined)
    throw new PdfLoadError(
      "range_unsupported",
      "服务器未按 PDF Range 请求返回 206，已停止继续读取。",
      { status: response.status, retryable: true },
    )
  }
  const contentRange = parseContentRange(
    response.headers.get("Content-Range"),
  )
  if (
    contentRange === null ||
    contentRange.begin !== range.start ||
    contentRange.end !== range.end
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw new PdfLoadError(
      "invalid_content_range",
      "服务器返回的 PDF 字节范围与请求不一致，请重试。",
      { status: response.status, retryable: true },
    )
  }
  const bytes = await readRangeBody(response)
  const expected = range.end - range.start + 1
  if (bytes.byteLength !== expected) {
    throw new PdfLoadError(
      "invalid_range_length",
      "服务器返回的 PDF 字节数不完整，请重试。",
      { status: response.status, retryable: true },
    )
  }
  const contentType = response.headers.get("Content-Type") ?? "application/pdf"
  const etag = response.headers.get("ETag") ?? ""
  cache.memory.set(
    resourceKeyId(key),
    bytes,
    { mediaType: contentType, version: String(contentRange.total) },
  )
  // 写缓存不阻塞返回 PDF 字节；慢 IndexedDB 或预算整理不应卡住首开。
  pdfChunkWriteBehind(cache.persistent).enqueue({
    key,
    range,
    bytes,
    status: response.status,
    totalBytes: contentRange.total,
    contentType,
    etag,
    generation,
  })
  options.onRequest?.({
    begin: range.start,
    end: range.end,
    status: response.status,
    bytes: bytes.byteLength,
  })
  return {
    bytes,
    begin: range.start,
    end: range.end,
    totalBytes: contentRange.total,
    contentType,
    etag,
  }
}

function validateContentType(response: Response): void {
  const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase()
  if (
    contentType.length > 0 &&
    !contentType.includes("application/pdf") &&
    !contentType.includes("application/octet-stream")
  ) {
    throw new PdfLoadError(
      "invalid_content_type",
      "服务器返回的内容不是 PDF 原件，请检查阅读链接是否仍然有效。",
      { status: response.status, retryable: false },
    )
  }
}

async function readRangeBody(
  response: Response,
): Promise<Uint8Array> {
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}

function checkSameOrigin(url: URL, currentHref: string): void {
  const current = new URL(currentHref)
  if (url.origin !== current.origin) {
    throw new PdfLoadError(
      "cross_origin_content",
      "PDF 原件地址与应用不同源，为避免泄露登录凭据已停止读取。",
      { retryable: false },
    )
  }
}

/**
 * 读取首块。PDF.js 需要先得到长度与开头字节才能解析交叉引用表；
 * 这不会下载整本文件。
 */
export async function fetchInitialRange(
  contentHref: string,
  expectedBytes: number,
  options: {
    signal: AbortSignal
    fetchImpl?: typeof fetch
    onRequest?: (request: PdfNetworkRequest) => void
    /** 有会话缓存时首块也走 scheduler/L1/L3。 */
    cache?: ReaderCacheRuntime
  },
): Promise<InitialRange> {
  const baseHref =
    typeof window === "undefined" ? "http://localhost/" : window.location.href
  const url = new URL(contentHref, baseHref)
  checkSameOrigin(url, baseHref)

  if (options.cache !== undefined && expectedBytes > 0) {
    const end = Math.min(
      PDF_RANGE_CHUNK_SIZE - 1,
      expectedBytes - 1,
    )
    const chunk = await loadPdfChunk(
      options.cache,
      url,
      { start: 0, end },
      {
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        onRequest: options.onRequest,
        priority: "critical",
        revalidate: true,
      },
    )
    return {
      data: chunk.bytes,
      totalBytes: chunk.totalBytes > 0 ? chunk.totalBytes : expectedBytes,
      request: {
        begin: 0,
        end: chunk.end,
        status: 206,
        bytes: chunk.bytes.byteLength,
      },
    }
  }

  const begin = 0
  const end = Math.max(0, PDF_RANGE_CHUNK_SIZE - 1)
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/pdf",
        Range: `bytes=${begin}-${end}`,
      },
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal.aborted) {
      throw error
    }
    throw new PdfLoadError(
      "network_error",
      "无法连接本机服务，请检查网络后重试。",
      { retryable: true, cause: error },
    )
  }

  if (!response.ok && response.status !== 206) {
    const envelope = await readErrorEnvelope(response)
    throw pdfErrorForStatus(
      response.status,
      typeof envelope.code === "string" ? envelope.code : "",
      typeof envelope.message === "string" ? envelope.message : "",
    )
  }
  validateContentType(response)

  if (response.status === 200) {
    const lengthHeader = Number(response.headers.get("Content-Length") ?? "0")
    const knownLength =
      Number.isSafeInteger(lengthHeader) && lengthHeader > 0
        ? lengthHeader
        : expectedBytes
    if (knownLength > PDF_RANGE_CHUNK_SIZE) {
      // 大型文件若退回 200，继续读取会变成整本下载。停止并给出可操作错误，
      // 不能把服务端/代理配置问题伪装成按需加载成功。
      await response.body?.cancel().catch(() => undefined)
      throw new PdfLoadError(
        "range_unsupported",
        "服务器未启用 PDF 字节范围读取；为避免整本下载，已停止打开。请检查代理或缓存配置。",
        { status: 200, retryable: true },
      )
    }
    const data = await readRangeBody(response)
    const request: PdfNetworkRequest = {
      begin,
      end: data.byteLength - 1,
      status: 200,
      bytes: data.byteLength,
    }
    options.onRequest?.(request)
    return { data, totalBytes: data.byteLength, request }
  }

  const contentRange = parseContentRange(response.headers.get("Content-Range"))
  if (contentRange === null || contentRange.begin !== begin) {
    throw new PdfLoadError(
      "invalid_content_range",
      "服务器返回的 PDF 范围头无效，请重试或检查代理缓存。",
      { status: response.status, retryable: true },
    )
  }
  const data = await readRangeBody(response)
  const expectedLength = contentRange.end - contentRange.begin + 1
  if (data.byteLength !== expectedLength) {
    throw new PdfLoadError(
      "invalid_range_length",
      "服务器返回的 PDF 字节数与范围头不一致，请重试。",
      { status: response.status, retryable: true },
    )
  }
  const request: PdfNetworkRequest = {
    begin,
    end: contentRange.end,
    status: 206,
    bytes: data.byteLength,
  }
  options.onRequest?.(request)
  return { data, totalBytes: contentRange.total, request }
}

interface TransportOptions {
  length: number
  initialData: Uint8Array
  fetchImpl?: typeof fetch
  signal: AbortSignal
  onRequest: (request: PdfNetworkRequest) => void
  onError: (error: unknown) => void
  cache?: ReaderCacheRuntime
}

/**
 * PDF.js 官方 PDFDataRangeTransport 的 HTTP 实现。
 * requestDataRange 的 end 是开区间，与 PDF.js 内部语义一致。
 */
export class HttpPdfRangeTransport extends PDFDataRangeTransport {
  readonly #url: URL
  readonly #fetchImpl: typeof fetch
  readonly #signal: AbortSignal
  readonly #onRequest: (request: PdfNetworkRequest) => void
  readonly #onError: (error: unknown) => void
  readonly #cache: ReaderCacheRuntime | null
  readonly #length: number
  readonly #controllers = new Set<AbortController>()
  readonly #pending = new Map<string, AbortController>()
  #aborted = false

  constructor(url: URL, options: TransportOptions) {
    super(options.length, options.initialData)
    this.#url = url
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#signal = options.signal
    this.#onRequest = options.onRequest
    this.#onError = options.onError
    this.#cache = options.cache ?? null
    this.#length = options.length
    this.#signal.addEventListener(
      "abort",
      () => {
        this.abort()
      },
      { once: true },
    )
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.#aborted || end <= begin) {
      return
    }
    const last = end - 1
    const key = `${begin}-${last}`
    const existing = this.#pending.get(key)
    if (existing !== undefined) {
      return
    }
    const controller = new AbortController()
    this.#controllers.add(controller)
    this.#pending.set(key, controller)

    void this.#fetchRange(begin, last, controller.signal)
      .then((chunk) => {
        if (this.#aborted || controller.signal.aborted) {
          return
        }
        this.onDataRange(begin, chunk)
      })
      .catch((error: unknown) => {
        if (this.#aborted || controller.signal.aborted) {
          return
        }
        this.#onError(error)
        // 解除 PDF.js range reader 的等待，让页面级错误可见，而不是悬挂。
        this.onDataRange(begin, new Uint8Array(0))
      })
      .finally(() => {
        this.#controllers.delete(controller)
        if (this.#pending.get(key) === controller) {
          this.#pending.delete(key)
        }
      })
  }

  /**
   * 页切换时取消旧页面尚未完成的 Range 请求。
   * 对每个取消的请求回空块解除 PDF.js range reader 等待；新页请求随后重新发起。
   */
  cancelPending(): number {
    if (this.#aborted) {
      return 0
    }
    let cancelled = 0
    for (const [key, controller] of [...this.#pending]) {
      const begin = Number(key.split("-")[0])
      this.#pending.delete(key)
      this.#controllers.delete(controller)
      controller.abort()
      cancelled += 1
      try {
        this.onDataRange(begin, new Uint8Array(0))
      } catch {
        // 文档可能已销毁。
      }
    }
    return cancelled
  }

  override abort(): void {
    if (this.#aborted) {
      return
    }
    this.#aborted = true
    for (const controller of this.#controllers) {
      controller.abort()
    }
    this.#controllers.clear()
    this.#pending.clear()
  }

  async #fetchRange(
    begin: number,
    end: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const cache = this.#cache
    if (cache !== null) {
      const ranges = pdfChunkRanges(begin, end + 1, this.#length)
      if (ranges.length === 0) {
        return new Uint8Array(0)
      }
      const chunks = await Promise.all(
        ranges.map((range) =>
          loadPdfChunk(cache, this.#url, range, {
            signal,
            fetchImpl: this.#fetchImpl,
            onRequest: this.#onRequest,
            priority: "visible",
          }),
        ),
      )
      const output = new Uint8Array(end - begin + 1)
      for (const chunk of chunks) {
        const from = Math.max(begin, chunk.begin)
        const to = Math.min(end, chunk.end)
        if (to < from) {
          continue
        }
        output.set(
          chunk.bytes.subarray(from - chunk.begin, to - chunk.begin + 1),
          from - begin,
        )
      }
      return output
    }

    let response: Response
    try {
      const fetchImpl = this.#fetchImpl
      response = await fetchImpl(this.#url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/pdf",
          Range: `bytes=${begin}-${end}`,
        },
        signal,
      })
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      throw new PdfLoadError(
        "network_error",
        "读取 PDF 字节范围时网络中断，请重试。",
        { retryable: true, cause: error },
      )
    }

    if (!response.ok && response.status !== 206) {
      const envelope = await readErrorEnvelope(response)
      throw pdfErrorForStatus(
        response.status,
        typeof envelope.code === "string" ? envelope.code : "",
        typeof envelope.message === "string" ? envelope.message : "",
      )
    }
    validateContentType(response)

    if (response.status !== 206) {
      // 对已打开的文档发起 200 会造成下载范围失控；直接拒绝续读。
      await response.body?.cancel().catch(() => undefined)
      throw new PdfLoadError(
        "range_unsupported",
        "服务器未按 PDF Range 请求返回 206，已停止继续读取。",
        { status: response.status, retryable: true },
      )
    }

    const contentRange = parseContentRange(response.headers.get("Content-Range"))
    if (
      contentRange === null ||
      contentRange.begin !== begin ||
      contentRange.end !== end
    ) {
      throw new PdfLoadError(
        "invalid_content_range",
        "服务器返回的 PDF 字节范围与请求不一致，请重试。",
        { status: response.status, retryable: true },
      )
    }
    const data = await readRangeBody(response)
    const expected = end - begin + 1
    if (data.byteLength !== expected) {
      throw new PdfLoadError(
        "invalid_range_length",
        "服务器返回的 PDF 字节数不完整，请重试。",
        { status: response.status, retryable: true },
      )
    }
    this.#onRequest({
      begin,
      end,
      status: response.status,
      bytes: data.byteLength,
    })
    return data
  }
}
