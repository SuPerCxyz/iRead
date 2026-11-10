import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { chromium } from "playwright"

// 只接受任务自建隔离环境；不默认为任何现有服务或用户数据库。
const connectionPath = process.env.IREAD_READER_FIX_CONNECTION
assert.ok(connectionPath?.startsWith("/tmp/"), "需要隔离connection文件")
const fixture = JSON.parse(readFileSync(connectionPath, "utf8"))
assert.ok(fixture.webBase.startsWith("http://127.0.0.1:"))
assert.ok(fixture.statePath.startsWith(path.dirname(connectionPath)))
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 803 }, storageState: fixture.statePath, serviceWorkers: "block" })
  await page.goto(`${fixture.webBase}/read/${fixture.bookId}`)
  await page.waitForSelector("[data-reader-engine-ready]", { timeout: 30000 })
  const geometry = await page.evaluate(() => {
    const view = document.querySelector("[data-reader-epub] foliate-view")
    const renderer = view.renderer
    const doc = renderer.getContents()[0].doc
    const iframe = doc.defaultView.frameElement
    const top = iframe.getRootNode().getElementById("top")
    const host = document.querySelector("[data-reader-epub]")
    return { hostHeight: host.getBoundingClientRect().height, iframeHeight: iframe.getBoundingClientRect().height, margin: renderer.getAttribute("margin"), maxBlock: renderer.getAttribute("max-block-size"), rows: getComputedStyle(top).gridTemplateRows, validMargin: CSS.supports("margin-top", renderer.getAttribute("margin")) }
  })
  writeFileSync(path.join(fixture.runtime, "viewport-regression.json"), JSON.stringify(geometry, null, 2))
  assert.ok(geometry.validMargin, `Foliate margin必须为有效CSS长度：${geometry.margin}`)
  assert.ok(Math.abs(geometry.iframeHeight - Math.min(parseFloat(geometry.maxBlock), geometry.hostHeight - 2 * parseFloat(geometry.margin))) < 2, `正文页区高度异常：${JSON.stringify(geometry)}`)
  await page.screenshot({ path: path.join(fixture.runtime, "shots/after-viewport.png") })
  const position = () => page.evaluate(() => { const v = document.querySelector("foliate-view"); return JSON.stringify({ index: v.renderer.getContents()[0]?.index, page: v.renderer.page, cfi: v.lastLocation?.cfi }) })
  const actualFrame = async () => {
    for (let attempt=0;attempt<3;attempt++) {
      const token=String(Math.random())
      await page.evaluate(token=>document.querySelector("foliate-view").renderer.getContents()[0].doc.documentElement.setAttribute("data-reader-test-frame",token),token)
      for (const frame of page.frames()) if(frame!==page.mainFrame() && await frame.evaluate(token=>document.documentElement.getAttribute("data-reader-test-frame")===token,token).catch(()=>false)) return frame
    }
    throw Error("未能取得当前EPUB正文iframe")
  }
  let contentFrame = await actualFrame()
  assert.ok(contentFrame, "需要真实EPUB iframe")
  await contentFrame.locator("body").evaluate(body => { body.tabIndex = -1; body.focus() })
  await contentFrame.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let text; while ((text = walker.nextNode()) && (text.textContent?.trim().length ?? 0) < 4) { /* 定位正文，不输出内容。 */ }
    if (text) { const range = document.createRange(); range.setStart(text, 0); range.collapse(true); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range) }
  })
  const beforeSelection = await position()
  await page.keyboard.press("Shift+ArrowRight")
  assert.equal(await position(), beforeSelection, "Shift+方向键保留正文原生选区，不翻页")
  await contentFrame.evaluate(() => document.getSelection()?.removeAllRanges())
  const beforeKey = await position()
  await page.keyboard.press("ArrowRight")
  await page.waitForFunction(previous => { const v = document.querySelector("foliate-view"); return v.lastLocation?.cfi !== JSON.parse(previous).cfi && v.lastLocation?.range?.startContainer?.ownerDocument === v.renderer.getContents()[0]?.doc }, beforeKey)
  await page.waitForFunction(() => document.querySelector("foliate-view")?.renderer?.getContents?.()[0]?.doc?.defaultView?.frameElement?.isConnected === true)
  contentFrame = await actualFrame()
  await contentFrame.evaluate(() => { const input = document.createElement("input"); input.id = "trusted-test-input"; input.style.position = "fixed"; document.body.append(input); input.focus() })
  await page.waitForFunction(() => {
    const view=document.querySelector("foliate-view"), value=JSON.stringify({ index:view.renderer.getContents()[0]?.index,page:view.renderer.page,cfi:view.lastLocation?.cfi })
    const now=performance.now(), state=window.__ireadStablePosition
    if(!state || state.value!==value) { window.__ireadStablePosition={value,since:now};return false }
    return now-state.since>250
  }, undefined, { timeout:10000 })
  const beforeInput = await position()
  const inputActive = await contentFrame.evaluate(() => ({ id:document.activeElement?.id, tag:document.activeElement?.tagName }))
  assert.equal(inputActive.id,"trusted-test-input","必须在实际正文输入控件中发送按键")
  await page.keyboard.press("ArrowRight")
  assert.equal(await position(), beforeInput, "跨realm输入控件不能触发翻页")
  await contentFrame.locator("#trusted-test-input").evaluate(input => input.remove()).catch(() => {})
  await page.evaluate(() => {
    const view=document.querySelector("foliate-view"),doc=view.renderer.getContents()[0].doc
    const link=doc.createElement("a");link.id="trusted-test-link";link.href="#";link.textContent="test link"
    link.addEventListener("pointerdown",event=>event.preventDefault())
    link.addEventListener("click",event=>{doc.defaultView.__trustedLinkClick=event.isTrusted;event.preventDefault();event.stopPropagation()})
    const range=view.lastLocation.range.cloneRange();range.collapse(true);range.insertNode(link)
  })
  contentFrame=await actualFrame()
  const beforeLink=JSON.parse(await position()), beforeToolbars=await page.locator("[data-toolbars]").getAttribute("data-toolbars")
  await contentFrame.locator("#trusted-test-link").click()
  assert.equal(await contentFrame.evaluate(()=>window.__trustedLinkClick),true,"必须实际可信点击正文链接")
  const afterLink=JSON.parse(await position())
  assert.equal(afterLink.index,beforeLink.index);assert.equal(afterLink.page,beforeLink.page,"正文链接不能被侧区手势抢成翻页")
  assert.equal(await page.locator("[data-toolbars]").getAttribute("data-toolbars"),beforeToolbars,"正文链接不能触发中区工具栏")
  await contentFrame.locator("#trusted-test-link").evaluate(link => link.remove())
  await contentFrame.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node
    while ((node=walker.nextNode()) && (node.textContent?.trim().length ?? 0)<5) { /* 不输出正文。 */ }
    if(node) { const range=document.createRange(); range.setStart(node,0); range.setEnd(node,4); const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range) }
  })
  const beforeSelected = await position(); await page.keyboard.press("ArrowRight"); assert.equal(await position(), beforeSelected, "已有选区不能被方向键抢成翻页")
  await contentFrame.evaluate(() => document.getSelection()?.removeAllRanges())
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: fixture.statePath, serviceWorkers: "block" })
  await mobile.goto(`${fixture.webBase}/read/${fixture.bookId}`)
  await mobile.waitForSelector("[data-reader-engine-ready]", { timeout: 30000 })
  const section=await mobile.evaluate(()=>Math.floor(document.querySelector("foliate-view").book.sections.length*0.6))
  await mobile.evaluate(async section=>{await document.querySelector("foliate-view").goTo(section)},section)
  await mobile.waitForFunction(section=>document.querySelector("foliate-view").renderer.getContents()[0]?.index===section,section)
  const middle = () => mobile.evaluate(() => {
    const d=document.querySelector("foliate-view").renderer.getContents()[0].doc,frame=d.defaultView.frameElement.getBoundingClientRect(),host=document.querySelector("[data-reader-epub]").getBoundingClientRect()
    const left=Math.max(0,host.left,frame.left),right=Math.min(innerWidth,host.right,frame.right),top=Math.max(host.top,frame.top),bottom=Math.min(innerHeight,host.bottom,frame.bottom)
    for(const y of [(top+bottom)/2,top+(bottom-top)*0.3,top+(bottom-top)*0.7]) {
      const x=(left+right)/2, target=d.elementFromPoint((x-frame.left)*d.documentElement.clientWidth/frame.width,(y-frame.top)*d.documentElement.clientHeight/frame.height)
      if(target && !target.closest("a[href],button,input,select,textarea,[contenteditable]"))return{x,y}
    }
    throw Error("当前中区没有非交互正文触点")
  })
  let point = await middle(); await mobile.touchscreen.tap(point.x, point.y)
  await mobile.waitForSelector('[data-toolbars="hidden"]')
  point = await middle(); await mobile.touchscreen.tap(point.x, point.y)
  await mobile.waitForSelector('[data-toolbars="visible"]')
  await mobile.screenshot({ path: path.join(fixture.runtime, "shots/mobile-content-input.png") })
  const beforeSide = await mobile.evaluate(() => document.querySelector("foliate-view").lastLocation?.cfi)
  point = await middle(); await mobile.touchscreen.tap(point.x + 0.35 * 390, point.y)
  await mobile.waitForFunction(previous => document.querySelector("foliate-view").lastLocation?.cfi !== previous, beforeSide)
  const beforeRotate = await mobile.evaluate(() => document.querySelector("foliate-view").renderer.getContents()[0].index)
  await mobile.setViewportSize({ width: 844, height: 390 })
  await mobile.waitForFunction(() => document.querySelector("[data-reader-epub]").getBoundingClientRect().width > 600)
  const rotated = await mobile.evaluate(() => { const view=document.querySelector("foliate-view"),frame=view.renderer.getContents()[0].doc.defaultView.frameElement; return { host:document.querySelector("[data-reader-epub]").getBoundingClientRect().height, iframe:frame.getBoundingClientRect().height,index:view.renderer.getContents()[0].index } })
  assert.ok(rotated.iframe > 0 && rotated.iframe <= rotated.host, "旋转后正文仍在可用宿主内")
  assert.equal(rotated.index,beforeRotate,"旋转保留当前章节")
  await mobile.screenshot({ path: path.join(fixture.runtime, "shots/mobile-landscape.png") })
  console.log("PASS actual EPUB viewport, iframe keyboard/input guard and real touch", JSON.stringify(geometry))
} finally { await browser.close() }
