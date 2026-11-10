import { describe, expect, it } from "vitest"

import { safeReturnTo } from "../src/lib/path"
import {
  passwordByteCount,
  passwordCharacterCount,
  validateLoginPassword,
  validateSetupPassword,
} from "../src/features/auth/model"

describe("safeReturnTo", () => {
  it("accepts known same-origin routes with query and hash", () => {
    expect(safeReturnTo("/library?sort=title#top", "/")).toBe(
      "/library?sort=title#top",
    )
    expect(safeReturnTo("/books/abc", "/")).toBe("/books/abc")
    expect(safeReturnTo("/read/abc", "/")).toBe("/read/abc")
  })

  it("rejects external and protocol-relative targets", () => {
    expect(safeReturnTo("https://evil.example/steal", "/home")).toBe("/home")
    expect(safeReturnTo("//evil.example/steal", "/home")).toBe("/home")
    expect(safeReturnTo("/\\evil.example/steal", "/home")).toBe("/home")
    expect(safeReturnTo("javascript:alert(1)", "/home")).toBe("/home")
  })

  it("rejects unknown routes and strips nested returnTo", () => {
    expect(safeReturnTo("/api/v1/auth/status", "/")).toBe("/")
    expect(safeReturnTo("/settings?returnTo=/library&tab=cache", "/")).toBe(
      "/settings?tab=cache",
    )
  })

  it("falls back for missing input", () => {
    expect(safeReturnTo(null, "/library")).toBe("/library")
    expect(safeReturnTo("", "/library")).toBe("/library")
  })
})

describe("password validation", () => {
  it("counts Unicode characters and UTF-8 bytes", () => {
    expect(passwordCharacterCount("😀😀😀😀😀😀😀😀😀😀")).toBe(10)
    expect(passwordByteCount("😀")).toBe(4)
  })

  it("requires at least ten characters for setup", () => {
    expect(validateSetupPassword("123456789")).toBe(
      "密码至少需要 10 个字符。",
    )
    expect(validateSetupPassword("1234567890")).toBeNull()
    expect(validateSetupPassword("😀😀😀😀😀😀😀😀😀😀")).toBeNull()
  })

  it("rejects passwords above 128 bytes without trimming", () => {
    expect(validateSetupPassword("😀".repeat(33))).toBe(
      "密码不能超过 128 字节。",
    )
    expect(validateSetupPassword("          ")).toBeNull()
  })

  it("only requires a non-empty password for login", () => {
    expect(validateLoginPassword("")).toBe("请输入密码。")
    expect(validateLoginPassword("x")).toBeNull()
  })
})
