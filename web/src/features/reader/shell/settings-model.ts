import { isRecord } from "@/lib/api"

import type { ReaderSettingSource } from "../types"

export type ReaderSettingGroupId = "reflow" | "pdf" | "comic"
export type ReaderSettingControl = "slider" | "select" | "switch" | "color"

export interface ReaderSettingOption {
  value: string
  label: string
}

export interface ReaderSettingField {
  key: string
  label: string
  description: string
  control: ReaderSettingControl
  defaultValue: number | string | boolean
  unit?: string
  min?: number
  max?: number
  step?: number
  /** 展示值 = 存储值 × valueScale，例如 manualScale 0.25–4 显示为 25–400%。 */
  valueScale?: number
  options?: ReaderSettingOption[]
}

export interface ReaderSettingGroup {
  id: ReaderSettingGroupId
  label: string
  description: string
  fields: ReaderSettingField[]
}

export const READER_SETTING_GROUPS: ReaderSettingGroup[] = [
  {
    id: "reflow",
    label: "EPUB 文字",
    description: "只影响 EPUB 重排正文，不改变 PDF 与漫画。",
    fields: [
      {
        key: "theme", label: "阅读主题", description: "只改变正文；选择预设会同时恢复背景、文字、链接和选区的自定义颜色。",
        control: "select", defaultValue: "inherit-app",
        options: [{ value: "inherit-app", label: "跟随应用" }, { value: "paper", label: "暖纸" }, { value: "white", label: "纯白" }, { value: "gray", label: "深灰" }, { value: "midnight", label: "深蓝黑" }],
      },
      {
        key: "publisherFont", label: "允许出版方字体", description: "关闭且字体选择为出版方时使用系统无衬线；不加载外部字体。",
        control: "switch", defaultValue: true,
      },
      {
        key: "fontFamily",
        label: "字体",
        description: "出版方字体优先；没有可用出版方字体时回退系统字体。",
        control: "select",
        defaultValue: "publisher",
        options: [
          { value: "publisher", label: "出版方字体" },
          { value: "system-sans", label: "系统无衬线" },
          { value: "serif", label: "衬线" },
          { value: "chinese-system", label: "中文系统字体" },
        ],
      },
      {
        key: "fontSize",
        label: "字号",
        description: "重排正文字号。",
        control: "slider",
        defaultValue: 16,
        unit: "px",
        min: 12,
        max: 48,
        step: 1,
      },
      {
        key: "fontWeight", label: "字重", description: "100–900；实际字形取决于可用字体。",
        control: "slider", defaultValue: 400, min: 100, max: 900, step: 100,
      },
      {
        key: "lineHeight",
        label: "行高",
        description: "无单位倍数。",
        control: "slider",
        defaultValue: 1.6,
        min: 1.2,
        max: 2.4,
        step: 0.05,
      },
      {
        key: "paragraphSpacing",
        label: "段间距",
        description: "段落之间的距离。",
        control: "slider",
        defaultValue: 0,
        unit: "em",
        min: 0,
        max: 3,
        step: 0.1,
      },
      {
        key: "textIndent",
        label: "首行缩进",
        description: "段落首行缩进量。",
        control: "slider",
        defaultValue: 0,
        unit: "em",
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        key: "align",
        label: "对齐",
        description: "两端对齐可能放大小字号下的字距。",
        control: "select",
        defaultValue: "start",
        options: [
          { value: "start", label: "左对齐" },
          { value: "justify", label: "两端对齐" },
        ],
      },
      {
        key: "horizontalMargin",
        label: "左右页边距",
        description: "相对阅读视口的宽度。",
        control: "slider",
        defaultValue: 6,
        unit: "vw",
        min: 0,
        max: 12,
        step: 1,
      },
      {
        key: "verticalMargin",
        label: "上下页边距",
        description: "相对阅读视口的高度。",
        control: "slider",
        defaultValue: 4,
        unit: "vh",
        min: 0,
        max: 12,
        step: 1,
      },
      {
        key: "maxWidth",
        label: "正文最大宽度",
        description: "自动或限定字符宽度。",
        control: "select",
        defaultValue: "auto",
        options: [
          { value: "auto", label: "自动" },
          { value: "40", label: "40ch" },
          { value: "50", label: "50ch" },
          { value: "60", label: "60ch" },
          { value: "70", label: "70ch" },
          { value: "80", label: "80ch" },
          { value: "90", label: "90ch" },
          { value: "100", label: "100ch" },
        ],
      },
      {
        key: "pagination",
        label: "翻页方式",
        description: "分页或连续滚动。",
        control: "select",
        defaultValue: "pagination",
        options: [
          { value: "pagination", label: "分页" },
          { value: "scroll", label: "滚动" },
        ],
      },
      {
        key: "columns",
        label: "栏数",
        description: "较窄视口可能仍回落为单栏。",
        control: "select",
        defaultValue: "1",
        options: [
          { value: "1", label: "单栏" },
          { value: "2", label: "双栏（可用时）" },
        ],
      },
      {
        key: "animation",
        label: "翻页动画",
        description: "仅影响翻页过渡，不改变定位。",
        control: "select",
        defaultValue: "none",
        options: [
          { value: "none", label: "无" },
          { value: "light", label: "轻量" },
        ],
      },
      ...[ ["background", "正文背景"], ["text", "正文文字"], ["link", "正文链接"], ["selection", "选区背景"] ].map(([key, label]): ReaderSettingField => ({
        key, label, description: "沿用阅读主题、选择官方预设，或输入 #rrggbb；低对比度颜色不会应用。",
        control: "color", defaultValue: "inherit",
        options: [{ value: "inherit", label: "沿用阅读主题" }, { value: "template", label: "应用模板" }, { value: "paper", label: "暖纸" }, { value: "white", label: "纯白" }, { value: "gray", label: "深灰" }, { value: "midnight", label: "深蓝黑" }],
      })),
      {
        key: "publisherCSSMode",
        label: "出版方 CSS",
        description: "关闭后只用受控的重排基线，不注入任意 CSS。",
        control: "select",
        defaultValue: "publisher",
        options: [
          { value: "publisher", label: "出版方优先" },
          { value: "off", label: "不加载出版方样式" },
        ],
      },
    ],
  },
  {
    id: "pdf",
    label: "PDF 布局",
    description: "只影响 PDF 视图，不伪改内嵌字号与行高。",
    fields: [
      {
        key: "layoutMode",
        label: "页面布局",
        description: "单页、连续或横向。",
        control: "select",
        defaultValue: "single",
        options: [
          { value: "single", label: "单页" },
          { value: "continuous", label: "连续" },
          { value: "horizontal", label: "横向" },
        ],
      },
      {
        key: "zoomMode",
        label: "缩放模式",
        description: "适应宽度/页面，或手动比例。",
        control: "select",
        defaultValue: "fit-width",
        options: [
          { value: "fit-width", label: "适应宽度" },
          { value: "fit-page", label: "适应页面" },
          { value: "manual", label: "手动" },
        ],
      },
      {
        key: "manualScale",
        label: "手动缩放",
        description: "切回适应模式时保留此比例，但不把测量结果写回。",
        control: "slider",
        // 存储值是 0.25–4 的比例，界面按百分比显示。
        defaultValue: 1,
        unit: "%",
        min: 25,
        max: 400,
        step: 5,
        valueScale: 100,
      },
      {
        key: "gap",
        label: "页距",
        description: "沿用官方间距档位。",
        control: "select",
        defaultValue: "standard",
        options: [
          { value: "compact", label: "紧凑" },
          { value: "standard", label: "标准" },
          { value: "relaxed", label: "宽松" },
        ],
      },
      {
        key: "toolbarVisible",
        label: "显示 PDF 工具栏",
        description: "关闭后由阅读器外壳接管翻页与跳转。",
        control: "switch",
        defaultValue: true,
      },
      {
        key: "background",
        label: "纸张外背景",
        description: "只影响页面外区域；反色/滤镜默认不启用。",
        control: "select",
        defaultValue: "inherit",
        options: [
          { value: "inherit", label: "跟随应用主题" },
          { value: "paper", label: "暖纸" },
          { value: "white", label: "纯白" },
          { value: "gray", label: "深灰" },
          { value: "midnight", label: "深蓝黑" },
        ],
      },
    ],
  },
  {
    id: "comic",
    label: "漫画",
    description: "方向、单双页与适应方式按书保存。",
    fields: [
      {
        key: "direction",
        label: "阅读方向",
        description: "从右到左常见于日式漫画。",
        control: "select",
        defaultValue: "ltr",
        options: [
          { value: "ltr", label: "从左到右" },
          { value: "rtl", label: "从右到左" },
        ],
      },
      {
        key: "mode",
        label: "显示模式",
        description: "单页、双页或连续。",
        control: "select",
        defaultValue: "single",
        options: [
          { value: "single", label: "单页" },
          { value: "double", label: "双页" },
          { value: "continuous", label: "连续" },
        ],
      },
      {
        key: "fit",
        label: "适应方式",
        description: "屏幕、宽度或原始尺寸。",
        control: "select",
        defaultValue: "screen",
        options: [
          { value: "screen", label: "适应屏幕" },
          { value: "width", label: "适应宽度" },
          { value: "original", label: "原始尺寸" },
        ],
      },
      {
        key: "gap",
        label: "页距",
        description: "沿用官方间距档位。",
        control: "select",
        defaultValue: "standard",
        options: [
          { value: "compact", label: "紧凑" },
          { value: "standard", label: "标准" },
          { value: "relaxed", label: "宽松" },
        ],
      },
      {
        key: "background",
        label: "页面外背景",
        description: "只影响页面外区域。",
        control: "select",
        defaultValue: "inherit",
        options: [
          { value: "inherit", label: "跟随应用主题" },
          { value: "paper", label: "暖纸" },
          { value: "white", label: "纯白" },
          { value: "gray", label: "深灰" },
          { value: "midnight", label: "深蓝黑" },
        ],
      },
    ],
  },
]

