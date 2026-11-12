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
import { assertReaderToolbarLayout } from "./reader-toolbar-layout.mjs"
import { cdpPinch } from "./reader-pinch-e2e.mjs"

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
const BOTTOM_BAR_STABILITY_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1152, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]
const LONG_PDF_TITLE =
  "性能之巅 系统、企业与云可观测性（第2版） (Brendan Gregg) (z-library.sk, 1lib.sk, z-lib.sk) 超长书名用于验证阅读器顶栏单行省略与右侧图标不被挤压"

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
 *
 * 目录回归用例可传 `outlines: false` 生成无目录 PDF；857 页样本关掉
 * 页内填充以控制生成/上传时间。
 */
function buildPdf({
  encrypted = false,
  pageCount = PAGE_COUNT,
  outlines = true,
  paddingLines = PDF_PADDING_LINES,
  pagePaddingLines = 40,
} = {}) {
  const ids = {
    catalog: 1,
    pages: 2,
    font: 3,
    outlineRoot: 100,
    outlineOne: 101,
    outlineTwo: 102,
    outlineThree: 103,
    encrypt: 200,
  }
  const pageId = (page) => 10 + page
  const contentId = (page) => 30 + page
  let body = "%PDF-1.4\n"
  for (let line = 0; line < paddingLines; line += 1) {
    body += `%${"padding-".repeat(125)}\n`
  }
  const offsets = new Map()

  const writeObject = (id, content) => {
    offsets.set(id, Buffer.byteLength(body))
    body += `${id} 0 obj\n${content}\nendobj\n`
  }

  const kids = []
  for (let page = 1; page <= pageCount; page += 1) {
    kids.push(`${pageId(page)} 0 R`)
  }

  writeObject(
    ids.catalog,
    `<< /Type /Catalog /Pages ${ids.pages} 0 R${
      outlines
        ? ` /Outlines ${ids.outlineRoot} 0 R /PageMode /UseOutlines`
        : ""
    } >>`,
  )
  writeObject(
    ids.pages,
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} /Resources << /Font << /F1 ${ids.font} 0 R >> >> >>`,
  )
  writeObject(
    ids.font,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  )

  for (let page = 1; page <= pageCount; page += 1) {
    const text = escapePdfText(`iRead PDF page ${page} searchable keyword`)
    const content = [
      ...Array.from(
        { length: pagePaddingLines },
        () => `%${"page-padding-".repeat(84)}`,
      ),
      "BT",
      "/F1 22 Tf",
      "72 720 Td",
      `(${text}) Tj`,
      "0 -32 Td",
      `(Second line for page ${page}) Tj`,
      "ET",
    ].join("\n")
    const annotation =
      page === 1 && pageCount >= 3
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

  if (outlines) {
    writeObject(
      ids.outlineRoot,
      `<< /Type /Outlines /First ${ids.outlineOne} 0 R /Last ${ids.outlineThree} 0 R /Count 3 >>`,
    )
    writeObject(
      ids.outlineOne,
      `<< /Title (Chapter One) /Parent ${ids.outlineRoot} 0 R /Dest [${pageId(1)} 0 R /XYZ 0 792 null] /Next ${ids.outlineTwo} 0 R >>`,
    )
    writeObject(
      ids.outlineTwo,
      `<< /Title (Chapter Two) /Parent ${ids.outlineRoot} 0 R /Dest [${pageId(3)} 0 R /XYZ 0 792 null] /Next ${ids.outlineThree} 0 R >>`,
    )
    writeObject(
      ids.outlineThree,
      `<< /Title (External Docs) /Parent ${ids.outlineRoot} 0 R /A << /S /URI /URI (https://example.com/iread-docs) >> >>`,
    )
  }
  if (encrypted) {
    writeObject(
      ids.encrypt,
      "<< /Type /Encrypt /Filter /Standard /V 1 /R 2 /O (iread) /U (iread) /P -4 >>",
    )
  }

  const maxId = encrypted
    ? ids.encrypt
    : outlines
      ? ids.outlineThree
      : Math.max(ids.font, pageId(pageCount), contentId(pageCount))
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

