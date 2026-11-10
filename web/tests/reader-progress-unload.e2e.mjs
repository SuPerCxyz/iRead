#!/usr/bin/env node

/**
 * P1-4 真实卸载回归：不使用 dispatchEvent("pagehide") 作为唯一证据，
 * 而是让 Chromium 真正 reload / 前进后退，验证：
 * 1. 位置变化后 <600ms 内 reload，keepalive PUT 仍把新位置写入服务器，
 *    重开后恢复新位置；
 * 2. 位置变化后立即路由离开/返回，保存并恢复；
 * 3. localStorage 退出快照比 IndexedDB 新时，恢复选择 localStorage。
 */

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
const SAMPLE_DIR = mkdtempSync(path.join(tmpdir(), "iread-progress-unload-"))
const SCREENSHOT_DIR =
  process.env.READER_SCREENSHOT_DIR ??
  path.join(tmpdir(), "iread-progress-unload-screenshots")

const CHAPTER_COUNT = 16
const START_CHAPTER = 4
const RELOAD_TARGET_CHAPTER = 12
const NAVIGATION_TARGET_CHAPTER = 9
const LOCAL_ONLY_START_CHAPTER = 3
const LOCAL_ONLY_TARGET_CHAPTER = 10
const THROTTLE_WINDOW_MS = 600

const SNAPSHOT_STORAGE_PREFIX = "iread.reader-snapshot.v1:"

function url(pathname) {
  return `${BASE_URL}${pathname}`
}

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function padChapter(index) {
  return String(index).padStart(2, "0")
}

