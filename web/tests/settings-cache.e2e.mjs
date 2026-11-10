#!/usr/bin/env node

/**
 * 阶段5.4/5.6 设置页“缓存与 PWA”真实服务 E2E。
 *
 * 使用临时 IREAD_BOOKS_DIR/DB_DIR/CACHE_DIR 启动真实 Go 服务与生产构建，
 * 覆盖：服务端派生用量 → 清理任务轮询 → 用量变化；CSRF 403 重试；
 * 部分失败范围与重试；原件/书籍/进度/书签/偏好保留；浏览器内容缓存清理；
 * 401 回到登录；移动 390x844 无横向溢出。
 */

import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

import { chromium, request as playwrightRequest } from "playwright"

import {
  AuthedApi,
  E2E_PASSWORD,
  E2EBlocked,
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const SERVER_ROOT = path.resolve(WEB_ROOT, "../server")
const WEB_DIST = path.join(WEB_ROOT, "dist")
const PREFERRED_PORT = Number(process.env.IREAD_SETTINGS_E2E_PORT ?? "18090")
const CHROME_PATH = process.env.CHROME_PATH || undefined

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

function startServer(binary, env, port) {
  const child = spawn(binary, [], {
    env,
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
  child.outputText = () => output
  child.port = port
  return child
}

async function stopServer(child) {
  if (child === undefined || child.exitCode !== null) {
    return
  }
  child.kill("SIGTERM")
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && child.exitCode === null) {
    await sleep(100)
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL")
  }
}

function seedBook(databasePath, dirs, fixture) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    const now = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
         VALUES (?, ?, 'epub', 'ready', 1, ?, ?)`,
      )
      .run(fixture.bookId, fixture.title, now, now)
    database
      .prepare(
        `INSERT INTO book_files (
          book_id, original_file_name, extension, media_type, sha256, byte_size,
          storage_rel_path, created_at
        ) VALUES (?, 'settings-cache.epub', 'epub', 'application/epub+zip', ?, ?, ?, ?)`,
      )
      .run(
        fixture.bookId,
        fixture.fileVersion,
        fixture.original.length,
        fixture.relativePath,
        now,
      )
    database
      .prepare(
        `INSERT INTO book_metadata (book_id, extraction_status, updated_at)
         VALUES (?, 'ok', ?)`,
      )
      .run(fixture.bookId, now)
    database
      .prepare(
        `INSERT INTO reading_progress (
          book_id, file_version, format, locator_type, locator_payload,
          progress_percent, client_mutation_id, revision, updated_at
        ) VALUES (?, ?, 'epub', 'epub-cfi', '{"locatorVersion":1,"spineIndex":4}',
          61.5, 'settings-cache-progress', 2, ?)`,
      )
      .run(fixture.bookId, fixture.fileVersion, now)
    database
      .prepare(
        `INSERT INTO bookmarks (
          bookmark_id, book_id, file_version, format, locator_type, locator_payload,
          locator_key, label, client_mutation_id, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'epub', 'epub-cfi', '{"locatorVersion":1,"spineIndex":4}',
          'settings-cache-locator', '缓存 E2E 书签', 'settings-cache-bookmark', 1, ?, ?)`,
      )
      .run(randomUUID().replaceAll("-", ""), fixture.bookId, fixture.fileVersion, now, now)
    database
      .prepare(
        `INSERT INTO book_reader_overrides (book_id, schema_version, overrides_json, revision, updated_at)
         VALUES (?, 1, '{"reflow":{"fontSize":20}}', 3, ?)`,
      )
      .run(fixture.bookId, now)
  } finally {
    database.close()
  }
}

function writeSeedFiles(dirs, fixture) {
  const originalPath = path.join(dirs.books, fixture.relativePath)
  mkdirSync(path.dirname(originalPath), { recursive: true })
  writeFileSync(originalPath, fixture.original)
  fixture.originalPath = originalPath

  const covers = path.join(dirs.cache, "covers", fixture.bookId, "1")
  const comic = path.join(dirs.cache, "comic", fixture.bookId, fixture.fileVersion)
  mkdirSync(covers, { recursive: true })
  mkdirSync(comic, { recursive: true })
  mkdirSync(path.join(dirs.cache, "keep"), { recursive: true })
  writeFileSync(path.join(covers, "grid.jpg"), Buffer.alloc(101, 0x11))
  writeFileSync(path.join(covers, "detail.jpg"), Buffer.alloc(203, 0x22))
  writeFileSync(path.join(comic, "page-1.jpg"), Buffer.alloc(307, 0x33))
}

async function waitForInnerText(page, testId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let latest = ""
  while (Date.now() < deadline) {
    const locator = page.getByTestId(testId)
    if ((await locator.count()) > 0) {
      latest = await locator.first().innerText()
      if (predicate(latest)) {
        return latest
      }
    }
    await sleep(150)
  }
  throw new Error(`等待 ${testId} 内容超时，最后内容：${latest}`)
}

async function seedBrowserCaches(page) {
  await page.evaluate(async () => {
    const content = await caches.open("iread-content-v1")
    await content.put(
      new Request("/__e2e__/content-resource"),
      new Response(new Blob(["c".repeat(1234)]), {
        headers: { "Content-Type": "text/html" },
      }),
    )
    const pdf = await caches.open("iread-pdf-v1")
    await pdf.put(
      new Request("/__e2e__/pdf-resource"),
      new Response(new Blob(["p".repeat(2048)]), {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    )
    const shell = await caches.open("workbox-precache-v2-e2e")
    await shell.put(
      new Request("/__e2e__/shell"),
      new Response("shell", { headers: { "Content-Type": "text/plain" } }),
    )
    window.localStorage.setItem(
      "iread.device-preferences.v1",
      JSON.stringify({ schemaVersion: 1, preloadProfile: "balanced" }),
    )

    await new Promise((resolve, reject) => {
      const request = indexedDB.open("iread-progress-v1", 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains("progressSnapshots")) {
          const store = database.createObjectStore("progressSnapshots", {
            keyPath: "bookId",
          })
          store.createIndex("updatedAt", "updatedAt")
        }
        if (!database.objectStoreNames.contains("progressOutbox")) {
          const store = database.createObjectStore("progressOutbox", {
            keyPath: "bookId",
          })
          store.createIndex("state", "state")
        }
      }
      request.onsuccess = () => {
        const database = request.result
        const tx = database.transaction("progressOutbox", "readwrite")
        tx.objectStore("progressOutbox").put({
          bookId: "settings-cache-e2e-book",
          pending: null,
          queued: null,
          inFlight: null,
          state: "pending",
          attemptCount: 1,
          lastError: "",
          conflict: null,
          updatedAt: new Date().toISOString(),
        })
        tx.oncomplete = () => {
          database.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      request.onerror = () => reject(request.error)
    })
  })
}

async function readBrowserCacheState(page) {
  return page.evaluate(async () => {
    const names = await caches.keys()
    const managed = names.filter(
      (name) =>
        name.startsWith("iread-content-") || name.startsWith("iread-pdf-"),
    )
    const shell = await caches.open("workbox-precache-v2-e2e")
    const shellEntry = await shell.match("/__e2e__/shell")
    const outbox = await new Promise((resolve, reject) => {
      const request = indexedDB.open("iread-progress-v1")
      request.onsuccess = () => {
        const database = request.result
        if (!database.objectStoreNames.contains("progressOutbox")) {
          database.close()
          resolve([])
          return
        }
        const tx = database.transaction("progressOutbox", "readonly")
        const getAll = tx.objectStore("progressOutbox").getAll()
        getAll.onsuccess = () => {
          database.close()
          resolve(getAll.result)
        }
        getAll.onerror = () => reject(getAll.error)
      }
      request.onerror = () => reject(request.error)
    })
    return {
      names,
      managed,
      shellEntry: Boolean(shellEntry),
      outboxCount: outbox.length,
      devicePreferences: window.localStorage.getItem(
        "iread.device-preferences.v1",
      ),
    }
  })
}

async function main() {
  const browser = await browserPromise
  const tempRoot = mkdtempSync(path.join(tmpdir(), "iread-settings-cache-e2e-"))
  const dirs = {
    books: path.join(tempRoot, "books"),
    db: path.join(tempRoot, "db"),
    cache: path.join(tempRoot, "cache"),
  }
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true })
  }

  const original = Buffer.from("settings-cache-e2e-original-must-survive")
  const fileVersion = createHash("sha256").update(original).digest("hex")
  const fixture = {
    bookId: randomUUID().replaceAll("-", ""),
    title: "缓存/清理保留 E2E",
    original,
    fileVersion,
    relativePath: `settings-cache-e2e/${fixtureVersionSafe(fileVersion)}.epub`,
  }

  const binary = path.join(tempRoot, "iread-e2e")
  let server
  const contexts = []
  const apiContexts = []
  let coversDir = path.join(dirs.cache, "covers")

  try {
    logStep("构建并启动真实 Go 服务（临时图书/数据库/缓存目录）")
    execFileSync("go", ["build", "-o", binary, "./cmd/iread"], {
      cwd: SERVER_ROOT,
      env: { ...process.env, GOFLAGS: "-buildvcs=false" },
      stdio: "inherit",
    })
    if (!readFileSync(path.join(WEB_DIST, "index.html"), "utf8").includes("iRead")) {
      throw new E2EBlocked("web/dist 不是最新构建，请先执行 pnpm build。")
    }

    const port = await findFreePort(PREFERRED_PORT)
    const baseUrl = `http://127.0.0.1:${port}`
    server = startServer(
      binary,
      {
        ...process.env,
        IREAD_ADDR: `127.0.0.1:${port}`,
        IREAD_BOOKS_DIR: dirs.books,
        IREAD_DB_DIR: dirs.db,
        IREAD_CACHE_DIR: dirs.cache,
        IREAD_WEB_DIR: WEB_DIST,
        IREAD_PUBLIC_ORIGIN: baseUrl,
        IREAD_LOG_LEVEL: "error",
        IREAD_LOG_FORMAT: "text",
      },
      port,
    )
    try {
      await waitForHttp(`${baseUrl}/healthz`, 20000)
    } catch (error) {
      throw new E2EBlocked(
        `服务未就绪：${error.message}\n${server.outputText()}`,
      )
    }

    const probe = await playwrightRequest.newContext({ baseURL: baseUrl })
    apiContexts.push(probe)
    const probeApi = new AuthedApi(probe, baseUrl)
    await ensureAdmin(probeApi, baseUrl)

    logStep("写入真实书籍/原件/进度/书签/单书偏好与派生缓存文件")
    writeSeedFiles(dirs, fixture)
    seedBook(path.join(dirs.db, "iread.db"), dirs, fixture)
    coversDir = path.join(dirs.cache, "covers")

    const usageBefore = await probeApi.get("/api/v1/cache/usage")
    assert.equal(usageBefore.status, 200, `usage 应 200：${JSON.stringify(usageBefore.payload)}`)
    assert.equal(usageBefore.payload.data.derivedBytes, 611)
    assert.equal(usageBefore.payload.data.entries, 3)
    assert.equal(usageBefore.payload.data.byKind.covers.entries, 2)
    assert.equal(usageBefore.payload.data.byKind.comic.entries, 1)

    const bookBefore = await probeApi.get(`/api/v1/books/${fixture.bookId}`)
    assert.equal(bookBefore.status, 200)
    assert.equal(bookBefore.payload.data.title, fixture.title)
    const progressBefore = await probeApi.get(`/api/v1/books/${fixture.bookId}/progress`)
    assert.equal(progressBefore.status, 200)
    assert.equal(progressBefore.payload.data.progressPercent, 61.5)
    const bookmarksBefore = await probeApi.get(`/api/v1/books/${fixture.bookId}/bookmarks`)
    assert.equal(bookmarksBefore.status, 200)
    assert.ok(
      bookmarksBefore.payload.data.some(
        (item) => item.label === "缓存 E2E 书签",
      ),
      "书签应在清理前存在",
    )
    const appearanceBefore = await probeApi.get("/api/v1/settings/appearance")
    assert.equal(appearanceBefore.status, 200)
    const readerSettingsBefore = await probeApi.get(
      `/api/v1/books/${fixture.bookId}/reader-settings`,
    )
    assert.equal(readerSettingsBefore.status, 200)
    assert.ok(JSON.stringify(readerSettingsBefore.payload).includes('"fontSize":20'))

    logStep("登录并进入设置页缓存与 PWA 分组")
    const storageState = await createAuthenticatedStorageState(
      browser,
      baseUrl,
      E2E_PASSWORD,
    )
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(context)
    const page = await context.newPage()
    page.on("pageerror", (error) => {
      console.error("[E2E][pageerror]", error)
    })
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
    await seedBrowserCaches(page)
    await page.goto(`${baseUrl}/settings?group=cache`, {
      waitUntil: "domcontentloaded",
    })
    await page.getByRole("heading", { level: 2, name: "服务端派生缓存" }).waitFor({ timeout: 10000 })
    await waitForInnerText(page, "server-cache-usage", (text) => text.includes("611 B"))
    await waitForInnerText(page, "browser-cache-usage", (text) => text.includes("3.21 KB"))
    assert.match(
      await page.getByTestId("server-cache-usage").innerText(),
      /3 条/,
    )
    assert.match(
      await page.getByTestId("browser-cache-usage").innerText(),
      /2 条/,
    )
    await page.getByText("有 1 条阅读进度尚未同步").first().waitFor({ timeout: 10000 })
    await waitForInnerText(page, "pwa-status", (text) => text.includes("已注册"))
    assert.equal(
      await page.getByRole("button", { name: /安装/ }).count(),
      0,
      "不应显示无法验证的安装按钮",
    )
    assert.ok(
      await page.getByText("不删除原件、阅读进度、阅读偏好、书签或全局设置").first().isVisible(),
      "清理边界说明应可见",
    )
    assert.ok(
      await page.getByRole("heading", { name: "iPhone / iPad（Safari）" }).isVisible(),
    )
    assert.ok(
      await page.getByRole("heading", { name: "Android（Chrome / Edge）" }).isVisible(),
    )

    logStep("CSRF 403 重试 + 部分失败范围 + 重试成功")
    const restrictedCoverDir = path.join(coversDir, fixture.bookId, "1")
    execFileSync("chmod", ["500", restrictedCoverDir])
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window)
      window.__cacheClearPosts = []
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url
        if (url.includes("/api/v1/cache/clear") && init.method === "POST") {
          window.__cacheClearPosts.push(url)
          if (window.__cacheClearPosts.length === 1) {
            const headers = new Headers(init.headers || {})
            headers.delete("X-CSRF-Token")
            return originalFetch(input, { ...init, headers })
          }
        }
        return originalFetch(input, init)
      }
    })
    await page.getByRole("button", { name: "清理服务端阅读缓存" }).click()
    await page
      .getByRole("alertdialog")
      .getByText("只删除可重建的封面与漫画页派生缓存")
      .waitFor({ timeout: 5000 })
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "确认清理" })
      .click()
    await page.getByText("服务端缓存清理未完成").waitFor({ timeout: 20000 })
    const postCount = await page.evaluate(() => window.__cacheClearPosts.length)
    assert.equal(postCount, 2, "CSRF 403 后应重取令牌并只重试一次")
    await page.getByText("影响范围：封面缓存（covers）与漫画页缓存（comic）").waitFor()
    await waitForInnerText(page, "server-cache-usage", (text) => text.includes("304 B"))

    execFileSync("chmod", ["755", restrictedCoverDir])
    await page.getByRole("button", { name: "重试清理" }).first().click()
    await waitForInnerText(page, "server-cache-usage", (text) => text.includes("0 B"))
    await page.getByText("暂无服务端派生缓存").waitFor({ timeout: 10000 })
    const usageAfter = await probeApi.get("/api/v1/cache/usage")
    assert.equal(usageAfter.payload.data.derivedBytes, 0)
    assert.equal(usageAfter.payload.data.entries, 0)

    logStep("清理后核对原件/书籍/进度/书签/偏好保留")
    assert.deepEqual(readFileSync(fixture.originalPath), original)
    const bookAfter = await probeApi.get(`/api/v1/books/${fixture.bookId}`)
    assert.equal(bookAfter.status, 200)
    assert.equal(bookAfter.payload.data.title, fixture.title)
    const progressAfter = await probeApi.get(`/api/v1/books/${fixture.bookId}/progress`)
    assert.equal(progressAfter.payload.data.progressPercent, 61.5)
    assert.equal(progressAfter.payload.data.revision, progressBefore.payload.data.revision)
    const bookmarksAfter = await probeApi.get(`/api/v1/books/${fixture.bookId}/bookmarks`)
    assert.equal(bookmarksAfter.payload.data.length, bookmarksBefore.payload.data.length)
    const appearanceAfter = await probeApi.get("/api/v1/settings/appearance")
    assert.deepEqual(appearanceAfter.payload, appearanceBefore.payload)
    const readerSettingsAfter = await probeApi.get(
      `/api/v1/books/${fixture.bookId}/reader-settings`,
    )
    assert.deepEqual(readerSettingsAfter.payload, readerSettingsBefore.payload)

    logStep("浏览器阅读缓存：精确用量 → 清理 → Shell/进度/偏好保留")
    await page.getByTestId("browser-cache-clear").click()
    await page
      .getByRole("alertdialog")
      .getByText("不会清除应用外壳（Shell precache）、进度 outbox 或设备预加载偏好")
      .waitFor({ timeout: 5000 })
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "确认清理" })
      .click()
    await page.getByTestId("browser-cache-result").waitFor({ timeout: 15000 })
    await page.getByText("本机阅读缓存已清理").waitFor()
    await waitForInnerText(page, "browser-cache-usage", (text) => text.includes("0 B"))
    await page.getByText("本机暂无阅读内容缓存").waitFor()
    const clientState = await readBrowserCacheState(page)
    assert.deepEqual(clientState.managed, [], "受管内容缓存应已删除")
    assert.equal(clientState.shellEntry, true, "Shell precache 不得被清理")
    assert.equal(clientState.outboxCount, 1, "进度 outbox 不得被清理")
    assert.ok(clientState.devicePreferences?.includes('"balanced"'))

    logStep("移动 390x844：无横向溢出与可用触控区")
    const mobileContext = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      storageState,
      isMobile: true,
      hasTouch: true,
    })
    contexts.push(mobileContext)
    const mobilePage = await mobileContext.newPage()
    await mobilePage.goto(`${baseUrl}/settings?group=cache`, {
      waitUntil: "domcontentloaded",
    })
    await mobilePage.getByRole("heading", { level: 2, name: "服务端派生缓存" }).waitFor({ timeout: 10000 })
    const overflow = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    assert.ok(overflow <= 1, `移动端横向溢出 ${overflow}px`)
    const buttons = mobilePage.locator('.iread-cache-panel [data-slot="button"]:visible')
    const buttonCount = await buttons.count()
    assert.ok(buttonCount >= 4, `缓存面板按钮应可见，实际 ${buttonCount}`)
    for (let index = 0; index < buttonCount; index += 1) {
      const box = await buttons.nth(index).boundingBox()
      assert.ok(box !== null && box.width > 0, "按钮必须有可点击区域")
      assert.ok(box.height >= 40, `按钮触控高度不足：${box.height}`)
    }

    logStep("会话失效 401：设置页回到登录")
    const logoutStatus = await page.evaluate(async () => {
      const status = await (await fetch("/api/v1/auth/status")).json()
      return (
        await fetch("/api/v1/auth/logout", {
          method: "POST",
          headers: {
            "X-CSRF-Token": status.data.csrfToken,
          },
          credentials: "same-origin",
        })
      ).status
    })
    assert.equal(logoutStatus, 204)
    await page.getByRole("button", { name: "刷新用量" }).click()
    await page.getByRole("heading", { level: 1, name: "登录 iRead" }).waitFor({
      timeout: 10000,
    })

    logStep("通过")
    console.log("[E2E] 设置页缓存与 PWA 全部断言通过")
  } finally {
    try {
      execFileSync("chmod", ["-R", "755", coversDir], { stdio: "ignore" })
    } catch {
      // 临时目录可能已被移除。
    }
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      await context.dispose().catch(() => {})
    }
    await stopServer(server)
    await browser.close().catch(() => {})
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function fixtureVersionSafe(value) {
  return value.slice(0, 16)
}

const browserPromise = chromium.launch({
  headless: true,
  executablePath: CHROME_PATH,
  args: ["--no-sandbox"],
})

main().catch(async (error) => {
  const browser = await browserPromise.catch(() => null)
  if (browser !== null) {
    await browser.close().catch(() => {})
  }
  console.error(error)
  process.exit(1)
})
