import { BookOpen, Info } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiError } from "@/lib/api"

import { isSetupTokenInvalidError } from "./api"
import {
  validateLoginPassword,
  validateSetupPassword,
  validateSetupToken,
} from "./model"

interface AuthScreenProps {
  mode: "setup" | "login"
  notice: string | null
  busy: boolean
  setupTokenRequired: boolean
  onSetup: (password: string, setupToken?: string) => Promise<void>
  onLogin: (password: string) => Promise<void>
}

interface FormError {
  message: string
  field?: "password" | "confirm" | "setupToken"
  summary?: boolean
}

function describeAuthError(
  caught: unknown,
  setupTokenVisible: boolean,
): FormError {
  if (!(caught instanceof ApiError)) {
    return {
      message: "认证请求失败，请稍后重试。",
      summary: true,
    }
  }
  if (caught.code === "network_error") {
    return {
      message: navigator.onLine
        ? "无法连接本机服务，请确认服务已启动后重试。"
        : "当前处于离线状态，无法建立新会话。请联网后重试。",
      summary: true,
    }
  }
  if (caught.status === 401) {
    return { message: "密码不正确。", field: "password" }
  }
  if (caught.status === 429) {
    return {
      message:
        caught.retryAfterSeconds === null
          ? "尝试次数过多，请稍后再试。"
          : `尝试次数过多，请在 ${caught.retryAfterSeconds} 秒后重试。`,
      summary: true,
    }
  }
  if (isSetupTokenInvalidError(caught)) {
    return setupTokenVisible
      ? { message: "安装令牌不正确", field: "setupToken" }
      : {
          message: "安装令牌不正确，请刷新页面后重试。",
          summary: true,
        }
  }
  if (caught.status === 403) {
    return {
      message: "安全校验失败，请刷新页面后重试。",
      summary: true,
    }
  }
  if (caught.status === 400) {
    return {
      message: caught.message,
      field: "password",
    }
  }
  if (caught.status === 409) {
    return {
      message: caught.message,
      summary: true,
    }
  }
  if (caught.status >= 500) {
    return {
      message: "服务器暂时无法完成请求，请稍后重试。",
      summary: true,
    }
  }
  return {
    message: caught.message,
    summary: true,
  }
}

