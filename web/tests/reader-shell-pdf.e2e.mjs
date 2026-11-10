#!/usr/bin/env node

/**
 * 真实 PDF 共享 Shell E2E：
 * 临时 Go 服务 + Vite + 真实多页 PDF 上传，经 /read/:id 验证 Canvas、文字层、
 * 翻页、缩放、布局、搜索、PDF 内置目录、跳页、书签创建/跳转/If-Match 删除、
 * locator 恢复、旋转、Range 206、409/加密错误与手机 Drawer。
 */

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
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
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
let serverPort = Number(process.env.IREAD_E2E_SERVER_PORT ?? "18090")
let webPort = Number(process.env.IREAD_E2E_WEB_PORT ?? "18091")
let serverBase = `http://127.0.0.1:${serverPort}`
let webBase = `http://127.0.0.1:${webPort}`
const SCREENSHOT_DIR =
  process.env.READER_SHELL_PDF_SCREENSHOT_DIR ??
  path.join("/tmp/opencode", "iread-reader-shell-pdf-screenshots")
const TEMP_ROOT = process.env.IREAD_E2E_TMP ?? "/tmp/opencode"
const PAGE_COUNT = 12
const PDF_PADDING_LINES = 420

function logStep(name) {
  console.log(`\n[PDF-SHELL-E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapePdfText(value) {
  return value.replace(/[\\()]/g, "\\$&")
}

/**
 * 生成真实多页 PDF：包含可搜索文字、两章内置目录与页内链接，并在对象前
 * 写入约 420KB 注释填充，确保远跳必须通过真实 Range 而不是整本下载。
 */
function buildPdf({ encrypted = false } = {}) {
  const ids = {
    catalog: 1,
    pages: 2,
    font: 3,
    outlineRoot: 100,
    outlineOne: 101,
    outlineTwo: 102,
    encrypt: 200,
  }
  const pageId = (page) => 10 + page
  const contentId = (page) => 30 + page
  let body = "%PDF-1.4\n"
  for (let line = 0; line < PDF_PADDING_LINES; line += 1) {
    body += `%${"padding-".repeat(125)}\n`
  }
  const offsets = new Map()

  const writeObject = (id, content) => {
    offsets.set(id, Buffer.byteLength(body))
    body += `${id} 0 obj\n${content}\nendobj\n`
  }

  const kids = []
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    kids.push(`${pageId(page)} 0 R`)
  }

  writeObject(
    ids.catalog,
    `<< /Type /Catalog /Pages ${ids.pages} 0 R /Outlines ${ids.outlineRoot} 0 R /PageMode /UseOutlines >>`,
  )
  writeObject(
    ids.pages,
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${PAGE_COUNT} /Resources << /Font << /F1 ${ids.font} 0 R >> >> >>`,
  )
  writeObject(
    ids.font,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  )

  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const text = escapePdfText(`iRead PDF page ${page} searchable keyword`)
    const content = [
      ...Array.from({ length: 40 }, () => `%${"page-padding-".repeat(84)}`),
      "BT",
      "/F1 22 Tf",
      "72 720 Td",
      `(${text}) Tj`,
      "0 -32 Td",
      `(Second line for page ${page}) Tj`,
      "ET",
    ].join("\n")
    const annotation =
      page === 1
        ? ` /Annots [<< /Type /Annot /Subtype /Link /Rect [72 690 430 725] /Border [0 0 0] /Dest [${pageId(3)} 0 R /XYZ 0 740 null] >>]`
        : ""
    writeObject(
      pageId(page),
      `<< /Type /Page /Parent ${ids.pages} 0 R /MediaBox [0 0 612 792] /Contents ${contentId(page)} 0 R${annotation} >>`,
    )
    writeObject(
      contentId(page),
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    )
  }

  writeObject(
    ids.outlineRoot,
    `<< /Type /Outlines /First ${ids.outlineOne} 0 R /Last ${ids.outlineTwo} 0 R /Count 2 >>`,
  )
  writeObject(
    ids.outlineOne,
    `<< /Title (Chapter One) /Parent ${ids.outlineRoot} 0 R /Dest [${pageId(1)} 0 R /XYZ 0 792 null] /Next ${ids.outlineTwo} 0 R >>`,
  )
  writeObject(
    ids.outlineTwo,
    `<< /Title (Chapter Two) /Parent ${ids.outlineRoot} 0 R /Dest [${pageId(3)} 0 R /XYZ 0 792 null] >>`,
  )
  if (encrypted) {
    writeObject(
      ids.encrypt,
      "<< /Type /Encrypt /Filter /Standard /V 1 /R 2 /O (iread) /U (iread) /P -4 >>",
    )
  }

  const maxId = encrypted ? ids.encrypt : ids.outlineTwo
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets.get(id)
    body += offset === undefined
      ? "0000000000 65535 f \n"
      : `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  const encryptClause = encrypted ? ` /Encrypt ${ids.encrypt} 0 R` : ""
  body += `trailer\n<< /Size ${maxId + 1} /Root ${ids.catalog} 0 R${encryptClause} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body)
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
  if (run === undefined || run === null) {
    return
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-run.child.pid, "SIGTERM")
    } else {
      run.child.kill("SIGTERM")
    }
  } catch {
    try {
      run.child.kill("SIGTERM")
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

async function buildServerBinary(tempRoot) {
  const binary = path.join(tempRoot, "iread-server")
  const build = startProcess(
    "go",
    ["build", "-o", binary, "./cmd/iread"],
    {
      cwd: path.join(REPO_ROOT, "server"),
      env: { ...process.env, GOFLAGS: "-buildvcs=false" },
    },
  )
  const code = await new Promise((resolve) => {
    build.child.once("exit", (value) => resolve(value ?? 1))
  })
  if (code !== 0) {
    throw new Error(`构建临时 Go 服务失败：\n${build.output()}`)
  }
  return binary
}

async function ensureServers(cleanup) {
  const tempRoot = mkdtempSync(path.join(TEMP_ROOT, "iread-shell-pdf-e2e-"))
  const dirs = {
    books: path.join(tempRoot, "books"),
    db: path.join(tempRoot, "db"),
    cache: path.join(tempRoot, "cache"),
    web: path.join(tempRoot, "web"),
  }
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(
    path.join(dirs.web, "index.html"),
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  )

  if (await httpReachable(`${serverBase}/healthz`)) {
    serverPort = await findFreePort(serverPort + 100)
    serverBase = `http://127.0.0.1:${serverPort}`
    webPort = await findFreePort(webPort + 100)
    webBase = `http://127.0.0.1:${webPort}`
    console.log(`[E2E] 首选端口已被占用，改用临时端口 ${serverPort}/${webPort}`)
  }
  if (!(await portFree(serverPort))) {
    serverPort = await findFreePort(serverPort + 100)
    serverBase = `http://127.0.0.1:${serverPort}`
  }
  if (!(await portFree(webPort))) {
    webPort = await findFreePort(webPort + 100)
    webBase = `http://127.0.0.1:${webPort}`
  }
  if (webPort === serverPort) {
    webPort = await findFreePort(webPort + 1)
    webBase = `http://127.0.0.1:${webPort}`
  }

  const serverBinary = await buildServerBinary(tempRoot)
  const server = startProcess(serverBinary, [], {
    cwd: path.join(REPO_ROOT, "server"),
    env: {
      ...process.env,
      GOFLAGS: "-buildvcs=false",
      IREAD_ADDR: `127.0.0.1:${serverPort}`,
      IREAD_PUBLIC_ORIGIN: webBase,
      IREAD_BOOKS_DIR: dirs.books,
      IREAD_DB_DIR: dirs.db,
      IREAD_CACHE_DIR: dirs.cache,
      IREAD_WEB_DIR: dirs.web,
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
  cleanup.push(() => rmSync(tempRoot, { recursive: true, force: true }))
  console.log(`[E2E] 临时 Go 服务 ${serverBase}，Vite ${webBase}，数据 ${tempRoot}`)
}

async function waitForTask(api, taskId) {
  if (typeof taskId !== "string" || taskId.length === 0) {
    return null
  }
  const deadline = Date.now() + 90_000
  let last = null
  while (Date.now() < deadline) {
    const response = await api.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
    if (response.status === 200) {
      last = response.payload?.data
      const state = last?.state
      if (state === "succeeded") {
        return last
      }
      if (state === "failed" || state === "cancelled") {
        throw new Error(`索引任务终态 ${state}：${JSON.stringify(last)}`)
      }
    }
    await sleep(250)
  }
  throw new Error(`索引任务未在 90 秒内成功：${JSON.stringify(last)}`)
}

async function waitForTaskTerminal(api, taskId) {
  if (typeof taskId !== "string" || taskId.length === 0) {
    return null
  }
  const deadline = Date.now() + 90_000
  let last = null
  while (Date.now() < deadline) {
    const response = await api.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
    if (response.status === 200) {
      last = response.payload?.data
      const state = last?.state
      if (
        state === "succeeded" ||
        state === "failed" ||
        state === "cancelled"
      ) {
        return last
      }
    }
    await sleep(250)
  }
  throw new Error(`索引任务未在 90 秒内进入终态：${JSON.stringify(last)}`)
}

async function uploadPdf(api, data, fileName, { readable = true } = {}) {
  const intent = await api.post("/api/v1/uploads", {
    clientUploadId: randomUUID(),
    fileName,
    byteSize: data.byteLength,
  })
  assert.ok(
    intent.status === 200 || intent.status === 201,
    `创建上传意图失败：HTTP ${intent.status} ${JSON.stringify(intent.payload)}`,
  )
  const uploadId = intent.payload?.data?.uploadId
  assert.equal(typeof uploadId, "string", "上传响应缺少 uploadId")

  if (api.csrfToken === null) {
    await api.refreshCsrf()
  }
  const put = await api.request.fetch(
    `${webBase}/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
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
    `上传 PDF 失败：HTTP ${put.status()} ${JSON.stringify(putPayload)}`,
  )
  const stored = putPayload.data
  const bookId = stored?.bookId ?? stored?.duplicateOfBookId
  assert.equal(typeof bookId, "string", "上传响应缺少 bookId")
  const task = readable
    ? await waitForTask(api, stored?.taskId)
    : await waitForTaskTerminal(api, stored?.taskId)

  if (!readable) {
    const deadline = Date.now() + 90_000
    let last = null
    while (Date.now() < deadline) {
      const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}/manifest`)
      last = response
      if (response.status === 409) {
        return { bookId, task, blockedManifest: response }
      }
      await sleep(250)
    }
    throw new Error(`加密 PDF 未在 90 秒内返回 409：${JSON.stringify(last?.payload)}`)
  }

  let detail = null
  const deadline = Date.now() + 90_000
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
    await sleep(250)
  }
  assert.equal(detail?.status, "ready", `等待书籍 ready 超时：${JSON.stringify(detail)}`)

  const manifestResponse = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/manifest`,
  )
  assert.equal(manifestResponse.status, 200, "PDF manifest 必须为 200")
  const manifest = manifestResponse.payload?.data
  assert.equal(manifest?.format, "pdf")
  assert.equal(manifest?.readingCapabilities?.canRead, true)
  assert.equal(manifest?.formatData?.pageCount, PAGE_COUNT)
  assert.equal(typeof manifest?.formatData?.etag, "string")
  return { bookId, detail, manifest, task }
}

async function waitForPdfReady(page) {
  await page.locator('.iread-pdf[data-pdf-ready="true"]').waitFor({
    timeout: 30_000,
  })
  await page
    .locator('.iread-pdf__page[data-pdf-page="1"]')
    .waitFor({ timeout: 15_000 })
}

async function waitForPage(page, pageNumber, timeout = 20_000) {
  await page.waitForFunction(
    (target) => {
      const root = document.querySelector(".iread-pdf")
      return Number(root?.getAttribute("data-pdf-page")) === target
    },
    pageNumber,
    { timeout },
  )
}

async function currentPage(page) {
  return page.evaluate(() =>
    Number(document.querySelector(".iread-pdf")?.getAttribute("data-pdf-page")),
  )
}

async function shellPosition(page) {
  return (
    (await page.locator(".iread-reader-shell__position-text").first().textContent()) ??
    ""
  )
}

async function waitForShellPage(page, pageNumber) {
  await page.waitForFunction(
    (target) =>
      ((document.querySelector(".iread-reader-shell__position-text")
        ?.textContent) ?? "").includes(`第 ${target} /`),
    pageNumber,
    { timeout: 20_000 },
  )
}

async function waitForPdfProgress(api, bookId, page, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    const response = await api.get(
      `/api/v1/books/${encodeURIComponent(bookId)}/progress`,
    )
    if (response.status === 200) {
      last = response.payload?.data
      if (
        last?.locatorType === "pdf-page" &&
        last?.locatorPayload?.page === page
      ) {
        return last
      }
    }
    await sleep(150)
  }
  throw new Error(
    `等待 PDF 进度第 ${page} 页超时，最后进度：${JSON.stringify(last)}`,
  )
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

    logStep("配置全局 PDF 设置（布局/缩放/页距/背景/隐藏引擎工具栏）")
    const globalGet = await adminApi.get("/api/v1/settings/reader")
    assert.equal(globalGet.status, 200)
    const globalPut = await adminApi.put("/api/v1/settings/reader", {
      schemaVersion: 1,
      baseRevision: globalGet.payload?.data?.revision ?? "0",
      value: {
        pdf: {
          layoutMode: "continuous",
          zoomMode: "fit-page",
          manualScale: 1.2,
          gap: "relaxed",
          background: "white",
          toolbarVisible: false,
        },
      },
    })
    assert.equal(
      globalPut.status,
      200,
      `全局 PDF 设置失败：${JSON.stringify(globalPut.payload)}`,
    )

    logStep("上传真实多页 PDF 并等待索引任务 succeeded / 书籍 ready")
    const readablePdf = buildPdf()
    const uploaded = await uploadPdf(
      adminApi,
      readablePdf,
      `shell-pdf-readable-${Date.now()}.pdf`,
    )
    console.log(
      `[E2E] bookId=${uploaded.bookId}，PDF=${readablePdf.byteLength} 字节，页数=${uploaded.manifest.formatData.pageCount}，task=${uploaded.task?.state}`,
    )

    logStep("上传加密 PDF 并确认 manifest 409 / pdf_encrypted")
    const encryptedPdf = buildPdf({ encrypted: true })
    const encrypted = await uploadPdf(
      adminApi,
      encryptedPdf,
      `shell-pdf-encrypted-${Date.now()}.pdf`,
      { readable: false },
    )
    assert.equal(encrypted.blockedManifest.status, 409)
    assert.equal(
      encrypted.blockedManifest.payload?.error?.code,
      "book_not_readable",
    )
    assert.equal(
      encrypted.blockedManifest.payload?.error?.details?.reason,
      "pdf_encrypted",
    )
    console.log(`[E2E] 加密 PDF manifest 409：${JSON.stringify(encrypted.blockedManifest.payload?.error)}`)

    const desktopContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(desktopContext)
    const page = await desktopContext.newPage()
    const contentRequests = []
    const contentResponses = []
    let firstSessionResponseCount = 0
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.warn(`[browser:error] ${message.text()}`)
      }
    })
    page.on("pageerror", (error) => {
      console.error("[browser:pageerror]", error.stack ?? error.message)
    })
    page.on("request", (request) => {
      if (!request.url().includes("/content")) {
        return
      }
      contentRequests.push({
        range: request.headers()["range"] ?? "",
        method: request.method(),
      })
      console.log(
        `[net:request] ${request.method()} ${request.url()} Range=${request.headers()["range"] ?? "(none)"}`,
      )
    })
    page.on("response", (response) => {
      if (!response.url().includes("/content")) {
        return
      }
      contentResponses.push({
        status: response.status(),
        contentRange: response.headers()["content-range"] ?? "",
        contentLength: Number(response.headers()["content-length"] ?? "0"),
        encoding: response.headers()["content-encoding"] ?? "",
      })
      console.log(
        `[net:response] ${response.status()} Range=${response.headers()["content-range"] ?? ""} Length=${response.headers()["content-length"] ?? ""} Encoding=${response.headers()["content-encoding"] ?? ""}`,
      )
    })
    page.on("requestfailed", (request) => {
      if (request.url().includes("/content")) {
        console.log(
          `[net:failed] ${request.url()} ${request.failure()?.errorText ?? ""}`,
        )
      }
    })

    logStep("真实 /read/:id 打开 PDF，验证设置映射、Canvas、文字层与页数")
    await page.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForPdfReady(page)
    const readyRoot = page.locator(".iread-pdf")
    await page.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-pdf-state") ===
        "ready",
      undefined,
      { timeout: 20_000 },
    )
    assert.equal(
      Number(await readyRoot.getAttribute("data-pdf-page-count")),
      PAGE_COUNT,
      "页数必须来自 PDF.js 实际解析",
    )
    assert.equal(await readyRoot.getAttribute("data-layout"), "continuous")
    assert.equal(await readyRoot.getAttribute("data-zoom"), "fit-page")
    assert.equal(await readyRoot.getAttribute("data-background"), "white")
    assert.equal(await readyRoot.getAttribute("data-toolbar"), "hidden")
    await page
      .locator('.iread-pdf__page[data-pdf-page="1"] canvas')
      .waitFor({ timeout: 20_000 })
    assert.equal(
      await page.locator('.iread-pdf__page[data-pdf-page="1"] canvas').count(),
      1,
      "首屏必须有 Canvas",
    )
    await page
      .locator('.iread-pdf__page[data-pdf-page="1"] .textLayer span')
      .first()
      .waitFor({ timeout: 10_000 })
    assert.ok(
      (await page.locator('.iread-pdf__page[data-pdf-page="1"] .textLayer span').count()) > 0,
      "文字层必须可选中",
    )
    await waitForShellPage(page, 1)
    console.log(`[E2E] Shell 位置：${await shellPosition(page)}`)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-page-1.png"),
    })

    logStep("翻页、缩放、布局切换保持当前页")
    await page.locator("[data-reader-page-next]").click()
    await waitForPage(page, 2)
    await waitForShellPage(page, 2)
    await page.locator("[data-reader-pdf-zoom-in]").click()
    await page.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "manual",
      undefined,
      { timeout: 10_000 },
    )
    const manualScale = Number(await readyRoot.getAttribute("data-pdf-scale"))
    assert.ok(manualScale > 0, "手动缩放必须由引擎测量")
    await page.locator("[data-reader-pdf-fit-width]").click()
    await page.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "fit-width",
      undefined,
      { timeout: 10_000 },
    )
    await page.locator("[data-reader-pdf-layout]").click()
    await page.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-layout") ===
        "horizontal",
      undefined,
      { timeout: 10_000 },
    )
    assert.equal(await currentPage(page), 2, "切换布局不得误翻页")

    logStep("跳页、Shell 搜索面板与文字高亮")
    await page.locator("#reader-jump-page").fill("9")
    await page.getByRole("button", { name: "跳转", exact: true }).click()
    await waitForPage(page, 9)
    await waitForShellPage(page, 9)

    await page.locator("[data-reader-pdf-search-trigger]").click()
    const searchPanel = page.locator('[data-reader-panel="search"]')
    await searchPanel.waitFor({ timeout: 5_000 })
    assert.equal(
      await page.locator('[data-slot="sheet-content"]').count() > 0,
      true,
      "桌面搜索应使用 Sheet",
    )
    await page.locator("[data-reader-pdf-search-input]").fill("searchable")
    await page.locator("[data-reader-pdf-search-input]").press("Enter")
    await page
      .locator("[data-reader-pdf-search-status]")
      .filter({ hasText: "1 / 12 处" })
      .waitFor({ timeout: 30_000 })
    await page.locator('[data-reader-pdf-search-result="5"]').click()
    await waitForPage(page, 5)
    await page
      .locator('.iread-pdf__page[data-pdf-page="5"] .iread-pdf__text-hit')
      .first()
      .waitFor({ timeout: 20_000 })
    await page.waitForFunction(() => {
      const root=document.querySelector(".iread-pdf")
      return root?.getAttribute("data-pdf-page")==="5" &&
        document.querySelector('.iread-pdf__page[data-pdf-page="5"][data-state="ready"] mark.iread-pdf__text-hit[data-active="true"]') !== null
    }, undefined, { timeout: 20000 })
    await page.getByRole("button", { name: "关闭面板", exact: true }).click()
    await searchPanel.waitFor({ state: "hidden" })

    await page.keyboard.press("/")
    await searchPanel.waitFor({ state: "visible" })
    await page.getByRole("button", { name: "关闭面板", exact: true }).click()
    await searchPanel.waitFor({ state: "hidden" })
    // 面板正确恢复触发按钮焦点；阅读方向键在正文区域验证，不抢控件原生键盘操作。
    await page.locator(".iread-reader-shell__stage").focus()
    await page.keyboard.press("ArrowRight")
    await waitForPage(page, 6)

    logStep("PDF 内置目录跳转")
    await page.getByRole("button", { name: "目录与书签" }).click()
    const tocPanel = page.locator('[data-reader-panel="toc"]')
    await tocPanel.waitFor({ timeout: 5_000 })
    await page.locator("[data-reader-pdf-outline]").waitFor({ timeout: 10_000 })
    await page.locator('[data-reader-pdf-outline-page="3"]').click()
    await waitForPage(page, 3)
    await tocPanel.waitFor({ state: "hidden" })

    logStep("旋转后保持当前页")
    await page.locator("[data-reader-pdf-rotate]").click()
    await sleep(500)
    await page
      .locator('.iread-pdf__page[data-pdf-page="3"][data-state="ready"]')
      .waitFor({ timeout: 20_000 })
    assert.equal(await currentPage(page), 3, "旋转不得误翻页")

    logStep("页内 locator 保存、退出与重开恢复")
    await page.locator("#reader-jump-page").fill("7")
    await page.getByRole("button", { name: "跳转", exact: true }).click()
    await waitForPage(page, 7)
    await page.evaluate(() => {
      const viewport = document.querySelector(".iread-pdf__viewport")
      const pageElement = document.querySelector(
        '.iread-pdf__page[data-pdf-page="7"]',
      )
      if (viewport === null || pageElement === null) {
        throw new Error("缺少 PDF viewport 或第 7 页")
      }
      const viewportRect = viewport.getBoundingClientRect()
      const pageRect = pageElement.getBoundingClientRect()
      const delta = pageRect.left - viewportRect.left
      viewport.scrollLeft += delta + pageRect.width * 0.35
      viewport.dispatchEvent(new Event("scroll"))
    })
    await page.waitForFunction(
      () => {
        const root = document.querySelector(".iread-pdf")
        return (
          Number(root?.getAttribute("data-pdf-page")) === 7 &&
          Number(root?.getAttribute("data-pdf-page-offset")) > 0.02
        )
      },
      undefined,
      { timeout: 10_000 },
    )
    const beforeOffset = Number(
      await readyRoot.getAttribute("data-pdf-page-offset"),
    )
    const beforeRelative = await readyRoot.getAttribute(
      "data-pdf-relative-viewport",
    )
    firstSessionResponseCount = contentResponses.length
    await page.getByRole("button", { name: "返回书库", exact: true }).click()
    await page.waitForFunction(
      () => window.location.pathname === "/library",
      undefined,
      { timeout: 10_000 },
    )
    const savedProgress = await adminApi.get(
      `/api/v1/books/${encodeURIComponent(uploaded.bookId)}/progress`,
    )
    assert.equal(savedProgress.status, 200)
    const saved = savedProgress.payload?.data
    assert.equal(saved?.locatorType, "pdf-page")
    assert.equal(saved?.locatorPayload?.page, 7)
    assert.ok(
      saved?.locatorPayload?.pageOffset > 0.02,
      `保存的 pageOffset 应大于 0，实际 ${saved?.locatorPayload?.pageOffset}`,
    )
    assert.equal(saved?.locatorPayload?.view?.layoutMode, "horizontal")
    assert.equal(saved?.locatorPayload?.view?.zoomMode, "fit-width")
    assert.ok(
      saved?.locatorPayload?.relativeViewport !== null &&
        typeof saved?.locatorPayload?.relativeViewport === "object",
      "保存的 locator 应包含相对视口",
    )
    assert.ok(saved?.progressPercent > 0 && saved?.progressPercent < 100)
    console.log(
      `[E2E] 保存 locator：page=${saved.locatorPayload.page} offset=${saved.locatorPayload.pageOffset} view=${JSON.stringify(saved.locatorPayload.view)}`,
    )

    await page.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForPdfReady(page)
    await waitForPage(page, 7)
    await page.waitForFunction(
      (expected) => {
        const root = document.querySelector(".iread-pdf")
        return (
          Number(root?.getAttribute("data-pdf-page")) === 7 &&
          Math.abs(
            Number(root?.getAttribute("data-pdf-page-offset")) - expected,
          ) < 0.15
        )
      },
      beforeOffset,
      { timeout: 20_000 },
    )
    await waitForShellPage(page, 7)
    const restoredRelative = await readyRoot.getAttribute(
      "data-pdf-relative-viewport",
    )
    assert.ok(
      beforeRelative !== "null" || restoredRelative !== null,
      "应保存过相对视口",
    )
    console.log(
      `[E2E] 重开恢复 page=7 offset=${await readyRoot.getAttribute("data-pdf-page-offset")}（保存 ${beforeOffset}）`,
    )

    logStep("Range 206、未整本下载与页数真实性")
    const rangeRequests = contentRequests.filter((item) => item.range.length > 0)
    assert.ok(rangeRequests.length >= 3, "必须存在多次 Range 请求")
    assert.ok(
      contentResponses.some((item) => item.status === 206),
      "浏览器网络必须观察到 206",
    )
    assert.equal(
      contentResponses.some((item) => item.status === 200),
      false,
      "原件读取不得退化为 200 整本响应",
    )
    assert.equal(
      contentResponses.some((item) => item.encoding.length > 0),
      false,
      "PDF Range 响应不得透明压缩",
    )
    const firstSessionResponses = contentResponses.slice(
      0,
      firstSessionResponseCount,
    )
    const restoredSessionResponses = contentResponses.slice(
      firstSessionResponseCount,
    )
    const downloaded = firstSessionResponses.reduce(
      (sum, item) => sum + item.contentLength,
      0,
    )
    const restoredDownloaded = restoredSessionResponses.reduce(
      (sum, item) => sum + item.contentLength,
      0,
    )
    assert.ok(
      downloaded < readablePdf.byteLength * 0.9,
      `首次打开按需读取下载量应小于整本（${downloaded} / ${readablePdf.byteLength}）`,
    )
    assert.ok(
      restoredDownloaded < readablePdf.byteLength * 0.9,
      `重开恢复按需读取下载量应小于整本（${restoredDownloaded} / ${readablePdf.byteLength}）`,
    )
    console.log(
      `[E2E] Range 请求 ${rangeRequests.length} 次；首次打开 ${downloaded} 字节，重开恢复 ${restoredDownloaded} 字节，整本 ${readablePdf.byteLength} 字节`,
    )

    logStep("内容 409：Shell 内显示 PDF 原件已更新")
    const conflictPage = await desktopContext.newPage()
    await conflictPage.route("**/content", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "file_version_conflict",
            message: "stale",
            requestId: "",
            details: {},
          },
        }),
      })
    })
    await conflictPage.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await conflictPage
      .locator('.iread-pdf[data-pdf-state="error"]')
      .waitFor({ timeout: 20_000 })
    await conflictPage
      .locator(".iread-pdf__error-message")
      .filter({ hasText: "PDF 原件已在别处更新" })
      .waitFor({ timeout: 10_000 })
    assert.equal(
      await conflictPage.getByRole("button", { name: "重试打开 PDF" }).count(),
      1,
    )
    await conflictPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-409.png"),
    })
    await conflictPage.close()

    logStep("加密 PDF：/read 显示 manifest 409 错误，不启动 PDF 引擎")
    const encryptedPage = await desktopContext.newPage()
    await encryptedPage.goto(`/read/${encodeURIComponent(encrypted.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await encryptedPage
      .getByText("阅读内容尚未就绪", { exact: true })
      .waitFor({ timeout: 20_000 })
    await encryptedPage
      .getByText("这本书当前不可阅读", { exact: false })
      .waitFor({ timeout: 10_000 })
    assert.equal(
      await encryptedPage.locator(".iread-pdf").count(),
      0,
      "manifest 409 时不得挂载 PDF 引擎",
    )
    await encryptedPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-encrypted.png"),
    })
    await encryptedPage.close()

    logStep("PDF 书签：第 5 页创建、列表、跳转、If-Match 删除与重开无残留")
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

    await page.locator("#reader-jump-page").fill("5")
    await page.getByRole("button", { name: "跳转", exact: true }).click()
    await waitForPage(page, 5)
    await waitForShellPage(page, 5)

    await page.getByRole("button", { name: "目录与书签" }).click()
    const bookmarkPanel = page.locator('[data-reader-panel="toc"]')
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page.getByText("还没有书签", { exact: true }).waitFor()
    await page.getByRole("button", { name: "添加当前位置书签" }).click()
    await page.getByText("书签已添加", { exact: true }).waitFor()

    const pdfBookmarkItem = page
      .locator(".iread-reader-bookmarks__item")
      .filter({ hasText: "第 5 页" })
    await pdfBookmarkItem.waitFor({ timeout: 10_000 })
    const pdfBookmarkText = (await pdfBookmarkItem.innerText()) ?? ""
    assert.match(pdfBookmarkText, /第 5 页/, "书签列表必须显示标签")
    assert.match(pdfBookmarkText, /第 5 \/ 12 页/, "书签列表必须显示页码摘要")

    const createdPdfBookmarks = await adminApi.get(
      `/api/v1/books/${encodeURIComponent(uploaded.bookId)}/bookmarks?fileVersion=${uploaded.manifest.fileVersion}`,
    )
    assert.equal(createdPdfBookmarks.status, 200)
    assert.equal(createdPdfBookmarks.payload?.data?.length, 1)
    const pdfBookmark = createdPdfBookmarks.payload.data[0]
    assert.equal(pdfBookmark.format, "pdf")
    assert.equal(pdfBookmark.fileVersion, uploaded.manifest.fileVersion)
    assert.equal(pdfBookmark.locatorType, "pdf-page")
    assert.equal(pdfBookmark.locatorPayload.page, 5)
    assert.equal(pdfBookmark.label, "第 5 页")
    assert.equal(pdfBookmark.revision, "1")

    await page.keyboard.press("Escape")
    await bookmarkPanel.waitFor({ state: "hidden" })
    await page.locator("#reader-jump-page").fill("8")
    await page.getByRole("button", { name: "跳转", exact: true }).click()
    await waitForPage(page, 8)
    await waitForShellPage(page, 8)

    await page.getByRole("button", { name: "目录与书签" }).click()
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page
      .locator(".iread-reader-bookmarks__jump")
      .filter({ hasText: "第 5 页" })
      .click()
    await bookmarkPanel.waitFor({ state: "hidden", timeout: 10_000 })
    await waitForPage(page, 5)
    await waitForShellPage(page, 5)

    await page.getByRole("button", { name: "目录与书签" }).click()
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page
      .getByRole("button", { name: "移除当前位置书签" })
      .waitFor({ timeout: 10_000 })
    await page
      .getByRole("button", { name: "移除书签：第 5 页" })
      .click()
    await page.getByText("书签已移除", { exact: true }).waitFor()
    await page.getByText("还没有书签", { exact: true }).waitFor()

    const removedPdfBookmarks = await adminApi.get(
      `/api/v1/books/${encodeURIComponent(uploaded.bookId)}/bookmarks?fileVersion=${uploaded.manifest.fileVersion}`,
    )
    assert.equal(removedPdfBookmarks.status, 200)
    assert.equal(removedPdfBookmarks.payload?.data?.length, 0)
    assert.equal(bookmarkDeleteRequests.length, 1, "必须通过一次 DELETE 移除书签")
    assert.equal(
      bookmarkDeleteRequests[0].ifMatch,
      `"${pdfBookmark.revision}"`,
      "DELETE 必须携带 If-Match revision",
    )
    assert.ok(
      bookmarkDeleteRequests[0].url.includes(
        `/bookmarks/${pdfBookmark.bookmarkId}`,
      ),
      "DELETE 必须指向刚创建的书签",
    )

    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForPdfReady(page)
    await page.getByRole("button", { name: "目录与书签" }).click()
    await bookmarkPanel.waitFor({ timeout: 5_000 })
    await page.getByRole("tab", { name: "书签" }).click()
    await page
      .getByText("还没有书签", { exact: true })
      .waitFor({ timeout: 10_000 })
    await page.keyboard.press("Escape")
    await bookmarkPanel.waitFor({ state: "hidden" })

    // 书签用例把位置移到第 5 页；恢复原有第 7 页进度，避免影响后续手机断言。
    await page.locator("#reader-jump-page").fill("7")
    await page.getByRole("button", { name: "跳转", exact: true }).click()
    await waitForPage(page, 7)
    await waitForShellPage(page, 7)
    await waitForPdfProgress(adminApi, uploaded.bookId, 7)

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-final.png"),
    })

    logStep("手机 390x844：Drawer 搜索/目录、PDF 设置与跳页")
    const mobileContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(mobileContext)
    const mobile = await mobileContext.newPage()
    await mobile.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForPdfReady(mobile)
    await waitForPage(mobile, 7)
    const mobileBox = await mobile.locator(".iread-reader-shell").boundingBox()
    assert.ok(mobileBox !== null)
    assert.equal(Math.round(mobileBox.width), 390)
    assert.ok(Math.abs(mobileBox.height - 844) <= 1)

    await mobile.locator("[data-reader-pdf-search-trigger]").click()
    const mobileSearch = mobile.locator('[data-reader-panel="search"]')
    await mobileSearch.waitFor({ timeout: 5_000 })
    assert.equal(
      await mobile.locator('[data-slot="drawer-content"]').count(),
      1,
      "手机搜索应使用 Drawer",
    )
    await mobile.locator("[data-reader-pdf-search-input]").fill("searchable")
    await mobile.locator("[data-reader-pdf-search-input]").press("Enter")
    await mobile
      .locator("[data-reader-pdf-search-status]")
      .filter({ hasText: "1 / 12 处" })
      .waitFor({ timeout: 30_000 })
    await mobile.getByRole("button", { name: "关闭面板", exact: true }).click()
    await mobileSearch.waitFor({ state: "hidden" })

    await mobile.getByRole("button", { name: "目录与书签" }).click()
    const mobileToc = mobile.locator('[data-reader-panel="toc"]')
    await mobileToc.waitFor({ timeout: 5_000 })
    assert.equal(await mobile.locator('[data-slot="drawer-content"]').count(), 1)
    await mobile.locator('[data-reader-pdf-outline-page="3"]').click()
    await waitForPage(mobile, 3)
    await mobileToc.waitFor({ state: "hidden" })

    await mobile.getByRole("button", { name: "阅读设置" }).click()
    const mobileSettings = mobile.locator('[data-reader-panel="settings"]')
    await mobileSettings.waitFor({ timeout: 5_000 })
    assert.equal(await mobile.getByRole("tab", { name: "PDF 布局" }).count(), 1)
    assert.equal(
      await mobile.getByRole("tab", { name: "EPUB 文字" }).count(),
      0,
      "PDF 设置不得显示文字/行高控件",
    )
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-pdf-settings.png"),
    })
    await mobile.keyboard.press("Escape")
    await mobileSettings.waitFor({ state: "hidden" })

    await mobile.locator("#reader-jump-page").fill("5")
    await mobile.getByRole("button", { name: "跳转", exact: true }).click()
    await waitForPage(mobile, 5)
    await waitForShellPage(mobile, 5)
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-pdf-page-5.png"),
    })

    await mobile.setViewportSize({ width: 844, height: 390 })
    await mobile.waitForFunction(
      () =>
        Math.round(
          document.querySelector(".iread-reader-shell")?.getBoundingClientRect()
            .height ?? 0,
        ) === 390,
      undefined,
      { timeout: 5_000 },
    )
    await waitForPage(mobile, 5)

    console.log("\n[PDF-SHELL-E2E] 通过：真实 /read/:id PDF 渲染、设置、搜索、目录、locator、Range、错误与手机均验证。")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      if (typeof context.dispose === "function") {
        await context.dispose().catch(() => {})
      } else if (typeof context.close === "function") {
        await context.close().catch(() => {})
      }
    }
    await browser?.close().catch(() => {})
    for (const dispose of cleanup) {
      try {
        dispose()
      } catch {
        // 清理失败不覆盖原始测试错误。
      }
    }
  }
}

main().catch((error) => {
  if (error instanceof E2EBlocked) {
    console.error(`\n[PDF-SHELL-E2E] BLOCKED：${error.message}`)
    process.exitCode = 2
    return
  }
  console.error("\n[PDF-SHELL-E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
