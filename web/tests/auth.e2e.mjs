#!/usr/bin/env node

import assert from "node:assert/strict"

import { chromium, request as playwrightRequest } from "playwright"

import {
  AuthedApi,
  E2E_PASSWORD,
  E2E_SETUP_TOKEN,
  E2EBlocked,
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
)

function url(path) {
  return `${BASE_URL}${path}`
}

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

async function fillAndSubmitLogin(page, password) {
  await page.getByLabel("密码", { exact: true }).fill(password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox"],
  })
  const contexts = []
  const apiContexts = []

  try {
    const probe = await playwrightRequest.newContext({ baseURL: BASE_URL })
    apiContexts.push(probe)
    const probeApi = new AuthedApi(probe, BASE_URL)
    const initialStatus = await probeApi.fetchStatus()

    if (!initialStatus.initialized) {
      if (
        initialStatus.setupTokenRequired === true &&
        E2E_SETUP_TOKEN.length === 0
      ) {
        throw new E2EBlocked(
          "后端已启用 IREAD_SETUP_TOKEN；请设置 IREAD_E2E_SETUP_TOKEN 后重试。",
        )
      }

      logStep("setup UI：本地校验、确认密码与首次初始化")
      const setupContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      })
      contexts.push(setupContext)
      const setupPage = await setupContext.newPage()
      await setupPage.goto(url("/"), { waitUntil: "domcontentloaded" })
      await setupPage
        .getByRole("heading", { level: 1, name: "初始化 iRead" })
        .waitFor({ timeout: 10000 })

      const setupTokenInput = setupPage.getByLabel("安装令牌", {
        exact: true,
      })
      if (initialStatus.setupTokenRequired === true) {
        await setupTokenInput.waitFor()
        assert.equal(
          await setupTokenInput.getAttribute("autocomplete"),
          "off",
          "安装令牌输入必须关闭自动填充",
        )
      } else {
        assert.equal(
          await setupTokenInput.count(),
          0,
          "未启用安装令牌时不得显示令牌输入",
        )
      }

      await setupPage.getByLabel("密码", { exact: true }).fill("short")
      await setupPage
        .getByRole("button", { name: "设置密码并进入" })
        .click()
      await setupPage
        .getByText("密码至少需要 10 个字符。", { exact: true })
        .waitFor()
      assert.equal(
        await setupPage.evaluate(() => document.activeElement?.id ?? null),
        "auth-password",
        "密码过短时焦点应回到密码输入框",
      )

      await setupPage.getByLabel("密码", { exact: true }).fill(E2E_PASSWORD)
      await setupPage
        .getByLabel("确认密码", { exact: true })
        .fill("different-password")
      await setupPage
        .getByRole("button", { name: "设置密码并进入" })
        .click()
      await setupPage
        .getByText("两次输入的密码不一致。", { exact: true })
        .waitFor()
      await setupPage.waitForFunction(
        () => document.activeElement?.id === "auth-confirm-password",
        undefined,
        { timeout: 5000 },
      )

      await setupPage
        .getByLabel("确认密码", { exact: true })
        .fill(E2E_PASSWORD)

      if (initialStatus.setupTokenRequired === true) {
        await setupPage
          .getByRole("button", { name: "设置密码并进入" })
          .click()
        await setupPage
          .getByText("请输入安装令牌。", { exact: true })
          .waitFor()
        await setupPage.waitForFunction(
          () => document.activeElement?.id === "auth-setup-token",
          undefined,
          { timeout: 5000 },
        )
        await setupTokenInput.fill(E2E_SETUP_TOKEN)
      }

      await setupPage
        .getByRole("button", { name: "设置密码并进入" })
        .click()
      await setupPage
        .getByRole("heading", { level: 1, name: "首页" })
        .waitFor({ timeout: 15000 })
      await setupPage.getByText("管理员", { exact: true }).waitFor()
      console.log("[E2E] setup UI 通过")
    } else {
      console.log("[E2E] setup UI 跳过：管理员已初始化")
    }

    logStep("登录并建立可复用管理员会话")
    const adminState = await createAuthenticatedStorageState(
      browser,
      BASE_URL,
      E2E_PASSWORD,
    )
    const adminRequest = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: adminState,
    })
    apiContexts.push(adminRequest)
    const adminApi = new AuthedApi(adminRequest, BASE_URL)
    await ensureAdmin(adminApi, BASE_URL, E2E_PASSWORD)
    const status = await adminApi.fetchStatus()

    assert.equal(status.initialized, true)
    assert.equal(status.authenticated, true)
    assert.ok(status.csrfToken.length > 0, "认证状态必须返回 CSRF 令牌")
    if (status.csrfExpiresAt !== null) {
      assert.ok(
        !Number.isNaN(Date.parse(status.csrfExpiresAt)),
        "csrfExpiresAt 必须是可解析时间",
      )
    }
    console.log("[E2E] 认证状态字段通过")

    logStep("未认证 API 返回 JSON 401/404，不返回 SPA")
    const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
    apiContexts.push(anonymous)
    const anonymousAppearance = await anonymous.get(
      `${BASE_URL}/api/v1/settings/appearance`,
      { failOnStatusCode: false },
    )
    assert.equal(anonymousAppearance.status(), 401)
    assert.match(
      anonymousAppearance.headers()["content-type"] ?? "",
      /application\/json/,
      "未认证 API 必须返回 JSON",
    )
    const anonymousBody = await anonymousAppearance.json()
    assert.equal(anonymousBody.error.code, "unauthenticated")

    const unknownApi = await anonymous.get(
      `${BASE_URL}/api/v1/not-a-route`,
      { failOnStatusCode: false },
    )
    assert.equal(
      unknownApi.status(),
      401,
      "未认证的未知 API 必须先返回 JSON 401，不暴露路由存在性",
    )
    assert.match(
      unknownApi.headers()["content-type"] ?? "",
      /application\/json/,
      "未知 API 不得返回 SPA HTML",
    )
    const unknownBody = await unknownApi.json()
    assert.equal(unknownBody.error.code, "unauthenticated")
    console.log("[E2E] 未认证 API 门禁通过")

    logStep("CSRF：缺令牌/错误 Origin 拒绝，合法令牌重试成功")
    const csrfRequest = await playwrightRequest.newContext({ baseURL: BASE_URL })
    apiContexts.push(csrfRequest)
    const csrfApi = new AuthedApi(csrfRequest, BASE_URL)
    await ensureAdmin(csrfApi, BASE_URL, E2E_PASSWORD)
    const appearance = await csrfApi.get("/api/v1/settings/appearance")
    assert.equal(appearance.status, 200)
    const record = appearance.payload.data
    const body = JSON.stringify({
      schemaVersion: 1,
      baseRevision: record.revision,
      value: record.value,
    })

    const missingCsrf = await csrfRequest.fetch(
      `${BASE_URL}/api/v1/settings/appearance`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: BASE_URL,
        },
        data: body,
        failOnStatusCode: false,
      },
    )
    assert.equal(missingCsrf.status(), 403, "缺少 CSRF 令牌必须 403")
    const missingPayload = await missingCsrf.json()
    assert.equal(missingPayload.error.code, "forbidden")
    assert.match(
      String(missingPayload.error.details?.reason ?? ""),
      /^csrf_(invalid|expired)$/,
    )

    const invalidOrigin = await csrfRequest.fetch(
      `${BASE_URL}/api/v1/settings/appearance`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "X-CSRF-Token": csrfApi.csrfToken,
        },
        data: body,
        failOnStatusCode: false,
      },
    )
    assert.equal(invalidOrigin.status(), 403, "错误 Origin 必须 403")
    const invalidOriginPayload = await invalidOrigin.json()
    assert.equal(invalidOriginPayload.error.code, "invalid_origin")

    const validCsrf = await csrfApi.put("/api/v1/settings/appearance", {
      schemaVersion: 1,
      baseRevision: record.revision,
      value: record.value,
    })
    assert.equal(validCsrf.status, 200, "合法 CSRF/Origin 应允许写入")
    console.log("[E2E] CSRF 与 Origin 门禁通过")

    logStep("UI 登录、令牌仅内存、退出与失效会话")
    const loginContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(loginContext)
    const loginPage = await loginContext.newPage()
    await loginPage.goto(url("/"), { waitUntil: "domcontentloaded" })
    await loginPage
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 10000 })
    await fillAndSubmitLogin(loginPage, E2E_PASSWORD)
    await loginPage
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor({ timeout: 15000 })
    await loginPage.getByText("管理员", { exact: true }).waitFor()

    const sessionState = await loginContext.storageState()
    const revokedRequest = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: sessionState,
    })
    apiContexts.push(revokedRequest)

    const pageToken = await loginPage.evaluate(async () => {
      const response = await fetch("/api/v1/auth/status", {
        credentials: "same-origin",
      })
      const payload = await response.json()
      return payload.data.csrfToken
    })
    const storageDump = await loginPage.evaluate(() =>
      JSON.stringify({
        local: { ...window.localStorage },
        session: { ...window.sessionStorage },
      }),
    )
    assert.ok(
      !storageDump.includes(pageToken),
      "CSRF 令牌不得写入 localStorage/sessionStorage",
    )

    await loginPage.getByRole("button", { name: "退出登录" }).click()
    await loginPage
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 10000 })
    const afterLogout = await loginPage.evaluate(async () => {
      const response = await fetch("/api/v1/settings/appearance", {
        credentials: "same-origin",
      })
      return response.status
    })
    assert.equal(afterLogout, 401, "退出后受保护 API 必须返回 401")

    const revoked = await revokedRequest.get(
      `${BASE_URL}/api/v1/settings/appearance`,
      { failOnStatusCode: false },
    )
    assert.equal(revoked.status(), 401, "已撤销会话不得继续访问资源")
    console.log("[E2E] 登录、内存令牌、退出与失效会话通过")

    logStep("登录后返回站内目标，拒绝外部 returnTo")
    const externalContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(externalContext)
    const externalPage = await externalContext.newPage()
    await externalPage.goto(
      url("/?returnTo=https%3A%2F%2Fevil.example%2Fsteal"),
      { waitUntil: "domcontentloaded" },
    )
    await fillAndSubmitLogin(externalPage, E2E_PASSWORD)
    await externalPage
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor({ timeout: 15000 })
    const externalUrl = new URL(externalPage.url())
    assert.equal(externalUrl.origin, BASE_URL)
    assert.equal(externalUrl.pathname, "/")
    assert.equal(externalUrl.searchParams.has("returnTo"), false)

    const internalContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(internalContext)
    const internalPage = await internalContext.newPage()
    await internalPage.goto(url("/settings?returnTo=%2Flibrary"), {
      waitUntil: "domcontentloaded",
    })
    await fillAndSubmitLogin(internalPage, E2E_PASSWORD)
    await internalPage.waitForFunction(
      () => window.location.pathname === "/library",
      undefined,
      { timeout: 15000 },
    )
    await internalPage
      .getByRole("heading", { level: 1, name: "书库" })
      .waitFor()
    console.log("[E2E] returnTo 站内/站外校验通过")

    logStep("429 与离线登录文案（前端行为）")
    const rateContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(rateContext)
    const ratePage = await rateContext.newPage()
    await ratePage.route("**/api/v1/auth/login", async (route) => {
      await route.fulfill({
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "30",
        },
        body: JSON.stringify({
          error: {
            code: "rate_limited",
            message: "尝试次数过多",
            requestId: "e2e-rate",
            details: {},
          },
        }),
      })
    })
    await ratePage.goto(url("/"), { waitUntil: "domcontentloaded" })
    await fillAndSubmitLogin(ratePage, "wrong-password")
    await ratePage
      .getByText("尝试次数过多，请在 30 秒后重试。", { exact: true })
      .waitFor({ timeout: 10000 })

    const offlineContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(offlineContext)
    const offlinePage = await offlineContext.newPage()
    await offlinePage.goto(url("/"), { waitUntil: "domcontentloaded" })
    await offlinePage
      .getByRole("heading", { level: 1, name: "登录 iRead" })
      .waitFor({ timeout: 10000 })
    await offlineContext.setOffline(true)
    await offlinePage.waitForFunction(() => navigator.onLine === false)
    await fillAndSubmitLogin(offlinePage, E2E_PASSWORD)
    await offlinePage
      .getByText("当前处于离线状态，无法建立新会话。请联网后重试。", {
        exact: true,
      })
      .waitFor({ timeout: 10000 })
    await offlineContext.setOffline(false)
    console.log("[E2E] 429/离线文案通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      await context.dispose().catch(() => {})
    }
    await browser.close().catch(() => {})
  }

  console.log("\n[E2E] 认证全部通过")
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
