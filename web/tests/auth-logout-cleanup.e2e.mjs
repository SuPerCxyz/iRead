#!/usr/bin/env node

// 退出登录清理浏览器验收：使用 web/dist 与 mock 认证 API，不启动后端。
// 覆盖显式退出、401 会话失效、清理失败不阻塞退出，以及进度/偏好保留。

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url))
const DIST_DIR = path.join(WEB_DIR, "dist")
const CSRF_TOKEN = "auth-logout-cleanup-csrf"
const CACHE_NAME = "iread-content-e2e"
const UNMANAGED_CACHE = "e2e-unmanaged"
const READER_CACHE_DB = "iread-reader-cache"
const PROGRESS_DB = "iread-progress-v1"
const DEVICE_PREFERENCES_KEY = "iread.device-preferences.v1"
const APPEARANCE_KEY = "iread.appearance.v1"
const SENTINEL_KEY = "iread.e2e.sentinel"

const APPEARANCE_VALUE = {
  themeMode: "system",
  lightPreset: "template",
  darkPreset: "template",
  accent: "default",
  density: "standard",
  contentWidth: "auto",
  navCompact: false,
}

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("无法分配临时端口。"))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, child, timeout = 30000) {
  const deadline = Date.now() + timeout
  let output = ""
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString()
  })
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`vite preview 提前退出：\n${output}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) {
        return
      }
    } catch {
      // 继续等待预览服务。
    }
    await sleep(150)
  }
  throw new Error(`等待 vite preview 超时：\n${output}`)
}

function statusPayload(state) {
  return {
    data: {
      initialized: true,
      authenticated: state.authenticated,
      csrfToken: CSRF_TOKEN,
      csrfExpiresAt: null,
      setupTokenRequired: false,
    },
  }
}

function errorPayload(code, message) {
  return {
    error: {
      code,
      message,
      requestId: "auth-logout-cleanup-e2e",
      details: {},
    },
  }
}

async function mockApi(page, state) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify(errorPayload("not_found", "未 mock 的接口")),
    })
  })

  await page.route("**/api/v1/auth/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusPayload(state)),
    })
  })

  await page.route("**/api/v1/auth/logout", async (route) => {
    state.logoutRequests.push({
      origin: route.request().headers().origin ?? null,
      csrf: route.request().headers()["x-csrf-token"] ?? null,
    })
    if (state.logoutStatus !== 204) {
      await route.fulfill({
        status: state.logoutStatus,
        contentType: "application/json",
        body: JSON.stringify(
          errorPayload("internal_error", "退出接口失败"),
        ),
      })
      return
    }
    state.authenticated = false
    await route.fulfill({ status: 204 })
  })

  await page.route("**/api/v1/settings/appearance", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          schemaVersion: 1,
          revision: "1",
          updatedAt: null,
          value: APPEARANCE_VALUE,
        },
      }),
    })
  })

  await page.route("**/api/v1/books*", async (route) => {
    if (state.booksUnauthorized) {
      state.authenticated = false
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify(
          errorPayload("unauthenticated", "登录状态已失效，请重新登录。"),
        ),
      })
      return
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        meta: { total: 0, nextCursor: null },
      }),
    })
  })
}

async function seedLocalData(page) {
  await page.evaluate(
    async ({ cacheName, unmanagedCache, readerDb, progressDb, deviceKey, appearanceKey, sentinelKey }) => {
      const content = await caches.open(cacheName)
      await content.put(
        "/e2e-content",
        new Response("cached-readable-body", {
          headers: { "Content-Type": "text/plain" },
        }),
      )
      const unmanaged = await caches.open(unmanagedCache)
      await unmanaged.put("/e2e-unmanaged", new Response("keep-me"))

      localStorage.setItem(
        deviceKey,
        JSON.stringify({ tier: "balanced", prefetch: true }),
      )
      localStorage.setItem(
        appearanceKey,
        JSON.stringify({ themeMode: "dark" }),
      )
      localStorage.setItem(sentinelKey, "keep")

      const openDb = (name, upgrade) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 1)
          request.onupgradeneeded = () => {
            upgrade(request.result)
          }
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })

      const readerDbHandle = await openDb(readerDb, (db) => {
        const meta = db.createObjectStore("meta", { keyPath: "key" })
        const contentMeta = db.createObjectStore("contentMeta", {
          keyPath: "key",
        })
        contentMeta.createIndex("lastAccess", "lastAccess")
        contentMeta.createIndex("book", ["bookId", "fileVersion"])
        db.createObjectStore("pdfChunks", { keyPath: "key" }).createIndex(
          "lastAccess",
          "lastAccess",
        )
        db.createObjectStore("manifests", { keyPath: "bookId" }).createIndex(
          "lastAccess",
          "lastAccess",
        )
        meta.put({ key: "cacheGeneration", value: 2 })
      })
      await new Promise((resolve, reject) => {
        const tx = readerDbHandle.transaction(
          ["meta", "contentMeta"],
          "readwrite",
        )
        tx.objectStore("contentMeta").put({
          key: "e2e-resource",
          bookId: "e2e-book",
          fileVersion: "v1",
          kind: "chapter",
          resourceId: "chapter-1",
          mediaType: "text/plain",
          bytes: 20,
          etag: "",
          createdAt: Date.now(),
          lastAccess: Date.now(),
          generation: 2,
        })
        tx.oncomplete = () => {
          readerDbHandle.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      })

      const progressDbHandle = await openDb(progressDb, (db) => {
        db.createObjectStore("progressSnapshots", {
          keyPath: "bookId",
        }).createIndex("updatedAt", "updatedAt")
        db.createObjectStore("progressOutbox", {
          keyPath: "bookId",
        }).createIndex("state", "state")
      })
      await new Promise((resolve, reject) => {
        const tx = progressDbHandle.transaction(
          ["progressSnapshots", "progressOutbox"],
          "readwrite",
        )
        const now = new Date().toISOString()
        tx.objectStore("progressSnapshots").put({
          schemaVersion: 1,
          bookId: "e2e-book",
          fileVersion: "v1",
          format: "epub",
          locatorType: "cfi",
          locatorPayload: { cfi: "epubcfi(/6/2!4)" },
          progressPercent: 42,
          revision: "3",
          updatedAt: now,
          savedAt: now,
          mutationId: null,
          source: "local",
          conflict: null,
        })
        tx.objectStore("progressOutbox").put({
          bookId: "e2e-book",
          pending: {
            mutationId: "e2e-mutation",
            bookId: "e2e-book",
            fileVersion: "v1",
            format: "epub",
            baseRevision: "3",
            locatorType: "cfi",
            locatorPayload: { cfi: "epubcfi(/6/2!4)" },
            progressPercent: 42,
            createdAt: now,
          },
          queued: null,
          inFlight: null,
          state: "pending",
          attemptCount: 0,
          lastError: "",
          conflict: null,
          updatedAt: now,
        })
        tx.oncomplete = () => {
          progressDbHandle.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      })
    },
    {
      cacheName: CACHE_NAME,
      unmanagedCache: UNMANAGED_CACHE,
      readerDb: READER_CACHE_DB,
      progressDb: PROGRESS_DB,
      deviceKey: DEVICE_PREFERENCES_KEY,
      appearanceKey: APPEARANCE_KEY,
      sentinelKey: SENTINEL_KEY,
    },
  )
}

async function readLocalState(page) {
  return page.evaluate(
    async ({ cacheName, unmanagedCache, readerDb, progressDb, deviceKey, appearanceKey, sentinelKey }) => {
      const names = await caches.keys()

      const readCounts = (dbName, stores) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(dbName, 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction(stores, "readonly")
            const counts = {}
            for (const store of stores) {
              const count = tx.objectStore(store).count()
              count.onsuccess = () => {
                counts[store] = count.result
              }
            }
            tx.oncomplete = () => {
              db.close()
              resolve(counts)
            }
            tx.onerror = () => reject(tx.error)
          }
        })

      const readerCounts = await readCounts(readerDb, [
        "meta",
        "contentMeta",
        "pdfChunks",
        "manifests",
      ]).catch(() => null)
      const progressCounts = await readCounts(progressDb, [
        "progressSnapshots",
        "progressOutbox",
      ]).catch(() => null)

      return {
        cacheNames: names,
        hasManagedCache: names.includes(cacheName),
        hasUnmanagedCache: names.includes(unmanagedCache),
        readerCounts,
        progressCounts,
        devicePreferences: localStorage.getItem(deviceKey),
        appearance: localStorage.getItem(appearanceKey),
        sentinel: localStorage.getItem(sentinelKey),
        localDump: JSON.stringify(localStorage),
        sessionDump: JSON.stringify(sessionStorage),
      }
    },
    {
      cacheName: CACHE_NAME,
      unmanagedCache: UNMANAGED_CACHE,
      readerDb: READER_CACHE_DB,
      progressDb: PROGRESS_DB,
      deviceKey: DEVICE_PREFERENCES_KEY,
      appearanceKey: APPEARANCE_KEY,
      sentinelKey: SENTINEL_KEY,
    },
  )
}

async function openAuthenticatedPage(browser, baseUrl, state, initScript) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    serviceWorkers: "block",
  })
  if (initScript !== undefined) {
    await context.addInitScript(initScript)
  }
  const page = await context.newPage()
  await mockApi(page, state)
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
  await page
    .getByRole("heading", { level: 1, name: "首页" })
    .waitFor({ timeout: 15000 })
  return { context, page }
}

async function main() {
  if (!existsSync(path.join(DIST_DIR, "index.html"))) {
    throw new Error("web/dist 不存在，请先运行 pnpm build。")
  }

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const preview = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: WEB_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let browser = null
  const contexts = []
  try {
    await waitForServer(baseUrl, preview)
    browser = await chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        process.env.CHROME_PATH ||
        undefined,
    })

    logStep("显式退出：清理可读缓存，保留进度/设备偏好，不写认证秘密")
    const explicitState = {
      authenticated: true,
      booksUnauthorized: false,
      logoutRequests: [],
      logoutStatus: 204,
    }
    const explicit = await openAuthenticatedPage(
      browser,
      baseUrl,
      explicitState,
    )
    contexts.push(explicit.context)
    await seedLocalData(explicit.page)

    await explicit.page
      .getByRole("button", { name: "退出登录", exact: true })
      .click()
    await explicit.page
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 15000 })

    assert.equal(
      explicitState.logoutRequests.length,
      1,
      "显式退出应调用一次 logout 接口",
    )
    assert.equal(
      explicitState.logoutRequests[0].csrf,
      CSRF_TOKEN,
      "退出请求应携带内存中的 CSRF 令牌",
    )

    const explicitLocal = await readLocalState(explicit.page)
    assert.equal(
      explicitLocal.hasManagedCache,
      false,
      "退出后必须删除 iread-content-* 可读缓存",
    )
    assert.equal(
      explicitLocal.hasUnmanagedCache,
      true,
      "退出不得删除非阅读缓存",
    )
    assert.equal(
      explicitLocal.readerCounts?.contentMeta,
      0,
      "退出必须清空阅读缓存 IndexedDB 内容账本",
    )
    assert.notEqual(
      explicitLocal.readerCounts?.meta,
      0,
      "阅读缓存元数据/代际记录应保留",
    )
    assert.deepEqual(
      explicitLocal.progressCounts,
      { progressSnapshots: 1, progressOutbox: 1 },
      "退出不得删除进度 outbox 或最近位置",
    )
    assert.notEqual(
      explicitLocal.devicePreferences,
      null,
      "退出不得清除设备预加载偏好",
    )
    assert.notEqual(
      explicitLocal.appearance,
      null,
      "退出不得清除外观偏好",
    )
    assert.equal(explicitLocal.sentinel, "keep", "无关 localStorage 应保留")
    assert.equal(
      explicitLocal.localDump.includes(CSRF_TOKEN),
      false,
      "CSRF 令牌不得写入 localStorage",
    )
    assert.equal(
      explicitLocal.sessionDump.includes(CSRF_TOKEN),
      false,
      "CSRF 令牌不得写入 sessionStorage",
    )
    assert.equal(
      explicitLocal.localDump.includes("iread-e2e-password"),
      false,
      "密码不得写入 localStorage",
    )
    console.log("[E2E] 显式退出清理通过")

    logStep("401 会话失效：同样清理可读缓存并保留进度")
    const unauthorizedState = {
      authenticated: true,
      booksUnauthorized: false,
      logoutRequests: [],
      logoutStatus: 204,
    }
    const unauthorized = await openAuthenticatedPage(
      browser,
      baseUrl,
      unauthorizedState,
    )
    contexts.push(unauthorized.context)
    await seedLocalData(unauthorized.page)

    unauthorizedState.booksUnauthorized = true
    await unauthorized.page.reload({ waitUntil: "domcontentloaded" })
    await unauthorized.page
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 15000 })
    await unauthorized.page.waitForFunction(
      async ({ cacheName, readerDb }) => {
        if ((await caches.keys()).includes(cacheName)) {
          return false
        }
        const count = await new Promise((resolve, reject) => {
          const request = indexedDB.open(readerDb, 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction("contentMeta", "readonly")
            const total = tx.objectStore("contentMeta").count()
            total.onsuccess = () => resolve(total.result)
            total.onerror = () => reject(total.error)
            tx.oncomplete = () => db.close()
          }
        })
        return count === 0
      },
      { cacheName: CACHE_NAME, readerDb: READER_CACHE_DB },
      { timeout: 15000 },
    )

    assert.equal(
      unauthorizedState.logoutRequests.length,
      0,
      "401 会话失效不应伪造显式 logout 请求",
    )
    const unauthorizedLocal = await readLocalState(unauthorized.page)
    assert.equal(
      unauthorizedLocal.hasManagedCache,
      false,
      "401 后必须删除 iread-content-* 可读缓存",
    )
    assert.equal(
      unauthorizedLocal.hasUnmanagedCache,
      true,
      "401 不得删除非阅读缓存",
    )
    assert.equal(
      unauthorizedLocal.readerCounts?.contentMeta,
      0,
      "401 后必须清空阅读缓存 IndexedDB 内容账本",
    )
    assert.deepEqual(
      unauthorizedLocal.progressCounts,
      { progressSnapshots: 1, progressOutbox: 1 },
      "401 不得删除进度 outbox 或最近位置",
    )
    assert.notEqual(
      unauthorizedLocal.devicePreferences,
      null,
      "401 不得清除设备预加载偏好",
    )
    assert.notEqual(
      unauthorizedLocal.appearance,
      null,
      "401 不得清除外观偏好",
    )
    console.log("[E2E] 401 会话失效清理通过")

    logStep("清理失败不阻塞退出：仍完成本机退出与登录页切换")
    const failureState = {
      authenticated: true,
      booksUnauthorized: false,
      logoutRequests: [],
      logoutStatus: 204,
    }
    const failure = await openAuthenticatedPage(
      browser,
      baseUrl,
      failureState,
      () => {
        const proto = CacheStorage.prototype
        const descriptor = Object.getOwnPropertyDescriptor(proto, "delete")
        Object.defineProperty(proto, "delete", {
          configurable: true,
          value: async () => {
            throw new Error("e2e cache delete failure")
          },
        })
        window.__ireadRestoreCacheDelete = () => {
          if (descriptor === undefined) {
            delete proto.delete
            return
          }
          Object.defineProperty(proto, "delete", descriptor)
        }
      },
    )
    contexts.push(failure.context)
    await seedLocalData(failure.page)

    await failure.page
      .getByRole("button", { name: "退出登录", exact: true })
      .click()
    await failure.page
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 15000 })

    assert.equal(
      failureState.logoutRequests.length,
      1,
      "缓存清理失败时仍应调用 logout 接口",
    )
    const failureLocal = await readLocalState(failure.page)
    assert.equal(
      failureLocal.hasManagedCache,
      true,
      "注入的删除失败应保留缓存，用于确认失败路径被覆盖",
    )
    assert.deepEqual(
      failureLocal.progressCounts,
      { progressSnapshots: 1, progressOutbox: 1 },
      "清理失败时进度 outbox 仍必须保留",
    )
    assert.notEqual(
      failureLocal.devicePreferences,
      null,
      "清理失败时设备偏好仍必须保留",
    )
    assert.notEqual(
      failureLocal.appearance,
      null,
      "清理失败时外观偏好仍必须保留",
    )
    console.log("[E2E] 清理失败不阻塞退出通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    await browser?.close().catch(() => {})
    preview.kill("SIGTERM")
  }

  console.log("\n[E2E] 退出登录清理浏览器验收全部通过")
}

main().catch((error) => {
  console.error("\n[E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
