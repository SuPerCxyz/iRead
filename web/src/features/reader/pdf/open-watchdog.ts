import { PdfLoadError } from "./range"

export type PdfOpenTimeoutReason = "deadline" | "stalled"

export interface PdfOpenWatchdogOptions {
  /** 打开 PDF 的绝对上限，避免无限等待。 */
  timeoutMs: number
  /** 连续多久没有新的已读取字节就判定为卡住。 */
  stallMs: number
  /** 超时后同步触发取消，例如销毁 PDFDocumentLoadingTask。 */
  onTimeout: () => void
}

/**
 * 打开 PDF 的进度看门狗。
 *
 * 固定总超时会把“仍在持续下载但超过阈值”的书籍误判为超时；这里同时
 * 使用绝对上限和进度停滞超时。只有 `progress(loaded)` 增长才重置停滞
 * 计时，重复或倒退的进度不会延长等待。
 */
export class PdfOpenWatchdog {
  readonly #timeoutMs: number
  readonly #stallMs: number
  readonly #onTimeout: () => void
  #deadlineTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  #stallTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  #reject: ((error: unknown) => void) | null = null
  #settled = false
  #lastLoaded = -1

  constructor(options: PdfOpenWatchdogOptions) {
    this.#timeoutMs = Math.max(1, options.timeoutMs)
    this.#stallMs = Math.max(1, options.stallMs)
    this.#onTimeout = options.onTimeout
  }

  /** 记录 PDF.js 已读取的字节数；只有增长才算有效进展。 */
  progress(loaded: number): void {
    if (this.#settled || !Number.isFinite(loaded) || loaded <= this.#lastLoaded) {
      return
    }
    this.#lastLoaded = loaded
    this.#armStall()
  }

  /** 等待打开完成；超时后会先调用 onTimeout 再以 PdfLoadError 拒绝。 */
  wait<T>(promise: Promise<T>): Promise<T> {
    if (this.#settled) {
      return promise
    }
    return new Promise<T>((resolve, reject) => {
      this.#reject = reject
      this.#deadlineTimer = globalThis.setTimeout(() => {
        this.#fail("deadline")
      }, this.#timeoutMs)
      this.#armStall()
      promise.then(
        (value) => {
          this.#finish()
          resolve(value)
        },
        (error: unknown) => {
          this.#finish()
          reject(error)
        },
      )
    })
  }

  /** 卸载或换书时停止计时，不再触发超时回调。 */
  dispose(): void {
    this.#settled = true
    this.#clearTimers()
    this.#reject = null
  }

  #armStall(): void {
    if (this.#stallTimer !== null) {
      globalThis.clearTimeout(this.#stallTimer)
    }
    this.#stallTimer = globalThis.setTimeout(() => {
      this.#fail("stalled")
    }, this.#stallMs)
  }

  #fail(reason: PdfOpenTimeoutReason): void {
    if (this.#settled) {
      return
    }
    this.#settled = true
    this.#clearTimers()
    try {
      this.#onTimeout()
    } catch {
      // 取消失败不能掩盖真正的超时错误。
    }
    const reject = this.#reject
    this.#reject = null
    reject?.(
      new PdfLoadError(
        "timeout",
        reason === "stalled"
          ? "读取 PDF 长时间没有进展，请重试。"
          : "打开 PDF 超时，请重试。",
        { retryable: true },
      ),
    )
  }

  #finish(): void {
    this.#settled = true
    this.#clearTimers()
    this.#reject = null
  }

  #clearTimers(): void {
    if (this.#deadlineTimer !== null) {
      globalThis.clearTimeout(this.#deadlineTimer)
      this.#deadlineTimer = null
    }
    if (this.#stallTimer !== null) {
      globalThis.clearTimeout(this.#stallTimer)
      this.#stallTimer = null
    }
  }
}
