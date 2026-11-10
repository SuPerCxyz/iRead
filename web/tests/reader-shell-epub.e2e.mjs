#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"

import { chromium, request as playwrightRequest } from "playwright"

import {
  AuthedApi,
  E2E_PASSWORD,
  E2EBlocked,
  createAuthenticatedStorageState,
  ensureAdmin,
} from "./auth-helpers.mjs"
import { assertReaderToolbarLayout } from "./reader-toolbar-layout.mjs"

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
let serverPort = Number(process.env.IREAD_E2E_SERVER_PORT ?? "18080")
let webPort = Number(process.env.IREAD_E2E_WEB_PORT ?? "18081")
let serverBase = `http://127.0.0.1:${serverPort}`
let webBase = `http://127.0.0.1:${webPort}`
const SCREENSHOT_DIR =
  process.env.READER_SHELL_EPUB_SCREENSHOT_DIR ??
  path.join("/tmp/opencode", "iread-reader-shell-epub-screenshots")
const TEMP_ROOT = process.env.IREAD_E2E_TMP ?? "/tmp/opencode"

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipEntries(entries) {
  const localChunks = []
  const centralChunks = []
  let offset = 0
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data)
    let payload = data
    let method = 0
    if (!entry.store && data.length > 0) {
      const compressed = deflateRawSync(data)
      if (compressed.length < data.length) {
        payload = compressed
        method = 8
      }
    }
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)
    offset += local.length + name.length + payload.length
  }
  const centralDirectory = Buffer.concat(centralChunks)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, centralDirectory, end])
}

const CHAPTERS = [
  {
    file: "chapter1.xhtml",
    title: "第一章",
    body: `<h1 id="chapter1">第一章</h1>
      <p id="p-1">第一章正文：这是真实 EPUB 章节，用于验证共享 Shell 的正文渲染。</p>
      ${Array.from({ length: 8 }, (_, index) => `<p>第一章长段落 ${index + 1}。重复文字用于形成分页后的多页内容。</p>`).join("\n")}
      <script type="text/javascript">window.parent.__ireadPwned = 1; fetch("https://example.com/script");</script>
      <iframe src="https://example.com/frame"></iframe>
      <img src="https://example.com/evil.png" onerror="window.parent.__ireadPwned = 1"/>
      <a href="javascript:window.parent.__ireadPwned = 1">javascript 链接</a>`,
  },
  {
    file: "chapter2.xhtml",
    title: "第二章",
    body: `<h1 id="chapter2">第二章</h1>
      <p id="chapter2-mid">第二章中段：用于验证目录跳转、字号重排与翻页。</p>
      ${Array.from({ length: 14 }, (_, index) => `<p>第二章长段落 ${index + 1}。字号重排后应仍停留在本章附近。</p>`).join("\n")}`,
  },
  {
    file: "chapter3.xhtml",
    title: "第三章",
    body: `<h1 id="chapter3">第三章</h1>
      <p id="chapter3-mid">第三章正文：用于验证章节失败后的局部重试。</p>
      ${Array.from({ length: 5 }, (_, index) => `<p>第三章段落 ${index + 1}。</p>`).join("\n")}`,
  },
]

