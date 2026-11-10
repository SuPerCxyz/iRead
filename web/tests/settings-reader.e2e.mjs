#!/usr/bin/env node

/**
 * 设置页“阅读默认”真实服务 E2E。
 *
 * 临时 IREAD_BOOKS_DIR/DB_DIR/CACHE_DIR 启动真实 Go 服务与生产构建，覆盖：
 * GET 全局默认、EPUB/PDF/漫画字段矩阵、显式 PUT + baseRevision CAS、
 * 409 当前记录与两种恢复、恢复内置默认、对比度加载/保存拦截、移动端格式切换。
 */

import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
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

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const SERVER_ROOT = path.resolve(WEB_ROOT, "../server")
const WEB_DIST = path.join(WEB_ROOT, "dist")
const PREFERRED_PORT = Number(process.env.IREAD_SETTINGS_E2E_PORT ?? "18093")
const CHROME_PATH = process.env.CHROME_PATH || undefined
const SETTINGS_PATH = "/api/v1/settings/reader"

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function portFree(port) {
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
  for (let port = start; port < start + 100; port += 1) {
    if (await portFree(port)) {
      return port
    }
  }
  throw new Error("找不到空闲端口")
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // 继续等待。
    }
    await sleep(200)
  }
  throw new Error(`等待 ${url} 超时`)
}

