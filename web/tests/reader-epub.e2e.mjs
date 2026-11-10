#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
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

const WEB_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
const PREFERRED_SERVER_PORT = Number(
  process.env.IREAD_E2E_SERVER_PORT ?? "18080",
)
const PREFERRED_WEB_PORT = Number(process.env.IREAD_E2E_WEB_PORT ?? "18081")
let serverPort = PREFERRED_SERVER_PORT
let webPort = PREFERRED_WEB_PORT
let webBase = `http://127.0.0.1:${webPort}`
let serverBase = `http://127.0.0.1:${serverPort}`
const SCREENSHOT_DIR =
  process.env.READER_EPUB_SCREENSHOT_DIR ??
  path.join("/tmp/opencode", "iread-epub-e2e-screenshots")
const TEMP_ROOT = process.env.IREAD_E2E_TMP ?? "/tmp/opencode"

function logStep(name) {
  console.log(`\n[E2E] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function url(pathname) {
  return `${webBase}${pathname}`
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataOf(payload) {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : null
}

function requireData(payload, label) {
  const data = dataOf(payload)
  if (data === null) {
    throw new Error(`${label} 响应缺少 data`)
  }
  return data
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

function dosDateTime() {
  const year = 2026
  const date = ((year - 1980) << 9) | (1 << 5) | 1
  return { date, time: 0 }
}

function zipEntries(entries) {
  const localChunks = []
  const centralChunks = []
  let offset = 0
  const { date, time } = dosDateTime()
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
    local.writeUInt16LE(time, 10)
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
    central.writeUInt16LE(time, 12)
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

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
)

function systemFont() {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/lato/Lato-Medium.ttf",
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate)
    }
  }
  return null
}

function longParagraphs(prefix, count) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    return `<p class="publisher-font">${prefix}第 ${number} 段：文字必须足够长，才能在分页布局中形成多页内容，并让重新排版后的位置仍然停留在同一段附近。这里是用于验证 CFI 定位、字号重排与资源缓存的真实段落文本。</p>`
  }).join("\n")
}

function chapter1() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <title>第一章</title>
  <link rel="stylesheet" type="text/css" href="../Styles/book.css"/>
  <style type="text/css">@import url("../Styles/extra.css"); .inline-art { background-image: url("../Images/pixel.png"); }</style>
  <meta http-equiv="refresh" content="0;url=https://example.com/refresh"/>
  <base href="https://example.com/"/>
</head>
<body>
  <h1 id="chapter1">第一章</h1>
  <p id="chapter1-mid" class="publisher-font">第一章正文。这个段落用于确认章节正文、出版方 CSS 与资源按需加载。</p>
  ${longParagraphs("第一章", 10)}
  <img id="pixel" src="../Images/pixel.png" alt="像素测试图"/>
  <p class="inline-art">带内联背景图的段落。</p>
  <a id="internal-link" href="chapter2.xhtml#chapter2-mid">跳到第二章</a>
  <a id="external-link" href="https://example.com/evil">外部链接</a>
  <script type="text/javascript">window.parent.__ireadPwned = 1; fetch("https://example.com/script");</script>
  <img src="https://example.com/evil.png" onerror="window.parent.__ireadPwned = 1"/>
  <iframe src="https://example.com/frame"></iframe>
  <object data="https://example.com/object"></object>
  <embed src="https://example.com/embed"/>
  <form action="https://example.com/form"><input name="x"/></form>
  <a href="javascript:window.parent.__ireadPwned = 1">javascript 链接</a>
  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.parent.__ireadPwned = 1</script><image href="https://example.com/svg.png"/></svg>
</body>
</html>`
}

function chapter2() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>第二章</title></head>
<body>
  <h1 id="chapter2">第二章</h1>
  ${longParagraphs("第二章", 6)}
  <p id="chapter2-mid" class="publisher-font">第二章中段。这里用于验证 CFI、文本锚点与字号重排后的位置恢复。</p>
  ${longParagraphs("第二章后半", 14)}
  <a id="to-chapter-3" href="chapter3.xhtml#target">继续到第三章</a>
</body>
</html>`
}

function chapter3() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>第三章</title></head>
<body>
  <h1 id="target">第三章</h1>
  <p>第三章正文。目录与内部链接都应当在这里结束。</p>
</body>
</html>`
}

function navDocument() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="Text/chapter1.xhtml">第一章</a></li>
      <li><a href="Text/chapter2.xhtml#chapter2-mid">第二章</a></li>
      <li><a href="Text/chapter3.xhtml#target">第三章</a></li>
    </ol>
  </nav>
</body>
</html>`
}

function ncxDocument() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:iread-e2e-ncx"/></head>
  <docTitle><text>E2E NCX 目录</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>NCX 第一章</text></navLabel><content src="Text/chapter1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>NCX 第二章</text></navLabel><content src="Text/chapter2.xhtml#chapter2-mid"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>NCX 第三章</text></navLabel><content src="Text/chapter3.xhtml#target"/></navPoint>
  </navMap>
</ncx>`
}

