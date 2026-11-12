#!/usr/bin/env node

/**
 * PDF 按 profile 视图 / 默认 100% / 恢复竞态 / 滚动抖动 E2E。
 *
 * 覆盖：
 * - 新书默认 manual 1.0，首帧不出现 fit-width；
 * - web/mobile profile 独立保存并在重开/跨断点切换时恢复；
 * - 旧进度 manual 1.1132 一次性迁移到当前 profile；
 * - 连续布局 compact/relaxed 跳 page 300 顶部对齐；
 * - 5s 空闲 scrollTop 漂移与反向滚动停止后 2s 跳变。
 *
 * 用法：
 *   CHROME_PATH=... node tests/reader-pdf-profile-view.e2e.mjs
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
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
let serverPort = Number(process.env.IREAD_E2E_SERVER_PORT ?? "18190")
let webPort = Number(process.env.IREAD_E2E_WEB_PORT ?? "18191")
let serverBase = `http://127.0.0.1:${serverPort}`
let webBase = `http://127.0.0.1:${webPort}`
const OUT_DIR =
  process.env.PDF_PROFILE_E2E_OUT ??
  path.join("/tmp/opencode", "iread-pdf-profile-view")
const SCREENSHOT_DIR = path.join(OUT_DIR, "shots")
const TEMP_ROOT = process.env.IREAD_E2E_TMP ?? "/tmp/opencode"
const PAGE_COUNT = Number(process.env.PDF_PROFILE_PAGE_COUNT ?? "320")
const LEGACY_SCALE = 1.1132

mkdirSync(SCREENSHOT_DIR, { recursive: true })

function logStep(name) {
  console.log(`\n[PDF-PROFILE-E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapePdfText(value) {
  return value.replace(/[\\()]/g, "\\$&")
}

/** 生成 472×675pt 多页 PDF，页数足够验证 page 300 跳转。 */
function buildPdf(pageCount = PAGE_COUNT, variant = "a") {
  const ids = { catalog: 1, pages: 2, font: 3 }
  const pageId = (page) => 10 + page
  const contentId = (page) => 10_000 + page
  let body = `%PDF-1.4\n% iRead ${variant}\n`
  const offsets = new Map()
  const writeObject = (id, content) => {
    offsets.set(id, Buffer.byteLength(body))
    body += `${id} 0 obj\n${content}\nendobj\n`
  }
  const kids = []
  for (let page = 1; page <= pageCount; page += 1) {
    kids.push(`${pageId(page)} 0 R`)
  }
  writeObject(ids.catalog, `<< /Type /Catalog /Pages ${ids.pages} 0 R >>`)
  writeObject(
    ids.pages,
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} /Resources << /Font << /F1 ${ids.font} 0 R >> >> >>`,
  )
  writeObject(
    ids.font,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  )
  for (let page = 1; page <= pageCount; page += 1) {
    const text = escapePdfText(`iRead profile page ${page}`)
    const content = [
      "BT",
      "/F1 18 Tf",
      "36 630 Td",
      `(${text}) Tj`,
      "0 -28 Td",
      "(position marker for profile and gap verification) Tj",
      "ET",
    ].join("\n")
    writeObject(
      pageId(page),
      `<< /Type /Page /Parent ${ids.pages} 0 R /MediaBox [0 0 472 675] /Contents ${contentId(page)} 0 R >>`,
    )
    writeObject(
      contentId(page),
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    )
  }
  const maxId = contentId(pageCount)
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets.get(id)
    body +=
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer\n<< /Size ${maxId + 1} /Root ${ids.catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
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
    server.once("listening", () => server.close(() => resolve(true)))
    server.listen(port, "127.0.0.1")
  })
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    if (await portFree(port)) return port
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
  if (run === undefined || run === null) return
  try {
    if (process.platform !== "win32") process.kill(-run.child.pid, "SIGTERM")
    else run.child.kill("SIGTERM")
  } catch {
    try {
      run.child.kill("SIGTERM")
    } catch {
      // 已退出。
    }
  }
}

async function waitForHttp(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await httpReachable(target)) return
    await sleep(250)
  }
  throw new Error(`等待 ${target} 超时`)
}

async function buildServerBinary(tempRoot) {
  const binary = path.join(tempRoot, "iread-server")
  const build = startProcess("go", ["build", "-o", binary, "./cmd/iread"], {
    cwd: path.join(REPO_ROOT, "server"),
    env: { ...process.env, GOFLAGS: "-buildvcs=false" },
  })
  const code = await new Promise((resolve) => {
    build.child.once("exit", (value) => resolve(value ?? 1))
  })
  if (code !== 0) {
    throw new Error(`构建临时 Go 服务失败：\n${build.output()}`)
  }
  return binary
}

async function ensureServers(cleanup) {
  const tempRoot = mkdtempSync(path.join(TEMP_ROOT, "iread-profile-e2e-"))
  const dirs = {
    books: path.join(tempRoot, "books"),
    db: path.join(tempRoot, "db"),
    cache: path.join(tempRoot, "cache"),
    web: path.join(tempRoot, "web"),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dirs.web, "index.html"),
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  )
  if (await httpReachable(`${serverBase}/healthz`)) {
    serverPort = await findFreePort(serverPort + 100)
    webPort = await findFreePort(webPort + 100)
    serverBase = `http://127.0.0.1:${serverPort}`
    webBase = `http://127.0.0.1:${webPort}`
  }
  if (!(await portFree(serverPort))) {
    serverPort = await findFreePort(serverPort + 100)
    serverBase = `http://127.0.0.1:${serverPort}`
  }
  if (!(await portFree(webPort))) {
    webPort = await findFreePort(webPort + 100)
    webBase = `http://127.0.0.1:${webPort}`
  }
  if (serverPort === webPort) {
    webPort = await findFreePort(webPort + 1)
    webBase = `http://127.0.0.1:${webPort}`
  }
  const binary = await buildServerBinary(tempRoot)
  const server = startProcess(binary, [], {
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
    { cwd: WEB_ROOT, env: { ...process.env, IREAD_DEV_API: serverBase } },
  )
  cleanup.push(() => stopProcess(vite))
  await waitForHttp(`${webBase}/`, 60_000)
  cleanup.push(() => rmSync(tempRoot, { recursive: true, force: true }))
  console.log(`[E2E] Go ${serverBase}，Vite ${webBase}，数据 ${tempRoot}`)
}

