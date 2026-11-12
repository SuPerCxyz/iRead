#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:18080").replace(
  /\/$/,
  "",
)
const DB_PATH = process.env.IREAD_DB_PATH ?? ""
const SAMPLE_DIR = mkdtempSync(path.join(tmpdir(), "iread-reader-shell-"))
const SCREENSHOT_DIR =
  process.env.READER_SCREENSHOT_DIR ??
  path.join(tmpdir(), "iread-reader-shell-screenshots")

const CHAPTER_COUNT = 30
const CURRENT_CHAPTER = 28
const PROGRESS_PERCENT = 50
const OLD_FILE_VERSION = "b".repeat(64)

function url(pathname) {
  return `${BASE_URL}${pathname}`
}

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function zipFiles(target, cwd, files, options = []) {
  execFileSync("zip", ["-X", ...options, target, ...files], {
    cwd,
    stdio: "ignore",
  })
}

function padChapter(index) {
  return String(index).padStart(2, "0")
}

function makeEpub(stamp) {
  const root = path.join(SAMPLE_DIR, "epub")
  mkdirSync(path.join(root, "META-INF"), { recursive: true })
  mkdirSync(path.join(root, "OEBPS", "chapters"), { recursive: true })
  writeFileSync(path.join(root, "mimetype"), "application/epub+zip")
  writeFileSync(
    path.join(root, "META-INF/container.xml"),
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  )

  const title = `Reader Shell 实读 ${stamp}`
  const items = []
  const spine = []
  const nav = []
  for (let index = 1; index <= CHAPTER_COUNT; index += 1) {
    const id = `c${index}`
    const href = `chapters/chapter${padChapter(index)}.xhtml`
    items.push(
      `    <item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`,
    )
    spine.push(`    <itemref idref="${id}"/>`)
    nav.push(
      `        <li><a href="${href}#start">第 ${index} 章</a></li>`,
    )
    writeFileSync(
      path.join(root, "OEBPS", href),
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>第 ${index} 章</title></head>
  <body>
    <h1 id="start">第 ${index} 章</h1>
    <p id="p-1">这是真实 EPUB 第 ${index} 章正文，用于验证共享阅读外壳。</p>
    <p>章节内容 ${stamp}。</p>
  </body>
</html>`,
    )
  }

  writeFileSync(
    path.join(root, "OEBPS/content.opf"),
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>iRead Reader E2E</dc:creator>
    <dc:identifier id="id">urn:uuid:reader-${stamp}</dc:identifier>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-10T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${items.join("\n")}
  </manifest>
  <spine>
${spine.join("\n")}
  </spine>
</package>`,
  )

  writeFileSync(
    path.join(root, "OEBPS/nav.xhtml"),
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
${nav.join("\n")}
      </ol>
    </nav>
  </body>
</html>`,
  )

  const file = path.join(SAMPLE_DIR, "reader-shell.epub")
  zipFiles(file, root, ["mimetype"], ["-0"])
  zipFiles(file, root, ["META-INF", "OEBPS"], ["-9", "-r"])
  return { file, title }
}

async function uploadEpub(adminApi, adminRequest, file, fileName) {
  const data = readFileSync(file)
  const create = await adminApi.post("/api/v1/uploads", {
    clientUploadId: `reader-shell-${Date.now()}-${randomBytes(4).toString("hex")}`,
    fileName,
    byteSize: data.length,
  })
  assert.ok(
    create.status === 201 || create.status === 200,
    `预留上传应成功，实际 HTTP ${create.status} ${JSON.stringify(create.payload)}`,
  )
  const uploadId = create.payload?.data?.uploadId
  assert.equal(typeof uploadId, "string", "上传响应缺少 uploadId")

  const content = await adminRequest.fetch(
    `${BASE_URL}/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,
    {
      method: "PUT",
      headers: {
        Origin: BASE_URL,
        "X-CSRF-Token": adminApi.csrfToken,
        "Content-Type": "application/epub+zip",
      },
      data,
      failOnStatusCode: false,
    },
  )
  const contentPayload = await content.json().catch(() => null)
  assert.equal(
    content.status(),
    200,
    `上传内容应成功，实际 HTTP ${content.status()} ${JSON.stringify(contentPayload)}`,
  )
  return uploadId
}

async function waitForUpload(adminApi, uploadId) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const result = await adminApi.get(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}`,
    )
    assert.equal(result.status, 200, `查询上传失败：HTTP ${result.status}`)
    const data = result.payload?.data
    if (data?.state === "stored" || data?.state === "duplicate") {
      return data
    }
    if (data?.state === "failed") {
      throw new Error(
        `上传失败：${JSON.stringify(data.error ?? "unknown")}`,
      )
    }
    await sleep(400)
  }
  throw new Error("等待上传进入 stored 超时")
}

async function waitForTask(adminApi, taskId) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const result = await adminApi.get(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    )
    assert.equal(result.status, 200, `查询任务失败：HTTP ${result.status}`)
    const task = result.payload?.data
    if (task?.state === "succeeded") {
      return task
    }
    if (task?.state === "failed" || task?.state === "cancelled") {
      throw new Error(`整理任务未成功：${JSON.stringify(task)}`)
    }
    await sleep(500)
  }
  throw new Error("等待整理任务成功超时")
}

async function waitForReadyBook(adminApi, bookId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await adminApi.get(
      `/api/v1/books/${encodeURIComponent(bookId)}`,
    )
    assert.equal(result.status, 200, `查询书籍失败：HTTP ${result.status}`)
    const book = result.payload?.data
    if (book?.status === "ready") {
      return book
    }
    if (book?.status === "error" || book?.status === "unsupported") {
      throw new Error(`书籍未就绪：${JSON.stringify(book)}`)
    }
    await sleep(400)
  }
  throw new Error("等待书籍 ready 超时")
}

function spineIndexFor(manifest, tocItem) {
  const spine = manifest.formatData.spine
  const index = spine.findIndex(
    (item) =>
      item.resourceId === tocItem.resourceId ||
      (tocItem.href.length > 0 && item.href === tocItem.href),
  )
  assert.ok(index >= 0, "目录项应能在 spine 中找到")
  return index
}

function progressBody(manifest, spineIndex, percent = PROGRESS_PERCENT) {
  const spine = manifest.formatData.spine[spineIndex]
  const toc = manifest.toc.find(
    (item) => item.resourceId === spine.resourceId || item.href === spine.href,
  )
  const anchorId =
    toc?.fragment !== undefined && toc.fragment.length > 0
      ? toc.fragment
      : "start"
  return {
    schemaVersion: 1,
    fileVersion: manifest.fileVersion,
    baseRevision: "0",
    clientMutationId: `progress-${Date.now()}-${randomBytes(4).toString("hex")}`,
    format: "epub",
    locatorType: "epub-anchor",
    locatorPayload: {
      locatorVersion: 1,
      spineIndex,
      resourceId: spine.resourceId,
      href: spine.href,
      anchorId,
      chapterProgress: 0.25,
      textQuote: null,
    },
    progressPercent: percent,
  }
}

function oldBookmarkSql(bookId, manifest, spineIndex) {
  const spine = manifest.formatData.spine[spineIndex]
  const bookmarkId = randomBytes(16).toString("hex")
  const payload = JSON.stringify({
    locatorVersion: 1,
    spineIndex,
    resourceId: spine.resourceId,
    href: spine.href,
    anchorId: "start",
    chapterProgress: 0.1,
    textQuote: null,
  })
  const now = new Date().toISOString()
  const expected = `old-${Date.now()}-${randomBytes(3).toString("hex")}`
  return {
    bookmarkId,
    sql: `INSERT INTO bookmarks (
      bookmark_id, book_id, file_version, format, locator_type,
      locator_payload, locator_key, label, client_mutation_id,
      revision, created_at, updated_at
    ) VALUES (
      '${bookmarkId}', '${bookId}', '${OLD_FILE_VERSION}', 'epub',
      'epub-anchor', '${payload.replace(/'/g, "''")}', '${expected}',
      '旧版本书签', '${expected}', 1, '${now}', '${now}'
    );`,
  }
}

function sourceFor(bookOverrides, group, field) {
  return bookOverrides.fieldSources?.[group]?.[field] ?? null
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox"],
  })
  const contexts = []
  const apiContexts = []

  try {
    logStep("初始化/登录真实会话")
    const probe = await playwrightRequest.newContext({ baseURL: BASE_URL })
    apiContexts.push(probe)
    const probeApi = new AuthedApi(probe, BASE_URL)
    const status = await probeApi.fetchStatus()
    if (!status.initialized) {
      const setupContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      })
      contexts.push(setupContext)
      const setupPage = await setupContext.newPage()
      await setupPage.goto(url("/"), { waitUntil: "domcontentloaded" })
      await setupPage
        .getByRole("heading", { level: 1, name: "初始化 iRead" })
        .waitFor({ timeout: 15000 })
      await setupPage.getByLabel("密码", { exact: true }).fill(E2E_PASSWORD)
      await setupPage
        .getByLabel("确认密码", { exact: true })
        .fill(E2E_PASSWORD)
      await setupPage
        .getByRole("button", { name: "设置密码并进入" })
        .click()
      await setupPage
        .getByRole("heading", { level: 1, name: "首页" })
        .waitFor({ timeout: 20000 })
      await setupContext.close()
      contexts.splice(contexts.indexOf(setupContext), 1)
    }

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

    logStep("生成并上传真实 EPUB，等待任务 succeeded / book ready")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const sample = makeEpub(stamp)
    const uploadId = await uploadEpub(
      adminApi,
      adminRequest,
      sample.file,
      `reader-shell-${stamp}.epub`,
    )
    const upload = await waitForUpload(adminApi, uploadId)
    assert.equal(upload.state, "stored", "上传应保存为 stored")
    assert.equal(typeof upload.bookId, "string", "上传结果缺少 bookId")
    assert.equal(typeof upload.taskId, "string", "上传结果缺少 taskId")
    const bookId = upload.bookId
    const task = await waitForTask(adminApi, upload.taskId)
    assert.equal(task.state, "succeeded")
    const book = await waitForReadyBook(adminApi, bookId)
    assert.equal(book.title, sample.title)

    logStep("读取真实 manifest 并准备进度/设置")
    const manifestResult = await adminApi.get(
      `/api/v1/books/${bookId}/manifest`,
    )
    assert.equal(manifestResult.status, 200)
    const manifest = manifestResult.payload?.data
    assert.equal(manifest.format, "epub")
    assert.equal(manifest.readingCapabilities.canRead, true)
    assert.equal(manifest.toc.length, CHAPTER_COUNT)
    assert.ok(manifest.fileVersion.length === 64)
    const spineIndex = spineIndexFor(
      manifest,
      manifest.toc[CURRENT_CHAPTER - 1],
    )
    assert.equal(spineIndex, CURRENT_CHAPTER - 1)

    const progressSeed = progressBody(manifest, spineIndex)
    const progressPut = await adminApi.put(
      `/api/v1/books/${bookId}/progress`,
      progressSeed,
    )
    assert.equal(
      progressPut.status,
      200,
      `进度 PUT 失败：${JSON.stringify(progressPut.payload)}`,
    )
    assert.equal(progressPut.payload?.data?.revision, "1")
    const progressGet = await adminApi.get(
      `/api/v1/books/${bookId}/progress`,
    )
    assert.equal(progressGet.status, 200)
    assert.equal(progressGet.payload?.data?.locatorPayload?.spineIndex, spineIndex)
    assert.equal(
      progressGet.payload?.data?.locatorPayload?.anchorId,
      progressSeed.locatorPayload.anchorId,
    )

    const globalGet = await adminApi.get("/api/v1/settings/reader")
    assert.equal(globalGet.status, 200)
    const globalBaseRevision = globalGet.payload?.data?.revision
    assert.match(globalBaseRevision, /^\d+$/)
    const globalSeedRevision = String(Number(globalBaseRevision) + 1)
    const globalPut = await adminApi.put("/api/v1/settings/reader", {
      schemaVersion: 1,
      baseRevision: globalBaseRevision,
      value: { reflow: { fontSize: 19 } },
    })
    assert.equal(
      globalPut.status,
      200,
      `全局设置 PUT 失败：${JSON.stringify(globalPut.payload)}`,
    )
    assert.equal(globalPut.payload?.data?.revision, globalSeedRevision)

    const overridesGet = await adminApi.get(
      `/api/v1/books/${bookId}/reader-overrides`,
    )
    assert.equal(overridesGet.status, 200)
    assert.equal(overridesGet.payload?.data?.revision, "0")
    assert.equal(
      overridesGet.payload?.data?.effectiveValues?.reflow?.fontSize,
      19,
    )
    assert.equal(
      sourceFor(overridesGet.payload.data, "reflow", "fontSize"),
      "global",
    )
    const overridesPut = await adminApi.put(
      `/api/v1/books/${bookId}/reader-overrides`,
      {
        schemaVersion: 1,
        fileVersion: manifest.fileVersion,
        baseRevision: "0",
        overrides: {
          reflow: { animation: "light", publisherCSSMode: "publisher" },
        },
      },
    )
    assert.equal(
      overridesPut.status,
      200,
      `单书设置 PUT 失败：${JSON.stringify(overridesPut.payload)}`,
    )
    assert.equal(overridesPut.payload?.data?.revision, "1")
    assert.equal(
      sourceFor(overridesPut.payload.data, "reflow", "animation"),
      "book",
    )

    logStep("桌面 1440x900：独立 Shell、真实 manifest 与进度")
    const desktopContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(desktopContext)
    const desktop = await desktopContext.newPage()
    await desktop.goto(url(`/read/${bookId}`), {
      waitUntil: "domcontentloaded",
    })
    await desktop
      .getByRole("heading", { level: 1, name: sample.title })
      .waitFor({ timeout: 15000 })
    await desktop
      .locator("[data-reader-surface] foliate-view")
      .waitFor({ timeout: 20000 })
    await desktop
      .locator(".iread-reader-shell__position-text")
      .filter({ hasText: "位置" })
      .waitFor()
    await desktop.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-reader.png"),
    })

    assert.equal(
      await desktop.locator('[data-slot="sidebar"]').count(),
      0,
      "阅读器不得渲染 Sidebar",
    )
    assert.equal(
      await desktop.locator(".iread-mobile-nav").count(),
      0,
      "阅读器不得渲染手机底栏",
    )
    const shellBox = await desktop
      .locator(".iread-reader-shell")
      .boundingBox()
    assert.ok(shellBox !== null)
    assert.equal(Math.round(shellBox.width), 1440)
    assert.ok(Math.abs(shellBox.height - 900) <= 1)
    assert.equal(
      await desktop.locator("[data-reader-epub] foliate-view").count(),
      1,
      "EPUB 正文应由真实引擎渲染",
    )

    logStep("桌面：真实 TOC、当前项滚入与焦点")
    await desktop.keyboard.press("s")
    const tocPanel = desktop.locator('[data-reader-panel="toc"]')
    await tocPanel.waitFor({ timeout: 5000 })
    assert.equal(await desktop.getByRole("dialog").count(), 1)
    assert.equal(
      await desktop.locator('[data-slot="sheet-content"]').count(),
      1,
      "桌面目录应使用 Sheet",
    )
    const tocItems = desktop.locator(".iread-reader-toc__item")
    assert.equal(await tocItems.count(), CHAPTER_COUNT)
    const currentToc = desktop.locator(
      '.iread-reader-toc__item[aria-current="location"]',
    )
    await currentToc.waitFor()
    assert.equal(
      (await currentToc.textContent()) ?? "",
      `第 ${CURRENT_CHAPTER} 章`,
    )
    assert.ok(
      await currentToc.evaluate((element) => {
        const viewport = element.closest(
          '[data-slot="scroll-area-viewport"]',
        )
        if (viewport === null) {
          return false
        }
        const itemRect = element.getBoundingClientRect()
        const viewportRect = viewport.getBoundingClientRect()
        return (
          itemRect.top >= viewportRect.top - 1 &&
          itemRect.bottom <= viewportRect.bottom + 1
        )
      }),
      "真实 TOC 当前项应滚入可见",
    )
    await desktop.waitForTimeout(400)
    await desktop.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-toc.png"),
    })
    for (let index = 0; index < 6; index += 1) {
      await desktop.keyboard.press("Tab")
      assert.equal(
        await desktop.evaluate(
          () =>
            document.activeElement?.closest("[data-reader-panel]") !== null,
        ),
        true,
        "焦点应被限制在面板内",
      )
    }
    await desktop.keyboard.press("Escape")
    await tocPanel.waitFor({ state: "hidden" })
    assert.equal(
      await desktop.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? "",
      ),
      "目录与书签",
      "关闭面板后焦点应回到触发按钮",
    )

    logStep("桌面：pagehide 立即保存最新位置并携带内存 CSRF")
    const positionText = desktop.locator(
      ".iread-reader-shell__position-text",
    )
    const positionBeforePagehide =
      (await positionText.textContent()) ?? ""
    const pagehidePutHeaders = []
    const progressRoute = "**/api/v1/books/*/progress"
    await desktop.route(progressRoute, async (route) => {
      if (route.request().method() === "PUT") {
        pagehidePutHeaders.push(route.request().headers())
      }
      await route.continue()
    })
    await desktop.getByRole("button", { name: "目录与书签" }).click()
    await tocPanel.waitFor()
    await tocPanel
      .locator(".iread-reader-toc__item", { hasText: "第 3 章" })
      .click()
    await desktop.waitForFunction(
      (previous) =>
        document.querySelector(".iread-reader-shell__position-text")
          ?.textContent !== previous,
      positionBeforePagehide,
      { timeout: 10000 },
    )
    const revisionBeforePagehide = Number(
      (
        await adminApi.get(`/api/v1/books/${bookId}/progress`)
      ).payload?.data?.revision,
    )
    await desktop.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"))
    })
    let revisionAfterPagehide = revisionBeforePagehide
    const pagehideDeadline = Date.now() + 5_000
    while (Date.now() < pagehideDeadline) {
      const current = await adminApi.get(
        `/api/v1/books/${bookId}/progress`,
      )
      revisionAfterPagehide = Number(current.payload?.data?.revision)
      if (revisionAfterPagehide > revisionBeforePagehide) {
        break
      }
      await sleep(100)
    }
    await desktop.unroute(progressRoute)
    assert.ok(
      revisionAfterPagehide > revisionBeforePagehide,
      "pagehide 应把 600ms 节流窗口内的最新位置立即写入服务器",
    )
    assert.ok(
      pagehidePutHeaders.some(
        (headers) =>
          typeof headers["x-csrf-token"] === "string" &&
          headers["x-csrf-token"].length > 0,
      ),
      "pagehide PUT 必须携带内存 CSRF 令牌",
    )
    const pagehideSnapshot = await desktop.evaluate((targetBookId) => {
      const raw = window.localStorage.getItem(
        `iread.reader-snapshot.v1:${targetBookId}`,
      )
      return raw === null ? null : JSON.parse(raw)
    }, bookId)
    assert.ok(pagehideSnapshot !== null, "pagehide 应同步写入退出快照")
    assert.match(
      (await positionText.textContent()) ?? "",
      new RegExp(`${Math.round(pagehideSnapshot.progressPercent)}%`),
      "退出快照进度应与当前显示位置一致",
    )
    // 恢复初始章节，后续书签用例依赖当前位置在第 28 章。
    await desktop.getByRole("button", { name: "目录与书签" }).click()
    await tocPanel.waitFor()
    await tocPanel
      .locator(".iread-reader-toc__item", {
        hasText: `第 ${CURRENT_CHAPTER} 章`,
      })
      .click()
    await tocPanel.waitFor({ state: "hidden" })
    await desktop.getByRole("button", { name: "目录与书签" }).click()
    await tocPanel.waitFor()
    await desktop.waitForFunction(
      (chapter) =>
        document
          .querySelector('.iread-reader-toc__item[aria-current="location"]')
          ?.textContent?.trim() === chapter,
      `第 ${CURRENT_CHAPTER} 章`,
      { timeout: 10000 },
    )
    // 章节跳转后焦点可能留在正文 iframe；先确认焦点进入面板再测 Esc，
    // 避免把“焦点在跨 realm 正文”误当成面板关闭失败。
    await tocPanel.getByRole("tab", { name: "目录" }).focus()
    await desktop.keyboard.press("Escape")
    await tocPanel.waitFor({ state: "hidden" })

    logStep("桌面：真实书签空态、POST、列表与 If-Match DELETE")
    await desktop.getByRole("button", { name: "目录与书签" }).click()
    await desktop.getByRole("tab", { name: "书签" }).click()
    await desktop.getByText("还没有书签", { exact: true }).waitFor()
    await desktop
      .getByRole("button", { name: "添加当前位置书签" })
      .click()
    await desktop.getByText("书签已添加", { exact: true }).waitFor()
    await desktop.getByText("第 28 章", { exact: true }).waitFor()
    const bookmarkListGet = await adminApi.get(
      `/api/v1/books/${bookId}/bookmarks?fileVersion=${manifest.fileVersion}`,
    )
    assert.equal(bookmarkListGet.status, 200)
    assert.equal(bookmarkListGet.payload?.data?.length, 1)
    assert.equal(bookmarkListGet.payload.data[0].label, "第 28 章")
    const bookmarkId = bookmarkListGet.payload.data[0].bookmarkId
    assert.equal(bookmarkListGet.payload.data[0].revision, "1")
    await desktop
      .getByRole("button", { name: "移除书签：第 28 章" })
      .click()
    await desktop.getByText("书签已移除", { exact: true }).waitFor()
    const bookmarkListAfter = await adminApi.get(
      `/api/v1/books/${bookId}/bookmarks?fileVersion=${manifest.fileVersion}`,
    )
    assert.equal(bookmarkListAfter.payload?.data?.length, 0)
    await desktop.keyboard.press("Escape")
    await tocPanel.waitFor({ state: "hidden" })

    logStep("桌面：键盘、输入区域不抢键与全屏")
    await desktop.evaluate(() => {
      const input = document.createElement("input")
      input.id = "e2e-reader-input"
      document.body.appendChild(input)
      input.focus()
    })
    await desktop.keyboard.press("ArrowRight")
    await desktop.waitForTimeout(150)
    assert.equal(
      await desktop.locator(".iread-reader-shell__notice").count(),
      0,
      "输入框聚焦时阅读器不得抢方向键",
    )
    await desktop.evaluate(() => {
      document.getElementById("e2e-reader-input")?.remove()
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    })
    const beforeKeyTurn = await desktop.evaluate(() => {
      const view = document.querySelector("[data-reader-epub] foliate-view")
      const contents = view?.renderer?.getContents?.() ?? []
      return {
        index: contents[0]?.index ?? null,
        page: view?.renderer?.page ?? null,
      }
    })
    await desktop.keyboard.press("ArrowRight")
    await desktop.waitForFunction(
      (previous) => {
        const view = document.querySelector("[data-reader-epub] foliate-view")
        const contents = view?.renderer?.getContents?.() ?? []
        return (
          JSON.stringify({
            index: contents[0]?.index ?? null,
            page: view?.renderer?.page ?? null,
          }) !== JSON.stringify(previous)
        )
      },
      beforeKeyTurn,
      { timeout: 5000 },
    )
    const fullscreenSupported = await desktop.evaluate(
      () =>
        document.fullscreenEnabled === true &&
        typeof document.documentElement.requestFullscreen === "function",
    )
    console.log(`[E2E] fullscreenSupported=${fullscreenSupported}`)
    if (fullscreenSupported) {
      await desktop.keyboard.press("f")
      await desktop.waitForFunction(
        () => document.fullscreenElement !== null,
        undefined,
        { timeout: 3000 },
      )
      await desktop.keyboard.press("f")
      await desktop.waitForFunction(
        () => document.fullscreenElement === null,
        undefined,
        { timeout: 3000 },
      )
    }

    logStep("桌面：真实设置三级继承、来源 Badge 与保存范围")
    await desktop.getByRole("button", { name: "阅读设置" }).click()
    const settingsPanel = desktop.locator('[data-reader-panel="settings"]')
    await settingsPanel.waitFor({ timeout: 5000 })
    assert.equal(
      (await desktop.evaluate(
        () => document.activeElement?.textContent?.trim() ?? "",
      )),
      "EPUB 文字",
      "设置面板初始焦点应在首个分组 Tab",
    )
    const fontRow = settingsPanel
      .locator(".iread-reader-settings__field")
      .filter({ hasText: "字号" })
    await fontRow.getByText("全局", { exact: true }).waitFor()
    const settingsTabs = settingsPanel.getByRole("tab")
    assert.equal(await settingsTabs.count(), 1, "EPUB 设置只应显示一个分组 Tab")
    assert.equal(
      await desktop.getByRole("tab", { name: "PDF 布局" }).count(),
      0,
      "EPUB 设置不应显示 PDF 布局 Tab",
    )
    assert.equal(
      await desktop.getByRole("tab", { name: "漫画" }).count(),
      0,
      "EPUB 设置不应显示漫画 Tab",
    )
    const bookAnimationRow = settingsPanel
      .locator(".iread-reader-settings__field")
      .filter({ hasText: "翻页动画" })
    await bookAnimationRow.getByText("本书覆盖", { exact: true }).waitFor()
    const paginationRow = settingsPanel
      .locator(".iread-reader-settings__field")
      .filter({ hasText: "翻页方式" })
    await paginationRow.getByText("内置", { exact: true }).waitFor()
    await desktop.waitForTimeout(300)
    await desktop.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-settings.png"),
    })

    const readBookOverrides = async () => {
      const result = await adminApi.get(
        `/api/v1/books/${bookId}/reader-overrides`,
      )
      assert.equal(result.status, 200)
      return result.payload.data
    }

    // 当前已确认行为：本书更改自动保存；“立即保存本书”可显式 flush。
    const beforeAutosave = await readBookOverrides()
    await desktop.getByLabel("翻页动画").click()
    await desktop.getByRole("option", { name: "无" }).click()
    await settingsPanel
      .locator('[data-reader-autosave="saved"]')
      .waitFor({ timeout: 10000 })
    const overridesAfterAutosave = await readBookOverrides()
    assert.equal(
      Number(overridesAfterAutosave.revision),
      Number(beforeAutosave.revision) + 1,
    )
    assert.equal(
      sourceFor(overridesAfterAutosave, "reflow", "animation"),
      "book",
    )
    assert.equal(overridesAfterAutosave.overrides.reflow.animation, "none")
    assert.equal(
      overridesAfterAutosave.overrides.reflow.publisherCSSMode,
      "publisher",
      "自动保存不得删除未修改的其他覆盖字段",
    )
    await bookAnimationRow.getByText("本书覆盖", { exact: true }).waitFor()

    await desktop.getByLabel("翻页动画").click()
    await desktop.getByRole("option", { name: "轻量" }).click()
    await desktop
      .getByRole("button", { name: "立即保存本书" })
      .click()
    await settingsPanel
      .locator('[data-status="saved"]')
      .filter({ hasText: "本书设置已保存。" })
      .waitFor({ timeout: 10000 })
    const overridesAfterImmediate = await readBookOverrides()
    assert.equal(
      Number(overridesAfterImmediate.revision),
      Number(overridesAfterAutosave.revision) + 1,
    )
    assert.equal(overridesAfterImmediate.overrides.reflow.animation, "light")

    await desktop.getByRole("button", { name: "设为全局默认" }).click()
    await desktop
      .getByText("已设为全局默认值；未删除其他书籍的本书覆盖。", {
        exact: true,
      })
      .waitFor()
    const globalAfterSave = await adminApi.get("/api/v1/settings/reader")
    assert.equal(
      globalAfterSave.payload?.data?.revision,
      String(Number(globalSeedRevision) + 1),
    )
    assert.equal(globalAfterSave.payload.data.value.reflow.animation, "light")
    assert.equal(globalAfterSave.payload.data.value.reflow.fontSize, 19)
    await bookAnimationRow.getByText("本书覆盖", { exact: true }).waitFor()

    await desktop.getByRole("button", { name: "恢复本书默认" }).click()
    await desktop.getByText("已恢复本书默认设置。", { exact: true }).waitFor()
    const overridesAfterReset = await readBookOverrides()
    assert.equal(
      Number(overridesAfterReset.revision),
      Number(overridesAfterImmediate.revision) + 1,
    )
    assert.deepEqual(overridesAfterReset.overrides, {})
    await bookAnimationRow.getByText("全局", { exact: true }).waitFor()

    logStep("桌面：409 设置冲突与载入服务器设置")
    const conflictSeed = await adminApi.put(
      `/api/v1/books/${bookId}/reader-overrides`,
      {
        schemaVersion: 1,
        fileVersion: manifest.fileVersion,
        baseRevision: overridesAfterReset.revision,
        overrides: { reflow: { animation: "light" } },
      },
    )
    assert.equal(conflictSeed.status, 200)
    assert.equal(
      Number(conflictSeed.payload?.data?.revision),
      Number(overridesAfterReset.revision) + 1,
    )
    await desktop.getByLabel("翻页动画").click()
    await desktop.getByRole("option", { name: "无" }).click()
    await settingsPanel
      .locator('[data-reader-autosave="conflict"]')
      .waitFor({ timeout: 10000 })
    await desktop
      .getByRole("button", { name: "载入服务器设置" })
      .click()
    await desktop
      .getByText("已载入服务器设置，本机待保存值已放弃。", { exact: true })
      .waitFor()
    const animationRow = settingsPanel
      .locator(".iread-reader-settings__field")
      .filter({ hasText: "翻页动画" })
    await animationRow.getByText("轻量", { exact: true }).first().waitFor()

    await desktop.getByLabel("翻页动画").click()
    await desktop.getByRole("option", { name: "无" }).click()
    await settingsPanel
      .locator('[data-reader-autosave="saved"]')
      .waitFor({ timeout: 10000 })
    const overridesAfterRecovery = await readBookOverrides()
    assert.equal(
      Number(overridesAfterRecovery.revision),
      Number(conflictSeed.payload.data.revision) + 1,
    )
    assert.equal(overridesAfterRecovery.overrides.reflow.animation, "none")

    const overridesBeforeSecondSeed = await readBookOverrides()
    const secondConflictSeed = await adminApi.put(
      `/api/v1/books/${bookId}/reader-overrides`,
      {
        schemaVersion: 1,
        fileVersion: manifest.fileVersion,
        baseRevision: overridesBeforeSecondSeed.revision,
        overrides: {
          reflow: { animation: "none", publisherCSSMode: "publisher" },
        },
      },
    )
    assert.equal(secondConflictSeed.status, 200)
    assert.equal(
      Number(secondConflictSeed.payload?.data?.revision),
      Number(overridesBeforeSecondSeed.revision) + 1,
    )
    await desktop.getByLabel("翻页动画").click()
    await desktop.getByRole("option", { name: "轻量" }).click()
    await settingsPanel
      .locator('[data-reader-autosave="conflict"]')
      .waitFor({ timeout: 10000 })
    await desktop
      .getByRole("button", { name: "保留本机选择并重新保存" })
      .click()
    await settingsPanel
      .locator('[data-reader-autosave="saved"]')
      .waitFor({ timeout: 10000 })
    const overridesAfterKeepLocal = await readBookOverrides()
    assert.equal(
      Number(overridesAfterKeepLocal.revision),
      Number(secondConflictSeed.payload.data.revision) + 1,
    )
    assert.equal(
      overridesAfterKeepLocal.overrides.reflow.animation,
      "light",
      "保留本机选择应写入当前待保存字段",
    )
    assert.equal(
      overridesAfterKeepLocal.overrides.reflow.publisherCSSMode,
      "publisher",
      "冲突重试应保留服务器上未修改的其他覆盖字段",
    )
    await desktop.keyboard.press("Escape")
    await settingsPanel.waitFor({ state: "hidden" })

    logStep("桌面：旧 fileVersion 书签标记与移除")
    if (DB_PATH === "") {
      console.log("[E2E] 未设置 IREAD_DB_PATH，旧 fileVersion 样本跳过")
    } else {
      const oldFixture = oldBookmarkSql(bookId, manifest, spineIndex)
      execFileSync("sqlite3", [DB_PATH, oldFixture.sql])
      await desktop.evaluate(
        ({ targetBookId, oldVersion }) => {
          window.localStorage.setItem(
            `iread.reader-file-version.v1:${targetBookId}`,
            oldVersion,
          )
        },
        { targetBookId: bookId, oldVersion: OLD_FILE_VERSION },
      )
      await desktop.reload({ waitUntil: "domcontentloaded" })
      await desktop
        .getByRole("heading", { level: 1, name: sample.title })
        .waitFor({ timeout: 15000 })
      await desktop.getByRole("button", { name: "目录与书签" }).click()
      await desktop.getByRole("tab", { name: "书签" }).click()
      await desktop.getByText("旧版本书签", { exact: true }).waitFor()
      await desktop
        .getByText("原件已更新，不可直接跳转", { exact: true })
        .waitFor()
      const oldJump = desktop
        .locator(".iread-reader-bookmarks__item")
        .filter({ hasText: "旧版本书签" })
        .locator(".iread-reader-bookmarks__jump")
      assert.equal(await oldJump.isDisabled(), true)
      const oldList = await adminApi.get(
        `/api/v1/books/${bookId}/bookmarks?fileVersion=${OLD_FILE_VERSION}`,
      )
      assert.equal(oldList.payload?.data?.length, 1)
      await desktop
        .getByRole("button", { name: "移除书签：旧版本书签" })
        .click()
      await desktop.getByText("书签已移除", { exact: true }).waitFor()
      const oldListAfter = await adminApi.get(
        `/api/v1/books/${bookId}/bookmarks?fileVersion=${OLD_FILE_VERSION}`,
      )
      assert.equal(oldListAfter.payload?.data?.length, 0)
      await desktop.keyboard.press("Escape")
      await tocPanel.waitFor({ state: "hidden" })
    }

    logStep("桌面：退出保存真实进度与本机快照")
    const progressBeforeExit = await adminApi.get(
      `/api/v1/books/${bookId}/progress`,
    )
    assert.equal(progressBeforeExit.status, 200)
    const progressRevisionBeforeExit = Number(
      progressBeforeExit.payload?.data?.revision,
    )
    assert.ok(
      Number.isInteger(progressRevisionBeforeExit),
      "退出前应读取到真实进度 revision",
    )
    await desktop.getByRole("button", { name: "返回书库" }).click()
    await desktop.waitForFunction(
      () => window.location.pathname === "/library",
      undefined,
      { timeout: 5000 },
    )
    const finalProgress = await adminApi.get(
      `/api/v1/books/${bookId}/progress`,
    )
    assert.equal(finalProgress.status, 200)
    assert.equal(
      Number(finalProgress.payload?.data?.revision),
      progressRevisionBeforeExit + 1,
      "退出应新增一次真实进度保存",
    )
    const finalSpineIndex =
      finalProgress.payload?.data?.locatorPayload?.spineIndex
    assert.ok(
      typeof finalSpineIndex === "number" &&
        finalSpineIndex >= spineIndex &&
        finalSpineIndex <= spineIndex + 1,
      `退出进度章节应在第 ${spineIndex + 1}–${spineIndex + 2} 节内，实际 ${finalSpineIndex}`,
    )
    assert.equal(
      finalProgress.payload?.data?.locatorType,
      "epub-cfi",
      "EPUB 退出进度应保存真实 CFI",
    )
    assert.match(
      finalProgress.payload?.data?.locatorPayload?.cfi ?? "",
      /^epubcfi\(/,
    )
    const snapshot = await desktop.evaluate((targetBookId) => {
      const raw = window.localStorage.getItem(
        `iread.reader-snapshot.v1:${targetBookId}`,
      )
      return raw === null ? null : JSON.parse(raw)
    }, bookId)
    assert.ok(snapshot !== null)
    assert.ok(
      snapshot.locatorPayload.spineIndex >= spineIndex &&
        snapshot.locatorPayload.spineIndex <= spineIndex + 1,
    )

    logStep("IndexedDB 不可用：localStorage 退出快照恢复")
    const fallbackLocator = progressBody(manifest, 3, 10)
    const fallbackContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(fallbackContext)
    await fallbackContext.addInitScript(
      ({ targetBookId, fileVersion, locator }) => {
        Object.defineProperty(window, "indexedDB", {
          configurable: true,
          get: () => undefined,
        })
        // 本用例只验证“IndexedDB 不可用时的 localStorage 恢复”。
        // 页面关闭时真实卸载 beacon 会把恢复位置写回服务器，阻断
        // 进度 PUT，避免用例的合成退出快照影响后续服务器进度断言。
        const originalFetch = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const request =
            typeof Request !== "undefined" && input instanceof Request
              ? input
              : null
          const requestUrl =
            request?.url ??
            (typeof input === "string" ? input : String(input))
          const method = (
            init?.method ?? request?.method ?? "GET"
          ).toUpperCase()
          if (method === "PUT" && requestUrl.includes("/progress")) {
            return Promise.reject(
              new TypeError("blocked by e2e: indexedDB fallback"),
            )
          }
          return originalFetch(input, init)
        }
        window.localStorage.setItem(
          `iread.reader-snapshot.v1:${targetBookId}`,
          JSON.stringify({
            schemaVersion: 1,
            bookId: targetBookId,
            fileVersion,
            format: "epub",
            locatorType: locator.locatorType,
            locatorPayload: locator.locatorPayload,
            progressPercent: locator.progressPercent,
            // 比服务器记录更新，验证 local-only 时不会被旧服务器位置覆盖。
            savedAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        )
      },
      {
        targetBookId: bookId,
        fileVersion: manifest.fileVersion,
        locator: {
          locatorType: fallbackLocator.locatorType,
          locatorPayload: fallbackLocator.locatorPayload,
          progressPercent: fallbackLocator.progressPercent,
        },
      },
    )
    const fallbackPage = await fallbackContext.newPage()
    await fallbackPage.goto(url(`/read/${bookId}`), {
      waitUntil: "domcontentloaded",
    })
    await fallbackPage
      .getByRole("heading", { level: 1, name: sample.title })
      .waitFor({ timeout: 15000 })
    await fallbackPage
      .locator("[data-reader-surface] foliate-view")
      .waitFor({ timeout: 20000 })
    const fallbackPosition = fallbackPage.locator(
      ".iread-reader-shell__position-text",
    )
    await fallbackPosition.filter({ hasText: "位置" }).waitFor()
    assert.equal(
      await fallbackPage.evaluate(() => window.indexedDB),
      undefined,
      "该用例必须模拟 IndexedDB 不可用",
    )
    await fallbackPage
      .getByRole("button", { name: "目录与书签" })
      .click()
    const fallbackToc = fallbackPage.locator('[data-reader-panel="toc"]')
    await fallbackToc.waitFor()
    assert.equal(
      (
        await fallbackToc
          .locator('.iread-reader-toc__item[aria-current="location"]')
          .textContent()
      )?.trim(),
      "第 4 章",
      "IndexedDB 不可用时应从 localStorage 退出快照恢复 locator",
    )
    await fallbackPage.keyboard.press("Escape")
    await fallbackPage.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "desktop-local-snapshot-fallback.png",
      ),
    })
    await fallbackContext.close()

    logStep("真实 API 错误路径：401/403/409/412/422")
    const unauthRequest = await playwrightRequest.newContext({
      baseURL: BASE_URL,
    })
    apiContexts.push(unauthRequest)
    const unauthManifest = await unauthRequest.get(
      `/api/v1/books/${bookId}/manifest`,
    )
    assert.equal(unauthManifest.status(), 401)
    assert.equal(
      (await unauthManifest.json()).error?.code,
      "unauthenticated",
    )

    const noCsrf = await adminRequest.fetch(
      `${BASE_URL}/api/v1/books/${bookId}/bookmarks`,
      {
        method: "POST",
        headers: {
          Origin: BASE_URL,
          "Content-Type": "application/json",
        },
        data: {
          schemaVersion: 1,
          fileVersion: manifest.fileVersion,
          format: "epub",
          locatorType: "epub-anchor",
          locatorPayload: progressSeed.locatorPayload,
          clientMutationId: `no-csrf-${Date.now()}`,
        },
        failOnStatusCode: false,
      },
    )
    assert.equal(noCsrf.status(), 403)
    const noCsrfPayload = await noCsrf.json()
    assert.equal(noCsrfPayload.error?.code, "forbidden")
    assert.equal(noCsrfPayload.error?.details?.reason, "csrf_invalid")

    const staleProgress = await adminApi.put(
      `/api/v1/books/${bookId}/progress`,
      { ...progressBody(manifest, spineIndex), baseRevision: "999" },
    )
    assert.equal(staleProgress.status, 409)
    assert.equal(staleProgress.payload?.error?.code, "revision_conflict")
    assert.ok(staleProgress.payload?.error?.details?.current)

    const staleGlobal = await adminApi.put("/api/v1/settings/reader", {
      schemaVersion: 1,
      baseRevision: "999",
      value: { reflow: { fontSize: 20 } },
    })
    assert.equal(staleGlobal.status, 409)
    assert.equal(staleGlobal.payload?.error?.code, "revision_conflict")

    const unsupported = await adminApi.put(
      `/api/v1/books/${bookId}/progress`,
      {
        ...progressBody(manifest, spineIndex),
        baseRevision: "2",
        locatorType: "pdf-page",
        locatorPayload: {
          locatorVersion: 1,
          page: 1,
          pageOffset: 0,
          relativeViewport: null,
          view: null,
        },
      },
    )
    assert.equal(unsupported.status, 422)
    assert.equal(unsupported.payload?.error?.code, "unsupported_locator")

    const tempBookmark = await adminApi.post(
      `/api/v1/books/${bookId}/bookmarks`,
      {
        schemaVersion: 1,
        fileVersion: manifest.fileVersion,
        format: "epub",
        locatorType: "epub-anchor",
        locatorPayload: {
          ...progressSeed.locatorPayload,
          spineIndex: spineIndex + 1,
          resourceId: manifest.formatData.spine[spineIndex + 1].resourceId,
          href: manifest.formatData.spine[spineIndex + 1].href,
        },
        clientMutationId: `temp-${Date.now()}`,
        label: "临时书签",
      },
    )
    assert.ok(
      tempBookmark.status === 201 || tempBookmark.status === 200,
      `创建临时书签失败：${JSON.stringify(tempBookmark.payload)}`,
    )
    const tempId = tempBookmark.payload.data.bookmarkId
    const wrongIfMatch = await adminRequest.fetch(
      `${BASE_URL}/api/v1/books/${bookId}/bookmarks/${tempId}`,
      {
        method: "DELETE",
        headers: {
          Origin: BASE_URL,
          "X-CSRF-Token": adminApi.csrfToken,
          "If-Match": '"999"',
        },
        failOnStatusCode: false,
      },
    )
    assert.equal(wrongIfMatch.status(), 412)
    assert.equal(
      (await wrongIfMatch.json()).error?.code,
      "precondition_failed",
    )
    const correctDelete = await adminRequest.fetch(
      `${BASE_URL}/api/v1/books/${bookId}/bookmarks/${tempId}`,
      {
        method: "DELETE",
        headers: {
          Origin: BASE_URL,
          "X-CSRF-Token": adminApi.csrfToken,
          "If-Match": `"${tempBookmark.payload.data.revision}"`,
        },
        failOnStatusCode: false,
      },
    )
    assert.equal(correctDelete.status(), 204)

    logStep("手机 390x844：真实 Drawer、手势与旋转")
    const mobileContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(mobileContext)
    const mobile = await mobileContext.newPage()
    await mobile.goto(url(`/read/${bookId}`), {
      waitUntil: "domcontentloaded",
    })
    await mobile
      .getByRole("heading", { level: 1, name: sample.title })
      .waitFor({ timeout: 15000 })
    await mobile
      .locator("[data-reader-surface] foliate-view")
      .waitFor({ timeout: 20000 })
    await mobile
      .locator(".iread-reader-shell__position-text")
      .filter({ hasText: "位置" })
      // 手机工具栏可自动隐藏；位置文本仍在 DOM 中，不能要求可见。
      .waitFor({ state: "attached" })
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-reader.png"),
    })
    assert.equal(await mobile.locator(".iread-mobile-nav").count(), 0)
    const mobileBox = await mobile.locator(".iread-reader-shell").boundingBox()
    assert.ok(mobileBox !== null)
    assert.equal(Math.round(mobileBox.width), 390)
    assert.ok(Math.abs(mobileBox.height - 844) <= 1)

    await mobile.getByRole("button", { name: "目录与书签" }).click()
    const mobilePanel = mobile.locator('[data-reader-panel="toc"]')
    await mobilePanel.waitFor({ timeout: 5000 })
    assert.equal(
      await mobile.locator('[data-slot="drawer-content"]').count(),
      1,
      "手机目录应使用 Drawer",
    )
    assert.equal(
      (await mobile.evaluate(
        () =>
          document.activeElement?.closest("[data-reader-panel]") !== null,
      )),
      true,
      "Drawer 初始焦点必须在面板内",
    )
    const mobileCurrent = mobile.locator(
      '.iread-reader-toc__item[aria-current="location"]',
    )
    await mobileCurrent.waitFor()
    assert.equal(
      (await mobileCurrent.textContent()) ?? "",
      `第 ${finalSpineIndex + 1} 章`,
      "手机目录当前项应与退出时保存的真实进度一致",
    )
    await mobile.waitForTimeout(300)
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-toc.png"),
    })
    for (let index = 0; index < 6; index += 1) {
      await mobile.keyboard.press("Tab")
      assert.equal(
        await mobile.evaluate(
          () => document.activeElement?.closest("[data-reader-panel]") !== null,
        ),
        true,
      )
    }
    await mobile.keyboard.press("Escape")
    await mobilePanel.waitFor({ state: "hidden" })
    assert.equal(
      await mobile.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? "",
      ),
      "目录与书签",
    )

    const stageBox = await mobile
      .locator(".iread-reader-shell__stage")
      .boundingBox()
    assert.ok(stageBox !== null)
    const centerX = stageBox.x + stageBox.width / 2
    const centerY = stageBox.y + stageBox.height / 2
    await mobile.dispatchEvent(".iread-reader-shell__stage", "pointerdown", {
      pointerId: 11,
      pointerType: "touch",
      clientX: centerX,
      clientY: centerY,
    })
    await mobile.dispatchEvent(".iread-reader-shell__stage", "pointerdown", {
      pointerId: 12,
      pointerType: "touch",
      clientX: centerX + 20,
      clientY: centerY,
    })
    await mobile.dispatchEvent(".iread-reader-shell__stage", "pointerup", {
      pointerId: 11,
      pointerType: "touch",
      clientX: centerX,
      clientY: centerY,
    })
    await mobile.dispatchEvent(".iread-reader-shell__stage", "pointerup", {
      pointerId: 12,
      pointerType: "touch",
      clientX: centerX + 20,
      clientY: centerY,
    })
    assert.equal(
      await mobile.locator(".iread-reader-shell__notice").count(),
      0,
      "多点触控不得触发翻页",
    )
    const mobileBeforeTurn = await mobile.evaluate(() => {
      const view = document.querySelector("[data-reader-epub] foliate-view")
      const contents = view?.renderer?.getContents?.() ?? []
      return {
        index: contents[0]?.index ?? null,
        page: view?.renderer?.page ?? null,
      }
    })
    await mobile.getByRole("button", { name: "下一处" }).click()
    await mobile.waitForFunction(
      (previous) => {
        const view = document.querySelector("[data-reader-epub] foliate-view")
        const contents = view?.renderer?.getContents?.() ?? []
        return (
          JSON.stringify({
            index: contents[0]?.index ?? null,
            page: view?.renderer?.page ?? null,
          }) !== JSON.stringify(previous)
        )
      },
      mobileBeforeTurn,
      { timeout: 5000 },
    )
    assert.equal(
      await mobile
        .locator(".iread-reader-shell__topbar")
        .getAttribute("aria-hidden"),
      "false",
      "手机工具栏应保持可操作",
    )

    await mobile.setViewportSize({ width: 844, height: 390 })
    await mobile.waitForFunction(
      () =>
        Math.round(
          document
            .querySelector(".iread-reader-shell")
            ?.getBoundingClientRect().height ?? 0,
        ) === 390,
      undefined,
      { timeout: 3000 },
    )
    assert.match(
      (await mobile
        .locator(".iread-reader-shell__position-text")
        .textContent()) ?? "",
      /位置 \d+%/,
    )
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.waitForFunction(
      () =>
        Math.round(
          document
            .querySelector(".iread-reader-shell")
            ?.getBoundingClientRect().height ?? 0,
        ) === 844,
      undefined,
      { timeout: 3000 },
    )

    await mobile.getByRole("button", { name: "阅读设置" }).click()
    const mobileSettings = mobile.locator('[data-reader-panel="settings"]')
    await mobileSettings.waitFor({ timeout: 5000 })
    assert.equal(
      await mobile.getByRole("tab", { name: "PDF 布局" }).count(),
      0,
      "EPUB 设置不应显示 PDF 布局 Tab",
    )
    await mobile.getByRole("tab", { name: "EPUB 文字" }).click()
    await mobileSettings.getByText("全局", { exact: true }).first().waitFor()
    await mobile.waitForTimeout(300)
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-settings.png"),
    })
    await mobile.keyboard.press("Escape")
    await mobileSettings.waitFor({ state: "hidden" })

    logStep("真实会话失效：401 后回到登录而不是继续阅读")
    const logout = await adminApi.post("/api/v1/auth/logout")
    assert.ok(
      logout.status === 200 || logout.status === 204,
      `退出登录失败：HTTP ${logout.status}`,
    )
    await mobile.reload({ waitUntil: "domcontentloaded" })
    await mobile
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 15000 })

    console.log("\n[E2E] 真实 API 阅读器共享 Shell 通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      await context.dispose().catch(() => {})
    }
    await browser.close().catch(() => {})
    rmSync(SAMPLE_DIR, { recursive: true, force: true })
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
