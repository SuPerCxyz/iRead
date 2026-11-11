/**
 * PDF.js worker 兼容入口（Vite ?url&no-inline 原样输出为 /assets 资源）。
 *
 * PDF.js 6.5.438 的 worker 仍会无条件调用 Promise.withResolvers()，而
 * worker 是独立全局作用域，主线程补丁不会带进来。真实 worker 与 fake
 * worker 都必须先执行补丁，再加载 pdfjs worker 模块。
 *
 * 用法：
 *   /assets/pdf.worker.compat-<hash>.mjs?src=<encodeURIComponent(worker module URL)>
 *
 * PDF.js 的 fake worker 会 import 同一个 URL 并读取 WorkerMessageHandler
 * 导出；因此这里必须保留具名导出，不能改成纯副作用脚本。
 */

const source = new URL(import.meta.url).searchParams.get("src")
if (source === null || source.length === 0) {
  throw new Error("PDF worker source is missing")
}

if (typeof Promise.withResolvers !== "function") {
  try {
    Object.defineProperty(Promise, "withResolvers", {
      configurable: true,
      writable: true,
      value: function withResolvers() {
        let resolve = () => undefined
        let reject = () => undefined
        const promise = new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise
          reject = rejectPromise
        })
        return { promise, resolve, reject }
      },
    })
  } catch {
    // Promise 被冻结时保留原状，让 PDF.js 抛出可诊断的原始错误。
  }
}

if (typeof Promise.try !== "function") {
  try {
    Object.defineProperty(Promise, "try", {
      configurable: true,
      writable: true,
      value: function tryPromise(callback, ...args) {
        return new Promise((resolve) => {
          resolve(callback(...args))
        })
      },
    })
  } catch {
    // 同上。
  }
}

const worker = await import(source)
const handler =
  worker.WorkerMessageHandler ?? globalThis.pdfjsWorker?.WorkerMessageHandler
if (typeof handler !== "function") {
  throw new Error("PDF worker module did not expose WorkerMessageHandler")
}

export const WorkerMessageHandler = handler