export function AuthScreen({
  mode,
  notice,
  busy,
  setupTokenRequired,
  onSetup,
  onLogin,
}: AuthScreenProps) {
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [setupToken, setSetupToken] = useState("")
  const [error, setError] = useState<FormError | null>(null)
  const submittingRef = useRef(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const setupTokenRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLParagraphElement>(null)

  const isSetup = mode === "setup"
  const showSetupToken = isSetup && setupTokenRequired
  const passwordError = error?.field === "password" ? error.message : null
  const confirmError = error?.field === "confirm" ? error.message : null
  const setupTokenError =
    error?.field === "setupToken" ? error.message : null

  useEffect(() => {
    if (error === null) {
      return
    }
    if (error.field === "password") {
      passwordRef.current?.focus()
    } else if (error.field === "confirm") {
      confirmRef.current?.focus()
    } else if (error.field === "setupToken") {
      setupTokenRef.current?.focus()
    } else {
      summaryRef.current?.focus()
    }
  }, [error])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || submittingRef.current) {
      return
    }

    const passwordMessage = isSetup
      ? validateSetupPassword(password)
      : validateLoginPassword(password)
    if (passwordMessage !== null) {
      setError({ message: passwordMessage, field: "password" })
      return
    }
    if (isSetup && password !== confirmPassword) {
      setError({
        message: "两次输入的密码不一致。",
        field: "confirm",
      })
      return
    }
    if (showSetupToken) {
      const setupTokenMessage = validateSetupToken(setupToken)
      if (setupTokenMessage !== null) {
        setError({ message: setupTokenMessage, field: "setupToken" })
        return
      }
    }
    if (!navigator.onLine) {
      setError({
        message: "当前处于离线状态，无法建立新会话。请联网后重试。",
        summary: true,
      })
      return
    }

    setError(null)
    submittingRef.current = true
    try {
      if (isSetup) {
        await onSetup(password, showSetupToken ? setupToken : undefined)
      } else {
        await onLogin(password)
      }
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        (caught.code === "already_initialized" ||
          caught.code === "not_initialized")
      ) {
        return
      }
      setError(describeAuthError(caught, showSetupToken))
    } finally {
      submittingRef.current = false
    }
  }

  const passwordDescription =
    error?.field === "password" ? "auth-password-error" : undefined
  const confirmDescription =
    error?.field === "confirm" ? "auth-confirm-error" : undefined
  const passwordDescribedBy = [
    isSetup ? "auth-password-hint" : null,
    passwordDescription,
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
  const confirmDescribedBy = [
    "auth-confirm-hint",
    confirmDescription,
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
  const setupTokenDescription =
    error?.field === "setupToken" ? "auth-setup-token-error" : undefined
  const setupTokenDescribedBy = [
    "auth-setup-token-hint",
    setupTokenDescription,
  ]
    .filter((value): value is string => value !== null)
    .join(" ")

  return (
    <div className="iread-auth">
      <div className="iread-auth__card">
        <div className="iread-auth__brand">
          <BookOpen aria-hidden="true" />
          <span>iRead</span>
        </div>

        <div className="iread-auth__header">
          <h1 className="iread-auth__title">
            {isSetup ? "初始化 iRead" : "登录 iRead"}
          </h1>
          <p className="iread-auth__description">
            {isSetup
              ? "首次使用需要设置唯一的管理员密码。密码只保存在本机服务。"
              : "输入管理员密码以继续访问你的书库。"}
          </p>
        </div>

        {notice === null ? null : (
          <p className="iread-auth__notice" role="status">
            {notice}
          </p>
        )}

        <form
          className="iread-auth__form"
          noValidate
          aria-busy={busy}
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
        >
          <Field data-invalid={passwordError === null ? undefined : true}>
            <FieldLabel htmlFor="auth-password">密码</FieldLabel>
            <Input
              ref={passwordRef}
              autoFocus
              aria-describedby={
                passwordDescribedBy.length > 0
                  ? passwordDescribedBy
                  : undefined
              }
              aria-invalid={passwordError === null ? undefined : true}
              autoComplete={isSetup ? "new-password" : "current-password"}
              disabled={busy}
              id="auth-password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                if (error?.field === "password") {
                  setError(null)
                }
              }}
            />
            {isSetup ? (
              <FieldDescription id="auth-password-hint">
                至少 10 个字符，最多 128 字节；不会自动裁剪空格。
              </FieldDescription>
            ) : null}
            <FieldError id="auth-password-error">{passwordError}</FieldError>
          </Field>

          {isSetup ? (
            <Field data-invalid={confirmError === null ? undefined : true}>
              <FieldLabel htmlFor="auth-confirm-password">
                确认密码
              </FieldLabel>
              <Input
                ref={confirmRef}
                aria-describedby={confirmDescribedBy}
                aria-invalid={confirmError === null ? undefined : true}
                autoComplete="new-password"
                disabled={busy}
                id="auth-confirm-password"
                name="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                  if (error?.field === "confirm") {
                    setError(null)
                  }
                }}
              />
              <FieldDescription id="auth-confirm-hint">
                再次输入同一密码；仅在本机比对。
              </FieldDescription>
              <FieldError id="auth-confirm-error">{confirmError}</FieldError>
            </Field>
          ) : null}

          {showSetupToken ? (
            <Field data-invalid={setupTokenError === null ? undefined : true}>
              <FieldLabel htmlFor="auth-setup-token">安装令牌</FieldLabel>
              <Input
                ref={setupTokenRef}
                aria-describedby={setupTokenDescribedBy}
                aria-invalid={setupTokenError === null ? undefined : true}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                data-1p-ignore="true"
                data-lpignore="true"
                disabled={busy}
                id="auth-setup-token"
                name="auth-setup-token"
                spellCheck={false}
                type="password"
                value={setupToken}
                onChange={(event) => {
                  setSetupToken(event.target.value)
                  if (error?.field === "setupToken") {
                    setError(null)
                  }
                }}
              />
              <FieldDescription id="auth-setup-token-hint">
                部署时通过 IREAD_SETUP_TOKEN 设置的安装令牌；只在本次提交时使用，不会保存在浏览器。
              </FieldDescription>
              <FieldError id="auth-setup-token-error">
                {setupTokenError}
              </FieldError>
            </Field>
          ) : null}

          {error !== null && error.summary === true ? (
            <p
              ref={summaryRef}
              className="iread-auth__error"
              role="alert"
              tabIndex={-1}
            >
              {error.message}
            </p>
          ) : null}

          <Button
            className="iread-auth__submit"
            type="submit"
            disabled={busy}
          >
            {busy
              ? isSetup
                ? "正在初始化"
                : "正在登录"
              : isSetup
                ? "设置密码并进入"
                : "登录"}
          </Button>
        </form>

        <p className="iread-auth__meta">
          {isSetup
            ? "初始化完成后，请妥善保管密码；当前版本不提供找回流程。"
            : "会话保存在浏览器的安全 Cookie 中，页面关闭后仍可保持登录。"}
        </p>
      </div>
    </div>
  )
}

export function AuthLoadingScreen({
  label = "正在验证登录状态",
}: {
  label?: string
}) {
  return (
    <div className="iread-auth">
      <div
        className="iread-auth__card iread-auth__card--skeleton"
        role="status"
        aria-busy="true"
        aria-label={label}
      >
        <Skeleton className="iread-auth__skeleton-title" />
        <Skeleton className="iread-auth__skeleton-line" />
        <Skeleton className="iread-auth__skeleton-line iread-auth__skeleton-line--short" />
        <Skeleton className="iread-auth__skeleton-button" />
      </div>
    </div>
  )
}

export function AuthErrorScreen({
  error,
  onRetry,
}: {
  error: ApiError | null
  onRetry: () => void
}) {
  const offline = typeof navigator !== "undefined" && !navigator.onLine
  const message = offline
    ? "当前处于离线状态，无法建立新会话。请联网后重试。"
    : error?.code === "network_error"
      ? "无法连接本机服务，请确认服务已启动后重试。"
      : error?.message ?? "无法验证登录状态。"

  return (
    <div className="iread-auth">
      <div className="iread-auth__card">
        <div className="iread-auth__brand">
          <BookOpen aria-hidden="true" />
          <span>iRead</span>
        </div>
        <div className="iread-auth__header">
          <h1 className="iread-auth__title">无法验证登录状态</h1>
        </div>
        <Alert variant="destructive">
          <Info aria-hidden="true" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
        <Button
          className="iread-auth__submit"
          type="button"
          onClick={onRetry}
        >
          重试
        </Button>
      </div>
    </div>
  )
}