function opf({ version, title, fixed, withNav }) {
  const navItem = withNav
    ? '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
    : ""
  const rendition = fixed
    ? '    <meta property="rendition:layout">pre-paginated</meta>\n'
    : '    <meta property="rendition:layout">reflowable</meta>\n'
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="bookid" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:identifier id="bookid">urn:uuid:iread-e2e-${title.replace(/[^a-z0-9]+/gi, "-")}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
${rendition}  </metadata>
  <manifest>
${navItem}    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="Text/chapter3.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="Styles/book.css" media-type="text/css"/>
    <item id="extra" href="Styles/extra.css" media-type="text/css"/>
    <item id="img" href="Images/pixel.png" media-type="image/png"/>
    <item id="font" href="Fonts/DejaVuSans.ttf" media-type="font/ttf"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`
}

function styles(extra = "") {
  return `.publisher-font { font-family: "E2E Font", serif; }
@font-face { font-family: "E2E Font"; src: url("../Fonts/DejaVuSans.ttf") format("truetype"); font-weight: normal; font-style: normal; }
.inline-art { min-height: 8px; background-image: url("../Images/pixel.png"); }
${extra}`
}

function makeEpub({
  version = "3.0",
  title = "E2E 可重排阅读测试",
  fixed = false,
  withNav = true,
  withFont = true,
} = {}) {
  const font = withFont ? systemFont() : null
  const entries = [
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    { name: "OEBPS/content.opf", data: opf({ version, title, fixed, withNav }) },
    { name: "OEBPS/nav.xhtml", data: navDocument() },
    { name: "OEBPS/toc.ncx", data: ncxDocument() },
    { name: "OEBPS/Text/chapter1.xhtml", data: chapter1() },
    { name: "OEBPS/Text/chapter2.xhtml", data: chapter2() },
    { name: "OEBPS/Text/chapter3.xhtml", data: chapter3() },
    { name: "OEBPS/Styles/book.css", data: styles() },
    { name: "OEBPS/Styles/extra.css", data: ".extra { background: url(../Images/pixel.png); }\n" },
    { name: "OEBPS/Images/pixel.png", data: PIXEL_PNG },
  ]
  if (font !== null) {
    entries.push({ name: "OEBPS/Fonts/DejaVuSans.ttf", data: font })
  }
  return zipEntries(entries)
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

function stopProcess(run) {
  if (run === null || run === undefined) {
    return
  }
  const { child } = run
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM")
    } else {
      child.kill("SIGTERM")
    }
  } catch {
    try {
      child.kill("SIGTERM")
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

async function ensureServers(cleanup) {
  const tempRoot = mkdtempSync(path.join(TEMP_ROOT, "iread-epub-e2e-"))
  const dirs = {
    books: path.join(tempRoot, "books"),
    db: path.join(tempRoot, "db"),
    cache: path.join(tempRoot, "cache"),
  }
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true })
  }
  const staticWebDir = path.join(tempRoot, "web")
  mkdirSync(staticWebDir, { recursive: true })
  writeFileSync(
    path.join(staticWebDir, "index.html"),
    "<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>",
  )
  let server = null
  let vite = null
  const preferredServerHealthy = await httpReachable(
    `http://127.0.0.1:${PREFERRED_SERVER_PORT}/healthz`,
  )
  if (!preferredServerHealthy) {
    if (!(await portFree(serverPort))) {
      serverPort = await findFreePort(serverPort + 100)
      serverBase = `http://127.0.0.1:${serverPort}`
      console.log(
        `[E2E] ${PREFERRED_SERVER_PORT} 被占用且不健康，改用 ${serverPort}`,
      )
    }
    if (!(await portFree(webPort))) {
      webPort = await findFreePort(webPort + 100)
      webBase = `http://127.0.0.1:${webPort}`
      console.log(
        `[E2E] ${PREFERRED_WEB_PORT} 被占用，改用 ${webPort}`,
      )
    }
  }
  if (!(await httpReachable(`${serverBase}/healthz`))) {
    server = startProcess("go", ["run", "./cmd/iread"], {
      cwd: path.join(REPO_ROOT, "server"),
      env: {
        ...process.env,
        IREAD_ADDR: `127.0.0.1:${serverPort}`,
        IREAD_PUBLIC_ORIGIN: serverBase,
        IREAD_BOOKS_DIR: dirs.books,
        IREAD_DB_DIR: dirs.db,
        IREAD_CACHE_DIR: dirs.cache,
        IREAD_WEB_DIR: staticWebDir,
        IREAD_LOG_LEVEL: "warn",
      },
    })
    cleanup.push(() => stopProcess(server))
    await waitForHttp(`${serverBase}/healthz`, 90_000)
    console.log(`[E2E] 已启动临时 Go 服务 ${serverBase}，数据目录 ${tempRoot}`)
  } else {
    console.log(`[E2E] 复用已在运行的 Go 服务 ${serverBase}`)
  }
  if (!(await httpReachable(`${webBase}/`))) {
    if (!(await portFree(webPort))) {
      webPort = await findFreePort(PREFERRED_WEB_PORT + 100)
      webBase = `http://127.0.0.1:${webPort}`
    }
    vite = startProcess(
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
        env: {
          ...process.env,
          IREAD_DEV_API: serverBase,
        },
      },
    )
    cleanup.push(() => stopProcess(vite))
    await waitForHttp(`${webBase}/`, 60_000)
    console.log(`[E2E] 已启动 Vite 开发服务器 ${webBase}`)
  } else {
    console.log(`[E2E] 复用已在运行的 Web 服务 ${webBase}`)
  }
  return {
    tempRoot,
    cleanup: () => {
      stopProcess(server)
      stopProcess(vite)
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}

async function uploadEpub(api, fileName, data) {
  const intentResponse = await api.post("/api/v1/uploads", {
    clientUploadId: `e2e-${fileName}-${Date.now()}`,
    fileName,
    byteSize: data.length,
  })
  assert.ok(
    intentResponse.status === 200 || intentResponse.status === 201,
    `创建上传意图失败：HTTP ${intentResponse.status} ${JSON.stringify(intentResponse.payload)}`,
  )
  const intent = requireData(intentResponse.payload, "上传意图")
  const uploadId = intent.uploadId
  assert.equal(typeof uploadId, "string", "上传意图缺少 uploadId")
  if (api.csrfToken === null) {
    await api.fetchStatus()
  }
  const put = await api.request.fetch(
    `${serverBase}/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/epub+zip",
        Origin: serverBase,
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
    `上传 EPUB 内容失败：HTTP ${put.status()} ${JSON.stringify(putPayload)}`,
  )
  const stored = requireData(putPayload, "上传结果")
  const bookId = stored.bookId ?? stored.duplicateOfBookId
  assert.equal(typeof bookId, "string", "上传结果缺少 bookId")
  let detail = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await api.get(`/api/v1/books/${encodeURIComponent(bookId)}`)
    if (response.status === 200) {
      detail = requireData(response.payload, "书籍详情")
      if (detail.status === "ready") {
        break
      }
      if (detail.status === "error") {
        throw new Error(`索引失败：${JSON.stringify(detail)}`)
      }
    }
    await sleep(250)
  }
  assert.ok(detail !== null, `等待书籍 ${bookId} 索引超时`)
  assert.equal(detail.status, "ready", `书籍未就绪：${JSON.stringify(detail)}`)
  const manifestResponse = await api.get(
    `/api/v1/books/${encodeURIComponent(bookId)}/manifest`,
  )
  assert.equal(
    manifestResponse.status,
    200,
    `读取 manifest 失败：HTTP ${manifestResponse.status} ${JSON.stringify(manifestResponse.payload)}`,
  )
  const manifest = requireData(manifestResponse.payload, "manifest")
  assert.equal(manifest.format, "epub", "manifest 格式不是 epub")
  return { bookId, detail, manifest }
}

function resourceRequest(requests, bookId, resourceId) {
  const needle = `/api/v1/books/${bookId}/versions/`
  return requests.filter(
    (request) =>
      request.url.includes(needle) && request.url.endsWith(`/resources/${resourceId}`),
  )
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

function anchorLocation(manifest, item, progressPercent = 0) {
  const spineIndex = manifest.formatData.spine.findIndex(
    (entry) =>
      (item.resourceId.length > 0 && entry.resourceId === item.resourceId) ||
      entry.href === item.href,
  )
  return {
    locatorType: "epub-anchor",
    progressPercent,
    locatorPayload: {
      locatorVersion: 1,
      spineIndex: spineIndex >= 0 ? spineIndex : 0,
      resourceId:
        item.resourceId.length > 0
          ? item.resourceId
          : manifest.formatData.spine[spineIndex]?.resourceId ?? "",
      href:
        item.href.length > 0
          ? item.href
          : manifest.formatData.spine[spineIndex]?.href ?? "",
      anchorId: item.fragment.length > 0 ? item.fragment : null,
      chapterProgress: 0,
      textQuote: null,
    },
  }
}

async function installHarness(page, manifest, settings = null) {
  return page.evaluate(
    async ({ manifestValue, settingsValue }) => {
      const module = await import("/src/features/reader/epub/index.ts")
      const host = document.createElement("div")
      host.id = "epub-e2e-host"
      host.style.position = "fixed"
      host.style.inset = "0"
      host.style.zIndex = "9999"
      host.style.background = "Canvas"
      document.body.replaceChildren(host)
      const engine = module.createEpubReaderEngine()
      const controller = new AbortController()
      const locations = []
      engine.subscribeLocation((location) => {
        locations.push(location)
      })
      window.__epubHarness = { engine, host, controller, locations }
      await engine.mount(host, manifestValue, controller.signal)
      if (settingsValue !== null) {
        engine.applySettings(settingsValue)
      }
      return {
        capabilities: engine.capabilities,
        settings: engine.getSettings(),
      }
    },
    { manifestValue: manifest, settingsValue: settings },
  )
}

async function harnessSnapshot(page) {
  return page.evaluate(() => {
    const harness = window.__epubHarness
    if (!harness) {
      return null
    }
    const view = harness.host.querySelector("foliate-view")
    const contents = view?.renderer?.getContents?.() ?? []
    const doc = contents[0]?.doc ?? null
    return {
      text: doc?.body?.innerText ?? "",
      location: harness.engine.getLocation(),
      page: view?.renderer?.page ?? null,
      pages: view?.renderer?.pages ?? null,
      locationCount: harness.locations.length,
    }
  })
}

async function waitForText(page, needle, timeout = 20_000) {
  await page.waitForFunction(
    (expected) => {
      const harness = window.__epubHarness
      const view = harness?.host.querySelector("foliate-view")
      const contents = view?.renderer?.getContents?.() ?? []
      return (contents[0]?.doc?.body?.innerText ?? "").includes(expected)
    },
    needle,
    { timeout },
  )
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const cleanup = []
  let servers = null
  let browser = null
  let apiContext = null
  const blocked = []
  const requests = []

  try {
    servers = await ensureServers(cleanup)
    const browserLaunch = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--no-sandbox"],
    })
    browser = browserLaunch
    const storageState = await createAuthenticatedStorageState(
      browser,
      serverBase,
      E2E_PASSWORD,
    )
    apiContext = await playwrightRequest.newContext({
      baseURL: serverBase,
      storageState,
    })
    const api = new AuthedApi(apiContext, serverBase)
    await ensureAdmin(api, serverBase, E2E_PASSWORD)

    logStep("上传真实 EPUB3（nav + NCX + CSS + 图片 + 字体）")
    const epub3 = await uploadEpub(
      api,
      "iread-e2e-reflow.epub",
      makeEpub({ version: "3.0", title: "E2E 可重排阅读测试" }),
    )
    console.log(
      `[E2E] EPUB3 bookId=${epub3.bookId} fileVersion=${epub3.manifest.fileVersion} spine=${epub3.manifest.formatData.spine.length} toc=${epub3.manifest.toc.length}`,
    )
    assert.equal(epub3.manifest.formatData.spine.length, 3, "spine 应为 3 章")
    assert.deepEqual(
      epub3.manifest.toc.map((item) => item.title),
      ["第一章", "第二章", "第三章"],
      "EPUB3 nav 目录标题不正确",
    )
    assert.ok(
      resourceIdForHref(epub3.manifest, "OEBPS/Styles/book.css") !== null,
      "manifest 缺少 CSS 资源",
    )
    assert.ok(
      resourceIdForHref(epub3.manifest, "OEBPS/Images/pixel.png") !== null,
      "manifest 缺少图片资源",
    )
    const fontHref = "OEBPS/Fonts/DejaVuSans.ttf"
    const hasFont = resourceIdForHref(epub3.manifest, fontHref) !== null
    if (!hasFont) {
      blocked.push("系统没有 DejaVuSans.ttf，字体资源请求未纳入断言。")
    }

    logStep("真实 /read/:id 路由检查（Shell 接线由集成者完成）")
    const context = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1200, height: 820 },
      locale: "zh-CN",
      serviceWorkers: "block",
      storageState,
    })
    const page = await context.newPage()
    page.on("request", (request) => {
      requests.push({ url: request.url(), type: request.resourceType() })
    })
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`[browser console] ${message.text()}`)
      }
    })
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message}`)
    })
    let shellWired = false
    try {
      await page.goto(url(`/read/${encodeURIComponent(epub3.bookId)}`), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      })
      await page.waitForFunction(
        () => document.querySelector("[data-reader-surface]") !== null,
        undefined,
        { timeout: 10_000 },
      )
      shellWired = await page.evaluate(
        () => document.querySelector("[data-reader-surface] foliate-view") !== null,
      )
    } catch (error) {
      blocked.push(
        `/read/:id 当前被并行应用改动阻断：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!shellWired) {
      blocked.push(
        "共享 Shell 的 ReaderSurface 尚未调用 createEpubReaderEngine；按写入边界由后续集成者接线。",
      )
      console.log(
        "[BLOCKED] /read/:id 可导航，但正文仍显示 Shell 占位；未伪造 Shell 接线。",
      )
    }

    logStep("独立挂载真实引擎并读取第一章")
    await page.goto(url("/pwa-192x192.png"), {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    })
    const harnessUrlBefore = page.url()
    requests.length = 0
    const mountInfo = await installHarness(page, epub3.manifest)
    console.log(
      `[E2E] engine capabilities=${JSON.stringify(mountInfo.capabilities)}`,
    )
    await waitForText(page, "第一章")
    await sleep(500)
    const first = await harnessSnapshot(page)
    assert.ok(first !== null, "引擎快照为空")
    assert.match(first.text, /第一章/, "未渲染第一章文本")
    assert.ok(first.location !== null, "首章未上报 locator")
    assert.equal(first.location.locatorType, "epub-cfi", "首章 locator 应为 epub-cfi")
    assert.equal(first.location.locatorPayload.spineIndex, 0, "首章 spineIndex 应为 0")
    assert.match(first.location.locatorPayload.cfi, /^epubcfi\(/, "locator 缺少 CFI")
    assert.ok(first.location.progressPercent >= 0, "progressPercent 无效")
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "01-first-chapter.png"),
    })

    logStep("章节隔离、CSP、sandbox 与恶意内容")
    const security = await page.evaluate(async () => {
      const harness = window.__epubHarness
      const view = harness.host.querySelector("foliate-view")
      const contents = view.renderer.getContents()
      const doc = contents[0].doc
      const frame = doc.defaultView
      const frameElement = frame.frameElement
      const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
      let evalBlocked = false
      let fetchBlocked = false
      try {
        frame.eval("1")
      } catch {
        evalBlocked = true
      }
      try {
        await frame.fetch("/api/v1/books")
      } catch {
        fetchBlocked = true
      }
      const dangerous = doc.querySelectorAll(
        "script, iframe, object, embed, form, base, link[rel~=stylesheet]",
      ).length
      const image = doc.getElementById("pixel")
      return {
        pwned: Boolean(window.__ireadPwned),
        parentPwned: Boolean(window.parent.__ireadPwned),
        sandbox: frameElement?.getAttribute("sandbox") ?? "",
        csp: meta?.getAttribute("content") ?? "",
        evalBlocked,
        fetchBlocked,
        dangerous,
        imageSrc: image?.getAttribute("src") ?? "",
        externalHref: doc.getElementById("external-link")?.getAttribute("href") ?? null,
        internalHref: doc.getElementById("internal-link")?.getAttribute("href") ?? "",
        topUrl: window.location.href,
      }
    })
    assert.equal(security.pwned, false, "恶意脚本在主文档执行")
    assert.equal(security.parentPwned, false, "恶意脚本在父文档执行")
    assert.equal(security.sandbox, "allow-same-origin allow-scripts", "iframe sandbox 不符合要求")
    assert.match(security.csp, /script-src 'none'/, "CSP 未禁止脚本")
    assert.match(security.csp, /connect-src 'none'/, "CSP 未禁止 connect")
    assert.match(security.csp, /frame-src 'none'/, "CSP 未禁止 frame")
    assert.match(security.csp, /object-src 'none'/, "CSP 未禁止 object")
    assert.equal(security.evalBlocked, true, "CSP 未阻止 iframe eval")
    assert.equal(security.fetchBlocked, true, "CSP 未阻止 iframe fetch")
    assert.equal(security.dangerous, 0, "危险元素未被清洗")
    assert.match(security.imageSrc, /^blob:/, "图片未重写为 blob URL")
    assert.equal(security.externalHref, null, "外链未移除 href")
    assert.match(
      security.internalHref,
      /^OEBPS\/Text\/chapter2\.xhtml#chapter2-mid$/,
      "内部链接未规范化为归档路径",
    )
    assert.equal(security.topUrl, harnessUrlBefore, "顶层导航被改变")

    const chapter1Id = resourceIdForHref(epub3.manifest, "OEBPS/Text/chapter1.xhtml")
    const chapter2Id = resourceIdForHref(epub3.manifest, "OEBPS/Text/chapter2.xhtml")
    const chapter3Id = resourceIdForHref(epub3.manifest, "OEBPS/Text/chapter3.xhtml")
    assert.ok(chapter1Id && chapter2Id && chapter3Id, "章节资源 ID 缺失")
    assert.equal(resourceRequest(requests, epub3.bookId, chapter1Id).length, 1, "第一章未按需请求")
    assert.equal(resourceRequest(requests, epub3.bookId, chapter2Id).length, 0, "未打开的第二章被提前下载")
    assert.equal(resourceRequest(requests, epub3.bookId, chapter3Id).length, 0, "未打开的第三章被提前下载")
    assert.ok(
      requests.some((request) => request.url.endsWith("/resources/" + resourceIdForHref(epub3.manifest, "OEBPS/Styles/book.css"))),
      "出版方 CSS 未按需请求",
    )
    assert.ok(
      requests.some((request) => request.url.endsWith("/resources/" + resourceIdForHref(epub3.manifest, "OEBPS/Images/pixel.png"))),
      "图片资源未按需请求",
    )
    if (hasFont) {
      assert.ok(
        requests.some((request) => request.url.endsWith("/resources/" + resourceIdForHref(epub3.manifest, fontHref))),
        "字体资源未按需请求",
      )
    }
    assert.equal(
      requests.filter((request) => request.url.includes("example.com")).length,
      0,
      "发生外部网络请求",
    )

    const chapter2Item = epub3.manifest.toc.find((item) => item.title === "第二章")
    assert.ok(chapter2Item, "缺少第二章目录项")
    const chapter2Target = anchorLocation(epub3.manifest, chapter2Item, 40)

    logStep("章节局部失败占位与重试")
    const firstTarget = anchorLocation(epub3.manifest, epub3.manifest.toc[0], 0)
    await page.evaluate(
      (target) => window.__epubHarness.engine.navigateTo(target),
      firstTarget,
    )
    await waitForText(page, "第一章正文")
    const chapter2Pattern = `**/resources/${chapter2Id}`
    let failedChapterRequests = 0
    await page.route(chapter2Pattern, async (route) => {
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
    const failedNavigate = await page.evaluate(
      (target) => window.__epubHarness.engine.navigateTo(target),
      chapter2Target,
    )
    assert.equal(failedNavigate.ok, false, "章节失败时应返回可重试错误")
    assert.ok(failedChapterRequests >= 1, "未触发章节资源失败请求")
    const failureOverlay = page.locator('#epub-e2e-host [role="alert"]')
    await failureOverlay.waitFor({ timeout: 10_000 })
    const failureText = (await failureOverlay.textContent()) ?? ""
    assert.match(failureText, /本章节未能加载/, "章节失败占位缺失")
    assert.match(failureText, /重试/, "章节失败占位缺少重试操作")
    await page.unroute(chapter2Pattern)
    await failureOverlay.getByRole("button", { name: "重试" }).click()
    await waitForText(page, "第二章中段")
    await failureOverlay.waitFor({ state: "detached", timeout: 10_000 })
    const retried = await harnessSnapshot(page)
    assert.equal(
      retried.location.locatorPayload.spineIndex,
      1,
      "重试后未回到失败章节",
    )

    logStep("目录跳转、内部链接与翻页")
    const chapter2Result = await page.evaluate(
      (target) => window.__epubHarness.engine.navigateTo(target),
      chapter2Target,
    )
    assert.equal(chapter2Result.ok, true, `目录跳转失败：${JSON.stringify(chapter2Result)}`)
    await waitForText(page, "第二章中段")
    const afterToc = await harnessSnapshot(page)
    assert.equal(afterToc.location.locatorPayload.spineIndex, 1, "目录跳转章节错误")
    assert.ok(
      resourceRequest(requests, epub3.bookId, chapter2Id).length >= 1,
      "第二章未按需请求",
    )
    assert.equal(resourceRequest(requests, epub3.bookId, chapter3Id).length, 0, "第三章被提前请求")
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "02-toc-chapter2.png"),
    })

    await page.evaluate(() => {
      const view = window.__epubHarness.host.querySelector("foliate-view")
      const doc = view.renderer.getContents()[0].doc
      doc.getElementById("to-chapter-3")?.click()
    })
    await waitForText(page, "第三章正文。")
    assert.equal(resourceRequest(requests, epub3.bookId, chapter3Id).length, 1, "内部链接未加载第三章")
    const chapter3Location = await harnessSnapshot(page)
    assert.equal(chapter3Location.location.locatorPayload.spineIndex, 2, "内部链接章节错误")

    const backToChapter2 = await page.evaluate(
      (target) => window.__epubHarness.engine.navigateTo(target),
      chapter2Target,
    )
    assert.equal(backToChapter2.ok, true, "返回第二章失败")
    await waitForText(page, "第二章中段")
    const beforeTurn = await harnessSnapshot(page)
    const turn = await page.evaluate(() =>
      window.__epubHarness.engine.advance("next"),
    )
    assert.equal(turn.ok, true, "翻页失败")
    await sleep(400)
    const afterTurn = await harnessSnapshot(page)
    assert.notEqual(
      JSON.stringify(afterTurn.location.locatorPayload),
      JSON.stringify(beforeTurn.location.locatorPayload),
      "翻页后 locator 未变化",
    )

    logStep("CFI 进度、字号重排与资源缓存")
    const beforeReflow = await harnessSnapshot(page)
    const chapter2RequestsBefore = resourceRequest(
      requests,
      epub3.bookId,
      chapter2Id,
    ).length
    await page.evaluate(() =>
      window.__epubHarness.engine.applySettings({
        fontSize: 26,
        lineHeight: 2.1,
        paragraphSpacing: 0.4,
        textIndent: 1,
      }),
    )
    await sleep(900)
    const afterReflow = await harnessSnapshot(page)
    assert.equal(
      afterReflow.location.locatorPayload.spineIndex,
      beforeReflow.location.locatorPayload.spineIndex,
      "字号重排后跳到了其他章节",
    )
    assert.ok(
      afterReflow.location.locatorPayload.chapterProgress > 0.05,
      "字号重排后退回章节开头",
    )
    assert.ok(
      afterReflow.location.locatorPayload.chapterProgress + 0.2 >=
        beforeReflow.location.locatorPayload.chapterProgress,
      "字号重排后位置明显前移",
    )
    assert.equal(
      resourceRequest(requests, epub3.bookId, chapter2Id).length,
      chapter2RequestsBefore,
      "字号重排重新下载了章节资源",
    )
    const fontSize = await page.evaluate(() => {
      const view = window.__epubHarness.host.querySelector("foliate-view")
      const doc = view.renderer.getContents()[0].doc
      return getComputedStyle(doc.body).fontSize
    })
    assert.equal(fontSize, "26px", "字号设置未生效")
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "03-reflow-fontsize.png"),
    })

    await page.evaluate(() =>
      window.__epubHarness.engine.applySettings({ columns: "2" }),
    )
    await sleep(700)
    const twoColumn = await page.evaluate(() => {
      const view = window.__epubHarness.host.querySelector("foliate-view")
      return {
        columns: view.renderer.getAttribute("max-column-count"),
        location: window.__epubHarness.engine.getLocation(),
      }
    })
    assert.equal(twoColumn.columns, "2", "宽屏双栏设置未应用")
    assert.equal(
      twoColumn.location.locatorPayload.spineIndex,
      1,
      "切换双栏后跳到了其他章节",
    )
    assert.ok(
      twoColumn.location.locatorPayload.chapterProgress > 0.05,
      "切换双栏后退回章节开头",
    )
    await page.evaluate(() =>
      window.__epubHarness.engine.applySettings({ columns: "1" }),
    )
    await sleep(500)

    await page.evaluate(() =>
      window.__epubHarness.engine.applySettings({ pagination: "scroll" }),
    )
    await sleep(700)
    const scrollState = await page.evaluate(() => {
      const view = window.__epubHarness.host.querySelector("foliate-view")
      return {
        scrolled: view.renderer.scrolled,
        location: window.__epubHarness.engine.getLocation(),
      }
    })
    assert.equal(scrollState.scrolled, true, "滚动模式未应用")
    assert.equal(
      scrollState.location.locatorPayload.spineIndex,
      1,
      "切换滚动模式后跳到了其他章节",
    )
    assert.ok(
      scrollState.location.locatorPayload.chapterProgress > 0.05,
      "切换滚动模式后退回章节开头",
    )
    await page.evaluate(() =>
      window.__epubHarness.engine.applySettings({ pagination: "pagination" }),
    )
    await sleep(500)

    await page.evaluate(() =>
      window.__epubHarness.engine.applySettings({ publisherCSSMode: "off" }),
    )
    await sleep(800)
    await waitForText(page, "第二章中段")
    const publisherOff = await page.evaluate(() => {
      const view = window.__epubHarness.host.querySelector("foliate-view")
      const doc = view.renderer.getContents()[0].doc
      return {
        html: doc.documentElement.innerHTML,
        baseline: doc.querySelectorAll("style[data-iread-baseline]").length,
      }
    })
    assert.equal(publisherOff.baseline, 1, "关闭出版方 CSS 后基础样式缺失")
    assert.ok(
      !publisherOff.html.includes("E2E Font"),
      "关闭出版方 CSS 后仍注入出版方字体样式",
    )
    assert.equal(
      resourceRequest(requests, epub3.bookId, chapter2Id).length,
      chapter2RequestsBefore,
      "样式切换重新下载了已缓存章节",
    )

    logStep("CFI 恢复与章节缓存")
    const saved = afterReflow.location
    const chapter1Target = anchorLocation(epub3.manifest, epub3.manifest.toc[0], 0)
    await page.evaluate(
      (target) => window.__epubHarness.engine.navigateTo(target),
      chapter1Target,
    )
    await waitForText(page, "第一章正文")
    const restoreResult = await page.evaluate(
      (target) => window.__epubHarness.engine.restore(target),
      saved,
    )
    assert.equal(restoreResult.ok, true, `CFI 恢复失败：${JSON.stringify(restoreResult)}`)
    await waitForText(page, "第二章中段")
    const restored = await harnessSnapshot(page)
    assert.equal(restored.location.locatorPayload.spineIndex, 1, "CFI 恢复到错误章节")
    assert.ok(
      restored.location.locatorPayload.chapterProgress > 0.05,
      "CFI 恢复退到章节开头",
    )
    assert.equal(
      resourceRequest(requests, epub3.bookId, chapter2Id).length,
      chapter2RequestsBefore,
      "CFI 恢复重新下载了章节资源",
    )

    logStep("EPUB2 NCX 目录与重挂载")
    await page.evaluate(() => window.__epubHarness.engine.unmount())
    const epub2 = await uploadEpub(
      api,
      "iread-e2e-ncx.epub",
      makeEpub({
        version: "2.0",
        title: "E2E NCX 阅读测试",
        withNav: false,
      }),
    )
    assert.deepEqual(
      epub2.manifest.toc.map((item) => item.title),
      ["NCX 第一章", "NCX 第二章", "NCX 第三章"],
      "EPUB2 NCX 目录标题不正确",
    )
    await page.evaluate(
      async (manifestValue) => {
        const harness = window.__epubHarness
        await harness.engine.mount(
          harness.host,
          manifestValue,
          new AbortController().signal,
        )
      },
      epub2.manifest,
    )
    const ncxItem = epub2.manifest.toc[1]
    assert.ok(ncxItem, "缺少 NCX 第二章目录项")
    const ncxTarget = anchorLocation(epub2.manifest, ncxItem, 30)
    const ncxResult = await page.evaluate(
      (target) => window.__epubHarness.engine.navigateTo(target),
      ncxTarget,
    )
    assert.equal(ncxResult.ok, true, `NCX 目录跳转失败：${JSON.stringify(ncxResult)}`)
    await waitForText(page, "第二章中段")
    const epub2Location = await harnessSnapshot(page)
    assert.equal(epub2Location.location.locatorPayload.spineIndex, 1, "NCX 目录跳转失败")

    logStep("固定布局 EPUB 明确拒绝")
    await page.evaluate(() => window.__epubHarness.engine.unmount())
    const fixed = await uploadEpub(
      api,
      "iread-e2e-fixed.epub",
      makeEpub({
        version: "3.0",
        title: "E2E 固定布局测试",
        fixed: true,
      }),
    )
    const fixedResult = await page.evaluate(async (manifestValue) => {
      const module = await import("/src/features/reader/epub/index.ts")
      const host = document.createElement("div")
      host.style.width = "400px"
      host.style.height = "400px"
      document.body.append(host)
      const engine = module.createEpubReaderEngine()
      try {
        await engine.mount(host, manifestValue, new AbortController().signal)
        return { ok: false, message: "固定布局未被拒绝", capabilities: engine.capabilities }
      } catch (error) {
        return {
          ok: true,
          message: error instanceof Error ? error.message : String(error),
          capabilities: engine.capabilities,
        }
      } finally {
        engine.dispose()
        host.remove()
      }
    }, fixed.manifest)
    assert.equal(fixedResult.ok, true, fixedResult.message)
    assert.match(fixedResult.message, /固定布局/, "固定布局错误信息不明确")
    assert.equal(
      fixedResult.capabilities.canRender,
      false,
      "固定布局仍声明可渲染",
    )

    logStep("结果汇总")
    console.log(
      JSON.stringify(
        {
          epub3: {
            bookId: epub3.bookId,
            fileVersion: epub3.manifest.fileVersion,
            toc: epub3.manifest.toc.map((item) => item.title),
            resourceRequests: requests.filter((request) =>
              request.url.includes(`/api/v1/books/${epub3.bookId}/versions/`),
            ).length,
          },
          epub2: {
            bookId: epub2.bookId,
            toc: epub2.manifest.toc.map((item) => item.title),
          },
          fixed: {
            bookId: fixed.bookId,
            rejected: fixedResult.message,
          },
          shellWired,
          blocked,
          screenshots: SCREENSHOT_DIR,
        },
        null,
        2,
      ),
    )
    if (blocked.length > 0) {
      for (const item of blocked) {
        console.log(`[BLOCKED] ${item}`)
      }
    }
    console.log("[E2E] EPUB 引擎断言通过。")
  } finally {
    try {
      await apiContext?.dispose()
    } catch {
      // 忽略 API 上下文关闭失败。
    }
    try {
      await browser?.close()
    } catch {
      // 忽略浏览器关闭失败。
    }
    try {
      await servers?.cleanup()
    } catch {
      // 忽略服务清理失败。
    }
    for (const item of cleanup) {
      try {
        item()
      } catch {
        // 忽略清理失败。
      }
    }
  }
}

main().catch(async (error) => {
  console.error("\n[E2E] 失败：")
  console.error(error instanceof E2EBlocked ? `[BLOCKED] ${error.message}` : error)
  process.exitCode = 1
})
