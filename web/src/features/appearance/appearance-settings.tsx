import { Info } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { LabeledSlider } from "@/components/app/labeled-slider"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"

import { useAppearance } from "./context"
import { evaluateCustomAccent } from "./color"
import {
  DARK_PRESETS,
  DENSITIES,
  LIGHT_PRESETS,
  THEME_MODES,
  buttonSizeForDensity,
  isHexAccent,
  type DarkPreset,
  type Density,
  type LightPreset,
  type ThemeMode,
} from "./model"

const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
}

const LIGHT_PRESET_LABELS: Record<LightPreset, string> = {
  template: "模板默认",
  paper: "暖纸",
  white: "纯白",
}

const DARK_PRESET_LABELS: Record<DarkPreset, string> = {
  template: "模板默认",
  gray: "深灰",
  midnight: "深蓝黑",
}

const DENSITY_LABELS: Record<Density, string> = {
  compact: "紧凑",
  standard: "标准",
  relaxed: "宽松",
}

const THEME_MODE_ARROW_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
])

type AccentMode = "default" | "blue" | "green" | "custom"

interface AccentEditState {
  sourceAccent: string
  mode: AccentMode
  draft: string
  error: string | null
}

function accentModeOf(accent: string): AccentMode {
  if (accent === "blue" || accent === "green" || accent === "default") {
    return accent
  }
  return "custom"
}

function createAccentEditState(accent: string): AccentEditState {
  return {
    sourceAccent: accent,
    mode: accentModeOf(accent),
    draft: isHexAccent(accent) ? accent : "",
    error: null,
  }
}

