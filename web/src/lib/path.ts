export function normalizePathname(pathname: string): string {
  if (pathname === "/") {
    return "/"
  }
  const normalized = pathname.replace(/\/+$/, "")
  return normalized === "" ? "/" : normalized
}

const BOOK_ROUTE = /^\/books\/[^/]+$/
const READER_ROUTE = /^\/read\/[^/]+$/

export function isShellPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname)
  return (
    normalized === "/" ||
    normalized === "/library" ||
    normalized === "/settings" ||
    BOOK_ROUTE.test(normalized) ||
    READER_ROUTE.test(normalized)
  )
}

const RETURN_TO_ORIGIN = "http://iread.invalid"

/**
 * 登录后的返回目标只接受已知站内路由。
 * 拒绝绝对 URL、协议相对地址、反斜杠绕过和未知路径，并移除 returnTo 参数。
 */
export function safeReturnTo(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return fallback
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback
  }

  let parsed: URL
  try {
    parsed = new URL(raw, RETURN_TO_ORIGIN)
  } catch {
    return fallback
  }
  if (parsed.origin !== RETURN_TO_ORIGIN) {
    return fallback
  }
  if (!isShellPath(parsed.pathname)) {
    return fallback
  }

  parsed.searchParams.delete("returnTo")
  const search = parsed.searchParams.toString()
  return `${parsed.pathname}${search.length > 0 ? `?${search}` : ""}${parsed.hash}`
}
