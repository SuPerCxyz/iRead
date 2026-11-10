import {
  fragmentElement,
  resolveArchiveHref,
  type EpubResourceClient,
  type EpubResourceEntry,
} from "./resources"
import { buildBaselineCss } from "./settings"

const XHTML_NS = "http://www.w3.org/1999/xhtml"
const MAX_STYLESHEETS = 16
const MAX_ASSETS = 96
const MAX_CSS_DEPTH = 4

export const EPUB_CONTENT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src blob: data:",
  "style-src blob: data: 'unsafe-inline'",
  "font-src blob: data:",
  "media-src blob: data:",
].join("; ")

export interface SanitizeChapterInput {
  html: string
  mediaType: string
  chapterHref: string
  publisherCssMode: "publisher" | "off"
  resources: EpubResourceClient
  signal: AbortSignal
  urls?: Set<string>
}

export interface SanitizedChapter {
  html: string
  contentType: "application/xhtml+xml" | "text/html"
  urls: string[]
}

interface ResourceContext {
  chapterHref: string
  resources: EpubResourceClient
  signal: AbortSignal
  urls: Set<string>
  urlsById: Map<string, string>
  assets: number
}

function createHtmlElement(doc: Document, tag: string): HTMLElement {
  return doc.createElementNS(XHTML_NS, tag) as HTMLElement
}

function attributeList(element: Element): Attr[] {
  return Array.from(element.attributes)
}

function localName(element: Element): string {
  return element.localName.toLowerCase()
}

function isExternal(value: string): boolean {
  return (
    value.startsWith("//") ||
    /^(?!blob:)[a-z][a-z0-9+.-]*:/i.test(value)
  )
}

function removeDangerousElements(doc: Document): void {
  const selector = [
    "script",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "form",
    "base",
    "template",
    "input",
    "button",
    "select",
    "textarea",
    "option",
    "video",
    "audio",
    "source",
    "track",
  ].join(",")
  for (const element of Array.from(doc.querySelectorAll(selector))) {
    element.remove()
  }
  for (const meta of Array.from(doc.querySelectorAll("meta[http-equiv]"))) {
    meta.remove()
  }
  for (const link of Array.from(doc.querySelectorAll("link"))) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/)
    if (!rel.includes("stylesheet")) {
      link.remove()
    }
  }
}

function removeProcessingInstructions(doc: Document): void {
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_PROCESSING_INSTRUCTION)
  const nodes: Node[] = []
  while (walker.nextNode() !== null) {
    nodes.push(walker.currentNode)
  }
  for (const node of nodes) {
    node.parentNode?.removeChild(node)
  }
  doc.doctype?.remove()
}

function ensureHead(doc: Document): HTMLElement {
  const existing = doc.head
  if (existing !== null) {
    return existing
  }
  const head = createHtmlElement(doc, "head")
  if (doc.documentElement === null) {
    throw new Error("章节缺少根元素")
  }
  doc.documentElement.insertBefore(head, doc.documentElement.firstChild)
  return head
}

function insertCspMeta(doc: Document): void {
  const head = ensureHead(doc)
  for (const meta of Array.from(
    head.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]'),
  )) {
    meta.remove()
  }
  const meta = createHtmlElement(doc, "meta")
  meta.setAttribute("http-equiv", "Content-Security-Policy")
  meta.setAttribute("content", EPUB_CONTENT_CSP)
  head.insertBefore(meta, head.firstChild)
}

function appendBaselineStyle(doc: Document): void {
  const head = ensureHead(doc)
  const style = createHtmlElement(doc, "style")
  style.setAttribute("data-iread-baseline", "")
  style.textContent = buildBaselineCss()
  head.append(style)
}

async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(regex)]
  if (matches.length === 0) {
    return input
  }
  let output = ""
  let last = 0
  for (const match of matches) {
    output += input.slice(last, match.index ?? 0)
    output += await replacer(match)
    last = (match.index ?? 0) + match[0].length
  }
  return output + input.slice(last)
}

function resourceUrl(
  context: ResourceContext,
  entry: EpubResourceEntry,
): Promise<string | null> {
  const cached = context.urlsById.get(entry.resourceId)
  if (cached !== undefined) {
    return Promise.resolve(cached)
  }
  if (context.assets >= MAX_ASSETS) {
    return Promise.resolve(null)
  }
  context.assets += 1
  return context.resources
    .objectUrl(entry, context.urls, context.signal)
    .then((url) => {
      context.urlsById.set(entry.resourceId, url)
      return url
    })
    .catch(() => null)
}

async function resolveResource(
  context: ResourceContext,
  rawHref: string,
): Promise<string | null> {
  const resolved = resolveArchiveHref(context.chapterHref, rawHref)
  if (resolved === null || resolved.external) {
    return null
  }
  const entry = context.resources.resolve(resolved.path)
  if (entry === null) {
    return null
  }
  return resourceUrl(context, entry)
}