export function settingGroup(
  id: ReaderSettingGroupId,
): ReaderSettingGroup | null {
  return READER_SETTING_GROUPS.find((group) => group.id === id) ?? null
}

export function readSettingValue(
  record: Record<string, unknown> | undefined,
  group: ReaderSettingGroupId,
  key: string,
): unknown {
  if (record === undefined) {
    return undefined
  }
  const groupValue = record[group]
  if (isRecord(groupValue) && groupValue[key] !== undefined) {
    return groupValue[key]
  }
  return record[`${group}.${key}`]
}

export function readSettingSource(
  record: Record<string, unknown> | undefined,
  group: ReaderSettingGroupId,
  key: string,
): ReaderSettingSource | null {
  const value = readSettingValue(record, group, key)
  if (value === "built-in" || value === "global" || value === "book") {
    return value
  }
  return null
}

export function settingSourceLabel(source: ReaderSettingSource): string {
  if (source === "book") {
    return "本书覆盖"
  }
  if (source === "global") {
    return "全局"
  }
  return "内置"
}

export function settingDisplayValue(
  field: ReaderSettingField,
  value: unknown,
): number | string | boolean {
  if (field.control === "switch") {
    return typeof value === "boolean" ? value : field.defaultValue === true
  }
  if (field.control === "color") return typeof value === "string" ? value : String(field.defaultValue)
  if (field.control === "select") {
    const selected = typeof value === "string" ? value : undefined
    if (selected !== undefined && field.options?.some((option) => option.value === selected)) {
      return selected
    }
    return String(field.defaultValue)
  }
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : Number(field.defaultValue)
  return numeric * (field.valueScale ?? 1)
}

