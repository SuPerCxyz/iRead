export interface NavigationSourceState {
  from: string
  scrollY: number
}

function isInternalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//")
}

export function readSourceState(state: unknown): NavigationSourceState | null {
  if (typeof state !== "object" || state === null) {
    return null
  }

  const candidate = state as Record<string, unknown>
  if (
    typeof candidate.from !== "string" ||
    !isInternalPath(candidate.from) ||
    typeof candidate.scrollY !== "number" ||
    !Number.isFinite(candidate.scrollY) ||
    candidate.scrollY < 0
  ) {
    return null
  }

  return {
    from: candidate.from,
    scrollY: candidate.scrollY,
  }
}

export function returnLabel(target: string): string {
  if (target === "/") {
    return "返回首页"
  }
  if (target === "/library") {
    return "返回书库"
  }
  return "返回上一页"
}
