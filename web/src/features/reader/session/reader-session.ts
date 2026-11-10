import type {
  BookFormat,
  BookStatus,
} from "@/features/library/types"

/**
 * 阅读会话的纯状态定义。这里不包含任何引擎缓存或正文资源，
 * 只描述共享 Shell 可观察的会话身份、面板与退出阶段。
 */

export type ReaderPanelId = "toc" | "settings" | null

export type ReaderToolbars = "visible" | "hidden"

export interface ReaderShellState {
  panel: ReaderPanelId
  toolbars: ReaderToolbars
}

export type ReaderShellAction =
  | { type: "open-panel"; panel: Exclude<ReaderPanelId, null> }
  | { type: "close-panel" }
  | { type: "toggle-panel"; panel: Exclude<ReaderPanelId, null> }
  | { type: "show-toolbars" }
  | { type: "hide-toolbars" }
  | { type: "toggle-toolbars" }

export const INITIAL_READER_SHELL_STATE: ReaderShellState = {
  panel: null,
  toolbars: "visible",
}

export function readerShellReducer(
  state: ReaderShellState,
  action: ReaderShellAction,
): ReaderShellState {
  switch (action.type) {
    case "open-panel":
      return state.panel === action.panel
        ? state
        : { ...state, panel: action.panel }
    case "close-panel":
      return state.panel === null ? state : { ...state, panel: null }
    case "toggle-panel":
      return {
        ...state,
        panel: state.panel === action.panel ? null : action.panel,
      }
    case "show-toolbars":
      return state.toolbars === "visible"
        ? state
        : { ...state, toolbars: "visible" }
    case "hide-toolbars":
      return state.toolbars === "hidden"
        ? state
        : { ...state, toolbars: "hidden" }
    case "toggle-toolbars":
      return {
        ...state,
        toolbars: state.toolbars === "visible" ? "hidden" : "visible",
      }
    default:
      return state
  }
}

export type ReaderSessionPhase =
  | "opening"
  | "ready"
  | "unavailable"
  | "error"
  | "disposed"

export interface ReaderSessionIdentity {
  bookId: string
  fileVersion: string
  format: BookFormat
  sessionGeneration: number
}

export interface ReaderBookSummary {
  bookId: string
  title: string
  authors: string[]
  format: BookFormat
  status: BookStatus
}

export type ReaderExitPhase =
  | "idle"
  | "snapshotting"
  | "saving"
  | "local-only"
  | "leaving"

export function nextSessionGeneration(current: number): number {
  return current + 1
}
