import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, RotateCcw, Save, Globe2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ReaderSlider as Slider } from "./reader-slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { describeApiError } from "@/features/library/errors"
import type { BookFormat } from "@/features/library/types"
import { ApiError, isRecord } from "@/lib/api"

import {
  parseBookReaderOverrides,
  parseReaderSettingsEnvelope,
  type ReaderProfile,
  type ReaderSettingSource,
} from "../types"
import {
  formatSettingValue,
  mergePendingIntoGlobal,
  READER_SETTING_GROUPS,
  readSettingSource,
  readSettingValue,
  settingDisplayValue,
  settingSourceLabel,
  settingStorageValue,
  type ReaderSettingField,
  type ReaderSettingGroup,
} from "./settings-model"
import {
  conflictRevision,
  fetchBookReaderOverrides,
  fetchReaderGlobalSettings,
  isConflictError,
  isNotFoundError,
  putReaderGlobalSettings,
} from "./reader-api"
import { readerQueryKeys } from "./query-keys"
import { epubSettingsPatch, readerSurfaceColors, validateEpubColors } from "./epub-settings"
import type { ReaderSettingsDraftView } from "./use-reader-settings-draft"

interface ReaderSettingsPanelProps {
  bookId: string
  fileVersion: string | null
  format: BookFormat | null
  profile: ReaderProfile
  enabled: boolean
  pending: Record<string, unknown>
  onPendingChange: (next: Record<string, unknown>) => void
  autoSave: ReaderSettingsDraftView
}

type SaveStatus =
  | { kind: "idle"; message: string }
  | { kind: "saving"; message: string }
  | { kind: "saved"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "error"; message: string }

interface ConflictState {
  scope: "book" | "global"
  revision: string | null
}

function ReaderColorControl({ id, label, value, options, disabled, onChange }: {
  id: string; label: string; value: string; options: ReaderSettingField["options"]; disabled: boolean; onChange: (value: string) => void
}) {
  const [input, setInput] = useState({ source: value, text: value.startsWith("#") ? value : "" })
  const custom = input.source === value ? input.text : value.startsWith("#") ? value : ""
  const invalid = custom !== "" && !/^#[0-9a-f]{6}$/.test(custom)
  return <div className="iread-reader-settings__color">
    <Select value={value.startsWith("#") ? "custom" : value === "auto" ? "inherit" : value} disabled={disabled} onValueChange={next => { if (next !== "custom") { setInput({ source: next, text: "" }); onChange(next) } }}>
      <SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{options?.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}<SelectItem value="custom">自定义颜色</SelectItem></SelectContent>
    </Select>
    <Input aria-label={`${label}自定义颜色`} placeholder="#rrggbb" value={custom} disabled={disabled} aria-invalid={invalid} onChange={event => {
      const text = event.target.value.toLowerCase(); setInput({ source: value, text })
      const valid = /^#[0-9a-f]{6}$/.test(text)
      if (valid) onChange(text)
    }} />
    {invalid ? <p role="alert" className="iread-reader-settings__description">请输入完整的六位颜色；未应用此输入。</p> : null}
  </div>
}

function badgeVariantForSource(
  source: ReaderSettingSource | "pending",
): "default" | "secondary" | "outline" {
  if (source === "book") {
    return "default"
  }
  if (source === "global") {
    return "secondary"
  }
  return "outline"
}

function sourceText(source: ReaderSettingSource | "pending"): string {
  return source === "pending" ? "本书（未保存）" : settingSourceLabel(source)
}

