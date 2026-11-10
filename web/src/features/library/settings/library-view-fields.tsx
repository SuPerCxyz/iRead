import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  LIBRARY_CARD_GAPS,
  LIBRARY_CARD_GAP_LABELS,
  LIBRARY_COVER_RADII,
  LIBRARY_COVER_RADIUS_LABELS,
  LIBRARY_COVER_RATIOS,
  LIBRARY_COVER_RATIO_LABELS,
  LIBRARY_DENSITIES,
  LIBRARY_DENSITY_LABELS,
  LIBRARY_VIEW_MODES,
  LIBRARY_VIEW_MODE_LABELS,
  libraryColumnsLabel,
  type LibraryColumns,
  type LibraryViewValue,
} from "../settings/model"

const COLUMN_OPTIONS: LibraryColumns[] = [
  "auto",
  2,
  3,
  4,
  5,
  6,
  7,
  8,
]

interface LibraryViewFieldsProps {
  value: LibraryViewValue
  onChange: (patch: Partial<LibraryViewValue>) => void
  idPrefix: string
  disabled?: boolean
}

export function LibraryViewFields({
  value,
  onChange,
  idPrefix,
  disabled = false,
}: LibraryViewFieldsProps) {
  const viewId = `${idPrefix}-view-mode`
  const densityId = `${idPrefix}-density`
  const columnsId = `${idPrefix}-columns`
  const ratioId = `${idPrefix}-cover-ratio`
  const radiusId = `${idPrefix}-cover-radius`
  const gapId = `${idPrefix}-card-gap`

  return (
    <div className="iread-library-view-fields">
      <Field>
        <FieldLabel htmlFor={viewId}>视图模式</FieldLabel>
        <Select
          value={value.viewMode}
          disabled={disabled}
          onValueChange={(next) => {
            onChange({ viewMode: next as LibraryViewValue["viewMode"] })
          }}
        >
          <SelectTrigger id={viewId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIBRARY_VIEW_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {LIBRARY_VIEW_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>当前：{LIBRARY_VIEW_MODE_LABELS[value.viewMode]}</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={densityId}>卡片密度</FieldLabel>
        <Select
          value={value.density}
          disabled={disabled}
          onValueChange={(next) => {
            onChange({ density: next as LibraryViewValue["density"] })
          }}
        >
          <SelectTrigger id={densityId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIBRARY_DENSITIES.map((density) => (
              <SelectItem key={density} value={density}>
                {LIBRARY_DENSITY_LABELS[density]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          当前：{LIBRARY_DENSITY_LABELS[value.density]}；影响卡片内文字与间距密度。
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={columnsId}>网格列数</FieldLabel>
        <Select
          value={String(value.columns)}
          disabled={disabled}
          onValueChange={(next) => {
            onChange({
              columns:
                next === "auto" ? "auto" : (Number(next) as LibraryColumns),
            })
          }}
        >
          <SelectTrigger id={columnsId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLUMN_OPTIONS.map((columns) => (
              <SelectItem key={String(columns)} value={String(columns)}>
                {libraryColumnsLabel(columns)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          当前：{libraryColumnsLabel(value.columns)}；桌面允许 2–8
          列，手机会限制为 2–3 列。
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={ratioId}>封面比例</FieldLabel>
        <Select
          value={value.coverRatio}
          disabled={disabled}
          onValueChange={(next) => {
            onChange({ coverRatio: next as LibraryViewValue["coverRatio"] })
          }}
        >
          <SelectTrigger id={ratioId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIBRARY_COVER_RATIOS.map((ratio) => (
              <SelectItem key={ratio} value={ratio}>
                {LIBRARY_COVER_RATIO_LABELS[ratio]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          当前：{LIBRARY_COVER_RATIO_LABELS[value.coverRatio]}；原始比例缺少尺寸时按
          2:3 显示。
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={radiusId}>封面圆角</FieldLabel>
        <Select
          value={value.coverRadius}
          disabled={disabled}
          onValueChange={(next) => {
            onChange({ coverRadius: next as LibraryViewValue["coverRadius"] })
          }}
        >
          <SelectTrigger id={radiusId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIBRARY_COVER_RADII.map((radius) => (
              <SelectItem key={radius} value={radius}>
                {LIBRARY_COVER_RADIUS_LABELS[radius]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          当前：{LIBRARY_COVER_RADIUS_LABELS[value.coverRadius]}。
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={gapId}>卡片间距</FieldLabel>
        <Select
          value={value.cardGap}
          disabled={disabled}
          onValueChange={(next) => {
            onChange({ cardGap: next as LibraryViewValue["cardGap"] })
          }}
        >
          <SelectTrigger id={gapId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIBRARY_CARD_GAPS.map((gap) => (
              <SelectItem key={gap} value={gap}>
                {LIBRARY_CARD_GAP_LABELS[gap]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          当前：{LIBRARY_CARD_GAP_LABELS[value.cardGap]}；同时作用于网格与列表。
        </FieldDescription>
      </Field>

      <div className="iread-library-view-fields__toggles">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${idPrefix}-show-authors`}>
              显示作者
            </FieldLabel>
            <FieldDescription>隐藏后仍保留书名与详情入口。</FieldDescription>
          </FieldContent>
          <Switch
            id={`${idPrefix}-show-authors`}
            checked={value.showAuthors}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({ showAuthors: checked })
            }}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${idPrefix}-show-progress`}>
              显示阅读进度
            </FieldLabel>
            <FieldDescription>仅对有真实进度的图书显示百分比。</FieldDescription>
          </FieldContent>
          <Switch
            id={`${idPrefix}-show-progress`}
            checked={value.showProgress}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({ showProgress: checked })
            }}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${idPrefix}-show-format`}>
              显示格式
            </FieldLabel>
            <FieldDescription>显示 EPUB、PDF、CBZ 或 CBR 标记。</FieldDescription>
          </FieldContent>
          <Switch
            id={`${idPrefix}-show-format`}
            checked={value.showFormat}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({ showFormat: checked })
            }}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${idPrefix}-show-subtitle`}>
              显示副标题
            </FieldLabel>
            <FieldDescription>
              仅在书库列表返回副标题时显示；当前服务未在列表 DTO
              中提供副标题，开启后对现有图书无可见变化。
            </FieldDescription>
          </FieldContent>
          <Switch
            id={`${idPrefix}-show-subtitle`}
            checked={value.showSubtitle}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({ showSubtitle: checked })
            }}
          />
        </Field>
      </div>
    </div>
  )
}