async function waitForTask(api, taskId) {
  const deadline = Date.now() + 120_000
  let last = null
  while (Date.now() < deadline) {
    const response = await api.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
    if (response.status === 200) {
      last = response.payload?.data
      if (last?.state === "succeeded") return last
      if (last?.state === "failed" || last?.state === "cancelled") {
        throw new Error(`索引任务终态 ${last.state}`)
      }
    }
    await sleep(250)
  }
  throw new Error(`索引任务未在 120 秒内成功：${JSON.stringify(last)}`)
}

async function uploadPdf(api, data, fileName) {
  const intent = await api.post("/api/v1/uploads", {
    clientUploadId: randomUUID(),
    fileName,
    byteSize: data.byteLength,
  })
  assert.ok(
    intent.status === 200 || intent.status === 201,
    `创建上传意图失败：HTTP ${intent.status}`,
  )
  const uploadId = intent.payload?.data?.uploadId
  assert.equal(typeof uploadId, "string", "上传响应缺少 uploadId")
  if (api.csrfToken === null) await api.refreshCsrf()
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
  const task =
    typeof stored?.taskId === "string"
      ? await waitForTask(api, stored.taskId)
      : null
  let detail = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}`)
    if (response.status === 200) {
      detail = response.payload?.data
      if (detail?.status === "ready") break
      if (detail?.status === "error" || detail?.status === "unsupported") {
        throw new Error(`书籍未就绪：${JSON.stringify(detail)}`)
      }
    }
    await sleep(250)
  }
  assert.equal(detail?.status, "ready", `等待书籍 ready 超时：${JSON.stringify(detail)}`)
  return { bookId, task }
}

async function fetchManifest(api, bookId) {
  const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}/manifest`)
  assert.equal(response.status, 200, "读取 manifest 失败")
  return response.payload?.data
}

