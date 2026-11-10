#!/usr/bin/env node

// 开发模式无密码认证浏览器验收：使用 web/dist 与 mock 认证 API，不启动后端。
// 覆盖 devNoAuth=true 时跳过登录/安装令牌、显示开发模式标识且 401 不回落登录页；
// 同时回归 devNoAuth=false 的登录/退出流程。

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url))
const DIST_DIR = path.join(WEB_DIR, "dist")
const DEV_CSRF_TOKEN = "dev-no-auth"
const AUTH_CSRF_TOKEN = "auth-csrf"
const DEV_MARKER = "开发模式 · 无密码"

const APPEARANCE_VALUE = {
  themeMode: "system",
  lightPreset: "template",
  darkPreset: "template",
  accent: "default",
  density: "standard",
  contentWidth: "auto",
  navCompact: false,
}

const LIBRARY_VIEW = {
  viewMode: "grid",
  density: "standard",
  columns: "auto",
  showAuthors: true,
  showProgress: true,
  showFormat: true,
  showSubtitle: false,
  coverRatio: "original",
  coverRadius: "md",
  cardGap: "standard",
}

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("无法分配临时端口。"))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, child, timeout = 30000) {
  const deadline = Date.now() + timeout
  let output = ""
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString()
  })
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`vite preview 提前退出：\n${output}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) {
        return
      }
    } catch {
      // 继续等待预览服务。
    }
    await sleep(150)
  }
  throw new Error(`等待 vite preview 超时：\n${output}`)
}

function statusPayload(state) {
  return {
    data: {
      initialized: state.initialized,
      authenticated: state.authenticated,
      csrfToken: state.csrfToken,
      csrfExpiresAt: null,
      setupTokenRequired: state.setupTokenRequired,
      devNoAuth: state.devNoAuth,
    },
  }
}

function authResultPayload(state, devNoAuth) {
  return {
    data: {
      initialized: true,
      authenticated: true,
      csrfToken: state.csrfToken,
      csrfExpiresAt: null,
      setupTokenRequired: false,
      devNoAuth,
    },
  }
}

function errorPayload(code, message) {
  return {
    error: {
      code,
      message,
      requestId: "auth-dev-no-auth-e2e",
      details: {},
    },
  }
}

function appearanceRecord() {
  return {
    schemaVersion: 1,
    revision: "1",
    updatedAt: null,
    value: APPEARANCE_VALUE,
  }
}

function libraryRecord() {
  return {
    schemaVersion: 1,
    revision: "1",
    updatedAt: null,
    value: LIBRARY_VIEW,
  }
}

async function mockApi(page, state) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify(errorPayload("not_found", "未 mock 的接口")),
    })
  })

  await page.route("**/api/v1/auth/status", async (route) => {
    state.statusRequests += 1
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusPayload(state)),
    })
  })

  await page.route("**/api/v1/auth/login", async (route) => {
    state.loginRequests += 1
    const body = JSON.parse(route.request().postData() ?? "{}")
    if (body.password !== "iread-e2e-password") {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify(
          errorPayload("invalid_credentials", "密码不正确。"),
        ),
      })
      return
    }
    state.authenticated = true
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(authResultPayload(state, false)),
    })
  })

  await page.route("**/api/v1/auth/logout", async (route) => {
    state.logoutRequests += 1
    state.authenticated = false
    await route.fulfill({ status: 204 })
  })

  await page.route("**/api/v1/auth/setup", async (route) => {
    state.setupRequests += 1
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify(
        errorPayload("already_initialized", "管理员已初始化。"),
      ),
    })
  })

  await page.route("**/api/v1/books*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        meta: { total: 0, nextCursor: null },
      }),
    })
  })

  await page.route("**/api/v1/settings/appearance", async (route) => {
    if (state.appearanceUnauthorized) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify(
          errorPayload("unauthenticated", "登录状态已失效，请重新登录。"),
        ),
      })
      return
    }
    const record = appearanceRecord()
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: record }),
    })
  })

  await page.route("**/api/v1/settings/library", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: libraryRecord() }),
    })
  })
}

function newState(overrides = {}) {
  return {
    devNoAuth: false,
    initialized: true,
    authenticated: false,
    setupTokenRequired: false,
    csrfToken: AUTH_CSRF_TOKEN,
    statusRequests: 0,
    loginRequests: 0,
    logoutRequests: 0,
    setupRequests: 0,
    appearanceUnauthorized: false,
    ...overrides,
  }
}

async function openPage(browser, baseUrl, state, pathname = "/") {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    serviceWorkers: "block",
  })
  const page = await context.newPage()
  await mockApi(page, state)
  await page.goto(`${baseUrl}${pathname}`, {
    waitUntil: "domcontentloaded",
  })
  return { context, page }
}

async function assertNoAuthUi(page) {
  assert.equal(
    await page.getByRole("heading", { level: 1, name: "登录 iRead" }).count(),
    0,
    "开发模式不得显示登录页",
  )
  assert.equal(
    await page
      .getByRole("heading", { level: 1, name: "初始化 iRead" })
      .count(),
    0,
    "开发模式不得显示初始化页",
  )
  assert.equal(
    await page.getByLabel("密码", { exact: true }).count(),
    0,
    "开发模式不得显示密码输入",
  )
  assert.equal(
    await page.getByLabel("安装令牌", { exact: true }).count(),
    0,
    "开发模式不得显示安装令牌输入",
  )
  assert.equal(
    await page.getByText("管理员", { exact: true }).count(),
    0,
    "开发模式不得伪装成已登录管理员",
  )
  assert.equal(
    await page.getByRole("button", { name: "退出登录" }).count(),
    0,
    "开发模式不得提供假的退出登录",
  )
}

async function main() {
  if (!existsSync(path.join(DIST_DIR, "index.html"))) {
    throw new Error("web/dist 不存在，请先运行 pnpm build。")
  }

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const preview = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: WEB_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let browser = null
  const contexts = []
  try {
    await waitForServer(baseUrl, preview)
    browser = await chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        process.env.CHROME_PATH ||
        undefined,
    })

    logStep("devNoAuth=true：首页、上传、书库、设置均跳过登录与安装令牌")
    const devState = newState({
      devNoAuth: true,
      // 即使后端返回安装令牌要求，开发模式也不得显示令牌输入。
      setupTokenRequired: true,
      authenticated: true,
      csrfToken: DEV_CSRF_TOKEN,
    })
    const dev = await openPage(browser, baseUrl, devState, "/")
    contexts.push(dev.context)
    await dev.page
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor({ timeout: 15000 })
    await assertNoAuthUi(dev.page)
    await dev.page
      .locator(".iread-sidebar-admin")
      .getByText(DEV_MARKER, { exact: true })
      .waitFor()
    await dev.page
      .locator(".iread-topbar")
      .getByText(DEV_MARKER, { exact: true })
      .waitFor()

    // 开发模式仍允许打开上传入口，不因缺少登录会话被拦截。
    await dev.page.locator(".iread-topbar__upload").click()
    await dev.page
      .getByRole("heading", { name: "上传图书", exact: true })
      .waitFor({ timeout: 10000 })
    await dev.page.keyboard.press("Escape")
    await dev.page
      .getByRole("heading", { name: "上传图书", exact: true })
      .waitFor({ state: "hidden", timeout: 10000 })

    await dev.page.goto(`${baseUrl}/library`, {
      waitUntil: "domcontentloaded",
    })
    await dev.page
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor({ timeout: 15000 })
    await assertNoAuthUi(dev.page)
    await dev.page
      .getByText(DEV_MARKER, { exact: true })
      .first()
      .waitFor()

    await dev.page.goto(`${baseUrl}/settings`, {
      waitUntil: "domcontentloaded",
    })
    await dev.page
      .getByRole("heading", { level: 1, name: "设置" })
      .waitFor({ timeout: 15000 })
    await assertNoAuthUi(dev.page)
    await dev.page
      .getByText(DEV_MARKER, { exact: true })
      .first()
      .waitFor()

    assert.equal(devState.loginRequests, 0, "开发模式不得调用登录接口")
    assert.equal(devState.logoutRequests, 0, "开发模式不得调用退出接口")
    assert.equal(devState.setupRequests, 0, "开发模式不得调用初始化接口")
    assert.ok(devState.statusRequests > 0, "开发模式仍应读取认证状态")
    console.log("[E2E] 开发模式三页与上传入口跳过认证界面通过")

    logStep("devNoAuth=true：设置页 401 不切回登录页、不刷新会话")
    devState.appearanceUnauthorized = true
    await dev.page.reload({ waitUntil: "domcontentloaded" })
    await dev.page
      .getByRole("heading", { level: 1, name: "设置" })
      .waitFor({ timeout: 15000 })
    await sleep(500)
    await assertNoAuthUi(dev.page)
    const statusRequestsAfter401 = devState.statusRequests
    await sleep(700)
    assert.equal(
      devState.statusRequests,
      statusRequestsAfter401,
      "开发模式收到 401 后不得发起会话刷新",
    )
    assert.equal(
      devState.logoutRequests,
      0,
      "开发模式收到 401 后不得调用退出接口",
    )
    console.log("[E2E] 开发模式 401 不回落登录通过")

    logStep("devNoAuth=false：登录、管理员标识与退出流程保持原样")
    const authState = newState({ devNoAuth: false })
    const auth = await openPage(browser, baseUrl, authState, "/")
    contexts.push(auth.context)
    await auth.page
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 15000 })
    assert.equal(
      await auth.page.getByText(DEV_MARKER, { exact: true }).count(),
      0,
      "关闭开发模式后不得显示开发标识",
    )
    assert.equal(
      await auth.page.getByLabel("安装令牌", { exact: true }).count(),
      0,
      "未启用安装令牌时不得显示令牌输入",
    )

    await auth.page
      .getByLabel("密码", { exact: true })
      .fill("iread-e2e-password")
    await auth.page
      .getByRole("button", { name: "登录", exact: true })
      .click()
    await auth.page
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor({ timeout: 15000 })
    await auth.page.getByText("管理员", { exact: true }).waitFor()
    assert.equal(
      await auth.page.getByRole("button", { name: "退出登录" }).count(),
      1,
      "正常模式必须保留退出登录按钮",
    )
    assert.equal(
      await auth.page.getByText(DEV_MARKER, { exact: true }).count(),
      0,
      "正常模式不得显示开发标识",
    )

    await auth.page
      .getByRole("button", { name: "退出登录", exact: true })
      .click()
    await auth.page
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 15000 })
    assert.equal(authState.loginRequests, 1, "正常模式应调用一次登录接口")
    assert.equal(authState.logoutRequests, 1, "正常模式应调用一次退出接口")
    console.log("[E2E] devNoAuth=false 登录/退出回归通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    await browser?.close().catch(() => {})
    preview.kill("SIGTERM")
  }

  console.log("\n[E2E] 开发模式无密码认证验收全部通过")
}

main().catch((error) => {
  console.error("\n[E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
