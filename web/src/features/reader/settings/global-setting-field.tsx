import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

import {
  formatSettingValue,
  settingDisplayValue,
  settingSourceLabel,
  type ReaderSettingField,
  type ReaderSettingGroup,
} from "../shell/settings-model"
import { ReaderSlider as Slider } from "../shell/reader-slider"
import {
  settingRangeDescription,
  type GlobalSettingSource,
} from "./global-settings-model"

interface GlobalSettingFieldProps {
  group: ReaderSettingGroup
  field: ReaderSettingField
  value: unknown
  source: GlobalSettingSource
  dirty: boolean
  error: string | null
  disabled: boolean
  onChange: (group: ReaderSettingGroup, field: ReaderSettingField, value: number | string | boolean) => void
}

function GlobalColorControl({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: ReaderSettingField["options"]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [input, setInput] = useState({
    source: value,
    text: value.startsWith("#") ? value : "",
  })
  const custom =
    input.source === value ? input.text : value.startsWith("#") ? value : ""
  const invalid = custom !== "" && !/^#[0-9a-f]{6}$/.test(custom)
  const selected = value.startsWith("#")
    ? "custom"
    : value === "auto"
      ? "inherit"
      : value

  return (
    <div className="iread-reader-settings__color">
      <Select
        value={selected}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== "custom") {
            setInput({ source: next, text: "" })
            onChange(next)
          }
        }}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options?.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
          <SelectItem value="custom">自定义颜色</SelectItem>
        </SelectContent>
      </Select>
      <Input
        aria-label={`${label}自定义颜色`}
        placeholder="#rrggbb"
        value={custom}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(event) => {
          const text = event.target.value.toLowerCase()
          setInput({ source: value, text })
          if (/^#[0-9a-f]{6}$/.test(text)) {
            onChange(text)
          }
        }}
      />
      {invalid ? (
        <p role="alert" className="iread-reader-settings__description">
          请输入完整的六位颜色；未应用此输入。
        </p>
      ) : null}
    </div>
  )
}

function controlForField(
  props: GlobalSettingFieldProps,
  id: string,
  display: number | string | boolean,
) {
  const { field, disabled, onChange, group } = props
  if (field.control === "color") {
    return (
      <GlobalColorControl
        key={`${group.id}.${field.key}`}
        id={id}
        label={field.label}
        value={String(display)}
        options={field.options}
        disabled={disabled}
        onChange={(next) => onChange(group, field, next)}
      />
    )
  }
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
            onChange(group, field, next)
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
        onCheckedChange={(next) => onChange(group, field, next)}
      />
    )
  }
  return (
    <Select
      value={String(display)}
      disabled={disabled}
      onValueChange={(next) => onChange(group, field, next)}
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

export function GlobalSettingField(props: GlobalSettingFieldProps) {
  const { group, field, value, source, dirty, error } = props
  const id = `reader-default-${group.id}-${field.key}`
  const display = settingDisplayValue(field, value)
  const range = settingRangeDescription(field)

  return (
    <Field
      className="iread-reader-settings__field"
      data-setting-path={`${group.id}.${field.key}`}
    >
      <div className="iread-reader-settings__field-head">
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <div className="iread-reader-defaults__badges">
          <Badge variant={source === "global" ? "secondary" : "outline"} data-source={source}>
            {settingSourceLabel(source)}
          </Badge>
          {dirty ? <Badge variant="outline" data-pending="true">未保存</Badge> : null}
        </div>
      </div>
      <div className="iread-reader-settings__control">
        {controlForField(props, id, display)}
        {field.control === "color" ? null : (
          <span className="iread-reader-settings__value">
            {formatSettingValue(field, value)}
          </span>
        )}
      </div>
      <FieldDescription className="iread-reader-settings__description">
        {field.description}
        {range === null ? "" : ` · ${range}`}
      </FieldDescription>
      {error === null ? null : <FieldError>{error}</FieldError>}
    </Field>
  )
}