export function settingStorageValue(
  field: ReaderSettingField,
  displayValue: number | string | boolean,
): unknown {
  if (field.control === "slider") {
    const numeric = typeof displayValue === "number" ? displayValue : Number(displayValue)
    return numeric / (field.valueScale ?? 1)
  }
  return displayValue
}

export function formatSettingValue(
  field: ReaderSettingField,
  value: unknown,
): string {
  const display = settingDisplayValue(field, value)
  if (field.control === "switch") {
    return display === true ? "开启" : "关闭"
  }
  if (field.control === "select" || field.control === "color") {
    return (
      field.options?.find((option) => option.value === display)?.label ??
      String(display)
    )
  }
  const numeric = Number(display)
  const rounded = Number.isInteger(numeric)
    ? String(numeric)
    : numeric.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
  return `${rounded}${field.unit === undefined ? "" : field.unit}`
}

/** 只把待保存字段合并进目标值，不隐式删除其他字段或其他书覆盖。 */
export function mergePendingIntoGlobal(
  globalValue: Record<string, unknown>,
  pending: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...globalValue }
  for (const [path, value] of Object.entries(pending)) {
    const [group, key] = path.split(".")
    if (group === undefined || key === undefined || key.length === 0) {
      continue
    }
    const current = isRecord(merged[group]) ? merged[group] : {}
    merged[group] = { ...current, [key]: value }
  }
  return merged
}

/**
 * 单书 PUT 的 overrides 是完整稀疏集合；把待保存字段合并到已有覆盖，
 * 避免改一个字段时删除其他本书覆盖。
 */
export function mergeBookOverrides(
  current: Record<string, unknown>,
  pending: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return mergePendingIntoGlobal(current, pending) as Record<
    string,
    Record<string, unknown>
  >
}

export function pendingPathsForGroup(
  pending: Record<string, unknown>,
  group: ReaderSettingGroupId,
): string[] {
  return Object.keys(pending).filter((path) => path.startsWith(`${group}.`))
}