function startServer(binary, env) {
  const child = spawn(binary, [], {
    env,
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
  child.outputText = () => output
  return child
}

async function stopServer(child) {
  if (child === undefined || child.exitCode !== null) {
    return
  }
  child.kill("SIGTERM")
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && child.exitCode === null) {
    await sleep(100)
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL")
  }
}

async function waitForStatus(page, text, timeout = 10000) {
  await page
    .getByTestId("reader-defaults-status")
    .filter({ hasText: text })
    .waitFor({ timeout })
}

async function fieldLabels(format) {
  return page
    .locator(`[data-reader-format="${format}"] label`)
    .allInnerTexts()
}

async function assertSources(format, source) {
  const badges = page.locator(
    `[data-reader-format="${format}"] [data-source]`,
  )
  const count = await badges.count()
  assert.ok(count > 0, `${format} 应渲染来源标记`)
  for (let index = 0; index < count; index += 1) {
    assert.equal(await badges.nth(index).getAttribute("data-source"), source)
  }
}

async function openSettings(page, baseUrl) {
  await page.goto(`${baseUrl}/settings?group=reading`, {
    waitUntil: "domcontentloaded",
  })
  await page.getByTestId("reader-defaults").waitFor({ timeout: 10000 })
}

const browserPromise = chromium.launch({
  headless: true,
  executablePath: CHROME_PATH,
  args: ["--no-sandbox"],
})

let page = null

async function main() {
  const browser = await browserPromise
  const tempRoot = mkdtempSync(
    path.join(tmpdir(), "iread-settings-reader-e2e-"),
  )
  const dirs = {
    books: path.join(tempRoot, "books"),
    db: path.join(tempRoot, "db"),
    cache: path.join(tempRoot, "cache"),
  }
  for (const directory of Object.values(dirs)) {
    mkdirSync(directory, { recursive: true })
  }

  const binary = path.join(tempRoot, "iread-e2e")
  let server
  const contexts = []
  const apiContexts = []

  try {
    logStep("构建并启动真实 Go 服务（临时图书/数据库/缓存目录）")
    execFileSync("go", ["build", "-o", binary, "./cmd/iread"], {
      cwd: SERVER_ROOT,
      env: { ...process.env, GOFLAGS: "-buildvcs=false" },
      stdio: "inherit",
    })
    if (
      !readFileSync(path.join(WEB_DIST, "index.html"), "utf8").includes("iRead")
    ) {
      throw new E2EBlocked("web/dist 不是最新构建，请先执行 pnpm build。")
    }

    const port = await findFreePort(PREFERRED_PORT)
    const baseUrl = `http://127.0.0.1:${port}`
    server = startServer(binary, {
      ...process.env,
      IREAD_ADDR: `127.0.0.1:${port}`,
      IREAD_BOOKS_DIR: dirs.books,
      IREAD_DB_DIR: dirs.db,
      IREAD_CACHE_DIR: dirs.cache,
      IREAD_WEB_DIR: WEB_DIST,
      IREAD_PUBLIC_ORIGIN: baseUrl,
      IREAD_LOG_LEVEL: "error",
      IREAD_LOG_FORMAT: "text",
    })
    try {
      await waitForHttp(`${baseUrl}/healthz`, 20000)
    } catch (error) {
      throw new E2EBlocked(
        `服务未就绪：${error.message}\n${server.outputText()}`,
      )
    }

    const probe = await playwrightRequest.newContext({ baseURL: baseUrl })
    apiContexts.push(probe)
    const probeApi = new AuthedApi(probe, baseUrl)
    await ensureAdmin(probeApi, baseUrl)

    const initial = await probeApi.get(SETTINGS_PATH)
    assert.equal(initial.status, 200)
    assert.equal(initial.payload?.data?.revision, "0")
    assert.deepEqual(initial.payload?.data?.value, {})

    const storageState = await createAuthenticatedStorageState(
      browser,
      baseUrl,
      E2E_PASSWORD,
    )
    const apiContext = await playwrightRequest.newContext({
      baseURL: baseUrl,
      storageState,
    })
    apiContexts.push(apiContext)
    const api = new AuthedApi(apiContext, baseUrl)
    await api.fetchStatus()

    const readerWrites = []
    const bookWrites = []

    logStep("登录并进入设置页“阅读默认”")
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(context)
    page = await context.newPage()
    page.on("pageerror", (error) => {
      console.error("[E2E][pageerror]", error)
    })
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (request.method() === "PUT" && pathname === SETTINGS_PATH) {
        readerWrites.push(request.postDataJSON())
      }
      if (
        pathname.includes("/reader-overrides") ||
        pathname.includes("/reader-settings")
      ) {
        bookWrites.push(pathname)
      }
    })
    await openSettings(page, baseUrl)
    await page
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 0" })
      .waitFor({ timeout: 10000 })
    await page.getByText("从未保存", { exact: false }).first().waitFor()

    logStep("EPUB 默认字段、单位/范围与 built-in 来源")
    const epubLabels = await fieldLabels("epub")
    assert.equal(epubLabels.length, 20)
    for (const label of [
      "阅读主题",
      "允许出版方字体",
      "字体",
      "字号",
      "字重",
      "行高",
      "段间距",
      "首行缩进",
      "对齐",
      "左右页边距",
      "上下页边距",
      "正文最大宽度",
      "翻页方式",
      "栏数",
      "翻页动画",
      "正文背景",
      "正文文字",
      "正文链接",
      "选区背景",
      "出版方 CSS",
    ]) {
      assert.ok(epubLabels.includes(label), `EPUB 缺少字段：${label}`)
    }
    assert.ok(
      await page
        .locator('[data-setting-path="reflow.fontSize"]')
        .getByText("范围 12–48px，步长 1px")
        .isVisible(),
    )
    await assertSources("epub", "built-in")

    logStep("PDF/漫画字段矩阵不混入文字字段")
    await page.getByRole("tab", { name: "PDF", exact: true }).click()
    await page
      .locator('[data-reader-format="pdf"]')
      .waitFor({ state: "visible" })
    const pdfLabels = await fieldLabels("pdf")
    assert.equal(pdfLabels.length, 6)
    assert.deepEqual(
      [...pdfLabels].sort(),
      ["页面布局", "缩放模式", "手动缩放", "页距", "显示 PDF 工具栏", "纸张外背景"].sort(),
    )
    assert.ok(!pdfLabels.includes("字号"), "PDF 不应出现文字字段")
    assert.ok(!pdfLabels.includes("行高"), "PDF 不应出现文字字段")
    await assertSources("pdf", "built-in")

    const manualScale = page.getByRole("slider", { name: "手动缩放" })
    assert.equal(
      await manualScale.getAttribute("aria-valuenow"),
      "100",
      "手动缩放默认必须显示 100%",
    )
    assert.equal(await manualScale.getAttribute("aria-valuemin"), "25")
    assert.equal(await manualScale.getAttribute("aria-valuemax"), "400")
    assert.equal(
      await page
        .locator('[data-setting-path="pdf.manualScale"] .iread-reader-settings__value')
        .innerText(),
      "100%",
    )
    assert.ok(
      await page
        .locator('[data-setting-path="pdf.manualScale"]')
        .getByText("范围 25–400%，步长 5%")
        .isVisible(),
    )
    assert.ok(
      !(await page.locator('[data-setting-path="pdf.manualScale"]').innerText()).includes(
        "10000",
      ),
      "手动缩放不得把存储默认值 1 当成 1% 再乘 100",
    )

    await page.getByRole("tab", { name: "漫画", exact: true }).click()
    await page
      .locator('[data-reader-format="comic"]')
      .waitFor({ state: "visible" })
    const comicLabels = await fieldLabels("comic")
    assert.equal(comicLabels.length, 5)
    assert.deepEqual(
      [...comicLabels].sort(),
      ["阅读方向", "显示模式", "适应方式", "页距", "页面外背景"].sort(),
    )
    assert.ok(!comicLabels.includes("字号"), "漫画不应出现文字字段")
    await assertSources("comic", "built-in")

    logStep("显式保存 EPUB 字段并推进 revision")
    await page.getByRole("tab", { name: "EPUB", exact: true }).click()
    await page
      .locator('[data-reader-format="epub"]')
      .waitFor({ state: "visible" })
    await page.getByRole("slider", { name: "字号" }).press("ArrowRight")
    await waitForStatus(page, "有未保存的更改")
    assert.equal(readerWrites.length, 0, "编辑不应自动保存")
    await page.getByRole("button", { name: "保存为全局默认" }).click()
    await waitForStatus(page, "已保存为全局默认（版本 1）")
    const saved1 = await api.get(SETTINGS_PATH)
    assert.equal(saved1.status, 200)
    assert.equal(saved1.payload?.data?.revision, "1")
    assert.equal(saved1.payload?.data?.value?.reflow?.fontSize, 17)
    assert.equal(readerWrites.length, 1)
    assert.equal(readerWrites[0].baseRevision, "0")
    assert.equal(
      await page
        .locator('[data-setting-path="reflow.fontSize"] [data-source]')
        .getAttribute("data-source"),
      "global",
    )

    logStep("409 冲突显示当前记录并可载入服务器")
    const external1 = await api.put(SETTINGS_PATH, {
      schemaVersion: 1,
      baseRevision: "1",
      value: { reflow: { fontSize: 18 } },
    })
    assert.equal(external1.status, 200)
    assert.equal(external1.payload?.data?.revision, "2")
    await page.getByRole("slider", { name: "行高" }).press("ArrowRight")
    await page.getByRole("button", { name: "保存为全局默认" }).click()
    const conflict = page.getByTestId("reader-defaults-conflict")
    await conflict.waitFor({ timeout: 10000 })
    const conflictText = await conflict.innerText()
    assert.match(conflictText, /服务器当前版本 2/)
    assert.match(conflictText, /字号：18px/)
    await conflict
      .getByRole("button", { name: "载入服务器设置", exact: true })
      .click()
    await page
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 2" })
      .waitFor({ timeout: 10000 })
    await waitForStatus(page, "已载入服务器当前全局默认（版本 2）")
    assert.equal(
      await page
        .locator('[data-setting-path="reflow.fontSize"] .iread-reader-settings__value')
        .innerText(),
      "18px",
    )
    assert.equal(await page.getByTestId("reader-defaults-conflict").count(), 0)

    logStep("再次 409：保留本机并使用冲突 revision 重试")
    const external2 = await api.put(SETTINGS_PATH, {
      schemaVersion: 1,
      baseRevision: "2",
      value: { reflow: { fontSize: 19 } },
    })
    assert.equal(external2.status, 200)
    assert.equal(external2.payload?.data?.revision, "3")
    await page.getByRole("slider", { name: "字号" }).press("ArrowRight")
    await page.getByRole("slider", { name: "字号" }).press("ArrowRight")
    await page.getByRole("button", { name: "保存为全局默认" }).click()
    await page.getByTestId("reader-defaults-conflict").waitFor({
      timeout: 10000,
    })
    assert.match(
      await page.getByTestId("reader-defaults-conflict").innerText(),
      /服务器当前版本 3/,
    )
    const writesBeforeRetry = readerWrites.length
    await page
      .getByRole("button", { name: "保留本机并重试", exact: true })
      .click()
    await waitForStatus(page, "已保存为全局默认（版本 4）")
    assert.equal(readerWrites.length, writesBeforeRetry + 1)
    assert.equal(readerWrites[readerWrites.length - 1].baseRevision, "3")
    assert.equal(
      readerWrites[readerWrites.length - 1].value?.reflow?.fontSize,
      20,
    )
    const saved2 = await api.get(SETTINGS_PATH)
    assert.equal(saved2.payload?.data?.revision, "4")
    assert.equal(saved2.payload?.data?.value?.reflow?.fontSize, 20)

    logStep("恢复内置默认：先改草稿，再显式保存空 value")
    const writesBeforeReset = readerWrites.length
    await page.getByRole("button", { name: "恢复内置默认" }).click()
    await waitForStatus(page, "已恢复内置默认")
    assert.equal(readerWrites.length, writesBeforeReset, "恢复默认不应自动保存")
    await page.getByRole("button", { name: "保存为全局默认" }).click()
    await waitForStatus(page, "已保存为全局默认（版本 5）")
    const reset = await api.get(SETTINGS_PATH)
    assert.equal(reset.payload?.data?.revision, "5")
    assert.deepEqual(reset.payload?.data?.value, {})
    await assertSources("epub", "built-in")

    logStep("低对比度：加载即提示，保存被拒绝，修正后可保存")
    // 服务端同样校验对比度，正常记录不会低对比度；这里拦截 GET 模拟历史遗留记录，
    // 验证前端在加载层也能识别并阻止保存。
    await page.route("**/api/v1/settings/reader", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            schemaVersion: 1,
            revision: "6",
            updatedAt: new Date().toISOString(),
            value: {
              reflow: { background: "#ffffff", text: "#ffffff" },
            },
          },
        }),
      })
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByTestId("reader-defaults").waitFor({ timeout: 10000 })
    await page
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 6" })
      .waitFor({ timeout: 10000 })
    await page.getByTestId("reader-defaults-contrast").waitFor({
      timeout: 10000,
    })
    assert.match(
      await page.getByTestId("reader-defaults-contrast").innerText(),
      /对比度不足 4.5:1/,
    )
    await page.getByRole("slider", { name: "字号" }).press("ArrowRight")
    assert.equal(
      await page.getByRole("button", { name: "保存为全局默认" }).isDisabled(),
      true,
      "低对比度时保存必须被拒绝",
    )
    assert.ok(
      await page
        .locator('[data-setting-path="reflow.text"]')
        .getByText(/对比度不足/)
        .isVisible(),
      "对比度错误应显示在相关字段附近",
    )

    await page.unroute("**/api/v1/settings/reader")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByTestId("reader-defaults").waitFor({ timeout: 10000 })
    await page
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 5" })
      .waitFor({ timeout: 10000 })

    logStep("编辑出低对比度：前端阻止保存，修正后写入 revision 6")
    await page.getByRole("slider", { name: "字号" }).press("ArrowRight")
    await page
      .getByRole("textbox", { name: "正文背景自定义颜色", exact: true })
      .fill("#ffffff")
    await page
      .getByRole("textbox", { name: "正文文字自定义颜色", exact: true })
      .fill("#ffffff")
    await page.getByTestId("reader-defaults-contrast").waitFor({
      timeout: 10000,
    })
    assert.equal(
      await page.getByRole("button", { name: "保存为全局默认" }).isDisabled(),
      true,
      "编辑出低对比度时保存必须被拒绝",
    )
    await page
      .getByRole("textbox", { name: "正文文字自定义颜色", exact: true })
      .fill("#000000")
    await page.getByTestId("reader-defaults-contrast").waitFor({
      state: "detached",
      timeout: 10000,
    })
    const saveAfterFix = page.getByRole("button", { name: "保存为全局默认" })
    await saveAfterFix.waitFor({ state: "visible" })
    assert.equal(await saveAfterFix.isDisabled(), false)
    await saveAfterFix.click()
    await waitForStatus(page, "已保存为全局默认（版本 6）")
    const fixed = await api.get(SETTINGS_PATH)
    assert.equal(fixed.payload?.data?.revision, "6")
    assert.equal(fixed.payload?.data?.value?.reflow?.background, "#ffffff")
    assert.equal(fixed.payload?.data?.value?.reflow?.text, "#000000")
    assert.equal(fixed.payload?.data?.value?.reflow?.fontSize, 17)

    assert.deepEqual(
      bookWrites,
      [],
      "阅读默认页不得写入单书 reader-settings/reader-overrides",
    )

    logStep("移动 390x844：Select 切换格式、无横向溢出")
    const mobileContext = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
      isMobile: true,
      hasTouch: true,
    })
    contexts.push(mobileContext)
    const mobile = await mobileContext.newPage()
    mobile.on("pageerror", (error) => {
      console.error("[E2E][mobile pageerror]", error)
    })
    await openSettings(mobile, baseUrl)
    await mobile
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 6" })
      .waitFor({ timeout: 10000 })
    assert.equal(
      await mobile.getByRole("tablist", { name: "阅读格式" }).isVisible(),
      false,
      "移动端不应显示格式 Tabs",
    )
    const formatSelect = mobile.getByRole("combobox", { name: "阅读格式" })
    assert.equal(await formatSelect.isVisible(), true)
    await formatSelect.click()
    await mobile.getByRole("option", { name: "PDF", exact: true }).click()
    await mobile
      .locator('[data-reader-format="pdf"]')
      .waitFor({ state: "visible" })
    assert.equal(await fieldLabelsMobile(mobile, "pdf"), 6)
    await formatSelect.click()
    await mobile.getByRole("option", { name: "漫画", exact: true }).click()
    await mobile
      .locator('[data-reader-format="comic"]')
      .waitFor({ state: "visible" })
    assert.equal(await fieldLabelsMobile(mobile, "comic"), 5)
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    assert.ok(overflow <= 1, `移动端横向溢出 ${overflow}px`)
    const buttons = mobile.locator(
      '[data-testid="reader-defaults"] [data-slot="button"]:visible',
    )
    const buttonCount = await buttons.count()
    assert.ok(buttonCount >= 2, `移动端保存/恢复按钮应可见，实际 ${buttonCount}`)
    for (let index = 0; index < buttonCount; index += 1) {
      const box = await buttons.nth(index).boundingBox()
      assert.ok(box !== null && box.width > 0, "按钮必须有可点击区域")
    }

    logStep("PDF 手动缩放：150% 保存/重开，改回 100% 后无未保存")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByTestId("reader-defaults").waitFor({ timeout: 10000 })
    await page
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 6" })
      .waitFor({ timeout: 10000 })
    await page.getByRole("tab", { name: "PDF", exact: true }).click()
    await page
      .locator('[data-reader-format="pdf"]')
      .waitFor({ state: "visible" })
    const pdfScale = page.getByRole("slider", { name: "手动缩放" })
    for (let index = 0; index < 10; index += 1) {
      await pdfScale.press("ArrowRight")
    }
    assert.equal(await pdfScale.getAttribute("aria-valuenow"), "150")
    assert.equal(
      await page
        .locator('[data-setting-path="pdf.manualScale"] .iread-reader-settings__value')
        .innerText(),
      "150%",
    )
    await waitForStatus(page, "有未保存的更改")
    const pdfSave = page.getByRole("button", { name: "保存为全局默认" })
    assert.equal(await pdfSave.isDisabled(), false)
    await pdfSave.click()
    await waitForStatus(page, "已保存为全局默认（版本 7）")
    const pdfSaved = await api.get(SETTINGS_PATH)
    assert.equal(pdfSaved.status, 200)
    assert.equal(pdfSaved.payload?.data?.value?.pdf?.manualScale, 1.5)

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByTestId("reader-defaults").waitFor({ timeout: 10000 })
    await page
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 7" })
      .waitFor({ timeout: 10000 })
    await page.getByRole("tab", { name: "PDF", exact: true }).click()
    await page
      .locator('[data-reader-format="pdf"]')
      .waitFor({ state: "visible" })
    assert.equal(
      await page.getByRole("slider", { name: "手动缩放" }).getAttribute(
        "aria-valuenow",
      ),
      "150",
      "重开后应保留已保存的 150%",
    )
    assert.equal(
      await page
        .locator('[data-setting-path="pdf.manualScale"] [data-source]')
        .getAttribute("data-source"),
      "global",
    )
    for (let index = 0; index < 10; index += 1) {
      await page
        .getByRole("slider", { name: "手动缩放" })
        .press("ArrowLeft")
    }
    assert.equal(
      await page.getByRole("slider", { name: "手动缩放" }).getAttribute(
        "aria-valuenow",
      ),
      "100",
    )
    await waitForStatus(page, "有未保存的更改")
    await page.getByRole("button", { name: "保存为全局默认" }).click()
    await waitForStatus(page, "已保存为全局默认（版本 8）")
    const pdfReset = await api.get(SETTINGS_PATH)
    assert.equal(pdfReset.payload?.data?.value?.pdf?.manualScale, 1)

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByTestId("reader-defaults").waitFor({ timeout: 10000 })
    await page
      .getByTestId("reader-defaults-record")
      .filter({ hasText: "版本 8" })
      .waitFor({ timeout: 10000 })
    await page.getByRole("tab", { name: "PDF", exact: true }).click()
    await page
      .locator('[data-reader-format="pdf"]')
      .waitFor({ state: "visible" })
    const pdfScaleRestored = page.getByRole("slider", { name: "手动缩放" })
    assert.equal(await pdfScaleRestored.getAttribute("aria-valuenow"), "100")
    assert.equal(
      await page
        .locator('[data-setting-path="pdf.manualScale"] .iread-reader-settings__value')
        .innerText(),
      "100%",
    )

    await pdfScaleRestored.press("ArrowRight")
    assert.equal(await pdfScaleRestored.getAttribute("aria-valuenow"), "105")
    await waitForStatus(page, "有未保存的更改")
    await pdfScaleRestored.press("ArrowLeft")
    assert.equal(await pdfScaleRestored.getAttribute("aria-valuenow"), "100")
    assert.equal(
      (await page.getByTestId("reader-defaults-status").innerText()).trim(),
      "没有未保存的更改；保存按钮已禁用。",
      "改回当前保存值后不应继续显示未保存",
    )
    assert.equal(
      await page
        .locator('[data-setting-path="pdf.manualScale"] [data-pending="true"]')
        .count(),
      0,
      "改回当前保存值后不应保留未保存标记",
    )
    assert.equal(
      await page.getByRole("button", { name: "保存为全局默认" }).isDisabled(),
      true,
      "改回当前保存值后保存按钮必须禁用",
    )
    assert.equal(
      await page
        .locator(".iread-reader-defaults__note")
        .filter({ hasText: "服务器仍保留版本" })
        .count(),
      0,
      "改回当前保存值后不应提示服务器仍有未保存更改",
    )

    logStep("通过")
    console.log(
      "[E2E] 设置页阅读默认全部断言通过：默认加载 / 格式矩阵 / CAS / 409 / 恢复 / 对比度 / 移动",
    )
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const apiContext of apiContexts) {
      await apiContext.dispose().catch(() => {})
    }
    await stopServer(server)
    await browser.close().catch(() => {})
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function fieldLabelsMobile(mobile, format) {
  const labels = await mobile
    .locator(`[data-reader-format="${format}"] label`)
    .allInnerTexts()
  return labels.length
}

main().catch(async (error) => {
  const browser = await browserPromise.catch(() => null)
  if (browser !== null) {
    await browser.close().catch(() => {})
  }
  console.error(error)
  process.exit(1)
})