async function rewriteCss(
  value: string,
  cssHref: string,
  context: ResourceContext,
  depth: number,
): Promise<string> {
  let text = value.replace(/<\/style/gi, "<\\/style")
  text = text.replace(/expression\s*\(/gi, "(")
  text = text.replace(/behavior\s*:[^;}]*;?/gi, "")
  text = text.replace(/-moz-binding\s*:[^;}]*;?/gi, "")

  const importPattern =
    /@import\s+(?:url\(\s*)?(?:(['"])(.*?)\1|([^'"()\s;]+))\s*\)?\s*([^;]*);/gi
  text = await replaceAsync(text, importPattern, async (match) => {
    const target = (match[2] ?? match[3] ?? "").trim()
    if (target.length === 0 || isExternal(target)) {
      return ""
    }
    if (depth >= MAX_CSS_DEPTH) {
      return ""
    }
    const resolved = resolveArchiveHref(cssHref, target)
    if (resolved === null || resolved.external) {
      return ""
    }
    const entry = context.resources.resolve(resolved.path)
    if (entry === null) {
      return ""
    }
    try {
      const nestedText = await context.resources.getText(entry, context.signal)
      const nested = await rewriteCss(
        nestedText,
        entry.href,
        context,
        depth + 1,
      )
      const media = (match[4] ?? "").trim()
      return media.length > 0 && media !== "all"
        ? `@media ${media} {\n${nested}\n}`
        : nested
    } catch {
      return ""
    }
  })

  const urlPattern = /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi
  return replaceAsync(text, urlPattern, async (match) => {
    const target = (match[2] ?? match[3] ?? "").trim()
    if (
      target.length === 0 ||
      target.startsWith("#") ||
      /^(?:data|blob|about):/i.test(target)
    ) {
      return match[0]
    }
    if (isExternal(target)) {
      return 'url("about:blank")'
    }
    const url = await resolveResource(context, target)
    return url === null ? 'url("about:blank")' : `url("${url}")`
  })
}

async function processStylesheetLinks(
  doc: Document,
  context: ResourceContext,
  publisherCssMode: "publisher" | "off",
): Promise<void> {
  let count = 0
  for (const link of Array.from(
    doc.querySelectorAll('link[rel~="stylesheet" i]'),
  )) {
    if (
      publisherCssMode === "off" ||
      count >= MAX_STYLESHEETS ||
      link.getAttribute("href") === null
    ) {
      link.remove()
      continue
    }
    count += 1
    const rawHref = link.getAttribute("href") ?? ""
    const resolved = resolveArchiveHref(context.chapterHref, rawHref)
    if (resolved === null || resolved.external) {
      link.remove()
      continue
    }
    const entry = context.resources.resolve(resolved.path)
    if (entry === null) {
      link.remove()
      continue
    }
    try {
      const css = await context.resources.getText(entry, context.signal)
      const rewritten = await rewriteCss(css, entry.href, context, 0)
      const style = createHtmlElement(doc, "style")
      const media = link.getAttribute("media")
      if (media !== null && media.length > 0) {
        style.setAttribute("media", media)
      }
      style.textContent = rewritten
      link.replaceWith(style)
    } catch {
      link.remove()
    }
  }
}

async function processStyleElements(
  doc: Document,
  context: ResourceContext,
  publisherCssMode: "publisher" | "off",
): Promise<void> {
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    if (style.getAttribute("data-iread-baseline") !== null) {
      continue
    }
    if (publisherCssMode === "off") {
      style.remove()
      continue
    }
    style.textContent = await rewriteCss(
      style.textContent ?? "",
      context.chapterHref,
      context,
      0,
    )
  }
}

function sanitizeAnchor(
  element: Element,
  context: ResourceContext,
): void {
  const rawHref = element.getAttribute("href")
  if (rawHref === null) {
    return
  }
  if (rawHref.startsWith("#")) {
    return
  }
  if (isExternal(rawHref)) {
    element.removeAttribute("href")
    element.removeAttribute("target")
    element.removeAttribute("download")
    element.setAttribute("data-iread-blocked-link", "external")
    return
  }
  const resolved = resolveArchiveHref(context.chapterHref, rawHref)
  if (resolved === null || resolved.external) {
    element.removeAttribute("href")
    return
  }
  const fragment = resolved.fragment.length > 0
    ? `#${resolved.fragment}`
    : ""
  element.setAttribute("href", `${resolved.path}${fragment}`)
}

async function sanitizeSourceAttribute(
  element: Element,
  attribute: string,
  context: ResourceContext,
): Promise<void> {
  const value = element.getAttribute(attribute)
  if (value === null) {
    return
  }
  if (/^(?:data|blob):/i.test(value)) {
    return
  }
  const url = await resolveResource(context, value)
  if (url === null) {
    element.removeAttribute(attribute)
  } else {
    element.setAttribute(attribute, url)
  }
}

async function sanitizeSrcset(
  element: Element,
  context: ResourceContext,
): Promise<void> {
  const value = element.getAttribute("srcset")
  if (value === null) {
    return
  }
  if (value.includes("data:")) {
    return
  }
  const parts = value.split(/,\s+/)
  const rewritten: string[] = []
  for (const part of parts) {
    const match = /^(\S+)(.*)$/.exec(part.trim())
    if (match === null) {
      continue
    }
    const url = await resolveResource(context, match[1])
    if (url !== null) {
      rewritten.push(`${url}${match[2]}`)
    }
  }
  if (rewritten.length === 0) {
    element.removeAttribute("srcset")
  } else {
    element.setAttribute("srcset", rewritten.join(", "))
  }
}

async function sanitizeAttributes(
  doc: Document,
  context: ResourceContext,
  publisherCssMode: "publisher" | "off",
): Promise<void> {
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    const tag = localName(element)
    for (const attribute of attributeList(element)) {
      const name = attribute.name.toLowerCase()
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "action" ||
        name === "formaction" ||
        name === "ping" ||
        name === "target" ||
        name === "download" ||
        name === "nonce" ||
        name === "integrity" ||
        name === "crossorigin" ||
        name === "referrerpolicy" ||
        name === "autofocus" ||
        name === "contenteditable" ||
        name === "xml:base"
      ) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === "style") {
        if (publisherCssMode === "off") {
          element.removeAttribute("style")
        } else {
          element.setAttribute(
            "style",
            await rewriteCss(attribute.value, context.chapterHref, context, 0),
          )
        }
        continue
      }
      if (name === "background") {
        await sanitizeSourceAttribute(element, attribute.name, context)
        continue
      }
      if (name === "srcset") {
        await sanitizeSrcset(element, context)
        continue
      }
      if (name === "src" || name === "poster") {
        if (tag === "img" || tag === "image" || tag === "source") {
          await sanitizeSourceAttribute(element, attribute.name, context)
        } else {
          element.removeAttribute(attribute.name)
        }
        continue
      }
      if (name === "href" || name === "xlink:href") {
        if (tag === "a" || tag === "area") {
          sanitizeAnchor(element, context)
        } else if (tag === "image" || tag === "use") {
          const value = attribute.value
          if (value.startsWith("#")) {
            continue
          }
          const url = await resolveResource(context, value)
          if (url === null) {
            element.removeAttribute(attribute.name)
          } else {
            element.setAttribute(attribute.name, url)
          }
        } else if (tag !== "link") {
          element.removeAttribute(attribute.name)
        }
      }
    }
    if (tag === "img") {
      const src = element.getAttribute("src")
      const srcset = element.getAttribute("srcset")
      if (src === null && srcset === null) {
        element.setAttribute("alt", element.getAttribute("alt") ?? "图片未能加载")
      }
    }
  }
}

