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
        `files/${suffix}.${format}`,
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
    assert.equal(await firstCard.locator("a").count(), 1, "卡片只保留一个详情入口")
    assert.equal(await firstCard.locator("button").count(), 0, "卡片内无嵌套按钮")
    const coverImage = firstCard.locator(".iread-book-cover__image")
    if ((await coverImage.count()) > 0) {
      assert.equal(
        await coverImage.first().getAttribute("loading"),
        "lazy",
        "网格封面必须懒加载",
      )
    } else {
      assert.ok(
        (await firstCard.locator(".iread-book-cover__fallback svg").count()) > 0,
        "无封面时应显示 BookOpen 回退",
      )
    }

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

    logStep("列表视图使用官方 Item")
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
    await page.screenshot({
      path: "/tmp/opencode/iread-library-desktop-list.png",
      fullPage: true,
    })
    await page.getByRole("button", { name: "网格视图" }).click()
    await waitUntil(
      async () => (await page.locator(".iread-book-card").count()) === 24,
      "切回网格视图",
    )

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
    assert.ok(
      (await mobilePage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      )) === true,
      "移动端不得横向溢出",
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
    await waitUntil(
      async () =>
        (await subtitlePage.locator(".iread-book-card__subtitle").count()) > 0,
      "开启副标题后显示列表副标题",
    )
    assert.equal(
      await subtitlePage
        .locator(".iread-book-card__subtitle")
        .first()
        .innerText(),
      "副标题注入",
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
    await targetCard.click()
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
