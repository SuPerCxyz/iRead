import { useSyncExternalStore } from "react"
import { registerSW } from "virtual:pwa-register"

export type PwaRegistrationStatus =
  | "unsupported"
  | "disabled"
  | "registering"
  | "registered"
  | "update-available"
  | "error"

export type UpdateDismissReason = "later" | "after-reading"

export interface PwaStatus {
  supported: boolean
  status: PwaRegistrationStatus
  needRefresh: boolean
  offlineReady: boolean
  checking: boolean
  controlled: boolean
  error: string | null
  lastCheckedAt: string | null
  dismissed: UpdateDismissReason | null
}

const initialState: PwaStatus = {
  supported: !import.meta.env.DEV,
  status: import.meta.env.DEV ? "disabled" : "registering",
  needRefresh: false,
  offlineReady: false,
  checking: false,
  controlled: false,
  error: null,
  lastCheckedAt: null,
  dismissed: null,
}

let state: PwaStatus = initialState
let initialized = false
let registrationRef: ServiceWorkerRegistration | null = null
let controllerListenerAttached = false
let updateSW:
  | ((reloadPage?: boolean) => Promise<void>)
  | undefined

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) {
    listener()
  }
}

function setState(patch: Partial<PwaStatus>) {
  state = { ...state, ...patch }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): PwaStatus {
  return state
}

function watchController() {
  if (controllerListenerAttached || !("serviceWorker" in navigator)) {
    return
  }
  controllerListenerAttached = true
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    setState({ controlled: true })
  })
}

async function hasPrecache(): Promise<boolean> {
  if (typeof caches === "undefined") {
    return false
  }
  try {
    const names = await caches.keys()
    return names.some((name) => name.includes("precache"))
  } catch {
    return false
  }
}

export function registerAppServiceWorker(): void {
  if (initialized) {
    return
  }
  initialized = true

  if (import.meta.env.DEV) {
    setState({
      supported: false,
      status: "disabled",
      controlled: false,
    })
    return
  }

  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    setState({
      supported: false,
      status: "unsupported",
      controlled: false,
    })
    return
  }

  watchController()
  setState({
    supported: true,
    status: "registering",
    controlled: navigator.serviceWorker.controller !== null,
  })

  void hasPrecache().then((ready) => {
    if (ready) {
      setState({ offlineReady: true })
    }
  })

  try {
    updateSW = registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (registration === undefined) {
          return
        }
        registrationRef = registration
        const waiting = registration.waiting !== null
        setState({
          status: waiting ? "update-available" : "registered",
          needRefresh: waiting,
          controlled: navigator.serviceWorker.controller !== null,
          dismissed: waiting ? null : state.dismissed,
        })
      },
      onNeedRefresh() {
        setState({
          status: "update-available",
          needRefresh: true,
          dismissed: null,
        })
      },
      onOfflineReady() {
        setState({ offlineReady: true })
      },
      onRegisterError(error) {
        setState({
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Service Worker 注册失败。",
        })
      },
    })
  } catch (error) {
    setState({
      status: "error",
      error:
        error instanceof Error
          ? error.message
          : "Service Worker 注册失败。",
    })
  }
}

export async function checkForUpdate(): Promise<void> {
  if (registrationRef === null) {
    setState({
      status: "error",
      error: "Service Worker 尚未注册，无法检查更新。",
    })
    return
  }
  setState({ checking: true, error: null })
  try {
    await registrationRef.update()
    const waiting = registrationRef.waiting !== null
    setState({
      checking: false,
      lastCheckedAt: new Date().toISOString(),
      needRefresh: state.needRefresh || waiting,
      status: waiting ? "update-available" : "registered",
      dismissed: waiting ? null : state.dismissed,
      error: null,
    })
  } catch (error) {
    setState({
      checking: false,
      error:
        error instanceof Error ? error.message : "检查更新失败。",
    })
  }
}

export async function applyUpdate(): Promise<void> {
  if (updateSW === undefined) {
    setState({
      error: "更新服务尚未就绪，请稍后重试。",
    })
    return
  }
  setState({ error: null })
  try {
    await updateSW(true)
  } catch (error) {
    setState({
      status: "update-available",
      needRefresh: true,
      error:
        error instanceof Error ? error.message : "应用更新失败，请重试。",
    })
  }
}

export function dismissUpdate(reason: UpdateDismissReason): void {
  setState({ dismissed: reason })
}

export function usePwaStatus(): PwaStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