function makeEpub(stamp) {
  const items = []
  const spine = []
  const nav = []
  for (const [index, chapter] of CHAPTERS.entries()) {
    const id = `c${index + 1}`
    const href = `Text/${chapter.file}`
    items.push(`    <item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`)
    spine.push(`    <itemref idref="${id}"/>`)
    nav.push(`      <li><a href="${href}#${chapter.file.replace(".xhtml", "")}">${chapter.title}</a></li>`)
  }
  const title = `Reader Shell EPUB 实读 ${stamp}`
  return {
    title,
    data: zipEntries([
      { name: "mimetype", data: "application/epub+zip", store: true },
      {
        name: "META-INF/container.xml",
        data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
      },
      {
        name: "OEBPS/content.opf",
        data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>iRead Shell E2E</dc:creator>
    <dc:identifier id="id">urn:uuid:reader-shell-epub-${stamp}</dc:identifier>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-10T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="publisher-css" href="Styles/publisher.css" media-type="text/css"/>
${items.join("\n")}
  </manifest>
  <spine>
${spine.join("\n")}
  </spine>
</package>`,
      },
      {
        name: "OEBPS/Styles/publisher.css",
        data: `/* 出版方直接给 p/h1 声明字号、字体和颜色，用于验证用户设置优先。 */
p {
  font-size: 40px;
  font-family: monospace;
  color: rgb(255, 0, 0);
  margin-block: 2em;
  text-indent: 2em;
  line-height: 3;
}
h1 {
  font-size: 48px;
  color: rgb(0, 128, 0);
}`,
      },
      {
        name: "OEBPS/nav.xhtml",
        data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${nav.join("\n")}
  </ol></nav></body>
</html>`,
      },
      ...CHAPTERS.map((chapter) => ({
        name: `OEBPS/Text/${chapter.file}`,
        data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${chapter.title}</title><link rel="stylesheet" type="text/css" href="../Styles/publisher.css"/></head>
  <body>${chapter.body}</body>
</html>`,
      })),
    ]),
  }
}

async function httpReachable(target) {
  try {
    const response = await fetch(target, { redirect: "manual" })
    return response.status > 0 && response.status < 500
  } catch {
    return false
  }
}

function portFree(port) {
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
  for (let port = start; port < start + 200; port += 1) {
    if (await portFree(port)) {
      return port
    }
  }
  throw new Error(`无法在 ${start} 起找到空闲端口`)
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
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
  return { child, output: () => output }
}

function stopProcess(run) {
  if (run === undefined || run === null) {
    return
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-run.child.pid, "SIGTERM")
    } else {
      run.child.kill("SIGTERM")
    }
  } catch {
    try {
      run.child.kill("SIGTERM")
    } catch {
      // 进程已退出。
    }
  }
}

async function waitForHttp(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await httpReachable(target)) {
      return
    }
    await sleep(250)
  }
  throw new Error(`等待 ${target} 超时`)
}

async function ensureServers(cleanup) {
  const tempRoot = mkdtempSync(path.join(TEMP_ROOT, "iread-shell-epub-e2e-"))
  const dirs = {
    books: path.join(tempRoot, "books"),
    db: path.join(tempRoot, "db"),
    cache: path.join(tempRoot, "cache"),
    web: path.join(tempRoot, "web"),
  }
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(
    path.join(dirs.web, "index.html"),
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  )
  if (await httpReachable(`${serverBase}/healthz`)) {
    serverPort = await findFreePort(serverPort + 100)
    serverBase = `http://127.0.0.1:${serverPort}`
    webPort = await findFreePort(webPort + 100)
    webBase = `http://127.0.0.1:${webPort}`
    console.log(
      `[E2E] 首选端口已被占用，改用临时端口 ${serverPort}/${webPort}`,
    )
  }
  if (!(await portFree(serverPort))) {
    serverPort = await findFreePort(serverPort + 100)
    serverBase = `http://127.0.0.1:${serverPort}`
  }
  if (!(await portFree(webPort))) {
    webPort = await findFreePort(webPort + 100)
    webBase = `http://127.0.0.1:${webPort}`
  }
  if (webPort === serverPort) {
    webPort = await findFreePort(webPort + 1)
    webBase = `http://127.0.0.1:${webPort}`
  }
  const server = startProcess("go", ["run", "./cmd/iread"], {
    cwd: path.join(REPO_ROOT, "server"),
    env: {
      ...process.env,
      IREAD_ADDR: `127.0.0.1:${serverPort}`,
      IREAD_PUBLIC_ORIGIN: webBase,
      IREAD_BOOKS_DIR: dirs.books,
      IREAD_DB_DIR: dirs.db,
      IREAD_CACHE_DIR: dirs.cache,
      IREAD_WEB_DIR: dirs.web,
      IREAD_LOG_LEVEL: "warn",
    },
  })
  cleanup.push(() => stopProcess(server))
  await waitForHttp(`${serverBase}/healthz`, 90_000)
  const vite = startProcess(
    "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: WEB_ROOT,
      env: { ...process.env, IREAD_DEV_API: serverBase },
    },
  )
  cleanup.push(() => stopProcess(vite))
  await waitForHttp(`${webBase}/`, 60_000)
  console.log(`[E2E] 临时 Go 服务 ${serverBase}，Vite ${webBase}，数据 ${tempRoot}`)
}

async function uploadEpub(api, fileName, data) {
  const intent = await api.post("/api/v1/uploads", {
    clientUploadId: `shell-epub-${Date.now()}-${fileName}`,
    fileName,
    byteSize: data.length,
  })
  assert.ok(
    intent.status === 200 || intent.status === 201,
    `创建上传意图失败：HTTP ${intent.status} ${JSON.stringify(intent.payload)}`,
  )
  const uploadId = intent.payload?.data?.uploadId
  assert.equal(typeof uploadId, "string")
  const put = await api.request.fetch(
    `${webBase}/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/epub+zip",
        Origin: webBase,
        "X-CSRF-Token": api.csrfToken ?? "",
      },
      data,
      failOnStatusCode: false,
    },
  )
  const putPayload = JSON.parse((await put.text()) || "{}")
  assert.equal(
    put.status(),
    200,
    `上传 EPUB 失败：HTTP ${put.status()} ${JSON.stringify(putPayload)}`,
  )
  const stored = putPayload.data
  const bookId = stored?.bookId ?? stored?.duplicateOfBookId
  assert.equal(typeof bookId, "string", "上传响应缺少 bookId")
  const deadline = Date.now() + 90_000
  let detail = null
  while (Date.now() < deadline) {
    const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}`)
    if (response.status === 200) {
      detail = response.payload?.data
      if (detail?.status === "ready") {
        break
      }
      if (detail?.status === "error" || detail?.status === "unsupported") {
        throw new Error(`书籍未就绪：${JSON.stringify(detail)}`)
      }
    }
    await sleep(300)
  }
  assert.equal(detail?.status, "ready", `等待书籍 ready 超时：${JSON.stringify(detail)}`)
  const manifestResponse = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/manifest`,
  )
  assert.equal(manifestResponse.status, 200)
  const manifest = manifestResponse.payload?.data
  assert.equal(manifest?.format, "epub")
  assert.equal(manifest.readingCapabilities.canRead, true)
  return { bookId, detail, manifest }
}

function resourceIdForHref(manifest, href) {
  for (const [resourceId, resource] of Object.entries(
    manifest.formatData.resources,
  )) {
    if (resource.href === href) {
      return resourceId
    }
  }
  return null
}

function spineIndexFor(manifest, href) {
  const index = manifest.formatData.spine.findIndex((item) => item.href === href)
  assert.ok(index >= 0, `spine 中找不到 ${href}`)
  return index
}

async function epubSnapshot(page) {
  return page.evaluate(() => {
    const view = document.querySelector("[data-reader-epub] foliate-view")
    if (view === null) {
      return null
    }
    const contents = view.renderer?.getContents?.() ?? []
    const doc = contents[0]?.doc ?? null
    let pageIndex = null
    let pages = null
    try {
      pageIndex = view.renderer?.page ?? null
    } catch {
      // 重挂载瞬间 renderer 可能尚未绑定视图，位置快照允许暂时缺失。
    }
    try {
      pages = view.renderer?.pages ?? null
    } catch {
      // 同上。
    }
    return {
      text: doc?.body?.innerText ?? "",
      index: contents[0]?.index ?? null,
      page: pageIndex,
      pages,
    }
  })
}

async function paragraphStyle(page, selector = "#p-1") {
  return page.evaluate((target) => {
    const doc = document
      .querySelector("[data-reader-epub] foliate-view")
      ?.renderer?.getContents?.()[0]?.doc
    const node = doc?.querySelector(target)
    if (!doc || !node) {
      return null
    }
    const style = getComputedStyle(node)
    return {
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      color: style.color,
      marginBlockStart: style.marginBlockStart,
      textIndent: style.textIndent,
      html: doc.documentElement.outerHTML,
    }
  }, selector)
}

async function waitForParagraphStyle(page, expected, timeout = 10_000) {
  await page.waitForFunction(
    (target) => {
      const doc = document
        .querySelector("[data-reader-epub] foliate-view")
        ?.renderer?.getContents?.()[0]?.doc
      const node = doc?.querySelector("#p-1")
      if (!doc || !node) {
        return false
      }
      const style = getComputedStyle(node)
      return (
        style.fontSize === target.fontSize &&
        style.color === target.color &&
        style.marginBlockStart === target.marginBlockStart &&
        style.textIndent === target.textIndent &&
        (target.familyIncludes === undefined ||
          style.fontFamily.includes(target.familyIncludes)) &&
        (target.familyExcludes === undefined ||
          !style.fontFamily.includes(target.familyExcludes))
      )
    },
    expected,
    { timeout },
  )
}

async function waitForEpubText(page, needle, timeout = 20_000) {
  await page.waitForFunction(
    (expected) => {
      const view = document.querySelector("[data-reader-epub] foliate-view")
      const contents = view?.renderer?.getContents?.() ?? []
      return (contents[0]?.doc?.body?.innerText ?? "").includes(expected)
    },
    needle,
    { timeout },
  )
}

async function waitForEpubIndex(page, index, timeout = 20_000) {
  await page.waitForFunction(
    (expected) => {
      const view = document.querySelector("[data-reader-epub] foliate-view")
      const contents = view?.renderer?.getContents?.() ?? []
      return contents[0]?.index === expected
    },
    index,
    { timeout },
  )
}

async function positionText(page) {
  return (await page.locator(".iread-reader-shell__position-text").textContent()) ?? ""
}

async function waitForStablePosition(page, timeout = 8_000) {
  const deadline = Date.now() + timeout
  let last = await positionText(page)
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await page.waitForTimeout(150)
    const next = await positionText(page)
    if (next === last) {
      if (Date.now() - stableSince >= 750) {
        return next
      }
    } else {
      last = next
      stableSince = Date.now()
    }
  }
  return last
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const cleanup = []
  const contexts = []
  const apiContexts = []
  let browser = null
  try {
    await ensureServers(cleanup)
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--no-sandbox"],
    })
    const storageState = await createAuthenticatedStorageState(
      browser,
      webBase,
      E2E_PASSWORD,
    )
    const adminRequest = await playwrightRequest.newContext({
      baseURL: webBase,
      storageState,
    })
    apiContexts.push(adminRequest)
    const adminApi = new AuthedApi(adminRequest, webBase)
    await ensureAdmin(adminApi, webBase, E2E_PASSWORD)

    logStep("上传真实 EPUB 并准备全局字号")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const sample = makeEpub(stamp)
    const { bookId, manifest } = await uploadEpub(
      adminApi,
      `shell-epub-${stamp}.epub`,
      sample.data,
    )
    const globalGet = await adminApi.get("/api/v1/settings/reader")
    assert.equal(globalGet.status, 200)
    const globalPut = await adminApi.put("/api/v1/settings/reader", {
      schemaVersion: 1,
      baseRevision: globalGet.payload?.data?.revision ?? "0",
      value: { reflow: { fontSize: 20 } },
    })
    assert.equal(globalPut.status, 200, `全局设置失败：${JSON.stringify(globalPut.payload)}`)

    const desktopContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(desktopContext)
    const desktop = await desktopContext.newPage()
    const pageErrors = []
    desktop.on("pageerror", (error) => pageErrors.push(error.message))
    // 记录引擎首次标记 ready 时的正文 computed style，防止首帧先读到
    // 出版方 40px/monospace/red 再被后续样式修正。
    await desktop.addInitScript(() => {
      window.__ireadFirstReadyStyle = null
      const record = () => {
        if (window.__ireadFirstReadyStyle !== null) {
          return
        }
        if (document.querySelector("[data-reader-engine-ready]") === null) {
          return
        }
        const doc = document
          .querySelector("[data-reader-epub] foliate-view")
          ?.renderer?.getContents?.()[0]?.doc
        const node = doc?.querySelector("#p-1")
        if (!doc || !node) {
          return
        }
        const style = getComputedStyle(node)
        window.__ireadFirstReadyStyle = {
          fontSize: style.fontSize,
          fontFamily: style.fontFamily,
          color: style.color,
        }
      }
      const observer = new MutationObserver(record)
      observer.observe(document, {
        attributes: true,
        subtree: true,
        attributeFilter: ["data-reader-engine-ready"],
      })
    })

    // S5 预取会在阅读过程中提前请求相邻章节。故障注入必须从首次导航前开始，
    // 确保第三章资源从未写入 L1/L3；否则预取缓存会让后面的 500 路由不被命中。
    const chapter3Id = resourceIdForHref(manifest, "OEBPS/Text/chapter3.xhtml")
    assert.ok(chapter3Id)
    const chapter3Pattern = `**/resources/${chapter3Id}`
    let failedChapterRequests = 0
    await desktop.route(chapter3Pattern, async (route) => {
      failedChapterRequests += 1
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "storage_unavailable",
            message: "e2e forced chapter failure",
            requestId: "",
            details: {},
          },
        }),
      })
    })

    logStep("桌面：真实 /read/:id 渲染 EPUB 正文与主题字号")
    await desktop.goto(`/read/${bookId}`, { waitUntil: "domcontentloaded" })
    await desktop
      .getByRole("heading", { level: 1, name: sample.title })
      .waitFor({ timeout: 20_000 })
    await desktop.locator("[data-reader-epub] foliate-view").waitFor({
      timeout: 20_000,
    })
    await waitForEpubText(desktop, "第一章正文")
    assert.equal(
      await desktop.locator(".iread-reader-shell__placeholder-text").count(),
      0,
      "EPUB 不应再显示 Shell 占位正文",
    )
    assert.equal(pageErrors.length, 0, `页面脚本错误：${pageErrors.join("; ")}`)
    const firstFontSize = await desktop.evaluate(() => {
      const doc = document
        .querySelector("[data-reader-epub] foliate-view")
        ?.renderer?.getContents?.()[0]?.doc
      return doc === null || doc === undefined
        ? null
        : getComputedStyle(doc.body).fontSize
    })
    assert.equal(firstFontSize, "20px", "全局字号没有映射到 EPUB 引擎")
    const security = await desktop.evaluate(() => {
      const view = document.querySelector("[data-reader-epub] foliate-view")
      const doc = view.renderer.getContents()[0].doc
      const frameElement = doc.defaultView?.frameElement
      return {
        pwned: Boolean(window.__ireadPwned),
        dangerous: doc.querySelectorAll("script, iframe, object, embed, form").length,
        sandbox: frameElement?.getAttribute("sandbox") ?? "",
        csp:
          doc
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute("content") ?? "",
      }
    })
    assert.equal(security.pwned, false, "恶意脚本在顶层文档执行")
    assert.equal(security.dangerous, 0, "危险元素未被清洗")
    assert.match(security.sandbox, /allow-same-origin/)
    assert.match(security.csp, /script-src 'none'/)
    await desktop.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-first-chapter.png"),
    })

    logStep("出版方 CSS 不覆盖用户字号/字体/文字色，首帧即生效")
    const firstReadyStyle = await desktop.evaluate(
      () => window.__ireadFirstReadyStyle,
    )
    assert.ok(firstReadyStyle, "引擎就绪时未找到正文段落")
    assert.equal(
      firstReadyStyle.fontSize,
      "20px",
      "引擎就绪首帧仍是出版方字号",
    )
    assert.match(
      firstReadyStyle.fontFamily,
      /monospace/,
      "publisherFont 打开时出版方字体应保留",
    )
    assert.notEqual(
      firstReadyStyle.color,
      "rgb(255, 0, 0)",
      "出版方文字色覆盖了用户主题色",
    )
    const initialParagraph = await paragraphStyle(desktop)
    assert.equal(initialParagraph.fontSize, "20px")
    assert.match(initialParagraph.fontFamily, /monospace/)
    assert.notEqual(initialParagraph.color, "rgb(255, 0, 0)")
    console.log(
      `[E2E] 首帧 p computed：font-size=${firstReadyStyle.fontSize} font-family=${firstReadyStyle.fontFamily} color=${firstReadyStyle.color}`,
    )

    logStep("用户字体/文字色/段距/缩进覆盖出版方 p 样式并持久化")
    const styledGlobalGet = await adminApi.get("/api/v1/settings/reader")
    assert.equal(styledGlobalGet.status, 200)
    const styledGlobalPut = await adminApi.put("/api/v1/settings/reader", {
      schemaVersion: 1,
      baseRevision: styledGlobalGet.payload?.data?.revision ?? "0",
      value: {
        reflow: {
          theme: "white",
          fontFamily: "publisher",
          publisherFont: true,
          fontSize: 20,
          paragraphSpacing: 0.6,
          textIndent: 1,
          background: "#ffffff",
          text: "#222222",
          link: "#123456",
          selection: "#cccccc",
          publisherCSSMode: "publisher",
        },
      },
    })
    assert.equal(
      styledGlobalPut.status,
      200,
      `用户排版设置保存失败：${JSON.stringify(styledGlobalPut.payload)}`,
    )
    await desktop.reload({ waitUntil: "domcontentloaded" })
    await desktop.waitForSelector("[data-reader-engine-ready]", {
      timeout: 30_000,
    })
    await waitForEpubText(desktop, "第一章正文")
    const styledExpectation = {
      fontSize: "20px",
      color: "rgb(34, 34, 34)",
      marginBlockStart: "12px",
      textIndent: "20px",
      familyIncludes: "monospace",
    }
    await waitForParagraphStyle(desktop, styledExpectation)
    const styledParagraph = await paragraphStyle(desktop)
    assert.match(
      styledParagraph.html,
      /font-size:\s*40px/,
      "出版方 CSS 开启时未加载出版方样式",
    )
    console.log(
      `[E2E] 用户设置 p computed：font-size=${styledParagraph.fontSize} font-family=${styledParagraph.fontFamily} color=${styledParagraph.color} margin=${styledParagraph.marginBlockStart} indent=${styledParagraph.textIndent}`,
    )

    await desktop.getByRole("button", { name: "阅读设置" }).click()
    const styledPanel = desktop.locator('[data-reader-panel="settings"]')
    await styledPanel.waitFor({ timeout: 5000 })
    await desktop.locator("#reader-setting-reflow-fontFamily").click()
    await desktop.getByRole("option", { name: "衬线", exact: true }).click()
    await waitForParagraphStyle(desktop, {
      ...styledExpectation,
      familyIncludes: "Georgia",
      familyExcludes: "monospace",
    })
    await desktop.locator('[data-reader-autosave="saved"]').waitFor({
      timeout: 10_000,
    })

    await desktop.locator("#reader-setting-reflow-fontFamily").click()
    await desktop.getByRole("option", { name: "出版方字体", exact: true }).click()
    await waitForParagraphStyle(desktop, {
      ...styledExpectation,
      familyIncludes: "monospace",
    })
    await desktop.getByRole("switch", { name: "允许出版方字体" }).click()
    await waitForParagraphStyle(desktop, {
      ...styledExpectation,
      familyIncludes: "system-ui",
      familyExcludes: "monospace",
    })
    await desktop.locator('[data-reader-autosave="saved"]').waitFor({
      timeout: 10_000,
    })

    await desktop.locator("#reader-setting-reflow-publisherCSSMode").click()
    await desktop
      .getByRole("option", { name: "不加载出版方样式", exact: true })
      .click()
    await waitForEpubText(desktop, "第一章正文")
    await waitForParagraphStyle(desktop, {
      ...styledExpectation,
      familyIncludes: "system-ui",
      familyExcludes: "monospace",
    })
    const publisherOffParagraph = await paragraphStyle(desktop)
    assert.equal(
      publisherOffParagraph.html.includes("font-size: 40px"),
      false,
      "publisherCSSMode=off 后仍加载出版方样式",
    )
    await desktop.locator('[data-reader-autosave="saved"]').waitFor({
      timeout: 10_000,
    })

    await desktop.reload({ waitUntil: "domcontentloaded" })
    await desktop.waitForSelector("[data-reader-engine-ready]", {
      timeout: 30_000,
    })
    await waitForEpubText(desktop, "第一章正文")
    await waitForParagraphStyle(desktop, {
      ...styledExpectation,
      familyIncludes: "system-ui",
      familyExcludes: "monospace",
    })
    const reopenedParagraph = await paragraphStyle(desktop)
    assert.equal(
      reopenedParagraph.html.includes("font-size: 40px"),
      false,
      "重开后 publisherCSSMode=off 未保持",
    )
    assert.equal(reopenedParagraph.fontSize, "20px")
    assert.equal(reopenedParagraph.color, "rgb(34, 34, 34)")
    assert.equal(reopenedParagraph.marginBlockStart, "12px")
    assert.equal(reopenedParagraph.textIndent, "20px")
    console.log(
      `[E2E] 重开 p computed：font-size=${reopenedParagraph.fontSize} font-family=${reopenedParagraph.fontFamily} color=${reopenedParagraph.color} margin=${reopenedParagraph.marginBlockStart} indent=${reopenedParagraph.textIndent}`,
    )

    logStep("桌面：目录跳转、翻页与 CFI 书签")
    await desktop.getByRole("button", { name: "目录与书签" }).click()
    const tocPanel = desktop.locator('[data-reader-panel="toc"]')
    await tocPanel.waitFor({ timeout: 5000 })
    const tocItems = desktop.locator(".iread-reader-toc__item")
    assert.equal(await tocItems.count(), CHAPTERS.length)
    await desktop
      .locator(".iread-reader-toc__item", { hasText: "第二章" })
      .first()
      .click()
    await tocPanel.waitFor({ state: "hidden" })
    await waitForEpubText(desktop, "第二章中段")
    assert.equal((await epubSnapshot(desktop)).index, 1)

    await desktop.getByRole("button", { name: "目录与书签" }).click()
    await desktop.getByRole("tab", { name: "书签" }).click()
    await desktop.getByRole("button", { name: "添加当前位置书签" }).click()
    await desktop.getByText("书签已添加", { exact: true }).waitFor()
    const bookmarkList = await adminApi.get(
      `/api/v1/books/${bookId}/bookmarks?fileVersion=${manifest.fileVersion}`,
    )
    assert.equal(bookmarkList.status, 200)
    assert.equal(bookmarkList.payload?.data?.length, 1)
    const bookmark = bookmarkList.payload.data[0]
    assert.equal(bookmark.locatorType, "epub-cfi", "书签应使用真实 CFI")
    assert.match(bookmark.locatorPayload.cfi, /^epubcfi\(/)
    assert.equal(bookmark.label, "第二章", "书签应使用当前章节标题")
    await desktop
      .getByRole("button", { name: new RegExp(`移除书签`) })
      .click()
    await desktop.getByText("书签已移除", { exact: true }).waitFor()
    await desktop.keyboard.press("Escape")
    await tocPanel.waitFor({ state: "hidden" })

    const beforeTurn = await epubSnapshot(desktop)
    const beforeTurnPosition = await positionText(desktop)
    await desktop.getByRole("button", { name: "下一处" }).click()
    await desktop.waitForFunction(
      (previous) => {
        const view = document.querySelector("[data-reader-epub] foliate-view")
        const contents = view?.renderer?.getContents?.() ?? []
        const state = {
          index: contents[0]?.index ?? null,
          page: view?.renderer?.page ?? null,
        }
        return JSON.stringify(state) !== JSON.stringify(previous)
      },
      { index: beforeTurn.index, page: beforeTurn.page },
      { timeout: 5000 },
    )
    assert.notEqual(await positionText(desktop), beforeTurnPosition, "翻页后位置文本未变化")

    logStep("桌面：字号重排保持章节")
    const beforeReflow = await epubSnapshot(desktop)
    await desktop.getByRole("button", { name: "阅读设置" }).click()
    const settingsPanel = desktop.locator('[data-reader-panel="settings"]')
    await settingsPanel.waitFor({ timeout: 5000 })
    const fontRow = settingsPanel
      .locator(".iread-reader-settings__field")
      .filter({ hasText: "字号" })
    const fontSizeSlider = fontRow.getByRole("slider")
    await fontSizeSlider.press("ArrowUp")
    await fontSizeSlider.press("ArrowUp")
    await desktop.waitForTimeout(900)
    await desktop.waitForFunction(
      () => {
        const doc = document
          .querySelector("[data-reader-epub] foliate-view")
          ?.renderer?.getContents?.()[0]?.doc
        return doc !== undefined && getComputedStyle(doc.body).fontSize !== "20px"
      },
      undefined,
      { timeout: 5000 },
    )
    await desktop.waitForTimeout(500)
    const afterReflow = await epubSnapshot(desktop)
    assert.equal(afterReflow.index, beforeReflow.index, "字号重排跳到了其他章节")
    assert.ok((afterReflow.page ?? 0) >= 0, "重排后没有分页状态")
    await desktop.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-reflow.png"),
    })
    await desktop.keyboard.press("Escape")
    await settingsPanel.waitFor({ state: "hidden" })

    logStep("桌面：章节失败局部重试，不整屏 Loading")
    const failureRequestsBefore = failedChapterRequests
    await desktop.getByRole("button", { name: "目录与书签" }).click()
    await desktop
      .locator(".iread-reader-toc__item", { hasText: "第三章" })
      .first()
      .click()
    const failureAlert = desktop.locator("[data-reader-chapter-failure]")
    await failureAlert.waitFor({ timeout: 10_000 })
    assert.ok(
      failedChapterRequests >= failureRequestsBefore,
      "章节失败请求计数不应回退；允许复用仍在途/失败的同资源请求",
    )
    assert.ok(failedChapterRequests >= 1, "未触发章节失败请求")
    assert.match((await failureAlert.textContent()) ?? "", /本章节未能加载/)
    assert.equal(
      await desktop.locator(".iread-reader-shell__placeholder").count(),
      0,
      "章节失败不应退化为整屏 Loading/占位",
    )
    assert.equal(
      await desktop.locator("[data-reader-epub] foliate-view").count(),
      1,
      "章节失败不应移除已有阅读界面",
    )
    await desktop.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-chapter-failure.png"),
    })
    await desktop.unroute(chapter3Pattern)
    await failureAlert.locator("button", { hasText: "重试" }).click()
    await waitForEpubText(desktop, "第三章正文")
    await failureAlert.waitFor({ state: "hidden", timeout: 10_000 })
    await waitForEpubIndex(desktop, 2)
    assert.equal((await epubSnapshot(desktop)).index, 2)
    await desktop.waitForTimeout(700)

    // 重试后的落点可能停在章节中段；翻到末页再退出，确保保存/恢复的是
    // 一个稳定且确定的 CFI 位置（第三章是全书最后一章，末页即 100%）。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await positionText(desktop)).includes("位置 100%")) {
        break
      }
      await desktop.getByRole("button", { name: "下一处" }).click()
      await waitForStablePosition(desktop)
    }
    assert.match(
      await positionText(desktop),
      /位置 100%/,
      "退出前未能稳定停在章节末页",
    )

    logStep("桌面：退出保存 CFI 进度并重开恢复")
    const beforeExitPosition = await waitForStablePosition(desktop)
    const beforeExitSnapshot = await epubSnapshot(desktop)
    assert.match(beforeExitSnapshot.text, /第三章正文/)
    console.log(`[E2E] 退出前位置：${beforeExitPosition}`)
    await desktop.getByRole("button", { name: "返回书库" }).click()
    await desktop.waitForFunction(
      () => window.location.pathname === "/library",
      undefined,
      { timeout: 5000 },
    )
    const savedProgress = await adminApi.get(`/api/v1/books/${bookId}/progress`)
    assert.equal(savedProgress.status, 200)
    assert.equal(savedProgress.payload?.data?.locatorType, "epub-cfi")
    assert.match(savedProgress.payload?.data?.locatorPayload?.cfi ?? "", /^epubcfi\(/)
    const savedPercent = savedProgress.payload?.data?.progressPercent
    assert.ok(typeof savedPercent === "number" && savedPercent > 0)
    assert.equal(
      Math.round(savedPercent),
      100,
      `退出未保存章节末页：server=${savedPercent}`,
    )
    const localSnapshot = await desktop.evaluate((targetBookId) => {
      const raw = window.localStorage.getItem(
        `iread.reader-snapshot.v1:${targetBookId}`,
      )
      return raw === null ? null : JSON.parse(raw)
    }, bookId)
    if (localSnapshot !== null) {
      assert.equal(
        localSnapshot.fileVersion,
        manifest.fileVersion,
        "退出快照的 fileVersion 不一致",
      )
      assert.equal(
        Math.round(localSnapshot.progressPercent),
        100,
        `退出快照不是章节末页：local=${localSnapshot.progressPercent}`,
      )
    }
    const expectedPercent = 100
    console.log(
      `[E2E] 退出持久化：server=${savedPercent}% local=${localSnapshot?.progressPercent ?? "无"}%`,
    )

    await desktop.goto(`/read/${bookId}`, { waitUntil: "domcontentloaded" })
    await desktop.locator("[data-reader-epub] foliate-view").waitFor({
      timeout: 20_000,
    })
    await waitForEpubText(desktop, "第三章正文")
    await desktop.waitForFunction(
      (expected) =>
        ((document.querySelector(".iread-reader-shell__position-text")
          ?.textContent) ?? "").includes(`位置 ${Math.round(expected)}%`),
      expectedPercent,
      { timeout: 10_000 },
    )
    await waitForEpubIndex(
      desktop,
      spineIndexFor(manifest, "OEBPS/Text/chapter3.xhtml"),
    )
    assert.equal(
      (await epubSnapshot(desktop)).index,
      spineIndexFor(manifest, "OEBPS/Text/chapter3.xhtml"),
      "重开后没有恢复到保存的章节",
    )
    console.log(`[E2E] 重开恢复：${beforeExitPosition} -> ${await positionText(desktop)}`)

    logStep("顶栏 1920/1440/1024/768/390：单行对齐、书名省略与操作区完整")
    await assertReaderToolbarLayout(desktop, {
      label: "EPUB 阅读器顶栏",
      expectEllipsis: (viewport) => viewport.width < 768,
    })
    await desktop.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-epub-toolbar-long-title.png"),
    })

    logStep("手机 390x844：工具栏、目录抽屉与翻页")
    const mobileContext = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      locale: "zh-CN",
      storageState,
      serviceWorkers: "block",
    })
    contexts.push(mobileContext)
    const mobile = await mobileContext.newPage()
    await mobile.goto(`/read/${bookId}`, { waitUntil: "domcontentloaded" })
    await mobile.locator("[data-reader-epub] foliate-view").waitFor({
      timeout: 20_000,
    })
    await waitForEpubText(mobile, "第三章正文")
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
    assert.equal(await mobile.locator(".iread-reader-toc__item").count(), CHAPTERS.length)
    await mobile
      .locator(".iread-reader-toc__item", { hasText: "第一章" })
      .first()
      .click()
    await mobilePanel.waitFor({ state: "hidden" })
    await waitForEpubText(mobile, "第一章正文")
    const mobileBefore = await epubSnapshot(mobile)
    await mobile.getByRole("button", { name: "下一处" }).click()
    await mobile.waitForFunction(
      (previous) => {
        const view = document.querySelector("[data-reader-epub] foliate-view")
        const contents = view?.renderer?.getContents?.() ?? []
        return JSON.stringify({
          index: contents[0]?.index ?? null,
          page: view?.renderer?.page ?? null,
        }) !== JSON.stringify(previous)
      },
      { index: mobileBefore.index, page: mobileBefore.page },
      { timeout: 5000 },
    )
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-reader.png"),
    })
    await mobile.getByRole("button", { name: "阅读设置" }).click()
    const mobileSettings = mobile.locator('[data-reader-panel="settings"]')
    await mobileSettings.waitFor({ timeout: 5000 })
    await mobile.getByRole("tab", { name: "EPUB 文字" }).click()
    await mobile.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-settings.png"),
    })
    await mobile.keyboard.press("Escape")
    await mobileSettings.waitFor({ state: "hidden" })

    await mobile.setViewportSize({ width: 844, height: 390 })
    await mobile.waitForFunction(
      () =>
        Math.round(
          document.querySelector(".iread-reader-shell")?.getBoundingClientRect()
            .height ?? 0,
        ) === 390,
      undefined,
      { timeout: 3000 },
    )
    await waitForEpubText(mobile, "第一章正文")

    console.log("\n[E2E] 真实 EPUB 共享 Shell 通过")
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {})
    }
    for (const context of apiContexts) {
      await context.dispose().catch(() => {})
    }
    await browser?.close().catch(() => {})
    for (const dispose of cleanup) {
      dispose()
    }
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