export function AppearanceSettings() {
  const {
    value,
    resolvedMode,
    update,
    reset,
    status,
    statusText,
    online,
    storageUnavailable,
    saveError,
    loadError,
    conflict,
    retry,
    loadServerSettings,
    keepLocalAndResave,
  } = useAppearance()
  const [accentEdit, setAccentEdit] = useState<AccentEditState>(() =>
    createAccentEditState(value.accent),
  )

  // 外部载入服务器设置/恢复默认时，在渲染期同步编辑控件。
  if (accentEdit.sourceAccent !== value.accent) {
    setAccentEdit(createAccentEditState(value.accent))
  }

  const { mode: accentMode, draft: customDraft, error: customError } =
    accentEdit

  const isAutoWidth = value.contentWidth === "auto"
  const widthPercent =
    typeof value.contentWidth === "number" ? value.contentWidth : 100
  const lightPresetActive = resolvedMode === "light"
  const darkPresetActive = resolvedMode === "dark"

  const themeModeRef = useRef(value.themeMode)
  useEffect(() => {
    themeModeRef.current = value.themeMode
  }, [value.themeMode])

  const selectThemeMode = (mode: ThemeMode) => {
    if (themeModeRef.current === mode) {
      return
    }
    themeModeRef.current = mode
    update({ themeMode: mode })
  }

  // Radix 1.5.1 在方向键事件中用 setTimeout 移动焦点；这里再排队一拍，
  // 读取最终获得焦点的选项并选中，保证方向键同时移动焦点与选中项。
  const handleThemeModeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      !THEME_MODE_ARROW_KEYS.has(event.key) ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !event.defaultPrevented
    ) {
      return
    }
    const group = event.currentTarget
    window.setTimeout(() => {
      if (!group.isConnected) {
        return
      }
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !group.contains(active)) {
        return
      }
      const nextMode = active.dataset.value
      if (
        nextMode === undefined ||
        !(THEME_MODES as readonly string[]).includes(nextMode)
      ) {
        return
      }
      selectThemeMode(nextMode as ThemeMode)
    }, 0)
  }

  const handleLightPreset = (preset: string) => {
    const lightPreset = preset as LightPreset
    update({
      lightPreset,
      themeMode: lightPreset === "template" ? value.themeMode : "light",
    })
  }

  const handleDarkPreset = (preset: string) => {
    const darkPreset = preset as DarkPreset
    update({
      darkPreset,
      themeMode: darkPreset === "template" ? value.themeMode : "dark",
    })
  }

  const handleAccentMode = (mode: string) => {
    const nextMode = mode as AccentMode
    if (nextMode === "custom") {
      setAccentEdit((current) => ({
        ...current,
        mode: "custom",
        draft: isHexAccent(value.accent) ? value.accent : "",
        error: null,
      }))
      return
    }

    setAccentEdit((current) => ({
      ...current,
      mode: nextMode,
      draft: "",
      error: null,
    }))
    update({ accent: nextMode })
  }

  const handleCustomAccent = (raw: string) => {
    setAccentEdit((current) => ({ ...current, draft: raw }))
    const evaluation = evaluateCustomAccent(raw)
    if (evaluation.ok) {
      setAccentEdit((current) => ({
        ...current,
        mode: "custom",
        error: null,
      }))
      update({ accent: evaluation.color })
      return
    }
    setAccentEdit((current) => ({
      ...current,
      error: evaluation.message,
    }))
  }

  const handleReset = () => {
    reset()
    setAccentEdit(createAccentEditState("default"))
  }

  const accentCurrent =
    value.accent === "default"
      ? "默认"
      : value.accent === "blue"
        ? "蓝色"
        : value.accent === "green"
          ? "绿色"
          : value.accent

  return (
    <div className="iread-appearance">
      <div className="iread-appearance__sync">
        <p
          className="iread-appearance__status"
          role="status"
          aria-live="polite"
        >
          {statusText}
        </p>
        {online ? null : (
          <p className="iread-appearance__hint">
            当前离线：更改会保留在本机，联网后自动重试。
          </p>
        )}
        {storageUnavailable ? (
          <Alert variant="destructive">
            <Info aria-hidden="true" />
            <AlertTitle>未能写入本机</AlertTitle>
            <AlertDescription>
              浏览器本地存储不可用；本次更改仍会尝试保存到本机服务。
            </AlertDescription>
          </Alert>
        ) : null}
        {loadError === null ? null : (
          <Alert variant="destructive">
            <Info aria-hidden="true" />
            <AlertTitle>无法读取本机服务</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {saveError === null ? null : (
          <Alert variant="destructive">
            <Info aria-hidden="true" />
            <AlertTitle>未能保存到服务器</AlertTitle>
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}
        {status === "pending" || status === "error" ? (
          <div>
            <Button
              type="button"
              size={buttonSizeForDensity(value.density)}
              variant="outline"
              onClick={retry}
            >
              重试
            </Button>
          </div>
        ) : null}
      </div>

      <FieldSet>
        <FieldLegend>主题</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel id="theme-mode-label">主题模式</FieldLabel>
            <RadioGroup
              aria-labelledby="theme-mode-label"
              value={value.themeMode}
              onKeyDown={handleThemeModeKeyDown}
              onValueChange={(mode) => {
                selectThemeMode(mode as ThemeMode)
              }}
            >
              {THEME_MODES.map((mode) => (
                <Field key={mode} orientation="horizontal">
                  <RadioGroupItem
                    id={`theme-mode-${mode}`}
                    value={mode}
                    data-value={mode}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`theme-mode-${mode}`}>
                      {THEME_MODE_LABELS[mode]}
                    </FieldLabel>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
            <FieldDescription>
              当前：{THEME_MODE_LABELS[value.themeMode]}（解析为
              {resolvedMode === "dark" ? "深色" : "浅色"}）。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="light-preset">浅色预设</FieldLabel>
            <Select
              value={value.lightPreset}
              onValueChange={handleLightPreset}
            >
              <SelectTrigger id="light-preset" className="iread-select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIGHT_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {LIGHT_PRESET_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              当前：{LIGHT_PRESET_LABELS[value.lightPreset]}。
              {lightPresetActive
                ? "正在生效。"
                : "当前为深色模式，此预设将在浅色模式下生效。"}
              选择暖纸或纯白会切换到浅色。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="dark-preset">深色预设</FieldLabel>
            <Select
              value={value.darkPreset}
              onValueChange={handleDarkPreset}
            >
              <SelectTrigger id="dark-preset" className="iread-select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DARK_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {DARK_PRESET_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              当前：{DARK_PRESET_LABELS[value.darkPreset]}。
              {darkPresetActive
                ? "正在生效。"
                : "当前为浅色模式，此预设将在深色模式下生效。"}
              选择深灰或深蓝黑会切换到深色。
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      <Separator />

      <FieldSet>
        <FieldLegend>强调色与密度</FieldLegend>
        <FieldGroup>
          <Field data-invalid={customError === null ? undefined : true}>
            <FieldLabel htmlFor="accent">强调色</FieldLabel>
            <Select value={accentMode} onValueChange={handleAccentMode}>
              <SelectTrigger id="accent" className="iread-select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">默认</SelectItem>
                <SelectItem value="blue">蓝色</SelectItem>
                <SelectItem value="green">绿色</SelectItem>
                <SelectItem value="custom">自定义颜色</SelectItem>
              </SelectContent>
            </Select>
            {accentMode === "custom" ? (
              <Input
                aria-describedby="accent-description"
                aria-invalid={customError === null ? undefined : true}
                aria-label="自定义强调色"
                autoComplete="off"
                id="custom-accent"
                inputMode="text"
                maxLength={7}
                placeholder="输入六位十六进制颜色"
                spellCheck={false}
                value={customDraft}
                onChange={(event) => {
                  handleCustomAccent(event.target.value)
                }}
              />
            ) : null}
            <FieldError>{customError}</FieldError>
            <FieldDescription id="accent-description">
              当前：{accentCurrent}。
              {accentMode === "custom"
                ? "自定义颜色需与白色和近黑背景均达到 3:1，文字对比度至少 4.5:1。"
                : "使用固定主题源中的强调色。"}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="density">界面密度</FieldLabel>
            <Select
              value={value.density}
              onValueChange={(density) => {
                update({ density: density as Density })
              }}
            >
              <SelectTrigger id="density" className="iread-select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DENSITIES.map((density) => (
                  <SelectItem key={density} value={density}>
                    {DENSITY_LABELS[density]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              当前：{DENSITY_LABELS[value.density]}。使用官方按钮尺寸与页面间距档位。
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      <Separator />

      <FieldSet>
        <FieldLegend>布局</FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="content-width-auto">自动内容宽度</FieldLabel>
              <FieldDescription>
                当前：{isAutoWidth ? "自动（随视口）" : `${widthPercent}%`}。
              </FieldDescription>
            </FieldContent>
            <Switch
              id="content-width-auto"
              checked={isAutoWidth}
              onCheckedChange={(checked) => {
                update({ contentWidth: checked ? "auto" : 100 })
              }}
            />
          </Field>

          <Field data-disabled={isAutoWidth ? true : undefined}>
            <FieldLabel htmlFor="content-width">页面宽度</FieldLabel>
            <LabeledSlider
              label="页面宽度"
              descriptionId="content-width-description"
              disabled={isAutoWidth}
              id="content-width"
              min={50}
              max={100}
              step={1}
              value={[widthPercent]}
              onValueChange={(next) => {
                update({ contentWidth: next[0] ?? 100 })
              }}
            />
            <FieldDescription id="content-width-description">
              当前：{isAutoWidth ? "自动" : `${widthPercent}%`}。范围 50–100%，不会超过视口。
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="nav-compact">紧凑导航</FieldLabel>
              <FieldDescription>
                当前：{value.navCompact ? "开启" : "关闭"}。只压缩导航组间距，不改变官方侧栏宽度。
              </FieldDescription>
            </FieldContent>
            <Switch
              id="nav-compact"
              checked={value.navCompact}
              onCheckedChange={(checked) => {
                update({ navCompact: checked })
              }}
            />
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="iread-appearance__actions">
        <Button
          type="button"
          size={buttonSizeForDensity(value.density)}
          variant="outline"
          onClick={handleReset}
        >
          恢复外观默认
        </Button>
      </div>

      <AlertDialog open={conflict !== null}>
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            event.preventDefault()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>设置已在另一处更新</AlertDialogTitle>
            <AlertDialogDescription>
              服务器上的外观设置已有更新，本机还有未同步的选择。影响范围：主题模式、浅色与深色预设、强调色、密度、内容宽度和导航紧凑度。
              “载入服务器设置”会放弃本机未同步更改；“保留本机选择并重新保存”会用服务器
              revision 作为新的基线重新保存，并覆盖服务器当前版本。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={loadServerSettings}>
              载入服务器设置
            </AlertDialogCancel>
            <AlertDialogAction onClick={keepLocalAndResave}>
              保留本机选择并重新保存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
