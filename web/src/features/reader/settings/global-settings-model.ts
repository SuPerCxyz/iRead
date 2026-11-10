import { ApiError, isRecord } from "@/lib/api"
import type {
  ReaderSettingSource,
  ReaderSettingsEnvelope,
} from "../types"
import { parseReaderSettingsEnvelope } from "../types"
import {
  READER_SETTING_GROUPS,
  formatSettingValue,
  readSettingValue,
  settingDisplayValue,
  settingGroup,
  type ReaderSettingField,
  type ReaderSettingGroup,
  type ReaderSettingGroupId,
} from "../shell/settings-model"
import {
  epubSettingsPatch,
  readerSurfaceColors,
  validateEpubColors,
} from "../shell/epub-settings"

export type GlobalReaderFormatId = "epub" | "pdf" | "comic"
export type GlobalSettingSource = Exclude<ReaderSettingSource, "book">
export type GlobalReaderDraft = Record<string, unknown>

export interface GlobalReaderFormatOption {
  id: GlobalReaderFormatId
  label: string
  groupId: ReaderSettingGroupId
}

export const GLOBAL_READER_FORMATS: GlobalReaderFormatOption[] = [
  { id: "epub", label: "EPUB", groupId: "reflow" },
  { id: "pdf", label: "PDF", groupId: "pdf" },
  { id: "comic", label: "漫画", groupId: "comic" },
]

export interface ContrastIssue {
  message: string
  fields: string[]
}

export function globalReaderGroup(groupId: ReaderSettingGroupId): ReaderSettingGroup {
  return settingGroup(groupId) ?? READER_SETTING_GROUPS[0]
}

export function globalReaderGroupForFormat(
  format: GlobalReaderFormatId,
): ReaderSettingGroup {
  const option = GLOBAL_READER_FORMATS.find((item) => item.id === format)
  return globalReaderGroup(option?.groupId ?? "reflow")
}

/**
 * 全局默认只有 built-in / global 两级来源；本页不读取也不显示单书覆盖。
 */
export function globalSettingSource(
  value: GlobalReaderDraft | undefined,
  group: ReaderSettingGroupId,
  key: string,
): GlobalSettingSource {
  return readSettingValue(value, group, key) === undefined
    ? "built-in"
    : "global"
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T
  }
  if (isRecord(value)) {
    const cloned: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(item)
    }
    return cloned as T
  }
  return value
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJson(item))
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalJson(value[key])
    }
    return sorted
  }
  return value
}

export function cloneGlobalDraft(value: GlobalReaderDraft): GlobalReaderDraft {
  return cloneJsonValue(value)
}

export function globalValuesEqual(
  first: unknown,
  second: unknown,
): boolean {
  return JSON.stringify(canonicalJson(first)) === JSON.stringify(canonicalJson(second))
}

export function withGlobalSettingValue(
  value: GlobalReaderDraft,
  group: ReaderSettingGroupId,
  key: string,
  nextValue: unknown,
): GlobalReaderDraft {
  const current = isRecord(value[group]) ? value[group] : {}
  return {
    ...value,
    [group]: { ...current, [key]: nextValue },
  }
}

/**
 * 合并一次字段修改；切换阅读主题时同步把自定义颜色恢复为“沿用”。
 * 返回新对象，不修改传入草稿。
 */
export function changeGlobalSettingValue(
  value: GlobalReaderDraft,
  group: ReaderSettingGroupId,
  field: ReaderSettingField,
  nextValue: unknown,
): GlobalReaderDraft {
  const next = withGlobalSettingValue(value, group, field.key, nextValue)
  if (group === "reflow" && field.key === "theme") {
    const reflow = isRecord(next.reflow) ? next.reflow : {}
    return {
      ...next,
      reflow: {
        ...reflow,
        background: "inherit",
        text: "inherit",
        link: "inherit",
        selection: "inherit",
      },
    }
  }
  return next
}

/**
 * 把稀疏草稿补齐为实际生效值（缺省字段取内置默认）。
 * 脏检查必须比较生效值：服务器没有显式字段时，把控件改回内置默认
 * 不应继续显示“有未保存的更改”。
 */
export function globalEffectiveValues(
  value: GlobalReaderDraft | undefined,
): GlobalReaderDraft {
  const effective = cloneGlobalDraft(value ?? {})
  for (const group of READER_SETTING_GROUPS) {
    const storedGroup = effective[group.id]
    const current = isRecord(storedGroup) ? { ...storedGroup } : {}
    let touched = false
    for (const field of group.fields) {
      if (readSettingValue(value, group.id, field.key) === undefined) {
        current[field.key] = field.defaultValue
        touched = true
      }
    }
    if (touched) {
      effective[group.id] = current
    }
  }
  return effective
}

export function globalDraftIsDirty(
  draft: GlobalReaderDraft,
  saved: GlobalReaderDraft | undefined,
): boolean {
  return !globalValuesEqual(
    globalEffectiveValues(draft),
    globalEffectiveValues(saved),
  )
}

export function globalFieldIsDirty(
  draft: GlobalReaderDraft,
  saved: GlobalReaderDraft | undefined,
  group: ReaderSettingGroupId,
  key: string,
): boolean {
  const field = settingGroup(group)?.fields.find((item) => item.key === key)
  const draftValue = readSettingValue(draft, group, key)
  const savedValue = readSettingValue(saved, group, key)
  if (field === undefined) {
    return !globalValuesEqual(draftValue, savedValue)
  }
  return !globalValuesEqual(
    draftValue === undefined ? field.defaultValue : draftValue,
    savedValue === undefined ? field.defaultValue : savedValue,
  )
}

