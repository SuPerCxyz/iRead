#!/usr/bin/env node

// 安装令牌浏览器验收：只使用 web/dist 与 mock 认证 API，不启动后端。
// 覆盖 setupTokenRequired=true/false/旧后端缺省、错误文案与焦点。

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url))
const DIST_DIR = path.join(WEB_DIR, "dist")
const PASSWORD = "iread-e2e-password"
const CORRECT_TOKEN = "e2e-setup-token-correct"

const APPEARANCE_VALUE = {
  themeMode: "system",
  lightPreset: "template",
  darkPreset: "template",
  accent: "default",
  density: "standard",
  contentWidth: "auto",
  navCompact: false,
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

function statusData(state) {
  const data = {
    initialized: state.initialized,
    authenticated: state.authenticated,
    csrfToken: "e2e-csrf-token",
    csrfExpiresAt: null,
  }
  if (state.includeSetupTokenField) {
    data.setupTokenRequired = state.setupTokenRequired
  }
  return data
}

async function mockAuthApi(page, state) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "not_found",
          message: "未 mock 的接口",
          requestId: "auth-setup-token-e2e",
          details: {},
        },
      }),
    })
  })

  await page.route("**/api/v1/auth/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: statusData(state) }),
    })
  })

  await page.route("**/api/v1/auth/setup", async (route) => {
    const body = route.request().postDataJSON()
    state.setupRequests.push(body)
    if (
      state.setupTokenRequired &&
      body.setupToken !== CORRECT_TOKEN
    ) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "forbidden",
            message: "安装令牌无效",
            requestId: "e2e-setup-token-invalid",
            details: { reason: "setup_token_invalid" },
          },
        }),
      })
      return
    }
    state.initialized = true
    state.authenticated = true
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: statusData(state) }),
    })
  })

  await page.route("**/api/v1/settings/appearance", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          schemaVersion: 1,
          revision: "1",
          updatedAt: null,
          value: APPEARANCE_VALUE,
        },
      }),
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
}

async function fillPasswords(page) {
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD)
  await page.getByLabel("确认密码", { exact: true }).fill(PASSWORD)
}

async function submitSetup(page) {
  await page
    .getByRole("button", { name: "设置密码并进入", exact: true })
    .click()
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

    const openSetupPage = async (state) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: "zh-CN",
        serviceWorkers: "block",
      })
      contexts.push(context)
      const page = await context.newPage()
      await mockAuthApi(page, state)
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
      await page
        .getByRole("heading", { level: 1, name: "初始化 iRead" })
        .waitFor({ timeout: 15000 })
      return page
    }

    logStep("setupTokenRequired=true：显示令牌、必填、错误焦点与请求体")
    const requiredState = {
      initialized: false,
      authenticated: false,
      includeSetupTokenField: true,
      setupTokenRequired: true,
      setupRequests: [],
    }
    const requiredPage = await openSetupPage(requiredState)
    const tokenInput = requiredPage.getByLabel("安装令牌", {
      exact: true,
    })
    await tokenInput.waitFor()
    assert.equal(
      await tokenInput.getAttribute("autocomplete"),
      "off",
      "安装令牌输入必须关闭自动填充",
    )
    assert.equal(
      await tokenInput.getAttribute("type"),
      "password",
      "安装令牌应使用密码输入类型",
    )

    await fillPasswords(requiredPage)
    await submitSetup(requiredPage)
    await requiredPage
      .getByText("请输入安装令牌。", { exact: true })
      .waitFor({ timeout: 10000 })
    await requiredPage.waitForFunction(
      () => document.activeElement?.id === "auth-setup-token",
      undefined,
      { timeout: 5000 },
    )
    assert.equal(
      requiredState.setupRequests.length,
      0,
      "缺少安装令牌时不得发起 setup 请求",
    )

    await tokenInput.fill("wrong-token")
    await submitSetup(requiredPage)
    await requiredPage
      .getByText("安装令牌不正确", { exact: true })
      .waitFor({ timeout: 10000 })
    await requiredPage.waitForFunction(
      () => document.activeElement?.id === "auth-setup-token",
      undefined,
      { timeout: 5000 },
    )
    assert.deepEqual(requiredState.setupRequests.at(-1), {
      password: PASSWORD,
      setupToken: "wrong-token",
    })

    await tokenInput.fill(CORRECT_TOKEN)
    await submitSetup(requiredPage)
    await requiredPage
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor({ timeout: 15000 })
    assert.deepEqual(requiredState.setupRequests.at(-1), {
      password: PASSWORD,
      setupToken: CORRECT_TOKEN,
    })
    const leaked = await requiredPage.evaluate((token) => {
      const storage = JSON.stringify({
        local: { ...window.localStorage },
        session: { ...window.sessionStorage },
      })
      return {
        storage,
        href: window.location.href,
        cookie: document.cookie,
        token,
      }
    }, CORRECT_TOKEN)
    assert.equal(
      leaked.storage.includes(leaked.token),
      false,
      "安装令牌不得写入 localStorage/sessionStorage",
    )
    assert.equal(
      leaked.href.includes(leaked.token),
      false,
      "安装令牌不得写入 URL",
    )
    assert.equal(
      leaked.cookie.includes(leaked.token),
      false,
      "安装令牌不得写入 Cookie",
    )
    console.log("[E2E] required=true 通过")

    logStep("setupTokenRequired=false：不显示令牌且请求体不带 setupToken")
    const notRequiredState = {
      initialized: false,
      authenticated: false,
      includeSetupTokenField: true,
      setupTokenRequired: false,
      setupRequests: [],
    }
    const notRequiredPage = await openSetupPage(notRequiredState)
    assert.equal(
      await notRequiredPage.getByLabel("安装令牌").count(),
      0,
      "setupTokenRequired=false 时不得显示安装令牌",
    )
    await fillPasswords(notRequiredPage)
    await submitSetup(notRequiredPage)
    await notRequiredPage
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor({ timeout: 15000 })
    assert.equal(
      Object.hasOwn(notRequiredState.setupRequests[0], "setupToken"),
      false,
      "未启用安装令牌时不得提交 setupToken",
    )
    console.log("[E2E] required=false 通过")

    logStep("旧后端缺省 setupTokenRequired：按 false 兼容")
    const legacyState = {
      initialized: false,
      authenticated: false,
      includeSetupTokenField: false,
      setupTokenRequired: false,
      setupRequests: [],
    }
    const legacyPage = await openSetupPage(legacyState)
    assert.equal(
      await legacyPage.getByLabel("安装令牌").count(),
      0,
      "旧后端缺省字段时不得显示安装令牌",
    )
    await fillPasswords(legacyPage)
    await submitSetup(legacyPage)
    await legacyPage
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor({ timeout: 15000 })
    assert.equal(
      Object.hasOwn(legacyState.setupRequests[0], "setupToken"),
      false,
      "旧后端 setup 请求不得包含 setupToken",
    )
    console.log("[E2E] 旧后端兼容通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    await browser?.close().catch(() => {})
    preview.kill("SIGTERM")
  }

  console.log("\n[E2E] 安装令牌浏览器验收全部通过")
}

main().catch((error) => {
  console.error("\n[E2E] 失败：")
  console.error(error)
  process.exitCode = 1
})
