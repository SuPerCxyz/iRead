import { describe, expect, it } from "vitest"

import {
  buildPdfDiagnosticsText,
  describePdfLoadError,
  sanitizePdfErrorDetail,
  toPdfLoadError,
} from "../src/features/reader/pdf/load-error"
import { PdfLoadError } from "../src/features/reader/pdf/range"

describe("PDF 错误分类", () => {
  it("worker 初始化失败映射为 worker_failed 并保留原始消息", () => {
    const detail =
      'Error: Setting up fake worker failed: "Failed to fetch dynamically imported module: https://read.example/assets/pdf.worker.min-abc.mjs?token=secret".'
    const descriptor = describePdfLoadError(new Error(detail))

    expect(descriptor.code).toBe("worker_failed")
    expect(descriptor.title).toBe("PDF 解析组件加载失败")
    expect(descriptor.message).toContain("Web Worker")
    expect(descriptor.message).toContain(".mjs")
    expect(descriptor.detail).toContain("Setting up fake worker failed")
    expect(descriptor.detail).not.toContain("secret")
  })

  it("WebAssembly 被策略禁用映射为 browser_unsupported", () => {
    const error = new Error("WebAssembly compile is blocked by policy")
    error.name = "UnknownErrorException"
    const descriptor = describePdfLoadError(error)

    expect(descriptor.code).toBe("browser_unsupported")
    expect(descriptor.message).toContain("WebAssembly")
    expect(descriptor.detail).toContain("WebAssembly")
  })

  it("缺失 Promise.withResolvers 映射为 browser_unsupported", () => {
    const descriptor = describePdfLoadError(
      new TypeError("Promise.withResolvers is not a function"),
    )

    expect(descriptor.code).toBe("browser_unsupported")
    expect(descriptor.detail).toContain("Promise.withResolvers")
  })

  it("密码/损坏/网络状态错误保持原有专门分类", () => {
    const password = new Error("Password required")
    password.name = "PasswordException"
    expect(describePdfLoadError(password).code).toBe("password_required")

    const invalid = new Error("Invalid PDF")
    invalid.name = "InvalidPDFException"
    expect(describePdfLoadError(invalid).code).toBe("invalid_pdf")

    const response = new Error("HTTP 416")
    response.name = "UnexpectedResponseException"
    Object.assign(response, { status: 416 })
    expect(describePdfLoadError(response).code).toBe("range_not_satisfiable")
  })

  it("未知异常保持 pdf_load_failed，但带可复制 detail", () => {
    const descriptor = describePdfLoadError(new Error("unexpected parser state"))

    expect(descriptor.code).toBe("pdf_load_failed")
    expect(descriptor.title).toBe("无法打开 PDF")
    expect(descriptor.detail).toBe("Error: unexpected parser state")
    expect(descriptor.message).toContain("复制下方诊断信息")
  })

  it("toPdfLoadError 保留 detail 与 cause", () => {
    const cause = new Error("Setting up fake worker failed: boom")
    const error = toPdfLoadError(cause)

    expect(error).toBeInstanceOf(PdfLoadError)
    expect(error.code).toBe("worker_failed")
    expect(error.detail).toContain("Setting up fake worker failed")
    expect(error.cause).toBe(cause)
  })
})

describe("PDF 诊断详情脱敏", () => {
  it("去掉 URL 查询串和片段，并截断到 200 字符", () => {
    const detail = sanitizePdfErrorDetail(
      new Error(
        `failed https://read.example/books/1/content?X-Amz-Signature=secret#frag ${"x".repeat(400)}`,
      ),
    )

    expect(detail).toContain("https://read.example/books/1/content")
    expect(detail).not.toContain("X-Amz-Signature")
    expect(detail).not.toContain("secret")
    expect(detail).not.toContain("#frag")
    expect(detail.length).toBeLessThanOrEqual(200)
  })

  it("控制字符与换行不会进入 DOM", () => {
    const detail = sanitizePdfErrorDetail(new Error("line1\nline2\u0000line3"))
    expect(detail).toBe("Error: line1 line2 line3")
  })

  it("复制文本包含错误码、详情、书 ID、页数与 UA", () => {
    const text = buildPdfDiagnosticsText({
      code: "worker_failed",
      detail: "Error: worker failed",
      pageCount: 857,
      bookId: "book-1",
      pdfjsVersion: "6.5.438",
      mode: "legacy",
    })

    expect(text).toContain("错误码: worker_failed")
    expect(text).toContain("错误详情: Error: worker failed")
    expect(text).toContain("页数: 857")
    expect(text).toContain("书籍 ID: book-1")
    expect(text).toContain("pdfjs-dist 6.5.438 (legacy)")
    expect(text).toContain("UA:")
  })
})
