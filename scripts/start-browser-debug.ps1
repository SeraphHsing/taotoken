# start-browser-debug.ps1 — 以调试端口启动本机浏览器（默认 Edge），用于续期脚本读取登录令牌。
#
# 用法：
#   .\scripts\start-browser-debug.ps1
#   .\scripts\start-browser-debug.ps1 -Browser chrome
#   .\scripts\start-browser-debug.ps1 -Browser msedge -Port 9223
#
# 说明：若目标端口已在监听则直接冒烟；否则会关闭所有该浏览器窗口后以调试端口重启
# （保留默认 profile，登录态不丢）。如不希望关闭窗口，请先用浏览器自带参数手动启动。

param(
  [string]$Browser = "msedge",
  [int]$Port = 9222
)

$ErrorActionPreference = "Stop"

# 常见 Chromium 系浏览器的候选路径与进程名
$browsers = @{
  msedge   = @{
    proc = "msedge"
    exe  = @(
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
  }
  chrome   = @{
    proc = "chrome"
    exe  = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
  }
  brave    = @{
    proc = "brave"
    exe  = @(
      "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
      "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
  }
  arc      = @{
    proc = "arc"
    exe  = @("$env:LOCALAPPDATA\Arc\Application\arc.exe")
  }
  opera    = @{
    proc = "opera"
    exe  = @(
      "$env:ProgramFiles\Opera\opera.exe",
      "$env:LOCALAPPDATA\Programs\Opera\opera.exe"
    )
  }
  vivaldi  = @{
    proc = "vivaldi"
    exe  = @(
      "$env:ProgramFiles\Vivaldi\Application\vivaldi.exe",
      "$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe"
    )
  }
}

function Test-PortListening([int]$p) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $r = $c.BeginConnect("127.0.0.1", $p, $null, $null)
    $ok = $r.AsyncWaitHandle.WaitOne(300)
    if ($ok) { $c.EndConnect($r) }
    $c.Close()
    return $ok
  } catch {
    return $false
  }
}

$cfg = $browsers[$Browser.ToLower()]
if (-not $cfg) {
  Write-Host "不支持的浏览器: $Browser（可选 msedge/chrome/brave/arc/opera/vivaldi）"
  exit 2
}

$exe = $cfg.exe | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Host "未找到 $Browser 的可执行文件。请安装浏览器或改用 -Browser 参数指定。"
  exit 1
}

Write-Host "浏览器: $exe"
Write-Host "调试端口: $Port"

if (Test-PortListening $Port) {
  Write-Host "端口 $Port 已在监听，无需重启浏览器。"
  curl.exe -s "http://127.0.0.1:$Port/json/version" | Select-Object -First 1
  exit 0
}

Write-Host "端口未监听。将关闭所有 $($cfg.proc) 窗口并以调试端口重启（请先保存浏览器中未完成内容）。"
Start-Sleep -Seconds 2
Get-Process $cfg.proc -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

Start-Process $exe -ArgumentList (
  "--remote-debugging-port=$Port",
  "--no-first-run",
  "--no-default-browser-check",
  "https://taotoken.net/console/api-keys"
)

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (Test-PortListening $Port) {
    Write-Host "调试端口 $Port 已就绪，浏览器已打开 taotoken 控制台。"
    curl.exe -s "http://127.0.0.1:$Port/json/version" | Select-Object -First 1
    exit 0
  }
}
Write-Host "等待端口就绪超时，请手动检查浏览器是否以调试端口启动。"
exit 1