async function readOverrides(api, bookId, profile) {
  const response = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/reader-overrides?profile=${profile}`,
  )
  assert.equal(response.status, 200, `读取 ${profile} 覆盖失败`)
  return response.payload?.data
}

async function putOverrides(api, bookId, profile, fileVersion, overrides) {
  const current = await readOverrides(api, bookId, profile)
  const response = await api.put(
    `/api/v1/books/${encodeURIComponent(bookId)}/reader-overrides?profile=${profile}`,
    {
      schemaVersion: 1,
      fileVersion,
      baseRevision: current?.revision ?? "0",
      overrides,
    },
  )
  assert.equal(
    response.status,
    200,
    `写入 ${profile} 覆盖失败：${JSON.stringify(response.payload)}`,
  )
  return response.payload?.data
}

async function putLegacyProgress(api, bookId, manifest, page, scale) {
  const current = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/progress`,
  )
  const baseRevision = current.payload?.data?.revision ?? "0"
  const response = await api.put(
    `/api/v1/books/${encodeURIComponent(bookId)}/progress`,
    {
      schemaVersion: 1,
      fileVersion: manifest.fileVersion,
      baseRevision,
      clientMutationId: randomUUID(),
      format: "pdf",
      locatorType: "pdf-page",
      locatorPayload: {
        locatorVersion: 1,
        page,
        pageOffset: 0.1,
        relativeViewport: null,
        view: { layoutMode: "single", zoomMode: "manual", manualScale: scale },
      },
      progressPercent: ((page - 1) / Math.max(1, manifest.formatData.pageCount - 1)) * 100,
    },
  )
  assert.equal(
    response.status,
    200,
    `写入旧进度失败：${JSON.stringify(response.payload)}`,
  )
}

async function addPdfSamples(page) {
  await page.addInitScript(() => {
    window.__pdfScaleSamples = []
    window.__pdfPageSamples = []
    const tick = () => {
      const root = document.querySelector(".iread-pdf")
      if (root !== null) {
        const scale = Number(root.getAttribute("data-pdf-scale"))
        if (Number.isFinite(scale) && scale > 0) {
          window.__pdfScaleSamples.push(scale)
        }
        const pageNumber = Number(root.getAttribute("data-pdf-page"))
        if (Number.isFinite(pageNumber) && pageNumber > 0) {
          window.__pdfPageSamples.push(pageNumber)
        }
      }
      window.requestAnimationFrame(tick)
    }
    window.requestAnimationFrame(tick)
  })
}

async function waitForPdfReady(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".iread-pdf")
      return (
        root?.getAttribute("data-pdf-ready") === "true" &&
        Number(root.getAttribute("data-pdf-page-count")) > 0
      )
    },
    undefined,
    { timeout: 60_000 },
  )
}

async function waitForScale(page, expected, tolerance = 0.02) {
  await page.waitForFunction(
    ({ expected, tolerance }) => {
      const scale = Number(
        document.querySelector(".iread-pdf")?.getAttribute("data-pdf-scale"),
      )
      return (
        Number.isFinite(scale) &&
        Math.abs(scale - expected) / expected <= tolerance
      )
    },
    { expected, tolerance },
    { timeout: 20_000 },
  )
}

async function waitForPage(page, expected) {
  await page.waitForFunction(
    (target) =>
      Number(
        document.querySelector(".iread-pdf")?.getAttribute("data-pdf-page"),
      ) === target,
    expected,
    { timeout: 30_000 },
  )
}

async function jumpToPage(page, target) {
  await page.locator("#reader-jump-page").fill(String(target))
  await page.getByRole("button", { name: "跳转", exact: true }).click()
  await waitForPage(page, target)
  await sleep(250)
}

async function measurePageTop(page, pageNumber) {
  return page.evaluate((target) => {
    const viewport = document.querySelector(".iread-pdf__viewport")
    const element = document.querySelector(
      `.iread-pdf__page[data-pdf-page="${target}"]`,
    )
    if (viewport === null || element === null) return null
    return (
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    )
  }, pageNumber)
}

async function openBook(context, bookId) {
  const page = await context.newPage()
  await addPdfSamples(page)
  const response = await page.goto(`/read/${encodeURIComponent(bookId)}`, {
    waitUntil: "domcontentloaded",
  })
  assert.equal(response?.status?.() ?? 200, 200)
  await waitForPdfReady(page)
  return page
}

