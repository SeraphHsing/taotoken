#!/usr/bin/env node
// refresh-token.mjs — 手动续期 taotoken 用量令牌并写回 magpie 凭据。
//
// 从本机已登录浏览器（调试端口）读取最新令牌，备份后仅更新
// plugin-auth.json 中 taotoken.metadata.loginToken，其余 provider 原样保留。
//
// 用法：
//   node scripts/refresh-token.mjs                     # 真实写回
//   node scripts/refresh-token.mjs --dry-run           # 只查看新旧到期时间
//   node scripts/refresh-token.mjs --task              # 同时打印计划任务示例
//   node scripts/refresh-token.mjs --auth <path>       # 指定 auth 文件
//   node scripts/refresh-token.mjs --ports 9222,9223   # 指定浏览器调试端口
//
// 退出码：0 成功（含 dry-run 成功），1 失败。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { captureToken, expiresOf } from "./capture-token.mjs"

const arg = (n) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : undefined
}

const authPath =
  arg("--auth") ?? path.join(os.homedir(), ".config", "magpie", "plugin-auth.json")
const dryRun = process.argv.includes("--dry-run")
const showTask = process.argv.includes("--task")

const DAY_MS = 86_400_000

function taskExample() {
  // placeholder script path resolved at runtime
  const script = path.resolve(process.argv[1])
  const node = process.execPath
  return [
    "计划任务示例（每周日 09:00 自动续期，需本机浏览器保持登录态且开启调试端口）：",
    `schtasks /Create /TN "taotoken-token-refresh" /TR "\"${node}\" \"${script}\" --auth \"${authPath}\"" /SC WEEKLY /D SUN /ST 09:00`,
    "如未固定调试端口，可在系统启动时运行 scripts/start-browser-debug.ps1。",
  ].join("\n")
}

async function main() {
  if (!fs.existsSync(authPath)) {
    console.error(`plugin-auth.json 不存在：${authPath}`)
    process.exit(1)
  }
  let auth
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"))
  } catch (e) {
    console.error(`无法解析 ${authPath}：${e?.message ?? e}`)
    process.exit(1)
  }
  const taotoken = auth?.taotoken
  const oldJwt = taotoken?.metadata?.loginToken
  if (!taotoken || !oldJwt) {
    console.error("plugin-auth.json 中没有 taotoken 账号的 metadata.loginToken，先登录插件。")
    process.exit(1)
  }

  const raw = arg("--ports")
  const ports = raw ? raw.split(",").map(Number).filter(Number.isFinite) : []
  const hit = await captureToken({ ports: ports.length ? ports : undefined })
  if (!hit) {
    console.error("未捕获到新令牌：请先运行 scripts/start-browser-debug.ps1（或开启浏览器调试端口）并确保已登录 taotoken。")
    process.exit(1)
  }

  const iso = (ms) => (ms ? new Date(ms).toISOString() : "(未知)")
  const oldExp = expiresOf(oldJwt)
  console.log(`旧令牌到期：${oldExp ? iso(oldExp) : "(无法解析)"}`)
  console.log(`浏览器命中：${hit.browser}，新令牌到期：${iso(hit.expiresAt)}（剩 ${hit.daysLeft} 天）`)

  if (dryRun) {
    if (showTask) console.log(taskExample())
    console.log("dry-run：未写入任何文件。")
    process.exit(0)
  }

  const backup = `${authPath}.bak-tt-refresh`
  fs.copyFileSync(authPath, backup)
  auth.taotoken.metadata = { ...auth.taotoken.metadata, loginToken: hit.token }
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", "utf8")
  console.log(`已更新令牌并写回 ${authPath}（备份：${backup}，其余 provider 不受影响）。`)
  console.log("请重启 magpie 应用，再查看用量卡片。")
  if (showTask) console.log(taskExample())
}

main().catch((e) => {
  console.error(e?.message ?? e)
  process.exit(1)
})