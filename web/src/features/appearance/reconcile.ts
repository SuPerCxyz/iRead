import type { AppearanceRecord } from "./api"
import type { AppearanceMirror } from "./storage"
import type { AppearanceValue } from "./model"

export type AppearanceReconcileResult =
  | { type: "apply-server"; record: AppearanceRecord }
  | { type: "retry"; record: AppearanceRecord }
  | { type: "conflict"; current: AppearanceRecord }
  | {
      type: "restore-local"
      record: AppearanceRecord
      value: AppearanceValue
      baseRevision: string
    }

function normalizeRevision(revision: string): string {
  return revision.replace(/^0+(?=\d)/, "")
}

export function compareRevisions(first: string, second: string): number {
  const left = normalizeRevision(first)
  const right = normalizeRevision(second)
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1
  }
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

export function isOlderThanConfirmedRevision(
  serverRevision: string,
  confirmedPutRevision: string | null,
): boolean {
  return (
    confirmedPutRevision !== null &&
    compareRevisions(serverRevision, confirmedPutRevision) < 0
  )
}

export function reconcileAppearance(
  server: AppearanceRecord,
  mirror: AppearanceMirror,
): AppearanceReconcileResult {
  if (mirror.pending !== null) {
    if (server.revision === mirror.baseRevision) {
      return { type: "retry", record: server }
    }
    return { type: "conflict", current: server }
  }

  const localRevision = mirror.record?.revision ?? "0"
  if (compareRevisions(server.revision, localRevision) >= 0) {
    return { type: "apply-server", record: server }
  }

  if (mirror.record !== null) {
    return {
      type: "restore-local",
      record: server,
      value: mirror.record.value,
      baseRevision: server.revision,
    }
  }

  return { type: "apply-server", record: server }
}