async function uploadPdf(
  api,
  data,
  fileName,
  { readable = true, expectedPageCount = PAGE_COUNT } = {},
) {
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
  assert.equal(manifest?.formatData?.pageCount, expectedPageCount)
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

async function waitForPdfPageCount(page, pageCount, timeout = 60_000) {
  await page.waitForFunction(
    (expected) =>
      Number(
        document.querySelector(".iread-pdf")?.getAttribute("data-pdf-page-count"),
      ) === expected,
    pageCount,
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

/**
 * 底栏断点与 iread.css 一致：>=72rem 保留完整控件，<72rem 收进“⋯ 更多”。
 * 五档视口都必须物理单行，不允许页面或底栏出现横向滚动。
 */
async function assertBottomBarLayout(page) {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]
  const originalViewport = page.viewportSize()
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          }),
      )
      const metrics = await page.evaluate(() => {
        const bar = document.querySelector(".iread-reader-shell__bottombar")
        if (bar === null) {
          return null
        }
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          )
        }
        const barRect = bar.getBoundingClientRect()
        const more = bar.querySelector("[data-reader-more-trigger]")
        const pdfControls = bar.querySelector("[data-reader-pdf-view-controls]")
        const jump = bar.querySelector(".iread-reader-shell__jump")
        const zoomControls = [
          ...bar.querySelectorAll(
            "[data-reader-pdf-zoom-in], [data-reader-pdf-zoom-out]",
          ),
        ].filter(isVisible)
        const slider = bar.querySelector('[role="slider"]')
        return {
          viewportWidth: window.innerWidth,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          bar: {
            rect: barRect.toJSON(),
            position: getComputedStyle(bar).position,
            flexWrap: getComputedStyle(bar).flexWrap,
            scrollWidth: bar.scrollWidth,
            clientWidth: bar.clientWidth,
          },
          moreVisible: more !== null && isVisible(more),
          moreHaspopup: more?.getAttribute("aria-haspopup") ?? null,
          moreExpanded: more?.getAttribute("aria-expanded") ?? null,
          pdfControlsVisible:
            pdfControls !== null && isVisible(pdfControls),
          jumpVisible: jump !== null && isVisible(jump),
          sliderVisible: slider !== null && isVisible(slider),
          zoomControlCount: zoomControls.length,
          controls: [...bar.querySelectorAll('button, input, [role="slider"]')]
            .filter(isVisible)
            .map((element) => ({
              label:
                element.getAttribute("aria-label") ??
                element.textContent?.trim().slice(0, 30) ??
                "",
              tag: element.tagName,
              rect: element.getBoundingClientRect().toJSON(),
              minWidth: getComputedStyle(element).minWidth,
              minHeight: getComputedStyle(element).minHeight,
              width: getComputedStyle(element).width,
              height: getComputedStyle(element).height,
            })),
        }
      })
      const prefix = `PDF 底栏 @ ${viewport.width}x${viewport.height}`
      assert.ok(metrics !== null, `${prefix}：底栏缺失`)
      assert.equal(metrics.viewportWidth, viewport.width, `${prefix}：视口宽度异常`)
      assert.equal(
        metrics.bar.flexWrap,
        "nowrap",
        `${prefix}：底栏必须禁止换行`,
      )
      assert.ok(
        metrics.bar.rect.height <= 64,
        `${prefix}：底栏必须物理单行，实际高度 ${metrics.bar.rect.height}`,
      )
      assert.ok(
        metrics.bar.scrollWidth <= metrics.bar.clientWidth + 1,
        `${prefix}：底栏不得横向溢出（${metrics.bar.scrollWidth} > ${metrics.bar.clientWidth}）`,
      )
      assert.ok(
        metrics.scrollWidth <= metrics.clientWidth + 1 &&
          metrics.bodyScrollWidth <= metrics.clientWidth + 1,
        `${prefix}：页面不得出现横向溢出`,
      )
      for (const control of metrics.controls) {
        assert.ok(
          control.rect.top >= metrics.bar.rect.top - 1 &&
            control.rect.bottom <= metrics.bar.rect.bottom + 1,
          `${prefix}：控件 ${control.label || "未命名"} 超出单行底栏`,
        )
      }
      if (viewport.width < 72 * 16) {
        assert.equal(metrics.moreVisible, true, `${prefix}：窄屏必须显示“⋯ 更多”`)
        assert.equal(
          metrics.pdfControlsVisible,
          false,
          `${prefix}：窄屏完整 PDF 控件应收进菜单`,
        )
        assert.equal(metrics.jumpVisible, false, `${prefix}：窄屏跳页应收进菜单`)
      } else {
        assert.equal(metrics.moreVisible, false, `${prefix}：宽屏不得显示“⋯ 更多”`)
        assert.equal(
          metrics.pdfControlsVisible,
          true,
          `${prefix}：宽屏必须保留完整 PDF 控件`,
        )
        assert.equal(metrics.jumpVisible, true, `${prefix}：宽屏必须保留页码跳转`)
      }
      if (viewport.width < 768) {
        assert.equal(
          metrics.bar.position,
          "absolute",
          `${prefix}：手机底栏必须悬浮在正文上方`,
        )
        assert.equal(
          metrics.zoomControlCount,
          0,
          `${prefix}：手机底栏不得出现可见的放大/缩小按钮`,
        )
        assert.equal(
          metrics.sliderVisible,
          true,
          `${prefix}：手机翻页格式必须保留进度条`,
        )
        assert.equal(metrics.moreHaspopup, "dialog", `${prefix}：“⋯”必须声明 dialog 弹层`)
        assert.equal(metrics.moreExpanded, "false", `${prefix}：“⋯”关闭时必须 aria-expanded=false`)
        for (const control of metrics.controls.filter((item) => item.tag === "BUTTON")) {
          assert.ok(
            control.rect.width >= 40 && control.rect.height >= 40,
            `${prefix}：触控目标 ${control.label || "未命名"} 必须至少 40×40，实际 ${control.rect.width}×${control.rect.height}，min=${control.minWidth}/${control.minHeight}，css=${control.width}/${control.height}`,
          )
        }
      } else {
        assert.equal(
          metrics.bar.position,
          "relative",
          `${prefix}：桌面/平板底栏必须保持占布局`,
        )
      }
      console.log(
        `[E2E] 底栏 ${viewport.width}x${viewport.height}：height=${metrics.bar.rect.height}, barScroll=${metrics.bar.scrollWidth}/${metrics.bar.clientWidth}, pageScroll=${metrics.scrollWidth}/${metrics.clientWidth}`,
      )
      await page.screenshot({
        path: path.join(
          SCREENSHOT_DIR,
          `bottom-bar-${viewport.width}x${viewport.height}.png`,
        ),
      })
    }
  } finally {
    if (originalViewport !== null) {
      await page.setViewportSize(originalViewport).catch(() => {})
    }
  }
}

/**
 * 底栏加载态/ready 快照：只读 DOM 与几何，用于断言两阶段结构一致。
 */
