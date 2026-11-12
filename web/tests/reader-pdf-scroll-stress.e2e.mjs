#!/usr/bin/env node

/**
 * PDF 连续滚动压力测试（真实 80MB / 857 页 JPX 样本）。
 *
 * 默认连接开发无密码预览：
 *   BASE_URL=http://192.168.100.170:8081
 * 也可指向本地 Vite：
 *   BASE_URL=http://127.0.0.1:5199
 *
 * 用法：
 *   node tests/reader-pdf-scroll-stress.e2e.mjs
 *   STRESS_LABEL=after STRESS_ASSERT=1 node tests/reader-pdf-scroll-stress.e2e.mjs
 *
 * 输出：/tmp/opencode/iread-pdf-scroll-stress-<label>.json 与截图目录。
 */

import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { chromium } from "playwright"

const BASE_URL = (process.env.BASE_URL ?? "http://192.168.100.170:8081").replace(
  /\/$/,
  "",
)
const BOOK_ID =
  process.env.PDF_BOOK_ID ?? "0f84b2c301c02032aa4d6694da378bc7"
const LABEL = process.env.STRESS_LABEL ?? "current"
const SHOULD_ASSERT = process.env.STRESS_ASSERT === "1"
const CHROME_PATH = process.env.CHROME_PATH ?? ""
const LOCAL_CHROME =
  "/home/superc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
const EXECUTABLE_PATH =
  CHROME_PATH ||
  (existsSync(LOCAL_CHROME) ? LOCAL_CHROME : chromium.executablePath())
const OUT_DIR =
  process.env.STRESS_OUT_DIR ?? path.join("/tmp/opencode", `iread-pdf-stress-${LABEL}`)
const SCREENSHOT_DIR = path.join(OUT_DIR, "shots")
const PAGE_COUNT = Number(process.env.PDF_PAGE_COUNT ?? "857")
const EXPECTED_LAYOUT = process.env.PDF_LAYOUT ?? "continuous"
const DPR = Number(process.env.STRESS_DPR ?? "1")

mkdirSync(SCREENSHOT_DIR, { recursive: true })