function zipFiles(target, cwd, files, options = []) {
  execFileSync("zip", ["-X", ...options, target, ...files], {
    cwd,
    stdio: "ignore",
  })
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

  const title = `进度卸载回归 ${stamp}`
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
    nav.push(`        <li><a href="${href}#start">第 ${index} 章</a></li>`)
    writeFileSync(
      path.join(root, "OEBPS", href),
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>第 ${index} 章</title></head>
  <body>
    <h1 id="start">第 ${index} 章</h1>
    <p>真实 EPUB 第 ${index} 章正文，用于验证页面卸载后的进度恢复。</p>
    <p>${stamp}</p>
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
    <dc:creator>iRead Progress E2E</dc:creator>
    <dc:identifier id="id">urn:uuid:progress-unload-${stamp}</dc:identifier>
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

  const file = path.join(SAMPLE_DIR, "progress-unload.epub")
  zipFiles(file, root, ["mimetype"], ["-0"])
  zipFiles(file, root, ["META-INF", "OEBPS"], ["-9", "-r"])
  return { file, title }
}

async function uploadEpub(adminApi, adminRequest, file, fileName) {
  const data = readFileSync(file)
  const create = await adminApi.post("/api/v1/uploads", {
    clientUploadId: `progress-unload-${Date.now()}-${randomBytes(4).toString("hex")}`,
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
  const payload = await content.json().catch(() => null)
  assert.equal(
    content.status(),
    200,
    `上传内容应成功，实际 HTTP ${content.status()} ${JSON.stringify(payload)}`,
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
      throw new Error(`上传失败：${JSON.stringify(data.error ?? "unknown")}`)
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

function spineIndexFor(manifest, chapter) {
  const tocItem = manifest.toc.find(
    (item) => item.title.trim() === `第 ${chapter} 章`,
  )
  assert.ok(tocItem, `目录中应存在第 ${chapter} 章`)
  const index = manifest.formatData.spine.findIndex(
    (item) =>
      item.resourceId === tocItem.resourceId ||
      (tocItem.href.length > 0 && item.href === tocItem.href),
  )
  assert.ok(index >= 0, `第 ${chapter} 章应能在 spine 中找到`)
  return index
}

function progressBody(manifest, chapter, baseRevision) {
  const spineIndex = spineIndexFor(manifest, chapter)
  const spine = manifest.formatData.spine[spineIndex]
  const toc = manifest.toc.find(
    (item) => item.resourceId === spine.resourceId || item.href === spine.href,
  )
  return {
    schemaVersion: 1,
    fileVersion: manifest.fileVersion,
    baseRevision: String(baseRevision),
    clientMutationId: `progress-seed-${Date.now()}-${randomBytes(4).toString("hex")}`,
    format: "epub",
    locatorType: "epub-anchor",
    locatorPayload: {
      locatorVersion: 1,
      spineIndex,
      resourceId: spine.resourceId,
      href: spine.href,
      anchorId:
        toc?.fragment !== undefined && toc.fragment.length > 0
          ? toc.fragment
          : "start",
      chapterProgress: 0.2,
      textQuote: null,
    },
    progressPercent: Math.round((chapter / CHAPTER_COUNT) * 100),
  }
}

async function readServerProgress(adminApi, bookId) {
  const result = await adminApi.get(`/api/v1/books/${bookId}/progress`)
  assert.equal(result.status, 200, `读取进度失败：HTTP ${result.status}`)
  return result.payload?.data ?? null
}

async function logServerState(adminApi, bookId, label) {
  if (process.env.E2E_TRACE_PROGRESS !== "1") {
    return
  }
  const progress = await readServerProgress(adminApi, bookId)
  console.log(
    `[trace:server] ${label} rev=${progress?.revision} spine=${progress?.locatorPayload?.spineIndex}`,
  )
}

async function seedProgress(adminApi, manifest, bookId, chapter) {
  const current = await readServerProgress(adminApi, bookId)
  const revision = Number(current?.revision ?? 0)
  const body = progressBody(manifest, chapter, revision)
  const result = await adminApi.put(`/api/v1/books/${bookId}/progress`, body)
  assert.equal(
    result.status,
    200,
    `进度 PUT 失败：HTTP ${result.status} ${JSON.stringify(result.payload)}`,
  )
  assert.equal(result.payload?.data?.locatorPayload?.spineIndex, body.locatorPayload.spineIndex)
  return result.payload.data
}

async function waitForServerChapter(
  adminApi,
  manifest,
  bookId,
  chapter,
  timeout = 10_000,
) {
  const expected = spineIndexFor(manifest, chapter)
  const deadline = Date.now() + timeout
  let latest = null
  while (Date.now() < deadline) {
    latest = await readServerProgress(adminApi, bookId)
    if (latest?.locatorPayload?.spineIndex === expected) {
      return latest
    }
    await sleep(100)
  }
  assert.fail(
    `等待服务器进度到第 ${chapter} 章超时；最后进度：${JSON.stringify(latest)}`,
  )
}

async function currentSpineIndex(page) {
  return page.evaluate(() => {
    const view = document.querySelector("[data-reader-epub] foliate-view")
    const contents = view?.renderer?.getContents?.() ?? []
    return contents[0]?.index ?? null
  })
}

async function waitForSpineIndex(page, expected, timeout = 15_000) {
  await page.waitForFunction(
    (target) => {
      const view = document.querySelector("[data-reader-epub] foliate-view")
      const contents = view?.renderer?.getContents?.() ?? []
      return contents[0]?.index === target
    },
    expected,
    { timeout },
  )
  return currentSpineIndex(page)
}

async function openReader(page, bookId, title) {
  await page.goto(url(`/read/${bookId}`), { waitUntil: "domcontentloaded" })
  await page
    .getByRole("heading", { level: 1, name: title })
    .waitFor({ timeout: 20_000 })
  await page
    .locator("[data-reader-surface] foliate-view")
    .waitFor({ timeout: 25_000 })
  await page
    .locator(".iread-reader-shell__position-text")
    .filter({ hasText: /位置 \d+%/ })
    .waitFor({ timeout: 20_000 })
}

async function navigateToChapter(
  page,
  chapter,
  { waitForPanel = true } = {},
) {
  await page.getByRole("button", { name: "目录与书签" }).click()
  const panel = page.locator('[data-reader-panel="toc"]')
  await panel.waitFor({ timeout: 10_000 })
  await panel
    .locator(".iread-reader-toc__item", { hasText: `第 ${chapter} 章` })
    .first()
    .click()
  if (waitForPanel) {
    await panel.waitFor({ state: "hidden", timeout: 10_000 })
  }
}

async function readLocalSnapshot(page, bookId) {
  return page.evaluate(
    ({ prefix, id }) => {
      const raw = window.localStorage.getItem(`${prefix}${id}`)
      return raw === null ? null : JSON.parse(raw)
    },
    { prefix: SNAPSHOT_STORAGE_PREFIX, id: bookId },
  )
}

async function readIndexedDbProgress(page, bookId) {
  return page.evaluate(async (id) => {
    const databases =
      typeof indexedDB.databases === "function"
        ? await indexedDB.databases()
        : []
    if (!databases.some((entry) => entry.name === "iread-progress-v1")) {
      return null
    }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("iread-progress-v1", 1)
      request.onupgradeneeded = () => {
        const opened = request.result
        if (!opened.objectStoreNames.contains("progressSnapshots")) {
          opened.createObjectStore("progressSnapshots", {
            keyPath: "bookId",
          })
        }
        if (!opened.objectStoreNames.contains("progressOutbox")) {
          opened.createObjectStore("progressOutbox", { keyPath: "bookId" })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const snapshot = await new Promise((resolve, reject) => {
        const tx = db.transaction("progressSnapshots", "readonly")
        const request = tx
          .objectStore("progressSnapshots")
          .get(id)
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => reject(request.error)
      })
      const outbox = await new Promise((resolve, reject) => {
        const tx = db.transaction("progressOutbox", "readonly")
        const request = tx.objectStore("progressOutbox").get(id)
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => reject(request.error)
      })
      return { snapshot, outbox }
    } finally {
      db.close()
    }
  }, bookId)
}

async function waitForIndexedDbChapter(page, manifest, bookId, chapter) {
  const expected = spineIndexFor(manifest, chapter)
  const deadline = Date.now() + 10_000
  let latest = null
  while (Date.now() < deadline) {
    const record = await readIndexedDbProgress(page, bookId)
    latest = record?.snapshot ?? null
    if (latest?.locatorPayload?.spineIndex === expected) {
      return latest
    }
    await sleep(100)
  }
  assert.fail(
    `等待 IndexedDB 快照到第 ${chapter} 章超时；最后快照：${JSON.stringify(latest)}`,
  )
}

function traceProgress(page, label) {
  if (process.env.E2E_TRACE_PROGRESS !== "1") {
    return
  }
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/progress")
    ) {
      let body = null
      try {
        body = JSON.parse(request.postData() ?? "null")
      } catch {
        body = null
      }
      console.log(
        `[trace:${label}] PUT base=${body?.baseRevision} spine=${body?.locatorPayload?.spineIndex} pct=${body?.progressPercent} id=${body?.clientMutationId}`,
      )
    }
  })
  page.on("response", (response) => {
    if (
      response.request().method() === "PUT" &&
      response.url().includes("/progress")
    ) {
      const status = response.status()
      if (status === 409 && process.env.E2E_TRACE_PROGRESS === "1") {
        void response
          .text()
          .then((text) => {
            console.log(
              `[trace:${label}] PUT response ${status} ${text.slice(0, 240)}`,
            )
          })
          .catch(() => {
            console.log(`[trace:${label}] PUT response ${status}`)
          })
        return
      }
      console.log(`[trace:${label}] PUT response ${status}`)
    }
  })
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

    logStep("生成并上传真实 EPUB")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const sample = makeEpub(stamp)
    const uploadId = await uploadEpub(
      adminApi,
      adminRequest,
      sample.file,
      `progress-unload-${stamp}.epub`,
    )
    const upload = await waitForUpload(adminApi, uploadId)
    assert.equal(upload.state, "stored", "上传应保存为 stored")
    const bookId = upload.bookId
    const task = await waitForTask(adminApi, upload.taskId)
    assert.equal(task.state, "succeeded")
    const book = await waitForReadyBook(adminApi, bookId)
    assert.equal(book.title, sample.title)

    const manifestResult = await adminApi.get(
      `/api/v1/books/${bookId}/manifest`,
    )
    assert.equal(manifestResult.status, 200)
    const manifest = manifestResult.payload?.data
    assert.equal(manifest.format, "epub")
    assert.equal(manifest.readingCapabilities.canRead, true)
    assert.ok(manifest.fileVersion.length === 64)

    logStep("真实 reload：位置变化后 <600ms 触发，keepalive 写入服务器")
    const seeded = await seedProgress(
      adminApi,
      manifest,
      bookId,
      START_CHAPTER,
    )
    const seededRevision = Number(seeded.revision)
    assert.ok(Number.isInteger(seededRevision))
    await logServerState(adminApi, bookId, "after-seed")

    const reloadContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(reloadContext)
    const reader = await reloadContext.newPage()
    traceProgress(reader, "reload")
    await openReader(reader, bookId, sample.title)
    await waitForSpineIndex(reader, spineIndexFor(manifest, START_CHAPTER))
    // 等初始恢复后的持久化 effect 落地，确保后续定位变化会登记给卸载路径。
    await sleep(250)
    await reader.screenshot({
      path: path.join(SCREENSHOT_DIR, "reload-before.png"),
    })

    const targetSpine = spineIndexFor(manifest, RELOAD_TARGET_CHAPTER)
    await navigateToChapter(reader, RELOAD_TARGET_CHAPTER, {
      waitForPanel: false,
    })
    await waitForSpineIndex(reader, targetSpine)
    const locatedAt = Date.now()
    await reader.reload({ waitUntil: "domcontentloaded" })
    const reloadGapMs = Date.now() - locatedAt
    assert.ok(
      reloadGapMs < THROTTLE_WINDOW_MS,
      `reload 距位置变化 ${reloadGapMs}ms，应小于 ${THROTTLE_WINDOW_MS}ms 节流窗口`,
    )

    await reader
      .getByRole("heading", { level: 1, name: sample.title })
      .waitFor({ timeout: 20_000 })
    await reader
      .locator("[data-reader-surface] foliate-view")
      .waitFor({ timeout: 25_000 })
    await waitForSpineIndex(reader, targetSpine, 20_000)
    const restoredAfterReload = await currentSpineIndex(reader)
    assert.equal(
      restoredAfterReload,
      targetSpine,
      "reload 后应从服务器/退出快照恢复新位置，而不是旧位置",
    )
    await reader.screenshot({
      path: path.join(SCREENSHOT_DIR, "reload-after.png"),
    })

    const afterReload = await waitForServerChapter(
      adminApi,
      manifest,
      bookId,
      RELOAD_TARGET_CHAPTER,
    )
    assert.ok(
      Number(afterReload.revision) > seededRevision,
      `keepalive 后服务器 revision 应增加：${seededRevision} → ${afterReload.revision}`,
    )
    assert.equal(
      afterReload.locatorPayload.spineIndex,
      targetSpine,
      "服务器应保存 reload 前的新位置",
    )
    await logServerState(adminApi, bookId, "after-reload")

    logStep("真实路由离开/返回：立即导航后保存并恢复")
    await reader.goto(url("/"), { waitUntil: "domcontentloaded" })
    const bookCard = reader.locator(`[data-book-card="${bookId}"]`)
    await bookCard.waitFor({ timeout: 20_000 })
    // 书籍详情页在上传后可能短暂显示 reader_not_available，直接从真实
    // /read 路由进入，避免依赖详情页入口的展示状态。
    await reader.goto(url(`/read/${bookId}`), {
      waitUntil: "domcontentloaded",
    })
    await reader
      .locator("[data-reader-surface] foliate-view")
      .waitFor({ timeout: 25_000 })
    await waitForSpineIndex(reader, targetSpine)
    await sleep(250)
    await logServerState(adminApi, bookId, "before-navigation")

    const navigationSpine = spineIndexFor(manifest, NAVIGATION_TARGET_CHAPTER)
    await navigateToChapter(reader, NAVIGATION_TARGET_CHAPTER, {
      waitForPanel: false,
    })
    await waitForSpineIndex(reader, navigationSpine)
    const navigationAt = Date.now()
    await reader.goto(url("/"), { waitUntil: "domcontentloaded" })
    await bookCard.waitFor({ timeout: 15_000 })
    const navigationGapMs = Date.now() - navigationAt
    assert.ok(
      navigationGapMs < 2_000,
      `离开阅读器的耗时 ${navigationGapMs}ms 过长，无法证明立即导航`,
    )
    await reader.goto(url(`/read/${bookId}`), {
      waitUntil: "domcontentloaded",
    })
    await waitForSpineIndex(reader, navigationSpine, 20_000)
    assert.equal(
      await currentSpineIndex(reader),
      navigationSpine,
      "导航离开/返回后应恢复离开前的位置",
    )
    const afterNavigation = await waitForServerChapter(
      adminApi,
      manifest,
      bookId,
      NAVIGATION_TARGET_CHAPTER,
    )
    assert.equal(
      afterNavigation.locatorPayload.spineIndex,
      navigationSpine,
      "导航离开时也应把位置写入服务器",
    )
    await logServerState(adminApi, bookId, "after-navigation")
    // 关闭旧页面，避免延迟重试影响后续 localStorage 用例的服务器状态。
    await reloadContext.close()

    logStep("localStorage 较新、IndexedDB 较旧：恢复选择 localStorage")
    const localOnlySeed = await seedProgress(
      adminApi,
      manifest,
      bookId,
      LOCAL_ONLY_START_CHAPTER,
    )
    const localOnlySeedRevision = Number(localOnlySeed.revision)
    await logServerState(adminApi, bookId, "after-local-seed")
    const localContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(localContext)
    // Playwright 的 page.route 抓不到 unload 期间的 keepalive PUT；
    // 在页面内按方法拦截 fetch，确保本用例只有 localStorage 能保存新位置。
    await localContext.addInitScript(() => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const request =
          typeof Request !== "undefined" && input instanceof Request
            ? input
            : null
        const requestUrl =
          request !== null
            ? request.url
            : typeof input === "string"
              ? input
              : String(input)
        const method = (
          init?.method ?? request?.method ?? "GET"
        ).toUpperCase()
        if (method === "PUT" && requestUrl.includes("/progress")) {
          const key = "e2e.blocked-progress-put"
          const count = Number(window.localStorage.getItem(key) ?? "0")
          window.localStorage.setItem(key, String(count + 1))
          return Promise.reject(new TypeError("blocked by e2e"))
        }
        return originalFetch(input, init)
      }
    })
    const localPage = await localContext.newPage()
    traceProgress(localPage, "local-only")
    await openReader(localPage, bookId, sample.title)
    const localStartSpine = spineIndexFor(
      manifest,
      LOCAL_ONLY_START_CHAPTER,
    )
    await waitForSpineIndex(localPage, localStartSpine)
    await waitForIndexedDbChapter(
      localPage,
      manifest,
      bookId,
      LOCAL_ONLY_START_CHAPTER,
    )
    await sleep(250)
    await localPage.evaluate(() => {
      window.localStorage.removeItem("e2e.blocked-progress-put")
    })

    const localTargetSpine = spineIndexFor(
      manifest,
      LOCAL_ONLY_TARGET_CHAPTER,
    )
    await navigateToChapter(localPage, LOCAL_ONLY_TARGET_CHAPTER, {
      waitForPanel: false,
    })
    await waitForSpineIndex(localPage, localTargetSpine)
    const localLocatedAt = Date.now()
    const staleIndexedDb = await readIndexedDbProgress(localPage, bookId)
    assert.equal(
      staleIndexedDb?.snapshot?.locatorPayload?.spineIndex,
      localStartSpine,
      "reload 前 IndexedDB 应仍是旧位置（节流窗口内未写入）",
    )
    await localPage.reload({ waitUntil: "domcontentloaded" })
    const localReloadGapMs = Date.now() - localLocatedAt
    assert.ok(
      localReloadGapMs < THROTTLE_WINDOW_MS,
      `reload 距位置变化 ${localReloadGapMs}ms，应小于 ${THROTTLE_WINDOW_MS}ms`,
    )

    await localPage
      .getByRole("heading", { level: 1, name: sample.title })
      .waitFor({ timeout: 20_000 })
    await localPage
      .locator("[data-reader-surface] foliate-view")
      .waitFor({ timeout: 25_000 })
    await waitForSpineIndex(localPage, localTargetSpine, 20_000)
    assert.equal(
      await currentSpineIndex(localPage),
      localTargetSpine,
      "IndexedDB 有旧记录时，恢复应选择更新的 localStorage 退出快照",
    )
    const exitSnapshot = await readLocalSnapshot(localPage, bookId)
    assert.equal(
      exitSnapshot?.locatorPayload?.spineIndex,
      localTargetSpine,
      "localStorage 退出快照应保存新位置",
    )
    assert.ok(
      Date.parse(exitSnapshot.savedAt) >
        Date.parse(staleIndexedDb.snapshot.savedAt),
      "localStorage 退出快照的 savedAt 应比旧 IndexedDB 快照更新",
    )
    assert.ok(
      Number(
        await localPage.evaluate(() =>
          window.localStorage.getItem("e2e.blocked-progress-put"),
        ),
      ) > 0,
      "该用例应至少拦截一次卸载 PUT，确保服务器没有新位置",
    )
    await sleep(600)
    const afterLocalOnly = await readServerProgress(adminApi, bookId)
    assert.equal(
      afterLocalOnly?.locatorPayload?.spineIndex,
      localStartSpine,
      "PUT 被拦截时服务器应保持旧位置，恢复只能来自 localStorage",
    )
    assert.equal(
      Number(afterLocalOnly?.revision),
      localOnlySeedRevision,
      "PUT 被拦截时服务器 revision 不应变化",
    )
    await localPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "local-only-restore.png"),
    })

    console.log("\n[E2E] 真实卸载/重载进度恢复通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const apiContext of apiContexts) {
      await apiContext.dispose().catch(() => {})
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
