#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { chromium, request as playwrightRequest } from "playwright"

import {
  AuthedApi,
  E2E_PASSWORD,
  E2EBlocked,
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
)
const WEB_DIR = fileURLToPath(new URL("..", import.meta.url))
const SCREENSHOT_DIR = "/tmp/opencode"

let adminApi = null

const DEFAULT_VALUE = {
  themeMode: "system",
  lightPreset: "template",
  darkPreset: "template",
  accent: "default",
  density: "standard",
  contentWidth: "auto",
  navCompact: false,
}

function url(path) {
  return `${BASE_URL}${path}`
}

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

async function apiGet() {
  assert.ok(adminApi, "认证 API 尚未初始化")
  const result = await adminApi.get("/api/v1/settings/appearance")
  assert.equal(result.status, 200, "GET appearance 应返回 200")
  return result.payload.data
}

async function apiPut(baseRevision, value) {
  assert.ok(adminApi, "认证 API 尚未初始化")
  return adminApi.put("/api/v1/settings/appearance", {
    schemaVersion: 1,
    baseRevision,
    value,
  })
}

async function resetAppearance() {
  const record = await apiGet()
  if (JSON.stringify(record.value) !== JSON.stringify(DEFAULT_VALUE)) {
    const result = await apiPut(record.revision, DEFAULT_VALUE)
    assert.equal(result.status, 200, "重置外观应成功")
    return result.payload.data
  }
  return record
}

async function waitForApiValue(expected, timeout = 8000) {
  const deadline = Date.now() + timeout
  let latest = null
  while (Date.now() < deadline) {
    latest = await apiGet()
    if (JSON.stringify(latest.value) === JSON.stringify(expected)) {
      return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(
    `等待服务器外观值超时。最后值：${JSON.stringify(latest?.value)}`,
  )
}

async function waitForStatus(page, text) {
  await page
    .locator('[role="status"]')
    .filter({ hasText: text })
    .first()
    .waitFor({ timeout: 10000 })
}

async function waitForChecked(locator, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await locator.isChecked()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail("等待控件选中超时")
}

async function waitForAriaChecked(locator, checked, timeout = 5000) {
  const expected = String(checked)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await locator.getAttribute("aria-checked")) === expected) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`等待 aria-checked=${expected} 超时`)
}

async function clearLocalMirror(page) {
  await page.goto(url("/"), { waitUntil: "domcontentloaded" })
  await page.evaluate(() => {
    window.localStorage.removeItem("iread.appearance.v1")
  })
}

async function waitForMirrorRevision(page, revision, timeout = 10000) {
  await page.waitForFunction(
    (expected) => {
      const raw = window.localStorage.getItem("iread.appearance.v1")
      if (raw === null) {
        return false
      }
      const mirror = JSON.parse(raw)
      return mirror.record?.revision === expected
    },
    revision,
    { timeout },
  )
}

async function waitForAppliedCss(page, key, value, timeout = 10000) {
  await page.waitForFunction(
    ([expectedKey, expectedValue]) => {
      const raw = window.localStorage.getItem("iread.appearance.v1")
      if (raw === null) {
        return false
      }
      const mirror = JSON.parse(raw)
      return mirror.appliedCss?.[expectedKey] === expectedValue
    },
    [key, value],
    { timeout },
  )
}

async function waitForController(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  const controlled = await page.evaluate(
    () => navigator.serviceWorker.controller !== null,
  )
  if (!controlled) {
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      undefined,
      { timeout: 15000 },
    )
  }
}

async function gotoRoute(page, path, heading, expectedStatus = 200) {
  const response = await page.goto(url(path), {
    waitUntil: "domcontentloaded",
  })
  assert.equal(
    response?.status(),
    expectedStatus,
    `${path} 的 HTTP 状态应为 ${expectedStatus}`,
  )
  await page
    .getByRole("heading", { level: 1, name: heading })
    .waitFor({ timeout: 10000 })
}

async function expectDataAttributes(page, expected) {
  const actual = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    lightPreset: document.documentElement.dataset.lightPreset,
    darkPreset: document.documentElement.dataset.darkPreset,
    accent: document.documentElement.dataset.accent,
    density: document.documentElement.dataset.density,
    navCompact: document.documentElement.dataset.navCompact,
    contentWidth: document.documentElement.style.getPropertyValue(
      "--iread-content-width",
    ),
  }))
  assert.deepEqual(actual, expected)
}

async function readMirror(page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("iread.appearance.v1")
    return raw === null ? null : JSON.parse(raw)
  })
}

