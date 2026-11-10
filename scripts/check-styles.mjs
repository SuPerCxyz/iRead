#!/usr/bin/env node

import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const COMMIT = "8ab27715521cbd4f87ae6886cd989cbb678f6de7"
const REGISTRY = "new-york-v4"
const APP_CSS = "web/src/styles/iread.css"
const APPLY_MODULE = "web/src/features/appearance/apply.ts"
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url))

const BOOT_CSS_KEYS = new Set([
  "--primary",
  "--primary-foreground",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
  "--iread-content-width",
])
const BOOT_COLOR_PATTERN = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/
const BOOT_WIDTH_PATTERN = /^(?:[5-9][0-9]|100)%$/

const KNOWN_BLOBS = {
  "blocks/sidebar-07/page.tsx":
    "c388c63ee469b4259f97bbd3f9324e63004f7b14",
  "blocks/sidebar-07/components/app-sidebar.tsx":
    "165e79eb23450f8b00f5fbbdec04f31ade3d0fe2",
  "registry-README.md": "962b2582bb502171c9a8c83bb9ab59473cb22c26",
}

const OFFICIAL_VERBATIM_FILES = [
  "web/src/hooks/use-mobile.ts",
  "web/src/lib/utils.ts",
]

function parseArgs(argv) {
  const result = { root: DEFAULT_ROOT, selfTest: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--root 需要目录参数")
      }
      result.root = path.resolve(value)
      index += 1
      continue
    }
    if (argv[index] === "--self-test") {
      result.selfTest = true
      continue
    }
    throw new Error(`未知参数：${argv[index]}`)
  }
  return result
}

function walk(directory) {
  if (!existsSync(directory)) {
    return []
  }
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(absolute))
    } else if (entry.isFile()) {
      files.push(absolute)
    }
  }
  return files
}

function relative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/")
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length
}