async function main() {
  const cleanup = []
  let browser = null
  const contexts = []
  const apiContexts = []
  const summary = { checks: [] }
  try {
    logStep("启动临时 Go + Vite")
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
    const api = new AuthedApi(adminRequest, webBase)
    await ensureAdmin(api, webBase, E2E_PASSWORD)

    logStep("清空全局 PDF 默认，上传两本真实 PDF")
    const global = await api.get("/api/v1/settings/reader")
    assert.equal(global.status, 200)
    if (Object.keys(global.payload?.data?.value ?? {}).length > 0) {
      const cleared = await api.put("/api/v1/settings/reader", {
        schemaVersion: 1,
        baseRevision: global.payload?.data?.revision ?? "0",
        value: {},
      })
      assert.equal(cleared.status, 200)
    }
    const bookA = await uploadPdf(
      api,
      buildPdf(PAGE_COUNT, "legacy"),
      `profile-legacy-${Date.now()}.pdf`,
    )
    const bookB = await uploadPdf(
      api,
      buildPdf(PAGE_COUNT, "profiles"),
      `profile-gap-${Date.now()}.pdf`,
    )
    const manifestA = await fetchManifest(api, bookA.bookId)
    const manifestB = await fetchManifest(api, bookB.bookId)
    console.log(`[E2E] bookA=${bookA.bookId} bookB=${bookB.bookId} pages=${manifestA.formatData.pageCount}`)

    logStep("新书默认 100%，首帧无 fit-width")
    const defaultContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(defaultContext)
    const defaultPage = await openBook(defaultContext, bookB.bookId)
    await waitForScale(defaultPage, 1)
    const defaultSamples = await defaultPage.evaluate(() => ({
      scales: window.__pdfScaleSamples ?? [],
      pages: window.__pdfPageSamples ?? [],
    }))
    assert.equal(
      await defaultPage
        .locator(".iread-pdf")
        .getAttribute("data-zoom"),
      "manual",
    )
    assert.ok(
      defaultSamples.scales.every((scale) => scale < 2),
      `新书首帧出现适宽比例：${JSON.stringify(defaultSamples.scales.slice(0, 20))}`,
    )
    summary.checks.push({
      name: "default-100",
      finalScale: Number(
        await defaultPage.locator(".iread-pdf").getAttribute("data-pdf-scale"),
      ),
      firstScales: defaultSamples.scales.slice(0, 10),
    })
    await defaultPage.close()

    logStep("旧进度 manual 1.1132：首帧、page 33、空闲漂移与反向滚动")
    await putLegacyProgress(api, bookA.bookId, manifestA, 33, LEGACY_SCALE)
    const legacyContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(legacyContext)
    const legacyPage = await openBook(legacyContext, bookA.bookId)
    await waitForPage(legacyPage, 33)
    await waitForScale(legacyPage, LEGACY_SCALE)
    const legacySamples = await legacyPage.evaluate(() => ({
      scales: window.__pdfScaleSamples ?? [],
      pages: window.__pdfPageSamples ?? [],
    }))
    assert.ok(
      legacySamples.scales.every((scale) => scale < 2),
      `旧进度打开首帧出现 fit-width：${JSON.stringify(legacySamples.scales.slice(0, 20))}`,
    )
    await sleep(800)
    const driftStart = await legacyPage.evaluate(
      () => document.querySelector(".iread-pdf__viewport")?.scrollTop ?? 0,
    )
    await sleep(5_000)
    const driftEnd = await legacyPage.evaluate(
      () => document.querySelector(".iread-pdf__viewport")?.scrollTop ?? 0,
    )
    assert.ok(
      Math.abs(driftEnd - driftStart) <= 1,
      `5s 空闲 scrollTop 漂移 ${driftStart} -> ${driftEnd}`,
    )
    const viewportBox = await legacyPage
      .locator(".iread-pdf__viewport")
      .boundingBox()
    assert.ok(viewportBox !== null)
    await legacyPage.mouse.move(
      viewportBox.x + viewportBox.width / 2,
      viewportBox.y + viewportBox.height / 2,
    )
    for (let index = 0; index < 6; index += 1) {
      await legacyPage.mouse.wheel(0, -420)
      await sleep(40)
    }
    await sleep(300)
    const reverseStart = await legacyPage.evaluate(
      () => document.querySelector(".iread-pdf__viewport")?.scrollTop ?? 0,
    )
    await sleep(2_000)
    const reverseEnd = await legacyPage.evaluate(
      () => document.querySelector(".iread-pdf__viewport")?.scrollTop ?? 0,
    )
    assert.ok(
      Math.abs(reverseEnd - reverseStart) <= 2,
      `反向滚动停止后 2s 跳变 ${reverseStart} -> ${reverseEnd}`,
    )
    const pagesAfterRestore = await legacyPage.evaluate(
      () => window.__pdfPageSamples ?? [],
    )
    const first33 = pagesAfterRestore.indexOf(33)
    assert.ok(first33 >= 0, "恢复后从未到达 page 33")
    assert.ok(
      pagesAfterRestore.slice(first33).every((value) => value !== 1),
      "恢复 page 33 后又被旧视口 effect 拉回 page 1",
    )
    await legacyPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "legacy-manual-page33.png"),
      fullPage: false,
    })
    summary.checks.push({
      name: "legacy-restore",
      firstScales: legacySamples.scales.slice(0, 10),
      finalScale: Number(
        await legacyPage.locator(".iread-pdf").getAttribute("data-pdf-scale"),
      ),
      drift: { start: driftStart, end: driftEnd },
      reverse: { start: reverseStart, end: reverseEnd },
      pagesTail: pagesAfterRestore.slice(-8),
    })

    logStep("旧进度一次性迁移到 web profile")
    let migrated = null
    const migrationDeadline = Date.now() + 8_000
    while (Date.now() < migrationDeadline) {
      const current = await readOverrides(api, bookA.bookId, "web")
      if (current?.overrides?.pdf?.zoomMode === "manual") {
        migrated = current
        break
      }
      await sleep(250)
    }
    assert.ok(migrated !== null, "旧进度未迁移到 web profile")
    assert.ok(
      Math.abs(Number(migrated.overrides.pdf.manualScale) - LEGACY_SCALE) < 0.001,
      `迁移后的 manualScale=${migrated.overrides.pdf.manualScale}`,
    )
    summary.checks.push({
      name: "legacy-migration",
      overrides: migrated.overrides,
    })
    await legacyPage.close()

    logStep("写入 web/mobile 独立 profile")
    const webOverrides = {
      pdf: {
        layoutMode: "continuous",
        zoomMode: "manual",
        manualScale: 1.25,
        gap: "compact",
        background: "white",
      },
    }
    const mobileOverrides = {
      pdf: {
        layoutMode: "continuous",
        zoomMode: "manual",
        manualScale: 0.8,
        gap: "relaxed",
        background: "paper",
      },
    }
    await putOverrides(api, bookB.bookId, "web", manifestB.fileVersion, webOverrides)
    await putOverrides(
      api,
      bookB.bookId,
      "mobile",
      manifestB.fileVersion,
      mobileOverrides,
    )

    logStep("web 1000px 打开 → 缩到 390px 切 mobile → 各自恢复")
    const responsiveContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1000, height: 900 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(responsiveContext)
    const responsivePage = await openBook(responsiveContext, bookB.bookId)
    await waitForScale(responsivePage, 1.25)
    assert.equal(
      await responsivePage.locator(".iread-pdf").getAttribute("data-layout"),
      "continuous",
    )
    assert.equal(
      await responsivePage.locator(".iread-pdf").getAttribute("data-gap"),
      "compact",
    )
    await responsivePage.setViewportSize({ width: 390, height: 844 })
    await sleep(400)
    await waitForScale(responsivePage, 0.8)
    assert.equal(
      await responsivePage.locator(".iread-pdf").getAttribute("data-gap"),
      "relaxed",
    )
    await responsivePage.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-profile.png"),
      fullPage: false,
    })
    const beforeScroll = await readOverrides(api, bookB.bookId, "mobile")
    await responsivePage.evaluate(() => {
      const viewport = document.querySelector(".iread-pdf__viewport")
      if (viewport !== null) viewport.scrollTop = 2_400
    })
    await sleep(1_500)
    const afterScroll = await readOverrides(api, bookB.bookId, "mobile")
    assert.equal(afterScroll.revision, beforeScroll.revision)
    assert.deepEqual(afterScroll.overrides, beforeScroll.overrides)
    summary.checks.push({
      name: "profile-switch",
      webScale: 1.25,
      mobileScale: 0.8,
      scrollDidNotChangeProfile: true,
    })
    await responsivePage.close()

    const mobileContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(mobileContext)
    const mobilePage = await openBook(mobileContext, bookB.bookId)
    await waitForScale(mobilePage, 0.8)
    assert.equal(
      await mobilePage.locator(".iread-pdf").getAttribute("data-gap"),
      "relaxed",
    )
    await mobilePage.close()

    const webContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(webContext)
    const webPage = await openBook(webContext, bookB.bookId)
    await waitForScale(webPage, 1.25)
    assert.equal(
      await webPage.locator(".iread-pdf").getAttribute("data-gap"),
      "compact",
    )

    logStep("连续布局 compact/relaxed 跳 page 300 顶部对齐 ±2px")
    const gapResults = []
    for (const gap of ["compact", "relaxed"]) {
      await putOverrides(api, bookB.bookId, "web", manifestB.fileVersion, {
        ...webOverrides,
        pdf: { ...webOverrides.pdf, gap },
      })
      await webPage.reload({ waitUntil: "domcontentloaded" })
      await waitForPdfReady(webPage)
      await waitForScale(webPage, 1.25)
      await jumpToPage(webPage, 300)
      const top = await measurePageTop(webPage, 300)
      assert.ok(top !== null)
      assert.ok(
        Math.abs(top) <= 2,
        `${gap} 跳 page 300 顶部偏移 ${top}px`,
      )
      const current = Number(
        await webPage.locator(".iread-pdf").getAttribute("data-pdf-page"),
      )
      assert.equal(current, 300, `${gap} 跳页后当前页=${current}`)
      gapResults.push({ gap, top })
    }
    await webPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "gap-page300.png"),
      fullPage: false,
    })
    summary.checks.push({ name: "gap-page300", results: gapResults })

    logStep("显式改缩放/布局后刷新恢复，滚动不覆盖 profile")
    await webPage.locator("[data-reader-pdf-zoom-in]").click()
    await webPage.waitForFunction(
      () => {
        const root = document.querySelector(".iread-pdf")
        return (
          root?.getAttribute("data-zoom") === "manual" &&
          Number(root.getAttribute("data-pdf-scale")) > 1.3
        )
      },
      undefined,
      { timeout: 10_000 },
    )
    await webPage.locator("[data-reader-pdf-layout]").click()
    await webPage.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-layout") ===
        "horizontal",
      undefined,
      { timeout: 10_000 },
    )
    await sleep(900)
    const explicitProfile = await readOverrides(api, bookB.bookId, "web")
    const explicitScale = Number(explicitProfile?.overrides?.pdf?.manualScale)
    assert.ok(
      Math.abs(explicitScale - 1.25 * 1.15) < 0.02,
      `工具栏缩放未写入 web profile：${explicitScale}`,
    )
    assert.equal(explicitProfile?.overrides?.pdf?.layoutMode, "horizontal")
    const profileBeforeScroll = explicitProfile.revision
    await webPage.evaluate(() => {
      const viewport = document.querySelector(".iread-pdf__viewport")
      if (viewport !== null) viewport.scrollTop = 1_800
    })
    await sleep(1_200)
    const profileAfterScroll = await readOverrides(api, bookB.bookId, "web")
    assert.equal(profileAfterScroll.revision, profileBeforeScroll)
    await webPage.reload({ waitUntil: "domcontentloaded" })
    await waitForPdfReady(webPage)
    await waitForScale(webPage, explicitScale)
    assert.equal(
      await webPage.locator(".iread-pdf").getAttribute("data-layout"),
      "horizontal",
    )
    summary.checks.push({
      name: "explicit-write-restore",
      manualScale: explicitScale,
      layoutMode: "horizontal",
      scrollDidNotChangeProfile: true,
    })

    writeFileSync(
      path.join(OUT_DIR, "summary.json"),
      JSON.stringify(summary, null, 2),
    )
    console.log(
      `\n[PDF-PROFILE-E2E] 通过；数据 ${path.join(OUT_DIR, "summary.json")}，截图 ${SCREENSHOT_DIR}`,
    )
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
        // 清理失败不覆盖原始错误。
      }
    }
  }
}

main().catch((error) => {
  console.error("\n[PDF-PROFILE-E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
