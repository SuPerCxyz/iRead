import type { BookReaderOverrides } from "../types"
import { mergeBookOverrides, readSettingValue } from "./settings-model"

type Values = Record<string, unknown>
export interface SettingsDraftState {
  values: Values
  promotion: Values
  reset: boolean
  baseRevision: string | null
  globalValue: Values
  status: "idle" | "pending" | "saving" | "saved" | "error" | "conflict"
  message: string
  localSaved: boolean
  error: unknown
}
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface Options {
  key: string
  storage: StorageLike | null
  save: (baseRevision: string, overrides: ReturnType<typeof mergeBookOverrides>) => Promise<BookReaderOverrides>
  onSaved: (record: BookReaderOverrides) => void
}
const empty = (): SettingsDraftState => ({ values: {}, promotion: {}, reset: false, baseRevision: null, globalValue: {}, status: "idle", message: "本书更改将自动保存；全局默认仅在明确操作时修改。", localSaved: true, error: null })
function values(value: unknown): Values {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => /^(reflow|pdf|comic)\.[a-zA-Z]+$/.test(key) && (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))))
}
export class ReaderSettingsDraft {
  private state = empty()
  private record: BookReaderOverrides | undefined
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private flight: Promise<BookReaderOverrides | undefined> | null = null
  private generation = 0
  private disposed = false
  private owner = `${Date.now()}-${Math.random()}`
  private options: Options
  constructor(options: Options) {
    this.options = options
    try {
      const raw = options.storage?.getItem(options.key)
      if (raw) {
        const stored = JSON.parse(raw)
        if (stored.schemaVersion === 1) {
          this.state = { ...empty(), values: values(stored.values), promotion: values(stored.promotion), reset: stored.reset === true, baseRevision: typeof stored.baseRevision === "string" && /^\d+$/.test(stored.baseRevision) ? stored.baseRevision : null, globalValue: stored.globalValue ?? {}, status: stored.conflict === true ? "conflict" : stored.reset === true || Object.keys(values(stored.values)).length ? "pending" : "saved", message: stored.reset === true || Object.keys(values(stored.values)).length ? "已恢复本机阅读设置，等待服务器确认。" : "当前没有待同步的本书更改。" }
        }
      }
    } catch { this.state.localSaved = false; this.state.message = "无法读取本机设置草稿。" }
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private pending() { return this.state.reset || Object.keys(this.state.values).length > 0 }
  private emit() { this.state = { ...this.state }; for (const f of this.listeners) f() }
  private persist(claim = false) {
    try {
      if (this.options.storage === null) throw Error("storage unavailable")
      const existing = JSON.parse(this.options.storage.getItem(this.options.key) || "{}")
      if (!claim && existing.owner && existing.owner !== this.owner) return
      this.options.storage.setItem(this.options.key, JSON.stringify({ owner: this.owner, schemaVersion: 1, values: this.state.values, promotion: this.state.promotion, reset: this.state.reset, baseRevision: this.state.baseRevision, globalValue: this.state.globalValue, conflict: this.state.status === "conflict" }))
      this.state.localSaved = true
    } catch { this.state.localSaved = false }
  }
  configure(record: BookReaderOverrides | undefined, globalValue?: Values) {
    if (record && (!this.record || BigInt(record.revision) >= BigInt(this.record.revision))) this.record = record
    if (this.state.baseRevision === null && this.record) this.state.baseRevision = this.record.revision
    if (globalValue) this.state.globalValue = globalValue
    if (this.record && !this.state.reset && this.pending() && Object.entries(this.state.values).every(([path, value]) => { const [group, key] = path.split("."); return readSettingValue(this.record?.overrides, group as "reflow" | "pdf" | "comic", key) === value })) {
      this.state.values = {}; this.state.baseRevision = this.record.revision; this.state.status = "saved"; this.state.message = "本书设置已保存到服务器。"; this.persist()
    }
    this.emit()
    if (this.pending() && this.state.status !== "conflict" && this.state.status !== "error") this.schedule()
  }
  change = (next: Values) => {
    const conflicted = this.state.status === "conflict"
    if (!this.pending()) this.state.baseRevision = this.record?.revision ?? this.state.baseRevision
    this.state.values = { ...next }
    this.state.promotion = { ...this.state.promotion, ...next }
    this.state.error = null
    this.state.status = conflicted ? "conflict" : "pending"
    this.state.message = conflicted ? "本机更改已保留，请先处理服务器版本冲突。" : "本书更改已在本机预览，正在等待自动保存。"
    this.persist(true); this.emit()
    if (!conflicted) this.schedule()
  }
  private schedule() {
    clearTimeout(this.timer)
    if (!this.disposed) this.timer = setTimeout(() => { void this.flush().catch(() => {}) }, 350)
  }
  flush = async (baseRevisionOverride?: string): Promise<BookReaderOverrides | undefined> => {
    clearTimeout(this.timer)
    while (this.flight) await this.flight.catch(() => {})
    if (!this.record || !this.pending()) return this.record
    const captured = { ...this.state.values }, resetting = this.state.reset, generation = this.generation
    const baseRevision = baseRevisionOverride ?? this.state.baseRevision ?? this.record.revision
    const body = mergeBookOverrides(resetting ? {} : this.record.overrides, captured)
    this.state.status = "saving"; this.state.error = null; this.state.message = "正在自动保存本书设置…"; this.emit()
    const run = async () => {
      try {
        const updated = await this.options.save(baseRevision, body)
        if (!this.record || BigInt(updated.revision) >= BigInt(this.record.revision)) {
          this.record = updated; this.state.baseRevision = updated.revision; this.options.onSaved(updated)
        }
        if (generation === this.generation) {
          const rest = { ...this.state.values }
          for (const [key, value] of Object.entries(captured)) if (rest[key] === value) delete rest[key]
          this.state.values = rest
          if (resetting) this.state.reset = false
        }
        this.state.status = this.pending() ? "pending" : "saved"
        this.state.message = this.pending() ? "正在保存后续本书更改…" : "本书设置已自动保存到服务器。"
        this.persist(); this.emit()
        return updated
      } catch (error) {
        const conflict = typeof error === "object" && error !== null && "status" in error && error.status === 409
        this.state.status = conflict ? "conflict" : "error"; this.state.error = error
        this.state.message = conflict ? "本书设置已在另一处更新；本机更改保留，未覆盖服务器。" : "本书设置未同步到服务器；本机草稿将等待重试。"
        this.persist(); this.emit(); throw error
      }
    }
    this.flight = run()
    try { return await this.flight } finally {
      this.flight = null
      if (this.pending() && this.snapshot().status === "pending") this.schedule()
    }
  }
  reset = async (baseRevisionOverride?: string) => {
    clearTimeout(this.timer); this.generation += 1
    this.state.values = {}; this.state.promotion = {}; this.state.reset = true
    this.state.baseRevision = baseRevisionOverride ?? this.record?.revision ?? this.state.baseRevision
    this.state.status = "pending"; this.persist(true); this.emit()
    return this.flush()
  }
  acknowledgePromotion = (submitted: Values) => {
    const next = { ...this.state.promotion }
    for (const [key, value] of Object.entries(submitted)) if (next[key] === value) delete next[key]
    this.state.promotion = next; this.persist(); this.emit()
  }
  waitForFlight = async () => { clearTimeout(this.timer); await this.flight?.catch(() => {}) }
  discard = (record: BookReaderOverrides) => {
    this.generation += 1; this.record = record
    this.state = { ...empty(), globalValue: this.state.globalValue, baseRevision: record.revision, message: "已载入服务器设置，本机待保存值已放弃。" }
    this.persist(); this.emit()
  }
  activate() { this.disposed = false; this.persist(true); if (this.pending() && this.state.status !== "conflict") this.schedule() }
  dispose() { this.disposed = true; clearTimeout(this.timer) }
}
