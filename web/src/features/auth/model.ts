export const PASSWORD_MIN_CHARS = 10
export const PASSWORD_MAX_BYTES = 128

export function passwordCharacterCount(password: string): number {
  return Array.from(password).length
}

export function passwordByteCount(password: string): number {
  return new TextEncoder().encode(password).length
}

/** 返回错误文案；null 表示通过。服务端仍会做最终校验。 */
export function validateSetupPassword(password: string): string | null {
  if (password.length === 0) {
    return "请输入管理员密码。"
  }
  if (passwordCharacterCount(password) < PASSWORD_MIN_CHARS) {
    return `密码至少需要 ${PASSWORD_MIN_CHARS} 个字符。`
  }
  if (passwordByteCount(password) > PASSWORD_MAX_BYTES) {
    return `密码不能超过 ${PASSWORD_MAX_BYTES} 字节。`
  }
  return null
}

export function validateLoginPassword(password: string): string | null {
  if (password.length === 0) {
    return "请输入密码。"
  }
  return null
}

/** 安装令牌只做非空本地校验；错误令牌由服务端返回 setup_token_invalid。 */
export function validateSetupToken(setupToken: string): string | null {
  if (setupToken.length === 0) {
    return "请输入安装令牌。"
  }
  return null
}