async function captureBottomBar(page) {
  const viewportWidth = page.viewportSize()?.width ?? 0
  await page.waitForFunction(
    ({ narrow }) => {
      const bar = document.querySelector(".iread-reader-shell__bottombar")
      const next = bar?.querySelector("[data-reader-page-next]") ?? null
      if (bar === null || next === null) {
        return false
      }
      // 跨断点 resize 时 Chromium 的 display:contents + order 重算可能落后一帧；
      // 等窄屏 order=3 / 宽屏 order=0 再取几何，避免把过渡态当成布局回跳。
      return narrow ? getComputedStyle(next).order === "3" : getComputedStyle(next).order === "0"
    },
    { narrow: viewportWidth < 72 * 16 },
    { timeout: 5_000, polling: "raf" },
  )
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
  )
  return page.evaluate(() => {
    const bar = document.querySelector(".iread-reader-shell__bottombar")
    if (bar === null) {
      return null
    }
    const shell = document.querySelector(".iread-reader-shell")
    const isVisible = (element) => {
      if (element === null) {
        return false
      }
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      )
    }
    const rectOf = (element) =>
      element === null ? null : element.getBoundingClientRect().toJSON()
    const jump = bar.querySelector(".iread-reader-shell__jump")
    const jumpInput = jump?.querySelector("input") ?? null
    const jumpSubmit = jump?.querySelector('button[type="submit"]') ?? null
    const jumpParts = jump
      ? [
          jump.querySelector("label"),
          jumpInput,
          jumpSubmit,
        ].map(rectOf)
      : []
    const pdf = bar.querySelector("[data-reader-pdf-view-controls]")
    const more = bar.querySelector("[data-reader-more-trigger]")
    const slider = bar.querySelector('[role="slider"]')
    const wide = bar.querySelector(
      ".iread-reader-shell__position-text--wide",
    )
    const compact = bar.querySelector("[data-reader-compact-position]")
    return {
      height: bar.getBoundingClientRect().height,
      flexWrap: getComputedStyle(bar).flexWrap,
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      engineReady: shell?.hasAttribute("data-reader-engine-ready") ?? false,
      ariaBusy: bar.getAttribute("aria-busy"),
      hintCount: document.querySelectorAll(
        ".iread-reader-shell__engine-hint",
      ).length,
      text: bar.innerText,
      wideVisible: isVisible(wide),
      compactVisible: isVisible(compact),
      compactRect: rectOf(compact),
      pdfVisible: isVisible(pdf),
      pdfRect: rectOf(pdf),
      pdfButtons: [...(pdf?.querySelectorAll("button") ?? [])].map(
        (button) => ({
          label: button.getAttribute("aria-label"),
          disabled: button.disabled,
        }),
      ),
      prevDisabled:
        bar.querySelector("[data-reader-page-previous]")?.disabled ?? null,
      nextDisabled:
        bar.querySelector("[data-reader-page-next]")?.disabled ?? null,
      prevRect: rectOf(bar.querySelector("[data-reader-page-previous]")),
      nextRect: rectOf(bar.querySelector("[data-reader-page-next]")),
      sliderRect: rectOf(slider),
      sliderDisabled:
        slider === null
          ? null
          : slider.hasAttribute("data-disabled") ||
            slider.getAttribute("aria-disabled") === "true",
      jumpVisible: isVisible(jump),
      jumpRect: rectOf(jump),
      jumpParts,
      jumpInputDisabled: jumpInput?.disabled ?? null,
      jumpSubmitDisabled: jumpSubmit?.disabled ?? null,
      moreVisible: isVisible(more),
      moreRect: rectOf(more),
    }
  })
}

async function measureBottomBarAcrossViewports(page, phase) {
  const originalViewport = page.viewportSize()
  const results = []
  try {
    for (const viewport of BOTTOM_BAR_STABILITY_VIEWPORTS) {
      await page.setViewportSize(viewport)
      const snapshot = await captureBottomBar(page)
      const prefix = `PDF 底栏${phase} @ ${viewport.width}x${viewport.height}`
      assert.ok(snapshot !== null, `${prefix}：底栏缺失`)
      assert.equal(snapshot.flexWrap, "nowrap", `${prefix}：底栏必须禁止换行`)
      assert.ok(
        snapshot.height > 0 && snapshot.height <= 64,
        `${prefix}：底栏必须物理单行，实际高度 ${snapshot.height}`,
      )
      assert.equal(
        snapshot.hintCount,
        0,
        `${prefix}：不得再出现 engine-hint`,
      )
      assert.ok(
        snapshot.scrollWidth <= snapshot.clientWidth + 1,
        `${prefix}：底栏不得横向溢出（${snapshot.scrollWidth} > ${snapshot.clientWidth}）`,
      )
      assert.equal(
        snapshot.prevDisabled,
        phase === "加载态",
        `${prefix}：上一页 disabled 状态不符`,
      )
      assert.equal(
        snapshot.nextDisabled,
        phase === "加载态",
        `${prefix}：下一页 disabled 状态不符`,
      )
      assert.equal(
        snapshot.sliderDisabled,
        phase === "加载态",
        `${prefix}：进度条 disabled 状态不符`,
      )

      if (phase === "加载态") {
        assert.equal(snapshot.engineReady, false, `${prefix}：不得提前标记 ready`)
        assert.equal(snapshot.ariaBusy, "true", `${prefix}：底栏必须 aria-busy=true`)
        assert.match(
          snapshot.text,
          /正在读取|读取中/,
          `${prefix}：position 必须显示读取状态`,
        )
        assert.doesNotMatch(
          snapshot.text,
          /引擎尚未接入|引擎尚未就绪/,
          `${prefix}：不得误报引擎未接入`,
        )
      } else {
        assert.equal(snapshot.engineReady, true, `${prefix}：ready 标记缺失`)
        assert.equal(
          snapshot.ariaBusy,
          "false",
          `${prefix}：ready 后底栏必须 aria-busy=false`,
        )
        assert.doesNotMatch(
          snapshot.text,
          /正在读取|读取中/,
          `${prefix}：ready 后不得残留读取状态`,
        )
      }

      if (viewport.width >= 72 * 16) {
        assert.equal(
          snapshot.pdfVisible,
          true,
          `${prefix}：宽屏必须提前渲染 PDF 控件组`,
        )
        assert.ok(
          snapshot.pdfButtons.length >= 6,
          `${prefix}：PDF 控件组不完整`,
        )
        for (const button of snapshot.pdfButtons) {
          assert.equal(
            button.disabled,
            phase === "加载态",
            `${prefix}：PDF 控件 ${button.label ?? "未命名"} disabled 状态不符`,
          )
        }
        assert.equal(
          snapshot.jumpVisible,
          true,
          `${prefix}：宽屏必须保留页码跳转`,
        )
        assert.ok(
          snapshot.jumpRect !== null &&
            Math.abs(snapshot.jumpRect.height - 36) <= 1,
          `${prefix}：跳页行必须保持 36px 高，实际 ${snapshot.jumpRect?.height}`,
        )
        const tops = snapshot.jumpParts
          .filter((rect) => rect !== null)
          .map((rect) => rect.top)
        assert.equal(tops.length, 3, `${prefix}：跳页行结构不完整`)
        assert.ok(
          Math.max(...tops) - Math.min(...tops) <= 1,
          `${prefix}：跳页 label/input/button 必须顶部对齐（${tops.join(", ")}）`,
        )
        assert.equal(
          snapshot.jumpInputDisabled,
          phase === "加载态",
          `${prefix}：页码输入 disabled 状态不符`,
        )
        assert.equal(
          snapshot.jumpSubmitDisabled,
          phase === "加载态",
          `${prefix}：跳转提交 disabled 状态不符`,
        )
      } else {
        assert.equal(
          snapshot.pdfVisible,
          false,
          `${prefix}：窄屏 PDF 控件应仍在“⋯ 更多”中`,
        )
        assert.equal(
          snapshot.moreVisible,
          true,
          `${prefix}：窄屏必须显示“⋯ 更多”`,
        )
      }

      results.push({ viewport, snapshot })
      console.log(
        `[E2E] ${prefix}：height=${snapshot.height}, text=${JSON.stringify(snapshot.text)}, pdf=${snapshot.pdfVisible}, jump=${snapshot.jumpVisible}, prev=${snapshot.prevRect?.left}, next=${snapshot.nextRect?.left}, compact=${snapshot.compactRect?.left}/${snapshot.compactRect?.width}, slider=${snapshot.sliderRect?.left}`,
      )
    }
  } finally {
    if (originalViewport !== null) {
      await page.setViewportSize(originalViewport).catch(() => {})
    }
  }
  return results
}

