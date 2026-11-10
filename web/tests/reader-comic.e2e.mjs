#!/usr/bin/env node

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
import { tmpdir } from "node:os"
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
const PREFERRED_SERVER_PORT = Number(
  process.env.IREAD_E2E_SERVER_PORT ?? "18080",
)
const PREFERRED_WEB_PORT = Number(process.env.IREAD_E2E_WEB_PORT ?? "18081")
let serverPort = PREFERRED_SERVER_PORT
let webPort = PREFERRED_WEB_PORT
let webBase = `http://127.0.0.1:${webPort}`
let serverBase = `http://127.0.0.1:${serverPort}`
const SCREENSHOT_DIR =
  process.env.READER_COMIC_SCREENSHOT_DIR ??
  path.join("/tmp/opencode", "iread-comic-e2e-screenshots")
const TEMP_ROOT = process.env.IREAD_E2E_TMP ?? "/tmp/opencode"

function logStep(name) {
  console.log(`\n[COMIC-E2E] ${name}`)
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

/** 12 页真实 CBZ：page1/2/10 使用 C6 样本，page11 为超原始尺寸图。 */
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
  const tempRoot = mkdtempSync(path.join(TEMP_ROOT, "iread-comic-e2e-"))
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
  let server = null
  let vite = null
  const preferredServerHealthy = await httpReachable(
    `http://127.0.0.1:${PREFERRED_SERVER_PORT}/healthz`,
  )
  if (!preferredServerHealthy) {
    if (!(await portFree(serverPort))) {
      serverPort = await findFreePort(serverPort + 100)
      serverBase = `http://127.0.0.1:${serverPort}`
      console.log(`[COMIC-E2E] 18080 被占用，改用 ${serverPort}`)
    }
    if (!(await portFree(webPort))) {
      webPort = await findFreePort(webPort + 100)
      webBase = `http://127.0.0.1:${webPort}`
      console.log(`[COMIC-E2E] 18081 被占用，改用 ${webPort}`)
    }
  }
  if (!(await httpReachable(`${serverBase}/healthz`))) {
    server = startProcess("go", ["run", "./cmd/iread"], {
      cwd: path.join(REPO_ROOT, "server"),
      env: {
        ...process.env,
        IREAD_ADDR: `127.0.0.1:${serverPort}`,
        IREAD_PUBLIC_ORIGIN: serverBase,
        IREAD_BOOKS_DIR: dirs.books,
        IREAD_DB_DIR: dirs.db,
        IREAD_CACHE_DIR: dirs.cache,
        IREAD_WEB_DIR: staticWebDir,
        IREAD_LOG_LEVEL: "warn",
      },
    })
    cleanup.push(() => stopProcess(server))
    await waitForHttp(`${serverBase}/healthz`, 90_000)
    console.log(`[COMIC-E2E] 已启动临时 Go 服务 ${serverBase}，数据目录 ${tempRoot}`)
  } else {
    console.log(`[COMIC-E2E] 复用已在运行的 Go 服务 ${serverBase}`)
  }
  if (!(await httpReachable(`${webBase}/`))) {
    if (!(await portFree(webPort))) {
      webPort = await findFreePort(PREFERRED_WEB_PORT + 100)
      webBase = `http://127.0.0.1:${webPort}`
    }
    vite = startProcess(
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
    console.log(`[COMIC-E2E] 已启动 Vite 开发服务器 ${webBase}`)
  } else {
    console.log(`[COMIC-E2E] 复用已在运行的 Web 服务 ${webBase}`)
  }
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
  options = {},
) {
  const allowedUnsupportedReasons = options.allowedUnsupportedReasons ?? []
  const intentResponse = await api.post("/api/v1/uploads", {
    clientUploadId: `comic-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    fileName,
    byteSize: data.length,
  })
  assert.ok(
    intentResponse.status === 200 || intentResponse.status === 201,
    `创建上传意图失败：HTTP ${intentResponse.status} ${JSON.stringify(intentResponse.payload)}`,
  )
  const intent = requireData(intentResponse.payload, "上传意图")
  const uploadId = intent.uploadId
  assert.equal(typeof uploadId, "string", "上传意图缺少 uploadId")
  if (api.csrfToken === null) {
    await api.fetchStatus()
  }
  const put = await api.request.fetch(
    `${serverBase}/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        Origin: serverBase,
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}`)
    if (response.status === 200) {
      detail = requireData(response.payload, "书籍详情")
      if (detail.status === "ready") {
        break
      }
      if (detail.status === "unsupported") {
        const reason = detail.readingCapabilities?.unavailableReason ?? ""
        if (allowedUnsupportedReasons.includes(reason)) {
          break
        }
      }
      if (detail.status === "error") {
        throw new Error(`漫画索引失败：${JSON.stringify(detail)}`)
      }
    }
    await sleep(250)
  }
  assert.ok(detail !== null, `等待书籍 ${bookId} 索引超时`)
  if (detail.status !== "ready") {
    assert.equal(
      detail.status,
      "unsupported",
      `书籍未就绪：${JSON.stringify(detail)}`,
    )
  }
  const manifestResponse = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/manifest`,
  )
  assert.equal(
    manifestResponse.status,
    200,
    `读取 manifest 失败：HTTP ${manifestResponse.status} ${JSON.stringify(manifestResponse.payload)}`,
  )
  const manifest = requireData(manifestResponse.payload, "manifest")
  assert.equal(manifest.format, expectedFormat, "manifest 格式不符合预期")
  return { bookId, detail, manifest }
}

function resourceRequests(requests, bookId) {
  const needle = `/api/v1/books/${bookId}/versions/`
  return requests.filter((request) => request.url.includes(needle))
}

function resourceInfo(url) {
  const parsed = new URL(url)
  const parts = parsed.pathname.split("/")
  return {
    resourceId: parts[parts.length - 1],
    variant: parsed.searchParams.get("variant") ?? "screen",
  }
}

function pageRequests(requests, manifest, pageNumber) {
  const entry = manifest.formatData.pages.find(
    (candidate) => candidate.page === pageNumber,
  )
  if (entry === undefined) {
    return []
  }
  return requests.filter(
    (request) => resourceInfo(request.url).resourceId === entry.resourceId,
  )
}

async function installHarness(page, manifest, settings) {
  return page.evaluate(
    async ({ manifestValue, settingsValue }) => {
      window.__comicHarness?.engine?.dispose()
      document.querySelector("#comic-e2e-host")?.remove()
      let style = document.querySelector("#comic-e2e-style")
      if (style === null) {
        style = document.createElement("style")
        style.id = "comic-e2e-style"
        style.textContent = `
          .iread-comic-reader { position: relative; width: 100%; height: 100%; overflow: auto; display: flex; flex-direction: column; align-items: center; }
          .iread-comic-reader__viewport { width: 100%; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
          .iread-comic-reader[data-mode="continuous"] .iread-comic-reader__viewport { justify-content: flex-start; }
          .iread-comic-reader__spread { display: flex; align-items: flex-start; justify-content: center; }
          .iread-comic-reader__page { display: flex; justify-content: center; width: 100%; }
          .iread-comic-reader__image { max-width: none; height: auto; display: block; }
          .iread-comic-reader__page-placeholder { display: block; }
          .iread-comic-reader__page-pending, .iread-comic-reader__page-error { padding: 1rem; text-align: center; }
          .iread-comic-reader[data-gap="compact"] .iread-comic-reader__spread { gap: 4px; }
          .iread-comic-reader[data-gap="standard"] .iread-comic-reader__spread { gap: 12px; }
          .iread-comic-reader[data-gap="relaxed"] .iread-comic-reader__spread { gap: 24px; }
        `
        document.head.append(style)
      }
      const module = await import("/src/features/reader/comic/index.ts")
      const host = document.createElement("div")
      host.id = "comic-e2e-host"
      host.style.position = "fixed"
      host.style.inset = "0"
      host.style.zIndex = "9999"
      host.style.overflow = "auto"
      host.style.background = "Canvas"
      document.body.replaceChildren(host)
      const engine = module.createComicReaderEngine({
        settings: settingsValue,
        tapNavigation: true,
      })
      const controller = new AbortController()
      const locations = []
      engine.subscribeLocation((location) => {
        locations.push(location)
      })
      const harness = { engine, host, controller, locations }
      window.__comicHarness = harness
      await engine.mount(host, manifestValue, controller.signal)
      return {
        capabilities: engine.capabilities,
        settings: engine.getSettings(),
        location: engine.getLocation(),
      }
    },
    { manifestValue: manifest, settingsValue: settings },
  )
}

async function comicSnapshot(page) {
  return page.evaluate(() => {
    const harness = window.__comicHarness
    if (!harness) {
      return null
    }
    const root = harness.host.querySelector(".iread-comic-reader")
    const pages = [...harness.host.querySelectorAll(".iread-comic-reader__page")].map(
      (element) => ({
        page: Number(element.dataset.page),
        state: element.dataset.state ?? null,
        current: element.dataset.current === "true",
        variant: element.dataset.variant ?? null,
        top: Math.round(element.getBoundingClientRect().top),
        error:
          element.querySelector(".iread-comic-reader__page-error")?.textContent ??
          null,
        images: [...element.querySelectorAll("img")].map((image) => ({
          alt: image.alt,
          variant: image.dataset.variant ?? null,
          width: image.width,
          height: image.height,
          renderedWidth: image.getAttribute("data-rendered-width"),
          renderedHeight: image.getAttribute("data-rendered-height"),
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          src: image.getAttribute("src"),
        })),
      }),
    )
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
            status: root.getAttribute("data-status"),
          }
        : null,
      pages,
      status:
        root?.querySelector(".iread-comic-reader__status")?.textContent ?? null,
      scroll: {
        root: root?.scrollTop ?? null,
        host: harness.host.scrollTop ?? null,
      },
      location: harness.engine.getLocation(),
      settings: harness.engine.getSettings(),
      locations: harness.locations.slice(),
    }
  })
}