function settingRangeText(field: ReaderSettingField): string | null {
  if (
    field.control !== "slider" ||
    field.min === undefined ||
    field.max === undefined
  ) {
    return null
  }
  const unit = field.unit ?? ""
  const step = field.step === undefined ? "" : `，步长 ${field.step}${unit}`
  return `范围 ${field.min}–${field.max}${unit}${step}`
}

/** 滑块范围按界面显示值给出，manualScale 等 valueScale 字段不会误报。 */
export function settingRangeDescription(
  field: ReaderSettingField,
): string | null {
  return settingRangeText(field)
}

function colorValueError(
  field: ReaderSettingField,
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return `${field.label}必须是颜色字符串。`
  }
  const allowed = new Set((field.options ?? []).map((option) => option.value))
  allowed.add("auto")
  if (allowed.has(value) || /^#[0-9a-f]{6}$/.test(value)) {
    return null
  }
  return `${field.label}必须是预设名或小写 #rrggbb。`
}

function fieldValueError(
  field: ReaderSettingField,
  value: unknown,
): string | null {
  if (field.control === "switch") {
    return typeof value === "boolean" ? null : `${field.label}必须是开关值。`
  }
  if (field.control === "color") {
    return colorValueError(field, value)
  }
  if (field.control === "select") {
    if (typeof value !== "string") {
      return `${field.label}必须选择一个选项。`
    }
    return field.options?.some((option) => option.value === value)
      ? null
      : `${field.label}的当前值不在可用选项中。`
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${field.label}必须是数字。`
  }
  const display = settingDisplayValue(field, value)
  if (typeof display !== "number") {
    return `${field.label}必须是数字。`
  }
  const min = field.min ?? Number.NEGATIVE_INFINITY
  const max = field.max ?? Number.POSITIVE_INFINITY
  if (display < min || display > max) {
    const unit = field.unit ?? ""
    return `${field.label}应在 ${min}–${max}${unit} 之间。`
  }
  return null
}

export function validateGlobalDraft(
  value: GlobalReaderDraft,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const group of READER_SETTING_GROUPS) {
    for (const field of group.fields) {
      const stored = readSettingValue(value, group.id, field.key)
      if (stored === undefined) {
        continue
      }
      const error = fieldValueError(field, stored)
      if (error !== null) {
        errors[`${group.id}.${field.key}`] = error
      }
    }
  }
  return errors
}

function contrastFieldPaths(message: string): string[] {
  if (message.includes("链接与背景")) {
    return ["reflow.background", "reflow.link"]
  }
  if (message.includes("选区")) {
    return ["reflow.text", "reflow.selection"]
  }
  if (message.includes("文字与背景")) {
    return ["reflow.background", "reflow.text"]
  }
  return [
    "reflow.background",
    "reflow.text",
    "reflow.link",
    "reflow.selection",
  ]
}

/**
 * 只在显式设置了正文颜色/主题时校验，避免 PDF/漫画设置被无关主题阻止。
 * 加载和保存都调用同一套校验；失败时保存按钮必须保持不可用。
 */
export function reflowContrastIssue(
  value: GlobalReaderDraft,
): ContrastIssue | null {
  const colorKeys = ["theme", "background", "text", "link", "selection"]
  const hasColorOverride = colorKeys.some(
    (key) => readSettingValue(value, "reflow", key) !== undefined,
  )
  if (!hasColorOverride) {
    return null
  }
  const message = validateEpubColors(
    epubSettingsPatch(value, {}, readerSurfaceColors()),
  )
  if (message === null) {
    return null
  }
  return { message, fields: contrastFieldPaths(message) }
}

export function readerSettingsConflict(
  error: unknown,
): ReaderSettingsEnvelope | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null
  }
  if (!isRecord(error.details.current)) {
    return null
  }
  try {
    return parseReaderSettingsEnvelope(error.details.current)
  } catch {
    return null
  }
}

export function readerSettingsFieldError(
  error: unknown,
): { field: string; message: string } | null {
  if (!(error instanceof ApiError) || error.status !== 422) {
    return null
  }
  const field = error.details.field
  if (typeof field !== "string" || field.length === 0) {
    return null
  }
  return {
    field,
    message: error.message || "全局阅读默认值无效。",
  }
}

export function formatUpdatedAt(updatedAt: string | null): string {
  if (updatedAt === null) {
    return "从未保存"
  }
  const timestamp = Date.parse(updatedAt)
  if (Number.isNaN(timestamp)) {
    return updatedAt
  }
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

export function recordFieldEntries(
  record: ReaderSettingsEnvelope,
): Array<{ path: string; groupLabel: string; label: string; value: string }> {
  const entries: Array<{
    path: string
    groupLabel: string
    label: string
    value: string
  }> = []
  for (const option of GLOBAL_READER_FORMATS) {
    const group = globalReaderGroup(option.groupId)
    for (const field of group.fields) {
      const value = readSettingValue(record.value, group.id, field.key)
      if (value === undefined) {
        continue
      }
      entries.push({
        path: `${group.id}.${field.key}`,
        groupLabel: option.label,
        label: field.label,
        value: formatSettingValue(field, value),
      })
    }
  }
  return entries
}
