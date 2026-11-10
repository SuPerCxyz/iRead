#!/usr/bin/env node

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { chromium, request as playwrightRequest } from "playwright"

import {
  AuthedApi,
  E2E_PASSWORD,
  E2EBlocked,
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:18081").replace(
  /\/$/,
  "",
)
const SCREENSHOT_DIR =
  process.env.PDF_E2E_SCREENSHOT_DIR ??
  path.join(tmpdir(), "iread-pdf-screenshots")
const PAGE_COUNT = 12
const PDF_PADDING_LINES = 420

function logStep(name) {
  console.log(`\n[PDF-E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapePdfText(value) {
  return value.replace(/[\\()]/g, "\\$&")
}

/**
 * 生成真实多页 PDF：包含可搜索文字、两章内置目录、页内链接，
 * 并在对象前加入约 420KB 注释填充，确保远跳必须走真实 Range。
 */
function buildPdf() {
  const ids = {
    catalog: 1,
    pages: 2,
    font: 3,
    outlineRoot: 100,
    outlineOne: 101,
    outlineTwo: 102,
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
    const text = escapePdfText(
      `iRead PDF page ${page} searchable keyword`,
    )
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

  const maxId = ids.outlineTwo
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets.get(id)
    body += offset === undefined
      ? "0000000000 65535 f \n"
      : `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer\n<< /Size ${maxId + 1} /Root ${ids.catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body)
}

async function uploadPdf(api, pdf) {
  const fileName = `reader-pdf-e2e-${Date.now()}.pdf`
  const created = await api.post("/api/v1/uploads", {
    clientUploadId: randomUUID(),
    fileName,
    byteSize: pdf.byteLength,
  })
  if (created.status === 404) {
    throw new E2EBlocked(
      "上传路由未注册：POST /api/v1/uploads 返回 404，无法准备真实 PDF。",
    )
  }
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(
      `创建上传意图失败：HTTP ${created.status} ${JSON.stringify(created.payload)}`,
    )
  }
  const uploadId = created.payload?.data?.uploadId
  if (typeof uploadId !== "string") {
    throw new E2EBlocked("上传响应缺少 uploadId，无法继续 PDF E2E。")
  }

  if (api.csrfToken === null) {
    await api.refreshCsrf()
  }
  const response = await api.request.fetch(
    `${BASE_URL}/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
        Origin: BASE_URL,
        "X-CSRF-Token": api.csrfToken,
      },
      data: pdf,
      failOnStatusCode: false,
    },
  )
  if (!response.ok()) {
    throw new Error(
      `上传 PDF 失败：HTTP ${response.status()} ${await response.text()}`,
    )
  }

  let upload = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await api.get(`/api/v1/uploads/${encodeURIComponent(uploadId)}`)
    if (result.status === 404) {
      throw new E2EBlocked("上传查询返回 404，后端上传流程未就绪。")
    }
    const data = result.payload?.data
    if (
      data !== undefined &&
      (data.state === "stored" || data.state === "duplicate") &&
      typeof data.bookId === "string"
    ) {
      upload = data
      break
    }
    if (data?.state === "failed" || data?.state === "cancelled") {
      throw new Error(`上传终态为 ${data.state}：${JSON.stringify(data.error)}`)
    }
    await sleep(250)
  }
  if (upload === null) {
    throw new E2EBlocked("上传在 30 秒内未进入 stored/duplicate，无法继续。")
  }

  let detail = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const book = await api.get(`/api/v1/books/${encodeURIComponent(upload.bookId)}`)
    if (book.status === 200 && book.payload?.data?.status === "ready") {
      detail = book.payload.data
      break
    }
    await sleep(250)
  }
  if (detail === null) {
    throw new E2EBlocked("PDF 索引未在 30 秒内 ready，无法继续。")
  }

  let manifest = null
  let manifestBlocked = ""
  const manifestResult = await api.get(
    `/api/v1/books/${encodeURIComponent(upload.bookId)}/manifest`,
  )
  if (manifestResult.status === 200 && manifestResult.payload?.data !== undefined) {
    manifest = manifestResult.payload.data
  } else {
    const errorCode = manifestResult.payload?.error?.code ?? ""
    manifestBlocked =
      manifestResult.status === 404
        ? "阅读清单接口未注册（GET /books/{id}/manifest 返回 404）"
        : `PDF manifest 尚未实现（HTTP ${manifestResult.status} ${errorCode}）`
    console.warn(`[PDF-E2E] BLOCKED: ${manifestBlocked}；用书详情中的真实 fileVersion/byteSize 构造测试清单 DTO 验证引擎，不冒充路由已完成。`)
    const fileVersion = detail.fileVersion
    if (typeof fileVersion !== "string" || fileVersion.length !== 64) {
      throw new E2EBlocked("书详情缺少合法 fileVersion，无法构造 PDF 测试清单。")
    }
    manifest = {
      schemaVersion: 1,
      bookId: upload.bookId,
      fileVersion,
      format: "pdf",
      indexVersion: detail.indexVersion ?? 1,
      readingCapabilities: {
        canRead: true,
        unavailableReason: "",
        features: ["toc", "bookmarks", "settings", "text-selection"],
      },
      toc: [
        {
          title: "Chapter One",
          href: "#page=1",
          resourceId: "",
          fragment: "page=1",
          level: 0,
          children: [],
        },
        {
          title: "Chapter Two",
          href: "#page=3",
          resourceId: "",
          fragment: "page=3",
          level: 0,
          children: [],
        },
      ],
      formatData: {
        contentHref: `/api/v1/books/${upload.bookId}/versions/${fileVersion}/content`,
        byteSize: detail.byteSize,
        etag: `"${fileVersion}"`,
        pageCount: PAGE_COUNT,
      },
    }
  }
  return {
    bookId: upload.bookId,
    manifest,
    manifestBlocked,
    contentType: response.headers()["content-type"],
  }
}

async function installHarness(page, manifest) {
  await page.evaluate(async (payload) => {
    const module = await import("/src/features/reader/pdf/index.ts")
    const host = document.createElement("div")
    host.id = "pdf-e2e-host"
    host.style.position = "fixed"
    host.style.inset = "0"
    host.style.zIndex = "99999"
    host.style.background = "white"
    document.body.append(host)
    const engine = module.createPdfReaderEngine({
      onBack: () => {
        window.__pdfBack = true
      },
    })
    window.__pdfEngine = engine
    window.__pdfLocations = []
    engine.subscribeLocation((location) => {
      window.__pdfLocations.push(location)
    })
    window.__pdfController = new AbortController()
    await engine.mount(host, payload.manifest, window.__pdfController.signal)
  }, { manifest })
}

async function waitForPage(page, pageNumber) {
  await page.waitForFunction(
    (target) => {
      const root = document.querySelector(".iread-pdf")
      const indicator = root?.querySelector("[data-pdf-page]")
      return (
        root?.getAttribute("data-pdf-ready") === "true" &&
        Number(root.getAttribute("data-pdf-page")) === target &&
        indicator?.getAttribute("data-pdf-page") === String(target)
      )
    },
    pageNumber,
    { timeout: 15000 },
  )
}

async function waitForReadyPage(page, pageNumber = 1) {
  await page.locator(`.iread-pdf__page[data-pdf-page="${pageNumber}"][data-state="ready"]`).waitFor({
    timeout: 20000,
  })
  await page
    .locator(`.iread-pdf__page[data-pdf-page="${pageNumber}"] .textLayer span`)
    .first()
    .waitFor({ timeout: 10000 })
}

async function currentPage(page) {
  return page.evaluate(() =>
    Number(document.querySelector(".iread-pdf")?.getAttribute("data-pdf-page")),
  )
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const pdf = buildPdf()
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox"],
  })
  const contexts = []
  const apiContexts = []
  let blockedReason = ""

  try {
    let storageState
    try {
      const probe = await playwrightRequest.newContext({ baseURL: BASE_URL })
      apiContexts.push(probe)
      const probeApi = new AuthedApi(probe, BASE_URL)
      const status = await probeApi.fetchStatus()
      if (!status.initialized) {
        await ensureAdmin(probeApi, BASE_URL, E2E_PASSWORD)
      }
      storageState = await createAuthenticatedStorageState(
        browser,
        BASE_URL,
        E2E_PASSWORD,
      )
      const authenticated = await playwrightRequest.newContext({
        baseURL: BASE_URL,
        storageState,
      })
      apiContexts.push(authenticated)
      const api = new AuthedApi(authenticated, BASE_URL)
      await ensureAdmin(api, BASE_URL, E2E_PASSWORD)
      const uploaded = await uploadPdf(api, pdf)
      logStep(
        `真实上传完成：bookId=${uploaded.bookId}，PDF=${pdf.byteLength} 字节，页数=${uploaded.manifest?.formatData?.pageCount}`,
      )
      if (uploaded.manifestBlocked.length > 0) {
        blockedReason = uploaded.manifestBlocked
      }

      const context = await browser.newContext({
        baseURL: BASE_URL,
        viewport: { width: 1280, height: 900 },
        locale: "zh-CN",
        serviceWorkers: "block",
        storageState,
        permissions: ["clipboard-read", "clipboard-write"],
      })
      contexts.push(context)

      const contentRequests = []
      const contentResponses = []
      const contentHandler = (request) => {
        if (!request.url().includes("/content")) return
        contentRequests.push({
          url: request.url(),
          method: request.method(),
          range: request.headers()["range"] ?? "",
        })
      }
      const responseHandler = async (response) => {
        if (!response.url().includes("/content")) return
        contentResponses.push({
          status: response.status(),
          contentRange: response.headers()["content-range"] ?? "",
          contentLength: Number(response.headers()["content-length"] ?? "0"),
        })
      }

      logStep("探测共享阅读路由是否已接入 PDF 引擎")
      const routePage = await context.newPage()
      await routePage.goto(`${BASE_URL}/read/${encodeURIComponent(uploaded.bookId)}`, {
        waitUntil: "domcontentloaded",
      })
      const shellIntegrated = await routePage
        .locator(".iread-pdf")
        .waitFor({ timeout: 8000 })
        .then(() => true)
        .catch(() => false)
      if (shellIntegrated) {
        await routePage.close()
      } else {
        const shellReason =
          "ReaderShell 尚未接入 createPdfReaderEngine（engine.ts 仍返回 UnavailableReaderEngine），无法通过 /read/:id 真实打开 PDF。"
        blockedReason =
          blockedReason.length > 0
            ? `${blockedReason}；${shellReason}`
            : shellReason
        console.warn(`[PDF-E2E] BLOCKED: ${blockedReason}`)
        console.warn(
          "[PDF-E2E] 继续用同一真实上传/清单/内容 URL 在浏览器内挂载 PDF 引擎，验证引擎自身行为；不伪造 shell 集成。",
        )
        await routePage.close()
      }

      const page = await context.newPage()
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          console.warn(`[browser:${message.type()}] ${message.text()}`)
        }
      })
      page.on("pageerror", (error) => {
        console.error("[browser:pageerror]", error)
      })
      page.on("request", (request) => {
        contentHandler(request)
        if (request.url().includes("/content")) {
          console.log(
            `[net:request] ${request.method()} ${request.url()} Range=${request.headers()["range"] ?? "(none)"}`,
          )
        }
      })
      page.on("response", (response) => {
        void responseHandler(response)
        if (response.url().includes("/content")) {
          console.log(
            `[net:response] ${response.status()} Range=${response.headers()["content-range"] ?? ""} Length=${response.headers()["content-length"] ?? ""} AcceptRanges=${response.headers()["accept-ranges"] ?? ""} Encoding=${response.headers()["content-encoding"] ?? ""}`,
          )
        }
      })
      page.on("requestfailed", (request) => {
        if (request.url().includes("/content")) {
          console.log(
            `[net:failed] ${request.url()} ${request.failure()?.errorText ?? ""}`,
          )
        }
      })
      await page.goto(`${BASE_URL}/library`, { waitUntil: "domcontentloaded" })
      await page.getByRole("heading", { level: 1, name: "书库" }).waitFor({
        timeout: 15000,
      })
      await page.waitForTimeout(500)
      await installHarness(page, uploaded.manifest)
      try {
        await page.locator('.iread-pdf[data-pdf-ready="true"]').waitFor({
          timeout: 20000,
        })
      } catch (error) {
        const diagnostic = await page.evaluate(() => {
          const root = document.querySelector(".iread-pdf")
          return {
            root: root?.outerHTML.slice(0, 2000) ?? null,
            ready: root?.getAttribute("data-pdf-ready") ?? null,
            state: root?.getAttribute("data-pdf-state") ?? null,
            error: root?.getAttribute("data-error-code") ?? null,
            loading: root?.querySelector(".iread-pdf__loading-text")?.textContent,
            errorText: root?.querySelector(".iread-pdf__error-message")?.textContent,
          }
        })
        console.error("[PDF-E2E] 引擎诊断：", JSON.stringify(diagnostic, null, 2))
        throw error
      }
      await waitForReadyPage(page, 1)
      assert.equal(
        Number(await page.locator(".iread-pdf").getAttribute("data-pdf-page-count")),
        PAGE_COUNT,
        "页数必须来自 PDF.js 实际解析，而不是伪造",
      )
      assert.equal(await currentPage(page), 1)
      assert.equal(
        await page.locator('.iread-pdf__page[data-pdf-page="1"] canvas').count(),
        1,
        "首屏必须存在 Canvas",
      )
      const textCount = await page
        .locator('.iread-pdf__page[data-pdf-page="1"] .textLayer span')
        .count()
      assert.ok(textCount > 0, "文字层必须可选中")
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "pdf-page-1.png"),
        fullPage: false,
      })

      logStep("翻页、缩放、布局与 locator")
      await page.getByRole("button", { name: "下一页" }).click()
      await waitForPage(page, 2)
      await page.getByRole("button", { name: "放大" }).click()
      await page.waitForFunction(() =>
        document.querySelector(".iread-pdf")?.getAttribute("data-zoom") === "manual",
      )
      await page.getByRole("button", { name: "适应宽度" }).click()
      await page.getByLabel("页面布局").selectOption("continuous")
      await waitForPage(page, 2)
      await page.waitForFunction(
        () =>
          document.querySelector(".iread-pdf")?.getAttribute("data-layout") ===
          "continuous",
      )
      await page.getByLabel("页面布局").selectOption("horizontal")
      await page.waitForFunction(
        () =>
          document.querySelector(".iread-pdf")?.getAttribute("data-layout") ===
          "horizontal",
      )
      await waitForPage(page, 2)
      assert.equal(await currentPage(page), 2, "切换布局必须保持当前页")

      logStep("远跳：真实 Range 与旧页隔离")
      await page.evaluate(async () => {
        const engine = window.__pdfEngine
        const result = await engine.navigateTo({
          locatorType: "pdf-page",
          locatorPayload: {
            locatorVersion: 1,
            page: 9,
            pageOffset: 0.3,
            relativeViewport: null,
            view: {
              layoutMode: "continuous",
              zoomMode: "fit-width",
              manualScale: 1,
            },
          },
          progressPercent: 72.7,
        })
        if (!result.ok) {
          throw new Error(`navigateTo 失败：${result.reason}`)
        }
      })
      await waitForPage(page, 9)
      await waitForReadyPage(page, 9)
      await page.waitForTimeout(500)
      assert.equal(await currentPage(page), 9)
      const stats = await page.evaluate(() => window.__pdfEngine.getNetworkStats())
      assert.ok(stats.requestCount >= 3, "必须存在多次 Range 请求")
      assert.ok(
        stats.downloadedBytes < pdf.byteLength * 0.9,
        `按需读取下载量应小于整本（${stats.downloadedBytes} / ${pdf.byteLength}）`,
      )
      assert.equal(stats.fullBodyResponse, false, "不得出现 200 整本响应")
      assert.ok(
        contentResponses.some((item) => item.status === 206),
        "浏览器网络必须观察到 206",
      )
      assert.equal(
        contentResponses.some((item) => item.status === 200),
        false,
        "原件读取不得退化为 200 整本响应",
      )

      const lastLocation = await page.evaluate(
        () => window.__pdfLocations.at(-1) ?? null,
      )
      assert.ok(lastLocation !== null, "订阅必须收到 locator")
      assert.equal(lastLocation.locatorType, "pdf-page")
      assert.equal(lastLocation.locatorPayload.page, 9)
      assert.ok(
        Math.abs(lastLocation.locatorPayload.pageOffset - 0.3) < 0.05,
        `远跳 offset 应保留，实际 ${lastLocation.locatorPayload.pageOffset}`,
      )
      assert.ok(lastLocation.locatorPayload.relativeViewport !== null)
      assert.deepEqual(lastLocation.locatorPayload.view, {
        layoutMode: "continuous",
        zoomMode: "fit-width",
        manualScale: 1,
      })

      logStep("连续跳页复用同一 PDF 会话，不重开全书")
      const sessionReuse = await page.evaluate(async () => {
        const engine = window.__pdfEngine
        const target = (page) => ({
          locatorType: "pdf-page",
          locatorPayload: {
            locatorVersion: 1,
            page,
            pageOffset: 0,
            relativeViewport: null,
            view: {
              layoutMode: "continuous",
              zoomMode: "fit-width",
              manualScale: 1,
            },
          },
          progressPercent: 0,
        })
        for (const page of [10, 11, 10, 9, 11]) {
          const result = await engine.navigateTo(target(page))
          if (!result.ok) throw new Error(result.reason)
        }
        return engine.getLocation()
      })
      assert.equal(sessionReuse.locatorPayload.page, 11)
      await waitForPage(page, 11)
      assert.equal(
        contentRequests.filter((item) => item.range === "bytes=0-65535").length,
        1,
        "会话复用不得重新发送首个范围请求",
      )


      logStep("文字选择与复制")
      await waitForReadyPage(page, 11)
      const selected = await page.evaluate(() => {
        const span = document.querySelector(
          '.iread-pdf__page[data-pdf-page="11"] .textLayer span',
        )
        if (!span) return ""
        const range = document.createRange()
        range.selectNodeContents(span)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return selection?.toString() ?? ""
      })
      assert.match(selected, /page 11/i, "文字层必须可选择")
      await page.keyboard.press("Control+c")
      const clipboard = await page.evaluate(() => navigator.clipboard.readText())
      assert.match(clipboard, /page 11/i, "选中文字必须可复制")

      logStep("快速远跳：迟到请求不得把新页改回旧页")
      const raceLocation = await page.evaluate(async () => {
        const engine = window.__pdfEngine
        const target = (page) => ({
          locatorType: "pdf-page",
          locatorPayload: {
            locatorVersion: 1,
            page,
            pageOffset: 0,
            relativeViewport: null,
            view: {
              layoutMode: "continuous",
              zoomMode: "fit-width",
              manualScale: 1,
            },
          },
          progressPercent: 0,
        })
        const first = engine.navigateTo(target(9))
        const second = engine.navigateTo(target(4))
        const results = await Promise.all([first, second])
        const immediate = engine.getLocation()
        await new Promise((resolve) => window.setTimeout(resolve, 800))
        return {
          location: engine.getLocation(),
          immediate,
          results,
          recent: (window.__pdfLocations ?? []).slice(-8),
        }
      })
      assert.equal(
        raceLocation.location.locatorPayload.page,
        4,
        "后发导航必须保持在新页，不能被迟到页改回",
      )
      await waitForPage(page, 4)

      logStep("搜索逐页 textContent、结果跳转与高亮")
      await page.getByRole("button", { name: "搜索 PDF" }).click()
      await page.getByLabel("在 PDF 中搜索").fill("searchable")
      await page.getByLabel("在 PDF 中搜索").press("Enter")
      await page
        .getByText(/找到 \d+ 处|没有找到/, { timeout: 30000 })
        .waitFor()
      const resultCount = await page
        .locator(".iread-pdf__search-result-button")
        .count()
      assert.equal(resultCount, PAGE_COUNT, "每页都应命中一次")
      await page
        .getByRole("button", { name: /跳转到搜索结果：第 5 页/ })
        .click()
      await waitForPage(page, 5)
      await waitForReadyPage(page, 5)
      assert.ok(
        (await page.locator(".iread-pdf__text-hit").count()) > 0,
        "搜索命中应在文字层高亮",
      )
      await page.getByRole("button", { name: "关闭搜索" }).click()

      logStep("内置目录与页内链接")
      await page.getByRole("button", { name: "PDF 内置目录" }).click()
      await page.getByText("Chapter One", { exact: true }).waitFor()
      await page.getByRole("button", { name: "跳转到目录：Chapter One" }).click()
      await waitForPage(page, 1)
      await page.getByRole("button", { name: "关闭 PDF 目录" }).click()
      await waitForReadyPage(page, 1)
      const internalLink = page.locator(
        '.iread-pdf__page[data-pdf-page="1"] .annotationLayer [data-internal-link] a',
      )
      await internalLink.first().waitFor({ timeout: 10000 })
      await internalLink.first().click()
      await waitForPage(page, 3)

      logStep("旋转、视口变化保持 page/pageOffset")
      await page.evaluate(() => window.__pdfEngine.rotate(90))
      await waitForPage(page, 3)
      await page.setViewportSize({ width: 900, height: 700 })
      await page.waitForTimeout(800)
      assert.equal(await currentPage(page), 3, "旋转/视口变化不得误翻页")

      logStep("manifest 页内定位恢复")
      await page.evaluate(async () => {
        const engine = window.__pdfEngine
        const result = await engine.restore({
          locatorType: "pdf-page",
          locatorPayload: {
            locatorVersion: 1,
            page: 7,
            pageOffset: 0.55,
            relativeViewport: null,
            view: {
              layoutMode: "continuous",
              zoomMode: "fit-width",
              manualScale: 1.25,
            },
          },
          progressPercent: 54.5,
        })
        if (!result.ok) {
          throw new Error(`restore 失败：${result.reason}`)
        }
      })
      await waitForPage(page, 7)
      await page.waitForTimeout(500)
      assert.equal(await currentPage(page), 7)
      const restored = await page.evaluate(
        () => window.__pdfLocations.at(-1) ?? null,
      )
      assert.equal(restored.locatorPayload.page, 7)
      assert.ok(
        Math.abs(restored.locatorPayload.pageOffset - 0.55) < 0.12,
        `恢复 offset 应接近目标，实际 ${restored.locatorPayload.pageOffset}`,
      )

      logStep("损坏/版本冲突错误与重试入口")
      const errorPage = await context.newPage()
      await errorPage.route("**/content", async (route) => {
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
      await errorPage.goto(`${BASE_URL}/library`, {
        waitUntil: "domcontentloaded",
      })
      await errorPage.getByRole("heading", { level: 1, name: "书库" }).waitFor({
        timeout: 15000,
      })
      await errorPage.waitForTimeout(500)
      await installHarness(errorPage, uploaded.manifest)
      await errorPage
        .locator(".iread-pdf__error:not([hidden])")
        .waitFor({ timeout: 15000 })
      await errorPage
        .getByText("PDF 原件已在别处更新", { exact: false })
        .waitFor()
      assert.equal(
        await errorPage.getByRole("button", { name: "重试打开 PDF" }).count(),
        1,
      )
      await errorPage.screenshot({
        path: path.join(SCREENSHOT_DIR, "pdf-error-409.png"),
      })
      await errorPage.close()

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "pdf-final.png"),
      })

      if (blockedReason.length > 0) {
        console.error(`\n[PDF-E2E] BLOCKED: ${blockedReason}`)
        console.error(
          "[PDF-E2E] 引擎级真实 PDF 验证已执行；共享 /read 路由集成仍未验证。",
        )
        process.exitCode = 2
      } else {
        console.log("\n[PDF-E2E] 通过：真实上传、Range、渲染、搜索、目录、选择/locator 与旋转均验证。")
      }
    } catch (error) {
      if (error instanceof E2EBlocked) {
        console.error(`\n[PDF-E2E] BLOCKED: ${error.message}`)
        process.exitCode = 2
        return
      }
      throw error
    }
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => undefined)
    }
    for (const context of apiContexts) {
      if (typeof context.dispose === "function") {
        await context.dispose().catch(() => undefined)
      } else if (typeof context.close === "function") {
        await context.close().catch(() => undefined)
      }
    }
    await browser.close().catch(() => undefined)
  }
}

try {
  await main()
} catch (error) {
  console.error("[PDF-E2E] 失败：", error)
  process.exitCode = 1
}