function addMatch(violations, root, absolute, content, index, message) {
  violations.push({
    file: relative(root, absolute),
    line: lineOf(content, index),
    message,
  })
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function gitBlobHash(buffer) {
  return createHash("sha1")
    .update(`blob ${buffer.byteLength}\0`)
    .update(buffer)
    .digest("hex")
}

function loadManifest(root) {
  const manifestPath = path.join(root, "scripts/template/official-files.json")
  if (!existsSync(manifestPath)) {
    return { manifest: null, error: "缺少 scripts/template/official-files.json" }
  }
  try {
    return {
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
      error: null,
    }
  } catch (error) {
    return {
      manifest: null,
      error: `无法解析 official-files.json：${error.message}`,
    }
  }
}

function checkManifest(root, violations) {
  const { manifest, error } = loadManifest(root)
  if (error !== null) {
    violations.push({ file: "scripts/template/official-files.json", line: 1, message: error })
    return new Set()
  }

  if (manifest.commit !== COMMIT) {
    violations.push({
      file: "scripts/template/official-files.json",
      line: 1,
      message: `commit 必须是 ${COMMIT}`,
    })
  }

  if (manifest.registry !== REGISTRY) {
    violations.push({
      file: "scripts/template/official-files.json",
      line: 1,
      message: `registry 必须是 ${REGISTRY}`,
    })
  }

  const files = Array.isArray(manifest.files) ? manifest.files : []
  if (files.length === 0) {
    violations.push({
      file: "scripts/template/official-files.json",
      line: 1,
      message: "files 不能为空",
    })
  }

  const verbatimLocalPaths = new Set()

  for (const entry of files) {
    const label = entry.localPath ?? "scripts/template/official-files.json"
    if (
      typeof entry.sourcePath !== "string" ||
      typeof entry.upstreamPath !== "string" ||
      typeof entry.localPath !== "string" ||
      typeof entry.sha256 !== "string" ||
      typeof entry.blob !== "string" ||
      (entry.mode !== "verbatim" && entry.mode !== "adapted")
    ) {
      violations.push({
        file: "scripts/template/official-files.json",
        line: 1,
        message: "文件条目字段不完整",
      })
      continue
    }

    const upstreamAbsolute = path.join(
      root,
      "scripts/template/upstream",
      entry.upstreamPath,
    )
    const localAbsolute = path.join(root, entry.localPath)

    if (!existsSync(upstreamAbsolute)) {
      violations.push({
        file: label,
        line: 1,
        message: `缺少上游原件 ${entry.upstreamPath}`,
      })
      continue
    }

    if (!existsSync(localAbsolute)) {
      violations.push({
        file: entry.localPath,
        line: 1,
        message: "缺少官方/改编文件",
      })
      continue
    }

    const upstreamBuffer = readFileSync(upstreamAbsolute)
    const localBuffer = readFileSync(localAbsolute)
    const upstreamBlob = gitBlobHash(upstreamBuffer)
    const upstreamHash = sha256(upstreamBuffer)
    const localHash = sha256(localBuffer)

    if (upstreamBlob !== entry.blob) {
      violations.push({
        file: entry.upstreamPath,
        line: 1,
        message: `上游 blob 不匹配（实际 ${upstreamBlob}）`,
      })
    }

    if (entry.mode === "verbatim") {
      verbatimLocalPaths.add(entry.localPath)
      if (localHash !== upstreamHash) {
        violations.push({
          file: entry.localPath,
          line: 1,
          message: "verbatim 官方组件被修改",
        })
      }
      if (entry.sha256 !== upstreamHash) {
        violations.push({
          file: "scripts/template/official-files.json",
          line: 1,
          message: `${entry.localPath} 的 sha256 清单值与上游不一致`,
        })
      }
    } else {
      if (localHash !== entry.sha256) {
        violations.push({
          file: entry.localPath,
          line: 1,
          message: "adapted 文件哈希未被批准（改动后需显式更新清单）",
        })
      }
      if (
        typeof entry.upstreamSha256 === "string" &&
        entry.upstreamSha256 !== upstreamHash
      ) {
        violations.push({
          file: entry.upstreamPath,
          line: 1,
          message: "上游原件 sha256 与清单不一致",
        })
      }
    }
  }

  for (const [upstreamPath, expectedBlob] of Object.entries(KNOWN_BLOBS)) {
    const absolute = path.join(root, "scripts/template/upstream", upstreamPath)
    if (!existsSync(absolute)) {
      violations.push({
        file: upstreamPath,
        line: 1,
        message: "缺少已知 blob 核验文件",
      })
      continue
    }
    const actualBlob = gitBlobHash(readFileSync(absolute))
    if (actualBlob !== expectedBlob) {
      violations.push({
        file: upstreamPath,
        line: 1,
        message: `已知 blob 不匹配（实际 ${actualBlob}）`,
      })
    }
  }

  const uiDirectory = path.join(root, "web/src/components/ui")
  const manifestVerboseLocals = new Set(
    files
      .filter((entry) => entry.mode === "verbatim")
      .map((entry) => entry.localPath),
  )

  for (const absolute of walk(uiDirectory)) {
    const localPath = relative(root, absolute)
    if (localPath.endsWith(".tsx") && !manifestVerboseLocals.has(localPath)) {
      violations.push({
        file: localPath,
        line: 1,
        message: "未在 official-files.json 登记的官方组件",
      })
    }
  }

  for (const localPath of OFFICIAL_VERBATIM_FILES) {
    if (!manifestVerboseLocals.has(localPath)) {
      violations.push({
        file: "scripts/template/official-files.json",
        line: 1,
        message: `缺少官方文件登记：${localPath}`,
      })
    }
  }

  return verbatimLocalPaths
}

function checkCssFiles(root, violations) {
  const sourceDirectory = path.join(root, "web/src")
  const cssFiles = walk(sourceDirectory)
    .filter((absolute) => absolute.endsWith(".css"))
    .map((absolute) => relative(root, absolute))

  if (!cssFiles.includes(APP_CSS)) {
    violations.push({
      file: APP_CSS,
      line: 1,
      message: "缺少唯一应用 CSS",
    })
  }

  for (const cssFile of cssFiles) {
    if (cssFile !== APP_CSS) {
      violations.push({
        file: cssFile,
        line: 1,
        message: "禁止第二个 CSS 文件",
      })
    }
  }

  for (const absolute of walk(sourceDirectory)) {
    if (!/\.(ts|tsx|mjs|js)$/.test(absolute)) {
      continue
    }
    const content = readFileSync(absolute, "utf8")
    const importRegex = /(?:from\s*|import\s*)["']([^"']+\.css)["']/g
    for (const match of content.matchAll(importRegex)) {
      const specifier = match[1]
      if (specifier !== "@/styles/iread.css") {
        addMatch(
          violations,
          root,
          absolute,
          content,
          match.index ?? 0,
          "禁止导入非唯一 CSS",
        )
      }
      if (specifier.startsWith(".")) {
        addMatch(
          violations,
          root,
          absolute,
          content,
          match.index ?? 0,
          "禁止相对 CSS 导入",
        )
      }
    }
  }

  if (existsSync(path.join(root, APP_CSS))) {
    const content = readFileSync(path.join(root, APP_CSS), "utf8")
    const regex = /@import\s+(?:url\()?["']([^"']+)["']/g
    for (const match of content.matchAll(regex)) {
      const specifier = match[1]
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        violations.push({
          file: APP_CSS,
          line: lineOf(content, match.index ?? 0),
          message: "CSS @import 只允许包或自身",
        })
      }
    }
  }
}

function isOfficialVerbatim(localPath, verbatimLocalPaths) {
  return (
    localPath.startsWith("web/src/components/ui/") ||
    verbatimLocalPaths.has(localPath)
  )
}

// 将注释替换为空格但保留换行，避免注释中的示例误触发规则。
function maskComments(content) {
  const chars = [...content]
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]

    if (lineComment) {
      if (char === "\n") {
        lineComment = false
      } else {
        chars[index] = " "
      }
      continue
    }

    if (blockComment) {
      chars[index] = " "
      if (char === "*" && next === "/") {
        chars[index + 1] = " "
        index += 1
        blockComment = false
      }
      continue
    }

    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }

    if (char === "/" && next === "/") {
      chars[index] = " "
      chars[index + 1] = " "
      index += 1
      lineComment = true
      continue
    }

    if (char === "/" && next === "*") {
      chars[index] = " "
      chars[index + 1] = " "
      index += 1
      blockComment = true
    }
  }

  return chars.join("")
}

