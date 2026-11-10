import { describe, expect, it } from "vitest"

import { ApiError } from "../src/lib/api"
import {
  GLOBAL_READER_FORMATS,
  formatUpdatedAt,
  globalDraftIsDirty,
  globalFieldIsDirty,
  globalReaderGroupForFormat,
  globalSettingSource,
  globalValuesEqual,
  readerSettingsConflict,
  readerSettingsFieldError,
  recordFieldEntries,
  settingRangeDescription,
  validateGlobalDraft,
  withGlobalSettingValue,
} from "../src/features/reader/settings/global-settings-model"
import {
  formatSettingValue,
  settingDisplayValue,
  settingStorageValue,
} from "../src/features/reader/shell/settings-model"

const EXPECTED_FIELDS = {
  reflow: [
    "theme",
    "publisherFont",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "paragraphSpacing",
    "textIndent",
    "align",
    "horizontalMargin",
    "verticalMargin",
    "maxWidth",
    "pagination",
    "columns",
    "animation",
    "background",
    "text",
    "link",
    "selection",
    "publisherCSSMode",
  ],
  pdf: [
    "layoutMode",
    "zoomMode",
    "manualScale",
    "gap",
    "background",
    "toolbarVisible",
  ],
  comic: ["direction", "mode", "fit", "gap", "background"],
} as const

describe("全局阅读默认字段矩阵", () => {
  it("EPUB/PDF/漫画只暴露各自格式字段，且不给 PDF/漫画混入文字字段", () => {
    expect(GLOBAL_READER_FORMATS.map((item) => item.id)).toEqual([
      "epub",
      "pdf",
      "comic",
    ])
    for (const option of GLOBAL_READER_FORMATS) {
      const group = globalReaderGroupForFormat(option.id)
      expect(group.id).toBe(option.groupId)
      expect([...group.fields.map((field) => field.key)].sort()).toEqual(
        [...EXPECTED_FIELDS[option.groupId]].sort(),
      )
    }
    const textOnlyFields = [
      "theme",
      "fontFamily",
      "publisherFont",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "paragraphSpacing",
      "textIndent",
      "align",
      "horizontalMargin",
      "verticalMargin",
      "maxWidth",
      "pagination",
      "columns",
      "animation",
      "text",
      "link",
      "selection",
      "publisherCSSMode",
    ]
    for (const option of GLOBAL_READER_FORMATS.slice(1)) {
      const keys = new Set(
        globalReaderGroupForFormat(option.id).fields.map(
          (field) => field.key,
        ),
      )
      for (const key of textOnlyFields) {
        expect(keys.has(key)).toBe(false)
      }
    }
  })

  it("显示范围使用界面单位，manualScale 按百分比提示", () => {
    const group = globalReaderGroupForFormat("pdf")
    const manualScale = group.fields.find((field) => field.key === "manualScale")
    expect(manualScale).toBeDefined()
    expect(settingRangeDescription(manualScale!)).toBe(
      "范围 25–400%，步长 5%",
    )
    expect(manualScale!.defaultValue).toBe(1)
    expect(settingDisplayValue(manualScale!, undefined)).toBe(100)
    expect(formatSettingValue(manualScale!, undefined)).toBe("100%")
    expect(settingStorageValue(manualScale!, 150)).toBe(1.5)
    expect(settingDisplayValue(manualScale!, 1.5)).toBe(150)
  })

  it("manualScale 存储值按 0.25–4 校验，不把百分数当存储值", () => {
    for (const manualScale of [0.25, 1, 1.5, 4]) {
      expect(validateGlobalDraft({ pdf: { manualScale } })).toEqual({})
    }
    for (const manualScale of [0.24, 4.01, 25, 400]) {
      expect(
        validateGlobalDraft({ pdf: { manualScale } }),
      ).toHaveProperty("pdf.manualScale")
    }
  })
})

