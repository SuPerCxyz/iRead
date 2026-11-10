#!/usr/bin/env node

// 阅读入口矩阵浏览器验收：只使用 web/dist 与 mock DTO，不启动后端。
// 端口自动选择临时端口；运行前需先 pnpm build。

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url))
const DIST_DIR = path.join(WEB_DIR, "dist")

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

function bookDto({
  bookId,
  format,
  status,
  canRead,
  reason,
  progress = null,
  indexTaskId = null,
}) {
  return {
    bookId,
    title: `能力矩阵 ${bookId}`,
    subtitle: null,
    authors: ["测试作者"],
    format,
    byteSize: 2048,
    status,
    cover: null,
    progress,
    readingCapabilities: {
      canRead,
      unavailableReason: reason,
      features: canRead ? ["bookmarks", "settings"] : [],
    },
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    fileVersion: "a".repeat(64),
    originalFileName: `${bookId}.${format}`,
    extension: format,
    metadata: null,
    indexTaskId,
  }
}

function failedTask(taskId, bookId) {
  return {
    schemaVersion: 1,
    taskId,
    kind: "book.index",
    bookId,
    state: "failed",
    attempt: 1,
    revision: "2",
    cancellationRequested: false,
    progress: {
      phase: "finalize",
      completedUnits: 1,
      totalUnits: 2,
    },
    error: {
      code: "index_failed",
      message: "整理失败",
      retryable: true,
    },
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:01:00Z",
  }
}

