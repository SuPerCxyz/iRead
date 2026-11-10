export const LIBRARY_VIEW_MODES = ["grid", "list"] as const
export type LibraryViewMode = (typeof LIBRARY_VIEW_MODES)[number]

export const LIBRARY_DENSITIES = ["compact", "standard", "relaxed"] as const
export type LibraryViewDensity = (typeof LIBRARY_DENSITIES)[number]

export const LIBRARY_COVER_RATIOS = ["original", "2:3", "3:4"] as const
export type LibraryCoverRatio = (typeof LIBRARY_COVER_RATIOS)[number]

export const LIBRARY_COVER_RADII = ["none", "sm", "md", "lg"] as const
export type LibraryCoverRadius = (typeof LIBRARY_COVER_RADII)[number]

export const LIBRARY_CARD_GAPS = ["compact", "standard", "relaxed"] as const
export type LibraryCardGap = (typeof LIBRARY_CARD_GAPS)[number]

export type LibraryColumns =
  | "auto"
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8

export interface LibraryViewValue {
  viewMode: LibraryViewMode
  density: LibraryViewDensity
  columns: LibraryColumns
  showAuthors: boolean
  showProgress: boolean
  showFormat: boolean
  showSubtitle: boolean
  coverRatio: LibraryCoverRatio
  coverRadius: LibraryCoverRadius
  cardGap: LibraryCardGap
}

export interface LibraryViewRecord {
  schemaVersion: 1
  revision: string
  updatedAt: string | null
  value: LibraryViewValue
}

export const DEFAULT_LIBRARY_VIEW: LibraryViewValue = {
  viewMode: "grid",
  density: "standard",
  columns: "auto",
  showAuthors: true,
  showProgress: true,
  showFormat: true,
  showSubtitle: false,
  coverRatio: "original",
  coverRadius: "md",
  cardGap: "standard",
}

const VALUE_KEYS = Object.keys(DEFAULT_LIBRARY_VIEW) as Array<
  keyof LibraryViewValue
>

const DECIMAL_REVISION = /^(?:0|[1-9][0-9]*)$/
const COLUMN_COUNTS = new Set([2, 3, 4, 5, 6, 7, 8])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
}

export function isLibraryColumns(value: unknown): value is LibraryColumns {
  return (
    value === "auto" ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      COLUMN_COUNTS.has(value))
  )
}

export function validateLibraryViewValue(
  input: unknown,
): LibraryViewValue | null {
  if (!isRecord(input)) {
    return null
  }
  const keys = Object.keys(input)
  if (
    keys.length !== VALUE_KEYS.length ||
    keys.some((key) => !VALUE_KEYS.includes(key as keyof LibraryViewValue))
  ) {
    return null
  }
  if (
    !oneOf(input.viewMode, LIBRARY_VIEW_MODES) ||
    !oneOf(input.density, LIBRARY_DENSITIES) ||
    !isLibraryColumns(input.columns) ||
    typeof input.showAuthors !== "boolean" ||
    typeof input.showProgress !== "boolean" ||
    typeof input.showFormat !== "boolean" ||
    typeof input.showSubtitle !== "boolean" ||
    !oneOf(input.coverRatio, LIBRARY_COVER_RATIOS) ||
    !oneOf(input.coverRadius, LIBRARY_COVER_RADII) ||
    !oneOf(input.cardGap, LIBRARY_CARD_GAPS)
  ) {
    return null
  }
  return {
    viewMode: input.viewMode,
    density: input.density,
    columns: input.columns,
    showAuthors: input.showAuthors,
    showProgress: input.showProgress,
    showFormat: input.showFormat,
    showSubtitle: input.showSubtitle,
    coverRatio: input.coverRatio,
    coverRadius: input.coverRadius,
    cardGap: input.cardGap,
  }
}

export function parseLibraryViewRecord(
  input: unknown,
): LibraryViewRecord | null {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    return null
  }
  if (
    typeof input.revision !== "string" ||
    !DECIMAL_REVISION.test(input.revision)
  ) {
    return null
  }
  if (
    input.updatedAt !== null &&
    (typeof input.updatedAt !== "string" ||
      Number.isNaN(Date.parse(input.updatedAt)))
  ) {
    return null
  }
  const value = validateLibraryViewValue(input.value)
  if (value === null) {
    return null
  }
  return {
    schemaVersion: 1,
    revision: input.revision,
    updatedAt: input.updatedAt,
    value,
  }
}

export const LIBRARY_VIEW_MODE_LABELS: Record<LibraryViewMode, string> = {
  grid: "网格",
  list: "列表",
}

export const LIBRARY_DENSITY_LABELS: Record<LibraryViewDensity, string> = {
  compact: "紧凑",
  standard: "标准",
  relaxed: "宽松",
}

export const LIBRARY_COVER_RATIO_LABELS: Record<LibraryCoverRatio, string> = {
  original: "原始比例",
  "2:3": "2:3",
  "3:4": "3:4",
}

export const LIBRARY_COVER_RADIUS_LABELS: Record<LibraryCoverRadius, string> = {
  none: "无圆角",
  sm: "小",
  md: "中",
  lg: "大",
}

export const LIBRARY_CARD_GAP_LABELS: Record<LibraryCardGap, string> = {
  compact: "紧凑",
  standard: "标准",
  relaxed: "宽松",
}

export function libraryColumnsLabel(columns: LibraryColumns): string {
  return columns === "auto" ? "自动" : `${columns} 列`
}
