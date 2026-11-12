import { describe, expect, it } from "vitest"

import {
  DEFAULT_PDF_VIEW,
  pdfLocation,
} from "../src/features/reader/pdf/model"
import {
  legacyPdfViewPatch,
  pdfDraftFields,
  pdfExplicitPatchFromRecord,
  pdfPendingPatch,
  resolveInitialPdfView,
  resolveProfilePdfView,
  resolveResetPdfView,
} from "../src/features/reader/shell/pdf-settings"
import {
  readerProfileFromViewport,
} from "../src/features/reader/settings/reader-profile"
import type { BookReaderOverrides } from "../src/features/reader/types"

function record(
  overrides: Record<string, unknown>,
  effectiveValues: Record<string, unknown>,
  fieldSources: Record<string, unknown>,
): BookReaderOverrides {
  return {
    schemaVersion: 1,
    bookId: "book",
    fileVersion: "f".repeat(64),
    profile: "web",
    revision: "1",
    updatedAt: null,
    overrides,
    effectiveValues,
    fieldSources,
    globalRevision: "0",
    builtInVersion: 2,
  }
}

describe("PDF 默认视图", () => {
  it("内置默认是手动 100%，不是自动适宽", () => {
    expect(DEFAULT_PDF_VIEW).toMatchObject({
      layoutMode: "single",
      zoomMode: "manual",
      manualScale: 1,
    })
  })

  it("视口宽度 767 为 mobile，768 为 web", () => {
    expect(readerProfileFromViewport(390)).toBe("mobile")
    expect(readerProfileFromViewport(767)).toBe("mobile")
    expect(readerProfileFromViewport(768)).toBe("web")
    expect(readerProfileFromViewport(1440)).toBe("web")
  })
})

describe("PDF 首帧视图解析优先级", () => {
  it("本书显式值覆盖旧进度 manual/fit-page", () => {
    const book = record(
      { pdf: { zoomMode: "manual", manualScale: 1.25 } },
      { pdf: { zoomMode: "manual", manualScale: 1.25 } },
      { pdf: { zoomMode: "book", manualScale: "book" } },
    )
    const view = resolveInitialPdfView({
      record: book,
      legacyView: { layoutMode: "single", zoomMode: "manual", manualScale: 1.1132 },
    })
    expect(view.zoomMode).toBe("manual")
    expect(view.manualScale).toBe(1.25)
  })

  it("全局显式值优先于旧进度", () => {
    const book = record(
      {},
      { pdf: { zoomMode: "fit-page", gap: "relaxed" } },
      { pdf: { zoomMode: "global", gap: "global" } },
    )
    const view = resolveInitialPdfView({
      record: book,
      legacyView: { layoutMode: "single", zoomMode: "manual", manualScale: 1.1132 },
    })
    expect(view.zoomMode).toBe("fit-page")
    expect(view.gap).toBe("relaxed")
  })

  it("built-in effectiveValues 不覆盖默认 100%", () => {
    const book = record(
      {},
      {
        pdf: {
          layoutMode: "single",
          zoomMode: "fit-width",
          manualScale: 1,
          gap: "standard",
          background: "inherit",
        },
      },
      {
        pdf: {
          layoutMode: "built-in",
          zoomMode: "built-in",
          manualScale: "built-in",
          gap: "built-in",
          background: "built-in",
        },
      },
    )
    const view = resolveInitialPdfView({ record: book, legacyView: null })
    expect(view.zoomMode).toBe("manual")
    expect(view.manualScale).toBe(1)
  })

  it("旧进度 manual 保留原比例；fit-page 保留模式", () => {
    expect(
      resolveInitialPdfView({
        legacyView: {
          layoutMode: "single",
          zoomMode: "manual",
          manualScale: 1.1132,
        },
      }),
    ).toMatchObject({ zoomMode: "manual", manualScale: 1.1132 })

    expect(
      resolveInitialPdfView({
        legacyView: {
          layoutMode: "continuous",
          zoomMode: "fit-page",
          manualScale: 1.2,
        },
      }),
    ).toMatchObject({
      layoutMode: "continuous",
      zoomMode: "fit-page",
      manualScale: 1,
    })
  })

  it("旧自动 fit-width 忽略，回 100%", () => {
    const view = resolveInitialPdfView({
      legacyView: {
        layoutMode: "continuous",
        zoomMode: "fit-width",
        manualScale: 3.9475,
      },
    })
    expect(view.zoomMode).toBe("manual")
    expect(view.manualScale).toBe(1)
    expect(view.layoutMode).toBe("continuous")
  })

  it("本书布局与旧进度缩放按字段合并", () => {
    const book = record(
      { pdf: { layoutMode: "horizontal" } },
      { pdf: { layoutMode: "horizontal", zoomMode: "manual", manualScale: 1 } },
      {
        pdf: {
          layoutMode: "book",
          zoomMode: "built-in",
          manualScale: "built-in",
        },
      },
    )
    const view = resolveInitialPdfView({
      record: book,
      legacyView: {
        layoutMode: "continuous",
        zoomMode: "manual",
        manualScale: 1.4,
      },
    })
    expect(view).toMatchObject({
      layoutMode: "horizontal",
      zoomMode: "manual",
      manualScale: 1.4,
    })
  })
})

