import { describeApiError, shouldShowLogin } from "../errors"
import {
  fetchLibrarySettings,
  librarySettingsConflict,
  librarySettingsFieldError,
  LibrarySettingsProtocolError,
  putLibrarySettings,
} from "./api"
import {
  DEFAULT_LIBRARY_VIEW,
  type LibraryViewRecord,
  type LibraryViewValue,
} from "./model"

export type LibrarySettingsStatus =
  | "loading"
  | "saved"
  | "pending"
  | "saving"
  | "conflict"
  | "error"

export interface LibraryViewSnapshot {
  status: LibrarySettingsStatus
  value: LibraryViewValue
  record: LibraryViewRecord | null
  conflict: LibraryViewRecord | null
  saveError: string | null
  loadError: string | null
  fieldError: { field: string; message: string } | null
}

export interface LibraryViewActions {
  update: (patch: Partial<LibraryViewValue>) => void
  retry: () => void
  loadServerSettings: () => void
  keepLocalAndResave: () => void
}

export type LibraryViewStore = LibraryViewSnapshot & LibraryViewActions

const SAVE_DEBOUNCE_MS = 400

const INITIAL_SNAPSHOT: LibraryViewSnapshot = {
  status: "loading",
  value: DEFAULT_LIBRARY_VIEW,
  record: null,
  conflict: null,
  saveError: null,
  loadError: null,
  fieldError: null,
}

let snapshot: LibraryViewSnapshot = INITIAL_SNAPSHOT
let listeners = new Set<() => void>()
let loadPromise: Promise<void> | null = null
let loaded = false
let blocked = false
let inFlight = false
let queued = false
let seq = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null

function emit(next: LibraryViewSnapshot): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

function clearSaveTimer(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

function currentStatus(): LibrarySettingsStatus {
  return snapshot.status
}

function scheduleFlush(delay = SAVE_DEBOUNCE_MS): void {
  clearSaveTimer()
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flush()
  }, delay)
}

function errorText(error: unknown): string {
  if (error instanceof LibrarySettingsProtocolError) {
    return error.message
  }
  return describeApiError(error, {
    fallback: "无法保存书库视图设置，请稍后重试。",
  })
}

async function ensureLoaded(): Promise<void> {
  if (loaded || loadPromise !== null) {
    return loadPromise ?? Promise.resolve()
  }
  loadPromise = (async () => {
    emit({ ...snapshot, status: "loading", loadError: null })
    try {
      const record = await fetchLibrarySettings()
      loaded = true
      if (seq > 0) {
        emit({
          ...snapshot,
          status: "pending",
          record,
          value: snapshot.value,
        })
        scheduleFlush(0)
      } else {
        emit({
          ...snapshot,
          status: "saved",
          record,
          value: record.value,
          loadError: null,
        })
      }
    } catch (error) {
      const login = shouldShowLogin(error)
      emit({
        ...snapshot,
        status: "error",
        loadError: login ? null : errorText(error),
      })
    } finally {
      loadPromise = null
    }
  })()
  return loadPromise
}

async function flush(): Promise<void> {
  if (inFlight) {
    queued = true
    return
  }
  if (blocked || snapshot.status === "conflict") {
    return
  }
  if (snapshot.record === null) {
    await ensureLoaded()
    if (snapshot.record === null) {
      return
    }
  }
  const record = snapshot.record
  if (record === null) {
    return
  }

  clearSaveTimer()
  inFlight = true
  const sendingSeq = seq
  emit({
    ...snapshot,
    status: "saving",
    saveError: null,
    fieldError: null,
  })

  try {
    const saved = await putLibrarySettings(record.revision, snapshot.value)
    loaded = true
    if (sendingSeq === seq && currentStatus() !== "conflict") {
      emit({
        ...snapshot,
        status: "saved",
        record: saved,
        value: saved.value,
        saveError: null,
        fieldError: null,
      })
    } else {
      emit({
        ...snapshot,
        status: "pending",
        record: saved,
        value: snapshot.value,
      })
    }
  } catch (error) {
    const conflict = librarySettingsConflict(error)
    if (conflict !== null) {
      blocked = true
      clearSaveTimer()
      emit({
        ...snapshot,
        status: "conflict",
        conflict,
        saveError: null,
        fieldError: null,
      })
    } else {
      const login = shouldShowLogin(error)
      emit({
        ...snapshot,
        status: "error",
        saveError: login ? null : errorText(error),
        fieldError: librarySettingsFieldError(error),
      })
    }
  } finally {
    inFlight = false
    if (
      queued &&
      !blocked &&
      currentStatus() !== "conflict" &&
      currentStatus() !== "error"
    ) {
      queued = false
      scheduleFlush(0)
    } else {
      queued = false
    }
  }
}

function update(patch: Partial<LibraryViewValue>): void {
  const value = { ...snapshot.value, ...patch }
  seq += 1
  if (snapshot.status === "conflict") {
    emit({ ...snapshot, value })
    return
  }
  blocked = false
  emit({
    ...snapshot,
    value,
    status: "pending",
    saveError: null,
    fieldError: null,
  })
  scheduleFlush()
}

export function retry(): void {
  if (snapshot.status === "conflict") {
    return
  }
  blocked = false
  emit({ ...snapshot, saveError: null, fieldError: null })
  if (snapshot.record === null) {
    void ensureLoaded().then(() => {
      if (snapshot.record !== null && !blocked) {
        void flush()
      }
    })
    return
  }
  void flush()
}

function loadServerSettings(): void {
  const conflict = snapshot.conflict
  if (conflict === null) {
    return
  }
  blocked = false
  loaded = true
  emit({
    ...snapshot,
    status: "saved",
    record: conflict,
    value: conflict.value,
    conflict: null,
    saveError: null,
    loadError: null,
    fieldError: null,
  })
}

function keepLocalAndResave(): void {
  const conflict = snapshot.conflict
  if (conflict === null) {
    return
  }
  blocked = false
  emit({
    ...snapshot,
    status: "pending",
    record: conflict,
    conflict: null,
    saveError: null,
    fieldError: null,
  })
  void flush()
}

export function subscribeLibraryViewStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLibraryViewSnapshot(): LibraryViewSnapshot {
  return snapshot
}

export function getLibraryViewActions(): LibraryViewActions {
  return {
    update,
    retry,
    loadServerSettings,
    keepLocalAndResave,
  }
}

export function ensureLibraryViewLoaded(): void {
  void ensureLoaded()
}

export function flushLibraryViewSettings(): void {
  void flush()
}

export function resetLibraryViewStoreForTests(): void {
  clearSaveTimer()
  listeners = new Set()
  snapshot = INITIAL_SNAPSHOT
  loadPromise = null
  loaded = false
  blocked = false
  inFlight = false
  queued = false
  seq = 0
}