// 将字符串和注释内容替换为空格，只留下可安全匹配语法的代码骨架。
function maskNonCode(content) {
  const chars = [...content]
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]

    if (lineComment) {
      if (char === "\n") {
        lineComment = false
      } else {
        chars[index] = " "
      }
      continue
    }

    if (blockComment) {
      chars[index] = " "
      if (char === "*" && next === "/") {
        chars[index + 1] = " "
        index += 1
        blockComment = false
      }
      continue
    }

    if (quote !== null) {
      chars[index] = " "
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char
      chars[index] = " "
      continue
    }

    if (char === "/" && next === "/") {
      chars[index] = " "
      chars[index + 1] = " "
      index += 1
      lineComment = true
      continue
    }

    if (char === "/" && next === "*") {
      chars[index] = " "
      chars[index + 1] = " "
      index += 1
      blockComment = true
    }
  }

  return chars.join("")
}

function findClosing(content, startIndex, openChar, closeChar) {
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]

    if (lineComment) {
      if (char === "\n") {
        lineComment = false
      }
      continue
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }

    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }

    if (char === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }

    if (char === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }

    if (char === openChar) {
      depth += 1
      continue
    }

    if (char === closeChar) {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

function findQuoteEnd(content, startIndex) {
  const quote = content[startIndex]
  let escaped = false
  for (let index = startIndex + 1; index < content.length; index += 1) {
    const char = content[index]
    if (escaped) {
      escaped = false
    } else if (char === "\\") {
      escaped = true
    } else if (char === quote) {
      return index
    }
  }
  return -1
}

function collectClassExpressionRanges(content) {
  const code = maskNonCode(content)
  const ranges = []

  for (const match of code.matchAll(/\bclassName\s*=/g)) {
    let index = (match.index ?? 0) + match[0].length
    while (/\s/.test(content[index] ?? "")) {
      index += 1
    }
    const first = content[index]
    if (first === '"' || first === "'" || first === "`") {
      const end = findQuoteEnd(content, index)
      if (end >= 0) {
        ranges.push([index, end + 1])
      }
      continue
    }
    if (first === "{") {
      const end = findClosing(content, index, "{", "}")
      if (end >= 0) {
        ranges.push([index, end + 1])
      }
    }
  }

  for (const match of code.matchAll(/\b(?:cn|clsx|cva|tv)\s*\(/g)) {
    const openIndex = code.indexOf("(", match.index ?? 0)
    if (openIndex < 0) {
      continue
    }
    const end = findClosing(content, openIndex, "(", ")")
    if (end >= 0) {
      ranges.push([openIndex, end + 1])
    }
  }

  return ranges
}

function checkClassExpressions(root, absolute, localPath, content, violations) {
  const lineMessages = new Set()
  for (const [start, end] of collectClassExpressionRanges(content)) {
    const expression = content.slice(start, end)
    for (const match of expression.matchAll(
      /(["'`])((?:\\.|[^\\])*?)\1/gs,
    )) {
      const value = match[2]
      if (!/\[[^\]\n]+\]/.test(value)) {
        continue
      }
      const line = lineOf(content, start + (match.index ?? 0))
      const key = `${line}:业务代码禁止 Tailwind 任意值`
      if (lineMessages.has(key)) {
        continue
      }
      lineMessages.add(key)
      violations.push({
        file: localPath,
        line,
        message: "业务代码禁止 Tailwind 任意值",
      })
    }
  }
}

function findTopLevelComma(text) {
  let quote = null
  let escaped = false
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1
      continue
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1
      continue
    }
    if (char === "," && depth === 0) {
      return index
    }
  }
  return -1
}

function readSetPropertyCalls(content) {
  const calls = []
  for (const match of content.matchAll(
    /\.style\s*\.\s*setProperty\s*\(/g,
  )) {
    const openIndex = content.indexOf("(", match.index ?? 0)
    if (openIndex < 0) {
      continue
    }
    const endIndex = findClosing(content, openIndex, "(", ")")
    if (endIndex < 0) {
      continue
    }
    const args = content.slice(openIndex + 1, endIndex)
    const commaIndex = findTopLevelComma(args)
    if (commaIndex < 0) {
      continue
    }
    calls.push({
      index: match.index ?? 0,
      key: args.slice(0, commaIndex).trim(),
      value: args
        .slice(commaIndex + 1)
        .trim()
        .replace(/,\s*$/, ""),
    })
  }
  return calls
}

function quotedLiteral(raw) {
  const quote = raw[0]
  if (quote !== '"' && quote !== "'") {
    return null
  }
  if (raw.length < 2 || raw[raw.length - 1] !== quote) {
    return null
  }
  return raw.slice(1, -1)
}

function isBootCssValue(key, value) {
  if (key === "--iread-content-width") {
    return BOOT_WIDTH_PATTERN.test(value)
  }
  return BOOT_COLOR_PATTERN.test(value)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function checkBootSetPropertyCalls(
  root,
  absolute,
  localPath,
  content,
  violations,
) {
  for (const call of readSetPropertyCalls(content)) {
    const key = quotedLiteral(call.key)
    if (key === null || !BOOT_CSS_KEYS.has(key)) {
      addMatch(
        violations,
        root,
        absolute,
        content,
        call.index,
        "首屏引导脚本只允许写白名单 CSS 变量字面量",
      )
      continue
    }
    const literalValue = quotedLiteral(call.value)
    if (literalValue !== null) {
      if (!isBootCssValue(key, literalValue)) {
        addMatch(
          violations,
          root,
          absolute,
          content,
          call.index,
          "首屏引导脚本字面量 CSS 值不合法",
        )
      }
      continue
    }
    const controlled = new RegExp(
      `^appliedCss\\s*\\[\\s*["']${escapeRegExp(key)}["']\\s*\\]$`,
    )
    if (!controlled.test(call.value)) {
      addMatch(
        violations,
        root,
        absolute,
        content,
        call.index,
        "首屏引导脚本非字面量 CSS 值不受控",
      )
    }
  }
}

function checkBusinessSetPropertyCalls(
  root,
  absolute,
  localPath,
  content,
  violations,
) {
  const calls = readSetPropertyCalls(content)
  if (calls.length === 0) {
    return
  }
  if (localPath !== APPLY_MODULE) {
    for (const call of calls) {
      addMatch(
        violations,
        root,
        absolute,
        content,
        call.index,
        "业务代码只允许外观模块受控写入 CSS 变量",
      )
    }
    return
  }
  for (const call of calls) {
    const key = quotedLiteral(call.key)
    if (key !== null && !BOOT_CSS_KEYS.has(key)) {
      addMatch(
        violations,
        root,
        absolute,
        content,
        call.index,
        "外观模块 setProperty 只允许白名单 CSS 变量",
      )
    }
  }
}

function checkBusinessCode(root, violations, verbatimLocalPaths) {
  const sourceDirectory = path.join(root, "web/src")
  const colorWhitelist = "web/src/features/appearance/color.ts"

  for (const absolute of walk(sourceDirectory)) {
    if (!/\.(ts|tsx)$/.test(absolute)) {
      continue
    }
    const localPath = relative(root, absolute)
    if (isOfficialVerbatim(localPath, verbatimLocalPaths)) {
      continue
    }

    const content = readFileSync(absolute, "utf8")
    checkBusinessSetPropertyCalls(
      root,
      absolute,
      localPath,
      content,
      violations,
    )
    const commentMasked = maskComments(content)
    const lines = commentMasked.split("\n")

    lines.forEach((line, index) => {
      const lineNumber = index + 1
      const add = (message) => {
        violations.push({ file: localPath, line: lineNumber, message })
      }

      if (localPath !== colorWhitelist) {
        if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
          add("业务代码禁止颜色字面量")
        }
        if (/\b(?:rgba?|hsla?|oklch|color-mix)\s*\(/.test(line)) {
          add("业务代码禁止颜色字面量")
        }
      }

      if (/style\s*=\s*\{\{/.test(line) || /style\s*=\s*["']/.test(line)) {
        add("业务代码禁止内联样式")
      }

      if (/<style\b/.test(line)) {
        add("业务代码禁止 <style> 标签")
      }

      if (/\b(?:768|1024)\b/.test(line)) {
        add("业务代码禁止复制断点数字")
      }
    })

    checkClassExpressions(root, absolute, localPath, content, violations)
  }
}

function checkIndexHtml(root, violations) {
  const absolute = path.join(root, "web/index.html")
  if (!existsSync(absolute)) {
    return
  }
  const content = readFileSync(absolute, "utf8")
  const localPath = relative(root, absolute)

  for (const match of content.matchAll(/<style\b/g)) {
    addMatch(
      violations,
      root,
      absolute,
      content,
      match.index ?? 0,
      "业务代码禁止 <style> 标签",
    )
  }

  for (const match of content.matchAll(/\bstyle\s*=\s*["'][^"']*["']/g)) {
    addMatch(
      violations,
      root,
      absolute,
      content,
      match.index ?? 0,
      "业务代码禁止内联样式",
    )
  }

  for (const match of content.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gs)) {
    if (!/\[[^\]\n]+\]/.test(match[2])) {
      continue
    }
    addMatch(
      violations,
      root,
      absolute,
      content,
      match.index ?? 0,
      "业务代码禁止 Tailwind 任意值",
    )
  }

  checkBootSetPropertyCalls(
    root,
    absolute,
    localPath,
    content,
    violations,
  )
}

function checkUpstreamChecksums(root, violations) {
  const checksumPath = path.join(
    root,
    "scripts/template/upstream-sha256.txt",
  )
  if (!existsSync(checksumPath)) {
    violations.push({
      file: "scripts/template/upstream-sha256.txt",
      line: 1,
      message: "缺少上游原件 sha256 清单",
    })
    return
  }

  const lines = readFileSync(checksumPath, "utf8").split("\n")
  const listed = new Set()
  for (const line of lines) {
    if (line.trim() === "") {
      continue
    }
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (!match) {
      violations.push({
        file: "scripts/template/upstream-sha256.txt",
        line: 1,
        message: "sha256 行格式无效",
      })
      continue
    }
    const [, expected, upstreamPath] = match
    listed.add(upstreamPath)
    const absolute = path.join(
      root,
      "scripts/template/upstream",
      upstreamPath,
    )
    if (!existsSync(absolute)) {
      violations.push({
        file: upstreamPath,
        line: 1,
        message: "上游 sha256 清单中的文件不存在",
      })
      continue
    }
    const actual = sha256(readFileSync(absolute))
    if (actual !== expected) {
      violations.push({
        file: upstreamPath,
        line: 1,
        message: "上游原件 sha256 与清单不一致",
      })
    }
  }

  const upstreamDirectory = path.join(root, "scripts/template/upstream")
  for (const absolute of walk(upstreamDirectory)) {
    const upstreamPath = relative(upstreamDirectory, absolute)
    if (!listed.has(upstreamPath)) {
      violations.push({
        file: upstreamPath,
        line: 1,
        message: "上游原件未在 sha256 清单登记",
      })
    }
  }
}

function runChecks(root) {
  const violations = []
  const verbatimLocalPaths = checkManifest(root, violations)
  checkUpstreamChecksums(root, violations)
  checkCssFiles(root, violations)
  checkBusinessCode(root, violations, verbatimLocalPaths)
  checkIndexHtml(root, violations)
  return violations
}

function writeFileWithParents(absolute, content) {
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function withScenario(setup) {
  const root = mkdtempSync(path.join(tmpdir(), "iread-styles-"))
  try {
    setup(root)
    return runChecks(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function missingMessages(violations, expected) {
  const messages = violations.map((item) => item.message)
  return expected.filter((message) => !messages.includes(message))
}

function writeHashFixture(root, mode, tampered) {
  const upstream = "export const hashFixture = 1\n"
  const original =
    mode === "verbatim"
      ? upstream
      : "export const hashFixture = 2\n"
  const changed = "export const hashFixture = 3\n"
  const localPath =
    mode === "verbatim"
      ? "web/src/components/ui/hash-fixture.tsx"
      : "web/src/app/hash-fixture.tsx"
  const upstreamBuffer = Buffer.from(upstream)
  const upstreamHash = sha256(upstreamBuffer)
  const localHash = sha256(
    Buffer.from(tampered ? changed : original),
  )

  writeFileWithParents(
    path.join(root, "scripts/template/official-files.json"),
    JSON.stringify({
      commit: COMMIT,
      registry: REGISTRY,
      files: [
        {
          sourcePath: "ui/hash-fixture.tsx",
          upstreamPath: "ui/hash-fixture.tsx",
          commit: COMMIT,
          blob: gitBlobHash(upstreamBuffer),
          localPath,
          mode,
          sha256: mode === "verbatim" ? upstreamHash : sha256(Buffer.from(original)),
          upstreamSha256: upstreamHash,
        },
      ],
    }),
  )
  writeFileWithParents(
    path.join(root, "scripts/template/upstream/ui/hash-fixture.tsx"),
    upstream,
  )
  writeFileWithParents(
    path.join(root, "scripts/template/upstream-sha256.txt"),
    `${upstreamHash}  ui/hash-fixture.tsx\n`,
  )
  writeFileWithParents(path.join(root, localPath), tampered ? changed : original)
  writeFileWithParents(
    path.join(root, "web/src/styles/iread.css"),
    '@import "tailwindcss";\n',
  )
}

function runSelfTest() {
  const failures = []

  const baseRoot = mkdtempSync(path.join(tmpdir(), "iread-styles-"))
  try {
    writeFileWithParents(
      path.join(baseRoot, "scripts/template/official-files.json"),
      JSON.stringify({ commit: COMMIT, registry: REGISTRY, files: [] }),
    )
    writeFileWithParents(
      path.join(baseRoot, "web/src/styles/iread.css"),
      '@import "tailwindcss";\n@import "./other.css";\n',
    )
    writeFileWithParents(
      path.join(baseRoot, "web/src/styles/other.css"),
      "body { color: #fff; }\n",
    )
    writeFileWithParents(
      path.join(baseRoot, "web/src/pages/bad.tsx"),
      [
        'import "./bad.css"',
        "export function Bad() {",
        '  return <div className="p-[3px]" style={{ color: "#fff" }}>x</div>',
        "}",
        "",
        "const width = 768",
        "",
      ].join("\n"),
    )
    writeFileWithParents(
      path.join(baseRoot, "web/src/pages/bad.css"),
      "x{}\n",
    )

    const violations = runChecks(baseRoot)
    const expected = [
      "禁止第二个 CSS 文件",
      "禁止相对 CSS 导入",
      "CSS @import 只允许包或自身",
      "业务代码禁止 Tailwind 任意值",
      "业务代码禁止内联样式",
      "业务代码禁止颜色字面量",
      "业务代码禁止复制断点数字",
    ]
    const missing = missingMessages(violations, expected)
    if (missing.length > 0) {
      failures.push(`基础样本未命中：${missing.join("、")}`)
    }
    if (violations.length !== 16) {
      failures.push(
        `基础样本违规数应为 16，实际 ${violations.length}`,
      )
    }
  } finally {
    rmSync(baseRoot, { recursive: true, force: true })
  }

  const classViolations = withScenario((root) => {
    writeFileWithParents(
      path.join(root, "scripts/template/official-files.json"),
      JSON.stringify({ commit: COMMIT, registry: REGISTRY, files: [] }),
    )
    writeFileWithParents(
      path.join(root, "web/src/styles/iread.css"),
      '@import "tailwindcss";\n',
    )
    writeFileWithParents(
      path.join(root, "web/src/pages/class-samples.tsx"),
      [
        "const classNameValue = cn(",
        '  "flex",',
        '  "p-[3px]",',
        ")",
        'const direct = <div className="m-[2px]" />',
        'const clsxValue = clsx({ "gap-[4px]": true })',
        'const cvaValue = cva("base", { variants: { size: { sm: "text-[12px]" } } })',
        'const tvValue = tv({ base: "leading-[1.2]" })',
        '// const ignored = cn("p-[9px]")',
        "",
      ].join("\n"),
    )
    writeFileWithParents(
      path.join(root, "web/src/pages/bad-set-property.tsx"),
      [
        "export function BadSetProperty() {",
        '  document.documentElement.style.setProperty("--primary", "red")',
        "  return null",
        "}",
        "",
      ].join("\n"),
    )
    writeFileWithParents(
      path.join(root, "web/index.html"),
      [
        "<html>",
        "  <head><style>body { color: red; }</style></head>",
        '  <body><div style="color: red" class="p-[5px]">x</div></body>',
        "</html>",
        "",
      ].join("\n"),
    )
  })
  const classMissing = missingMessages(classViolations, [
    "业务代码禁止 Tailwind 任意值",
    "业务代码禁止内联样式",
    "业务代码禁止 <style> 标签",
    "业务代码只允许外观模块受控写入 CSS 变量",
  ])
  if (classMissing.length > 0) {
    failures.push(`class/HTML 样本未命中：${classMissing.join("、")}`)
  }
  const htmlMissing = missingMessages(
    classViolations.filter((item) => item.file === "web/index.html"),
    [
      "业务代码禁止 Tailwind 任意值",
      "业务代码禁止内联样式",
      "业务代码禁止 <style> 标签",
    ],
  )
  if (htmlMissing.length > 0) {
    failures.push(`index.html 样本未命中：${htmlMissing.join("、")}`)
  }

  const bootValidViolations = withScenario((root) => {
    writeFileWithParents(
      path.join(root, "scripts/template/official-files.json"),
      JSON.stringify({ commit: COMMIT, registry: REGISTRY, files: [] }),
    )
    writeFileWithParents(
      path.join(root, "web/src/styles/iread.css"),
      '@import "tailwindcss";\n',
    )
    writeFileWithParents(
      path.join(root, "web/index.html"),
      [
        "<html><head><script>",
        'root.style.setProperty("--primary", "#2563eb")',
        'root.style.setProperty("--iread-content-width", "60%")',
        'root.style.setProperty("--ring", appliedCss["--ring"])',
        "</script></head><body></body></html>",
        "",
      ].join("\n"),
    )
  })
  const bootValidMissing = missingMessages(bootValidViolations, [
    "首屏引导脚本只允许写白名单 CSS 变量字面量",
  ])
  if (bootValidMissing.length === 0) {
    failures.push("合法引导脚本白名单变量被误拦截")
  }

  const bootInvalidViolations = withScenario((root) => {
    writeFileWithParents(
      path.join(root, "scripts/template/official-files.json"),
      JSON.stringify({ commit: COMMIT, registry: REGISTRY, files: [] }),
    )
    writeFileWithParents(
      path.join(root, "web/src/styles/iread.css"),
      '@import "tailwindcss";\n',
    )
    writeFileWithParents(
      path.join(root, "web/index.html"),
      [
        "<html><head><script>",
        'root.style.setProperty("--evil", "#ffffff")',
        "</script></head><body></body></html>",
        "",
      ].join("\n"),
    )
  })
  if (
    missingMessages(bootInvalidViolations, [
      "首屏引导脚本只允许写白名单 CSS 变量字面量",
    ]).length > 0
  ) {
    failures.push("非白名单引导脚本变量未被拦截")
  }

  const bootInvalidValueViolations = withScenario((root) => {
    writeFileWithParents(
      path.join(root, "scripts/template/official-files.json"),
      JSON.stringify({ commit: COMMIT, registry: REGISTRY, files: [] }),
    )
    writeFileWithParents(
      path.join(root, "web/src/styles/iread.css"),
      '@import "tailwindcss";\n',
    )
    writeFileWithParents(
      path.join(root, "web/index.html"),
      [
        "<html><head><script>",
        'root.style.setProperty("--primary", "red")',
        "</script></head><body></body></html>",
        "",
      ].join("\n"),
    )
  })
  if (
    missingMessages(bootInvalidValueViolations, [
      "首屏引导脚本字面量 CSS 值不合法",
    ]).length > 0
  ) {
    failures.push("非法引导脚本字面量值未被拦截")
  }

  const verbatimViolations = withScenario((root) => {
    writeHashFixture(root, "verbatim", true)
  })
  if (
    missingMessages(verbatimViolations, ["verbatim 官方组件被修改"])
      .length > 0
  ) {
    failures.push("篡改 verbatim 文件未被拦截")
  }

  const adaptedViolations = withScenario((root) => {
    writeHashFixture(root, "adapted", true)
  })
  if (
    missingMessages(adaptedViolations, [
      "adapted 文件哈希未被批准（改动后需显式更新清单）",
    ]).length > 0
  ) {
    failures.push("篡改 adapted 文件未被拦截")
  }

  const unregisteredViolations = withScenario((root) => {
    writeFileWithParents(
      path.join(root, "scripts/template/official-files.json"),
      JSON.stringify({ commit: COMMIT, registry: REGISTRY, files: [] }),
    )
    writeFileWithParents(
      path.join(root, "web/src/styles/iread.css"),
      '@import "tailwindcss";\n',
    )
    writeFileWithParents(
      path.join(root, "web/src/components/ui/unregistered.tsx"),
      "export const value = 1\n",
    )
  })
  if (
    missingMessages(unregisteredViolations, [
      "未在 official-files.json 登记的官方组件",
    ]).length > 0
  ) {
    failures.push("未登记官方组件未被拦截")
  }

  if (failures.length > 0) {
    console.error("check:styles --self-test 失败：")
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  console.log(
    "check:styles --self-test 通过：基础 16 项、class/HTML、引导脚本白名单、verbatim、adapted 与未登记组件样本均命中。",
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfTest) {
    runSelfTest()
    return
  }

  if (!statSync(args.root).isDirectory()) {
    console.error(`根目录不存在：${args.root}`)
    process.exitCode = 1
    return
  }

  const violations = runChecks(args.root)
  if (violations.length === 0) {
    console.log("check:styles 通过：唯一 CSS、业务样式约束与模板哈希均有效。")
    return
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.message}`)
  }
  console.error(`check:styles 失败：${violations.length} 项问题。`)
  process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(`check:styles 内部错误：${error.message}`)
  process.exitCode = 1
}
