#!/usr/bin/env node

/**
 * 阶段5.1–5.4 浏览器数据层 E2E：
 * - CacheStorage/IndexedDB 三层缓存、PDF 206 块、generation 清理
 * - 设置页缓存用量/清理不删进度 outbox/设备偏好
 * - 进度 outbox 多标签 Web Locks/BroadcastChannel、离线读缓存
 *
 * 不依赖真实 Go 服务或阅读引擎，只启动 Vite 开发服务器，
 * 在页面内动态加载 TS 模块验证浏览器 API。
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const CHROME_PATH = process.env.CHROME_PATH || undefined
const PREFERRED_PORT = Number(process.env.IREAD_CACHE_E2E_PORT ?? "18086")

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await portFree(port)) {
      return port
    }
  }
  throw new Error("找不到空闲端口")
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // 继续等待。
    }
    await sleep(200)
  }
  throw new Error(`等待 ${url} 超时`)
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString()
  })
  return { child, output: () => output }
}

function stopProcess(processInfo) {
  if (processInfo === null) {
    return
  }
  try {
    if (process.platform !== "win32" && processInfo.child.pid) {
      process.kill(-processInfo.child.pid, "SIGTERM")
    } else {
      processInfo.child.kill("SIGTERM")
    }
  } catch {
    // 已退出。
  }
}

async function evaluate(page, fn, arg) {
  return page.evaluate(fn, arg)
}

async function resetBrowserState(page) {
  await evaluate(page, async () => {
    for (const name of await caches.keys()) {
      await caches.delete(name)
    }
    for (const name of ["iread-reader-cache", "iread-progress-v1"]) {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      })
    }
    localStorage.clear()
    sessionStorage.clear()
  })
}

async function main() {
  const port = (await portFree(PREFERRED_PORT))
    ? PREFERRED_PORT
    : await findFreePort(PREFERRED_PORT + 10)
  const base = `http://127.0.0.1:${port}`
  const server = startProcess(
    "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        IREAD_DEV_API: "http://127.0.0.1:9",
      },
    },
  )
  let browser = null
  const cleanup = []
  try {
    await waitForHttp(`${base}/`, 60_000)
    console.log(`[E2E] Vite 开发服务器 ${base}`)

    browser = await chromium.launch({
      headless: true,
      executablePath: CHROME_PATH,
      args: ["--no-sandbox"],
    })
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width: 1200, height: 820 },
      locale: "zh-CN",
      serviceWorkers: "block",
    })
    cleanup.push(() => context.close())
    const page = await context.newPage()
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`[browser console] ${message.text()}`)
      }
    })
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message}`)
    })
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" })
    await resetBrowserState(page)

    logStep("CacheStorage/IndexedDB：EPUB 资源、PDF 206 块、manifest")
    const cacheResult = await evaluate(page, async () => {
      const {
        CONTENT_CACHE_NAME,
        PDF_CHUNK_SIZE,
        ReaderPersistentCache,
      } = await import("/src/features/reader/cache/persistent-cache.ts")
      const {
        epubChapterKey,
        pdfRangeKey,
      } = await import("/src/features/reader/cache/resource-key.ts")
      const cache = new ReaderPersistentCache({ tier: "mobile" })
      await cache.open()
      const generation = await cache.currentGeneration()
      const chapterKey = epubChapterKey(
        "book-cache",
        "v".repeat(64),
        "chapter-1",
        "OEBPS/chapter1.xhtml",
      )
      const write = await cache.writeResource({
        key: chapterKey,
        blob: new Blob(["<html>cache me</html>"], {
          type: "application/xhtml+xml",
        }),
        mediaType: "application/xhtml+xml",
        generation,
      })
      const read = await cache.readResource(chapterKey)
      const text = read === null ? null : await read.blob.text()

      const pdfKey = pdfRangeKey("book-pdf", "p".repeat(64), 0, PDF_CHUNK_SIZE - 1)
      const chunk = new Uint8Array(PDF_CHUNK_SIZE)
      chunk[0] = 0x25
      chunk[1] = 0x50
      chunk[2] = 0x44
      chunk[3] = 0x46
      const pdfWrite = await cache.writePdfChunk({
        key: pdfKey,
        range: { start: 0, end: PDF_CHUNK_SIZE - 1 },
        bytes: chunk,
        status: 206,
        totalBytes: 300_000,
        contentType: "application/pdf",
        etag: "etag-1",
        generation,
      })
      const pdfRead = await cache.readPdfChunk(pdfKey)
      const fullResponse = await cache.writePdfChunk({
        key: pdfRangeKey("book-pdf", "p".repeat(64), PDF_CHUNK_SIZE, PDF_CHUNK_SIZE * 2 - 1),
        range: { start: PDF_CHUNK_SIZE, end: PDF_CHUNK_SIZE * 2 - 1 },
        bytes: new Uint8Array(PDF_CHUNK_SIZE),
        status: 200,
        generation,
      })
      const oversized = await cache.writePdfChunk({
        key: pdfRangeKey("book-pdf", "p".repeat(64), 0, PDF_CHUNK_SIZE),
        range: { start: 0, end: PDF_CHUNK_SIZE },
        bytes: new Uint8Array(PDF_CHUNK_SIZE + 1),
        status: 206,
        generation,
      })

      const manifest = await cache.writeManifest({
        bookId: "book-cache",
        fileVersion: "v".repeat(64),
        format: "epub",
        manifest: { schemaVersion: 1, spine: [1, 2, 3] },
        generation,
      })
      const manifestRead = await cache.readManifest(
        "book-cache",
        "v".repeat(64),
      )
      const manifestOldVersion = await cache.readManifest(
        "book-cache",
        "o".repeat(64),
      )
      await cache.writeManifest({
        bookId: "book-manifest-2",
        fileVersion: "v".repeat(64),
        format: "epub",
        manifest: { schemaVersion: 1, spine: [4] },
        generation,
      })

      const cacheNames = await caches.keys()
      const contentCache = await caches.open(CONTENT_CACHE_NAME)
      const contentKeys = (await contentCache.keys()).length
      const usage = await cache.usage()
      cache.close()
      return {
        write,
        text,
        pdfWrite,
        pdfRead,
        fullResponse,
        oversized,
        manifest,
        manifestRead,
        manifestOldVersion,
        cacheNames,
        contentKeys,
        usage,
        pdfChunkSize: PDF_CHUNK_SIZE,
      }
    })
    assert.equal(cacheResult.write.stored, true)
    assert.equal(cacheResult.text, "<html>cache me</html>")
    assert.ok(cacheResult.contentKeys >= 1)
    assert.equal(cacheResult.pdfWrite.stored, true)
    assert.equal(cacheResult.pdfRead?.bytes.length, cacheResult.pdfChunkSize)
    assert.equal(cacheResult.pdfRead?.bytes[0], 0x25)
    assert.equal(cacheResult.pdfRead?.totalBytes, 300_000)
    assert.equal(cacheResult.fullResponse.stored, false)
    assert.equal(cacheResult.fullResponse.reason, "not-partial-response")
    assert.equal(cacheResult.oversized.stored, false)
    assert.equal(cacheResult.oversized.reason, "invalid-chunk")
    assert.equal(cacheResult.manifest.stored, true)
    assert.deepEqual(cacheResult.manifestRead, {
      schemaVersion: 1,
      spine: [1, 2, 3],
    })
    assert.equal(cacheResult.manifestOldVersion, null)
    assert.ok(
      cacheResult.cacheNames.some((name) =>
        name.startsWith("iread-content-"),
      ),
    )
    assert.ok(cacheResult.usage.content.bytes > 0)
    assert.ok(cacheResult.usage.pdfChunks.bytes > 0)
    assert.ok(cacheResult.usage.manifests.bytes > 0)
    console.log(
      `[E2E] content=${cacheResult.usage.content.bytes}B pdf=${cacheResult.usage.pdfChunks.bytes}B manifest=${cacheResult.usage.manifests.bytes}B`,
    )

    logStep("cacheGeneration：清理后旧任务不回填，进度 outbox/偏好保留")
    const generationResult = await evaluate(page, async () => {
      const {
        ReaderPersistentCache,
      } = await import("/src/features/reader/cache/persistent-cache.ts")
      const {
        clearReaderContentCaches,
        getReaderCacheUsage,
      } = await import("/src/features/reader/cache/cache-admin.ts")
      const {
        epubChapterKey,
      } = await import("/src/features/reader/cache/resource-key.ts")
      const {
        ReaderProgressStore,
      } = await import("/src/features/reader/session/progress-store.ts")

      const progressStore = new ReaderProgressStore()
      await progressStore.open()
      await progressStore.saveLocal({
        bookId: "book-progress",
        fileVersion: "v".repeat(64),
        format: "epub",
        locator: {
          locatorType: "epub-cfi",
          locatorPayload: {
            locatorVersion: 1,
            spineIndex: 1,
            resourceId: "r1",
            href: "chapter1.xhtml",
            cfi: "epubcfi(/6/4!/4/2)",
            chapterProgress: 0.2,
            textQuote: null,
          },
          progressPercent: 22,
        },
        mutationId: "mutation-keep",
      })
      localStorage.setItem(
        "iread.device-preferences.v1",
        JSON.stringify({ schemaVersion: 1, preloadProfile: "fast" }),
      )

      const cache = new ReaderPersistentCache({ tier: "mobile" })
      await cache.open()
      const key = epubChapterKey(
        "book-cache",
        "v".repeat(64),
        "chapter-2",
      )
      const staleGeneration = await cache.currentGeneration()
      await cache.writeResource({
        key,
        blob: new Blob(["old generation"]),
        mediaType: "text/html",
        generation: staleGeneration,
      })
      const advanced = await cache.advanceGeneration()
      const staleRead = await cache.readResource(key)
      const staleWrite = await cache.writeResource({
        key,
        blob: new Blob(["late"]),
        mediaType: "text/html",
        generation: staleGeneration,
      })
      const clear = await clearReaderContentCaches({
        persistent: cache,
        freeze: () => undefined,
        reason: "settings",
      })
      const usageAfter = await getReaderCacheUsage({
        persistent: cache,
      })
      const keptSnapshot = await progressStore.getSnapshot("book-progress")
      const keptOutbox = await progressStore.getOutbox("book-progress")
      const keptPreference = localStorage.getItem(
        "iread.device-preferences.v1",
      )
      const progressDatabases =
        (await indexedDB.databases?.()) ?? []
      progressStore.close()
      cache.close()
      return {
        staleGeneration,
        advanced,
        staleRead,
        staleWrite,
        clear,
        usageAfter,
        keptSnapshot,
        keptOutbox,
        keptPreference,
        progressDatabases,
      }
    })
    assert.equal(generationResult.advanced, generationResult.staleGeneration + 1)
    assert.equal(generationResult.staleRead, null)
    assert.equal(generationResult.staleWrite.stored, false)
    assert.equal(generationResult.staleWrite.reason, "stale-generation")
    assert.equal(generationResult.clear.ok, true)
    assert.equal(generationResult.usageAfter.content.entries, 0)
    assert.equal(generationResult.usageAfter.pdfChunks.entries, 0)
    assert.equal(generationResult.usageAfter.manifests.entries, 0)
    assert.ok(generationResult.usageAfter.estimate !== null)
    assert.equal(generationResult.usageAfter.estimateIsApproximate, true)
    assert.equal(generationResult.keptSnapshot?.progressPercent, 22)
    assert.equal(generationResult.keptOutbox?.pending?.mutationId, "mutation-keep")
    assert.ok(
      JSON.parse(generationResult.keptPreference ?? "{}").preloadProfile ===
        "fast",
    )
    assert.ok(
      generationResult.progressDatabases.some(
        (database) => database.name === "iread-progress-v1",
      ),
    )
    console.log(
      `[E2E] 清理 generation=${generationResult.clear.generation} bytes=${generationResult.clear.clearedBytes}`,
    )

    logStep("离线：清空网络后仍能从 L3 读取已缓存章节")
    const offlineKey = await evaluate(page, async () => {
      const {
        ReaderPersistentCache,
      } = await import("/src/features/reader/cache/persistent-cache.ts")
      const {
        epubChapterKey,
      } = await import("/src/features/reader/cache/resource-key.ts")
      const cache = new ReaderPersistentCache()
      await cache.open()
      const generation = await cache.currentGeneration()
      const key = epubChapterKey("book-offline", "v".repeat(64), "r1")
      await cache.writeResource({
        key,
        blob: new Blob(["offline chapter"]),
        mediaType: "text/html",
        generation,
      })
      cache.close()
      return key
    })
    await context.setOffline(true)
    const offlineText = await evaluate(page, async (key) => {
      const {
        ReaderPersistentCache,
      } = await import("/src/features/reader/cache/persistent-cache.ts")
      const cache = new ReaderPersistentCache()
      await cache.open()
      const entry = await cache.readResource(key)
      cache.close()
      return entry === null ? null : await entry.blob.text()
    }, offlineKey)
    await context.setOffline(false)
    assert.equal(offlineText, "offline chapter")

    logStep("多标签：Web Locks 跳过重复 PUT，BroadcastChannel 通知")
    const pageA = await context.newPage()
    const pageB = await context.newPage()
    await Promise.all([
      pageA.goto(`${base}/`, { waitUntil: "domcontentloaded" }),
      pageB.goto(`${base}/`, { waitUntil: "domcontentloaded" }),
    ])
    await Promise.all([resetBrowserState(pageA), resetBrowserState(pageB)])
    // 两个标签共享同一 origin 存储，reset 只需执行一次即可。
    await evaluate(pageA, async () => {
      const {
        ReaderProgressSync,
      } = await import("/src/features/reader/session/progress-outbox.ts")
      const {
        ReaderProgressStore,
      } = await import("/src/features/reader/session/progress-store.ts")
      const store = new ReaderProgressStore()
      const release = {}
      release.promise = new Promise((resolve) => {
        release.resolve = resolve
      })
      const calls = []
      const transport = {
        async put(input) {
          calls.push(input)
          await release.promise
          return {
            schemaVersion: 1,
            bookId: input.bookId,
            fileVersion: input.fileVersion,
            format: input.format,
            locatorType: input.locatorType,
            locatorPayload: input.locatorPayload,
            progressPercent: input.progressPercent,
            updatedAt: new Date().toISOString(),
            revision: "1",
          }
        },
        async fetch() {
          return null
        },
      }
      const sync = new ReaderProgressSync({
        store,
        transport,
        locks: navigator.locks,
        channel: new BroadcastChannel("iread-progress-v1"),
        lifecycleTarget: null,
        onlineTarget: null,
        throttleMs: 10,
      })
      await sync.open({ bindLifecycle: false })
      window.__cacheTestA = { sync, store, calls, release }
    })
    await evaluate(pageB, async () => {
      const {
        ReaderProgressSync,
      } = await import("/src/features/reader/session/progress-outbox.ts")
      const {
        ReaderProgressStore,
      } = await import("/src/features/reader/session/progress-store.ts")
      const store = new ReaderProgressStore()
      const events = []
      const sync = new ReaderProgressSync({
        store,
        transport: {
          async put(input) {
            return {
              schemaVersion: 1,
              bookId: input.bookId,
              fileVersion: input.fileVersion,
              format: input.format,
              locatorType: input.locatorType,
              locatorPayload: input.locatorPayload,
              progressPercent: input.progressPercent,
              updatedAt: new Date().toISOString(),
              revision: "1",
            }
          },
          async fetch() {
            return null
          },
        },
        locks: navigator.locks,
        channel: new BroadcastChannel("iread-progress-v1"),
        lifecycleTarget: null,
        onlineTarget: null,
        onEvent: (event) => events.push(event),
      })
      await sync.open({ bindLifecycle: false })
      window.__cacheTestB = { sync, store, events }
    })
    await evaluate(pageA, async () => {
      const locator = {
        locatorType: "epub-cfi",
        locatorPayload: {
          locatorVersion: 1,
          spineIndex: 1,
          resourceId: "r1",
          href: "chapter1.xhtml",
          cfi: "epubcfi(/6/4!/4/2)",
          chapterProgress: 0.3,
          textQuote: null,
        },
        progressPercent: 31,
      }
      window.__cacheTestA.recordPromise =
        window.__cacheTestA.sync.record(
          {
            bookId: "book-multitab",
            fileVersion: "v".repeat(64),
            format: "epub",
            locator,
          },
          { mutationId: "multi-1", immediate: true },
        )
    })
    await pageA.waitForFunction(
      () => window.__cacheTestA?.calls.length === 1,
      undefined,
      { timeout: 10_000 },
    )
    const skipped = await evaluate(pageB, async () => {
      return window.__cacheTestB.sync.flushBook("book-multitab")
    })
    assert.equal(skipped.status, "skipped")
    await pageB.waitForFunction(
      () =>
        window.__cacheTestB.events.some(
          (event) => event.type === "remote-change",
        ),
      undefined,
      { timeout: 10_000 },
    )
    const remoteEvents = await evaluate(
      pageB,
      () => window.__cacheTestB.events,
    )
    assert.ok(
      remoteEvents.some(
        (event) =>
          event.type === "remote-change" &&
          event.bookId === "book-multitab",
      ),
    )
    await evaluate(pageA, () => {
      window.__cacheTestA.release.resolve()
      return window.__cacheTestA.recordPromise
    })
    const afterA = await evaluate(pageA, async () => {
      const outbox = await window.__cacheTestA.store.getOutbox(
        "book-multitab",
      )
      window.__cacheTestA.sync.dispose()
      window.__cacheTestA.store.close()
      return outbox
    })
    assert.equal(afterA?.state, "idle")
    await evaluate(pageB, () => {
      window.__cacheTestB.sync.dispose()
      window.__cacheTestB.store.close()
    })
    await pageA.close()
    await pageB.close()

    logStep("L1/L2 与预算常量可在浏览器加载")
    const l1Result = await evaluate(page, async () => {
      const { ReaderMemoryCache } = await import(
        "/src/features/reader/cache/memory-cache.ts"
      )
      const { ReaderRenderCache } = await import(
        "/src/features/reader/cache/render-cache.ts"
      )
      const { detectCacheTier, READER_CACHE_BUDGETS } = await import(
        "/src/features/reader/cache/budgets.ts"
      )
      const memory = new ReaderMemoryCache("mobile")
      memory.set("k", new Blob(["1234"]))
      const render = new ReaderRenderCache("mobile")
      let released = false
      render.register("r", { bitmap: true }, {
        bytes: 10,
        release: () => {
          released = true
        },
      })
      render.clear()
      return {
        tier: detectCacheTier(),
        memoryBytes: memory.stats.bytes,
        released,
        mobileL1: READER_CACHE_BUDGETS.mobile.l1.maxBytes,
      }
    })
    assert.ok(["mobile", "desktop"].includes(l1Result.tier))
    assert.equal(l1Result.memoryBytes, 4)
    assert.equal(l1Result.released, true)
    assert.ok(l1Result.mobileL1 > 0)

    logStep("L3 过期：usage 会清理超过层预算时间的条目")
    const ttlResult = await evaluate(page, async () => {
      const {
        ReaderPersistentCache,
      } = await import("/src/features/reader/cache/persistent-cache.ts")
      const {
        epubChapterKey,
      } = await import("/src/features/reader/cache/resource-key.ts")
      const cache = new ReaderPersistentCache({
        tier: "mobile",
        budget: {
          maxBytes: 10 * 1024 * 1024,
          maxEntries: 10,
          maxAgeMs: 1,
        },
      })
      await cache.open()
      const generation = await cache.currentGeneration()
      await cache.writeResource({
        key: epubChapterKey("book-ttl", "v".repeat(64), "r1"),
        blob: new Blob(["expire me"]),
        mediaType: "text/html",
        generation,
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      const usage = await cache.usage()
      cache.close()
      return usage.content
    })
    assert.equal(ttlResult.entries, 0)
    assert.equal(ttlResult.bytes, 0)

    console.log("\n[E2E] reader-cache 浏览器测试全部通过")
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn()
      } catch {
        // 清理失败不覆盖测试结论。
      }
    }
    if (browser !== null) {
      await browser.close()
    }
    stopProcess(server)
  }
}

main().catch((error) => {
  console.error("\n[E2E] 失败：", error)
  process.exitCode = 1
})
