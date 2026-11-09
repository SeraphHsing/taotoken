#!/usr/bin/env node
// capture-token.mjs — 从本机任意已登录浏览器（调试端口）读取 taotoken 登录令牌。
//
// 零依赖 Node ESM。支持所有以 --remote-debugging-port 启动的 Chromium 系浏览器
// （Edge/Chrome/Brave/Arc/Opera 等）；Firefox 的 Remote Agent 若开放了 debug
// 端口也可尝试（CDP 能力有限时脚本会报“未找到”）。
//
// 用法：
//   node scripts/capture-token.mjs                 # 人类可读输出
//   node scripts/capture-token.mjs --json          # 输出 JSON 供程序消费
//   node scripts/capture-token.mjs --ports 9222,9223
//
// JSON 输出：{ token, expiresAt, daysLeft, tokenTail, browser }
// 退出码：0 命中，1 未命中（错误信息不含令牌明文）。

import process from "node:process"

const DEFAULT_PORTS = [9222, 9223, 9229, 9333, 9224, 9225]
const DAY_MS = 86_400_000

// —— JWT claims (unverified) ——

const b64url = (s) => {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/")
  const pad = b64.length % 4
  return Buffer.from(pad === 2 ? b64 + "==" : pad === 3 ? b64 + "=" : b64, "base64").toString("utf8")
}

export const expiresOf = (jwt) => {
  if (typeof jwt !== "string") return 0
  const parts = jwt.split(".")
  if (parts.length !== 3 || !parts[1]) return 0
  try {
    const payload = JSON.parse(b64url(parts[1]))
    return typeof payload?.exp === "number" ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

// —— CDP over WebSocket ——

async function cookiesOf(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error("WebSocket 连接失败"))
  })
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const out = await send("Network.getCookies")
  ws.close()
  return out?.result?.cookies ?? []
}

async function tabWsUrlOf(port) {
  let tabs
  let res = await fetch(`http://127.0.0.1:${port}/json`).catch(() => null)
  if (res?.ok) {
    try {
      tabs = await res.json()
    } catch {
      tabs = null
    }
  }
  if (!Array.isArray(tabs)) {
    const res2 = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null)
    if (res2?.ok) {
      try {
        tabs = await res2.json()
      } catch {
        tabs = null
      }
    }
  }
  if (!tabs || !tabs.length) return null
  const page = tabs.find((t) => t?.type === "page" && t?.webSocketDebuggerUrl)
  return page?.webSocketDebuggerUrl ?? null
}

// tryPort returns { token, exp } or null.
async function tryPort(port) {
  let wsUrl
  try {
    wsUrl = await tabWsUrlOf(port)
  } catch {
    return null
  }
  if (!wsUrl) return null
  let cookies
  try {
    cookies = await cookiesOf(wsUrl)
  } catch {
    return null
  }
  const token = cookies.find((c) => c?.name === "token" && typeof c?.value === "string" && c?.value?.split?.(".")?.length === 3)
  if (!token) return null
  const exp = expiresOf(token.value)
  return { token: token.value, exp }
}

// captureToken scans the local debugging ports and returns the freshest
// taotoken token, or null.
export async function captureToken({ ports = DEFAULT_PORTS } = {}) {
  let best = null
  let bestExp = -1
  let bestPort = 0
  for (const port of ports) {
    const hit = await tryPort(port)
    if (hit && hit.exp >= bestExp) {
      best = hit
      bestExp = hit.exp
      bestPort = port
    }
  }
  if (!best) return null
  return {
    token: best.token,
    expiresAt: best.exp,
    daysLeft: Math.ceil((best.exp - Date.now()) / DAY_MS),
    tokenTail: String(best.token).slice(-8),
    browser: `localhost:${bestPort}`,
  }
}

// —— CLI ——

const arg = (n) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const jsonOut = process.argv.includes("--json")
  const raw = arg("--ports")
  const ports = raw ? raw.split(",").map(Number).filter(Number.isFinite) : []
  const hit = await captureToken({ ports: ports.length ? ports : undefined })
  if (!hit) {
    if (jsonOut) {
      console.log("{}")
    } else {
      console.error(
        "未找到 taotoken 登录令牌。请先让本机浏览器以调试端口运行并登录 taotoken：可执行 scripts/start-browser-debug.ps1（或用浏览器自身 --remote-debugging-port 参数启动），然后重试。",
      )
    }
    process.exit(1)
  }
  if (jsonOut) {
    console.log(JSON.stringify(hit))
  } else {
    console.log(
      `命中（${hit.browser}）：令牌尾 ${hit.tokenTail}，到期 ${new Date(hit.expiresAt).toISOString()}，剩 ${hit.daysLeft} 天`,
    )
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url.replace(/^file:\/\//, "").replace(/\\/g, "/").endsWith(process.argv[1].replace(/\\/g, "/"))

if (isMain) {
  main().catch((e) => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}