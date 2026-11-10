#!/usr/bin/env node

/**
 * 阶段5.1/5.2 阅读器缓存集成 E2E：
 * - EPUB/PDF/CBZ 经真实 Go 服务读取后，设置页精确用量 > 0；
 * - 资源层断网后重开已读章节/页仍从 L3 命中；
 * - 设置页清理后受管缓存归零，设备偏好保留；
 * - PDF 只接受 206 + Content-Range，不缓存/不接受 200 完整响应；
 * - 漫画快速跳页时旧页响应不覆盖当前页。
 *
 * 仅使用临时服务目录，不触碰真实数据。
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
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
const TEMP_ROOT = process.env.IREAD_E2E_TMP ?? "/tmp/opencode"
const SCREENSHOT_DIR =
  process.env.READER_CACHE_INTEGRATION_SCREENSHOT_DIR ??
  path.join(TEMP_ROOT, "iread-cache-integration-screenshots")
const COMIC_TESTDATA = path.join(
  REPO_ROOT,
  "server/internal/reader/comic/testdata",
)
let serverPort = Number(process.env.IREAD_CACHE_INTEGRATION_SERVER_PORT ?? "18480")
let webPort = Number(process.env.IREAD_CACHE_INTEGRATION_WEB_PORT ?? "18481")
let serverBase = `http://127.0.0.1:${serverPort}`
let webBase = `http://127.0.0.1:${webPort}`

const PDF_PAGE_COUNT = 8
const PDF_PADDING_LINES = 420
const COMIC_PAGE_COUNT = 12

function logStep(name) {
  console.log(`\n[CACHE-E2E] ${name}`)
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

function zipEntries(entries) {
  const localChunks = []
  const centralChunks = []
  let offset = 0
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1
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
    local.writeUInt16LE(0, 10)
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
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)
    offset += local.length + name.length + payload.length
  }
  const centralDirectory = Buffer.concat(centralChunks)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, centralDirectory, end])
}

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

function makeEpub() {
  const title = "缓存集成 EPUB"
  return {
    title,
    data: zipEntries([
      { name: "mimetype", data: "application/epub+zip", store: true },
      {
        name: "META-INF/container.xml",
        data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
      },
      {
        name: "OEBPS/content.opf",
        data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:identifier id="id">urn:uuid:reader-cache-integration-epub</dc:identifier>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-10T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="pic" href="pic.png" media-type="image/png"/>
    <item id="c1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`,
      },
      {
        name: "OEBPS/style.css",
        data: "body { color: #222; font-family: serif; } #cached { font-weight: 600; }",
      },
      { name: "OEBPS/pic.png", data: PIXEL_PNG },
      {
        name: "OEBPS/Text/chapter1.xhtml",
        data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>缓存第一章</title><link rel="stylesheet" href="../style.css"/></head>
  <body>
    <h1 id="cached">缓存第一章正文</h1>
    <p>用于验证 EPUB 章节、CSS 与图片都进入三层缓存。</p>
    <img src="../pic.png" alt="缓存像素"/>
  </body>
</html>`,
      },
      {
        name: "OEBPS/Text/chapter2.xhtml",
        data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>缓存第二章</title></head>
  <body><h1>缓存第二章正文</h1><p>相邻章节。</p></body>
</html>`,
      },
    ]),
  }
}

function escapePdfText(value) {
  return value.replace(/[\\()]/g, "\\$&")
}

function buildPdf() {
  const ids = { catalog: 1, pages: 2, font: 3 }
  const pageId = (page) => 10 + page
  const contentId = (page) => 30 + page
  let body = "%PDF-1.4\n"
  for (let line = 0; line < PDF_PADDING_LINES; line += 1) {
    body += `%${"cache-padding-".repeat(40)}\n`
  }
  const offsets = new Map()
  const writeObject = (id, content) => {
    offsets.set(id, Buffer.byteLength(body))
    body += `${id} 0 obj\n${content}\nendobj\n`
  }
  const kids = []
  for (let page = 1; page <= PDF_PAGE_COUNT; page += 1) {
    kids.push(`${pageId(page)} 0 R`)
  }
  writeObject(ids.catalog, `<< /Type /Catalog /Pages ${ids.pages} 0 R >>`)
  writeObject(
    ids.pages,
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${PDF_PAGE_COUNT} /Resources << /Font << /F1 ${ids.font} 0 R >> >> >>`,
  )
  writeObject(ids.font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  for (let page = 1; page <= PDF_PAGE_COUNT; page += 1) {
    const text = escapePdfText(`Cache PDF page ${page} readable text`)
    const content = [
      "BT",
      "/F1 22 Tf",
      "72 720 Td",
      `(${text}) Tj`,
      "0 -32 Td",
      `(Second line ${page}) Tj`,
      "ET",
    ].join("\n")
    writeObject(
      pageId(page),
      `<< /Type /Page /Parent ${ids.pages} 0 R /MediaBox [0 0 612 792] /Contents ${contentId(page)} 0 R >>`,
    )
    writeObject(
      contentId(page),
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    )
  }
  const maxId = contentId(PDF_PAGE_COUNT)
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id += 1) {
    body += `${String(offsets.get(id) ?? 0).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer\n<< /Size ${maxId + 1} /Root ${ids.catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body)
}

function makeComic() {
  const page = readFileSync(path.join(COMIC_TESTDATA, "page1.jpg"))
  const entries = []
  for (let index = 1; index <= COMIC_PAGE_COUNT; index += 1) {
    entries.push({ name: `page${index}.jpg`, data: page })
  }
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

function stopProcess(run) {
  if (run === null || run === undefined) {
    return
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-run.child.pid, "SIGTERM")
    } else {
      run.child.kill("SIGTERM")
    }
  } catch {
    // 已退出。
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

async function ensureServers(cleanup) {
  mkdirSync(TEMP_ROOT, { recursive: true })
  const tempRoot = mkdtempSync(path.join(TEMP_ROOT, "iread-cache-integration-"))
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
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
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
      env: { ...process.env, IREAD_DEV_API: serverBase },
    },
  )
  cleanup.push(() => stopProcess(vite))
  await waitForHttp(`${webBase}/`, 60_000)
  console.log(
    `[CACHE-E2E] 服务 ${serverBase} / ${webBase}，数据 ${tempRoot}`,
  )
  return tempRoot
}

async function uploadBook(api, fileName, contentType, data, format) {
  const intent = await api.post("/api/v1/uploads", {
    clientUploadId: `cache-integration-${Date.now()}-${fileName}`,
    fileName,
    byteSize: data.length,
  })
  assert.ok(
    intent.status === 200 || intent.status === 201,
    `创建上传意图失败：HTTP ${intent.status}`,
  )
  const uploadId = intent.payload?.data?.uploadId
  assert.equal(typeof uploadId, "string")
  const put = await api.request.fetch(
    `${webBase}/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,
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
  assert.equal(put.status(), 200, `上传失败：${JSON.stringify(putPayload)}`)
  const stored = putPayload.data
  const bookId = stored?.bookId ?? stored?.duplicateOfBookId
  assert.equal(typeof bookId, "string")
  const deadline = Date.now() + 90_000
  let detail = null
  while (Date.now() < deadline) {
    const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}`)
    if (response.status === 200) {
      detail = response.payload?.data
      if (detail?.status === "ready") {
        break
      }
      if (detail?.status === "error" || detail?.status === "unsupported") {
        throw new Error(`书籍未就绪：${JSON.stringify(detail)}`)
      }
    }
    await sleep(300)
  }
  assert.equal(detail?.status, "ready", `等待书籍 ready 超时`)
  const manifestResponse = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/manifest`,
  )
  assert.equal(manifestResponse.status, 200)
  const manifest = manifestResponse.payload?.data
  assert.equal(manifest?.format, format)
  return { bookId, manifest, detail }
}

async function readUsage(page) {
  return page.evaluate(async () => {
    const { getReaderCacheUsage } = await import(
      "/src/features/reader/cache/cache-admin.ts"
    )
    return getReaderCacheUsage()
  })
}

async function waitForEpubText(page, needle, timeout = 20_000) {
  await page.waitForFunction(
    (expected) => {
      const view = document.querySelector("[data-reader-epub] foliate-view")
      const contents = view?.renderer?.getContents?.() ?? []
      return (contents[0]?.doc?.body?.innerText ?? "").includes(expected)
    },
    needle,
    { timeout },
  )
}

async function waitForPdfReady(page, timeout = 30_000) {
  await page.locator('.iread-pdf[data-pdf-ready="true"]').waitFor({ timeout })
  await page
    .locator('.iread-pdf__page[data-pdf-page="1"][data-state="ready"]')
    .waitFor({ timeout })
}

async function waitForComicReady(page, timeout = 20_000) {
  await page.locator(".iread-comic-reader").waitFor({ timeout })
  await page
    .locator('.iread-comic-reader__page[data-state="ready"]')
    .first()
    .waitFor({ timeout })
}

async function jumpComic(page, target) {
  const input = page.locator("#reader-jump-page")
  await input.fill(String(target))
  await page.getByRole("button", { name: "跳转", exact: true }).click()
}

async function jumpPdf(page, target) {
  const input = page.locator("#reader-jump-page")
  await input.fill(String(target))
  await page.getByRole("button", { name: "跳转", exact: true }).click()
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const cleanup = []
  const contexts = []
  const apiContexts = []
  let browser = null
  try {
    await ensureServers(cleanup)
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
    const adminRequest = await playwrightRequest.newContext({
      baseURL: webBase,
      storageState,
    })
    apiContexts.push(adminRequest)
    const adminApi = new AuthedApi(adminRequest, webBase)
    await ensureAdmin(adminApi, webBase, E2E_PASSWORD)

    logStep("上传 EPUB / PDF / CBZ 样本")
    const epub = makeEpub()
    const epubBook = await uploadBook(
      adminApi,
      "cache-integration.epub",
      "application/epub+zip",
      epub.data,
      "epub",
    )
    const pdf = buildPdf()
    const pdfBook = await uploadBook(
      adminApi,
      "cache-integration.pdf",
      "application/pdf",
      pdf,
      "pdf",
    )
    const comicBook = await uploadBook(
      adminApi,
      "cache-integration.cbz",
      "application/vnd.comicbook+zip",
      makeComic(),
      "cbz",
    )

    const context = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(context)
    const page = await context.newPage()
    page.on("pageerror", (error) => {
      console.error("[CACHE-E2E][pageerror]", error.message)
    })

    logStep("EPUB：读后用量 > 0，资源断网重开仍可读")
    await page.goto(`/read/${epubBook.bookId}`, {
      waitUntil: "domcontentloaded",
    })
    await page.locator("[data-reader-epub] foliate-view").waitFor({
      timeout: 30_000,
    })
    await waitForEpubText(page, "缓存第一章正文")
    await page.waitForTimeout(500)
    const epubUsage = await readUsage(page)
    assert.ok(
      epubUsage.content.bytes > 0,
      `EPUB 读后 content 用量应 > 0，实际 ${epubUsage.content.bytes}`,
    )
    assert.ok(
      epubUsage.content.entries >= 2,
      `EPUB 应缓存章节及 CSS/图片，实际 ${epubUsage.content.entries} 条`,
    )
    assert.ok(
      epubUsage.cacheNames.some((name) => name.startsWith("iread-content-")),
      "EPUB 应写入受管 CacheStorage",
    )
    console.log(
      `[CACHE-E2E] EPUB usage=${epubUsage.content.bytes}B entries=${epubUsage.content.entries}`,
    )
    await page.route("**/resources/**", (route) => route.abort())
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.locator("[data-reader-epub] foliate-view").waitFor({
      timeout: 30_000,
    })
    await waitForEpubText(page, "缓存第一章正文")
    await page.unroute("**/resources/**")
    console.log("[CACHE-E2E] EPUB 断网重开命中 L3")

    logStep("PDF：读后分块用量 > 0，206/Content-Range，断网重开可读")
    const pdfResponses = []
    const pdfNetwork = (response) => {
      if (response.url().includes("/content")) {
        pdfResponses.push({
          status: response.status(),
          contentRange: response.headers()["content-range"] ?? "",
        })
      }
    }
    page.on("response", pdfNetwork)
    await page.goto(`/read/${pdfBook.bookId}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForPdfReady(page)
    await jumpPdf(page, 5)
    await page
      .locator('.iread-pdf__page[data-pdf-page="5"][data-state="ready"]')
      .waitFor({ timeout: 30_000 })
    await page.waitForTimeout(500)
    const pdfUsage = await readUsage(page)
    assert.ok(
      pdfUsage.pdfChunks.bytes > 0,
      `PDF 读后 pdfChunks 用量应 > 0，实际 ${pdfUsage.pdfChunks.bytes}`,
    )
    assert.ok(
      pdfUsage.pdfChunks.entries > 0,
      "PDF 应有 64KiB 分块记录",
    )
    const pdfChunks = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("iread-reader-cache")
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            if (!db.objectStoreNames.contains("pdfChunks")) {
              db.close()
              resolve([])
              return
            }
            const tx = db.transaction("pdfChunks", "readonly")
            const all = tx.objectStore("pdfChunks").getAll()
            all.onsuccess = () => {
              db.close()
              resolve(
                all.result.map((record) => ({
                  byteLength: record.byteLength,
                  start: record.start,
                  end: record.end,
                })),
              )
            }
            all.onerror = () => reject(all.error)
          }
        }),
    )
    assert.ok(pdfChunks.length > 0, "PDF 分块表不应为空")
    assert.ok(
      pdfChunks.every((chunk) => chunk.byteLength <= 65_536),
      `PDF 不得缓存完整 200 响应：${JSON.stringify(pdfChunks.slice(0, 3))}`,
    )
    const pdfContentResponses = pdfResponses.filter(
      (entry) => entry.status > 0,
    )
    assert.ok(
      pdfContentResponses.some(
        (entry) => entry.status === 206 && entry.contentRange.includes("/"),
      ),
      "PDF 必须观察到 206 + Content-Range",
    )
    assert.equal(
      pdfContentResponses.some((entry) => entry.status === 200),
      false,
      "PDF 原件读取不得出现 200 完整响应",
    )
    console.log(
      `[CACHE-E2E] PDF usage=${pdfUsage.pdfChunks.bytes}B chunks=${pdfUsage.pdfChunks.entries}`,
    )

    await page.route("**/content", (route) => route.abort())
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.locator('.iread-pdf[data-pdf-ready="true"]').waitFor({
      timeout: 30_000,
    })
    await page
      .locator('.iread-pdf__page[data-state="ready"]')
      .first()
      .waitFor({ timeout: 30_000 })
    await page.unroute("**/content")
    page.off("response", pdfNetwork)
    console.log("[CACHE-E2E] PDF 断网重开命中 L3 分块")

    logStep("漫画：读后用量 > 0，快速跳页旧响应不覆盖，断网重开可读")
    await page.goto(`/read/${comicBook.bookId}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForComicReady(page)
    const comicPages = comicBook.manifest.formatData.pages
    const pageSix = comicPages.find((entry) => entry.page === 6)
    assert.ok(pageSix, "漫画清单缺少第 6 页")
    let releasePageSix = () => undefined
    const pageSixRequested = new Promise((resolve) => {
      releasePageSix = resolve
    })
    await page.route(`**/resources/${pageSix.resourceId}*`, async (route) => {
      releasePageSix()
      await sleep(1_500)
      await route.continue().catch(() => undefined)
    })
    await jumpComic(page, 6)
    await pageSixRequested
    await jumpComic(page, 9)
    await page.waitForFunction(
      () =>
        document
          .querySelector(".iread-comic-reader")
          ?.getAttribute("data-current-page") === "9",
      undefined,
      { timeout: 15_000 },
    )
    await page.waitForTimeout(2_000)
    assert.equal(
      await page
        .locator(".iread-comic-reader")
        .getAttribute("data-current-page"),
      "9",
      "快速跳页后旧页响应不得覆盖当前页",
    )
    const visibleAlt =
      (await page
        .locator('.iread-comic-reader__page[data-current="true"] img')
        .first()
        .getAttribute("alt")) ?? ""
    assert.match(visibleAlt, /第 9 页/, `当前页图片应为第 9 页，实际 ${visibleAlt}`)
    await page.unroute(`**/resources/${pageSix.resourceId}*`)
    const comicUsage = await readUsage(page)
    assert.ok(
      comicUsage.content.bytes > 0,
      `漫画读后 content 用量应 > 0，实际 ${comicUsage.content.bytes}`,
    )
    assert.ok(
      comicUsage.content.entries >= 2,
      "漫画至少应缓存当前页与预取邻页",
    )
    console.log(
      `[CACHE-E2E] 漫画 usage=${comicUsage.content.bytes}B entries=${comicUsage.content.entries}`,
    )
    await page.route("**/resources/**", (route) => route.abort())
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForComicReady(page)
    await page.unroute("**/resources/**")
    console.log("[CACHE-E2E] 漫画断网重开命中 L3 页")

    logStep("设置页：三类用量真实展示，清理后归零，设备偏好保留")
    await page.evaluate(() => {
      window.localStorage.setItem(
        "iread.device-preferences.v1",
        JSON.stringify({ schemaVersion: 1, preloadProfile: "fast" }),
      )
    })
    await page.goto("/settings?group=cache", {
      waitUntil: "domcontentloaded",
    })
    await page
      .getByRole("heading", { level: 2, name: "本机阅读缓存" })
      .waitFor({ timeout: 15_000 })
    const usageText =
      (await page.getByTestId("browser-cache-usage").innerText()) ?? ""
    assert.doesNotMatch(usageText, /精确测量总量\s*0 B/, "阅读后用量不应为 0")
    const breakdownText =
      (await page.locator(".iread-cache-breakdown").innerText()) ?? ""
    assert.match(breakdownText, /正文\/章节内容/, "设置页应展示正文/章节缓存")
    assert.match(breakdownText, /PDF 分块/, "设置页应展示 PDF 分块缓存")
    await page.getByTestId("browser-cache-clear").click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "确认清理" })
      .click()
    await page.getByTestId("browser-cache-result").waitFor({ timeout: 20_000 })
    await page.getByText("本机阅读缓存已清理").waitFor({ timeout: 10_000 })
    await page.waitForFunction(
      () => {
        const text =
          document.querySelector('[data-testid="browser-cache-usage"]')
            ?.textContent ?? ""
        return text.includes("0 B")
      },
      undefined,
      { timeout: 15_000 },
    )
    const cleared = await page.evaluate(async () => {
      const managed = (await caches.keys()).filter(
        (name) =>
          name.startsWith("iread-content-") ||
          name.startsWith("iread-pdf-"),
      )
      return {
        managed,
        preference: window.localStorage.getItem(
          "iread.device-preferences.v1",
        ),
      }
    })
    assert.deepEqual(cleared.managed, [], "清理后受管内容缓存应为空")
    assert.ok(
      cleared.preference?.includes('"fast"'),
      "清理不得删除设备预加载偏好",
    )
    const usageAfter = await readUsage(page)
    assert.equal(usageAfter.totalMeasured.bytes, 0)
    assert.equal(usageAfter.content.entries, 0)
    assert.equal(usageAfter.pdfChunks.entries, 0)
    console.log("[CACHE-E2E] 清理后 usage=0，设备偏好保留")

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "cache-cleared.png"),
    })
    console.log("\n[CACHE-E2E] 缓存集成测试全部通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      await context.dispose().catch(() => {})
    }
    await browser?.close().catch(() => {})
    for (const dispose of cleanup) {
      dispose()
    }
  }
}

main().catch((error) => {
  console.error("\n[CACHE-E2E] 失败：", error)
  process.exitCode = 1
})