describe("全局默认来源与草稿", () => {
  it("字段来源只有 built-in/global，从不返回 book", () => {
    const value = { reflow: { fontSize: 18 } }
    expect(globalSettingSource(value, "reflow", "fontSize")).toBe("global")
    expect(globalSettingSource(value, "reflow", "lineHeight")).toBe(
      "built-in",
    )
    expect(globalSettingSource(undefined, "pdf", "gap")).toBe("built-in")
  })

  it("按 group/key 合并时保留其他字段且不修改原对象", () => {
    const saved = { reflow: { fontSize: 16, lineHeight: 1.6 } }
    const next = withGlobalSettingValue(saved, "reflow", "fontSize", 18)
    expect(next).toEqual({
      reflow: { fontSize: 18, lineHeight: 1.6 },
    })
    expect(saved).toEqual({ reflow: { fontSize: 16, lineHeight: 1.6 } })
    expect(globalFieldIsDirty(next, saved, "reflow", "fontSize")).toBe(true)
    expect(globalFieldIsDirty(next, saved, "reflow", "lineHeight")).toBe(false)
  })

  it("比较不依赖对象键顺序", () => {
    expect(
      globalValuesEqual(
        { reflow: { fontSize: 18, lineHeight: 1.6 } },
        { reflow: { lineHeight: 1.6, fontSize: 18 } },
      ),
    ).toBe(true)
  })

  it("改回内置默认后草稿与空全局记录等价，不再标记未保存", () => {
    const empty: Record<string, unknown> = {}
    expect(globalDraftIsDirty({}, empty)).toBe(false)
    expect(
      globalDraftIsDirty({ pdf: { manualScale: 1 } }, empty),
    ).toBe(false)
    expect(
      globalFieldIsDirty({ pdf: { manualScale: 1 } }, empty, "pdf", "manualScale"),
    ).toBe(false)
    expect(
      globalDraftIsDirty({ reflow: { fontSize: 16 } }, empty),
    ).toBe(false)
  })

  it("字段改回保存值后不再标记未保存，改回默认仍区别于已保存自定义值", () => {
    const saved = { pdf: { manualScale: 1.5 } }
    expect(globalDraftIsDirty(saved, saved)).toBe(false)
    expect(
      globalDraftIsDirty({ pdf: { manualScale: 2 } }, saved),
    ).toBe(true)
    expect(
      globalDraftIsDirty({ pdf: { manualScale: 1.5 } }, saved),
    ).toBe(false)
    expect(
      globalFieldIsDirty(
        { pdf: { manualScale: 1.5 } },
        saved,
        "pdf",
        "manualScale",
      ),
    ).toBe(false)
    expect(
      globalFieldIsDirty(
        { pdf: { manualScale: 1 } },
        saved,
        "pdf",
        "manualScale",
      ),
    ).toBe(true)
  })

  it("加载值超出范围或枚举时给出就近字段错误", () => {
    expect(
      validateGlobalDraft({
        reflow: { fontSize: 50, backgroundColor: "#fff" },
        pdf: { manualScale: 5 },
        comic: { mode: "triple" },
      }),
    ).toMatchObject({
      "reflow.fontSize": expect.stringContaining("12–48px"),
      "pdf.manualScale": expect.stringContaining("25–400%"),
      "comic.mode": expect.stringContaining("不在可用选项"),
    })
    expect(
      validateGlobalDraft({
        reflow: { fontSize: 18, lineHeight: 1.8, text: "#112233" },
        pdf: { manualScale: 1.5, toolbarVisible: false },
        comic: { direction: "rtl", gap: "compact" },
      }),
    ).toEqual({})
    expect(
      validateGlobalDraft({ reflow: { background: "not-a-color" } }),
    ).toHaveProperty("reflow.background")
  })
})

describe("全局默认 409 与 422 解析", () => {
  const current = {
    schemaVersion: 1,
    revision: "7",
    updatedAt: "2026-11-10T10:00:00Z",
    value: { reflow: { fontSize: 20 } },
  }

  it("从 409 current 读取服务器当前记录", () => {
    const conflict = readerSettingsConflict(
      new ApiError(409, "revision_conflict", "冲突", "", { current }),
    )
    expect(conflict).toEqual(current)
    expect(readerSettingsConflict(new ApiError(409, "revision_conflict", "冲突", "", {}))).toBeNull()
    expect(readerSettingsConflict(new ApiError(500, "server_error", "错误", "", { current }))).toBeNull()
  })

  it("从 422 读取字段路径与消息", () => {
    expect(
      readerSettingsFieldError(
        new ApiError(422, "invalid_request", "fontSize 超出范围", "", {
          field: "reflow.fontSize",
        }),
      ),
    ).toEqual({
      field: "reflow.fontSize",
      message: "fontSize 超出范围",
    })
    expect(
      readerSettingsFieldError(new ApiError(422, "invalid_request", "坏值", "", {})),
    ).toBeNull()
  })

  it("冲突记录可展开为当前显式字段列表", () => {
    const entries = recordFieldEntries(current)
    expect(entries).toEqual([
      {
        path: "reflow.fontSize",
        groupLabel: "EPUB",
        label: "字号",
        value: "20px",
      },
    ])
    expect(formatUpdatedAt(null)).toBe("从未保存")
  })
})
