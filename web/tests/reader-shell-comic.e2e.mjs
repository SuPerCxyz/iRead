#!/usr/bin/env node

/**
 * 真实漫画共享 Shell E2E：
 * 临时 Go 服务 + Vite + 真实 CBZ/CBR 上传，经书库进入 /read/:id，
 * 验证单/双/连续、LTR/RTL、fit、页码跳转、目录、书签创建/跳转/If-Match 删除、
 * 进度保存/浏览器后退恢复/409 冲突选择以及手机 390x844。漫画引擎本身由
 * reader-comic.e2e.mjs 覆盖。
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"

import { chromium, request as playwrightRequest } from "playwright"

import {
  AuthedApi,
  E2E_PASSWORD,
  E2EBlocked,
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
const COMIC_TESTDATA = path.join(
  REPO_ROOT,
  "server/internal/reader/comic/testdata",
)
let serverPort = Number(process.env.IREAD_E2E_SERVER_PORT ?? "18380")
let webPort = Number(process.env.IREAD_E2E_WEB_PORT ?? "18381")
let webBase = `http://127.0.0.1:${webPort}`
let serverBase = `http://127.0.0.1:${serverPort}`
const SCREENSHOT_DIR =
  process.env.READER_SHELL_COMIC_SCREENSHOT_DIR ??
  path.join("/tmp/opencode", "iread-shell-comic-screenshots")
const TEMP_ROOT = process.env.IREAD_E2E_TMP ?? "/tmp/opencode"

const CBZ_PAGE_COUNT = 12
const CBR_PAGE_COUNT = 3

function logStep(name) {
  console.log(`\n[COMIC-SHELL-E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataOf(payload) {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : null
}

function requireData(payload, label) {
  const data = dataOf(payload)
  if (data === null) {
    throw new Error(`${label} 响应缺少 data`)
  }
  return data
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime() {
  const year = 2026
  const date = ((year - 1980) << 9) | (1 << 5) | 1
  return { date, time: 0 }
}

function zipEntries(entries) {
  const localChunks = []
  const centralChunks = []
  let offset = 0
  const { date, time } = dosDateTime()
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data)
    let payload = data
    let method = 0
    if (!entry.store && data.length > 0) {
      const compressed = deflateRawSync(data)
      if (compressed.length < data.length) {
        payload = compressed
        method = 8
      }
    }
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)
    offset += local.length + name.length + payload.length
  }
  const centralSize = centralChunks.reduce(
    (total, chunk) => total + chunk.length,
    0,
  )
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localChunks, ...centralChunks, end])
}

function sample(name) {
  return readFileSync(path.join(COMIC_TESTDATA, name))
}

function makeComicCbz() {
  const page1 = sample("page1.jpg")
  const page2 = sample("page2.jpg")
  const page10 = sample("page10.jpg")
  const huge = sample("huge.png")
  const transparent = sample("transparent.png")
  const entries = []
  for (let page = 1; page <= 9; page += 1) {
    entries.push({
      name: `page${page}.jpg`,
      data: page === 2 ? page2 : page1,
    })
  }
  entries.push({ name: "page10.jpg", data: page10 })
  entries.push({ name: "page11.png", data: huge })
  entries.push({ name: "page12.png", data: transparent })
  return zipEntries(entries)
}

async function httpReachable(target) {
  try {
    const response = await fetch(target, { redirect: "manual" })
    return response.status > 0 && response.status < 500
  } catch {
    return false
  }
}

function portFree(port) {
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
  for (let port = start; port < start + 200; port += 1) {
    if (await portFree(port)) {
      return port
    }
  }
  throw new Error(`无法在 ${start} 起找到空闲端口`)
}

function stopProcess(run) {
  if (run === null || run === undefined) {
    return
  }
  const { child } = run
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM")
    } else {
      child.kill("SIGTERM")
    }
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // 进程已退出。
    }
  }
}

async function waitForHttp(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await httpReachable(target)) {
      return
    }
    await sleep(250)
  }
  throw new Error(`等待 ${target} 超时`)
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

async function ensureServers(cleanup) {
  mkdirSync(TEMP_ROOT, { recursive: true })
  const tempRoot = mkdtempSync(path.join(TEMP_ROOT, "iread-comic-shell-e2e-"))
  const dirs = {
    books: path.join(tempRoot, "books"),
    db: path.join(tempRoot, "db"),
    cache: path.join(tempRoot, "cache"),
  }
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true })
  }
  const staticWebDir = path.join(tempRoot, "web")
  mkdirSync(staticWebDir, { recursive: true })
  writeFileSync(
    path.join(staticWebDir, "index.html"),
    "<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>",
  )
  if (!(await portFree(serverPort))) {
    serverPort = await findFreePort(serverPort + 100)
    serverBase = `http://127.0.0.1:${serverPort}`
  }
  if (!(await portFree(webPort))) {
    webPort = await findFreePort(webPort + 100)
    webBase = `http://127.0.0.1:${webPort}`
  }
  const server = startProcess("go", ["run", "./cmd/iread"], {
    cwd: path.join(REPO_ROOT, "server"),
    env: {
      ...process.env,
      IREAD_ADDR: `127.0.0.1:${serverPort}`,
      IREAD_PUBLIC_ORIGIN: webBase,
      IREAD_BOOKS_DIR: dirs.books,
      IREAD_DB_DIR: dirs.db,
      IREAD_CACHE_DIR: dirs.cache,
      IREAD_WEB_DIR: staticWebDir,
      IREAD_LOG_LEVEL: "warn",
    },
  })
  cleanup.push(() => stopProcess(server))
  await waitForHttp(`${serverBase}/healthz`, 90_000)

  const vite = startProcess(
    "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        IREAD_DEV_API: serverBase,
      },
    },
  )
  cleanup.push(() => stopProcess(vite))
  await waitForHttp(`${webBase}/`, 60_000)
  console.log(
    `[COMIC-SHELL-E2E] 服务 ${serverBase} / ${webBase}，数据 ${tempRoot}`,
  )
  return {
    tempRoot,
    cleanup: () => {
      stopProcess(server)
      stopProcess(vite)
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}

async function uploadComic(
  api,
  fileName,
  data,
  contentType,
  expectedFormat,
) {
  const intentResponse = await api.post("/api/v1/uploads", {
    clientUploadId: `comic-shell-e2e-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
    fileName,
    byteSize: data.length,
  })
  assert.ok(
    intentResponse.status === 200 || intentResponse.status === 201,
    `创建上传意图失败：HTTP ${intentResponse.status} ${JSON.stringify(
      intentResponse.payload,
    )}`,
  )
  const intent = requireData(intentResponse.payload, "上传意图")
  assert.equal(typeof intent.uploadId, "string", "上传意图缺少 uploadId")
  if (api.csrfToken === null) {
    await api.fetchStatus()
  }
  const put = await api.request.fetch(
    `${webBase}/api/v1/uploads/${encodeURIComponent(intent.uploadId)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        Origin: webBase,
        "X-CSRF-Token": api.csrfToken ?? "",
      },
      data,
      failOnStatusCode: false,
    },
  )
  const putPayload = JSON.parse((await put.text()) || "{}")
  assert.equal(
    put.status(),
    200,
    `上传漫画内容失败：HTTP ${put.status()} ${JSON.stringify(putPayload)}`,
  )
  const stored = requireData(putPayload, "上传结果")
  const bookId = stored.bookId ?? stored.duplicateOfBookId
  assert.equal(typeof bookId, "string", "上传结果缺少 bookId")
  let detail = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}`)
    if (response.status === 200) {
      detail = requireData(response.payload, "书籍详情")
      if (detail.status === "ready" || detail.status === "error") {
        break
      }
    }
    await sleep(250)
  }
  assert.ok(detail !== null, `等待书籍 ${bookId} 索引超时`)
  assert.equal(detail.status, "ready", `书籍未就绪：${JSON.stringify(detail)}`)
  const manifestResponse = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/manifest`,
  )
  assert.equal(
    manifestResponse.status,
    200,
    `读取 manifest 失败：HTTP ${manifestResponse.status}`,
  )
  const manifest = requireData(manifestResponse.payload, "manifest")
  assert.equal(manifest.format, expectedFormat, "manifest 格式不符合预期")
  return { bookId, manifest }
}

async function openFromLibrary(page, bookId) {
  await page.goto(`${webBase}/library`, { waitUntil: "domcontentloaded" })
  const card = page.locator(`[data-book-card="${bookId}"]`)
  await card.waitFor({ timeout: 20_000 })
  await card.getByRole("link").click()
  await page.waitForURL(`**/books/${bookId}`, { timeout: 10_000 })
  const readLink = page.getByRole("link", { name: /开始阅读|继续阅读/ })
  await readLink.waitFor({ timeout: 10_000 })
  await readLink.click()
  await page.waitForURL(`**/read/${bookId}`, { timeout: 10_000 })
}

async function waitForComicPage(page, target, timeout = 30_000) {
  try {
    await page.waitForFunction(
      (expected) => {
        const root = document.querySelector(".iread-comic-reader")
        if (!root || root.getAttribute("data-current-page") !== String(expected)) {
          return false
        }
        const slot = root.querySelector(
          `.iread-comic-reader__page[data-page="${expected}"]`,
        )
        const image = slot?.querySelector("img")
        return (
          slot?.getAttribute("data-state") === "ready" &&
          image !== null &&
          image !== undefined &&
          image.complete &&
          image.naturalWidth > 0
        )
      },
      target,
      { timeout },
    )
  } catch (error) {
    const snapshot = await comicSnapshot(page).catch(() => null)
    const text = await page
      .locator(".iread-reader-shell")
      .innerText()
      .catch(() => "")
    console.error(
      `[COMIC-SHELL-E2E] 等待第 ${target} 页超时：${JSON.stringify(snapshot)} text=${text.slice(0, 600)}`,
    )
    throw error
  }
}

async function comicSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".iread-comic-reader")
    const viewport = root?.querySelector(".iread-comic-reader__viewport")
    const pageSlots = root
      ? [...root.querySelectorAll(".iread-comic-reader__page")]
      : []
    const images = root ? [...root.querySelectorAll("img")] : []
    const rootStyle = root ? getComputedStyle(root) : null
    const viewportStyle = viewport ? getComputedStyle(viewport) : null
    const layout = root?.querySelector(
      ".iread-comic-reader__spread, .iread-comic-reader__continuous",
    )
    const layoutStyle = layout ? getComputedStyle(layout) : null
    const imageStyle = images[0] ? getComputedStyle(images[0]) : null
    const shell = document.querySelector(".iread-reader-shell")
    return {
      attributes: root
        ? {
            direction: root.getAttribute("data-direction"),
            mode: root.getAttribute("data-mode"),
            fit: root.getAttribute("data-fit"),
            gap: root.getAttribute("data-gap"),
            background: root.getAttribute("data-background"),
            currentPage: root.getAttribute("data-current-page"),
            pageCount: root.getAttribute("data-page-count"),
            variant: root.getAttribute("data-variant"),
          }
        : null,
      pages: pageSlots.map((slot) => ({
        page: Number(slot.getAttribute("data-page")),
        state: slot.getAttribute("data-state"),
        current: slot.getAttribute("data-current") === "true",
        images: [...slot.querySelectorAll("img")].map((image) => ({
          width: image.width,
          height: image.height,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          variant: image.getAttribute("data-variant"),
          renderedWidth: image.getAttribute("data-rendered-width"),
          renderedHeight: image.getAttribute("data-rendered-height"),
        })),
      })),
      styles: {
        rootOverflow: rootStyle?.overflow ?? null,
        rootBackground: rootStyle?.backgroundColor ?? null,
        viewportJustify: viewportStyle?.justifyContent ?? null,
        imageMaxWidth: imageStyle?.maxWidth ?? null,
        imageDisplay: imageStyle?.display ?? null,
        imageHeight: imageStyle?.height ?? null,
        gap: layoutStyle?.gap ?? null,
      },
      box: shell
        ? {
            width: Math.round(shell.getBoundingClientRect().width),
            height: Math.round(shell.getBoundingClientRect().height),
          }
        : null,
      debug: shell
        ? {
            settingsPending: shell.hasAttribute(
              "data-reader-settings-pending",
            ),
            engineReady: shell.hasAttribute("data-reader-engine-ready"),
            comicHost: document.querySelector("[data-reader-comic]") !== null,
            comicHostChildren:
              document.querySelector("[data-reader-comic]")?.childElementCount ??
              null,
            comicHostConnected:
              document.querySelector("[data-reader-comic]")?.isConnected ??
              null,
            surfaceFormat:
              document
                .querySelector("[data-reader-surface]")
                ?.getAttribute("data-reader-surface-format") ?? null,
          }
        : null,
      position:
        document.querySelector(".iread-reader-shell__position-text")
          ?.textContent ?? null,
      tocEmpty:
        document.querySelector('[data-reader-panel="toc"]')?.textContent ?? null,
    }
  })
}

async function applySetting(page, label, option) {
  await page.getByLabel(label).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

async function openSettings(page) {
  await page.getByRole("button", { name: "阅读设置" }).click()
  const panel = page.locator('[data-reader-panel="settings"]')
  await panel.waitFor({ timeout: 5_000 })
  return panel
}

async function closePanel(page, panel) {
  const closeButton = panel.getByRole("button", {
    name: "关闭面板",
    exact: true,
  })
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click()
  }
  try {
    await panel.waitFor({ state: "hidden", timeout: 1_500 })
    return
  } catch {
    // 下拉框焦点可能吞掉第一次关闭；再点遮罩或按 Esc 兜底。
  }
  const overlay = page
    .locator('[data-slot="sheet-overlay"], [data-slot="drawer-overlay"]')
    .first()
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.click({ position: { x: 5, y: 5 } }).catch(() => {})
  } else {
    await page.keyboard.press("Escape")
  }
  try {
    await panel.waitFor({ state: "hidden", timeout: 2_000 })
  } catch {
    await page.keyboard.press("Escape")
    await panel.waitFor({ state: "hidden" })
  }
}

function comicProgressBody(manifest, page, settings) {
  const total = manifest.formatData.pageCount
  const percent =
    page >= total ? 100 : ((page - 1) / Math.max(1, total - 1)) * 100
  return {
    schemaVersion: 1,
    fileVersion: manifest.fileVersion,
    baseRevision: "0",
    clientMutationId: `comic-shell-progress-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
    format: manifest.format,
    locatorType: "comic-page",
    locatorPayload: {
      locatorVersion: 1,
      page,
      pageOffset: 0,
      direction: settings.direction,
      mode: settings.mode,
      fit: settings.fit,
    },
    progressPercent: percent,
  }
}

