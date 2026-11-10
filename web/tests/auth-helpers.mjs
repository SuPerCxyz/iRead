import assert from "node:assert/strict"

export const E2E_PASSWORD =
  process.env.IREAD_E2E_PASSWORD ?? "iread-e2e-password"
export const E2E_SETUP_TOKEN = process.env.IREAD_E2E_SETUP_TOKEN ?? ""

export class E2EBlocked extends Error {
  constructor(message) {
    super(message)
    this.name = "E2EBlocked"
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function authStatusFrom(payload) {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return null
  }
  const data = payload.data
  if (
    typeof data.initialized !== "boolean" ||
    typeof data.authenticated !== "boolean" ||
    typeof data.csrfToken !== "string" ||
    data.csrfToken.length === 0
  ) {
    return null
  }
  return data
}

async function readPayload(response) {
  const text = await response.text()
  if (text.length === 0) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function csrfReason(payload) {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return null
  }
  const details = payload.error.details
  if (!isRecord(details)) {
    return null
  }
  return typeof details.reason === "string" ? details.reason : null
}

/**
 * Cookie-aware API helper. Requests and CSRF tokens are kept per context,
 * matching a real browser session.
 */
export class AuthedApi {
  constructor(requestContext, baseUrl, options = {}) {
    this.request = requestContext
    this.baseUrl = baseUrl.replace(/\/$/, "")
    this.csrfToken = options.csrfToken ?? null
  }

  async fetchStatus() {
    let response
    try {
      response = await this.request.get(`${this.baseUrl}/api/v1/auth/status`, {
        headers: { Accept: "application/json" },
        failOnStatusCode: false,
      })
    } catch (error) {
      throw new E2EBlocked(
        `无法连接 ${this.baseUrl}/api/v1/auth/status：${error.message}`,
      )
    }

    if (response.status() === 404 || response.status() === 405) {
      throw new E2EBlocked(
        "后端尚未实现认证接口：/api/v1/auth/status 返回 404/405。",
      )
    }
    if (response.status() !== 200) {
      throw new Error(
        `认证状态接口返回 ${response.status()}，无法执行认证 E2E。`,
      )
    }

    const payload = await readPayload(response)
    const status = authStatusFrom(payload)
    if (status === null) {
      throw new E2EBlocked(
        "认证状态响应缺少 initialized/authenticated/csrfToken，后端契约尚未就绪。",
      )
    }
    this.csrfToken = status.csrfToken
    return status
  }

  async refreshCsrf() {
    const status = await this.fetchStatus()
    return status.csrfToken
  }

  async requestJson(method, path, { data, retryCsrf = true } = {}) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`
    const headers = { Accept: "application/json" }
    let body
    if (data !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(data)
    }
    if (method !== "GET" && method !== "HEAD") {
      if (this.csrfToken === null) {
        await this.refreshCsrf()
      }
      headers.Origin = this.baseUrl
      headers["X-CSRF-Token"] = this.csrfToken
    }

    const response = await this.request.fetch(url, {
      method,
      headers,
      data: body,
      failOnStatusCode: false,
    })
    const payload = await readPayload(response)

    if (
      method !== "GET" &&
      response.status() === 403 &&
      retryCsrf &&
      csrfReason(payload) !== null &&
      csrfReason(payload).startsWith("csrf_")
    ) {
      await this.refreshCsrf()
      return this.requestJson(method, path, { data, retryCsrf: false })
    }

    return {
      status: response.status(),
      payload,
      headers: response.headers(),
    }
  }

  get(path) {
    return this.requestJson("GET", path)
  }

  post(path, data) {
    return this.requestJson("POST", path, { data })
  }

  put(path, data) {
    return this.requestJson("PUT", path, { data })
  }
}

export async function ensureAdmin(api, baseUrl, password = E2E_PASSWORD) {
  const status = await api.fetchStatus()
  if (status.authenticated) {
    return status
  }

  if (!status.initialized) {
    if (status.setupTokenRequired === true && E2E_SETUP_TOKEN.length === 0) {
      throw new E2EBlocked(
        "后端已启用 IREAD_SETUP_TOKEN；请设置 IREAD_E2E_SETUP_TOKEN 后重试。",
      )
    }
    const setupBody =
      status.setupTokenRequired === true
        ? { password, setupToken: E2E_SETUP_TOKEN }
        : { password }
    const setup = await api.post("/api/v1/auth/setup", setupBody)
    if (setup.status === 409) {
      // 并发初始化：转为登录已有管理员。
    } else if (
      setup.status === 403 &&
      csrfReason(setup.payload) === "setup_token_invalid"
    ) {
      throw new E2EBlocked(
        "IREAD_E2E_SETUP_TOKEN 与后端安装令牌不一致。",
      )
    } else if (setup.status !== 201) {
      throw new Error(
        `管理员初始化失败：HTTP ${setup.status} ${JSON.stringify(setup.payload)}`,
      )
    }
  }

  const current = await api.fetchStatus()
  if (!current.authenticated) {
    const login = await api.post("/api/v1/auth/login", { password })
    if (login.status === 429) {
      throw new E2EBlocked(
        "登录被限流（429），请等待 Retry-After 后重试 E2E。",
      )
    }
    if (login.status === 401) {
      throw new E2EBlocked(
        "现有管理员密码与 IREAD_E2E_PASSWORD 不一致；请设置正确的测试密码。",
      )
    }
    if (login.status === 409) {
      throw new Error(
        "后端认证状态在 setup/login 之间不一致，请先检查服务实现。",
      )
    }
    if (login.status !== 200) {
      throw new Error(
        `管理员登录失败：HTTP ${login.status} ${JSON.stringify(login.payload)}`,
      )
    }
  }

  const authenticated = await api.fetchStatus()
  assert.equal(
    authenticated.authenticated,
    true,
    "登录后 /auth/status 必须返回 authenticated=true",
  )
  return authenticated
}

export async function createAuthenticatedStorageState(
  browser,
  baseUrl,
  password = E2E_PASSWORD,
) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    locale: "zh-CN",
  })
  try {
    const api = new AuthedApi(context.request, baseUrl)
    await ensureAdmin(api, baseUrl, password)
    return await context.storageState()
  } finally {
    await context.close()
  }
}
