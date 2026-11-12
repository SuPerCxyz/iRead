#!/usr/bin/env node

// 默认 Web 18080 / API 18081；端口被其他并行任务占用时可用
// LIBRARY_E2E_WEB_PORT / LIBRARY_E2E_API_PORT 覆盖，测试数据始终写入临时目录。

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
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

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url))
const ROOT_DIR = path.resolve(WEB_DIR, "..")
const SERVER_DIR = path.join(ROOT_DIR, "server")
const WEB_PORT = Number(process.env.LIBRARY_E2E_WEB_PORT ?? 18080)
const API_PORT = Number(process.env.LIBRARY_E2E_API_PORT ?? 18081)
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`
const API_URL = `http://127.0.0.1:${API_PORT}`
const TEMP_ROOT = mkdtempSync(
  path.join(tmpdir(), "iread-library-e2e-"),
)
const BOOKS_DIR = path.join(TEMP_ROOT, "books")
const DB_DIR = path.join(TEMP_ROOT, "db")
const CACHE_DIR = path.join(TEMP_ROOT, "cache")
const DB_PATH = path.join(DB_DIR, "iread.db")
const SEED_COUNT = 1000
const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
)

let serverProcess = null
let webProcess = null
let serverOutput = ""
let webOutput = ""

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function url(pathname) {
  return `${BASE_URL}${pathname}`
}

async function waitUntil(check, label, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) {
        return result
      }
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw new Error(
    `等待超时：${label}${lastError ? `（最后错误：${lastError.message}）` : ""}`,
  )
}

async function waitForUrl(check, label, timeout = 20000) {
  return waitUntil(async () => {
    try {
      const response = await fetch(check)
      return response.ok
    } catch {
      return false
    }
  }, label, timeout, 200)
}

function startServer() {
  serverProcess = spawn("go", ["run", "./cmd/iread"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      GOFLAGS: "-buildvcs=false",
      IREAD_ADDR: `127.0.0.1:${API_PORT}`,
      IREAD_PUBLIC_ORIGIN: BASE_URL,
      IREAD_BOOKS_DIR: BOOKS_DIR,
      IREAD_DB_DIR: DB_DIR,
      IREAD_CACHE_DIR: CACHE_DIR,
      IREAD_WEB_DIR: path.join(WEB_DIR, "dist"),
      IREAD_LOG_LEVEL: "error",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  serverProcess.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString()
  })
  serverProcess.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString()
  })
}