async function waitForPage(page, pageNumber, timeout = 30_000) {
  try {
    await page.waitForFunction(
      (expected) => {
        const harness = window.__comicHarness
        const root = harness?.host.querySelector(".iread-comic-reader")
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
      pageNumber,
      { timeout },
    )
  } catch (error) {
    const snapshot = await comicSnapshot(page)
    console.error(
      `[COMIC-E2E] 等待第 ${pageNumber} 页超时，快照：${JSON.stringify(snapshot, null, 2)}`,
    )
    throw error
  }
}

async function navigateToPage(page, pageNumber) {
  const result = await page.evaluate(async (target) => {
    const harness = window.__comicHarness
    const settings = harness.engine.getSettings()
    const outcome = await harness.engine.navigateTo({
      locatorType: "comic-page",
      progressPercent: 0,
      locatorPayload: {
        locatorVersion: 1,
        page: target,
        pageOffset: 0,
        direction: settings.direction,
        mode: settings.mode,
        fit: settings.fit,
      },
    })
    return outcome
  }, pageNumber)
  assert.equal(result.ok, true, `跳转到第 ${pageNumber} 页失败`)
}

async function applySettings(page, patch) {
  return page.evaluate(
    (patchValue) => window.__comicHarness.engine.applySettings(patchValue),
    patch,
  )
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const cleanup = []
  let servers = null
  let browser = null
  let apiContext = null
  const requests = []

  try {
    servers = await ensureServers(cleanup)
    const browserLaunch = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--no-sandbox"],
    })
    browser = browserLaunch
    const storageState = await createAuthenticatedStorageState(
      browser,
      serverBase,
      E2E_PASSWORD,
    )
    apiContext = await playwrightRequest.newContext({
      baseURL: serverBase,
      storageState,
    })
    const api = new AuthedApi(apiContext, serverBase)
    await ensureAdmin(api, serverBase, E2E_PASSWORD)

    logStep("上传真实 CBZ（12 页，含 page1/page2/page10 与超原始尺寸图）")
    const cbz = await uploadComic(
      api,
      `comic-e2e-${Date.now()}.cbz`,
      makeComicCbz(),
      "application/vnd.comicbook+zip",
      "cbz",
    )
    assert.equal(cbz.manifest.formatData.pageCount, 12, "CBZ 页数应为 12")
    assert.deepEqual(
      cbz.manifest.formatData.pages.map((page) => page.page),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      "CBZ 页号应按自然顺序 1..12",
    )
    const page2 = cbz.manifest.formatData.pages[1]
    const page10 = cbz.manifest.formatData.pages[9]
    const page11 = cbz.manifest.formatData.pages[10]
    assert.equal(page2.width, 400, "page2 宽度应来自真实样本")
    assert.equal(page2.height, 200, "page2 高度应来自真实样本")
    assert.equal(page10.width, 3200, "page10 应为 3200×1800")
    assert.equal(page10.height, 1800, "page10 应为 3200×1800")
    assert.equal(page11.width, 8000, "page11 应为 8000×5000")
    assert.deepEqual(
      page11.availableVariants,
      ["screen"],
      "超 32M 像素页不应提供 original",
    )
    console.log(
      `[COMIC-E2E] CBZ bookId=${cbz.bookId} pages=${cbz.manifest.formatData.pageCount}`,
    )

    logStep("上传真实 CBR（C6 RAR5 样本，自然排序 page1/page2/page10）")
    const cbr = await uploadComic(
      api,
      `comic-e2e-${Date.now()}.cbr`,
      sample("comic_rar5.rar"),
      "application/vnd.comicbook-rar",
      "cbr",
      { allowedUnsupportedReasons: ["cbr_parser_pending", "cbr_parser_deferred"] },
    )
    assert.equal(cbr.manifest.formatData.pageCount, 3, "CBR 页数应为 3")
    assert.deepEqual(
      cbr.manifest.formatData.pages.map((page) => page.page),
      [1, 2, 3],
      "CBR manifest 页号应从 1 连续编号",
    )
    assert.equal(
      cbr.manifest.formatData.pages[0].width,
      320,
      "CBR 自然排序第 1 页应为 page1.jpg",
    )
    assert.equal(
      cbr.manifest.formatData.pages[1].width,
      400,
      "CBR 自然排序第 2 页应为 page2.jpg",
    )
    assert.equal(
      cbr.manifest.formatData.pages[2].width,
      3200,
      "CBR 自然排序第 3 页应为 page10.jpg（不是字典序 page10 在前）",
    )
    console.log(
      `[COMIC-E2E] CBR bookId=${cbr.bookId} widths=${cbr.manifest.formatData.pages
        .map((page) => page.width)
        .join(",")}`,
    )

    const desktopContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1200, height: 820 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    const page = await desktopContext.newPage()
    page.on("request", (request) => {
      if (request.url().includes("/resources/")) {
        requests.push({ url: request.url() })
      }
    })
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`[COMIC-E2E][browser] ${message.text()}`)
      }
    })
    page.on("response", (response) => {
      if (response.url().includes("/resources/") && response.status() >= 400) {
        console.log(
          `[COMIC-E2E][resource ${response.status()}] ${response.url()}`,
        )
      }
    })
    page.on("requestfailed", (request) => {
      if (request.url().includes("/resources/")) {
        console.log(
          `[COMIC-E2E][requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`,
        )
      }
    })
    page.on("pageerror", (error) => {
      console.log(`[COMIC-E2E][pageerror] ${error.message}`)
    })
    await page.goto(`${webBase}/`, { waitUntil: "domcontentloaded" })

    logStep("桌面单页：真实 manifest、page1、预取 4 页、进度/locator")
    await installHarness(page, cbz.manifest, {
      direction: "ltr",
      mode: "single",
      fit: "screen",
      gap: "standard",
      background: "inherit",
    })
    await waitForPage(page, 1)
    await sleep(700)
    let snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.mode, "single")
    assert.equal(snapshot.attributes.direction, "ltr")
    assert.equal(snapshot.attributes.fit, "screen")
    assert.equal(snapshot.attributes.gap, "standard")
    assert.equal(snapshot.attributes.background, "inherit")
    assert.equal(snapshot.pages.length, 1)
    assert.equal(snapshot.pages[0].page, 1)
    assert.equal(snapshot.pages[0].images.length, 1)
    assert.equal(snapshot.pages[0].images[0].variant, "screen")
    assert.equal(snapshot.pages[0].images[0].width, 1200)
    assert.equal(snapshot.pages[0].images[0].height, 750)
    assert.equal(snapshot.location.locatorType, "comic-page")
    assert.deepEqual(snapshot.location.locatorPayload, {
      locatorVersion: 1,
      page: 1,
      pageOffset: 0,
      direction: "ltr",
      mode: "single",
      fit: "screen",
    })
    assert.equal(snapshot.location.progressPercent, 0)
    let scoped = resourceRequests(requests, cbz.bookId)
    const initialPages = new Set(
      scoped.map((request) => {
        const info = resourceInfo(request.url)
        return cbz.manifest.formatData.pages.find(
          (entry) => entry.resourceId === info.resourceId,
        )?.page
      }),
    )
    assert.deepEqual(
      [...initialPages].sort((left, right) => left - right),
      [1, 2, 3, 4],
      "桌面单页应只预取当前+邻页 4 页",
    )
    assert.equal(scoped.every((request) => resourceInfo(request.url).variant === "screen"), true)
    console.log("[COMIC-E2E] 初始请求页：1,2,3,4（全部 screen）")

    logStep("页距/背景参数由 Shell 设置驱动，根节点真实反映")
    await applySettings(page, { gap: "relaxed", background: "paper" })
    await waitForPage(page, 1)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.gap, "relaxed")
    assert.equal(snapshot.attributes.background, "paper")
    await applySettings(page, { gap: "standard", background: "inherit" })
    await waitForPage(page, 1)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.gap, "standard")
    assert.equal(snapshot.attributes.background, "inherit")

    logStep("单页翻页：page2/page10、缓存复用、精准跳转")
    await navigateToPage(page, 2)
    await waitForPage(page, 2)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].width, 1200)
    assert.equal(snapshot.pages[0].images[0].height, 600)
    assert.ok(Math.abs(snapshot.location.progressPercent - (100 / 11)) < 0.001)
    assert.equal(
      pageRequests(resourceRequests(requests, cbz.bookId), cbz.manifest, 2).length,
      1,
      "page2 已预取，跳转不应重复请求",
    )
    const page2CountBefore = pageRequests(
      resourceRequests(requests, cbz.bookId),
      cbz.manifest,
      2,
    ).length
    const page3CountBefore = pageRequests(
      resourceRequests(requests, cbz.bookId),
      cbz.manifest,
      3,
    ).length
    await navigateToPage(page, 3)
    await waitForPage(page, 3)
    await navigateToPage(page, 2)
    await waitForPage(page, 2)
    assert.equal(
      pageRequests(resourceRequests(requests, cbz.bookId), cbz.manifest, 2).length,
      page2CountBefore,
      "前后翻页不应重复请求 page2",
    )
    assert.equal(
      pageRequests(resourceRequests(requests, cbz.bookId), cbz.manifest, 3).length,
      page3CountBefore,
      "前后翻页不应重复请求 page3",
    )
    await navigateToPage(page, 10)
    await waitForPage(page, 10)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].width, 1200)
    assert.equal(snapshot.pages[0].images[0].height, 675)
    assert.ok(Math.abs(snapshot.location.progressPercent - (900 / 11)) < 0.001)
    assert.equal(
      pageRequests(resourceRequests(requests, cbz.bookId), cbz.manifest, 10).length,
      1,
    )
    console.log(
      `[COMIC-E2E] page2 progress=${(100 / 11).toFixed(3)} page10 progress=${snapshot.location.progressPercent.toFixed(3)}`,
    )

    logStep("双页：封面单页、LTR/RTL 视觉顺序、末页落单")
    await applySettings(page, { mode: "double", direction: "ltr" })
    await page.waitForFunction(() =>
      window.__comicHarness.host
        .querySelector(".iread-comic-reader")
        ?.getAttribute("data-mode") === "double",
    )
    await waitForPage(page, 10)
    snapshot = await comicSnapshot(page)
    assert.deepEqual(
      snapshot.pages.map((entry) => entry.page),
      [10, 11],
      "LTR 双页应显示 10,11",
    )
    assert.ok(
      snapshot.pages.every((entry) =>
        entry.images.every((image) => image.width <= 594),
      ),
      "双页每页宽度不得超过半宽减页距",
    )
    await applySettings(page, { direction: "rtl" })
    await page.waitForFunction(() =>
      window.__comicHarness.host
        .querySelector(".iread-comic-reader")
        ?.getAttribute("data-direction") === "rtl",
    )
    await waitForPage(page, 10)
    snapshot = await comicSnapshot(page)
    assert.deepEqual(
      snapshot.pages.map((entry) => entry.page),
      [11, 10],
      "RTL 双页视觉顺序应反转",
    )
    assert.equal(snapshot.location.locatorPayload.direction, "rtl")
    await navigateToPage(page, 1)
    await waitForPage(page, 1)
    snapshot = await comicSnapshot(page)
    assert.deepEqual(
      snapshot.pages.map((entry) => entry.page),
      [1],
      "封面必须单页",
    )
    await navigateToPage(page, 12)
    await waitForPage(page, 12)
    snapshot = await comicSnapshot(page)
    assert.deepEqual(
      snapshot.pages.map((entry) => entry.page),
      [12],
      "末页必须落单",
    )
    assert.equal(snapshot.location.progressPercent, 100, "最后一页进度必须 100")
    await applySettings(page, { mode: "single", direction: "ltr" })
    await page.waitForFunction(() =>
      window.__comicHarness.host
        .querySelector(".iread-comic-reader")
        ?.getAttribute("data-mode") === "single",
    )

    logStep("fit：screen/width/original 与 32M/64MiB 限制")
    await page.setViewportSize({ width: 1200, height: 400 })
    await page.evaluate(() => {
      window.__comicHarness.engine.handleViewportChange({
        width: 1200,
        height: 400,
        visualWidth: 1200,
        visualHeight: 400,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        devicePixelRatio: 1,
      })
    })
    await sleep(250)
    await navigateToPage(page, 10)
    await waitForPage(page, 10)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].width, 711)
    assert.equal(snapshot.pages[0].images[0].height, 400)
    await applySettings(page, { fit: "width" })
    await sleep(250)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].width, 1200)
    assert.equal(snapshot.pages[0].images[0].height, 675)
    await applySettings(page, { fit: "original" })
    await sleep(500)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].variant, "original")
    assert.equal(snapshot.pages[0].images[0].width, 3200)
    assert.equal(snapshot.pages[0].images[0].height, 1800)
    assert.equal(snapshot.attributes.variant, "original")
    assert.equal(snapshot.location.locatorPayload.fit, "original")
    const originalRequests = pageRequests(
      resourceRequests(requests, cbz.bookId),
      cbz.manifest,
      10,
    ).filter((request) => resourceInfo(request.url).variant === "original")
    assert.equal(originalRequests.length, 1, "当前页应只请求一次 original")
    await navigateToPage(page, 11)
    await sleep(700)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].images[0].variant, "screen")
    assert.match(snapshot.status ?? "", /超过原始尺寸限制/)
    assert.equal(
      pageRequests(resourceRequests(requests, cbz.bookId), cbz.manifest, 11).filter(
        (request) => resourceInfo(request.url).variant === "original",
      ).length,
      0,
      "超 32M 像素页不得请求 original",
    )
    console.log("[COMIC-E2E] 超限页已回退 screen，未请求 original")

    logStep("旋转/视口变化保持 page10，手机尺寸重算")
    await applySettings(page, { fit: "screen" })
    await navigateToPage(page, 10)
    await waitForPage(page, 10)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      window.__comicHarness.engine.handleViewportChange({
        width: 390,
        height: 844,
        visualWidth: 390,
        visualHeight: 844,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        devicePixelRatio: 3,
      })
    })
    await sleep(300)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.currentPage, "10")
    assert.equal(snapshot.pages[0].page, 10)
    assert.equal(snapshot.pages[0].images[0].width, 390)
    assert.equal(snapshot.pages[0].images[0].height, 219)
    assert.equal(snapshot.location.locatorPayload.page, 10)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comic-mobile-single-page10.png"),
    })

    logStep("键盘与点按手势回调")
    await page.setViewportSize({ width: 1200, height: 820 })
    await page.evaluate(() => {
      window.__comicHarness.engine.handleViewportChange({
        width: 1200,
        height: 820,
        visualWidth: 1200,
        visualHeight: 820,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        devicePixelRatio: 1,
      })
    })
    await navigateToPage(page, 2)
    await waitForPage(page, 2)
    await page.locator(".iread-comic-reader").focus()
    await page.keyboard.press("ArrowRight")
    await waitForPage(page, 3)
    assert.equal((await comicSnapshot(page)).attributes.currentPage, "3")
    await page.keyboard.press("ArrowLeft")
    await waitForPage(page, 2)
    await page.mouse.click(1140, 400)
    await waitForPage(page, 3)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.currentPage, "3", "右侧点按应前进一页")

    logStep("快速跳页：旧请求取消/不覆盖新页")
    await navigateToPage(page, 1)
    await waitForPage(page, 1)
    const page8 = cbz.manifest.formatData.pages.find(
      (entry) => entry.page === 8,
    )
    await page.route("**/resources/**", async (route) => {
      if (route.request().url().includes(page8.resourceId)) {
        await sleep(900)
        try {
          await route.continue()
        } catch {
          // 已因快速跳页取消，忽略。
        }
        return
      }
      await route.continue()
    })
    await page.evaluate(async () => {
      const harness = window.__comicHarness
      const settings = harness.engine.getSettings()
      harness.pending = harness.engine.navigateTo({
        locatorType: "comic-page",
        progressPercent: 0,
        locatorPayload: {
          locatorVersion: 1,
          page: 8,
          pageOffset: 0,
          direction: settings.direction,
          mode: settings.mode,
          fit: settings.fit,
        },
      })
    })
    await sleep(120)
    await navigateToPage(page, 2)
    await waitForPage(page, 2)
    await sleep(1200)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.attributes.currentPage, "2")
    assert.equal(snapshot.pages[0].page, 2)
    assert.equal(snapshot.pages[0].images[0].alt, "第 2 页")
    assert.equal(
      snapshot.pages.some((entry) => entry.page === 8),
      false,
      "旧响应不得出现在新页 DOM",
    )
    await page.unroute("**/resources/**")

    logStep("连续模式：12 页占位，有限加载，跳页 1/12 与进度")
    await navigateToPage(page, 10)
    await waitForPage(page, 10)
    await applySettings(page, { mode: "continuous", fit: "screen" })
    await page.waitForFunction(() =>
      window.__comicHarness.host
        .querySelector(".iread-comic-reader")
        ?.getAttribute("data-mode") === "continuous",
    )
    await sleep(900)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages.length, 12, "连续模式应为每页建立真实占位")
    const loadedAtPage10 = snapshot.pages.filter(
      (entry) => entry.images.length > 0,
    ).length
    assert.ok(loadedAtPage10 > 0 && loadedAtPage10 < 12, "不应预取整本")
    const pageOneBeforeJump = snapshot.pages.find((entry) => entry.page === 1)
    assert.equal(
      pageOneBeforeJump?.images.length,
      0,
      "连续模式在 page10 不应已加载 page1",
    )
    await navigateToPage(page, 1)
    await waitForPage(page, 1)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.location.progressPercent, 0)
    const pageOneSlot = snapshot.pages.find((entry) => entry.page === 1)
    assert.equal(
      pageOneSlot?.images.length,
      1,
      "跳到 page1 后应加载该页",
    )
    assert.ok(
      (pageOneSlot?.top ?? -999) >= -2 && (pageOneSlot?.top ?? 999) <= 8,
      `连续模式跳转后 page1 应滚到视口顶部，实际 top=${pageOneSlot?.top}`,
    )
    await sleep(600)
    await page.evaluate(() => {
      const root = window.__comicHarness.host.querySelector(
        ".iread-comic-reader",
      )
      const slot = window.__comicHarness.host.querySelector(
        '.iread-comic-reader__page[data-page="5"]',
      )
      if (root instanceof HTMLElement && slot instanceof HTMLElement) {
        root.scrollTop = slot.offsetTop
      }
    })
    await page.waitForFunction(
      () => {
        const root = window.__comicHarness.host.querySelector(
          ".iread-comic-reader",
        )
        const page = Number(root?.getAttribute("data-current-page") ?? 0)
        return page >= 4 && page <= 6
      },
      null,
      { timeout: 5000 },
    )
    const scrolledSnapshot = await comicSnapshot(page)
    assert.ok(
      scrolledSnapshot.location.locatorPayload.page >= 4,
      "连续滚动应更新 locator 页码",
    )
    await navigateToPage(page, 12)
    await waitForPage(page, 12)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.location.progressPercent, 100)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comic-continuous-page12.png"),
    })
    console.log(
      `[COMIC-E2E] 连续模式 page10 已加载 ${loadedAtPage10}/12 页，page12 进度 100`,
    )

    logStep("CBR 真实归档：按页读取与最后一页 100")
    await installHarness(page, cbr.manifest, {
      direction: "ltr",
      mode: "single",
      fit: "screen",
      gap: "standard",
      background: "inherit",
    })
    await waitForPage(page, 1)
    assert.equal(cbr.manifest.formatData.pageCount, 3)
    await navigateToPage(page, 3)
    await waitForPage(page, 3)
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.location.progressPercent, 100)
    const cbrScoped = resourceRequests(requests, cbr.bookId)
    const cbrLastPage = cbr.manifest.formatData.pages[2]
    assert.equal(
      cbrScoped.filter(
        (request) =>
          resourceInfo(request.url).resourceId === cbrLastPage.resourceId &&
          resourceInfo(request.url).variant === "screen",
      ).length,
      1,
      "CBR 最后一页应恰好请求一次 screen",
    )

    logStep("无假页：清单缺失页显示局部错误，不渲染空图")
    const brokenManifest = JSON.parse(JSON.stringify(cbz.manifest))
    brokenManifest.formatData.pages = brokenManifest.formatData.pages.filter(
      (entry) => entry.page !== 5,
    )
    await installHarness(page, brokenManifest, {
      direction: "ltr",
      mode: "single",
      fit: "screen",
      gap: "standard",
      background: "inherit",
    })
    await waitForPage(page, 1)
    await navigateToPage(page, 5)
    await page.waitForFunction(() => {
      const root = window.__comicHarness.host.querySelector(".iread-comic-reader")
      return (
        root?.getAttribute("data-current-page") === "5" &&
        root.querySelector(
          '.iread-comic-reader__page[data-page="5"]',
        )?.getAttribute("data-state") === "error"
      )
    })
    snapshot = await comicSnapshot(page)
    assert.equal(snapshot.pages[0].page, 5)
    assert.equal(snapshot.pages[0].images.length, 0, "缺页不得生成假图片")
    assert.match(snapshot.pages[0].error ?? "", /缺少第 5 页/)
    console.log("[COMIC-E2E] 缺页显示局部错误，未生成假页")

    logStep("手机视图：page10、screen、移动预取窗口")
    const mobileContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    const mobilePage = await mobileContext.newPage()
    const mobileRequests = []
    mobilePage.on("request", (request) => {
      if (request.url().includes("/resources/")) {
        mobileRequests.push({ url: request.url() })
      }
    })
    await mobilePage.goto(`${webBase}/`, { waitUntil: "domcontentloaded" })
    await installHarness(mobilePage, cbz.manifest, {
      direction: "rtl",
      mode: "single",
      fit: "screen",
      gap: "compact",
      background: "midnight",
    })
    await waitForPage(mobilePage, 1)
    const initialMobileCount = mobileRequests.length
    const initialMobilePages = new Set(
      resourceRequests(mobileRequests, cbz.bookId).map((request) => {
        const info = resourceInfo(request.url)
        return cbz.manifest.formatData.pages.find(
          (entry) => entry.resourceId === info.resourceId,
        )?.page
      }),
    )
    assert.ok(
      initialMobilePages.size <= 2,
      `移动端初始预取应不超过 2 页，实际 ${[...initialMobilePages].join(",")}`,
    )
    await navigateToPage(mobilePage, 10)
    await waitForPage(mobilePage, 10)
    await sleep(600)
    snapshot = await comicSnapshot(mobilePage)
    assert.equal(snapshot.attributes.currentPage, "10")
    assert.equal(snapshot.attributes.direction, "rtl")
    assert.equal(snapshot.pages[0].images[0].width, 390)
    assert.equal(snapshot.pages[0].images[0].height, 219)
    const jumpScoped = resourceRequests(
      mobileRequests.slice(initialMobileCount),
      cbz.bookId,
    )
    const mobilePages = new Set(
      jumpScoped.map((request) => {
        const info = resourceInfo(request.url)
        return cbz.manifest.formatData.pages.find(
          (entry) => entry.resourceId === info.resourceId,
        )?.page
      }),
    )
    assert.ok(
      mobilePages.size <= 3,
      `移动端跳页后预取窗口应受限，实际 ${[...mobilePages].join(",")}`,
    )
    assert.equal(
      jumpScoped.some(
        (request) => resourceInfo(request.url).variant === "original",
      ),
      false,
      "移动端 screen 模式不得请求 original",
    )
    await mobilePage.screenshot({
      path: path.join(SCREENSHOT_DIR, "comic-mobile-rtl-page10.png"),
    })
    await mobileContext.close()

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comic-desktop.png"),
    })

    logStep("结果汇总")
    console.log(
      JSON.stringify(
        {
          cbz: {
            bookId: cbz.bookId,
            pageCount: cbz.manifest.formatData.pageCount,
            requestCount: resourceRequests(requests, cbz.bookId).length,
          },
          cbr: {
            bookId: cbr.bookId,
            pageCount: cbr.manifest.formatData.pageCount,
            order: cbr.manifest.formatData.pages.map((entry) => entry.page),
          },
          screenshots: SCREENSHOT_DIR,
        },
        null,
        2,
      ),
    )
    console.log("[COMIC-E2E] 漫画引擎断言通过。")
  } catch (error) {
    if (error instanceof E2EBlocked) {
      console.error(`[COMIC-E2E][BLOCKED] ${error.message}`)
    }
    throw error
  } finally {
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
  console.error("\n[COMIC-E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
