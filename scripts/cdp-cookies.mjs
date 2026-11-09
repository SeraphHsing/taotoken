#!/usr/bin/env node
// cdp-cookies.mjs — 从 CDP 调试实例导出 taotoken 域 cookie 到本地文件（供 probe.mjs 鉴权矩阵复用）。
// 输出: <outFile>，每行 "cookieName\tvalue"，仅打印 cookie 名称列表（值不明文回显）。
//
// 用法: node scripts/cdp-cookies.mjs [outFile]   // 默认 .probe-cookies.tsv
// 注意: 退出后请尽快使用；会话凭证会过期。

import process from "node:process"
import fs from "node:fs"
import path from "node:path"

const PORT = 9222
const HOST = "127.0.0.1"
const outFile = process.argv[2] ?? "e:/Work/Git/taotoken/.probe-cookies.tsv"

async function main() {
  const tabs = await (await fetch(`http://${HOST}:${PORT}/json`)).json()
  const tab =
    tabs.find((t) => t.type === "page" && t.url.includes("taotoken")) ??
    tabs.find((t) => t.type === "page" && t.url.startsWith("http"))
  if (!tab) {
    console.error("未找到 taotoken 标签页")
    process.exit(1)
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = (e) => rej(new Error("WebSocket error: " + JSON.stringify(e)))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  const out = await send("Network.getCookies")
  const cookies = (out.result?.cookies ?? []).filter((c) => c.domain.endsWith("taotoken.net"))
  const lines = cookies.map((c) => `${c.name}\t${c.value ?? ""}`)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8")
  console.log(`已导出 ${cookies.length} 个 cookie -> ${outFile}`)
  for (const c of cookies.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${c.name}${c.httpOnly ? " [httpOnly]" : ""} (${String(c.value ?? "").length} 字符)`)
  }
  ws.close()
}

main().catch((e) => {
  console.error("[error]", e.message)
  process.exit(1)
})