async function assertLoadingMoreMenuDisabled(page) {
  const menu = await openPdfMoreMenu(page)
  await menu.waitFor({ timeout: 5_000 })
  for (const selector of [
    "[data-reader-more-zoom-out]",
    "[data-reader-more-zoom-in]",
    "[data-reader-more-zoom-reset]",
    "[data-reader-more-fit-width]",
    "[data-reader-more-fit-page]",
    '[data-reader-more-layout="single"]',
    '[data-reader-more-layout="continuous"]',
    '[data-reader-more-layout="horizontal"]',
    "[data-reader-more-rotate]",
    "[data-reader-more-jump-input]",
    "[data-reader-more-jump-submit]",
  ]) {
    const control = page.locator(selector)
    assert.equal(
      await control.count(),
      1,
      `加载态“⋯ 更多”菜单缺少 ${selector}`,
    )
    assert.equal(
      await control.isDisabled(),
      true,
      `加载态“⋯ 更多”菜单项 ${selector} 必须禁用`,
    )
  }
  await closePdfMoreMenu(page)
}

async function openPdfMoreMenu(page) {
  await page.locator("[data-reader-more-trigger]").click()
  const menu = page.locator("[data-reader-more-menu]")
  await menu.waitFor({ timeout: 5_000 })
  assert.equal(
    await page.locator("[data-reader-more-trigger]").getAttribute("aria-expanded"),
    "true",
    "“⋯”打开后必须 aria-expanded=true",
  )
  return menu
}

async function closePdfMoreMenu(page) {
  const menu = page.locator("[data-reader-more-menu]")
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "hidden" })
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

/**
 * 页内偏移必须稳定一段时间再读取：跳页/旋转后可能仍有排版的 rAF
 * 重排把滚动位置回到页首。这里等可观察的 data-pdf-page-offset 连续
 * 稳定，不用固定 sleep，也不放宽 > 0.02 的核心断言。
 */
