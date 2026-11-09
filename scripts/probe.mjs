#!/usr/bin/env node
// TaoToken 接口鉴权探测脚本（独立于插件本体，不进入发布产物）。
//
// 目的：实测两个核心接口接受哪种凭证，以决定 usage 数据读取的
// 主/回退分支：
//   ① GET /v1/plan/overview   —— CodingPlan 用量（buckets）
//   ② GET /coding/v1/models   —— CodingPlan 模型清单（OpenAI 兼容）
//
// 用法（Node >= 18，零依赖）：
//   node scripts/probe.mjs                                          # 仅基线
//   node scripts/probe.mjs --key sk-xxx                             # API Key 矩阵
//   node scripts/probe.mjs --token <登录 JWT>                        # 登录 token 矩阵
//   node scripts/probe.mjs --cookie-file .probe-cookies.tsv          # 浏览器导出的 cookie 矩阵
//   也可组合；环境变量 TAOTOKEN_API_KEY / TAOTOKEN_SESSION_TOKEN / TAOTOKEN_COOKIE。
//
//   cookie 文件格式：每行 "cookieName\tvalue"（cdp-cookies.mjs 导出）。
//
// 安全：凭证只打印掩码前缀；响应体摘要截断前 300 字符。

import process from "node:process"
import fs from "node:fs"

const API = "https://taotoken.net/api"
const CODING = "https://api.taotoken.net/coding"

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const key = arg("--key") ?? process.env.TAOTOKEN_API_KEY
const token = arg("--token") ?? process.env.TAOTOKEN_SESSION_TOKEN
const cookieArg = arg("--cookie") ?? process.env.TAOTOKEN_COOKIE
const cookieFile = arg("--cookie-file")

const mask = (s) => (s ? `${String(s).slice(0, 8)}…(${String(s).length} 字符)` : "(未提供)")

// 从 tsv 读取 {name: value}
function loadCookies(file) {
  const map = {}
  if (!fs.existsSync(file)) {
    console.warn(`[warn] cookie 文件不存在: ${file}`)
    return map
  }
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const [name, ...rest] = line.trim().split("\t")
    if (name) map[name] = rest.join("\t") || ""
  }
  return map
}

async function probe(label, url, { method = "GET", headers = {} } = {}) {
  const started = Date.now()
  let res, text
  try {
    res = await fetch(url, { method, headers })
    text = await res.text()
  } catch (e) {
    console.log(`x ${label}: 网络错误 — ${e.message}`)
    return { status: 0, text: "" }
  }
  const ms = Date.now() - started
  let summary = text.replace(/\s+/g, " ").slice(0, 300)
  if (text.length > 300) summary += ` …(共 ${text.length} 字符)`
  const ok = res.ok ? "OK " : "!! "
  console.log(`${ok}${label}: HTTP ${res.status} (${ms}ms)`)
  if (text) console.log(`    ${summary}`)
  return { status: res.status, text }
}

const tt = (h) => ({ ...h, "Content-Type": "application/json", "x-auth-type": "taotoken" })

function main() {
  const cookies = cookieFile ? loadCookies(cookieFile) : {}
  const jwt = token ?? cookies["token"]
  const cookieEntries = Object.entries(cookies)
  const joinCookies = (names) => names.map((n) => `${n}=${cookies[n]}`).join("; ")

  console.log("== TaoToken 接口鉴权探测 ==")
  console.log(`API Key:  ${mask(key)}`)
  console.log(`会话令牌: ${mask(token)} (cookie 文件含 ${cookieEntries.length} 项${jwt ? `，其中 token JWT ${jwt.length} 字符` : "，无 token"})`)
  if (cookieFile) console.log(`cookie 文件: ${cookieFile}`)
  console.log("")

  void (async () => {
    const usage = API + "/v1/plan/overview"
    const models = CODING + "/v1/models"

    console.log("--- ① 用量接口 GET /v1/plan/overview ---")
    await probe("无凭证（基线）", usage)
    if (key) {
      await probe("Bearer <API Key>", usage, { headers: tt({ Authorization: `Bearer ${key}` }) })
    }
    if (cookieEntries.length) {
      const full = joinCookies(cookieEntries.map(([n]) => n))
      await probe("Cookie: 全部 19 项", usage, { headers: tt({ Cookie: full }) })
      if (jwt) {
        await probe("Cookie: 仅 token JWT", usage, { headers: tt({ Cookie: `token=${jwt}` }) })
        await probe("Authorization: Bearer <JWT>（无 cookie）", usage, { headers: tt({ Authorization: `Bearer ${jwt}` }) })
        await probe("Authorization: 裸 <JWT>（无 cookie）", usage, { headers: tt({ Authorization: jwt }) })
        const wafless = cookieEntries
          .filter(([n]) => !/waf|captcha/i.test(n))
          .map(([n]) => `${n}=${cookies[n]}`)
          .join("; ")
        await probe("Cookie: 排除 waf/captcha", usage, { headers: tt({ Cookie: wafless }) })
        const onlyWaf = cookieEntries
          .filter(([n]) => /waf|captcha/i.test(n))
          .map(([n]) => `${n}=${cookies[n]}`)
          .join("; ")
        await probe("Cookie: 仅 waf/captcha", usage, { headers: tt({ Cookie: onlyWaf }) })
      }
    }
    if (token) {
      await probe("Bearer <会话令牌>（仅参数）", usage, { headers: tt({ Authorization: `Bearer ${token}` }) })
      await probe("裸 <会话令牌>（仅参数）", usage, { headers: tt({ Authorization: token }) })
    }
    console.log("")

    console.log("--- ② CodingPlan 模型接口 GET /coding/v1/models ---")
    await probe("无凭证（基线）", models)
    if (key) {
      await probe("Bearer <API Key>", models, { headers: tt({ Authorization: `Bearer ${key}` }) })
    }
    if (cookieEntries.length) {
      const full = joinCookies(cookieEntries.map(([n]) => n))
      await probe("Cookie: 全部", models, { headers: tt({ Cookie: full }) })
      if (jwt) {
        await probe("Authorization: Bearer <JWT>（无 cookie）", models, { headers: tt({ Authorization: `Bearer ${jwt}` }) })
      }
    }
    console.log("")

    console.log("--- 结论 ---")
    console.log("主事实：模型接口接受 API Key(Bearer)；用量接口需要登录会话（JWT cookie 或 header token）。")
    console.log("回退分支凭证形态以 ① 中 '仅 token JWT' 与 'Bearer/裸 JWT' 两条结果为准。")
  })().catch((e) => {
    console.error("探测失败:", e)
    process.exitCode = 1
  })
}

main()