describe("PDF profile 应用与写入字段", () => {
  it("profile 切换只使用该 profile 显式值和默认值", () => {
    const mobile = record(
      { pdf: { zoomMode: "manual", manualScale: 1.4, gap: "compact" } },
      { pdf: { zoomMode: "manual", manualScale: 1.4, gap: "compact" } },
      { pdf: { zoomMode: "book", manualScale: "book", gap: "book" } },
    )
    expect(resolveProfilePdfView(mobile)).toMatchObject({
      zoomMode: "manual",
      manualScale: 1.4,
      gap: "compact",
    })
    expect(resolveProfilePdfView(undefined)).toMatchObject({
      zoomMode: "manual",
      manualScale: 1,
      gap: "standard",
    })
  })

  it("恢复本书默认使用全局显式值 + 内置默认", () => {
    expect(
      resolveResetPdfView({
        pdf: { layoutMode: "continuous", zoomMode: "fit-page", gap: "relaxed" },
      }),
    ).toMatchObject({
      layoutMode: "continuous",
      zoomMode: "fit-page",
      gap: "relaxed",
    })
    expect(resolveResetPdfView(undefined).manualScale).toBe(1)
  })

  it("只把 book/global 来源当显式，未知嵌套不误读", () => {
    const book = record(
      { pdf: { gap: "compact" } },
      {
        pdf: {
          layoutMode: "horizontal",
          zoomMode: "manual",
          manualScale: 1.3,
          background: "white",
        },
      },
      {
        pdf: {
          layoutMode: "global",
          zoomMode: "built-in",
          manualScale: "built-in",
          background: "global",
        },
      },
    )
    expect(pdfExplicitPatchFromRecord(book)).toEqual({
      layoutMode: "horizontal",
      gap: "compact",
      background: "white",
    })
  })

  it("工具栏补丁转成 pdf.* 稀疏草稿字段", () => {
    expect(
      pdfDraftFields({
        zoomMode: "manual",
        manualScale: 1.25,
        layoutMode: "continuous",
      }),
    ).toEqual({
      "pdf.zoomMode": "manual",
      "pdf.manualScale": 1.25,
      "pdf.layoutMode": "continuous",
    })
    expect(pdfPendingPatch({ "pdf.gap": "relaxed" })).toEqual({
      gap: "relaxed",
    })
  })

  it("旧进度 fit-width 的 patch 不包含缩放字段", () => {
    expect(
      legacyPdfViewPatch({
        layoutMode: "single",
        zoomMode: "fit-width",
        manualScale: 3.9475,
      }),
    ).toEqual({ layoutMode: "single" })
  })
})

describe("PDF 进度 locator", () => {
  it("滚动/flip 进度只写 page/offset/relativeViewport，不再写 view", () => {
    const location = pdfLocation(
      300,
      0.25,
      857,
      { x: 0, y: 0, width: 1, height: 1 },
    )
    expect(location.locatorPayload).toMatchObject({
      page: 300,
      pageOffset: 0.25,
      view: null,
    })
  })
})