async function waitForStablePdfOffset(
  page,
  { minimum = 0.02, stableMs = 400, timeout = 10_000 } = {},
) {
  await page.waitForFunction(
    ({ minimum, stableMs }) => {
      const offset = Number(
        document
          .querySelector(".iread-pdf")
          ?.getAttribute("data-pdf-page-offset"),
      )
      if (!Number.isFinite(offset) || offset <= minimum) {
        window.__ireadStablePdfOffset = null
        return false
      }
      const now = performance.now()
      const state = window.__ireadStablePdfOffset
      if (
        !state ||
        Math.abs(state.offset - offset) > 1e-4
      ) {
        window.__ireadStablePdfOffset = { offset, since: now }
        return false
      }
      return now - state.since >= stableMs
    },
    { minimum, stableMs },
    { timeout },
  )
  return Number(
    await page
      .locator(".iread-pdf")
      .getAttribute("data-pdf-page-offset"),
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

    logStep("配置全局 PDF 设置（布局/缩放/页距/背景）")
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
      `${LONG_PDF_TITLE}.pdf`,
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

    logStep("加载态底栏：与 ready 同构、物理单行、无 engine-hint、PDF 控件禁用")
    const loadingContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    contexts.push(loadingContext)
    const loadingPage = await loadingContext.newPage()
    let releaseLoadingContent = () => {}
    const loadingContentGate = new Promise((resolve) => {
      releaseLoadingContent = resolve
    })
    await loadingPage.route("**/versions/*/content*", async (route) => {
      await loadingContentGate
      await route.continue()
    })
    await loadingPage.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await loadingPage
      .locator(".iread-reader-shell__bottombar")
      .waitFor({ timeout: 20_000 })
    await loadingPage
      .locator("#reader-jump-page")
      .waitFor({ state: "attached", timeout: 20_000 })
    await loadingPage
      .locator("[data-reader-pdf-view-controls]")
      .waitFor({ timeout: 20_000 })
    await loadingPage.waitForFunction(
      () =>
        /正在读取|读取中/.test(
          document.querySelector(".iread-reader-shell__bottombar")?.innerText ??
            "",
        ),
      undefined,
      { timeout: 20_000 },
    )
    assert.equal(
      await loadingPage.locator("[data-reader-engine-ready]").count(),
      0,
      "加载态不得提前出现 data-reader-engine-ready",
    )
    assert.equal(
      await loadingPage.locator(".iread-reader-shell__engine-hint").count(),
      0,
      "加载态不得出现 engine-hint",
    )

    const loadingSnapshots = await measureBottomBarAcrossViewports(
      loadingPage,
      "加载态",
    )
    await loadingPage.setViewportSize({ width: 1920, height: 1080 })
    await loadingPage.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
    await loadingPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "loading-1920x1080.png"),
    })
    await loadingPage.setViewportSize({ width: 390, height: 844 })
    await loadingPage.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
    await loadingPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "loading-390x844.png"),
    })
    await assertLoadingMoreMenuDisabled(loadingPage)

    releaseLoadingContent()
    await loadingPage
      .locator(".iread-reader-shell[data-reader-engine-ready]")
      .waitFor({ timeout: 30_000 })
    await loadingPage
      .locator('.iread-pdf[data-pdf-ready="true"]')
      .waitFor({ timeout: 30_000 })
    await loadingPage
      .locator('.iread-pdf__page[data-pdf-page="1"] canvas')
      .waitFor({ timeout: 30_000 })
    await loadingPage.waitForFunction(
      () =>
        !/正在读取|读取中/.test(
          document.querySelector(".iread-reader-shell__bottombar")?.innerText ??
            "",
        ),
      undefined,
      { timeout: 20_000 },
    )
    const readySnapshots = await measureBottomBarAcrossViewports(
      loadingPage,
      "ready",
    )

    const readyByWidth = new Map(
      readySnapshots.map(({ viewport, snapshot }) => [
        viewport.width,
        snapshot,
      ]),
    )
    for (const { viewport, snapshot } of loadingSnapshots) {
      const ready = readyByWidth.get(viewport.width)
      const prefix = `PDF 底栏加载/ready 对比 @ ${viewport.width}x${viewport.height}`
      assert.ok(ready !== undefined, `${prefix}：ready 快照缺失`)
      assert.ok(
        Math.abs(snapshot.height - ready.height) <= 1,
        `${prefix}：底栏高度必须一致（${snapshot.height} -> ${ready.height}）`,
      )
      for (const key of [
        "pdfRect",
        "jumpRect",
        "moreRect",
        "sliderRect",
        "prevRect",
        "nextRect",
      ]) {
        const before = snapshot[key]
        const after = ready[key]
        if (before === null || after === null) {
          continue
        }
        assert.ok(
          Math.abs(before.left - after.left) <= 1 &&
            Math.abs(before.top - after.top) <= 1,
          `${prefix}：${key} 位置必须稳定（${before.left},${before.top} -> ${after.left},${after.top}）`,
        )
      }
    }

    await loadingPage.setViewportSize({ width: 1920, height: 1080 })
    await loadingPage.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
    await loadingPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "ready-1920x1080.png"),
    })
    await loadingPage.setViewportSize({ width: 390, height: 844 })
    await loadingPage.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
    await loadingPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "ready-390x844.png"),
    })
    await loadingPage.close()
    await loadingContext.close()

    const page = await desktopContext.newPage()
    page.on("response", (response) => {
      if (response.status() === 409) {
        console.log(
          `[E2E] 409 ${response.request().method()} ${response.url()}`,
        )
      }
    })
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
    await page
      .getByRole("heading", { level: 1, name: LONG_PDF_TITLE })
      .waitFor({ timeout: 20_000 })
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
    assert.equal(
      await page.locator(".iread-pdf__toolbar").count(),
      0,
      "PDF 引擎不得再创建中间工具栏",
    )
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

    await page.keyboard.press("Control+f")
    await searchPanel.waitFor({ state: "visible" })
    await page.keyboard.press("Escape")
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
    await page
      .locator('.iread-pdf__page[data-pdf-page="7"][data-state="ready"]')
      .waitFor({ timeout: 20_000 })
    const beforeOffset = await waitForStablePdfOffset(page)
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
    // 滚动进度只保存位置；视图由按 profile 的 reader-overrides 保存。
    assert.equal(saved?.locatorPayload?.view, null)
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

    logStep("顶栏 1920/1440/1024/768/390：单行对齐、长书名省略与操作区完整")
    await assertReaderToolbarLayout(page, {
      label: "PDF 阅读器顶栏",
      expectEllipsis: () => true,
    })
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-toolbar-long-title.png"),
    })

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
    const conflictRoot = conflictPage.locator(".iread-pdf")
    assert.match(
      (await conflictRoot.getAttribute("data-error-detail")) ?? "",
      /PDF 原件.*更新/,
      "409 错误必须带可诊断的 data-error-detail",
    )
    assert.equal(
      await conflictPage.locator(".iread-pdf__error-detail:not([hidden])").count(),
      1,
      "错误页必须显示技术详情行",
    )
    assert.equal(
      await conflictPage.getByRole("button", { name: "复制 PDF 诊断信息" }).count(),
      1,
      "错误页必须提供复制诊断信息按钮",
    )
    assert.equal(
      await conflictPage.getByRole("button", { name: "重试打开 PDF" }).count(),
      1,
    )
    await conflictPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-409.png"),
    })
    await conflictPage.close()

    logStep("worker 静态资源 404：显示专门 worker_failed 文案")
    const workerPage = await desktopContext.newPage()
    await workerPage.route(
      (url) => /pdf\.worker\.compat/.test(url.pathname) && url.searchParams.has("src"),
      async (route) => {
        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: "worker not found",
        })
      },
    )
    await workerPage.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await workerPage
      .locator('.iread-pdf[data-pdf-state="error"]')
      .waitFor({ timeout: 20_000 })
    const workerRoot = workerPage.locator(".iread-pdf")
    assert.equal(
      await workerRoot.getAttribute("data-error-code"),
      "worker_failed",
      "worker 资源加载失败必须映射为 worker_failed",
    )
    assert.match(
      (await workerRoot.getAttribute("data-error-detail")) ?? "",
      /worker|dynamically imported|fetch/i,
      "worker 失败必须保留原始动态 import 错误",
    )
    assert.equal(
      await workerPage.getByRole("button", { name: "复制 PDF 诊断信息" }).count(),
      1,
    )
    assert.equal(
      await workerPage.locator(".iread-pdf__error-title").textContent(),
      "PDF 解析组件加载失败",
    )
    await workerPage.close()

    logStep("旧内核 + WebAssembly 缺失：still 可打开 PDF（兼容构建与补丁）")
    const legacyPage = await desktopContext.newPage()
    await legacyPage.addInitScript(() => {
      // 模拟 Chrome < 119 / 企业策略裁剪：这些 API 在旧内核中不存在。
      delete Promise.withResolvers
      delete globalThis.structuredClone
      delete Uint8Array.prototype.toHex
      delete Uint8Array.prototype.toBase64
      delete Uint8Array.prototype.fromBase64
      delete Uint8Array.prototype.setFromBase64
      delete Uint8Array.prototype.setFromHex
      delete Map.prototype.getOrInsert
      delete Map.prototype.getOrInsertComputed
      delete WeakMap.prototype.getOrInsert
      delete WeakMap.prototype.getOrInsertComputed
      delete Set.prototype.union
      delete Set.prototype.intersection
      delete Set.prototype.difference
      delete Math.sumPrecise
      // 模拟企业策略禁用 WebAssembly。
      Object.defineProperty(globalThis, "WebAssembly", {
        value: undefined,
        configurable: true,
        writable: true,
      })
      delete globalThis.WebAssembly
    })
    await legacyPage.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await legacyPage
      .locator('.iread-pdf[data-pdf-ready="true"]')
      .waitFor({ timeout: 30_000 })
    await legacyPage
      .locator('.iread-pdf__page[data-state="ready"] canvas')
      .first()
      .waitFor({ timeout: 30_000 })
    assert.equal(
      Number(await legacyPage.locator(".iread-pdf").getAttribute("data-pdf-page-count")),
      PAGE_COUNT,
      "兼容构建必须仍能解析真实 PDF",
    )
    assert.equal(
      await legacyPage.locator(".iread-pdf").getAttribute("data-error-code"),
      null,
      "旧内核兼容路径不得残留错误码",
    )
    await legacyPage.close()

    logStep("重试打开：失败后重试成功，错误/loading/底部 notice 全部清除")
    const retryPage = await desktopContext.newPage()
    let failContent = true
    await retryPage.route("**/content", async (route) => {
      if (failContent) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "storage_unavailable",
              message: "temporary",
              requestId: "",
              details: {},
            },
          }),
        })
        return
      }
      await route.continue()
    })
    await retryPage.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await retryPage
      .locator('.iread-pdf[data-pdf-state="error"]')
      .waitFor({ timeout: 20_000 })
    await retryPage
      .locator('.iread-pdf__error:not([hidden])')
      .waitFor({ timeout: 10_000 })
    assert.equal(
      await retryPage.locator('.iread-pdf__loading:not([hidden])').count(),
      0,
      "失败后 loading 必须隐藏",
    )
    failContent = false
    await retryPage.getByRole("button", { name: "重试打开 PDF" }).click()
    await retryPage
      .locator('.iread-pdf[data-pdf-ready="true"]')
      .waitFor({ timeout: 30_000 })
    await retryPage
      .locator('.iread-pdf__page[data-pdf-page="1"][data-state="ready"] canvas')
      .waitFor({ timeout: 30_000 })
    const retryRoot = retryPage.locator(".iread-pdf")
    assert.equal(
      await retryRoot.getAttribute("data-pdf-state"),
      "ready",
      "重试成功后状态必须回到 ready",
    )
    assert.equal(
      await retryRoot.getAttribute("data-error-code"),
      null,
      "重试成功后不得残留错误码",
    )
    assert.equal(
      Number(await retryRoot.getAttribute("data-pdf-page-count")),
      PAGE_COUNT,
    )
    assert.equal(
      await retryPage.locator('.iread-pdf__error:not([hidden])').count(),
      0,
      "重试成功后错误遮罩必须隐藏",
    )
    assert.equal(
      await retryPage.locator('.iread-pdf__loading:not([hidden])').count(),
      0,
      "重试成功后 loading 必须隐藏",
    )
    assert.equal(
      (await retryPage.locator(".iread-pdf__notice").innerText()).trim(),
      "",
      "重试成功后引擎 notice 必须清空",
    )
    assert.equal(
      await retryPage.locator(".iread-reader-shell__notice").count(),
      0,
      "重试成功后底部 notice 必须清空",
    )
    assert.equal(
      await retryPage.locator(".iread-reader-shell__engine-hint").count(),
      0,
      "重试成功后 Shell 必须恢复翻页/跳页能力",
    )
    assert.equal(
      await retryPage.locator("#reader-jump-page").isEnabled(),
      true,
      "重试成功后页码输入必须可用",
    )
    assert.equal(
      await retryPage.locator("[data-reader-page-next]").isEnabled(),
      true,
      "重试成功后下一页按钮必须可用",
    )
    assert.match(
      (await retryPage
        .locator(".iread-reader-shell__position-text")
        .first()
        .innerText()) ?? "",
      new RegExp(`第 1 / ${PAGE_COUNT} 页`),
      "重试成功后 Shell 位置必须显示真实页数",
    )
    await retryPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-retry-recovered.png"),
    })
    await retryPage.close()

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

    logStep("Shell PDF 目录外链与无中间栏")
    assert.equal(
      await page.locator(".iread-pdf__toolbar").count(),
      0,
      "PDF 引擎不得再创建中间工具栏",
    )
    await page.getByRole("button", { name: "目录与书签" }).click()
    const externalToc = page.locator('[data-reader-panel="toc"]')
    await externalToc.waitFor({ timeout: 5_000 })
    const externalLink = externalToc.locator('[data-reader-pdf-outline-url]')
    await externalLink.waitFor({ timeout: 15_000 })
    assert.equal(
      await externalLink.getAttribute("href"),
      "https://example.com/iread-docs",
      "PDF 目录外链必须保留原始 URL",
    )
    assert.equal(await externalLink.getAttribute("target"), "_blank")
    const externalRel = (await externalLink.getAttribute("rel")) ?? ""
    assert.ok(externalRel.split(/\s+/).includes("noreferrer"), "外链必须带 noreferrer")
    assert.ok(externalRel.split(/\s+/).includes("noopener"), "外链必须带 noopener")
    assert.equal(
      (await externalLink.textContent())?.trim(),
      "External Docs",
      "外链必须显示目录标题",
    )
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-pdf-outline-external.png"),
    })
    await page.getByRole("button", { name: "关闭面板", exact: true }).click()
    await externalToc.waitFor({ state: "hidden" })

    logStep("五档视口：底栏物理单行且无横向溢出")
    await assertBottomBarLayout(page)

    // 手机段开始前关闭桌面页：避免同一会话的两个页面并发写进度/轮换 CSRF，
    // 干扰手机退出保存与跨上下文进度对账。桌面进度已确认在第 7 页。
    await page.close()
    await waitForPdfProgress(adminApi, uploaded.bookId, 7)

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
    // 手机段只验证搜索/目录/设置/底栏；跨上下文进度对账弹窗按“稍后处理”关闭。
    await mobile.addLocatorHandler(
      mobile.getByRole("alertdialog", { name: "阅读进度冲突" }),
      async () => {
        await mobile.getByRole("button", { name: "稍后处理" }).click()
      },
    )
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
    const mobileManualScale = mobile.getByRole("slider", { name: "手动缩放" })
    await mobileManualScale.waitFor({ timeout: 5_000 })
    assert.equal(
      await mobileManualScale.getAttribute("aria-valuenow"),
      "120",
      "阅读器内手动缩放必须显示 120%，不得出现 10000%",
    )
    assert.equal(await mobileManualScale.getAttribute("aria-valuemin"), "25")
    assert.equal(await mobileManualScale.getAttribute("aria-valuemax"), "400")
    const mobileManualScaleField = mobile
      .locator(".iread-reader-settings__field")
      .filter({ hasText: "手动缩放" })
    assert.equal(
      (await mobileManualScaleField.locator(".iread-reader-settings__value").innerText()).trim(),
      "120%",
    )
    assert.ok(
      !(await mobileManualScaleField.innerText()).includes("10000"),
      "阅读器内 PDF 设置不得显示 10000%",
    )
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-pdf-settings.png"),
    })
    await mobile.keyboard.press("Escape")
    await mobileSettings.waitFor({ state: "hidden" })

    logStep("手机 390x844：底栏单行与“⋯ 更多”逐项可用")
    const mobileBar = await mobile.evaluate(() => {
      const bar = document.querySelector(".iread-reader-shell__bottombar")
      const rect = bar?.getBoundingClientRect()
      return {
        height: rect?.height ?? 0,
        flexWrap: bar === null ? "" : getComputedStyle(bar).flexWrap,
        scrollWidth: bar?.scrollWidth ?? 0,
        clientWidth: bar?.clientWidth ?? 0,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
        toolbarCount: document.querySelectorAll(".iread-pdf__toolbar").length,
        moreVisible:
          document.querySelector("[data-reader-more-trigger]") !== null,
      }
    })
    assert.ok(mobileBar.height > 0 && mobileBar.height <= 64, `手机底栏必须单行，实际 ${mobileBar.height}`)
    assert.equal(mobileBar.flexWrap, "nowrap")
    assert.ok(mobileBar.scrollWidth <= mobileBar.clientWidth + 1, "手机底栏不得横向溢出")
    assert.ok(
      mobileBar.pageScrollWidth <= mobileBar.pageClientWidth + 1,
      "手机页面不得横向溢出",
    )
    assert.equal(mobileBar.toolbarCount, 0, "PDF 引擎中间工具栏必须为 0")
    assert.equal(mobileBar.moreVisible, true, "手机底栏必须显示“⋯ 更多”")

    await openPdfMoreMenu(mobile)
    for (const selector of [
      "[data-reader-more-zoom-out]",
      "[data-reader-more-zoom-in]",
      "[data-reader-more-fit-width]",
      "[data-reader-more-fit-page]",
      '[data-reader-more-layout="single"]',
      '[data-reader-more-layout="continuous"]',
      '[data-reader-more-layout="horizontal"]',
      "[data-reader-more-rotate]",
      "[data-reader-more-jump-input]",
      "[data-reader-more-jump-submit]",
    ]) {
      assert.equal(
        await mobile.locator(selector).count(),
        1,
        `“⋯ 更多”菜单缺少 ${selector}`,
      )
    }
    await mobile.locator("[data-reader-more-jump-input]").fill("5")
    await mobile.locator("[data-reader-more-jump-submit]").click()
    await waitForPage(mobile, 5)
    await waitForShellPage(mobile, 5)
    await mobile.locator("[data-reader-more-menu]").waitFor({ state: "hidden" })

    await openPdfMoreMenu(mobile)
    const scaleBefore = Number(
      await mobile.locator(".iread-pdf").getAttribute("data-pdf-scale"),
    )
    await mobile.locator("[data-reader-more-zoom-out]").click()
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "manual",
      undefined,
      { timeout: 10_000 },
    )
    const scaleAfterOut = Number(
      await mobile.locator(".iread-pdf").getAttribute("data-pdf-scale"),
    )
    assert.ok(
      scaleAfterOut < scaleBefore,
      `菜单缩小必须生效（${scaleBefore} -> ${scaleAfterOut}）`,
    )
    await mobile.locator("[data-reader-more-zoom-in]").click()
    await mobile.waitForFunction(
      (before) =>
        Number(
          document.querySelector(".iread-pdf")?.getAttribute("data-pdf-scale"),
        ) > before,
      scaleAfterOut,
      { timeout: 10_000 },
    )
    await mobile.locator("[data-reader-more-fit-width]").click()
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "fit-width",
      undefined,
      { timeout: 10_000 },
    )
    assert.equal(
      (await mobile.locator("[data-reader-more-zoom-value]").textContent())?.trim(),
      "自动",
      "适宽必须显示“自动”而不是伪造百分比",
    )
    await mobile.locator("[data-reader-more-fit-page]").click()
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "fit-page",
      undefined,
      { timeout: 10_000 },
    )
    assert.equal(
      (await mobile.locator("[data-reader-more-zoom-value]").textContent())?.trim(),
      "自动",
      "适页必须显示“自动”而不是伪造百分比",
    )
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-pdf-more-menu.png"),
    })

    await mobile.locator('[data-reader-more-layout="horizontal"]').click()
    await mobile.locator("[data-reader-more-menu]").waitFor({ state: "hidden" })
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-layout") ===
        "horizontal",
      undefined,
      { timeout: 10_000 },
    )
    assert.equal(await currentPage(mobile), 5, "菜单切换布局不得误翻页")
    await openPdfMoreMenu(mobile)
    assert.equal(
      await mobile
        .locator('[data-reader-more-layout="horizontal"]')
        .getAttribute("data-selected"),
      "true",
      "菜单必须标出当前布局",
    )
    await mobile.locator('[data-reader-more-layout="continuous"]').click()
    await mobile.locator("[data-reader-more-menu]").waitFor({ state: "hidden" })
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-layout") ===
        "continuous",
      undefined,
      { timeout: 10_000 },
    )

    await openPdfMoreMenu(mobile)
    await mobile.locator("[data-reader-more-rotate]").click()
    await mobile.locator("[data-reader-more-menu]").waitFor({ state: "hidden" })
    await sleep(500)
    await waitForPage(mobile, 5)
    assert.equal(await currentPage(mobile), 5, "菜单旋转不得误翻页")
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-pdf-page-5.png"),
    })

    logStep("手机 390x844：悬浮工具栏、双指整体缩放与 locator 恢复")
    const floating = await mobile.evaluate(() => {
      const topbar = document.querySelector(".iread-reader-shell__topbar")
      const bottombar = document.querySelector(".iread-reader-shell__bottombar")
      const stage = document.querySelector(".iread-reader-shell__stage")
      return {
        topbar: {
          position: getComputedStyle(topbar).position,
          rect: topbar.getBoundingClientRect().toJSON(),
        },
        bottombar: {
          position: getComputedStyle(bottombar).position,
          rect: bottombar.getBoundingClientRect().toJSON(),
        },
        stage: {
          rect: stage.getBoundingClientRect().toJSON(),
          height: innerHeight,
        },
      }
    })
    assert.equal(floating.topbar.position, "absolute")
    assert.equal(floating.bottombar.position, "absolute")
    assert.ok(floating.topbar.rect.top >= 7)
    assert.ok(floating.bottombar.rect.bottom <= 844 - 7)
    assert.ok(Math.abs(floating.stage.rect.height - 844) <= 1)

    const beforePinchPage = await currentPage(mobile)
    const beforePinchScale = Number(
      await mobile.locator(".iread-pdf").getAttribute("data-pdf-scale"),
    )
    const beforeToolbars = await mobile
      .locator(".iread-reader-shell")
      .getAttribute("data-toolbars")
    const pdfPinchBox = await mobile.locator("[data-reader-pdf]").boundingBox()
    assert.ok(pdfPinchBox !== null)
    await cdpPinch(mobile, {
      center: {
        x: pdfPinchBox.x + pdfPinchBox.width * 0.82,
        y: pdfPinchBox.y + 150,
      },
      startGap: 70,
      endGap: 190,
    })
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "manual",
      undefined,
      { timeout: 10_000 },
    )
    await mobile.waitForFunction(
      (before) =>
        Number(
          document.querySelector(".iread-pdf")?.getAttribute("data-pdf-scale"),
        ) > before * 1.05,
      beforePinchScale,
      { timeout: 10_000 },
    )
    const afterPinchScale = Number(
      await mobile.locator(".iread-pdf").getAttribute("data-pdf-scale"),
    )
    assert.equal(
      await currentPage(mobile),
      beforePinchPage,
      "双指缩放不得改变页码",
    )
    assert.equal(
      await mobile.locator(".iread-reader-shell").getAttribute("data-toolbars"),
      beforeToolbars,
      "双指缩放不得切换工具栏",
    )
    const pinchState = await mobile.evaluate(() => ({
      visualScale: window.visualViewport?.scale ?? 1,
      hasSelection: (() => {
        const selection = document.getSelection()
        return selection !== null && !selection.isCollapsed
      })(),
      pinching: document
        .querySelector(".iread-pdf")
        ?.hasAttribute("data-pdf-pinching"),
    }))
    assert.equal(pinchState.visualScale, 1, "内容区捏合不得放大浏览器视口")
    assert.equal(pinchState.hasSelection, false, "捏合结束必须清除文字选区")
    assert.equal(pinchState.pinching, false, "捏合结束必须清理预览状态")
    await mobile.waitForTimeout(800)
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-pdf-pinched.png"),
    })

    await openPdfMoreMenu(mobile)
    assert.ok(
      (await mobile.locator("[data-reader-more-zoom-value]").textContent())?.includes("%"),
      "捏合后更多菜单必须显示当前缩放值",
    )
    assert.equal(
      await mobile.locator("[data-reader-more-zoom-reset]").count(),
      1,
      "更多菜单必须提供复位 100%",
    )
    await mobile.locator("[data-reader-more-zoom-reset]").click()
    await mobile.waitForFunction(
      () =>
        Number(
          document.querySelector(".iread-pdf")?.getAttribute("data-pdf-scale"),
        ) <= 1.01,
      undefined,
      { timeout: 10_000 },
    )
    await mobile.keyboard.press("Escape")
    await mobile.locator("[data-reader-more-menu]").waitFor({ state: "hidden" })
    // 复位后再次捏合，确保退出重开恢复的是 pinch 结果而不是菜单步进值。
    await cdpPinch(mobile, {
      center: {
        x: pdfPinchBox.x + pdfPinchBox.width * 0.82,
        y: pdfPinchBox.y + 150,
      },
      startGap: 70,
      endGap: 170,
    })
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "manual",
      undefined,
      { timeout: 10_000 },
    )
    await mobile.waitForFunction(
      () =>
        Number(
          document.querySelector(".iread-pdf")?.getAttribute("data-pdf-scale"),
        ) > 1,
      undefined,
      { timeout: 10_000 },
    )
    const persistedScale = Number(
      await mobile.locator(".iread-pdf").getAttribute("data-pdf-scale"),
    )
    const persistedPage = await currentPage(mobile)

    // 先确认捏合后的页码已写入服务器，退出保存基于最新 revision，
    // 避免与本页此前节流中的进度写产生 409。
    await waitForPdfProgress(adminApi, uploaded.bookId, persistedPage)

    await mobile.getByRole("button", { name: /返回上一页|返回书库/ }).click()
    await mobile.waitForFunction(
      (id) =>
        location.pathname === "/library" ||
        location.pathname === `/books/${id}`,
      uploaded.bookId,
      { timeout: 15_000 },
    )
    await mobile.goto(`/read/${encodeURIComponent(uploaded.bookId)}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForPdfReady(mobile)
    await mobile.waitForFunction(
      () =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") ===
        "manual",
      undefined,
      { timeout: 20_000 },
    )
    await waitForPage(mobile, persistedPage)
    const restoredScale = Number(
      await mobile.locator(".iread-pdf").getAttribute("data-pdf-scale"),
    )
    assert.ok(
      Math.abs(restoredScale - persistedScale) / persistedScale < 0.05,
      `重开必须恢复捏合后的 manualScale（${persistedScale} -> ${restoredScale}）`,
    )

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