function startWeb() {
  webProcess = spawn(
    "pnpm",
    [
      "dev",
      "--port",
      String(WEB_PORT),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        IREAD_DEV_API: API_URL,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  webProcess.stdout.on("data", (chunk) => {
    webOutput += chunk.toString()
  })
  webProcess.stderr.on("data", (chunk) => {
    webOutput += chunk.toString()
  })
}

function killProcessGroup(child) {
  if (child === null || child.pid === undefined) {
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // 进程可能已退出。
    }
  }
}

function stopProcesses() {
  killProcessGroup(webProcess)
  killProcessGroup(serverProcess)
  webProcess = null
  serverProcess = null
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function seedDatabase() {
  const base = Date.parse("2026-11-10T00:00:00Z")
  const formats = ["epub", "pdf", "cbz", "cbr"]
  const mediaTypes = {
    epub: "application/epub+zip",
    pdf: "application/pdf",
    cbz: "application/vnd.comicbook+zip",
    cbr: "application/vnd.comicbook-rar",
  }
  const rows = []
  rows.push("PRAGMA foreign_keys=ON;")
  rows.push("BEGIN;")
  for (let index = 0; index < SEED_COUNT; index += 1) {
    const suffix = index.toString(16).padStart(32, "0")
    const title =
      index % 10 === 0 ? `Alpha ${index}` : `Book ${String(index).padStart(4, "0")}`
    const author = index % 2 === 0 ? "Author A" : "Author B"
    const format = formats[index % formats.length]
    const timestamp = new Date(base - index * 60_000).toISOString()
    const sha = index.toString(16).padStart(64, "0")
    const fileName = `${title.replaceAll(" ", "_")}.${format}`
    const cover = index === 0 ? "'cover:1'" : "NULL"
    const storageRelPath =
      index === 0 ? `${suffix}/${fileName}` : `files/${suffix}.${format}`
    const pageCount = format === "pdf" || format === "cbz" || format === "cbr"
      ? 100
      : 12
    rows.push(
      `INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at) VALUES (${sqlString(
        suffix,
      )}, ${sqlString(title)}, ${sqlString(format)}, 'ready', 1, ${sqlString(
        timestamp,
      )}, ${sqlString(timestamp)});`,
    )
    rows.push(
      `INSERT INTO book_files (book_id, original_file_name, extension, media_type, sha256, byte_size, storage_rel_path, created_at) VALUES (${sqlString(
        suffix,
      )}, ${sqlString(fileName)}, ${sqlString(format)}, ${sqlString(
        mediaTypes[format],
      )}, ${sqlString(sha)}, ${1024 + index}, ${sqlString(
        storageRelPath,
      )}, ${sqlString(timestamp)});`,
    )
    rows.push(
      `INSERT INTO book_metadata (book_id, title, subtitle, language, publisher, published_at, identifier, authors_json, page_count, toc_json, cover_resource_id, index_version, extraction_status, extracted_at, updated_at) VALUES (${sqlString(
        suffix,
      )}, ${sqlString(title)}, ${sqlString(
        `Subtitle ${index}`,
      )}, 'zh-CN', NULL, NULL, ${sqlString(`seed-${index}`)}, ${sqlString(
        JSON.stringify([author]),
      )}, ${pageCount}, '[]', ${cover}, 1, 'ok', ${sqlString(
        timestamp,
      )}, ${sqlString(timestamp)});`,
    )
    const finished = index % 11 === 0
    const reading = !finished && index % 7 === 0
    if (finished || reading) {
      rows.push(
        `INSERT INTO reading_progress (book_id, file_version, format, locator_type, locator_payload, progress_percent, client_mutation_id, revision, updated_at) VALUES (${sqlString(
          suffix,
        )}, ${sqlString(sha)}, ${sqlString(format)}, 'epub-cfi', '{"cfi":"/6/2"}', ${
          finished ? 100 : 42
        }, ${sqlString(`seed-progress-${index}`)}, 1, ${sqlString(
          timestamp,
        )});`,
      )
    }
  }
  rows.push("COMMIT;")
  const result = spawnSync("sqlite3", [DB_PATH], {
    input: rows.join("\n"),
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`SQLite 种子写入失败：${result.stderr || result.stdout}`)
  }

  const coverId = "0".repeat(32)
  const coverDir = path.join(CACHE_DIR, "covers", coverId, "1")
  mkdirSync(coverDir, { recursive: true })
  for (const variant of ["grid", "detail"]) {
    writeFileSync(path.join(coverDir, `${variant}.jpg`), COVER_PNG)
  }

  // 第一本种子图书保留真实原件，供真实下载与改名端点使用。
  const firstBookFile = path.join(
    BOOKS_DIR,
    coverId,
    "Alpha_0.epub",
  )
  mkdirSync(path.dirname(firstBookFile), { recursive: true })
  writeFileSync(firstBookFile, Buffer.alloc(1024, 0x61))
}

async function main() {
  if (!existsSync(path.join(WEB_DIR, "dist", "index.html"))) {
    throw new E2EBlocked("缺少 web/dist/index.html，请先运行 pnpm build。")
  }
  for (const [label, target] of [
    ["Web", BASE_URL],
    ["API", API_URL],
  ]) {
    try {
      await fetch(target, { signal: AbortSignal.timeout(800) })
      throw new E2EBlocked(`${label} 端口已被占用：${target}`)
    } catch (error) {
      if (error instanceof E2EBlocked) {
        throw error
      }
    }
  }
  mkdirSync(BOOKS_DIR, { recursive: true })
  mkdirSync(DB_DIR, { recursive: true })
  mkdirSync(CACHE_DIR, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox"],
  })
  const contexts = []
  const apiContexts = []
  let adminApi = null
  let storageState = null

  try {
    logStep(`启动临时服务（Web ${WEB_PORT} / API ${API_PORT}）`)
    startServer()
    startWeb()
    await waitForUrl(`${API_URL}/healthz`, "API healthz", 40000)
    await waitForUrl(BASE_URL, "Vite 页面", 30000)
    console.log(`[E2E] 临时数据目录：${TEMP_ROOT}`)

    logStep("初始化管理员与匿名门禁")
    const setupContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
    apiContexts.push(setupContext)
    adminApi = new AuthedApi(setupContext, BASE_URL)
    await ensureAdmin(adminApi, BASE_URL, E2E_PASSWORD)
    storageState = await createAuthenticatedStorageState(
      browser,
      BASE_URL,
      E2E_PASSWORD,
    )

    const anonymous = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
    })
    contexts.push(anonymous)
    const anonymousPage = await anonymous.newPage()
    await anonymousPage.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await anonymousPage
      .getByRole("heading", { level: 1 })
      .first()
      .waitFor({ timeout: 15000 })
    assert.equal(
      await anonymousPage.getByText("书库还没有图书", { exact: true }).count(),
      0,
      "未认证页面不得显示空库",
    )
    await anonymous.close()
    contexts.splice(contexts.indexOf(anonymous), 1)

    const desktop = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(desktop)
    const page = await desktop.newPage()
    page.on("pageerror", (error) => {
      console.error("[E2E][pageerror]", error)
    })
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error("[E2E][console]", message.text())
      }
    })

    logStep("真实空库空态")
    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await page
      .getByText("书库还没有图书", { exact: true })
      .waitFor({ timeout: 15000 })
    assert.equal(
      await page.getByText("没有匹配的图书", { exact: true }).count(),
      0,
      "无筛选时不得显示筛选空态",
    )

    logStep(`写入 ${SEED_COUNT} 本临时种子图书`)
    seedDatabase()
    const seeded = await waitUntil(async () => {
      const result = await adminApi.get("/api/v1/books?limit=1")
      return result.status === 200 && result.payload?.meta?.total === SEED_COUNT
        ? result.payload
        : null
    }, "书库总数达到 1000")
    assert.equal(seeded.meta.total, SEED_COUNT)

    await page.reload({ waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () =>
        (await page.locator(".iread-library__summary").innerText()).includes(
          "共 1000 本图书",
        ),
      "书库总数显示 1000",
    )

    logStep("顶栏、筛选行与右侧操作组对齐")
    const layout = await page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector)
        if (node === null) {
          return null
        }
        const rect = node.getBoundingClientRect()
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          height: rect.height,
          width: rect.width,
        }
      }
      const center = (rect) => (rect.top + rect.bottom) / 2
      const items = [
        box(".iread-library__search"),
        box("#library-format"),
        box("#library-reading-state"),
        box("#library-sort"),
        box(".iread-library__view-toggle"),
        box(".iread-library__settings-button"),
        box(".iread-library__summary"),
      ].filter((rect) => rect !== null)
      return {
        topbar: box(".iread-topbar"),
        upload: box(".iread-topbar__upload"),
        pageContent: box(".iread-page__content"),
        toolbar: box(".iread-library__toolbar"),
        toolbarEnd: box(".iread-library__toolbar-end"),
        label: box(".iread-library__filters-desktop [data-slot=field-label]"),
        summary: box(".iread-library__summary"),
        centers: items.map((rect) => center(rect)),
      }
    })
    assert.ok(
      Math.abs(
        (layout.topbar.top + layout.topbar.bottom) / 2 -
          (layout.upload.top + layout.upload.bottom) / 2,
      ) <= 1,
      "顶栏上传按钮应与顶栏垂直居中",
    )
    assert.equal(
      Math.round(layout.upload.height),
      36,
      "桌面顶栏操作控件高度应为 36px",
    )
    assert.ok(
      layout.pageContent.top - layout.topbar.bottom >= 0 &&
        layout.pageContent.top - layout.topbar.bottom <= 9,
      "页面内容应紧贴顶栏，顶部留白不超过 9px",
    )
    assert.ok(
      layout.label.height <= 1 && layout.label.width <= 1,
      "桌面筛选标签应视觉隐藏",
    )
    assert.equal(
      await page
        .locator(".iread-library__filters-desktop")
        .getByRole("combobox", { name: "格式", exact: true })
        .count(),
      1,
      "视觉隐藏后筛选控件仍应保留可访问名称",
    )
    assert.equal(layout.centers.length, 7, "筛选行应包含全部控件")
    assert.ok(
      Math.max(...layout.centers) - Math.min(...layout.centers) <= 2,
      "搜索、筛选与右侧视图控件应在同一水平基线",
    )
    assert.ok(
      Math.abs(layout.summary.right - layout.toolbar.right) <= 1 &&
        Math.abs(layout.toolbarEnd.right - layout.toolbar.right) <= 1,
      "数量摘要应与视图控件同组并右对齐",
    )
    assert.equal(
      await page.locator(".iread-library__toolbar-end .iread-library__summary").count(),
      1,
      "数量摘要应位于右侧操作组内",
    )

    logStep("分页、content-visibility 与 1000 本不全量挂载")
    assert.equal(
      await page.locator(".iread-book-card").count(),
      24,
      "初始只应挂载一页 24 本",
    )
    assert.equal(
      await page.locator(".iread-book-card").first().evaluate(
        (node) => getComputedStyle(node).contentVisibility,
      ),
      "auto",
      "卡片应启用 content-visibility: auto",
    )
    await page.getByRole("button", { name: "加载更多" }).click()
    await waitUntil(
      async () => (await page.locator(".iread-book-card").count()) === 48,
      "加载第二页",
    )
    assert.ok(
      (await page.locator(".iread-library__loaded").innerText()).includes(
        "已显示 48 本 / 共 1000 本",
      ),
      "分页计数应真实",
    )
    const firstCard = page.locator(".iread-book-card").first()
    assert.equal(
      await firstCard.locator(".iread-book-card__link").count(),
      1,
      "卡片只保留一个信息入口",
    )
    assert.equal(
      await firstCard.locator(".iread-book-card__cover-link").count(),
      1,
      "卡片应提供独立封面入口",
    )
    assert.match(
      (await firstCard
        .locator(".iread-book-card__cover-link")
        .getAttribute("href")) ?? "",
      /^\/read\//,
      "可读图书封面应指向阅读器",
    )
    assert.match(
      (await firstCard
        .locator(".iread-book-card__link")
        .getAttribute("href")) ?? "",
      /^\/books\//,
      "卡片信息入口应指向详情",
    )
    assert.equal(
      await firstCard.locator(".iread-book-card__link a").count(),
      0,
      "信息 Link 内不得嵌套链接",
    )
    assert.equal(
      await firstCard.locator(".iread-book-card__link button").count(),
      0,
      "信息 Link 内不得嵌套按钮",
    )
    assert.equal(
      await firstCard.locator(".iread-book-card__cover-link a").count(),
      0,
      "封面 Link 内不得嵌套链接",
    )
    const cardActions = firstCard.locator(".iread-book-card__actions")
    assert.equal(await cardActions.count(), 1, "书库卡片应提供操作区")
    assert.equal(
      await cardActions.locator("a").count(),
      1,
      "操作区应提供下载链接",
    )
    assert.equal(
      await cardActions.locator("button").count(),
      1,
      "操作区应提供编辑按钮",
    )
    assert.equal(
      await cardActions.evaluate((node) => node.closest("a") === null),
      true,
      "操作区必须是详情 Link 的兄弟，不得嵌套在链接内",
    )
    const firstCover = firstCard.locator(".iread-book-cover")
    const firstCoverImage = firstCard.locator(".iread-book-cover__image")
    await waitUntil(
      async () => (await firstCoverImage.count()) === 1,
      "种子图书应显示真实封面",
    )
    assert.equal(
      await firstCoverImage.getAttribute("loading"),
      "lazy",
      "网格封面必须懒加载",
    )
    await waitUntil(
      async () =>
        firstCoverImage.evaluate(
          (node) => node.complete && node.naturalWidth > 0,
        ),
      "正常封面应加载为真实图片",
    )
    assert.equal(
      await firstCover.getAttribute("data-cover-state"),
      "image",
      "正常封面不应进入回退",
    )
    assert.equal(
      await firstCard.locator(".iread-book-cover__fallback").count(),
      0,
      "正常封面不应同时显示占位",
    )

    logStep("封面 404 回退：书库、详情、首页与移动端")
    const fallbackContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(fallbackContext)
    const fallbackPage = await fallbackContext.newPage()
    let coverRequests = 0
    await fallbackPage.route("**/api/v1/books/*/cover*", async (route) => {
      coverRequests += 1
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "not_found", message: "封面已随缓存清理删除" },
        }),
      })
    })
    await fallbackPage.goto(url("/library?q=Alpha"), {
      waitUntil: "domcontentloaded",
    })
    await fallbackPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    const fallbackCard = fallbackPage.locator(".iread-book-card").first()
    await waitUntil(
      async () =>
        (await fallbackCard.locator(".iread-book-cover__fallback").count()) === 1,
      "封面 404 后书库卡片显示占位",
    )
    assert.ok(coverRequests > 0, "应真实请求封面地址")
    assert.equal(
      await fallbackCard.locator(".iread-book-cover__image").count(),
      0,
      "封面 404 后不得保留破图 img",
    )
    assert.equal(
      await fallbackCard.locator(".iread-book-cover__fallback svg").count(),
      1,
      "封面回退应使用 BookOpen 图标",
    )
    assert.equal(
      await fallbackCard.locator(".iread-book-cover__title").innerText(),
      "Alpha 0",
      "书库封面回退应显示真实标题",
    )
    assert.equal(
      await fallbackCard
        .locator(".iread-book-cover")
        .getAttribute("data-cover-state"),
      "fallback",
      "书库封面应标记为回退状态",
    )

    await fallbackCard.locator(".iread-book-card__link").click()
    await fallbackPage
      .getByRole("heading", { level: 1, name: "Alpha 0" })
      .waitFor({ timeout: 15000 })
    const detailFallback = fallbackPage.locator(
      ".iread-book-cover--detail .iread-book-cover__fallback",
    )
    await detailFallback.waitFor({ timeout: 15000 })
    assert.equal(
      await fallbackPage
        .locator(".iread-book-cover--detail .iread-book-cover__image")
        .count(),
      0,
      "详情封面 404 后不得保留破图 img",
    )
    assert.equal(
      await detailFallback.locator(".iread-book-cover__title").innerText(),
      "Alpha 0",
      "详情封面回退应显示真实标题",
    )

    await fallbackPage.goto(url("/"), { waitUntil: "domcontentloaded" })
    const continueCover = fallbackPage.locator(
      ".iread-home__continue-cover .iread-book-cover",
    )
    await waitUntil(
      async () => (await continueCover.locator(".iread-book-cover__fallback").count()) === 1,
      "首页继续阅读封面 404 后显示占位",
    )
    assert.equal(
      await continueCover.locator(".iread-book-cover__image").count(),
      0,
      "首页继续阅读封面不得保留破图 img",
    )
    assert.equal(
      await continueCover.locator(".iread-book-cover__title").innerText(),
      "Alpha 0",
      "首页继续阅读封面回退应显示真实标题",
    )
    const homeCard = fallbackPage.locator(".iread-book-grid .iread-book-card").first()
    await waitUntil(
      async () =>
        (await homeCard.locator(".iread-book-cover__fallback").count()) === 1,
      "首页最近添加封面 404 后显示占位",
    )
    assert.equal(
      await homeCard.locator(".iread-book-cover__image").count(),
      0,
      "首页最近添加封面不得保留破图 img",
    )
    assert.equal(
      await homeCard.locator(".iread-book-card__actions").count(),
      0,
      "首页复用卡片时不得出现书库下载/编辑操作",
    )
    const homeContinue = fallbackPage.locator(".iread-home__continue")
    assert.match(
      (await homeContinue
        .locator(".iread-home__continue-cover-link")
        .getAttribute("href")) ?? "",
      /^\/read\//,
      "首页继续阅读封面应进入阅读器",
    )
    assert.match(
      (await homeContinue
        .locator(".iread-home__continue-info-link")
        .getAttribute("href")) ?? "",
      /^\/books\//,
      "首页继续阅读标题应进入详情",
    )
    assert.match(
      (await homeContinue
        .locator(".iread-home__continue-content")
        .getByRole("link", { name: /^继续阅读/ })
        .getAttribute("href")) ?? "",
      /^\/read\//,
      "首页继续阅读按钮应进入阅读器",
    )
    assert.equal(
      await homeCard.locator(".iread-book-card__cover-link").count(),
      1,
      "首页最近添加卡片应有封面入口",
    )
    assert.match(
      (await homeCard
        .locator(".iread-book-card__cover-link")
        .getAttribute("href")) ?? "",
      /^\/read\//,
      "首页最近添加可读封面应进入阅读器",
    )
    assert.match(
      (await homeCard
        .locator(".iread-book-card__link")
        .getAttribute("href")) ?? "",
      /^\/books\//,
      "首页最近添加信息入口应进入详情",
    )
    await fallbackContext.close()
    contexts.splice(contexts.indexOf(fallbackContext), 1)

    logStep("卡片点击矩阵：封面→阅读器，标题/信息→详情，不可读封面→详情")
    const linkMatrixContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(linkMatrixContext)
    const linkMatrixPage = await linkMatrixContext.newPage()
    await linkMatrixPage.goto(url("/library?q=Alpha"), {
      waitUntil: "domcontentloaded",
    })
    await linkMatrixPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    const matrixCard = linkMatrixPage.locator(".iread-book-card").first()
    const matrixBookId = await matrixCard.getAttribute("data-book-card")
    assert.ok(matrixBookId, "点击矩阵卡片应带书籍编号")
    assert.equal(
      await matrixCard
        .locator(".iread-book-card__cover-link")
        .getAttribute("aria-label"),
      "继续阅读《Alpha 0》",
      "封面链接应有明确可访问名称",
    )
    assert.equal(
      await matrixCard
        .locator(".iread-book-card__link")
        .getAttribute("aria-label"),
      "查看《Alpha 0》详情",
      "信息链接应有明确可访问名称",
    )
    await matrixCard.locator(".iread-book-card__cover-link").click()
    await linkMatrixPage.waitForURL(`**/read/${matrixBookId}`, {
      timeout: 10000,
    })
    assert.equal(
      new URL(linkMatrixPage.url()).pathname,
      `/read/${matrixBookId}`,
      "点击封面必须进入阅读器",
    )
    await linkMatrixPage.goto(url("/library?q=Alpha"), {
      waitUntil: "domcontentloaded",
    })
    await linkMatrixPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await linkMatrixPage
      .locator(`.iread-book-card[data-book-card="${matrixBookId}"]`)
      .locator(".iread-book-card__link")
      .click()
    await linkMatrixPage.waitForURL(`**/books/${matrixBookId}`, {
      timeout: 10000,
    })
    assert.equal(
      new URL(linkMatrixPage.url()).pathname,
      `/books/${matrixBookId}`,
      "点击标题/信息必须进入详情",
    )

    await linkMatrixPage.route("**/api/v1/books?*", async (route) => {
      const response = await route.fetch()
      const payload = await response.json()
      if (Array.isArray(payload.data) && payload.data.length > 0) {
        payload.data[0].status = "indexing"
        payload.data[0].readingCapabilities = {
          canRead: false,
          unavailableReason: "not_ready",
          features: [],
        }
      }
      await route.fulfill({ response, json: payload })
    })
    await linkMatrixPage.goto(url("/library?q=Alpha"), {
      waitUntil: "domcontentloaded",
    })
    await linkMatrixPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    const unreadableCard = linkMatrixPage.locator(".iread-book-card").first()
    assert.match(
      (await unreadableCard
        .locator(".iread-book-card__cover-link")
        .getAttribute("href")) ?? "",
      /^\/books\//,
      "不可读封面应回详情",
    )
    await unreadableCard.locator(".iread-book-card__cover-link").click()
    await linkMatrixPage.waitForURL(`**/books/${matrixBookId}`, {
      timeout: 10000,
    })
    await linkMatrixContext.close()
    contexts.splice(contexts.indexOf(linkMatrixContext), 1)

    const coverMobile = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      storageState,
      isMobile: true,
      hasTouch: true,
    })
    contexts.push(coverMobile)
    const coverMobilePage = await coverMobile.newPage()
    const longCoverTitle = `Alpha ${"UnbrokenCoverTitle".repeat(12)}`
    await coverMobilePage.route("**/api/v1/books?*", async (route) => {
      const response = await route.fetch()
      const payload = await response.json()
      if (Array.isArray(payload.data) && payload.data.length > 0) {
        payload.data[0].title = longCoverTitle
      }
      await route.fulfill({ response, json: payload })
    })
    await coverMobilePage.route("**/api/v1/books/*/cover*", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "not_found", message: "封面已随缓存清理删除" },
        }),
      })
    })
    await coverMobilePage.goto(url("/library?q=Alpha"), {
      waitUntil: "domcontentloaded",
    })
    const mobileFallbackCard = coverMobilePage.locator(".iread-book-card").first()
    await waitUntil(
      async () =>
        (await mobileFallbackCard.locator(".iread-book-cover__fallback").count()) === 1,
      "移动端封面 404 后显示占位",
    )
    assert.equal(
      await mobileFallbackCard.locator(".iread-book-cover__title").innerText(),
      longCoverTitle,
      "移动端回退应显示真实标题",
    )
    const mobileCoverMetrics = await mobileFallbackCard
      .locator(".iread-book-cover")
      .evaluate((cover) => {
        const title = cover.querySelector(".iread-book-cover__title")
        const coverRect = cover.getBoundingClientRect()
        const titleRect = title.getBoundingClientRect()
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          coverRight: coverRect.right,
          coverBottom: coverRect.bottom,
          titleRight: titleRect.right,
          titleBottom: titleRect.bottom,
          titleClientWidth: title.clientWidth,
          titleScrollWidth: title.scrollWidth,
        }
      })
    assert.ok(
      mobileCoverMetrics.documentWidth <= mobileCoverMetrics.viewportWidth + 1,
      "移动端封面回退不得造成横向溢出",
    )
    assert.ok(
      mobileCoverMetrics.titleRight <= mobileCoverMetrics.coverRight + 1,
      "移动端封面标题不得超出封面宽度",
    )
    assert.ok(
      mobileCoverMetrics.titleBottom <= mobileCoverMetrics.coverBottom + 1,
      "移动端封面标题不得溢出封面高度",
    )
    assert.ok(
      mobileCoverMetrics.titleScrollWidth <=
        mobileCoverMetrics.titleClientWidth + 1,
      "移动端封面标题应折行而不是横向撑开",
    )
    await coverMobile.close()
    contexts.splice(contexts.indexOf(coverMobile), 1)

    logStep("搜索、格式、阅读状态、排序与 URL 同步")
    const search = page.getByRole("searchbox", { name: "搜索图书" })
    await search.fill("Alpha")
    await waitUntil(
      async () =>
        (await page.locator(".iread-library__summary").innerText()).includes(
          "匹配 100 本图书",
        ),
      "搜索 Alpha 返回 100 本",
    )
    assert.ok(page.url().includes("q=Alpha"), "搜索词应写入 URL")
    await waitUntil(
      async () =>
        (await page.locator(".iread-book-card").count()) > 0 &&
        (await page.locator(".iread-book-card__title").allInnerTexts()).every(
          (title) => title.startsWith("Alpha"),
        ),
      "搜索结果只包含匹配图书",
    )
    assert.ok(
      (await page.locator(".iread-library__active-filter").allInnerTexts()).some(
        (text) => text.includes("搜索：Alpha"),
      ),
      "应显示搜索筛选摘要",
    )
    await page.getByRole("button", { name: "清除搜索" }).click()
    await waitUntil(
      async () =>
        (await page.locator(".iread-library__summary").innerText()).includes(
          "共 1000 本图书",
        ),
      "清除搜索",
    )

    const selectOption = async (targetPage, scope, label, option) => {
      await scope
        .getByRole("combobox", { name: label, exact: true })
        .click()
      await targetPage
        .getByRole("option", { name: option, exact: true })
        .click()
    }

    await selectOption(page, page, "格式", "PDF")
    await waitUntil(
      async () =>
        (await page.locator(".iread-library__summary").innerText()).includes(
          "匹配 250 本图书",
        ),
      "格式 PDF 返回 250 本",
    )
    assert.ok(page.url().includes("format=pdf"), "格式应写入 URL")
    await selectOption(page, page, "阅读状态", "已读完")
    await waitUntil(async () => {
      const text = await page.locator(".iread-library__summary").innerText()
      const match = /匹配 (\d+) 本图书/.exec(text)
      if (match === null) {
        return false
      }
      const expected = await adminApi.get(
        "/api/v1/books?limit=1&format=pdf&readingState=finished",
      )
      return Number(match[1]) === expected.payload?.meta?.total
    }, "格式+状态组合 total 与 API 一致")
    assert.ok(page.url().includes("readingState=finished"), "状态应写入 URL")
    assert.ok(
      (await page.locator(".iread-library__active-filter").allInnerTexts()).some(
        (text) => text.includes("格式：PDF"),
      ) &&
        (await page.locator(".iread-library__active-filter").allInnerTexts()).some(
          (text) => text.includes("状态：已读完"),
        ),
      "筛选摘要应包含格式与状态",
    )

    await page.getByRole("button", { name: "清除筛选" }).first().click()
    await waitUntil(
      async () =>
        (await page.locator(".iread-library__summary").innerText()).includes(
          "共 1000 本图书",
        ),
      "清除全部筛选",
    )

    await selectOption(page, page, "排序", "标题")
    await waitUntil(
      async () =>
        (await page.locator(".iread-book-card__title").first().innerText()) ===
        "Alpha 0",
      "标题排序首项为 Alpha 0",
    )
    assert.ok(page.url().includes("sort=title"), "排序应写入 URL")
    await selectOption(page, page, "排序", "最近阅读")
    await waitUntil(
      async () =>
        (await page.locator(".iread-book-card__title").first().innerText()) ===
        "Alpha 0",
      "最近阅读排序首项为有进度且最新的 Alpha 0",
    )
    await selectOption(page, page, "排序", "最近更新")
    await waitUntil(
      async () => page.url().includes("sort=updated"),
      "最近更新排序写入 URL",
    )
    await selectOption(page, page, "排序", "最近添加")

    logStep("cursor 深链接与改筛选重置 cursor")
    const firstPage = await adminApi.get("/api/v1/books?limit=10")
    const cursor = firstPage.payload?.meta?.nextCursor
    assert.ok(cursor, "第一页应返回 nextCursor")
    const secondPage = await adminApi.get(
      `/api/v1/books?limit=10&cursor=${encodeURIComponent(cursor)}`,
    )
    assert.equal(secondPage.status, 200, "cursor 请求应成功")
    const expectedSecondTitle = secondPage.payload.data[0].title
    await page.goto(
      url(`/library?limit=10&cursor=${encodeURIComponent(cursor)}`),
      { waitUntil: "domcontentloaded" },
    )
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () =>
        (await page.locator(".iread-book-card").count()) === 10 &&
        (await page.locator(".iread-book-card__title").first().innerText()) ===
          expectedSecondTitle,
      "cursor 深链接从第二页开始",
    )
    await selectOption(page, page, "格式", "EPUB")
    await waitUntil(async () => page.url().includes("format=epub"), "格式筛选生效")
    assert.equal(
      new URL(page.url()).searchParams.get("cursor"),
      null,
      "改筛选必须重置 cursor",
    )

    logStep("视图设置持久化与网格布局")
    await page.goto(url("/settings?group=bookshelf"), {
      waitUntil: "domcontentloaded",
    })
    await page
      .getByRole("heading", { level: 1, name: "设置" })
      .waitFor({ timeout: 15000 })
    await page
      .getByRole("heading", { level: 2, name: "书库视图" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () =>
        (await page.locator(".iread-library-settings__status").innerText()).includes(
          "已保存",
        ),
      "书库视图设置加载完成",
    )

    const waitSaved = async () => {
      await waitUntil(
        async () => {
          const text = await page
            .locator(".iread-library-settings__status")
            .innerText()
          return text.includes("已保存")
        },
        "设置保存完成",
      )
    }
    const getSettings = async () => {
      const result = await adminApi.get("/api/v1/settings/library")
      assert.equal(result.status, 200, "GET library settings 应成功")
      return result.payload.data
    }
    const waitSettingsValue = async (predicate) =>
      waitUntil(async () => {
        const record = await getSettings()
        return predicate(record.value) ? record : null
      }, "服务器设置值更新")

    await selectOption(page, page, "视图模式", "网格")
    await waitSaved()
    await selectOption(page, page, "卡片密度", "宽松")
    await waitSaved()
    await selectOption(page, page, "网格列数", "4 列")
    await waitSaved()
    await selectOption(page, page, "封面比例", "3:4")
    await waitSaved()
    await selectOption(page, page, "封面圆角", "大")
    await waitSaved()
    await selectOption(page, page, "卡片间距", "宽松")
    await waitSaved()

    for (const [id, checked] of [
      ["settings-library-show-authors", false],
      ["settings-library-show-progress", false],
      ["settings-library-show-format", false],
      ["settings-library-show-subtitle", true],
    ]) {
      const toggle = page.locator(`#${id}`)
      if ((await toggle.isChecked()) !== checked) {
        await toggle.click()
        await waitSaved()
      }
    }

    const savedValue = await waitSettingsValue(
      (value) =>
        value.viewMode === "grid" &&
        value.density === "relaxed" &&
        value.columns === 4 &&
        value.coverRatio === "3:4" &&
        value.coverRadius === "lg" &&
        value.cardGap === "relaxed" &&
        value.showAuthors === false &&
        value.showProgress === false &&
        value.showFormat === false &&
        value.showSubtitle === true,
    )
    console.log(`[E2E] 服务器已保存视图设置 revision ${savedValue.revision}`)

    await page.reload({ waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 2, name: "书库视图" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () =>
        (await page.locator(".iread-library-settings__status").innerText()).includes(
          "已保存",
        ),
      "重开设置页加载完成",
    )
    assert.equal(
      await page.getByRole("combobox", { name: "网格列数" }).innerText(),
      "4 列",
      "列数应持久化",
    )
    assert.equal(
      await page.getByRole("combobox", { name: "视图模式" }).innerText(),
      "网格",
      "视图模式应持久化",
    )
    await page.screenshot({
      path: "/tmp/opencode/iread-library-settings.png",
      fullPage: true,
    })
    assert.equal(
      await page.locator("#settings-library-show-subtitle").isChecked(),
      true,
      "副标题开关应持久化",
    )

    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () => (await page.locator(".iread-book-card").count()) === 24,
      "视图设置生效后加载书库",
    )
    assert.equal(
      await page.locator(".iread-library").getAttribute("data-view-mode"),
      "grid",
    )
    assert.equal(
      await page.locator(".iread-library").getAttribute("data-columns"),
      "4",
    )
    assert.equal(
      await page.locator(".iread-book-card__authors").count(),
      0,
      "关闭作者后不显示作者",
    )
    assert.equal(
      await page.locator(".iread-book-card__progress").count(),
      0,
      "关闭进度后不显示进度",
    )
    assert.equal(
      await page.getByText("EPUB", { exact: true }).count(),
      0,
      "关闭格式后不显示格式 Badge",
    )
    const gridStyle = await page.locator(".iread-book-grid").evaluate((node) => {
      const style = getComputedStyle(node)
      return {
        columns: style.gridTemplateColumns.split(" ").length,
        rowGap: Number.parseFloat(style.rowGap),
      }
    })
    assert.equal(gridStyle.columns, 4, "桌面应显示 4 列")
    assert.ok(gridStyle.rowGap >= 20, "宽松卡片间距应生效")
    const coverMetrics = await page
      .locator(".iread-book-card .iread-book-cover")
      .first()
      .evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          ratio: rect.height / rect.width,
          radius: Number.parseFloat(style.borderRadius),
        }
      })
    assert.ok(
      Math.abs(coverMetrics.ratio - 4 / 3) < 0.08,
      `3:4 封面比例应生效，实际 ${coverMetrics.ratio}`,
    )
    assert.ok(coverMetrics.radius >= 10, "大圆角应生效")
    assert.ok(
      (await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      )) === true,
      "桌面不得横向溢出",
    )
    await page.screenshot({
      path: "/tmp/opencode/iread-library-desktop-grid.png",
      fullPage: true,
    })

    logStep("卡片下载、书名编辑与详情顶部操作")
    const firstBookId = await firstCard.getAttribute("data-book-card")
    assert.ok(firstBookId, "卡片应带书籍编号")
    const firstDetailResult = await adminApi.get(
      `/api/v1/books/${firstBookId}`,
    )
    assert.equal(firstDetailResult.status, 200, "详情 API 应成功")
    const firstDetail = firstDetailResult.payload.data
    let patchFailure = false

    await page.route(new RegExp(`/api/v1/books/${firstBookId}$`), async (route) => {
      const request = route.request()
      if (request.method() === "PATCH" && patchFailure) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "state_conflict",
              message: "书籍正在索引，请稍后重试",
            },
          }),
        })
        return
      }
      await route.continue()
    })

    await firstCard.hover()
    const downloadLink = firstCard.getByRole("link", {
      name: `下载《${firstDetail.title}》`,
    })
    await downloadLink.waitFor({ state: "visible", timeout: 5000 })
    assert.match(
      (await downloadLink.getAttribute("href")) ?? "",
      new RegExp(`/api/v1/books/${firstBookId}/download$`),
      "下载入口应指向服务端下载地址",
    )
    assert.notEqual(
      await downloadLink.getAttribute("download"),
      null,
      "下载入口应带 download 属性",
    )
    const downloadPromise = page.waitForEvent("download")
    await page.waitForTimeout(200)
    await page.screenshot({
      path: "/tmp/opencode/iread-book-card-actions.png",
    })
    await downloadLink.click()
    const download = await downloadPromise
    assert.equal(
      download.suggestedFilename(),
      `${firstDetail.title}.${firstDetail.extension}`,
      "下载文件名应为书名加原扩展名",
    )
    assert.ok(
      download.url().endsWith(`/api/v1/books/${firstBookId}/download`),
      "实际点击应请求同源下载端点",
    )

    const editButton = firstCard.getByRole("button", {
      name: `编辑《${firstDetail.title}》名称`,
    })
    await editButton.click()
    const editDialog = page.getByRole("dialog")
    await editDialog.waitFor({ state: "visible", timeout: 5000 })
    const titleInput = editDialog.getByLabel("书名", { exact: true })
    assert.equal(
      await titleInput.inputValue(),
      firstDetail.title,
      "编辑对话框应预填当前书名",
    )
    await editDialog.getByRole("button", { name: "取消" }).click()
    await editDialog.waitFor({ state: "hidden", timeout: 5000 })
    assert.equal(
      await firstCard.locator(".iread-book-card__title").innerText(),
      firstDetail.title,
      "取消编辑不得改变书名",
    )

    patchFailure = true
    await firstCard.hover()
    await editButton.click()
    await editDialog.waitFor({ state: "visible", timeout: 5000 })
    await titleInput.fill("失败书名")
    await editDialog.getByRole("button", { name: "保存" }).click()
    await editDialog
      .getByText("书籍正在索引，请稍后重试", { exact: true })
      .first()
      .waitFor({ timeout: 5000 })
    assert.equal(
      await editDialog.isVisible(),
      true,
      "保存失败时应保持编辑对话框",
    )
    assert.equal(
      await titleInput.inputValue(),
      "失败书名",
      "保存失败时不得丢失输入",
    )
    await editDialog.getByRole("button", { name: "取消" }).click()
    await editDialog.waitFor({ state: "hidden", timeout: 5000 })

    patchFailure = false
    const savedTitle = "重命名后的书名"
    await firstCard.hover()
    await editButton.click()
    await editDialog.waitFor({ state: "visible", timeout: 5000 })
    await titleInput.fill(savedTitle)
    await editDialog.getByRole("button", { name: "保存" }).click()
    await editDialog.waitFor({ state: "hidden", timeout: 5000 })
    await waitUntil(
      async () =>
        (await firstCard.locator(".iread-book-card__title").innerText()) ===
        savedTitle,
      "保存成功后卡片书名即时更新",
    )

    await page.reload({ waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () => (await page.locator(".iread-book-card").count()) === 24,
      "刷新后重新加载书库",
    )
    await waitUntil(
      async () =>
        (await page
          .locator(".iread-book-card__title")
          .first()
          .innerText()) === savedTitle,
      "刷新后书名保持新值",
    )
    await page
      .locator(".iread-book-card")
      .filter({ hasText: savedTitle })
      .first()
      .locator(".iread-book-card__link")
      .click()
    await page
      .getByRole("heading", { level: 1, name: savedTitle })
      .waitFor({ timeout: 15000 })

    const detailTopbar = page.locator(".iread-book__topbar")
    await detailTopbar.waitFor({ timeout: 10000 })
    assert.equal(
      await detailTopbar
        .getByRole("button", { name: "返回书库", exact: true })
        .count(),
      1,
      "详情页顶部应保留返回书库",
    )
    assert.equal(
      await page.getByRole("button", { name: "返回书库", exact: true }).count(),
      1,
      "详情页不得出现底部重复返回",
    )
    assert.equal(
      await page.locator(".iread-book__back").count(),
      0,
      "旧底部返回容器应移除",
    )
    assert.equal(
      await detailTopbar
        .getByRole("link", { name: `下载《${savedTitle}》` })
        .count(),
      1,
      "详情顶部应提供下载入口",
    )
    assert.equal(
      await detailTopbar
        .getByRole("button", { name: `编辑《${savedTitle}》名称` })
        .count(),
      1,
      "详情顶部应提供编辑入口",
    )
    const topReadLink = detailTopbar.getByRole("link", {
      name: "继续阅读",
      exact: true,
    })
    assert.equal(
      await topReadLink.count(),
      1,
      "详情顶部应提供唯一继续阅读主按钮",
    )
    assert.match(
      (await topReadLink.getAttribute("href")) ?? "",
      /^\/read\//,
      "顶部主按钮应指向阅读器",
    )
    assert.equal(
      await page
        .getByRole("link", { name: /^(开始阅读|继续阅读)$/ })
        .count(),
      1,
      "整页只允许一个开始/继续阅读入口",
    )
    assert.equal(
      await page.getByText("已整理完成", { exact: true }).count(),
      0,
      "可读图书不再显示已整理完成卡片",
    )
    const factLabels = await page
      .locator(".iread-book__facts-grid dt")
      .allInnerTexts()
    assert.deepEqual(
      factLabels,
      ["文件大小", "页数", "语言", "文件名", "标识"],
      "详情 facts 应按 canonical 顺序且不重复格式",
    )
    const wideLabels = await page
      .locator(".iread-book__fact--wide dt")
      .allInnerTexts()
    assert.deepEqual(
      wideLabels,
      ["文件名", "标识"],
      "文件名与标识应为 wide 字段",
    )
    const renamedDownloadPromise = page.waitForEvent("download")
    await detailTopbar
      .getByRole("link", { name: `下载《${savedTitle}》` })
      .click()
    const renamedDownload = await renamedDownloadPromise
    assert.equal(
      renamedDownload.suggestedFilename(),
      `${savedTitle}.${firstDetail.extension}`,
      "改名后下载文件名应使用新书名",
    )
    assert.equal(
      await page
        .locator(".iread-book__fact")
        .filter({ hasText: "文件名" })
        .locator("dd")
        .innerText(),
      `${savedTitle}.${firstDetail.extension}`,
      "详情文件名应同步为新书名加扩展名",
    )
    assert.equal(
      await page.getByText("原始文件名", { exact: true }).count(),
      0,
      "详情不再显示旧文案原始文件名",
    )

    const factsGrid = page.locator(".iread-book__facts-grid").first()
    const factColumns = async () =>
      factsGrid.evaluate(
        (node) =>
          getComputedStyle(node).gridTemplateColumns.split(" ").length,
      )
    assert.equal(await factColumns(), 2, "桌面元数据应两列并排")
    const factsGridBox = await factsGrid.boundingBox()
    const wideFactBox = await page
      .locator(".iread-book__fact--wide")
      .first()
      .boundingBox()
    assert.ok(
      factsGridBox !== null &&
        wideFactBox !== null &&
        Math.abs(wideFactBox.width - factsGridBox.width) <= 1,
      "长字段应占满两列",
    )
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      true,
      "详情桌面不得横向溢出",
    )
    await page.screenshot({
      path: "/tmp/opencode/iread-book-detail-1440.png",
      fullPage: true,
    })

    await page.setViewportSize({ width: 768, height: 1024 })
    await page.waitForTimeout(120)
    assert.equal(await factColumns(), 1, "768 宽度元数据应单列")
    await page.screenshot({
      path: "/tmp/opencode/iread-book-detail-768.png",
      fullPage: true,
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(120)
    assert.equal(await factColumns(), 1, "390 宽度元数据应单列")
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      true,
      "详情移动端不得横向溢出",
    )
    assert.equal(
      await page.locator(".iread-book__back-label").evaluate(
        (node) => getComputedStyle(node).display,
      ),
      "none",
      "移动端返回按钮应图标化",
    )
    assert.equal(
      await detailTopbar
        .getByRole("link", { name: `下载《${savedTitle}》` })
        .count(),
      1,
      "移动端下载入口保留可访问名称",
    )
    await page.screenshot({
      path: "/tmp/opencode/iread-book-detail-390.png",
      fullPage: true,
    })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(120)
    await detailTopbar
      .getByRole("button", { name: "返回书库", exact: true })
      .click()
    await page.waitForFunction(
      () => window.location.pathname === "/library",
      undefined,
      { timeout: 5000 },
    )
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })

    logStep("列表视图使用官方 Item")
    const listSettingsBefore = await getSettings()
    const listSettingsPut = await adminApi.put("/api/v1/settings/library", {
      schemaVersion: 1,
      baseRevision: listSettingsBefore.revision,
      value: {
        ...listSettingsBefore.value,
        viewMode: "list",
        showAuthors: true,
        showProgress: true,
        showFormat: true,
        showSubtitle: true,
      },
    })
    assert.equal(listSettingsPut.status, 200, "列表测试前应开启全部信息列")
    await page.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await page.getByRole("button", { name: "列表视图" }).click()
    await waitUntil(
      async () => (await page.locator("[data-slot='item']").count()) === 24,
      "切换列表视图",
    )
    assert.equal(
      await page.locator(".iread-book-card").count(),
      0,
      "列表视图不渲染网格卡片",
    )
    assert.ok(
      (await page.locator("[data-slot='item-title']").count()) === 24,
      "列表使用官方 ItemTitle",
    )
    assert.ok(
      (await page.locator("[data-slot='item-media']").count()) === 24,
      "列表使用官方 ItemMedia",
    )
    const firstListItem = page.locator("[data-slot='item']").first()
    assert.equal(
      await firstListItem.locator(".iread-book-list__link a").count(),
      0,
      "列表详情 Link 内不得嵌套链接",
    )
    assert.equal(
      await firstListItem.locator(".iread-book-list__link button").count(),
      0,
      "列表详情 Link 内不得嵌套按钮",
    )
    assert.equal(
      await firstListItem.locator(".iread-book-list__cover-link").count(),
      1,
      "列表封面应是独立链接",
    )
    assert.match(
      (await firstListItem
        .locator(".iread-book-list__cover-link")
        .getAttribute("href")) ?? "",
      /^\/read\//,
      "可读列表封面应进入阅读器",
    )
    assert.match(
      (await firstListItem
        .locator(".iread-book-list__link")
        .getAttribute("href")) ?? "",
      /^\/books\//,
      "列表信息链接应进入详情",
    )
    assert.equal(
      await firstListItem.locator(".iread-book-list__actions a").count(),
      1,
      "列表应提供下载入口",
    )
    assert.equal(
      await firstListItem.locator(".iread-book-list__actions button").count(),
      1,
      "列表应提供编辑入口",
    )
    assert.equal(
      await firstListItem
        .locator(".iread-book-list__actions")
        .evaluate((node) => node.closest("a") === null),
      true,
      "列表操作区不得嵌套在链接内",
    )
    assert.equal(
      await firstListItem
        .locator(".iread-book-list__actions")
        .locator(".iread-book-actions__label")
        .count(),
      0,
      "列表操作按钮应图标化",
    )
    const listActions = firstListItem.locator(".iread-book-list__actions")
    assert.equal(
      await listActions.evaluate((node) => getComputedStyle(node).opacity),
      "0",
      "桌面列表操作区默认应收起",
    )
    await firstListItem.hover()
    await waitUntil(
      async () =>
        (await listActions.evaluate((node) => getComputedStyle(node).opacity)) ===
        "1",
      "列表操作区悬停显示",
      3000,
    )
    await page.screenshot({
      path: "/tmp/opencode/iread-library-desktop-list.png",
      fullPage: true,
    })

    logStep("列表单行：1920/1440/1024/768/390 行高、垂直中心与列对齐")
    for (const viewport of [
      { width: 1920, height: 1000 },
      { width: 1440, height: 900 },
      { width: 1024, height: 900 },
      { width: 768, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(150)
      const metrics = await page.evaluate(() => {
        const rect = (node) => node.getBoundingClientRect()
        const center = (node) => {
          const box = rect(node)
          return (box.top + box.bottom) / 2
        }
        const items = Array.from(
          document.querySelectorAll(".iread-book-list__item"),
        ).slice(0, 6)
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          rows: items.map((item) => {
            const cover = item.querySelector(".iread-book-list__cover-cell")
            const link = item.querySelector(".iread-book-list__link")
            const actions = item.querySelector(".iread-book-list__actions")
            const format = item.querySelector(".iread-book-list__format")
            const status = item.querySelector(".iread-book-list__status")
            const progress = item.querySelector(".iread-book-list__progress")
            const progressBar = item.querySelector(
              '.iread-book-list__progress [data-slot="progress"]',
            )
            const formatVisible =
              format !== null && getComputedStyle(format).display !== "none"
            const statusVisible =
              status !== null && getComputedStyle(status).display !== "none"
            return {
              height: rect(item).height,
              centers: [cover, link, actions].map(center),
              formatLeft: formatVisible ? rect(format).left : null,
              statusLeft: statusVisible ? rect(status).left : null,
              progressLeft:
                progress !== null && getComputedStyle(progress).display !== "none"
                  ? rect(progress).left
                  : null,
              actionOpacity:
                actions === null
                  ? null
                  : Number.parseFloat(getComputedStyle(actions).opacity),
              progressBarVisible:
                progressBar !== null &&
                getComputedStyle(progressBar).display !== "none",
            }
          }),
        }
      })
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth + 1,
        `${viewport.width} 列表不得横向溢出`,
      )
      for (const row of metrics.rows) {
        const maxHeight = viewport.width === 390 ? 80 : 96
        assert.ok(
          row.height <= maxHeight,
          `${viewport.width} 列表行高应 <= ${maxHeight}px，实际 ${row.height}`,
        )
        assert.ok(
          Math.max(...row.centers) - Math.min(...row.centers) <= 1,
          `${viewport.width} 同一行元素应垂直居中`,
        )
      }
      if (viewport.width >= 768) {
        for (const key of ["formatLeft", "statusLeft", "progressLeft"]) {
          const values = metrics.rows
            .map((row) => row[key])
            .filter((value) => value !== null)
          assert.ok(values.length >= 2, `${viewport.width} 应显示 ${key} 列`)
          assert.ok(
            Math.max(...values) - Math.min(...values) <= 1,
            `${viewport.width} ${key} 应跨行对齐`,
          )
        }
      } else {
        assert.equal(
          metrics.rows[0].formatLeft,
          null,
          "390 应隐藏格式列",
        )
        assert.equal(
          metrics.rows[0].statusLeft,
          null,
          "390 状态改用封面圆点",
        )
        assert.equal(
          metrics.rows[0].progressBarVisible,
          false,
          "390 进度只显示百分比",
        )
        assert.equal(
          metrics.rows[0].actionOpacity,
          1,
          "390 操作按钮应常显",
        )
      }
      await page.screenshot({
        path: `/tmp/opencode/iread-library-list-${viewport.width}.png`,
      })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(120)
    await page.getByRole("button", { name: "网格视图" }).click()
    await waitUntil(
      async () => (await page.locator(".iread-book-card").count()) === 24,
      "切回网格视图",
    )
    const listRestore = await getSettings()
    const listRestorePut = await adminApi.put("/api/v1/settings/library", {
      schemaVersion: 1,
      baseRevision: listRestore.revision,
      value: listSettingsBefore.value,
    })
    assert.equal(listRestorePut.status, 200, "列表测试后应恢复视图设置")

    logStep("卡片等高与封面 contain：1920/1440/1024/768/390")
    const equalBefore = await getSettings()
    const equalSettings = {
      ...equalBefore.value,
      viewMode: "grid",
      columns: 4,
      density: "standard",
      cardGap: "standard",
      coverRatio: "original",
      coverRadius: "md",
      showAuthors: true,
      showProgress: true,
      showSubtitle: true,
      showFormat: true,
    }
    const equalPut = await adminApi.put("/api/v1/settings/library", {
      schemaVersion: 1,
      baseRevision: equalBefore.revision,
      value: equalSettings,
    })
    assert.equal(equalPut.status, 200, "等高测试前应保存视图设置")

    const equalContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(equalContext)
    const equalPage = await equalContext.newPage()
    const longTitle = "超长书名".repeat(18)
    let equalCoverHref = null
    await equalPage.route("**/api/v1/books?*", async (route) => {
      const response = await route.fetch()
      const payload = await response.json()
      const books = payload.data ?? []
      const coverSource = books.find((book) => book.cover !== null)
      if (equalCoverHref === null && coverSource !== undefined) {
        equalCoverHref = coverSource.cover.href
      }
      const cover = (width, height) =>
        equalCoverHref === null
          ? null
          : {
              href: equalCoverHref,
              mediaType: "image/png",
              width,
              height,
            }
      if (books.length >= 6) {
        books[0].title = "短标题"
        books[0].authors = ["作者甲"]
        books[0].subtitle = null
        books[0].progress = null
        books[0].cover = null
        books[1].title = longTitle
        books[1].authors = []
        books[1].subtitle = "副标题"
        books[1].progress = null
        books[1].cover = cover(1200, 600)
        books[2].title = "两行书名".repeat(6)
        books[2].authors = []
        books[2].subtitle = null
        books[2].progress = null
        books[2].cover = cover(600, 1200)
        books[3].title = "短"
        books[3].authors = []
        books[3].subtitle = null
        books[3].progress = null
        books[3].cover = null
        books[4].title = "中等长度书名用于折行"
        books[4].authors = ["作者乙"]
        books[4].progress = null
        books[4].cover = cover(400, 400)
        books[5].title = "另一本书"
        books[5].authors = []
        books[5].progress = null
        books[5].cover = cover(800, 1200)
      }
      await route.fulfill({ response, json: payload })
    })
    await equalPage.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await equalPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () => (await equalPage.locator(".iread-book-card").count()) === 24,
      "等高测试加载书库",
    )
    await waitUntil(
      async () =>
        (await equalPage
          .locator(".iread-library")
          .getAttribute("data-columns")) === "4" &&
        (await equalPage
          .locator(".iread-library")
          .getAttribute("data-cover-ratio")) === "original",
      "等高测试视图设置生效",
    )

    const widthChecks = [
      { width: 1920, height: 1000 },
      { width: 1440, height: 1000 },
      { width: 1024, height: 900 },
      { width: 768, height: 900 },
      { width: 390, height: 844 },
    ]
    for (const viewport of widthChecks) {
      await equalPage.setViewportSize(viewport)
      await equalPage.reload({ waitUntil: "domcontentloaded" })
      await equalPage
        .getByRole("heading", { level: 1, name: "书库" })
        .waitFor({ timeout: 15000 })
      await waitUntil(
        async () =>
          (await equalPage.locator(".iread-book-card").count()) === 24,
        `${viewport.width} 宽度加载书库`,
      )
      await equalPage.evaluate(() => window.scrollTo(0, 0))
      await equalPage.waitForTimeout(150)
      const metrics = await equalPage.evaluate(() => {
        const cards = Array.from(
          document.querySelectorAll(".iread-book-card"),
        )
        const firstTop = cards[0].getBoundingClientRect().top
        const row = cards.filter(
          (card) =>
            Math.abs(card.getBoundingClientRect().top - firstTop) <= 1,
        )
        return {
          columns: getComputedStyle(
            document.querySelector(".iread-book-grid"),
          ).gridTemplateColumns.split(" ").length,
          row: row.map((card) => {
            const cardRect = card.getBoundingClientRect()
            const coverRect = card
              .querySelector(".iread-book-cover")
              .getBoundingClientRect()
            const badgeRect = card
              .querySelector(".iread-book-card__badges")
              .getBoundingClientRect()
            const progressRect = card
              .querySelector(".iread-book-card__progress")
              .getBoundingClientRect()
            return {
              height: cardRect.height,
              coverWidth: coverRect.width,
              coverHeight: coverRect.height,
              coverRatio: coverRect.height / coverRect.width,
              badgeBottom: badgeRect.bottom,
              progressBottom: progressRect.bottom,
            }
          }),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }
      })
      assert.ok(metrics.row.length >= 2, `${viewport.width} 应有同排卡片`)
      console.log(
        `[E2E] ${viewport.width} 同排 ${metrics.row.length} 张，高度 ${metrics.row
          .map((card) => Math.round(card.height))
          .join("/")}，封面 ${Math.round(
          metrics.row[0].coverWidth,
        )}x${Math.round(metrics.row[0].coverHeight)}，比例 ${metrics.row[0].coverRatio.toFixed(
          3,
        )}`,
      )
      const heights = metrics.row.map((card) => card.height)
      assert.ok(
        Math.max(...heights) - Math.min(...heights) <= 1,
        `${viewport.width} 同排卡片应等高`,
      )
      const coverWidths = metrics.row.map((card) => card.coverWidth)
      const coverHeights = metrics.row.map((card) => card.coverHeight)
      assert.ok(
        Math.max(...coverWidths) - Math.min(...coverWidths) <= 1 &&
          Math.max(...coverHeights) - Math.min(...coverHeights) <= 1,
        `${viewport.width} 封面框尺寸应一致`,
      )
      for (const card of metrics.row) {
        assert.ok(
          Math.abs(card.coverRatio - 1.5) < 0.02,
          `${viewport.width} original 在网格中应回退为 2:3`,
        )
      }
      const badgeBottoms = metrics.row.map((card) => card.badgeBottom)
      const progressBottoms = metrics.row.map(
        (card) => card.progressBottom,
      )
      assert.ok(
        Math.max(...badgeBottoms) - Math.min(...badgeBottoms) <= 1,
        `${viewport.width} 徽标应底部对齐`,
      )
      assert.ok(
        Math.max(...progressBottoms) - Math.min(...progressBottoms) <= 1,
        `${viewport.width} 进度槽应底部对齐`,
      )
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth + 1,
        `${viewport.width} 书库不得横向溢出`,
      )
      await equalPage.screenshot({
        path: `/tmp/opencode/iread-library-equal-${viewport.width}.png`,
      })
    }
    await equalContext.close()
    contexts.splice(contexts.indexOf(equalContext), 1)
    const equalAfter = await getSettings()
    const equalRestore = await adminApi.put("/api/v1/settings/library", {
      schemaVersion: 1,
      baseRevision: equalAfter.revision,
      value: equalBefore.value,
    })
    assert.equal(equalRestore.status, 200, "等高测试后应恢复视图设置")

    logStep("保存失败恢复与 revision 409 冲突")
    await page.goto(url("/settings?group=bookshelf"), {
      waitUntil: "domcontentloaded",
    })
    await waitUntil(
      async () =>
        (await page.locator(".iread-library-settings__status").innerText()).includes(
          "已保存",
        ),
      "冲突测试前设置已加载",
    )
    let failPut = true
    await page.route("**/api/v1/settings/library", async (route) => {
      if (route.request().method() === "PUT" && failPut) {
        await route.abort("failed")
        return
      }
      await route.continue()
    })
    await selectOption(page, page, "封面圆角", "小")
    await page
      .getByText("未能保存书库视图设置", { exact: true })
      .first()
      .waitFor({ timeout: 10000 })
    failPut = false
    await page.unroute("**/api/v1/settings/library")
    await page.getByRole("button", { name: "重试保存" }).click()
    await waitSaved()

    let record = await getSettings()
    const externalValue = {
      ...record.value,
      density: record.value.density === "compact" ? "relaxed" : "compact",
    }
    const externalPut = await adminApi.put("/api/v1/settings/library", {
      schemaVersion: 1,
      baseRevision: record.revision,
      value: externalValue,
    })
    assert.equal(externalPut.status, 200, "外部 PUT 应成功")
    await selectOption(page, page, "卡片间距", "紧凑")
    await page
      .getByText("设置已在另一处更新", { exact: true })
      .first()
      .waitFor({ timeout: 10000 })
    await page.getByRole("button", { name: "使用服务器设置" }).click()
    await waitSaved()
    await waitUntil(
      async () =>
        (await page.getByRole("combobox", { name: "卡片密度" }).innerText()) ===
        (externalValue.density === "compact" ? "紧凑" : "宽松"),
      "载入服务器密度",
    )
    record = await getSettings()
    assert.equal(record.value.density, externalValue.density)

    const externalValue2 = {
      ...record.value,
      cardGap: record.value.cardGap === "relaxed" ? "compact" : "relaxed",
    }
    const externalPut2 = await adminApi.put("/api/v1/settings/library", {
      schemaVersion: 1,
      baseRevision: record.revision,
      value: externalValue2,
    })
    assert.equal(externalPut2.status, 200, "第二次外部 PUT 应成功")
    await selectOption(page, page, "封面比例", "2:3")
    await page
      .getByText("设置已在另一处更新", { exact: true })
      .first()
      .waitFor({ timeout: 10000 })
    await page.getByRole("button", { name: "保留本机并覆盖" }).click()
    const kept = await waitSettingsValue(
      (value) => value.coverRatio === "2:3",
    )
    assert.equal(kept.value.coverRatio, "2:3")

    logStep("移动端搜索、官方 Drawer、列数限制与清除筛选")
    record = await getSettings()
    const columnsEight = {
      ...record.value,
      viewMode: "grid",
      columns: 8,
    }
    const columnPut = await adminApi.put("/api/v1/settings/library", {
      schemaVersion: 1,
      baseRevision: record.revision,
      value: columnsEight,
    })
    assert.equal(columnPut.status, 200)

    const mobile = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      storageState,
      isMobile: true,
      hasTouch: true,
    })
    contexts.push(mobile)
    const mobilePage = await mobile.newPage()
    await mobilePage.route("**/api/v1/books?*", async (route) => {
      const response = await route.fetch()
      const payload = await response.json()
      if (Array.isArray(payload.data) && payload.data.length > 0) {
        payload.data[0].status = "error"
        payload.data[0].readingCapabilities = {
          canRead: false,
          unavailableReason: "index_failed",
          features: [],
        }
      }
      await route.fulfill({ response, json: payload })
    })
    await mobilePage.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await mobilePage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () =>
        (await mobilePage.locator(".iread-book-card").count()) === 24,
      "移动端加载书库",
    )
    assert.equal(
      await mobilePage.getByRole("searchbox", { name: "搜索图书" }).isVisible(),
      true,
      "移动端保留搜索框",
    )
    assert.equal(
      await mobilePage
        .locator(".iread-library__filters-desktop")
        .evaluate((node) => getComputedStyle(node).display),
      "none",
      "移动端隐藏桌面筛选控件",
    )
    const mobileColumns = await mobilePage
      .locator(".iread-book-grid")
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length)
    assert.equal(mobileColumns, 3, "移动端 8 列设置应限制为 3 列")
    assert.equal(
      await mobilePage
        .locator(".iread-book-card__actions")
        .first()
        .evaluate((node) => getComputedStyle(node).opacity),
      "1",
      "触屏设备应常显卡片操作入口",
    )
    assert.ok(
      (await mobilePage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      )) === true,
      "移动端不得横向溢出",
    )
    const mobileToolbar = await mobilePage.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect()
        return {
          top: rect.top,
          bottom: rect.bottom,
          right: rect.right,
        }
      }
      const toolbar = box(".iread-library__toolbar")
      const filter = box(".iread-library__filter-trigger")
      const summary = box(".iread-library__summary")
      return {
        toolbarRight: toolbar.right,
        filterCenter: (filter.top + filter.bottom) / 2,
        summaryCenter: (summary.top + summary.bottom) / 2,
        summaryRight: summary.right,
      }
    })
    assert.ok(
      Math.abs(mobileToolbar.filterCenter - mobileToolbar.summaryCenter) <= 1,
      "移动端筛选按钮与数量摘要应在同一水平基线",
    )
    assert.ok(
      Math.abs(mobileToolbar.summaryRight - mobileToolbar.toolbarRight) <= 1,
      "移动端数量摘要应右对齐",
    )
    await mobilePage.screenshot({
      path: "/tmp/opencode/iread-library-mobile-grid.png",
      fullPage: true,
    })

    await mobilePage
      .getByRole("button", { name: /筛选与视图/ })
      .click()
    const drawer = mobilePage.getByRole("dialog")
    await drawer.getByText("筛选与视图", { exact: true }).waitFor({
      timeout: 5000,
    })
    assert.equal(
      await drawer
        .locator(".iread-library-filters [data-slot=field-label]")
        .filter({ hasText: "格式" })
        .isVisible(),
      true,
      "移动端 Drawer 应保留筛选标签",
    )
    const mobileTopbar = await mobilePage.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect()
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        }
      }
      const topbar = box(".iread-topbar")
      const upload = box(".iread-topbar__upload")
      return {
        topbarCenter: (topbar.top + topbar.bottom) / 2,
        uploadCenter: (upload.top + upload.bottom) / 2,
        uploadHeight: upload.height,
      }
    })
    assert.equal(
      Math.round(mobileTopbar.uploadHeight),
      44,
      "移动端顶栏操作控件高度应为 44px",
    )
    assert.ok(
      Math.abs(mobileTopbar.topbarCenter - mobileTopbar.uploadCenter) <= 1,
      "移动端顶栏操作控件应垂直居中",
    )
    await mobilePage.screenshot({
      path: "/tmp/opencode/iread-library-mobile-drawer.png",
      fullPage: true,
    })
    await selectOption(mobilePage, drawer, "格式", "EPUB")
    await selectOption(mobilePage, drawer, "阅读状态", "未读")
    await selectOption(mobilePage, drawer, "排序", "标题")
    await drawer.getByRole("button", { name: "应用筛选" }).click()
    await drawer.waitFor({ state: "hidden", timeout: 5000 })
    await waitUntil(
      async () =>
        mobilePage.url().includes("format=epub") &&
        mobilePage.url().includes("readingState=unread") &&
        mobilePage.url().includes("sort=title"),
      "Drawer 应用筛选写入 URL",
    )
    const mobileChips = await mobilePage
      .locator(".iread-library__active-filter")
      .allInnerTexts()
    assert.ok(mobileChips.some((text) => text.includes("格式：EPUB")))
    assert.ok(mobileChips.some((text) => text.includes("状态：未读")))
    assert.ok(mobileChips.some((text) => text.includes("排序：标题")))
    await mobilePage
      .getByRole("button", { name: "清除筛选" })
      .first()
      .click()
    await waitUntil(
      async () => mobilePage.url().endsWith("/library"),
      "移动端清除筛选恢复 URL",
    )

    await mobilePage
      .getByRole("button", { name: /筛选与视图/ })
      .click()
    const drawer2 = mobilePage.getByRole("dialog")
    await selectOption(mobilePage, drawer2, "视图模式", "列表")
    await drawer2.getByRole("button", { name: "应用筛选" }).click()
    await waitUntil(
      async () =>
        (await mobilePage.locator("[data-slot='item']").count()) === 24,
      "移动端切到列表视图",
    )
    const mobileListItem = mobilePage.locator("[data-slot='item']").first()
    assert.equal(
      await mobileListItem.locator(".iread-book-list__status-dot").count(),
      1,
      "异常状态应在移动端封面显示圆点",
    )
    assert.notEqual(
      await mobileListItem
        .locator(".iread-book-list__status-dot")
        .evaluate((node) => getComputedStyle(node).display),
      "none",
      "移动端异常状态圆点应可见",
    )
    assert.equal(
      await mobileListItem.locator(".iread-book-list__status").count(),
      1,
      "移动端保留状态节点用于降级",
    )
    assert.equal(
      await mobileListItem
        .locator(".iread-book-list__status")
        .evaluate((node) => getComputedStyle(node).display),
      "none",
      "移动端隐藏状态文字 Badge",
    )
    const mobileFormat = mobileListItem.locator(".iread-book-list__format")
    if ((await mobileFormat.count()) > 0) {
      assert.equal(
        await mobileFormat.evaluate((node) => getComputedStyle(node).display),
        "none",
        "移动端隐藏格式列",
      )
    }
    await mobilePage
      .getByRole("button", { name: /筛选与视图/ })
      .click()
    const drawer3 = mobilePage.getByRole("dialog")
    await selectOption(mobilePage, drawer3, "视图模式", "网格")
    await drawer3.getByRole("button", { name: "应用筛选" }).click()
    await waitUntil(
      async () => (await mobilePage.locator(".iread-book-card").count()) === 24,
      "移动端切回网格视图",
    )

    logStep("服务错误 Alert 与真实重试")
    const errorContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(errorContext)
    const errorPage = await errorContext.newPage()
    let failBooks = true
    await errorPage.route("**/api/v1/books?*", async (route) => {
      if (failBooks) {
        await route.abort("failed")
        return
      }
      await route.continue()
    })
    await errorPage.goto(url("/library"), { waitUntil: "domcontentloaded" })
    await errorPage
      .getByText("无法加载书库", { exact: true })
      .waitFor({ timeout: 15000 })
    assert.equal(
      await errorPage.getByText("书库还没有图书", { exact: true }).count(),
      0,
      "服务错误不得伪装空库",
    )
    failBooks = false
    await errorPage.getByRole("button", { name: "重试" }).click()
    await waitUntil(
      async () => (await errorPage.locator(".iread-book-card").count()) > 0,
      "错误后重试加载书库",
    )
    await errorContext.close()
    contexts.splice(contexts.indexOf(errorContext), 1)

    logStep("total=null 不显示假总数、副标题显示")
    const totalNullContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(totalNullContext)
    const totalNullPage = await totalNullContext.newPage()
    await totalNullPage.route("**/api/v1/books?*", async (route) => {
      const response = await route.fetch()
      const payload = await response.json()
      payload.meta.total = null
      await route.fulfill({ response, json: payload })
    })
    await totalNullPage.goto(url("/library?q=Book"), {
      waitUntil: "domcontentloaded",
    })
    await totalNullPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () => (await totalNullPage.locator(".iread-book-card").count()) === 24,
      "total=null 仍展示结果",
    )
    assert.equal(
      await totalNullPage.locator(".iread-library__summary").count(),
      0,
      "total 未知时不得显示假总数",
    )
    await totalNullContext.close()
    contexts.splice(contexts.indexOf(totalNullContext), 1)

    const subtitleContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      storageState,
    })
    contexts.push(subtitleContext)
    const subtitlePage = await subtitleContext.newPage()
    await subtitlePage.route("**/api/v1/books?*", async (route) => {
      const response = await route.fetch()
      const payload = await response.json()
      for (const book of payload.data) {
        book.subtitle = "副标题注入"
      }
      await route.fulfill({ response, json: payload })
    })
    await subtitlePage.goto(url("/library?q=Alpha"), {
      waitUntil: "domcontentloaded",
    })
    // content-visibility 布局可能让 innerText 短暂为空，等待真实文本而不是只等节点出现。
    await waitUntil(
      async () =>
        (await subtitlePage
          .locator(".iread-book-card__subtitle")
          .first()
          .innerText()) === "副标题注入",
      "开启副标题后显示列表副标题",
    )
    await subtitleContext.close()
    contexts.splice(contexts.indexOf(subtitleContext), 1)

    logStep("返回恢复筛选与滚动位置")
    await page.goto(url("/library?q=Book"), { waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () => (await page.locator(".iread-book-card").count()) === 24,
      "返回测试前加载",
    )
    await page.getByRole("button", { name: "加载更多" }).click()
    await waitUntil(
      async () => (await page.locator(".iread-book-card").count()) === 48,
      "返回测试前加载第二页",
    )
    await page.evaluate(() => window.scrollTo(0, 700))
    await sleep(300)
    const beforeClickScroll = await page.evaluate(() => window.scrollY)
    assert.ok(beforeClickScroll > 400, "应实际滚动")
    const targetCard = page.locator(".iread-book-card").nth(8)
    const targetTitle = await targetCard
      .locator(".iread-book-card__title")
      .innerText()
    await targetCard.locator(".iread-book-card__link").click()
    await page
      .getByRole("heading", { level: 1, name: targetTitle })
      .waitFor({ timeout: 15000 })
    await page.goBack({ waitUntil: "domcontentloaded" })
    await page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await waitUntil(
      async () =>
        (await page.getByRole("searchbox", { name: "搜索图书" }).inputValue()) ===
        "Book",
      "返回后恢复搜索词",
    )
    assert.ok(page.url().includes("q=Book"), "返回后恢复搜索 URL")
    const restoredScroll = await waitUntil(
      async () => {
        const value = await page.evaluate(() => window.scrollY)
        return value > 200 ? value : null
      },
      "返回后恢复滚动位置",
    )
    assert.ok(restoredScroll > 200, "滚动位置应恢复")

    console.log("\n[E2E] 书库/视图设置浏览器验收全部通过")
    console.log(`[E2E] 种子图书：${SEED_COUNT}；截图目录：/tmp/opencode`)
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      await context.dispose().catch(() => {})
    }
    await browser.close().catch(() => {})
    stopProcesses()
    if (process.env.KEEP_LIBRARY_E2E_DATA === "1") {
      console.log(`[E2E] 保留临时数据：${TEMP_ROOT}`)
    } else {
      rmSync(TEMP_ROOT, { recursive: true, force: true })
    }
    if (serverOutput.trim().length > 0) {
      console.error("[E2E][server log]\n" + serverOutput.slice(-4000))
    }
    if (webOutput.trim().length > 0 && webOutput.includes("error")) {
      console.error("[E2E][web log]\n" + webOutput.slice(-2000))
    }
  }
}

main().catch((error) => {
  if (error instanceof E2EBlocked) {
    rmSync(TEMP_ROOT, { recursive: true, force: true })
    console.error(`\n[E2E] BLOCKED：${error.message}`)
    process.exitCode = 2
    return
  }
  console.error("\n[E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