const appearanceRecord = {
  schemaVersion: 1,
  revision: "1",
  updatedAt: null,
  value: {
    themeMode: "system",
    lightPreset: "template",
    darkPreset: "template",
    accent: "default",
    density: "standard",
    contentWidth: "auto",
    navCompact: false,
  },
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
  try {
    await waitForServer(baseUrl, preview)
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    })
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })

    let currentBook = null
    let currentTask = null

    await page.route("**/api/**", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "not_found",
            message: "未 mock 的接口",
            requestId: "book-capability-e2e",
            details: {},
          },
        }),
      })
    })
    await page.route("**/api/v1/auth/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            initialized: true,
            authenticated: true,
            csrfToken: "book-capability-csrf",
            csrfExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      })
    })
    await page.route("**/api/v1/settings/appearance", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: appearanceRecord }),
      })
    })
    await page.route("**/api/v1/books/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (
        currentBook === null ||
        !/^\/api\/v1\/books\/[^/]+$/.test(pathname)
      ) {
        await route.fulfill({ status: 404, body: "{}" })
        return
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: currentBook }),
      })
    })
    await page.route("**/api/v1/tasks/*", async (route) => {
      if (currentTask === null) {
        await route.fulfill({ status: 404, body: "{}" })
        return
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: currentTask }),
      })
    })

    const openBook = async (book) => {
      currentBook = book
      currentTask = null
      await page.goto(`${baseUrl}/books/${book.bookId}`, {
        waitUntil: "domcontentloaded",
      })
      await page
        .getByRole("heading", { level: 1, name: book.title })
        .waitFor({ timeout: 15000 })
    }

    const startLink = page.getByRole("link", {
      name: "开始阅读",
      exact: true,
    })
    const continueLink = page.getByRole("link", {
      name: "继续阅读",
      exact: true,
    })

    logStep("EPUB ready 且 canRead=true：显示开始阅读并进入阅读器路由")
    const epub = bookDto({
      bookId: "epub-readable",
      format: "epub",
      status: "ready",
      canRead: true,
      reason: "",
    })
    await openBook(epub)
    await startLink.waitFor({ timeout: 10000 })
    assert.match(
      (await startLink.getAttribute("href")) ?? "",
      /^\/read\/epub-readable$/,
      "可读 EPUB 必须链接到 /read/:id",
    )
    const startCount = await startLink.count()
    assert.equal(startCount, 1, "只显示一个开始阅读入口")
    await startLink.click()
    await page.waitForURL(`**/read/${epub.bookId}`, { timeout: 10000 })
    assert.equal(
      new URL(page.url()).pathname,
      `/read/${epub.bookId}`,
      "点击开始阅读必须进入真实阅读器路由",
    )

    logStep("CBR ready 且 canRead=true：显示开始阅读并进入阅读器路由")
    const cbr = bookDto({
      bookId: "cbr-readable",
      format: "cbr",
      status: "ready",
      canRead: true,
      reason: "",
    })
    await openBook(cbr)
    await startLink.waitFor({ timeout: 10000 })
    assert.match(
      (await startLink.getAttribute("href")) ?? "",
      /^\/read\/cbr-readable$/,
      "可读 CBR 必须链接到 /read/:id",
    )
    assert.equal(
      await startLink.count(),
      1,
      "只显示一个 CBR 开始阅读入口",
    )
    assert.equal(
      await page.getByText("CBR 暂不可用", { exact: true }).count(),
      0,
      "可读 CBR 不得显示解析器未就绪文案",
    )
    assert.equal(
      await page.getByText("当前格式暂不支持阅读", { exact: true }).count(),
      0,
      "可读 CBR 不得显示旧的不可读文案",
    )
    await startLink.click()
    await page.waitForURL(`**/read/${cbr.bookId}`, { timeout: 10000 })
    assert.equal(
      new URL(page.url()).pathname,
      `/read/${cbr.bookId}`,
      "点击 CBR 开始阅读必须进入真实阅读器路由",
    )

    logStep("有真实进度时显示继续阅读")
    const continued = bookDto({
      bookId: "pdf-continue",
      format: "pdf",
      status: "ready",
      canRead: true,
      reason: "",
      progress: {
        progressPercent: 37.6,
        updatedAt: "2026-11-10T00:00:00Z",
      },
    })
    await openBook(continued)
    await continueLink.waitFor({ timeout: 10000 })
    assert.match(
      (await continueLink.getAttribute("href")) ?? "",
      /^\/read\/pdf-continue$/,
    )
    await page.getByText("上次阅读到 38%。", { exact: true }).waitFor({
      timeout: 10000,
    })

    const unavailableCases = [
      {
        name: "PDF 加密",
        book: bookDto({
          bookId: "pdf-encrypted",
          format: "pdf",
          status: "ready",
          canRead: false,
          reason: "pdf_encrypted",
        }),
        title: "PDF 受加密保护",
        text: "这份 PDF 已加密",
      },
      {
        name: "EPUB DRM",
        book: bookDto({
          bookId: "epub-drm",
          format: "epub",
          status: "unsupported",
          canRead: false,
          reason: "drm_protected",
        }),
        title: "受 DRM 保护",
        text: "受 DRM 保护",
      },
      {
        name: "CBR 解析器未就绪",
        book: bookDto({
          bookId: "cbr-pending",
          format: "cbr",
          status: "unsupported",
          canRead: false,
          reason: "cbr_parser_pending",
        }),
        title: "CBR 暂不可用",
        text: "CBR 解析暂未就绪",
      },
      {
        name: "加密或多卷 RAR",
        book: bookDto({
          bookId: "cbz-unsupported-archive",
          format: "cbz",
          status: "unsupported",
          canRead: false,
          reason: "unsupported_archive",
        }),
        title: "压缩包无法读取",
        text: "多卷 RAR",
      },
      {
        name: "索引尚未完成",
        book: bookDto({
          bookId: "epub-not-ready",
          format: "epub",
          status: "ready",
          canRead: false,
          reason: "not_ready",
        }),
        title: "正在整理",
        text: "整理完成前暂时不能阅读",
      },
    ]

    for (const scenario of unavailableCases) {
      logStep(`canRead=false：${scenario.name}`)
      await openBook(scenario.book)
      await page
        .getByText(scenario.title, { exact: true })
        .first()
        .waitFor({ timeout: 10000 })
      await page.getByText(scenario.text, { exact: false }).first().waitFor({
        timeout: 10000,
      })
      assert.equal(
        await startLink.count(),
        0,
        `${scenario.name} 不得显示开始阅读`,
      )
      assert.equal(
        await continueLink.count(),
        0,
        `${scenario.name} 不得显示继续阅读`,
      )
    }

    const retryableFailures = [
      {
        name: "EPUB 索引失败",
        book: bookDto({
          bookId: "epub-index-failed",
          format: "epub",
          status: "error",
          canRead: false,
          reason: "index_failed",
          indexTaskId: "task-failed",
        }),
      },
      {
        name: "CBR 索引失败",
        book: bookDto({
          bookId: "cbr-index-failed",
          format: "cbr",
          status: "error",
          canRead: false,
          reason: "cbr_index_failed",
          indexTaskId: "task-cbr-failed",
        }),
      },
    ]

    for (const scenario of retryableFailures) {
      const { book } = scenario
      logStep(`canRead=false 且${scenario.name}：显示整理失败并重试整理`)
      await openBook(book)
      currentTask = failedTask(book.indexTaskId, book.bookId)
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.getByText("整理失败", { exact: true }).first().waitFor({
        timeout: 10000,
      })
      await page
        .getByRole("button", { name: "重试整理", exact: true })
        .waitFor({ timeout: 10000 })
      assert.equal(
        await startLink.count(),
        0,
        `${scenario.name} 不得显示开始阅读`,
      )
      assert.equal(
        await continueLink.count(),
        0,
        `${scenario.name} 不得显示继续阅读`,
      )
    }

    logStep("详情页不提供下载、删除、编辑或转换")
    for (const label of ["下载", "删除", "编辑", "转换"]) {
      assert.equal(
        await page.getByRole("button", { name: label, exact: true }).count(),
        0,
        `详情页不得显示${label}`,
      )
    }

    console.log("\n[E2E] 阅读入口矩阵全部通过")
  } finally {
    await browser?.close()
    preview.kill("SIGTERM")
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
