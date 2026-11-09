#!/usr/bin/env node
// cdp-eval.mjs — 通过 CDP 在 taotoken（或任意）已登录页面里执行 JS 表达式（Node >= 21，内置 WebSocket/fetch）。
// 属开发辅助工具；使用浏览器存储的登录态复刻前端请求，验证用量接口鉴权形态。
//
// 用法：
//   node scripts/cdp-eval.mjs "document.title"
//   echo "await fetch('/api/v1/plan/overview').then(r=>r.status)" | node scripts/cdp-eval.mjs
//   node scripts/cdp-eval.mjs --list-cookies

import process from "node:process"
import fs from "node:fs"

const PORT = 9222
const HOST = "127.0.0.1"

async function findTab() {
  const tabs = await (await fetch(`http://${HOST}:${PORT}/json`)).json()
  const pages = tabs.filter((t) => t.type === "page")
  return (
    pages.find((t) => t.url.includes("taotoken")) ??
    pages.find((t) => t.url.startsWith("http")) ??
    pages[0]
  )
}

async function main() {
  const listMode = process.argv.includes("--list-cookies")
  let expr = process.argv[2]
  if (!expr && !process.stdin.isTTY) expr = fs.readFileSync(0, "utf8")
  if (!expr && !listMode) {
    console.error('用法: node scripts/cdp-eval.mjs <JS 表达式> | echo "表达式" | node scripts/cdp-eval.mjs | node scripts/cdp-eval.mjs --list-cookies')
    process.exit(1)
  }
  const tab = await findTab()
  if (!tab) {
    console.error("未找到可用的 page 标签页，请确认 Edge 调试实例已启动")
    process.exit(1)
  }
  console.log(`[tab] ${tab.title}\n[url] ${tab.url}`)
  if (expr) console.log(`[expr] ${expr.slice(0, 200)}`)
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
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
    ws.onerror = (e) => rej(new Error("WebSocket 连接失败: " + JSON.stringify(e)))
  })
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  if (listMode) {
    const out = await send("Network.getCookies")
    const cookies = out.result?.cookies ?? []
    console.log(`[cookies] 共 ${cookies.length} 项:`)
    const interesting = cookies.filter((c) => c.httpOnly || /session|token|auth|csrf|jwt|sid|uid|user|login|pass/i.test(c.name))
    for (const c of cookies.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))) {
      const flag = c.httpOnly || /session|token|auth|csrf|jwt|sid|uid|user|login|pass/i.test(c.name) ? " *" : ""
      const v = c.value ? `${String(c.value).slice(0, 8)}…(${String(c.value).length})` : "(空)"
      console.log(`  ${c.domain.padEnd(30)} ${c.name.padEnd(28)} httpOnly=${c.httpOnly} secure=${c.secure} value=${v}${flag}`)
    }
    ws.close()
    return
  }

  const out = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  })
  if (out.result?.exceptionDetails) {
    console.error("[exception]", out.result.exceptionDetails.text, out.result.exceptionDetails.exception?.description)
    process.exitCode = 2
  } else {
    const v = out.result?.result?.value
    console.log(`[value] ${typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v)}`)
  }
  ws.close()
}

main().catch((e) => {
  console.error("[error]", e.message)
  process.exitCode = 1
})