function logStep(name) {
  console.log(`\n[PDF-STRESS] ${name}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MONITOR_SCRIPT = String.raw`
(() => {
  const viewport = document.querySelector('.iread-pdf__viewport')
  const pagesHost = document.querySelector('.iread-pdf__pages')
  if (!viewport || !pagesHost) return 'no pdf viewport'
  const pages = [...pagesHost.querySelectorAll('.iread-pdf__page')]
  const pageNumbers = pages.map((el) => Number(el.dataset.pdfPage))
  let layout = []
  let coordinateBias = 0
  let lastLayoutAt = 0
  const rebuildLayout = () => {
    const viewportRect = viewport.getBoundingClientRect()
    const first = pages[0]
    coordinateBias = first
      ? first.getBoundingClientRect().top -
        viewportRect.top +
        viewport.scrollTop -
        first.offsetTop
      : 0
    layout = pages.map((el, index) => ({
      el,
      page: pageNumbers[index],
      top: el.offsetTop + coordinateBias,
      height: el.offsetHeight,
    }))
    lastLayoutAt = performance.now()
  }
  rebuildLayout()
  const monitor = {
    active: true,
    totalFrames: 0,
    blankFrames: 0,
    visibleSamples: 0,
    visibleNotCanvasReady: 0,
    visibleNoPlaceholder: 0,
    firstVisibleAt: new Map(),
    firstCanvasAt: new Map(),
    canvasDurations: [],
    stateEvents: [],
    maxRenderingInOneFrame: 0,
    raf: 0,
  }
  const isPainted = (el) => {
    const canvas = el.querySelector('canvas')
    const canvasReady =
      el.dataset.canvasReady === 'true' &&
      canvas !== null &&
      canvas.width > 0 &&
      canvas.height > 0
    if (canvasReady) return { painted: true, canvasReady, placeholder: false }
    const placeholder = el.querySelector('.iread-pdf__page-placeholder')
    const placeholderVisible =
      placeholder !== null && el.dataset.canvasReady !== 'true'
    return {
      painted: canvasReady || placeholderVisible,
      canvasReady,
      placeholder: placeholderVisible,
    }
  }
  const sample = () => {
    if (!monitor.active) return
    const now = performance.now()
    if (now - lastLayoutAt > 500) rebuildLayout()
    const scrollTop = viewport.scrollTop
    const viewportHeight = viewport.clientHeight
    let low = 0
    let high = layout.length - 1
    let firstIndex = layout.length
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const entry = layout[middle]
      if (entry.top + entry.height > scrollTop) {
        firstIndex = middle
        high = middle - 1
      } else {
        low = middle + 1
      }
    }
    const visible = []
    for (let index = firstIndex; index < layout.length; index += 1) {
      const entry = layout[index]
      if (entry.top >= scrollTop + viewportHeight) break
      if (entry.top + entry.height > scrollTop) visible.push(entry.el)
    }
    monitor.totalFrames += 1
    if (visible.length === 0) {
      monitor.blankFrames += 1
    } else {
      let anyPainted = false
      for (const el of visible) {
        const pageNumber = Number(el.dataset.pdfPage)
        const paint = isPainted(el)
        monitor.visibleSamples += 1
        if (!paint.canvasReady) monitor.visibleNotCanvasReady += 1
        if (!paint.canvasReady && !paint.placeholder) {
          monitor.visibleNoPlaceholder += 1
        }
        if (paint.painted) anyPainted = true
        if (!monitor.firstVisibleAt.has(pageNumber)) {
          monitor.firstVisibleAt.set(pageNumber, now)
        }
        if (paint.canvasReady && !monitor.firstCanvasAt.has(pageNumber)) {
          monitor.firstCanvasAt.set(pageNumber, now)
          monitor.canvasDurations.push({
            page: pageNumber,
            ms: Math.round(now - monitor.firstVisibleAt.get(pageNumber)),
          })
        }
      }
      if (!anyPainted) monitor.blankFrames += 1
    }
    if (monitor.totalFrames % 10 === 0) {
      const rendering = pagesHost.querySelectorAll(
        '.iread-pdf__page[data-state="rendering"]',
      ).length
      if (rendering > monitor.maxRenderingInOneFrame) {
        monitor.maxRenderingInOneFrame = rendering
      }
    }
    monitor.raf = requestAnimationFrame(sample)
  }
  monitor.start = () => {
    monitor.active = true
    monitor.raf = requestAnimationFrame(sample)
  }
  monitor.stop = () => {
    monitor.active = false
    cancelAnimationFrame(monitor.raf)
  }
  window.__pdfScrollStress = monitor
  return 'ok'
})()
`

const SUMMARY_SCRIPT = String.raw`
(() => {
  const monitor = window.__pdfScrollStress
  monitor.stop()
  const pages = [...document.querySelectorAll('.iread-pdf__page')]
  const states = {}
  let canvasCount = 0
  let canvasPixels = 0
  let canvasReadyCount = 0
  let placeholderCount = 0
  for (const el of pages) {
    const state = el.dataset.state || 'none'
    states[state] = (states[state] || 0) + 1
    const canvas = el.querySelector('canvas')
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      canvasCount += 1
      canvasPixels += canvas.width * canvas.height
    }
    if (el.dataset.canvasReady === 'true') canvasReadyCount += 1
    const placeholder = el.querySelector('.iread-pdf__page-placeholder')
    if (placeholder) {
      const style = getComputedStyle(placeholder)
      if (style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.01) {
        placeholderCount += 1
      }
    }
  }
  const durations = monitor.canvasDurations.map((entry) => entry.ms).sort((a, b) => a - b)
  return {
    totalFrames: monitor.totalFrames,
    blankFrames: monitor.blankFrames,
    blankFrameRatio: monitor.totalFrames
      ? +(monitor.blankFrames / monitor.totalFrames).toFixed(4)
      : null,
    visibleSamples: monitor.visibleSamples,
    visibleNotCanvasReady: monitor.visibleNotCanvasReady,
    visibleNotCanvasReadyRatio: monitor.visibleSamples
      ? +(monitor.visibleNotCanvasReady / monitor.visibleSamples).toFixed(4)
      : null,
    visibleReadyRatio: monitor.visibleSamples
      ? +((monitor.visibleSamples - monitor.visibleNotCanvasReady) / monitor.visibleSamples).toFixed(4)
      : null,
    visibleNoPlaceholderRatio: monitor.visibleSamples
      ? +(monitor.visibleNoPlaceholder / monitor.visibleSamples).toFixed(4)
      : null,
    canvasReadyDurations: monitor.canvasDurations.slice(0, 120),
    canvasReadyMedianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    canvasReadyMaxMs: durations.length ? durations[durations.length - 1] : null,
    maxRenderingInOneFrame: monitor.maxRenderingInOneFrame,
    states,
    canvasCount,
    canvasPixels,
    canvasPixelsBudgetPct: null,
    canvasReadyCount,
    placeholderVisibleCount: placeholderCount,
    scrollTop: Math.round(document.querySelector('.iread-pdf__viewport')?.scrollTop ?? 0),
  }
})()
`

async function waitForPdf(page) {
  await page.waitForFunction(
    (pageCount) => {
      const root = document.querySelector(".iread-pdf")
      return (
        root?.getAttribute("data-pdf-state") === "ready" &&
        Number(root.getAttribute("data-pdf-page-count")) === pageCount
      )
    },
    PAGE_COUNT,
    { timeout: 60_000, polling: 100 },
  )
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.iread-pdf__page[data-state="ready"] canvas',
      ) !== null,
    undefined,
    { timeout: 30_000, polling: 100 },
  )
}

async function ensureLayout(page) {
  const current = await page
    .locator(".iread-pdf__pages")
    .getAttribute("data-layout")
  if (current === EXPECTED_LAYOUT) {
    return
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const button = page.locator("[data-reader-pdf-layout]").first()
    if ((await button.count()) === 0) {
      break
    }
    await button.evaluate((element) => element.click())
    await page.waitForTimeout(500)
    const next = await page
      .locator(".iread-pdf__pages")
      .getAttribute("data-layout")
    if (next === EXPECTED_LAYOUT) {
      return
    }
  }
  throw new Error(
    `无法切换到 ${EXPECTED_LAYOUT} 布局（当前 ${await page
      .locator(".iread-pdf__pages")
      .getAttribute("data-layout")}）`,
  )
}

async function ensureFitWidth(page) {
  const zoom = await page.locator(".iread-pdf").getAttribute("data-zoom")
  if (zoom === "fit-width") {
    return
  }
  const button = page.locator("[data-reader-pdf-fit-width]").first()
  if ((await button.count()) === 0) {
    return
  }
  await button.evaluate((element) => element.click())
  await page.waitForTimeout(400)
}

async function scrollToPage(page, targetPage) {
  await page.evaluate((target) => {
    const viewport = document.querySelector(".iread-pdf__viewport")
    const pages = [...document.querySelectorAll(".iread-pdf__page")]
    const chosen = pages[Math.max(0, Math.min(target - 1, pages.length - 1))]
    if (!viewport || !chosen) return
    viewport.scrollTop = Math.max(0, chosen.offsetTop - 8)
  }, targetPage)
  await page.waitForTimeout(1_500)
}

async function analyzeScreenshot(page, buffer) {
  const base64 = buffer.toString("base64")
  return page.evaluate(async (data) => {
    if (!window.__stressCanvas) {
      const canvas = document.createElement("canvas")
      canvas.width = 160
      canvas.height = 90
      window.__stressCanvas = canvas
      window.__stressContext = canvas.getContext("2d", {
        willReadFrequently: true,
      })
    }
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const context = window.__stressContext
    context.clearRect(0, 0, 160, 90)
    context.drawImage(image, 0, 0, 160, 90)
    const pixels = context.getImageData(0, 0, 160, 90).data
    let white = 0
    let total = 0
    let luminance = 0
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index]
      const green = pixels[index + 1]
      const blue = pixels[index + 2]
      total += 1
      luminance += red * 0.2126 + green * 0.7152 + blue * 0.0722
      if (red >= 250 && green >= 250 && blue >= 250) white += 1
    }
    return {
      whiteRatio: +(white / total).toFixed(4),
      meanLuminance: +(luminance / total).toFixed(2),
    }
  }, base64)
}

async function runScenario(page, scenario) {
  logStep(
    `${scenario.name}（${scenario.pps} 页/秒，${scenario.pages} 页，${
      scenario.reverse ? "反向" : "正向"
    }）`,
  )
  await scrollToPage(page, scenario.startPage)
  await page.waitForTimeout(2_000)

  const geometry = await page.evaluate(() => {
    const viewport = document.querySelector(".iread-pdf__viewport")
    const pages = [...document.querySelectorAll(".iread-pdf__page")]
    const first = pages[0]?.getBoundingClientRect()
    const second = pages[1]?.getBoundingClientRect()
    const third = pages[2]?.getBoundingClientRect()
    return {
      step: second && first ? second.top - first.top : (first?.height ?? 800) + 12,
      step2: third && second ? third.top - second.top : null,
      viewportHeight: viewport?.clientHeight ?? 0,
      scrollHeight: viewport?.scrollHeight ?? 0,
    }
  })

  const monitor = await page.evaluate(MONITOR_SCRIPT)
  assert.equal(monitor, "ok", "压力监视器初始化失败")
  await page.evaluate(() => {
    window.__pdfScrollStress.start()
  })

  const pdfBox = await page.locator(".iread-pdf").boundingBox()
  const stripHeight = Math.min(180, pdfBox?.height ?? 180)
  const stripWidth = Math.min(960, pdfBox?.width ?? 960)
  const clip = pdfBox
    ? {
        x: Math.max(0, pdfBox.x + Math.max(0, (pdfBox.width - stripWidth) / 2)),
        y: Math.max(
          0,
          pdfBox.y + Math.max(0, (pdfBox.height - stripHeight) / 2),
        ),
        width: Math.max(1, stripWidth),
        height: Math.max(1, stripHeight),
      }
    : null
  const clips = []
  let samplerRunning = false
  const startSampler = async () => {
    samplerRunning = true
    while (samplerRunning) {
      const started = Date.now()
      try {
        if (clip) {
          const buffer = await page.screenshot({
            type: "jpeg",
            quality: 45,
            clip,
          })
          const analysis = await analyzeScreenshot(page, buffer)
          clips.push({ t: Date.now(), ...analysis })
        }
      } catch {
        // 滚动期间截图失败不影响主采样。
      }
      const elapsed = Date.now() - started
      await sleep(Math.max(80, 350 - elapsed))
    }
  }

  const startedAt = Date.now()
  const scrollPromise = page.evaluate(
    async ({ step, pages, interval, reverse, maxScroll }) => {
      const viewport = document.querySelector(".iread-pdf__viewport")
      if (!viewport) return
      for (let index = 0; index < pages; index += 1) {
        const next = viewport.scrollTop + (reverse ? -step : step)
        viewport.scrollTop = Math.max(0, Math.min(next, maxScroll))
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    },
    {
      step: geometry.step,
      pages: scenario.pages,
      interval: 1000 / scenario.pps,
      reverse: scenario.reverse,
      maxScroll: geometry.scrollHeight - geometry.viewportHeight,
    },
  )
  await sleep(40)
  const samplerPromise = startSampler()
  await scrollPromise
  const scrollElapsedMs = Date.now() - startedAt
  samplerRunning = false
  await samplerPromise
  await page.waitForTimeout(2_000)

  const summary = await page.evaluate(SUMMARY_SCRIPT)
  const whiteRatios = clips.map((entry) => entry.whiteRatio)
  const meanLuminance = clips.map((entry) => entry.meanLuminance)
  const result = {
    ...summary,
    name: scenario.name,
    pps: scenario.pps,
    pagesScrolled: scenario.pages,
    reverse: scenario.reverse,
    scrollElapsedMs,
    actualPagesPerSecond: +(
      scenario.pages /
      Math.max(0.001, scrollElapsedMs / 1000)
    ).toFixed(2),
    geometry,
    screenshotSamples: clips.length,
    screenshotWhiteRatioMedian: whiteRatios.length
      ? +whiteRatios.sort((a, b) => a - b)[Math.floor(whiteRatios.length / 2)].toFixed(4)
      : null,
    screenshotWhiteRatioMax: whiteRatios.length ? Math.max(...whiteRatios) : null,
    screenshotWhiteRatioOver995: whiteRatios.filter((ratio) => ratio >= 0.995).length,
    screenshotMeanLuminanceMedian: meanLuminance.length
      ? +meanLuminance.sort((a, b) => a - b)[Math.floor(meanLuminance.length / 2)].toFixed(2)
      : null,
    clips,
  }
  console.log(JSON.stringify(result))
  const screenshotPath = path.join(
    SCREENSHOT_DIR,
    `${LABEL}-${scenario.name}.png`,
  )
  await page.screenshot({ path: screenshotPath })
  result.screenshotPath = screenshotPath
  return result
}

async function checkSettled(page, label, budgetPixels) {
  logStep(`${label}：静止 13s 后检查残留与预算`)
  await page.waitForTimeout(13_000)
  const result = await page.evaluate((budget) => {
    const pages = [...document.querySelectorAll(".iread-pdf__page")]
    const states = {}
    let rendering = 0
    let canvasCount = 0
    let canvasPixels = 0
    for (const el of pages) {
      const state = el.dataset.state || "none"
      states[state] = (states[state] || 0) + 1
      if (state === "rendering") rendering += 1
      const canvas = el.querySelector("canvas")
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        canvasCount += 1
        canvasPixels += canvas.width * canvas.height
      }
    }
    return {
      rendering,
      states,
      canvasCount,
      canvasPixels,
      budgetPixels: budget,
      budgetPct: budget ? +((canvasPixels / budget) * 100).toFixed(1) : null,
    }
  }, budgetPixels)
  console.log(JSON.stringify(result))
  return result
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  })
  const results = { label: LABEL, baseUrl: BASE_URL, bookId: BOOK_ID, scenarios: [] }
  try {
    for (const viewportSpec of [
      { width: 1920, height: 1080, name: "desktop", coarse: false },
      { width: 390, height: 844, name: "mobile", coarse: true },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewportSpec.width, height: viewportSpec.height },
        deviceScaleFactor: DPR,
        isMobile: viewportSpec.coarse,
        hasTouch: viewportSpec.coarse,
        locale: "zh-CN",
        serviceWorkers: "block",
      })
      const page = await context.newPage()
      const consoleErrors = []
      page.on("pageerror", (error) =>
        consoleErrors.push(`${error.name}: ${error.message}`),
      )
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text())
      })

      logStep(`打开 ${BASE_URL}/read/${BOOK_ID}（${viewportSpec.name}）`)
      await page.goto(`${BASE_URL}/read/${BOOK_ID}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForPdf(page)
      await page.waitForTimeout(3_000)
      await ensureLayout(page)
      await page.waitForTimeout(1_000)
      await ensureLayout(page)
      await ensureFitWidth(page)
      await page.waitForTimeout(1_000)

      const budgetPixels = viewportSpec.coarse ? 12_000_000 : 40_000_000
      const scenarios = viewportSpec.coarse
        ? [
            { name: "mobile-20pps", pps: 20, pages: 40, reverse: false, startPage: 420 },
            { name: "mobile-100pps", pps: 100, pages: 60, reverse: false, startPage: 300 },
            { name: "mobile-reverse-100pps", pps: 100, pages: 60, reverse: true, startPage: 600 },
          ]
        : [
            { name: "desktop-20pps", pps: 20, pages: 60, reverse: false, startPage: 420 },
            { name: "desktop-100pps", pps: 100, pages: 100, reverse: false, startPage: 300 },
            { name: "desktop-reverse-100pps", pps: 100, pages: 80, reverse: true, startPage: 700 },
          ]

      for (const scenario of scenarios) {
        results.scenarios.push(
          await runScenario(page, { ...scenario, viewport: viewportSpec.name }),
        )
      }
      results[`${viewportSpec.name}Settled`] = await checkSettled(
        page,
        viewportSpec.name,
        budgetPixels,
      )
      results[`${viewportSpec.name}ConsoleErrors`] = consoleErrors
      await context.close()
    }
  } finally {
    await browser.close()
  }

  const outputPath = path.join(OUT_DIR, `summary-${LABEL}.json`)
  writeFileSync(outputPath, JSON.stringify(results, null, 2))
  console.log(`\n[PDF-STRESS] 汇总写入 ${outputPath}`)

  if (SHOULD_ASSERT) {
    const failures = []
    for (const scenario of results.scenarios) {
      if (scenario.pps <= 20 && scenario.blankFrameRatio > 0.05) {
        failures.push(`${scenario.name} 纯白帧 ${scenario.blankFrameRatio} > 5%`)
      }
      if (scenario.pps > 20 && scenario.blankFrameRatio > 0.1) {
        failures.push(`${scenario.name} 纯白帧 ${scenario.blankFrameRatio} > 10%`)
      }
    }
    for (const key of ["desktopSettled", "mobileSettled"]) {
      const settled = results[key]
      if (settled && settled.rendering !== 0) {
        failures.push(`${key} 静止 13s 后仍有 ${settled.rendering} 页 rendering`)
      }
      if (settled && settled.canvasPixels > settled.budgetPixels * 1.2) {
        failures.push(
          `${key} canvas 像素 ${settled.canvasPixels} 超出预算 ${settled.budgetPixels} 的 120%`,
        )
      }
    }
    assert.equal(failures.length, 0, failures.join("；"))
  }
}

main().catch((error) => {
  console.error(`[PDF-STRESS] 失败：${error.stack ?? error}`)
  process.exitCode = 1
})
