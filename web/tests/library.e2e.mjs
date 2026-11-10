#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"

import { chromium, request as playwrightRequest } from "playwright"

import {
  AuthedApi,
  E2E_PASSWORD,
  E2EBlocked,
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
)
const SAMPLE_DIR = mkdtempSync(path.join(tmpdir(), "iread-e2e-library-"))

function url(pathname) {
  return `${BASE_URL}${pathname}`
}

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildPdf(text) {
  const escaped = text.replace(/[\\()]/g, "\\$&")
  const content = `BT /F1 12 Tf 20 100 Td (${escaped}) Tj ET`
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ]
  let body = "%PDF-1.4\n"
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body))
    body += object
  }
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body)
}

function zipFiles(target, cwd, files, options = []) {
  execFileSync("zip", ["-X", ...options, target, ...files], {
    cwd,
    stdio: "ignore",
  })
}


function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

// 生成大尺寸但压缩很小的封面，让真实任务在 cover 阶段有可观察的耗时。
function writeSlowCover(target, width = 6000, height = 6000) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rowBytes = 1 + width * 3
  const raw = Buffer.alloc(rowBytes * height)
  const row = Buffer.alloc(rowBytes)
  row[0] = 0
  row.fill(140, 1)
  for (let y = 0; y < height; y += 1) {
    row[1] = y & 0xff
    row.copy(raw, y * rowBytes)
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
  writeFileSync(target, png)
}

function makeSlowEpubs(stamp, count = 5) {
  const cover = path.join(SAMPLE_DIR, "slow-cover.png")
  writeSlowCover(cover)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    const dir = path.join(SAMPLE_DIR, `slow-${index}`)
    mkdirSync(path.join(dir, "META-INF"), { recursive: true })
    mkdirSync(path.join(dir, "OEBPS"), { recursive: true })
    writeFileSync(path.join(dir, "mimetype"), "application/epub+zip")
    writeFileSync(
      path.join(dir, "META-INF/container.xml"),
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    )
    writeFileSync(path.join(dir, "OEBPS/cover.png"), readFileSync(cover))
    const title = `Slow E2E ${stamp} ${index}`
    writeFileSync(
      path.join(dir, "OEBPS/content.opf"),
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title><dc:creator>iRead E2E</dc:creator>
    <dc:identifier id="id">urn:uuid:${stamp}-${index}</dc:identifier><dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
    )
    writeFileSync(
      path.join(dir, "OEBPS/chapter1.xhtml"),
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Slow</title></head><body><h1>${title}</h1></body></html>`,
    )
    const file = path.join(SAMPLE_DIR, `slow-${index}.epub`)
    zipFiles(file, dir, ["mimetype"], ["-0"])
    zipFiles(file, dir, ["META-INF", "OEBPS"], ["-9", "-r"])
    entries.push({ file, fileName: `slow-${index}.epub`, title })
  }
  return entries
}

function makeSamples() {
  const stamp = new Date().toISOString()

  const epubDir = path.join(SAMPLE_DIR, "epub")
  mkdirSync(path.join(epubDir, "META-INF"), { recursive: true })
  mkdirSync(path.join(epubDir, "OEBPS"), { recursive: true })
  writeFileSync(
    path.join(epubDir, "mimetype"),
    "application/epub+zip",
  )
  writeFileSync(
    path.join(epubDir, "META-INF/container.xml"),
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  )
  writeFileSync(
    path.join(epubDir, "OEBPS/content.opf"),
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>E2E EPUB ${stamp}</dc:title>
    <dc:creator>iRead E2E</dc:creator>
    <dc:identifier id="id">urn:uuid:${stamp}</dc:identifier>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
  )
  writeFileSync(
    path.join(epubDir, "OEBPS/chapter1.xhtml"),
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>E2E</title></head><body><h1>E2E EPUB</h1><p>${stamp}</p></body></html>`,
  )
  const epub = path.join(SAMPLE_DIR, "e2e.epub")
  zipFiles(epub, epubDir, ["mimetype"], ["-0"])
  zipFiles(epub, epubDir, ["META-INF", "OEBPS"], ["-9", "-r"])

  const pdf = path.join(SAMPLE_DIR, "e2e.pdf")
  writeFileSync(pdf, buildPdf(`iRead E2E PDF ${stamp}`))

  const cbzDir = path.join(SAMPLE_DIR, "cbz")
  mkdirSync(cbzDir, { recursive: true })
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  )
  writeFileSync(path.join(cbzDir, "001.png"), png)
  writeFileSync(path.join(cbzDir, "002.png"), png)
  writeFileSync(path.join(cbzDir, "note.txt"), stamp)
  const cbz = path.join(SAMPLE_DIR, "e2e.cbz")
  zipFiles(cbz, cbzDir, ["001.png", "002.png", "note.txt"], ["-0"])

  const retryPdf = path.join(SAMPLE_DIR, "retry.pdf")
  writeFileSync(retryPdf, buildPdf(`iRead E2E retry ${stamp}`))

  const cancelPdf = path.join(SAMPLE_DIR, "cancel.pdf")
  writeFileSync(cancelPdf, buildPdf(`iRead E2E cancel ${stamp}`))
  const slow = makeSlowEpubs(stamp)

  return {
    epub,
    pdf,
    cbz,
    retryPdf,
    cancelPdf,
    slow,
    names: {
      epub: "e2e.epub",
      pdf: "e2e.pdf",
      cbz: "e2e.cbz",
      retryPdf: "retry.pdf",
      cancelPdf: "cancel.pdf",
    },
  }
}