async function getProgress(api, bookId) {
  const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}/progress`)
  assert.equal(response.status, 200, `读取进度失败：HTTP ${response.status}`)
  const data = response.payload?.data
  return isRecord(data) ? data : null
}

async function seedProgress(api, manifest, page, settings) {
  const current = await getProgress(api, manifest.bookId)
  const body = comicProgressBody(manifest, page, settings)
  const response = await api.put(
    `/api/v1/books/${encodeURIComponent(manifest.bookId)}/progress`,
    { ...body, baseRevision: current?.revision ?? "0" },
  )
  assert.equal(
    response.status,
    200,
    `写入进度失败：HTTP ${response.status} ${JSON.stringify(response.payload)}`,
  )
  return requireData(response.payload, "进度")
}

async function waitForStoredPage(api, bookId, page, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await getProgress(api, bookId)
    if (last?.locatorType === "comic-page" && last?.locatorPayload?.page === page) {
      return last
    }
    await sleep(150)
  }
  throw new Error(
    `等待进度第 ${page} 页超时，最后进度：${JSON.stringify(last)}`,
  )
}

async function jumpToPage(page, pageNumber) {
  const input = page.locator("#reader-jump-page")
  await input.fill(String(pageNumber))
  await page.waitForTimeout(120)
  await input.press("Enter")
  await page.waitForTimeout(120)
  // 极短视口下 Enter 可能先被布局/焦点消耗；用原生表单提交兜底。
  await page
    .locator("form.iread-reader-shell__jump")
    .evaluate((form) => form.requestSubmit())
}

async function readProgressSnapshot(page, bookId) {
  return page.evaluate(async (targetBookId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("iread-progress-v1", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction("progressSnapshots", "readonly")
        const request = tx.objectStore("progressSnapshots").get(targetBookId)
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => reject(request.error)
      })
      return record
    } finally {
      db.close()
    }
  }, bookId)
}

async function waitForConflictDialog(page, timeout = 20_000) {
  const dialog = page.getByRole("alertdialog")
  await dialog.waitFor({ timeout })
  await page
    .getByText("阅读进度冲突", { exact: true })
    .waitFor({ timeout: 5_000 })
  return dialog
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const cleanup = []
  let servers = null
  let browser = null
  let apiContext = null
  const contexts = []

  try {
    servers = await ensureServers(cleanup)
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--no-sandbox"],
    })
    const storageState = await createAuthenticatedStorageState(
      browser,
      webBase,
      E2E_PASSWORD,
    )
    apiContext = await playwrightRequest.newContext({
      baseURL: webBase,
      storageState,
    })
    const api = new AuthedApi(apiContext, webBase)
    await ensureAdmin(api, webBase, E2E_PASSWORD)

    logStep("上传真实 CBZ 与 CBR")
    const cbz = await uploadComic(
      api,
      `comic-shell-${Date.now()}.cbz`,
      makeComicCbz(),
      "application/vnd.comicbook+zip",
      "cbz",
    )
    assert.equal(cbz.manifest.formatData.pageCount, CBZ_PAGE_COUNT)
    const cbr = await uploadComic(
      api,
      `comic-shell-${Date.now()}.cbr`,
      sample("comic_rar5.rar"),
      "application/vnd.comicbook-rar",
      "cbr",
    )
    assert.equal(cbr.manifest.formatData.pageCount, CBR_PAGE_COUNT)
    console.log(
      `[COMIC-SHELL-E2E] CBZ ${cbz.bookId}(${CBZ_PAGE_COUNT} 页) CBR ${cbr.bookId}(${CBR_PAGE_COUNT} 页)`,
    )

    const desktopContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1200, height: 820 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(desktopContext)
    const page = await desktopContext.newPage()
    const pageErrors = []
    page.on("pageerror", (error) => {
      pageErrors.push(error.stack ?? error.message)
      console.log(`[COMIC-SHELL-E2E][pageerror] ${error.stack ?? error.message}`)
    })
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`[COMIC-SHELL-E2E][browser] ${message.text()}`)
      }
    })

    logStep("从书库进入 CBZ 阅读器，验证单页、工具栏与控制台无错误")
    await openFromLibrary(page, cbz.bookId)
    await waitForComicPage(page, 1)
    let snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.mode, "single")
    assert.equal(snapshot.attributes.direction, "ltr")
    assert.equal(snapshot.attributes.fit, "screen")
    assert.equal(snapshot.attributes.pageCount, String(CBZ_PAGE_COUNT))
    assert.equal(snapshot.styles.rootOverflow, "auto")
    assert.equal(snapshot.styles.imageMaxWidth, "none")
    assert.equal(snapshot.styles.imageDisplay, "block")
    assert.equal(snapshot.box?.width, 1200)
    assert.equal(snapshot.box?.height, 820)
    assert.match(snapshot.position ?? "", /第 1 \/ 12 页/)

    await page.locator("[data-reader-page-next]").click()
    await waitForComicPage(page, 2)
    await page.locator("[data-reader-page-previous]").click()
    await waitForComicPage(page, 1)

    logStep("目录面板与页码跳转")
    await page.getByRole("button", { name: "目录与书签" }).click()
    const tocPanel = page.locator('[data-reader-panel="toc"]')
    await tocPanel.waitFor({ timeout: 5_000 })
    await page.getByText("这本书的清单没有提供目录。", { exact: false }).waitFor()
    await closePanel(page, tocPanel)
    await jumpToPage(page, 5)
    await waitForComicPage(page, 5)
    assert.match((await comicSnapshot(page)).position ?? "", /第 5 \/ 12 页/)

    logStep("漫画设置：RTL、双页、页距与保存到本书")
    let settingsPanel = await openSettings(page)
    assert.equal(
      await settingsPanel.getByRole("tab", { name: "漫画" }).count(),
      1,
    )
    assert.equal(
      await settingsPanel.getByRole("tab", { name: "EPUB 文字" }).count(),
      0,
      "漫画设置不得显示 EPUB 字段",
    )
    await applySetting(page, "阅读方向", "从右到左")
    await applySetting(page, "显示模式", "双页")
    await applySetting(page, "页距", "宽松")
    await page.waitForFunction(() => {
      const root = document.querySelector(".iread-comic-reader")
      return (
        root?.getAttribute("data-direction") === "rtl" &&
        root?.getAttribute("data-mode") === "double" &&
        root?.getAttribute("data-gap") === "relaxed"
      )
    })
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.styles.gap, "24px")
    assert.deepEqual(
      snapshot.pages.map((entry) => entry.page),
      [5, 4],
      "RTL 双页视觉顺序应反转",
    )
    await page.locator('[data-reader-autosave="saved"]').waitFor({ timeout: 10000 })
    await closePanel(page, settingsPanel)

    logStep("双页前后翻页按跨页步进（不落到伴随页）")
    await jumpToPage(page, 1)
    await waitForComicPage(page, 1)
    await page.locator("[data-reader-page-next]").click()
    await waitForComicPage(page, 2)
    await page.locator("[data-reader-page-next]").click()
    await waitForComicPage(page, 4)
    snapshot = await comicSnapshot(page)
    assert.deepEqual(snapshot.pages.map((entry) => entry.page), [5, 4])
    await page.locator("[data-reader-page-next]").click()
    await waitForComicPage(page, 6)
    await page.locator("[data-reader-page-previous]").click()
    await waitForComicPage(page, 4)

    logStep("fit：screen / width / original 与 CSS 不缩小原图")
    settingsPanel = await openSettings(page)
    await applySetting(page, "显示模式", "单页")
    await applySetting(page, "适应方式", "适应宽度")
    await page.waitForFunction(
      () => document.querySelector(".iread-comic-reader")?.getAttribute("data-fit") === "width",
    )
    await closePanel(page, settingsPanel)
    await jumpToPage(page, 2)
    await waitForComicPage(page, 2)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].width, 1200)
    assert.equal(snapshot.styles.imageMaxWidth, "none")

    await page.setViewportSize({ width: 1200, height: 420 })
    await page.waitForTimeout(400)
    await jumpToPage(page, 10)
    await waitForComicPage(page, 10)
    await page.waitForTimeout(400)
    const widthFit = (await comicSnapshot(page)).pages[0].images[0]
    assert.equal(widthFit.width, 1200, "适应宽度应铺满可用宽度")
    settingsPanel = await openSettings(page)
    await applySetting(page, "适应方式", "适应屏幕")
    await closePanel(page, settingsPanel)
    await page.waitForTimeout(400)
    const screenFit = (await comicSnapshot(page)).pages[0].images[0]
    assert.ok(screenFit.width < 1200, "窄视口下适应屏幕应同时受高度约束")
    settingsPanel = await openSettings(page)
    await applySetting(page, "适应方式", "原始尺寸")
    await closePanel(page, settingsPanel)
    await page.waitForTimeout(700)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].variant, "original")
    assert.equal(snapshot.pages[0].images[0].width, 3200)
    assert.equal(snapshot.styles.imageMaxWidth, "none")
    await page.setViewportSize({ width: 1200, height: 820 })
    await page.waitForTimeout(400)
    settingsPanel = await openSettings(page)
    await page.locator('[data-reader-autosave="saved"]').waitFor({ timeout: 10000 })
    await closePanel(page, settingsPanel)

    logStep("连续模式：flex-start、页距、滚动定位与 12 页占位")
    settingsPanel = await openSettings(page)
    await applySetting(page, "显示模式", "连续")
    await applySetting(page, "适应方式", "适应屏幕")
    await applySetting(page, "页距", "紧凑")
    await page.waitForFunction(
      () => document.querySelector(".iread-comic-reader")?.getAttribute("data-mode") === "continuous",
    )
    await page.waitForTimeout(700)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.mode, "continuous")
    assert.equal(snapshot.pages.length, CBZ_PAGE_COUNT)
    assert.equal(snapshot.styles.viewportJustify, "flex-start")
    assert.equal(snapshot.styles.gap, "4px")
    await page.locator('[data-reader-autosave="saved"]').waitFor({ timeout: 10000 })
    await closePanel(page, settingsPanel)
    await jumpToPage(page, 5)
    await waitForComicPage(page, 5)
    await page.waitForTimeout(300)
    const page5Top = await page.evaluate(() => {
      const root = document.querySelector(".iread-comic-reader")
      const slot = root?.querySelector(
        '.iread-comic-reader__page[data-page="5"]',
      )
      if (!root || !slot) {
        return null
      }
      return Math.round(
        slot.getBoundingClientRect().top - root.getBoundingClientRect().top,
      )
    })
    assert.ok(
      page5Top !== null && page5Top >= -2 && page5Top <= 12,
      `连续模式跳页应滚到目标页，实际 top=${page5Top}`,
    )

    logStep("恢复单页 LTR 便于进度与冲突验证")
    settingsPanel = await openSettings(page)
    await applySetting(page, "显示模式", "单页")
    await applySetting(page, "阅读方向", "从左到右")
    await applySetting(page, "页距", "标准")
    await page.locator('[data-reader-autosave="saved"]').waitFor({ timeout: 10000 })
    await closePanel(page, settingsPanel)
    await jumpToPage(page, 8)
    await waitForComicPage(page, 8)
    await page.waitForTimeout(2_200)

    logStep("浏览器后退保存本机快照与服务器进度")
    await page.goBack()
    await page.waitForURL(`**/books/${cbz.bookId}`, { timeout: 10_000 })
    const afterBack = await waitForStoredPage(api, cbz.bookId, 8)
    assert.equal(afterBack.locatorPayload.mode, "single")
    assert.equal(afterBack.locatorPayload.direction, "ltr")
    const storedSnapshot = await readProgressSnapshot(page, cbz.bookId)
    assert.ok(storedSnapshot !== null, "IndexedDB 应保存进度快照")
    assert.equal(storedSnapshot.locatorPayload.page, 8)
    assert.equal(storedSnapshot.bookId, cbz.bookId)
    const localSnapshot = await page.evaluate(
      (bookId) =>
        JSON.parse(
          window.localStorage.getItem(`iread.reader-snapshot.v1:${bookId}`) ??
            "null",
        ),
      cbz.bookId,
    )
    assert.ok(localSnapshot !== null, "localStorage 应保留退出快照")
    assert.equal(localSnapshot.locatorPayload.page, 8)

    logStep("重新打开恢复第 8 页与已保存的漫画设置")
    await page.getByRole("link", { name: /继续阅读|开始阅读/ }).click()
    await page.waitForURL(`**/read/${cbz.bookId}`, { timeout: 10_000 })
    await waitForComicPage(page, 8)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.mode, "single")
    assert.equal(snapshot.attributes.direction, "ltr")
    assert.match(snapshot.position ?? "", /第 8 \/ 12 页/)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-comic-restored-page8.png"),
    })

    logStep("漫画书签：第 8 页创建、列表、跳转、If-Match 删除与重开无残留")
    const bookmarkDeleteRequests = []
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        request.url().includes("/bookmarks/")
      ) {
        bookmarkDeleteRequests.push({
          url: request.url(),
          ifMatch: request.headers()["if-match"] ?? "",
        })
      }
    })

    await page.getByRole("button", { name: "目录与书签" }).click()
    const bookmarkPanel = page.locator('[data-reader-panel="toc"]')
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page.getByText("还没有书签", { exact: true }).waitFor()
    await page.getByRole("button", { name: "添加当前位置书签" }).click()
    await page.getByText("书签已添加", { exact: true }).waitFor()

    const comicBookmarkItem = page
      .locator(".iread-reader-bookmarks__item")
      .filter({ hasText: "第 8 页" })
    await comicBookmarkItem.waitFor({ timeout: 10_000 })
    const comicBookmarkText = (await comicBookmarkItem.innerText()) ?? ""
    assert.match(comicBookmarkText, /第 8 页/, "书签列表必须显示标签")
    assert.match(comicBookmarkText, /第 8 \/ 12 页/, "书签列表必须显示页码摘要")

    const createdComicBookmarks = await api.get(
      `/api/v1/books/${encodeURIComponent(cbz.bookId)}/bookmarks?fileVersion=${cbz.manifest.fileVersion}`,
    )
    assert.equal(createdComicBookmarks.status, 200)
    assert.equal(createdComicBookmarks.payload?.data?.length, 1)
    const comicBookmark = createdComicBookmarks.payload.data[0]
    assert.equal(comicBookmark.format, "cbz")
    assert.equal(comicBookmark.fileVersion, cbz.manifest.fileVersion)
    assert.equal(comicBookmark.locatorType, "comic-page")
    assert.equal(comicBookmark.locatorPayload.page, 8)
    assert.equal(comicBookmark.label, "第 8 页")
    assert.equal(comicBookmark.revision, "1")

    await closePanel(page, bookmarkPanel)
    await jumpToPage(page, 10)
    await waitForComicPage(page, 10)

    await page.getByRole("button", { name: "目录与书签" }).click()
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page
      .locator(".iread-reader-bookmarks__jump")
      .filter({ hasText: "第 8 页" })
      .click()
    await bookmarkPanel.waitFor({ state: "hidden", timeout: 10_000 })
    await waitForComicPage(page, 8)

    await page.getByRole("button", { name: "目录与书签" }).click()
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page
      .getByRole("button", { name: "移除当前位置书签" })
      .waitFor({ timeout: 10_000 })
    await page
      .getByRole("button", { name: "移除书签：第 8 页" })
      .click()
    await page.getByText("书签已移除", { exact: true }).waitFor()
    await page.getByText("还没有书签", { exact: true }).waitFor()

    const removedComicBookmarks = await api.get(
      `/api/v1/books/${encodeURIComponent(cbz.bookId)}/bookmarks?fileVersion=${cbz.manifest.fileVersion}`,
    )
    assert.equal(removedComicBookmarks.status, 200)
    assert.equal(removedComicBookmarks.payload?.data?.length, 0)
    assert.equal(bookmarkDeleteRequests.length, 1, "必须通过一次 DELETE 移除书签")
    assert.equal(
      bookmarkDeleteRequests[0].ifMatch,
      `"${comicBookmark.revision}"`,
      "DELETE 必须携带 If-Match revision",
    )
    assert.ok(
      bookmarkDeleteRequests[0].url.includes(
        `/bookmarks/${comicBookmark.bookmarkId}`,
      ),
      "DELETE 必须指向刚创建的书签",
    )

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector(".iread-comic-reader")
            ?.getAttribute("data-current-page"),
        ) >= 1,
      undefined,
      { timeout: 30_000 },
    )
    await page.getByRole("button", { name: "目录与书签" }).click()
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page
      .getByText("还没有书签", { exact: true })
      .waitFor({ timeout: 10_000 })
    await closePanel(page, bookmarkPanel)
    await jumpToPage(page, 8)
    await waitForComicPage(page, 8)

    logStep("409 冲突：采用服务器位置")
    // 等当前页的后台节流同步落定，再制造服务器 revision 前进。
    await page.waitForTimeout(2_200)
    const beforeConflict = await getProgress(api, cbz.bookId)
    await seedProgress(api, cbz.manifest, 11, {
      direction: "ltr",
      mode: "single",
      fit: "screen",
    })
    await page.locator("[data-reader-page-next]").click()
    await waitForComicPage(page, 9)
    let conflictDialog = await waitForConflictDialog(page)
    const conflictText = (await conflictDialog.textContent()) ?? ""
    assert.match(conflictText, /服务器位置：第 11 页/)
    assert.match(conflictText, /保留本机位置/)
    assert.match(conflictText, /采用服务器位置/)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-comic-conflict.png"),
    })
    await conflictDialog.getByRole("button", { name: "采用服务器位置" }).click()
    await conflictDialog.waitFor({ state: "hidden", timeout: 10_000 })
    await waitForComicPage(page, 11)
    assert.ok(beforeConflict !== null)

    logStep("409 冲突：保留本机位置并重新同步")
    // 采用服务器位置后引擎会再上报一次位置，等其后台同步落定再改服务器。
    await page.waitForTimeout(2_200)
    await seedProgress(api, cbz.manifest, 6, {
      direction: "ltr",
      mode: "single",
      fit: "screen",
    })
    await jumpToPage(page, 12)
    await waitForComicPage(page, 12)
    conflictDialog = await waitForConflictDialog(page)
    await conflictDialog.getByRole("button", { name: "保留本机位置" }).click()
    await conflictDialog.waitFor({ state: "hidden", timeout: 10_000 })
    await waitForStoredPage(api, cbz.bookId, 12)
    await waitForComicPage(page, 12)

    logStep("退出保存第 12 页与 100%")
    await page.getByRole("button", { name: /返回上一页|返回书库/ }).click()
    await page.waitForURL("**/library", { timeout: 10_000 })
    const finalCbz = await waitForStoredPage(api, cbz.bookId, 12)
    assert.equal(finalCbz.progressPercent, 100)

    logStep("真实 CBR：书库进入、翻页、跳页与进度 100")
    await openFromLibrary(page, cbr.bookId)
    await waitForComicPage(page, 1)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.pageCount, String(CBR_PAGE_COUNT))
    await page.locator("[data-reader-page-next]").click()
    await waitForComicPage(page, 2)
    await jumpToPage(page, 3)
    await waitForComicPage(page, 3)
    assert.match((await comicSnapshot(page)).position ?? "", /100%/)
    await page.getByRole("button", { name: /返回上一页|返回书库/ }).click()
    await page.waitForURL("**/library", { timeout: 10_000 })
    const finalCbr = await waitForStoredPage(api, cbr.bookId, 3)
    assert.equal(finalCbr.progressPercent, 100)
    assert.equal(finalCbr.locatorType, "comic-page")

    logStep("手机 390x844：单页、Drawer 设置与连续模式")
    const mobileContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(mobileContext)
    const mobile = await mobileContext.newPage()
    await mobile.goto(`/read/${cbz.bookId}`, { waitUntil: "domcontentloaded" })
    await waitForComicPage(mobile, 12)
    let mobileSnapshot = await comicSnapshot(mobile)
    assert.equal(mobileSnapshot.box?.width, 390)
    assert.equal(mobileSnapshot.box?.height, 844)
    assert.equal(mobileSnapshot.styles.imageMaxWidth, "none")
    await jumpToPage(mobile, 10)
    await waitForComicPage(mobile, 10)
    await mobile.waitForTimeout(300)
    mobileSnapshot = await comicSnapshot(mobile)
    assert.equal(mobileSnapshot.pages[0].images[0].width, 390)
    assert.equal(mobileSnapshot.pages[0].images[0].height, 219)

    await mobile.getByRole("button", { name: "阅读设置" }).click()
    const mobileSettings = mobile.locator('[data-reader-panel="settings"]')
    await mobileSettings.waitFor({ timeout: 5_000 })
    assert.equal(
      await mobile.locator('[data-slot="drawer-content"]').count(),
      1,
      "手机漫画设置应使用 Drawer",
    )
    await applySetting(mobile, "显示模式", "连续")
    await mobile.waitForFunction(
      () => document.querySelector(".iread-comic-reader")?.getAttribute("data-mode") === "continuous",
    )
    await closePanel(mobile, mobileSettings)
    await mobile.waitForTimeout(500)
    mobileSnapshot = await comicSnapshot(mobile)
    assert.equal(mobileSnapshot.styles.viewportJustify, "flex-start")
    assert.equal(mobileSnapshot.pages.length, CBZ_PAGE_COUNT)
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-comic-continuous.png"),
    })

    assert.deepEqual(pageErrors, [], `桌面页面脚本错误：${pageErrors.join("\n")}`)
    console.log("\n[COMIC-SHELL-E2E] 通过：CBZ/CBR 经书库真实进入，单/双/连续、RTL、fit、跳页、进度恢复、409 与手机均验证。")
  } catch (error) {
    if (error instanceof E2EBlocked) {
      console.error(`[COMIC-SHELL-E2E][BLOCKED] ${error.message}`)
    }
    throw error
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    try {
      await apiContext?.dispose()
    } catch {
      // 忽略 API 上下文关闭失败。
    }
    try {
      await browser?.close()
    } catch {
      // 忽略浏览器关闭失败。
    }
    try {
      await servers?.cleanup()
    } catch {
      // 忽略服务清理失败。
    }
    for (const item of cleanup) {
      try {
        item()
      } catch {
        // 忽略清理失败。
      }
    }
  }
}

main().catch((error) => {
  console.error("\n[COMIC-SHELL-E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
