/**
 * PDF.js 6.x 运行时兼容补丁。
 *
 * pdfjs-dist 6.5.438 的现代构建和 legacy 构建都会无条件调用
 * `Promise.withResolvers()`（包括 PDFWorker 的类字段初始化）。该方法直到
 * Chrome/Edge 119、Firefox 121、Safari 17.4 才进入浏览器；较旧内核会在
 * `getDocument()` 内同步抛出 `TypeError: Promise.withResolvers is not a
 * function`，最终被误报为泛化的 pdf_load_failed。
 *
 * 这段补丁必须早于任何 pdfjs 模块执行；主线程与 worker 都通过静态 import
 * 顺序保证这一点。只补齐 PDF.js 必需的、无副作用的标准语义。
 */

type Resolvers<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => Resolvers<T>
  try?: <T>(callback: (...args: unknown[]) => T, ...args: unknown[]) => Promise<T>
}

const promiseConstructor = Promise as PromiseConstructorWithResolvers

if (typeof promiseConstructor.withResolvers !== "function") {
  try {
    Object.defineProperty(promiseConstructor, "withResolvers", {
      configurable: true,
      writable: true,
      value: function withResolvers<T>(): Resolvers<T> {
        let resolve: (value: T | PromiseLike<T>) => void = () => undefined
        let reject: (reason?: unknown) => void = () => undefined
        const promise = new Promise<T>((resolvePromise, rejectPromise) => {
          resolve = resolvePromise
          reject = rejectPromise
        })
        return { promise, resolve, reject }
      },
    })
  } catch {
    // Promise 被冻结时保留原状；调用方会得到明确的 browser_unsupported。
  }
}

/**
 * legacy 构建自带 core-js 的 Promise.try 补丁；这里再兜底一次，避免
 * 个别打包环境裁剪 core-js 后 worker 在消息循环里静默卡死。
 */
if (typeof promiseConstructor.try !== "function") {
  try {
    Object.defineProperty(promiseConstructor, "try", {
      configurable: true,
      writable: true,
      value: function tryPromise<T>(
        callback: (...args: unknown[]) => T,
        ...args: unknown[]
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          resolve(callback(...args))
        })
      },
    })
  } catch {
    // 同上。
  }
}

export {}
