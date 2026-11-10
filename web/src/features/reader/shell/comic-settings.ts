import {
  comicSettingsFromEffective,
  normalizeComicSettings,
  type ComicReaderSettings,
} from "../comic"

const COMIC_KEYS = [
  "direction",
  "mode",
  "fit",
  "gap",
  "background",
] as const

/**
 * 合并服务端 effectiveValues 与设置面板的未保存字段。
 * 只读取 comic 分组，其他格式的字段不会串到漫画引擎。
 */
export function comicSettingsPatch(
  effectiveValues: unknown,
  pending: Record<string, unknown>,
): ComicReaderSettings {
  const base = normalizeComicSettings(
    comicSettingsFromEffective(effectiveValues) ?? {},
  )
  const patch: Partial<ComicReaderSettings> = {}
  for (const key of COMIC_KEYS) {
    const value = pending[`comic.${key}`]
    if (typeof value === "string") {
      Object.assign(patch, { [key]: value })
    }
  }
  return normalizeComicSettings({ ...base, ...patch })
}

export function comicSettingsKey(settings: ComicReaderSettings): string {
  return JSON.stringify(settings)
}
