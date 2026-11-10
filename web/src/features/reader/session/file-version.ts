const STORAGE_PREFIX = "iread.reader-file-version.v1:"
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function storageKey(bookId: string): string {
  return `${STORAGE_PREFIX}${bookId}`
}

/**
 * 记住最近一次打开的 fileVersion，用于在原件更新后仍能列出旧版本书签。
 * 只保存书籍身份，不保存正文或定位内容。
 */
export function readRememberedFileVersion(bookId: string): string | null {
  try {
    const value = window.localStorage.getItem(storageKey(bookId))
    return value !== null && SHA256_PATTERN.test(value) ? value : null
  } catch {
    return null
  }
}

export function rememberFileVersion(bookId: string, fileVersion: string): boolean {
  if (!SHA256_PATTERN.test(fileVersion)) {
    return false
  }
  try {
    window.localStorage.setItem(storageKey(bookId), fileVersion)
    return true
  } catch {
    return false
  }
}