async function selectOption(page, label, option) {
  await page
    .getByRole("combobox", { name: label, exact: true })
    .click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox"],
  })
  const contexts = []
  let updateBuildApplied = false
  let anonymousApi = null

  try {
    logStep("认证：确保管理员会话")
    const authState = await createAuthenticatedStorageState(
      browser,
      BASE_URL,
      E2E_PASSWORD,
    )
    adminApi = new AuthedApi(
      await playwrightRequest.newContext({
        baseURL: BASE_URL,
        storageState: authState,
      }),
      BASE_URL,
    )
    await ensureAdmin(adminApi, BASE_URL, E2E_PASSWORD)
    const newContext = (options = {}) =>
      browser.newContext({ storageState: authState, ...options })
    console.log("[E2E] 管理员会话已建立")

    logStep("未认证 API 与页面不得假通过")
    anonymousApi = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const anonymousAppearance = await anonymousApi.get(
      "/api/v1/settings/appearance",
      { failOnStatusCode: false },
    )
    assert.equal(
      anonymousAppearance.status(),
      401,
      "未认证 GET appearance 应返回 401，不得保留公开读写",
    )
    const anonymousContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(anonymousContext)
    const anonymousPage = await anonymousContext.newPage()
    await anonymousPage.goto(url("/library"), {
      waitUntil: "domcontentloaded",
    })
    await anonymousPage
      .getByRole("heading", { name: /^(登录 iRead|初始化 iRead)$/ })
      .waitFor({ timeout: 10000 })
    assert.equal(
      await anonymousPage
        .getByRole("heading", { level: 1, name: "书库" })
        .count(),
      0,
      "未认证不得渲染空书库或假数据",
    )
    console.log("[E2E] 未认证 API/页面门禁通过")

    logStep("重置服务器外观到默认值")
    await resetAppearance()
    console.log("[E2E] 已重置")

    logStep("桌面 1440x900：六路由与 404")
    const desktop = await newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(desktop)
    const desktopPage = await desktop.newPage()
    await gotoRoute(desktopPage, "/", "首页")
    await gotoRoute(desktopPage, "/library", "书库")
    await gotoRoute(
      desktopPage,
      "/books/demo-book",
      "没有找到这本书",
    )
    await desktopPage
      .getByText("它可能已被移除，或链接不再有效。", { exact: true })
      .waitFor()
    await desktopPage
      .getByRole("button", { name: "返回书库", exact: true })
      .waitFor()
    await gotoRoute(desktopPage, "/read/demo-book", "阅读器")
    await gotoRoute(desktopPage, "/settings", "设置")
    await gotoRoute(desktopPage, "/no-such-route", "页面不存在", 404)
    console.log("[E2E] 六路由通过")

    logStep("尾斜杠 breadcrumb 与 aria-current")
    await gotoRoute(desktopPage, "/library/", "书库")
    assert.equal(
      (await desktopPage
        .locator('[data-slot="breadcrumb-page"]')
        .last()
        .textContent()) ?? "",
      "书库",
      "/library/ 面包屑末项应为书库",
    )
    assert.deepEqual(
      await desktopPage
        .locator('[data-slot="sidebar"] [aria-current="page"]')
        .allTextContents(),
      ["书库"],
      "/library/ 侧栏应只有书库为当前项",
    )
    await gotoRoute(desktopPage, "/settings/", "设置")
    assert.equal(
      (await desktopPage
        .locator('[data-slot="breadcrumb-page"]')
        .last()
        .textContent()) ?? "",
      "设置",
      "/settings/ 面包屑末项应为设置",
    )
    assert.deepEqual(
      await desktopPage
        .locator('[data-slot="sidebar"] [aria-current="page"]')
        .allTextContents(),
      ["设置"],
      "/settings/ 侧栏应只有设置为当前项",
    )
    await desktopPage
      .getByRole("tablist", { name: "设置分组" })
      .waitFor()
    assert.equal(
      await desktopPage
        .getByRole("button", { name: "关闭导航" })
        .isVisible(),
      false,
      "桌面不得显示手机 Sheet 关闭按钮",
    )
    console.log("[E2E] 尾斜杠与设置分组 aria-label 通过")

    logStep("首屏主题：abort 主 bundle，仅引导脚本生效")
    const openBootOnlyPage = async (options, mirror) => {
      const context = await newContext(options)
      contexts.push(context)
      if (mirror !== undefined) {
        await context.addInitScript((serialized) => {
          try {
            window.localStorage.setItem(
              "iread.appearance.v1",
              serialized,
            )
          } catch {
            // about:blank 等不可写来源直接跳过。
          }
        }, mirror)
      }
      const page = await context.newPage()
      const pageErrors = []
      page.on("pageerror", (error) => {
        pageErrors.push(error.message)
      })
      await page.route("**/assets/*.js", (route) => route.abort())
      await page.goto(url("/"), { waitUntil: "domcontentloaded" })
      return { page, pageErrors }
    }

    const darkValue = {
      ...DEFAULT_VALUE,
      themeMode: "dark",
      darkPreset: "midnight",
    }
    const darkMirror = JSON.stringify({
      record: {
        schemaVersion: 1,
        revision: "0",
        updatedAt: null,
        value: darkValue,
      },
      pending: darkValue,
      baseRevision: "0",
    })
    const darkBoot = await openBootOnlyPage(
      {
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
        colorScheme: "light",
      },
      darkMirror,
    )
    const earlyDark = await darkBoot.page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      darkPreset: document.documentElement.dataset.darkPreset,
      background: getComputedStyle(document.body).backgroundColor,
    }))
    assert.equal(earlyDark.dark, true, "无 bundle 时镜像深色应生效")
    assert.equal(earlyDark.darkPreset, "midnight")
    assert.notEqual(
      earlyDark.background,
      "rgb(255, 255, 255)",
      "首屏深色背景不得先显示白色",
    )
    assert.deepEqual(darkBoot.pageErrors, [])

    const systemDarkBoot = await openBootOnlyPage({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      colorScheme: "dark",
    })
    const earlySystem = await systemDarkBoot.page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      background: getComputedStyle(document.body).backgroundColor,
    }))
    assert.equal(
      earlySystem.dark,
      true,
      "无镜像且系统深色时首帧应为深色",
    )
    assert.notEqual(earlySystem.background, "rgb(255, 255, 255)")
    assert.deepEqual(systemDarkBoot.pageErrors, [])

    const customValue = {
      ...DEFAULT_VALUE,
      accent: "#2563eb",
      contentWidth: 60,
    }
    const customMirror = JSON.stringify({
      record: {
        schemaVersion: 1,
        revision: "0",
        updatedAt: null,
        value: customValue,
      },
      pending: customValue,
      baseRevision: "0",
      appliedCss: {
        "--primary": "#2563eb",
        "--primary-foreground": "#ffffff",
        "--ring": "#2563eb",
        "--sidebar-primary": "#2563eb",
        "--sidebar-primary-foreground": "#ffffff",
        "--sidebar-ring": "#2563eb",
        "--iread-content-width": "60%",
      },
    })
    const customBoot = await openBootOnlyPage(
      {
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
        colorScheme: "light",
      },
      customMirror,
    )
    const earlyCustom = await customBoot.page.evaluate(() => ({
      primary: document.documentElement.style.getPropertyValue(
        "--primary",
      ),
      contentWidth: document.documentElement.style.getPropertyValue(
        "--iread-content-width",
      ),
    }))
    assert.equal(earlyCustom.primary, "#2563eb")
    assert.equal(earlyCustom.contentWidth, "60%")
    assert.deepEqual(customBoot.pageErrors, [])

    const invalidMirror = JSON.stringify({
      record: null,
      pending: {
        ...DEFAULT_VALUE,
        themeMode: "dark",
      },
      baseRevision: "0",
      appliedCss: {
        "--primary": "red",
        "--ring": "not-a-color",
        "--evil": "#ffffff",
        "--iread-content-width": "101%",
      },
    })
    const invalidBoot = await openBootOnlyPage(
      {
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
        colorScheme: "light",
      },
      invalidMirror,
    )
    const earlyInvalid = await invalidBoot.page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      primary: document.documentElement.style.getPropertyValue(
        "--primary",
      ),
      ring: document.documentElement.style.getPropertyValue("--ring"),
      evil: document.documentElement.style.getPropertyValue("--evil"),
      contentWidth: document.documentElement.style.getPropertyValue(
        "--iread-content-width",
      ),
    }))
    assert.equal(earlyInvalid.dark, true, "非法 appliedCss 不影响主题")
    assert.equal(earlyInvalid.primary, "")
    assert.equal(earlyInvalid.ring, "")
    assert.equal(earlyInvalid.evil, "")
    assert.equal(earlyInvalid.contentWidth, "")
    assert.deepEqual(invalidBoot.pageErrors, [])
    console.log("[E2E] 首屏真首帧引导通过")

    logStep("外观保存 → 刷新恢复 → GET revision")
    await resetAppearance()
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await desktopPage.getByRole("radio", { name: "深色", exact: true }).click()
    await selectOption(desktopPage, "深色预设", "深灰")
    await selectOption(desktopPage, "强调色", "蓝色")
    await selectOption(desktopPage, "界面密度", "紧凑")
    await desktopPage.getByRole("switch", { name: "自动内容宽度" }).click()
    const widthSlider = desktopPage.getByRole("slider", { name: "页面宽度" })
    await widthSlider.focus()
    await widthSlider.press("Home")
    await desktopPage.getByRole("switch", { name: "紧凑导航" }).click()

    const pendingMirror = await readMirror(desktopPage)
    assert.ok(pendingMirror?.pending, "编辑后本地镜像应写入 pending")
    assert.equal(pendingMirror.pending.themeMode, "dark")

    const saved = await waitForApiValue({
      themeMode: "dark",
      lightPreset: "template",
      darkPreset: "gray",
      accent: "blue",
      density: "compact",
      contentWidth: 50,
      navCompact: true,
    })
    await waitForStatus(desktopPage, "已保存")
    const savedMirror = await readMirror(desktopPage)
    assert.equal(savedMirror.pending, null, "保存成功后 pending 应清空")
    assert.equal(savedMirror.record.revision, saved.revision)
    assert.equal(savedMirror.record.value.contentWidth, 50)
    await waitForAppliedCss(desktopPage, "--iread-content-width", "50%")

    console.log(`[E2E] 服务器 revision=${saved.revision}`)
    await desktopPage.reload({ waitUntil: "domcontentloaded" })
    await expectDataAttributes(desktopPage, {
      dark: true,
      lightPreset: "template",
      darkPreset: "gray",
      accent: "blue",
      density: "compact",
      navCompact: "true",
      contentWidth: "50%",
    })
    await waitForStatus(desktopPage, "已保存")
    const reloadedGet = await apiGet()
    assert.equal(reloadedGet.revision, saved.revision)
    assert.equal(reloadedGet.value.darkPreset, "gray")

    logStep("恢复默认走同一保存路径")
    await desktopPage.getByRole("button", { name: "恢复外观默认" }).click()
    const defaultRecord = await waitForApiValue(DEFAULT_VALUE)
    assert.ok(
      BigInt(defaultRecord.revision) > BigInt(saved.revision),
      "恢复默认应提升 revision",
    )
    await waitForStatus(desktopPage, "已保存")
    console.log("[E2E] 恢复默认通过")

    logStep("主题模式 RadioGroup 方向键移动焦点并选中（含首尾环绕）")
    await resetAppearance()
    await clearLocalMirror(desktopPage)
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForStatus(desktopPage, "已保存")

    const themeModeLabels = {
      system: "跟随系统",
      light: "浅色",
      dark: "深色",
    }
    const themeModeRadio = (mode) =>
      desktopPage.getByRole("radio", {
        name: themeModeLabels[mode],
        exact: true,
      })
    let keyboardPutCount = 0
    const keyboardApiPattern = "**/api/v1/settings/appearance"
    const countKeyboardPut = async (route) => {
      if (route.request().method() === "PUT") {
        keyboardPutCount += 1
      }
      await route.continue()
    }
    await desktopPage.route(keyboardApiPattern, countKeyboardPut)

    const pressThemeMode = async (key, mode) => {
      const before = keyboardPutCount
      await desktopPage.keyboard.press(key)
      await waitForAriaChecked(themeModeRadio(mode), true)
      const focusState = await desktopPage.evaluate(() => ({
        activeId: document.activeElement?.id ?? null,
        tabIndexZero: [...document.querySelectorAll('[role="radio"]')]
          .filter((radio) => radio.getAttribute("tabindex") === "0")
          .map((radio) => radio.id),
      }))
      assert.equal(
        focusState.activeId,
        `theme-mode-${mode}`,
        `${key} 后焦点应停留在 ${themeModeLabels[mode]}`,
      )
      assert.deepEqual(
        focusState.tabIndexZero,
        [`theme-mode-${mode}`],
        `${key} 后应只有当前项处于 roving tabindex=0`,
      )
      await desktopPage
        .getByText(
          new RegExp(
            `当前：${themeModeLabels[mode]}（解析为(深色|浅色)）`,
          ),
        )
        .first()
        .waitFor({ timeout: 5000 })
      assert.equal(
        await desktopPage.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
        mode === "dark",
        `${key} 后预览主题应与选中模式一致`,
      )
      await waitForApiValue({ ...DEFAULT_VALUE, themeMode: mode })
      await waitForStatus(desktopPage, "已保存")
      assert.equal(
        keyboardPutCount,
        before + 1,
        `${key} 切换主题模式只能产生一次保存请求`,
      )
    }

    await themeModeRadio("light").focus()
    assert.equal(
      await desktopPage.evaluate(() => document.activeElement?.id),
      "theme-mode-light",
      "应由测试聚焦浅色选项",
    )
    await pressThemeMode("ArrowDown", "dark")
    await pressThemeMode("ArrowUp", "light")
    await pressThemeMode("ArrowRight", "dark")
    await pressThemeMode("ArrowLeft", "light")
    await pressThemeMode("ArrowLeft", "system")
    await pressThemeMode("ArrowLeft", "dark")
    await pressThemeMode("ArrowRight", "system")
    await pressThemeMode("ArrowUp", "dark")
    await pressThemeMode("ArrowDown", "system")

    await themeModeRadio("dark").focus()
    await desktopPage.keyboard.press("Space")
    await waitForAriaChecked(themeModeRadio("dark"), true)
    await waitForApiValue({ ...DEFAULT_VALUE, themeMode: "dark" })
    await waitForStatus(desktopPage, "已保存")

    await themeModeRadio("light").focus()
    await desktopPage.keyboard.press("Enter")
    await desktopPage.waitForTimeout(500)
    await waitForAriaChecked(themeModeRadio("dark"), true)
    assert.equal(
      (await apiGet()).value.themeMode,
      "dark",
      "Enter 不得改变既有选中项（官方 Radio 仅 Space 触发选择）",
    )

    await themeModeRadio("light").click()
    await waitForAriaChecked(themeModeRadio("light"), true)
    await waitForApiValue({ ...DEFAULT_VALUE, themeMode: "light" })
    await waitForStatus(desktopPage, "已保存")

    await desktopPage.keyboard.press("Tab")
    const afterTab = await desktopPage.evaluate(() => ({
      activeRole: document.activeElement?.getAttribute("role") ?? null,
      checked: [...document.querySelectorAll('[role="radio"]')]
        .filter((radio) => radio.getAttribute("aria-checked") === "true")
        .map((radio) => radio.id),
    }))
    assert.notEqual(afterTab.activeRole, "radio", "Tab 应离开主题模式组")
    assert.deepEqual(
      afterTab.checked,
      ["theme-mode-light"],
      "Tab 不得改变主题模式选中项",
    )
    assert.equal(
      (await apiGet()).value.themeMode,
      "light",
      "Tab 不得触发额外主题保存",
    )

    await desktopPage.unroute(keyboardApiPattern, countKeyboardPut)
    await resetAppearance()
    console.log("[E2E] 主题模式方向键与环绕通过")

    logStep("初始 GET 迟到：忽略旧 revision，不产生假 409")
    const staleRecord = await resetAppearance()
    await clearLocalMirror(desktopPage)
    await desktopPage.evaluate((record) => {
      window.localStorage.setItem(
        "iread.appearance.v1",
        JSON.stringify({
          record,
          pending: null,
          baseRevision: record.revision,
        }),
      )
    }, staleRecord)

    let releaseStaleGet
    const staleGetGate = new Promise((resolve) => {
      releaseStaleGet = resolve
    })
    let markStaleGetStarted
    const staleGetStarted = new Promise((resolve) => {
      markStaleGetStarted = resolve
    })
    let staleGetHeld = false
    const lateGetPattern = "**/api/v1/settings/appearance"
    const lateGetRoute = async (route) => {
      if (route.request().method() === "GET" && !staleGetHeld) {
        staleGetHeld = true
        markStaleGetStarted()
        await staleGetGate
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: staleRecord }),
        })
        return
      }
      await route.continue()
    }
    await desktopPage.route(lateGetPattern, lateGetRoute)
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await staleGetStarted
    await desktopPage.getByRole("radio", { name: "深色", exact: true }).click()
    const lateGetSaved = await waitForApiValue({
      ...DEFAULT_VALUE,
      themeMode: "dark",
    })
    assert.ok(
      BigInt(lateGetSaved.revision) > BigInt(staleRecord.revision),
      "PUT 后 revision 应高于迟到的旧 GET",
    )
    releaseStaleGet()
    await desktopPage.waitForTimeout(1500)
    assert.equal(
      await desktopPage.getByRole("alertdialog").count(),
      0,
      "迟到旧 GET 不得触发冲突弹窗",
    )
    await waitForStatus(desktopPage, "已保存")
    assert.equal(
      await desktopPage.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      ),
      true,
      "迟到旧 GET 不得回滚深色选择",
    )
    const afterLateGet = await apiGet()
    assert.equal(afterLateGet.value.themeMode, "dark")
    assert.equal(afterLateGet.revision, lateGetSaved.revision)
    await desktopPage.unroute(lateGetPattern, lateGetRoute)
    await resetAppearance()
    console.log("[E2E] 迟到初始 GET 通过")

    logStep("直接深链接返回：replace 到书库且不污染历史")
    const assertDirectReturn = async (path, heading, deepPart) => {
      const context = await newContext({
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      })
      contexts.push(context)
      const page = await context.newPage()
      await page.goto(url(path), { waitUntil: "domcontentloaded" })
      await page
        .getByRole("heading", { level: 1, name: heading })
        .waitFor({ timeout: 10000 })
      const before = await page.evaluate(() => window.history.length)
      await page
        .getByRole("button", { name: "返回书库", exact: true })
        .first()
        .click()
      await page.waitForFunction(
        () => window.location.pathname === "/library",
        undefined,
        { timeout: 5000 },
      )
      const after = await page.evaluate(() => window.history.length)
      assert.equal(
        after,
        before,
        `${path} 返回不得新增历史条目`,
      )
      await page
        .evaluate(() => window.history.back())
        .catch(() => {
          // 后退本身可能销毁当前执行上下文，断言只看最终 URL。
        })
      await page.waitForTimeout(800)
      assert.ok(
        !page.url().includes(deepPart),
        `${path} 返回后浏览器后退不得再次进入 ${deepPart}`,
      )
    }
    await assertDirectReturn("/read/demo-direct", "阅读器", "/read/demo-direct")
    await assertDirectReturn(
      "/books/demo-direct",
      "没有找到这本书",
      "/books/demo-direct",
    )

    const escContext = await newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(escContext)
    const escPage = await escContext.newPage()
    await escPage.goto(url("/read/demo-esc"), {
      waitUntil: "domcontentloaded",
    })
    await escPage
      .getByRole("heading", { level: 1, name: "阅读器" })
      .waitFor({ timeout: 10000 })
    const escBefore = await escPage.evaluate(() => window.history.length)
    await escPage.keyboard.press("Escape")
    await escPage.waitForFunction(
      () => window.location.pathname === "/library",
      undefined,
      { timeout: 5000 },
    )
    assert.equal(
      await escPage.evaluate(() => window.history.length),
      escBefore,
      "Esc 返回不得新增历史条目",
    )
    await escPage
      .evaluate(() => window.history.back())
      .catch(() => {})
    await escPage.waitForTimeout(800)
    assert.ok(
      !escPage.url().includes("/read/demo-esc"),
      "Esc 返回后浏览器后退不得再次进入阅读器",
    )
    console.log("[E2E] 深链接返回历史通过")

    logStep("400ms 防抖串行与迟到响应不覆盖新预览")
    await resetAppearance()
    await clearLocalMirror(desktopPage)
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForStatus(desktopPage, "已保存")
    await desktopPage.evaluate(() => {
      window.__ireadAccentHistory = []
      new MutationObserver(() => {
        window.__ireadAccentHistory.push(
          document.documentElement.dataset.accent ?? null,
        )
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-accent"],
      })
    })
    let putCount = 0
    const apiPattern = "**/api/v1/settings/appearance"
    const delayedRoute = async (route) => {
      if (route.request().method() === "PUT") {
        putCount += 1
        if (putCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1200))
        }
      }
      await route.continue()
    }
    await desktopPage.route(apiPattern, delayedRoute)
    await selectOption(desktopPage, "强调色", "蓝色")
    await desktopPage.waitForTimeout(500)
    await selectOption(desktopPage, "强调色", "绿色")
    await desktopPage.waitForTimeout(300)
    assert.equal(
      await desktopPage.evaluate(
        () => document.documentElement.dataset.accent,
      ),
      "green",
      "新预览应立即可见",
    )
    const serialSaved = await waitForApiValue({
      ...DEFAULT_VALUE,
      accent: "green",
    })
    await waitForStatus(desktopPage, "已保存")
    assert.equal(putCount, 2, "两次编辑应串行产生两次 PUT")
    const accentHistory = await desktopPage.evaluate(
      () => window.__ireadAccentHistory,
    )
    const firstGreen = accentHistory.indexOf("green")
    assert.ok(firstGreen >= 0, "应观察到绿色预览")
    assert.ok(
      accentHistory
        .slice(firstGreen)
        .every((value) => value === "green"),
      `迟到响应不得把绿色回退为蓝色：${JSON.stringify(accentHistory)}`,
    )
    assert.equal(serialSaved.value.accent, "green")
    await desktopPage.unroute(apiPattern, delayedRoute)
    await resetAppearance()
    console.log("[E2E] seq/迟到响应通过")

    logStep("协议错误：非 JSON 响应明确失败并保留重试")
    await resetAppearance()
    await clearLocalMirror(desktopPage)
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForStatus(desktopPage, "已保存")
    let protocolHit = false
    const protocolPattern = "**/api/v1/settings/appearance"
    const protocolRoute = async (route) => {
      if (route.request().method() === "PUT" && !protocolHit) {
        protocolHit = true
        await route.fulfill({
          status: 200,
          contentType: "text/plain",
          body: "not-json",
        })
        return
      }
      await route.continue()
    }
    await desktopPage.route(protocolPattern, protocolRoute)
    await selectOption(desktopPage, "强调色", "蓝色")
    await desktopPage
      .getByText("未能保存到服务器", { exact: true })
      .first()
      .waitFor({ timeout: 10000 })
    await waitForStatus(desktopPage, "未能保存到服务器")
    await desktopPage.getByRole("button", { name: "重试" }).waitFor()
    assert.equal(protocolHit, true, "应命中一次非 JSON PUT 响应")
    await desktopPage.unroute(protocolPattern, protocolRoute)
    await desktopPage.getByRole("button", { name: "重试" }).click()
    await waitForApiValue({ ...DEFAULT_VALUE, accent: "blue" })
    await waitForStatus(desktopPage, "已保存")
    await resetAppearance()
    console.log("[E2E] 协议错误与重试通过")

    logStep("切换页面不丢本地选择与待同步队列")
    await clearLocalMirror(desktopPage)
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForStatus(desktopPage, "已保存")
    await desktopPage
      .getByRole("radio", { name: "深色", exact: true })
      .click()
    await desktopPage.getByRole("link", { name: "首页" }).first().click()
    await desktopPage
      .getByRole("heading", { level: 1, name: "首页" })
      .waitFor()
    const queuedSave = await waitForApiValue({
      ...DEFAULT_VALUE,
      themeMode: "dark",
    })
    assert.ok(queuedSave.revision !== "0")
    await desktopPage.getByRole("link", { name: "设置" }).first().click()
    await desktopPage
      .getByRole("heading", { level: 1, name: "设置" })
      .waitFor()
    await waitForChecked(
      desktopPage.getByRole("radio", { name: "深色", exact: true }),
    )
    assert.ok(
      await desktopPage.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      ),
    )
    console.log("[E2E] 切换页面保持本地选择与队列通过")

    logStep("切换设置 Tab 不丢本地选择与待同步队列")
    await resetAppearance()
    await clearLocalMirror(desktopPage)
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForStatus(desktopPage, "已保存")
    await selectOption(desktopPage, "强调色", "蓝色")
    await desktopPage.getByRole("tab", { name: "缓存与 PWA" }).click()
    await desktopPage.getByRole("tab", { name: "外观" }).click()
    assert.match(
      (await desktopPage
        .getByRole("combobox", { name: "强调色", exact: true })
        .textContent()) ?? "",
      /蓝色/,
    )
    const tabSaved = await waitForApiValue({
      ...DEFAULT_VALUE,
      accent: "blue",
    })
    assert.equal(tabSaved.value.accent, "blue")
    await waitForStatus(desktopPage, "已保存")
    await resetAppearance()
    console.log("[E2E] 切换 Tab 保持本地选择与队列通过")

    logStep("409：载入服务器设置")
    let record = await resetAppearance()
    const conflictPage = await desktop.newPage()
    await clearLocalMirror(conflictPage)
    await conflictPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForMirrorRevision(conflictPage, record.revision)
    await waitForStatus(conflictPage, "已保存")
    await conflictPage
      .getByRole("radio", { name: "深色", exact: true })
      .click()
    record = await waitForApiValue({
      ...DEFAULT_VALUE,
      themeMode: "dark",
    })
    await waitForMirrorRevision(conflictPage, record.revision)
    await waitForStatus(conflictPage, "已保存")
    const serverChoice = {
      ...DEFAULT_VALUE,
      themeMode: "light",
      lightPreset: "paper",
      accent: "#2563eb",
    }
    const external = await apiPut(record.revision, serverChoice)
    assert.equal(external.status, 200)
    record = external.payload.data
    await conflictPage
      .getByRole("radio", { name: "跟随系统", exact: true })
      .click()
    const dialog = conflictPage.getByRole("alertdialog")
    await dialog.waitFor({ timeout: 10000 })
    await dialog.getByText("设置已在另一处更新").waitFor()
    await waitForStatus(conflictPage, "设置已在另一处更新")
    await conflictPage.waitForTimeout(1000)
    const stillOld = await apiGet()
    assert.equal(stillOld.revision, record.revision, "冲突时不得自动覆盖服务器")
    assert.equal(
      (await conflictPage.locator('[role="status"]').first().textContent())
        ?.trim(),
      "设置已在另一处更新",
      "冲突状态不得自动消失或无限重试",
    )
    await dialog.getByRole("button", { name: "载入服务器设置" }).click()
    await dialog.waitFor({ state: "hidden" })
    await waitForStatus(conflictPage, "已保存")
    await waitForChecked(
      conflictPage.getByRole("radio", { name: "浅色", exact: true }),
    )
    assert.match(
      (await conflictPage.getByLabel("浅色预设").textContent()) ?? "",
      /暖纸/,
    )
    assert.match(
      (await conflictPage
        .getByRole("combobox", { name: "强调色", exact: true })
        .textContent()) ?? "",
      /自定义/,
    )
    assert.equal(
      await conflictPage.getByLabel("自定义强调色").inputValue(),
      "#2563eb",
      "载入服务器自定义强调色后编辑控件应同步",
    )
    const afterLoad = await apiGet()
    assert.equal(afterLoad.value.themeMode, "light")
    assert.equal(afterLoad.value.lightPreset, "paper")
    assert.equal(afterLoad.value.accent, "#2563eb")
    await waitForAppliedCss(conflictPage, "--primary", "#2563eb")
    console.log("[E2E] 载入服务器记录已应用")

    logStep("409：保留本机选择并重新保存")
    record = await apiGet()
    const externalAgain = await apiPut(record.revision, {
      ...DEFAULT_VALUE,
      themeMode: "dark",
      darkPreset: "midnight",
    })
    assert.equal(externalAgain.status, 200)
    record = externalAgain.payload.data
    await selectOption(conflictPage, "浅色预设", "纯白")
    const dialogAgain = conflictPage.getByRole("alertdialog")
    await dialogAgain.waitFor({ timeout: 10000 })
    await dialogAgain
      .getByRole("button", { name: "保留本机选择并重新保存" })
      .click()
    await dialogAgain.waitFor({ state: "hidden" })
    const kept = await waitForApiValue({
      ...DEFAULT_VALUE,
      themeMode: "light",
      lightPreset: "white",
      accent: "#2563eb",
    })
    assert.ok(BigInt(kept.revision) > BigInt(record.revision))
    await waitForStatus(conflictPage, "已保存")
    console.log("[E2E] 两种 409 动作通过")

    logStep("载入服务器设置后更高 revision 可正常应用")
    const higherValue = {
      ...kept.value,
      themeMode: "dark",
      darkPreset: "midnight",
      accent: "green",
    }
    const higher = await apiPut(kept.revision, higherValue)
    assert.equal(higher.status, 200)
    await conflictPage.evaluate(() => {
      window.dispatchEvent(new Event("online"))
    })
    await waitForMirrorRevision(
      conflictPage,
      higher.payload.data.revision,
    )
    await waitForStatus(conflictPage, "已保存")
    const higherUi = await conflictPage.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      darkPreset: document.documentElement.dataset.darkPreset,
      accent: document.documentElement.dataset.accent,
    }))
    assert.deepEqual(higherUi, {
      dark: true,
      darkPreset: "midnight",
      accent: "green",
    })
    const higherServer = await apiGet()
    assert.deepEqual(higherServer.value, higherValue)
    console.log("[E2E] 更高 revision 应用通过")

    logStep("localStorage 失败：提示未能写入本机但仍保存服务器")
    await resetAppearance()
    const noStorage = await newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(noStorage)
    await noStorage.addInitScript(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === "iread.appearance.v1") {
          throw new DOMException("quota", "QuotaExceededError")
        }
        return original.call(this, key, value)
      }
    })
    const noStoragePage = await noStorage.newPage()
    await noStoragePage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForStatus(noStoragePage, "已保存")
    await selectOption(noStoragePage, "强调色", "绿色")
    await noStoragePage
      .getByText("未能写入本机", { exact: true })
      .first()
      .waitFor({ timeout: 10000 })
    const noStorageSaved = await waitForApiValue({
      ...DEFAULT_VALUE,
      accent: "green",
    })
    await waitForStatus(noStoragePage, "已保存")
    assert.equal(noStorageSaved.value.accent, "green")
    console.log("[E2E] localStorage 失败仍保存服务器通过")

    logStep("手机 390x844：Sheet 焦点与返回")
    const mobile = await newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
    })
    contexts.push(mobile)
    const mobilePage = await mobile.newPage()
    await gotoRoute(mobilePage, "/", "首页")
    const trigger = mobilePage.getByRole("button", { name: "切换导航" })
    const triggerBox = await trigger.boundingBox()
    assert.ok(triggerBox !== null)
    assert.ok(
      triggerBox.width >= 44 && triggerBox.height >= 44,
      "手机导航触发按钮触控区应不小于 44px",
    )
    await trigger.click()
    const sheet = mobilePage.getByRole("dialog")
    await sheet.waitFor({ timeout: 5000 })
    const closeButton = mobilePage.getByRole("button", { name: "关闭导航" })
    await closeButton.waitFor({ timeout: 5000 })
    assert.ok(await closeButton.isVisible(), "手机 Sheet 应显示关闭按钮")
    await closeButton.click()
    await sheet.waitFor({ state: "hidden" })
    await mobilePage.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") === "切换导航",
      undefined,
      { timeout: 5000 },
    )

    await trigger.click()
    await sheet.waitFor({ timeout: 5000 })
    await mobilePage.keyboard.press("Escape")
    await sheet.waitFor({ state: "hidden" })
    await mobilePage.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") === "切换导航",
      undefined,
      { timeout: 5000 },
    )

    await trigger.click()
    await sheet.waitFor({ timeout: 5000 })
    for (let index = 0; index < 8; index += 1) {
      await mobilePage.keyboard.press("Tab")
      const inDialog = await mobilePage.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        return dialog !== null && dialog.contains(document.activeElement)
      })
      assert.ok(inDialog, `第 ${index + 1} 次 Tab 后焦点应仍在 Sheet 内`)
    }
    await mobilePage.waitForTimeout(700)
    await mobilePage.screenshot({
      path: `${SCREENSHOT_DIR}/iread-mobile-sheet.png`,
    })
    // 侧栏链接聚焦会打开 Tooltip（另一个 dismissable layer），
    // 因此用遮罩关闭并验证焦点返回。
    await mobilePage.mouse.click(370, 400)
    await sheet.waitFor({ state: "hidden" })
    const focusReturned = await mobilePage.evaluate(() => {
      const active = document.activeElement
      return active?.getAttribute("aria-label") === "切换导航"
    })
    assert.ok(focusReturned, "关闭 Sheet 后焦点应回到触发按钮")
    console.log("[E2E] 手机 Sheet 焦点通过")

    logStep("手机 390x844：其余路由与 404")
    await gotoRoute(mobilePage, "/library", "书库")
    await gotoRoute(
      mobilePage,
      "/books/mobile-book",
      "没有找到这本书",
    )
    await gotoRoute(mobilePage, "/settings", "设置")
    await gotoRoute(mobilePage, "/read/mobile-book", "阅读器")
    await gotoRoute(mobilePage, "/mobile-404", "页面不存在", 404)
    console.log("[E2E] 手机路由通过")

    logStep("Service Worker 与服务器静态头")
    const swResponse = await fetch(url("/sw.js"))
    assert.equal(swResponse.status, 200)
    assert.match(
      swResponse.headers.get("content-type") ?? "",
      /javascript/,
    )
    assert.equal(swResponse.headers.get("service-worker-allowed"), "/")
    assert.equal(swResponse.headers.get("cache-control"), "no-cache")
    const manifestResponse = await fetch(url("/manifest.webmanifest"))
    assert.equal(manifestResponse.status, 200)
    assert.match(
      manifestResponse.headers.get("content-type") ?? "",
      /manifest\+json/,
    )
    assert.equal(manifestResponse.headers.get("cache-control"), "no-cache")
    const manifest = await manifestResponse.json()
    assert.equal(manifest.id, "/")
    assert.equal(manifest.name, "iRead")
    assert.equal(manifest.short_name, "iRead")
    assert.equal(manifest.lang, "zh-CN")
    assert.equal(manifest.start_url, "/")
    assert.equal(manifest.scope, "/")
    assert.equal(manifest.display, "standalone")
    assert.ok(
      manifest.icons.some(
        (icon) => icon.sizes === "192x192" && icon.type === "image/png",
      ),
    )
    assert.ok(
      manifest.icons.some(
        (icon) => icon.sizes === "512x512" && icon.type === "image/png",
      ),
    )
    assert.ok(
      manifest.icons.some(
        (icon) =>
          icon.sizes === "512x512" &&
          String(icon.purpose).includes("maskable"),
      ),
    )
    const appleIcon = await fetch(url("/apple-touch-icon-180x180.png"))
    assert.equal(appleIcon.status, 200)
    const iosMeta = await desktopPage.evaluate(() => ({
      capable:
        document
          .querySelector('meta[name="apple-mobile-web-app-capable"]')
          ?.getAttribute("content") ?? null,
      title:
        document
          .querySelector('meta[name="apple-mobile-web-app-title"]')
          ?.getAttribute("content") ?? null,
      statusBar:
        document
          .querySelector(
            'meta[name="apple-mobile-web-app-status-bar-style"]',
          )
          ?.getAttribute("content") ?? null,
    }))
    assert.deepEqual(iosMeta, {
      capable: "yes",
      title: "iRead",
      statusBar: "default",
    })
    console.log("[E2E] SW/manifest/图标通过")

    logStep("API 与 Range 不进入 Cache Storage")
    await desktopPage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForController(desktopPage)
    await desktopPage.evaluate(async () => {
      await fetch("/api/v1/settings/appearance")
    })
    const rangeProbe = await desktopPage.evaluate(async () => {
      const script = document.querySelector('script[type="module"][src]')
      const target = script?.getAttribute("src") ?? "/iread-icon.svg"
      const response = await fetch(target, {
        headers: { Range: "bytes=0-99" },
      })
      return {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        bytes: (await response.arrayBuffer()).byteLength,
      }
    })
    assert.equal(rangeProbe.status, 206, "Range 请求应返回 206")
    assert.match(
      rangeProbe.contentRange ?? "",
      /^bytes 0-99\/\d+$/,
      "Range 响应应包含 Content-Range",
    )
    assert.equal(rangeProbe.bytes, 100, "Range 响应长度应为 100 字节")
    const cacheReport = await desktopPage.evaluate(async () => {
      const names = await caches.keys()
      const entries = []
      for (const name of names) {
        const cache = await caches.open(name)
        for (const request of await cache.keys()) {
          const response = await cache.match(request)
          entries.push({
            url: request.url,
            status: response?.status ?? 0,
          })
        }
      }
      return { names, entries }
    })
    assert.equal(cacheReport.names.length, 1, "应只有一个 precache")
    assert.match(cacheReport.names[0], /precache/)
    for (const entry of cacheReport.entries) {
      assert.ok(
        !entry.url.includes("/api/"),
        `API 不应被缓存：${entry.url}`,
      )
      assert.ok(
        !/\/books\/|\/read\/|\.epub|\.pdf|\.cbz/.test(entry.url),
        `原件/章节/页面不应被缓存：${entry.url}`,
      )
      assert.notEqual(entry.status, 206, `Range 响应不应被缓存：${entry.url}`)
    }
    console.log(
      `[E2E] Cache Storage 仅 ${cacheReport.entries.length} 个 shell 条目`,
    )

    logStep("设置页“缓存与 PWA”显示真实状态")
    await desktopPage.getByRole("tab", { name: "缓存与 PWA" }).click()
    await desktopPage
      .getByText(/Service Worker 已注册/)
      .first()
      .waitFor({ timeout: 10000 })
    await desktopPage
      .getByText(/应用外壳已缓存/)
      .first()
      .waitFor({ timeout: 10000 })
    await desktopPage.getByRole("button", { name: "检查更新" }).waitFor()
    assert.equal(
      await desktopPage
        .getByRole("button", { name: /清理阅读缓存/ })
        .count(),
      0,
      "阶段5未实施前不得出现清理缓存假按钮",
    )
    console.log("[E2E] PWA 设置状态通过")

    logStep("离线本地保存、online 重试与离线认证门禁")
    const offlineRecord = await resetAppearance()
    const offlinePage = await desktop.newPage()
    await offlinePage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await waitForMirrorRevision(offlinePage, offlineRecord.revision)
    await waitForController(offlinePage)
    await desktop.setOffline(true)

    await offlinePage
      .getByRole("radio", { name: "浅色", exact: true })
      .click()
    await selectOption(offlinePage, "浅色预设", "暖纸")
    await waitForStatus(offlinePage, "已保存在本机，等待同步")
    const offlineMirror = await readMirror(offlinePage)
    assert.equal(offlineMirror.pending.lightPreset, "paper")
    const serverBeforeOnline = await apiGet()
    assert.equal(serverBeforeOnline.revision, offlineRecord.revision)

    await desktop.setOffline(false)
    const onlineSaved = await waitForApiValue({
      ...DEFAULT_VALUE,
      themeMode: "light",
      lightPreset: "paper",
    })
    assert.ok(BigInt(onlineSaved.revision) > BigInt(offlineRecord.revision))
    await waitForStatus(offlinePage, "已保存")
    console.log("[E2E] 离线本地保存与 online 重试通过")

    await desktop.setOffline(true)
    await offlinePage.goto(url("/library"), {
      waitUntil: "domcontentloaded",
    })
    await offlinePage
      .getByRole("heading", { level: 1, name: "无法验证登录状态" })
      .waitFor({ timeout: 10000 })
    await offlinePage
      .getByText("当前处于离线状态，无法建立新会话。请联网后重试。", {
        exact: true,
      })
      .waitFor()
    assert.equal(
      await offlinePage
        .getByRole("heading", { level: 1, name: "书库" })
        .count(),
      0,
      "离线不得绕过登录显示书库",
    )

    await offlinePage.goto(url("/settings?tab=cache"), {
      waitUntil: "domcontentloaded",
    })
    await offlinePage
      .getByRole("heading", { level: 1, name: "无法验证登录状态" })
      .waitFor({ timeout: 10000 })
    await expectDataAttributes(offlinePage, {
      dark: false,
      lightPreset: "paper",
      darkPreset: "template",
      accent: "default",
      density: "standard",
      navCompact: "false",
      contentWidth: "100%",
    })
    console.log("[E2E] 离线 Shell 与认证门禁通过")

    const unknownPage = await desktop.newPage()
    let unknownFailed = false
    try {
      await unknownPage.goto(url("/offline-unknown-route"), {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      })
    } catch {
      unknownFailed = true
    }
    await unknownPage.close()
    assert.ok(unknownFailed, "离线未知路径不应被 NavigationRoute 吞掉")
    console.log("[E2E] 离线未知路径未被吞掉")

    await desktop.setOffline(false)
    console.log("[E2E] 离线主题镜像与认证门禁通过")

    logStep("/read 更新提示不自动刷新（两次真实构建）")
    await desktop.setOffline(false)
    const updateContext = await newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    })
    contexts.push(updateContext)
    const updatePage = await updateContext.newPage()
    await updatePage.goto(url("/read/update-demo"), {
      waitUntil: "domcontentloaded",
    })
    await updatePage
      .getByRole("heading", { level: 1, name: "阅读器" })
      .waitFor()
    await waitForController(updatePage)
    await updatePage.evaluate(() => {
      window.__ireadE2eMarker = "alive"
    })

    const build = spawnSync("pnpm", ["build"], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        IREAD_BUILD_ID: `e2e-update-${Date.now()}`,
      },
      encoding: "utf8",
    })
    assert.equal(build.status, 0, `第二次构建失败：${build.stderr}`)
    updateBuildApplied = true
    const swText = await (await fetch(url("/sw.js"))).text()
    assert.match(swText, /e2e-update-/)

    await updatePage.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration === null) {
        throw new Error("没有 Service Worker registration")
      }
      await registration.update()
    })
    const updateAlert = updatePage
      .locator('[role="alert"]')
      .filter({ hasText: "有新版本可用" })
    await updateAlert.waitFor({ timeout: 20000 })
    await updateAlert
      .getByRole("button", { name: "退出阅读后更新" })
      .waitFor()
    await updateAlert.getByRole("button", { name: "稍后" }).waitFor()
    assert.equal(
      await updateAlert.getByRole("button", { name: "立即更新" }).count(),
      0,
      "阅读页不得出现立即更新按钮",
    )
    await updatePage.screenshot({
      path: `${SCREENSHOT_DIR}/iread-read-update.png`,
    })
    await updatePage.waitForTimeout(1500)
    const marker = await updatePage.evaluate(() => window.__ireadE2eMarker)
    assert.equal(marker, "alive", "阅读页不得自动刷新")
    await updateAlert
      .getByRole("button", { name: "退出阅读后更新" })
      .click()
    await updateAlert.waitFor({ state: "hidden" })

    await updatePage.goto(url("/settings"), {
      waitUntil: "domcontentloaded",
    })
    await updatePage
      .getByRole("heading", { level: 1, name: "设置" })
      .waitFor()
    const globalAlert = updatePage
      .locator('[role="alert"]')
      .filter({ hasText: "有新版本可用" })
    await globalAlert.waitFor({ timeout: 10000 })
    await waitForStatus(updatePage, "已保存")
    const immediateUpdate = globalAlert.getByRole("button", {
      name: "立即更新",
    })
    await selectOption(updatePage, "强调色", "蓝色")
    await updatePage.waitForTimeout(150)
    assert.equal(
      await immediateUpdate.isDisabled(),
      true,
      "外观保存未完成时应禁用立即更新",
    )
    await waitForApiValue({
      ...DEFAULT_VALUE,
      themeMode: "light",
      lightPreset: "paper",
      accent: "blue",
    })
    await waitForStatus(updatePage, "已保存")
    assert.equal(
      await immediateUpdate.isDisabled(),
      false,
      "外观保存完成后应恢复立即更新",
    )
    await immediateUpdate.click()
    await updatePage.waitForLoadState("domcontentloaded")
    await updatePage
      .getByRole("heading", { level: 1, name: "设置" })
      .waitFor({ timeout: 15000 })
    await updatePage.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker.getRegistration()
        return (
          registration !== undefined &&
          registration.waiting === null &&
          registration.active !== null
        )
      },
      undefined,
      { timeout: 15000 },
    )
    console.log("[E2E] /read 更新提示与手动更新通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    if (anonymousApi !== null) {
      await anonymousApi.dispose().catch(() => {})
    }
    if (adminApi !== null) {
      await adminApi.request.dispose().catch(() => {})
    }
    await browser.close().catch(() => {})
    if (updateBuildApplied) {
      const restoreEnv = { ...process.env }
      delete restoreEnv.IREAD_BUILD_ID
      const restore = spawnSync("pnpm", ["build"], {
        cwd: WEB_DIR,
        env: restoreEnv,
        encoding: "utf8",
      })
      if (restore.status !== 0) {
        console.error("恢复默认构建失败：", restore.stderr)
      } else {
        console.log("[E2E] 已恢复默认构建")
      }
    }
  }

  console.log("\n[E2E] 全部通过")
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