export function parseChapterDocument(
  html: string,
  mediaType: string,
): { doc: Document; xml: boolean } {
  const parser = new DOMParser()
  const xhtml =
    mediaType === "application/xhtml+xml" ||
    mediaType === "application/xml" ||
    mediaType === "text/xml"
  if (xhtml) {
    const xmlDoc = parser.parseFromString(html, "application/xhtml+xml")
    const parserError = xmlDoc.getElementsByTagName("parsererror")
    if (
      parserError.length === 0 &&
      xmlDoc.documentElement !== null &&
      xmlDoc.body !== null
    ) {
      return { doc: xmlDoc, xml: true }
    }
  }
  const htmlDoc = parser.parseFromString(html, "text/html")
  if (htmlDoc.body === null) {
    throw new Error("章节正文为空或无法解析")
  }
  return { doc: htmlDoc, xml: false }
}

export async function sanitizeChapter(
  input: SanitizeChapterInput,
): Promise<SanitizedChapter> {
  const { doc, xml } = parseChapterDocument(input.html, input.mediaType)
  removeProcessingInstructions(doc)
  removeDangerousElements(doc)
  const context: ResourceContext = {
    chapterHref: input.chapterHref,
    resources: input.resources,
    signal: input.signal,
    urls: input.urls ?? new Set<string>(),
    urlsById: new Map<string, string>(),
    assets: 0,
  }
  await processStylesheetLinks(doc, context, input.publisherCssMode)
  await processStyleElements(doc, context, input.publisherCssMode)
  await sanitizeAttributes(doc, context, input.publisherCssMode)
  insertCspMeta(doc)
  appendBaselineStyle(doc)
  const html = xml
    ? new XMLSerializer().serializeToString(doc)
    : `<!DOCTYPE html>${doc.documentElement.outerHTML}`
  return {
    html,
    contentType: xml ? "application/xhtml+xml" : "text/html",
    urls: [...context.urls],
  }
}

export function chapterFragment(
  doc: Document,
  fragment: string,
): Element | null {
  return fragmentElement(doc, fragment)
}