async function waitForLibrary(page, timeout = 15000) {
  await page
    .getByRole("heading", { level: 1, name: "书库" })
    .waitFor({ timeout })
}

async function openUpload(page) {
  await page
    .locator(".iread-topbar")
    .getByRole("button", { name: "上传图书", exact: true })
    .click()
  await page.getByRole("dialog", { name: "上传图书" }).waitFor({
    timeout: 5000,
  })
}

async function selectFiles(page, files) {
  await page.locator('input[type="file"]').setInputFiles(files)
}

async function main() {
  const samples = makeSamples()
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox"],
  })
  const contexts = []
  const apiContexts = []

  try {
    const probe = await playwrightRequest.newContext({ baseURL: BASE_URL })
    apiContexts.push(probe)
    const probeApi = new AuthedApi(probe, BASE_URL)
    const status = await probeApi.fetchStatus()
    if (!status.initialized) {
      logStep("首次初始化管理员（E2E 专用数据库）")
      const setupContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      })
      contexts.push(setupContext)
      const setupPage = await setupContext.newPage()
      await setupPage.goto(url("/"), { waitUntil: "domcontentloaded" })
      await setupPage
        .getByRole("heading", { level: 1, name: "初始化 iRead" })
        .waitFor({ timeout: 10000 })
      await setupPage
        .getByLabel("密码", { exact: true })
        .fill(E2E_PASSWORD)
      await setupPage
        .getByLabel("确认密码", { exact: true })
        .fill(E2E_PASSWORD)
      await setupPage
        .getByRole("button", { name: "设置密码并进入" })
        .click()
      await setupPage
        .getByRole("heading", { level: 1, name: "首页" })
        .waitFor({ timeout: 15000 })
      await setupContext.close()
      contexts.splice(contexts.indexOf(setupContext), 1)
      console.log("[E2E] 管理员初始化通过")
    }

    logStep("登录并探测书库/上传路由")
    const storageState = await createAuthenticatedStorageState(
      browser,
      BASE_URL,
      E2E_PASSWORD,
    )
    const adminRequest = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState,
    })
    apiContexts.push(adminRequest)
    const adminApi = new AuthedApi(adminRequest, BASE_URL)
    await ensureAdmin(adminApi, BASE_URL, E2E_PASSWORD)

    const booksProbe = await adminApi.get("/api/v1/books?limit=1")
    if (booksProbe.status === 404) {
      throw new E2EBlocked(
        `书库路由未注册：GET /api/v1/books 返回 404 ${JSON.stringify(
          booksProbe.payload,
        )}；server/internal/httpapi/server.go 的 library 路由集成点尚未接线。`,
      )
    }
    assert.equal(
      booksProbe.status,
      200,
      `GET /api/v1/books 应返回 200，实际 ${booksProbe.status}`,
    )
    const initialLibrary = booksProbe.payload?.data ?? []
    assert.ok(Array.isArray(initialLibrary), "书库响应 data 必须是数组")

    const uploadsProbe = await adminApi.post("/api/v1/uploads", {
      clientUploadId: `probe-${Date.now()}`,
      fileName: "probe.epub",
      byteSize: 1,
    })
    if (uploadsProbe.status === 404) {
      throw new E2EBlocked(
        `上传路由未注册：POST /api/v1/uploads 返回 404 ${JSON.stringify(
          uploadsProbe.payload,
        )}`,
      )
    }
    if (
      (uploadsProbe.status === 200 || uploadsProbe.status === 201) &&
      typeof uploadsProbe.payload?.data?.uploadId === "string"
    ) {
      await adminApi.post(
        `/api/v1/uploads/${encodeURIComponent(
          uploadsProbe.payload.data.uploadId,
        )}/cancel`,
      )
    }

    logStep("书库空态/真实分页字段（如当前库非空则记录跳过空态）")
    const desktopContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(desktopContext)
    const page = await desktopContext.newPage()
    page.on("pageerror", (error) => {
      console.error("[E2E][pageerror]", error)
    })
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error("[E2E][console]", message.text())
      }
    })
    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await waitForLibrary(page)

    if (initialLibrary.length === 0) {
      await page.goto(url("/"), { waitUntil: "domcontentloaded" })
      await page
        .getByText("从第一本书开始", { exact: true })
        .waitFor({ timeout: 15000 })
      await page
        .getByRole("button", { name: "上传图书", exact: true })
        .first()
        .waitFor()
      await page
        .getByRole("link", { name: "查看书库", exact: true })
        .waitFor()
      await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
      await waitForLibrary(page)
      await page
        .getByText("书库还没有图书", { exact: true })
        .waitFor({ timeout: 10000 })
      assert.equal(
        await page.getByText("没有匹配的图书", { exact: true }).count(),
        0,
        "阶段2 无筛选，不得伪造筛选空态",
      )
    } else {
      console.log(
        `[E2E] 当前库已有 ${initialLibrary.length} 本，空库断言跳过（非伪造通过）`,
      )
    }

    logStep("上传 3 个真实样本并等待真实保存/整理状态")
    await page.route("**/api/v1/uploads/*/content", async (route) => {
      await sleep(700)
      await route.continue().catch(() => {})
    })
    await openUpload(page)
    await selectFiles(page, [samples.epub, samples.pdf, samples.cbz])
    for (const name of [
      samples.names.epub,
      samples.names.pdf,
      samples.names.cbz,
    ]) {
      await page.getByText(name, { exact: true }).waitFor({ timeout: 10000 })
    }
    const uploadDialog = page.getByRole("dialog", { name: "上传图书" })
    await page
      .getByText(/上传中|验证 \/ 整理中/)
      .first()
      .waitFor({ timeout: 15000 })
    assert.equal(
      await uploadDialog.getByText("可阅读", { exact: false }).count(),
      0,
      "上传面板不得把网络完成说成可阅读",
    )
    for (const name of [
      samples.names.epub,
      samples.names.pdf,
      samples.names.cbz,
    ]) {
      const row = page
        .locator("[data-slot='item']")
        .filter({ hasText: name })
        .first()
      try {
        await row.getByText("已保存", { exact: false }).waitFor({
          timeout: 60000,
        })
      } catch (error) {
        await page.screenshot({
          path: "/tmp/opencode/iread-upload-failure.png",
          fullPage: true,
        })
        console.error(
          "[E2E][upload rows]",
          await page.locator("[data-slot='item']").allInnerTexts(),
        )
        throw error
      }
    }
    await page.unroute("**/api/v1/uploads/*/content")

    await page.keyboard.press("Escape")
    await uploadDialog.waitFor({ state: "hidden", timeout: 5000 })
    await page
      .locator(".iread-topbar")
      .getByRole("button", { name: "上传图书", exact: true })
      .click()
    for (const name of [
      samples.names.epub,
      samples.names.pdf,
      samples.names.cbz,
    ]) {
      await page.getByText(name, { exact: true }).waitFor({ timeout: 10000 })
    }
    console.log("[E2E] 关闭再打开后上传记录仍在")
    await page.keyboard.press("Escape")

    logStep("等待书库真实出现并打开详情")
    let libraryBooks = []
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const result = await adminApi.get("/api/v1/books?limit=100")
      libraryBooks = result.payload?.data ?? []
      if (libraryBooks.length >= initialLibrary.length + 3) {
        break
      }
      await sleep(500)
    }
    assert.ok(
      libraryBooks.length >= initialLibrary.length + 3,
      `上传后书库应增加至少 3 本，实际 ${libraryBooks.length}`,
    )

    await page.goto(url("/"), { waitUntil: "domcontentloaded" })
    await page
      .getByText("最近添加", { exact: true })
      .waitFor({ timeout: 15000 })
    assert.ok(
      (await page.locator(".iread-book-card").count()) > 0,
      "首页应显示真实最近添加图书",
    )
    assert.equal(
      await page.getByText("继续阅读", { exact: true }).count(),
      0,
      "阶段2无真实阅读进度时不得显示继续阅读",
    )
    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await waitForLibrary(page)
    const firstBook = libraryBooks.find(
      (book) => book.title.includes("E2E EPUB"),
    )
    assert.ok(firstBook, "书库中应出现 E2E EPUB")
    await page
      .getByRole("link")
      .filter({ hasText: firstBook.title })
      .first()
      .click()
    await page
      .getByRole("heading", { level: 1, name: firstBook.title })
      .waitFor({ timeout: 10000 })
    if (firstBook.status === "ready") {
      const startLink = page.getByRole("link", {
        name: "开始阅读",
        exact: true,
      })
      await startLink.waitFor({ timeout: 10000 })
      assert.match(
        (await startLink.getAttribute("href")) ?? "",
        /^\/read\/[^/]+$/,
        "canRead=true 时必须进入真实阅读器路由",
      )
    }

    logStep("重复文件提示并链接已有书籍")
    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await openUpload(page)
    await selectFiles(page, [samples.epub])
    const duplicateRow = page
      .locator("[data-slot='item']")
      .filter({ hasText: samples.names.epub })
      .last()
    await duplicateRow
      .getByText("书库中已有此文件", { exact: true })
      .waitFor({ timeout: 30000 })
    const detailLink = duplicateRow.getByRole("link", { name: "查看详情" })
    await detailLink.waitFor({ timeout: 5000 })
    assert.match(
      await detailLink.getAttribute("href"),
      /^\/books\//,
      "重复文件必须链接到已有书籍详情",
    )
    await page.keyboard.press("Escape")

    logStep("单项网络失败后重试（真实上传文件）")
    await openUpload(page)
    let failedOnce = false
    await page.route("**/api/v1/uploads/*/content", async (route) => {
      if (!failedOnce) {
        failedOnce = true
        await route.abort("failed")
        return
      }
      await route.continue()
    })
    await selectFiles(page, [samples.retryPdf])
    await page.getByText(samples.names.retryPdf, { exact: true }).waitFor({
      timeout: 10000,
    })
    await page
      .getByText("上传失败", { exact: true })
      .first()
      .waitFor({ timeout: 20000 })
    await page.unroute("**/api/v1/uploads/*/content")
    const retryRow = page
      .locator("[data-slot='item']")
      .filter({ hasText: samples.names.retryPdf })
      .first()
    await retryRow.getByRole("button", { name: "重试" }).click()
    await retryRow
      .getByText("已保存", { exact: false })
      .waitFor({ timeout: 60000 })
    console.log("[E2E] 单项失败重试通过")
    await page.keyboard.press("Escape")

    logStep("取消上传（与取消整理分开）")
    await openUpload(page)
    await page.route("**/api/v1/uploads/*/content", async (route) => {
      await sleep(2500)
      await route.continue().catch(() => {})
    })
    await selectFiles(page, [samples.cancelPdf])
    const cancelRow = page
      .locator("[data-slot='item']")
      .filter({ hasText: samples.names.cancelPdf })
      .first()
    await cancelRow
      .getByRole("button", { name: "取消上传" })
      .click({ timeout: 10000 })
    await cancelRow
      .getByText("已取消", { exact: false })
      .waitFor({ timeout: 20000 })
    await page.unroute("**/api/v1/uploads/*/content")
    console.log("[E2E] 上传取消通过")
    await page.keyboard.press("Escape")

    logStep("整理任务：真实进度、取消与重试")
    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await waitForLibrary(page)
    await openUpload(page)
    await selectFiles(
      page,
      samples.slow.map((entry) => entry.file),
    )
    for (const entry of samples.slow) {
      await page.getByText(entry.fileName, { exact: true }).waitFor({
        timeout: 10000,
      })
    }
    await page.keyboard.press("Escape")

    let slowBook = null
    const taskDeadline = Date.now() + 30000
    while (Date.now() < taskDeadline) {
      const result = await adminApi.get("/api/v1/books?limit=100")
      slowBook = (result.payload?.data ?? []).find(
        (book) =>
          book.title.startsWith("Slow E2E") &&
          book.status === "indexing",
      )
      if (slowBook !== undefined) {
        break
      }
      await sleep(100)
    }
    assert.ok(slowBook, "应出现正在整理的真实慢速书籍")
    await page.goto(url(`/books/${slowBook.bookId}`), {
      waitUntil: "domcontentloaded",
    })
    await page.getByText("正在整理", { exact: true }).waitFor({
      timeout: 15000,
    })
    await page.getByText(/^阶段：/).waitFor({ timeout: 15000 })
    console.log("[E2E] 详情显示真实任务阶段")

    const cancelTrigger = page.getByRole("button", {
      name: "取消整理",
      exact: true,
    })
    await cancelTrigger.waitFor({ timeout: 10000 })
    await cancelTrigger.click()
    const cancelDialog = page.getByRole("alertdialog")
    await cancelDialog.waitFor({ timeout: 5000 })
    await cancelDialog
      .getByRole("button", { name: "取消整理", exact: true })
      .click()
    await page
      .getByText("已请求取消整理，正在等待服务器完成。", {
        exact: true,
      })
      .waitFor({ timeout: 10000 })
    await page
      .getByText("整理已取消，可以重试。", { exact: true })
      .waitFor({ timeout: 30000 })
    console.log("[E2E] 整理任务取消通过")

    await page
      .getByRole("button", { name: "重试整理", exact: true })
      .click()
    await page
      .getByText("已重新提交整理任务。", { exact: true })
      .waitFor({ timeout: 10000 })
    await page
      .getByText("已整理完成", { exact: true })
      .waitFor({ timeout: 60000 })
    const retriedStartLink = page.getByRole("link", {
      name: "开始阅读",
      exact: true,
    })
    await retriedStartLink.waitFor({ timeout: 10000 })
    assert.match(
      (await retriedStartLink.getAttribute("href")) ?? "",
      /^\/read\/[^/]+$/,
      "重试成功后可阅读图书必须显示真实阅读入口",
    )
    const detailCover = page.locator(".iread-book-cover__image").first()
    await detailCover.waitFor({ timeout: 10000 })
    await page.waitForFunction(
      () => {
        const image = document.querySelector(
          ".iread-book-cover__image",
        )
        return (
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0
        )
      },
      undefined,
      { timeout: 10000 },
    )
    const coverSrc = await detailCover.getAttribute("src")
    assert.match(coverSrc ?? "", /variant=detail/)
    assert.match(coverSrc ?? "", /v=[0-9]+/)
    console.log("[E2E] 整理任务重试、最终状态与真实封面通过")

    logStep("服务错误 Alert+重试（前端错误路径，非假空库）")
    const errorContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(errorContext)
    const errorPage = await errorContext.newPage()
    await errorPage.route("**/api/v1/books?limit=24", async (route) => {
      await route.fulfill({
        status: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: {
            code: "storage_unavailable",
            message: "存储暂时不可用",
            requestId: "e2e-storage",
            details: {},
          },
        }),
      })
    })
    await errorPage.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await errorPage
      .getByText("无法加载书库", { exact: true })
      .waitFor({ timeout: 10000 })
    assert.equal(
      await errorPage.getByText("书库还没有图书", { exact: true }).count(),
      0,
      "服务错误不得显示为空库",
    )
    await errorPage.unroute("**/api/v1/books?limit=24")
    await errorPage.getByRole("button", { name: "重试" }).click()
    await errorPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 10000 })

    logStep("手机 390x844：无横向溢出、Drawer 上传面板")
    const mobileContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(mobileContext)
    const mobilePage = await mobileContext.newPage()
    await mobilePage.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await mobilePage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 10000 })
    const overflow = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    assert.ok(overflow <= 1, `手机书库横向溢出 ${overflow}px`)
    await mobilePage
      .locator(".iread-topbar")
      .getByRole("button", { name: "上传图书", exact: true })
      .click()
    await mobilePage.locator("[data-slot='drawer-content']").waitFor({
      timeout: 5000,
    })
    const drawerOverflow = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    assert.ok(drawerOverflow <= 1, `手机上传 Drawer 横向溢出 ${drawerOverflow}px`)
    await mobilePage.keyboard.press("Escape")

    logStep("退出后受保护书库不可读")
    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await page.getByRole("button", { name: "退出登录" }).click()
    await page
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 10000 })
    const afterLogout = await page.evaluate(async () => {
      const response = await fetch("/api/v1/books?limit=1", {
        credentials: "same-origin",
      })
      return response.status
    })
    assert.equal(afterLogout, 401, "退出后书库 API 必须返回 401")

    console.log("\n[E2E] 书库/上传全部通过")
  } finally {
    rmSync(SAMPLE_DIR, { recursive: true, force: true })
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      await context.dispose().catch(() => {})
    }
    await browser.close().catch(() => {})
  }
}

main().catch((error) => {
  if (error instanceof E2EBlocked) {
    console.error(`\n[E2E] BLOCKED：${error.message}`)
    process.exitCode = 2
    return
  }
  console.error("\n[E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
