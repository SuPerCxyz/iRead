import {
  AlertCircle,
  CheckCircle2,
  Info,
  RotateCcw,
  Save,
} from "lucide-react"
import { useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import type { ReaderSettingField, ReaderSettingGroup } from "../shell/settings-model"
import { readSettingValue } from "../shell/settings-model"
import type { ReaderSettingsEnvelope } from "../types"
import {
  GLOBAL_READER_FORMATS,
  formatUpdatedAt,
  globalFieldIsDirty,
  globalReaderGroup,
  globalSettingSource,
  globalValuesEqual,
  recordFieldEntries,
  type GlobalReaderFormatId,
} from "./global-settings-model"
import { GlobalSettingField } from "./global-setting-field"
import { useGlobalReaderSettings } from "./use-global-reader-settings"

function CurrentRecordSummary({
  record,
}: {
  record: ReaderSettingsEnvelope
}) {
  const entries = recordFieldEntries(record)
  if (entries.length === 0) {
    return (
      <p className="iread-reader-defaults__note">
        服务器当前没有显式全局字段，全部沿用内置默认。
      </p>
    )
  }
  return (
    <ul className="iread-reader-defaults__record-list">
      {entries.map((entry) => (
        <li key={entry.path}>
          {entry.groupLabel} · {entry.label}：{entry.value}
        </li>
      ))}
    </ul>
  )
}

function fieldsForGroup(
  group: ReaderSettingGroup,
  draft: Record<string, unknown>,
  saved: Record<string, unknown>,
  fieldErrors: Record<string, string>,
  disabled: boolean,
  onChange: (
    group: ReaderSettingGroup,
    field: ReaderSettingField,
    value: number | string | boolean,
  ) => void,
) {
  return group.fields.map((field) => {
    const path = `${group.id}.${field.key}`
    const stored = readSettingValue(draft, group.id, field.key)
    return (
      <GlobalSettingField
        key={path}
        group={group}
        field={field}
        value={stored === undefined ? field.defaultValue : stored}
        source={globalSettingSource(saved, group.id, field.key)}
        dirty={globalFieldIsDirty(draft, saved, group.id, field.key)}
        error={fieldErrors[path] ?? null}
        disabled={disabled}
        onChange={onChange}
      />
    )
  })
}

export function GlobalReaderDefaults() {
  const {
    record,
    draft,
    dirty,
    loading,
    loadError,
    status,
    fieldErrors,
    contrastIssue,
    conflict,
    updateField,
    save,
    loadServer,
    keepLocalAndRetry,
    resetToBuiltIn,
    retryLoad,
  } = useGlobalReaderSettings()
  const [format, setFormat] = useState<GlobalReaderFormatId>("epub")
  const saving = status.kind === "saving"
  const savedValue = record?.value ?? {}
  const canSave =
    record !== null &&
    dirty &&
    !saving &&
    conflict === null &&
    Object.keys(fieldErrors).length === 0
  const canReset = record !== null && !saving && !globalValuesEqual(draft, {})

  return (
    <section className="iread-reader-defaults" data-testid="reader-defaults">
      <div className="iread-reader-defaults__header">
        <div>
          <h2 className="iread-settings-section__title">全局阅读默认</h2>
          <p className="iread-settings-note">
            built-in → 全局默认 → 单书覆盖。这里只编辑全局默认，未单独覆盖的书会沿用；
            本页不会自动保存，也不会写入任何单书 overrides。
          </p>
        </div>
        <p
          className="iread-reader-defaults__record"
          data-testid="reader-defaults-record"
        >
          {record === null
            ? "尚未读取"
            : `版本 ${record.revision} · ${formatUpdatedAt(record.updatedAt)}`}
        </p>
      </div>

      {loadError === null ? null : (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>无法读取全局阅读默认</AlertTitle>
          <AlertDescription>
            <p className="iread-query-error__message">{loadError}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={retryLoad}
            >
              重试读取
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <p className="iread-reader-settings__status" role="status">
          正在读取全局阅读默认…
        </p>
      ) : null}

      {contrastIssue === null ? null : (
        <Alert variant="destructive" data-testid="reader-defaults-contrast">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>正文颜色对比度不足</AlertTitle>
          <AlertDescription>
            <p>{contrastIssue.message}</p>
            <p>保存已被阻止；请调整正文背景、文字、链接或选区颜色后重试。</p>
          </AlertDescription>
        </Alert>
      )}

      {conflict === null ? null : (
        <Alert data-testid="reader-defaults-conflict">
          <Info aria-hidden="true" />
          <AlertTitle>全局阅读默认已在另一处更新</AlertTitle>
          <AlertDescription>
            <p>
              服务器当前版本 {conflict.revision} ·{" "}
              {formatUpdatedAt(conflict.updatedAt)}。本机未保存的修改仍在下方保留。
            </p>
            <div
              className="iread-reader-defaults__record-summary"
              data-testid="reader-defaults-conflict-current"
            >
              <CurrentRecordSummary record={conflict} />
            </div>
            <div className="iread-reader-settings__actions">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={loadServer}
              >
                载入服务器设置
              </Button>
              <Button type="button" size="sm" onClick={keepLocalAndRetry}>
                保留本机并重试
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {record === null ? null : (
        <>
          <div className="iread-settings__switcher">
            <Field>
              <FieldLabel htmlFor="reader-default-format">阅读格式</FieldLabel>
              <Select
                value={format}
                onValueChange={(value) =>
                  setFormat(value as GlobalReaderFormatId)
                }
              >
                <SelectTrigger
                  id="reader-default-format"
                  aria-label="阅读格式"
                  className="iread-select-trigger"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GLOBAL_READER_FORMATS.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Tabs
            value={format}
            onValueChange={(value) => setFormat(value as GlobalReaderFormatId)}
            className="iread-reader-defaults__tabs"
          >
            <TabsList
              className="iread-settings__tabs-list"
              aria-label="阅读格式"
            >
              {GLOBAL_READER_FORMATS.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {GLOBAL_READER_FORMATS.map((item) => {
              const group = globalReaderGroup(item.groupId)
              return (
                <TabsContent
                  key={item.id}
                  value={item.id}
                  className="iread-reader-defaults__tab"
                >
                  <p className="iread-reader-settings__group-description">
                    {group.description}
                  </p>
                  <div
                    className="iread-reader-settings__fields"
                    data-reader-format={item.id}
                  >
                    {fieldsForGroup(
                      group,
                      draft,
                      savedValue,
                      fieldErrors,
                      saving,
                      (activeGroup, field, value) =>
                        updateField(activeGroup.id, field, value),
                    )}
                  </div>
                </TabsContent>
              )
            })}
          </Tabs>
        </>
      )}

      {record === null ? null : (
        <div className="iread-reader-settings__footer">
          <p
            className="iread-reader-settings__status"
            role="status"
            aria-live="polite"
            data-testid="reader-defaults-status"
            data-status={status.kind}
          >
            {status.kind === "saved" ? <CheckCircle2 aria-hidden="true" /> : null}
            {status.message}
          </p>
          {dirty ? (
            <p className="iread-reader-defaults__note">
              有未保存的更改；服务器仍保留版本 {record.revision}。
            </p>
          ) : null}
          <div className="iread-reader-settings__actions">
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={() => {
                void save()
              }}
            >
              <Save aria-hidden="true" />
              保存为全局默认
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canReset}
              onClick={resetToBuiltIn}
            >
              <RotateCcw aria-hidden="true" />
              恢复内置默认
            </Button>
          </div>
          <p className="iread-reader-settings__note">
            保存时使用 GET 返回的 revision 作为 baseRevision 进行 CAS 写入；
            若服务器已更新会显示冲突记录，由你选择载入服务器或保留本机后重试。
            “恢复内置默认”只清空全局值，仍需点击保存；不会删除单书覆盖。
          </p>
        </div>
      )}
    </section>
  )
}