export function ReaderSettingsPanel({
  bookId,
  fileVersion,
  format,
  profile,
  enabled,
  pending,
  onPendingChange,
  autoSave,
}: ReaderSettingsPanelProps) {
  const queryClient = useQueryClient()
  const settingGroups = useMemo(() => {
    if (format === "epub") {
      return READER_SETTING_GROUPS.filter((group) => group.id === "reflow")
    }
    if (format === "pdf") {
      return READER_SETTING_GROUPS.filter((group) => group.id === "pdf")
    }
    if (format === "cbz" || format === "cbr") {
      return READER_SETTING_GROUPS.filter((group) => group.id === "comic")
    }
    return READER_SETTING_GROUPS
  }, [format])
  const defaultTab = settingGroups[0]?.id ?? "reflow"
  const [tab, setTab] = useState<string>(defaultTab)
  const activeTab = settingGroups.some((group) => group.id === tab)
    ? tab
    : defaultTab
  const [status, setStatus] = useState<SaveStatus>(() => ({
    kind: "idle",
    message:
      Object.keys(pending).length > 0
        ? "有未保存的更改。"
        : "读取设置后可修改；保存范围由下方按钮决定。",
  }))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [conflict, setConflict] = useState<ConflictState | null>(null)

  const globalQuery = useQuery({
    queryKey: readerQueryKeys.globalSettings(),
    queryFn: ({ signal }) => fetchReaderGlobalSettings(signal),
    retry: false,
    enabled,
  })
  const overridesQuery = useQuery({
    queryKey: readerQueryKeys.bookOverrides(bookId, fileVersion ?? "", profile),
    queryFn: ({ signal }) => fetchBookReaderOverrides(bookId, profile, signal),
    retry: false,
    enabled: enabled && fileVersion !== null,
  })

  const globalUnavailable = isNotFoundError(globalQuery.error)
  const overridesUnavailable = isNotFoundError(overridesQuery.error)
  const unavailable =
    !enabled ||
    fileVersion === null ||
    globalUnavailable ||
    overridesUnavailable
  const fatalError =
    (globalQuery.isError && !globalUnavailable) ||
    (overridesQuery.isError && !overridesUnavailable)
  const loading =
    enabled &&
    fileVersion !== null &&
    !unavailable &&
    !fatalError &&
    (globalQuery.isPending || overridesQuery.isPending)

  const overrides = overridesQuery.data
  const globalSettings = globalQuery.data
  const pendingCount = Object.keys(pending).length
  const promotionCount = Object.keys(autoSave.promotion).length
  const saving = status.kind === "saving"

  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: readerQueryKeys.root })
  }

  const handleRetry = () => {
    void globalQuery.refetch()
    if (fileVersion !== null) {
      void overridesQuery.refetch()
    }
  }

  const handleFieldChange = (
    group: ReaderSettingGroup,
    field: ReaderSettingField,
    displayValue: number | string | boolean,
  ) => {
    const path = `${group.id}.${field.key}`
    const next = { ...pending, [path]: settingStorageValue(field, displayValue) }
    if (group.id === "reflow" && field.key === "theme") {
      for (const key of ["background", "text", "link", "selection"]) next[`reflow.${key}`] = "inherit"
    }
    const error = group.id === "reflow" && (field.control === "color" || field.key === "theme")
      ? validateEpubColors(epubSettingsPatch(autoSave.effectiveValues, next, readerSurfaceColors())) : null
    setFieldErrors(previous => field.key === "theme" && !error ? {} : ({ ...previous, [path]: error ?? "" }))
    if (error) return
    onPendingChange(next)
    setConflict(null)
    setStatus({ kind: "idle", message: "此处更改仅自动保存到本书。" })
  }

  const handleConflict = (
    caught: unknown,
    scope: "book" | "global",
  ): boolean => {
    if (
      caught instanceof ApiError &&
      caught.code === "file_version_conflict"
    ) {
      setStatus({
        kind: "error",
        message:
          "原件已在别处更新，本书设置未保存；请重新打开阅读器后再修改。",
      })
      return true
    }
    if (!(caught instanceof ApiError) || !isConflictError(caught)) {
      return false
    }
    const current = caught.details.current
    if (isRecord(current)) {
      try {
        if (scope === "book" && fileVersion !== null) {
          const parsed = parseBookReaderOverrides(current)
          queryClient.setQueryData(
            readerQueryKeys.bookOverrides(bookId, fileVersion, profile),
            parsed,
          )
        } else if (scope === "global") {
          const parsed = parseReaderSettingsEnvelope(current)
          queryClient.setQueryData(readerQueryKeys.globalSettings(), parsed)
        }
      } catch {
        // 冲突响应缺少可解析的 current 时仍保留冲突提示，由用户重新载入。
      }
    }
    setConflict({ scope, revision: conflictRevision(caught) })
    setStatus({
      kind: "conflict",
      message:
        "设置已在另一处更新；未覆盖服务器记录，请选择载入服务器设置或保留本机选择后重试。",
    })
    return true
  }

  const saveBook = async (baseRevisionOverride?: string) => {
    try { await autoSave.flush(baseRevisionOverride); setConflict(null); setStatus({ kind: "saved", message: "本书设置已保存。" }) }
    catch (caught) { if (!handleConflict(caught, "book")) setStatus({ kind: "error", message: `本书设置未保存：${describeApiError(caught, { fallback: "请重试。" })}` }) }
  }

  const saveGlobal = async (baseRevisionOverride?: string) => {
    if (globalSettings === undefined || promotionCount === 0) {
      return
    }
    const submitted = { ...autoSave.promotion }
    setStatus({ kind: "saving", message: "正在写入全局阅读默认值…" })
    try {
      const updated = await putReaderGlobalSettings({
        baseRevision: baseRevisionOverride ?? globalSettings.revision,
        value: mergePendingIntoGlobal(globalSettings.value, submitted),
      })
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchReaderGlobalSettings>>>(readerQueryKeys.globalSettings(), current =>
        !current || BigInt(updated.revision) >= BigInt(current.revision) ? updated : current,
      )
      autoSave.acknowledgePromotion(submitted)
      setConflict(null)
      setStatus({
        kind: "saved",
        message: "已设为全局默认值；未删除其他书籍的本书覆盖。",
      })
      await refreshAll()
    } catch (caught) {
      if (handleConflict(caught, "global")) {
        return
      }
      setStatus({
        kind: "error",
        message: isNotFoundError(caught)
          ? "全局阅读设置接口尚未接入，未保存；本机选择仍保留在面板中。"
          : `写入全局设置失败：${describeApiError(caught, {
              fallback: "请稍后重试。",
            })}`,
      })
    }
  }

  const resetBook = async (baseRevisionOverride?: string) => {
    try { await autoSave.resetBook(baseRevisionOverride); setConflict(null); setStatus({ kind: "saved", message: "已恢复本书默认设置。" }) }
    catch (caught) { if (!handleConflict(caught, "book")) setStatus({ kind: "error", message: `恢复失败：${describeApiError(caught, { fallback: "请重试。" })}` }) }
  }

  const handleKeepLocal = () => {
    if (conflict === null) {
      return
    }
    if (conflict.revision === null) {
      void refreshAll().then(() => {
        setStatus({
          kind: "error",
          message: "已重新读取服务器修订号，请再次选择保留本机选择并保存。",
        })
      })
      return
    }
    if (conflict.scope === "book") {
      void saveBook(conflict.revision)
    } else {
      void saveGlobal(conflict.revision)
    }
  }

  const handleLoadServer = async () => {
    try {
      if (conflict?.scope === "global") {
        await globalQuery.refetch({ throwOnError: true })
        autoSave.acknowledgePromotion({ ...autoSave.promotion })
      } else await autoSave.loadServer()
      setConflict(null); setStatus({ kind: "idle", message: "已载入服务器设置。" })
    } catch { setStatus({ kind: "error", message: "未能加载服务器设置，本机草稿仍保留。" }) }
  }

  const renderControl = (
    group: ReaderSettingGroup,
    field: ReaderSettingField,
    value: unknown,
    disabled: boolean,
  ) => {
    const id = `reader-setting-${group.id}-${field.key}`
    const display = settingDisplayValue(field, value)
    if (field.control === "color") return <ReaderColorControl key={String(pending["reflow.theme"] ?? readSettingValue(autoSave.effectiveValues, "reflow", "theme"))} id={id} label={field.label} value={String(display)} options={field.options} disabled={disabled} onChange={next => handleFieldChange(group, field, next)} />
    if (field.control === "slider") {
      return (
        <Slider
          id={id}
          aria-label={field.label}
          min={field.min ?? 0}
          max={field.max ?? 100}
          step={field.step ?? 1}
          value={[Number(display)]}
          disabled={disabled}
          onValueChange={([next]) => {
            if (typeof next === "number") {
              handleFieldChange(group, field, next)
            }
          }}
        />
      )
    }
    if (field.control === "switch") {
      return (
        <Switch
          id={id}
          aria-label={field.label}
          checked={display === true}
          disabled={disabled}
          onCheckedChange={(next) => {
            handleFieldChange(group, field, next)
          }}
        />
      )
    }
    return (
      <Select
        value={String(display)}
        disabled={disabled}
        onValueChange={(next) => {
          handleFieldChange(group, field, next)
        }}
      >
        <SelectTrigger id={id} className="iread-reader-settings__select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  const renderField = (
    group: ReaderSettingGroup,
    field: ReaderSettingField,
  ) => {
    if (overrides === undefined) {
      return null
    }
    const path = `${group.id}.${field.key}`
    const hasPending = Object.prototype.hasOwnProperty.call(pending, path)
    const bookValue = readSettingValue(overrides.overrides, group.id, field.key)
    const effectiveValue = readSettingValue(
      autoSave.effectiveValues,
      group.id,
      field.key,
    )
    const value = hasPending
      ? pending[path]
      : effectiveValue !== undefined
        ? effectiveValue
        : field.defaultValue
    const source: ReaderSettingSource | "pending" = hasPending
      ? "pending"
      : readSettingSource(overrides.fieldSources, group.id, field.key) ??
        (bookValue === undefined ? "built-in" : "book")
    const id = `reader-setting-${group.id}-${field.key}`

    return (
      <Field className="iread-reader-settings__field" key={path}>
        <div className="iread-reader-settings__field-head">
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          <Badge
            variant={badgeVariantForSource(source)}
            data-source={source}
          >
            {sourceText(source)}
          </Badge>
        </div>
        <div className="iread-reader-settings__control">
          {renderControl(group, field, value, unavailable || saving)}
          <span className="iread-reader-settings__value">
            {formatSettingValue(field, value)}
          </span>
        </div>
        <FieldDescription className="iread-reader-settings__description">
          {field.description}
        </FieldDescription>
        {fieldErrors[path] ? <p role="alert" className="iread-reader-settings__status" data-status="error">{fieldErrors[path]}</p> : null}
      </Field>
    )
  }

  const renderUnavailableField = (
    group: ReaderSettingGroup,
    field: ReaderSettingField,
  ) => (
    <div
      className="iread-reader-settings__field iread-reader-settings__field--unavailable"
      key={`${group.id}.${field.key}`}
    >
      <div className="iread-reader-settings__field-head">
        <span className="iread-reader-settings__label">{field.label}</span>
        <Badge variant="outline">不可用</Badge>
      </div>
      <p className="iread-reader-settings__description">
        设置服务尚未接入，无法读取当前值。
      </p>
    </div>
  )

  return (
    <div className="iread-reader-settings">
      <p className="iread-reader-settings__status" role="status" aria-live="polite" data-reader-autosave={autoSave.status}>
        {autoSave.message}{!autoSave.localSaved ? " 未能写入本机，关闭前请确认服务器已保存。" : ""}
      </p>
      <ScrollArea className="iread-reader-settings__scroll">
      <div className="iread-reader-settings__content">
      {loading ? (
        <p className="iread-reader-panel__status" role="status">
          正在读取阅读设置…
        </p>
      ) : unavailable ? (
        <Alert className="iread-reader-panel__alert">
          <AlertTitle>阅读设置服务尚未接入</AlertTitle>
          <AlertDescription>
            <p>
              当前无法读取或保存 built-in / 全局 / 本书三级继承设置。
              本面板不会显示伪造的有效值，也不会报告已保存。
            </p>
            <Button type="button" size="sm" variant="outline" onClick={handleRetry}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : fatalError ? (
        <Alert variant="destructive" className="iread-reader-panel__alert">
          <AlertTitle>无法读取阅读设置</AlertTitle>
          <AlertDescription>
            <p>
              {describeApiError(globalQuery.error ?? overridesQuery.error, {
                fallback: "请稍后重试。",
              })}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={handleRetry}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={setTab}
        className="iread-reader-settings__tabs"
      >
        <TabsList className="iread-reader-settings__tabs-list">
          {settingGroups.map((group, index) => (
            <TabsTrigger
              key={group.id}
              value={group.id}
              data-reader-panel-focus={index === 0 ? "" : undefined}
            >
              {group.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {settingGroups.map((group) => (
          <TabsContent
            key={group.id}
            value={group.id}
            className="iread-reader-settings__tab-content"
          >
            <div className="iread-reader-settings__group-description">
              {group.description}
            </div>
              <div className="iread-reader-settings__fields">
                {group.fields.map((field) =>
                  unavailable
                    ? renderUnavailableField(group, field)
                    : renderField(group, field),
                )}
              </div>
          </TabsContent>
        ))}
      </Tabs>

      <div className="iread-reader-settings__footer">
        {autoSave.status === "conflict" && conflict === null ? (
          <div className="iread-reader-settings__conflict">
            <Button type="button" size="sm" variant="outline" onClick={() => { void autoSave.loadServer().catch(() => {}) }}>载入服务器设置</Button>
            <Button type="button" size="sm" onClick={() => { void autoSave.keepLocal().catch(() => {}) }}>保留本机选择并重新保存</Button>
          </div>
        ) : null}
        <p
          className="iread-reader-settings__status"
          role="status"
          aria-live="polite"
          data-status={unavailable ? "error" : status.kind}
        >
          {status.kind === "saved" && !unavailable ? (
            <CheckCircle2 aria-hidden="true" />
          ) : null}
          {unavailable
            ? pendingCount > 0
              ? "设置服务不可用；本机草稿已保留，尚未保存。"
              : "设置服务不可用，当前不能保存。"
            : status.message}
        </p>

        {conflict === null ? null : (
          <div className="iread-reader-settings__conflict">
            <Button type="button" size="sm" variant="outline" onClick={handleLoadServer}>
              载入服务器设置
            </Button>
            <Button type="button" size="sm" onClick={handleKeepLocal}>
              保留本机选择并重新保存
            </Button>
          </div>
        )}

        <div className="iread-reader-settings__actions">
          <Button
            type="button"
            size="sm"
            disabled={unavailable || saving || (pendingCount === 0 && !autoSave.reset)}
            onClick={() => {
              void saveBook()
            }}
          >
            <Save aria-hidden="true" />
            立即保存本书
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={unavailable || saving || promotionCount === 0}
            onClick={() => {
              void saveGlobal()
            }}
          >
            <Globe2 aria-hidden="true" />
            设为全局默认
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              unavailable ||
              saving ||
              overrides === undefined ||
              (overrides.revision === "0" && pendingCount === 0 && !autoSave.reset &&
                Object.keys(overrides.overrides).length === 0)
            }
            onClick={() => {
              void resetBook()
            }}
          >
            <RotateCcw aria-hidden="true" />
            恢复本书默认
          </Button>
        </div>
        <p className="iread-reader-settings__note">
          本书更改会自动保存；“设为全局默认”仅显式提交本次改动字段（自动保存成功后仍可操作），
          不隐式删除其他书籍的本书覆盖。单书设置不会复制整份有效值。
        </p>
      </div>
      </div>
      </ScrollArea>
    </div>
  )
}
