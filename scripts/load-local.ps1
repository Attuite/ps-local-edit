param([string]$UxpCommand)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $UxpCommand) {
    $taskCli = Get-Command uxp -ErrorAction SilentlyContinue
    if ($taskCli) { $UxpCommand = $taskCli.Source }
    else {
        $taskWorkspace = Split-Path -Parent (Split-Path -Parent $taskRoot)
        $UxpCommand = Join-Path $taskWorkspace 'work\uxp-tools\node_modules\.bin\uxp.cmd'
    }
}
if (-not (Test-Path -LiteralPath $UxpCommand)) { throw '请先安装 Adobe UXP CLI，或使用 -UxpCommand 指定 uxp.cmd。' }
if (-not (Get-Process Photoshop -ErrorAction SilentlyContinue)) { throw '请先打开 Photoshop 并返回主界面。' }
$taskPort = Get-NetTCPConnection -LocalPort 14001 -State Listen -ErrorAction SilentlyContinue
if (-not $taskPort) {
    $taskJob = Start-Job -ArgumentList $UxpCommand -ScriptBlock { param($taskCommand) & $taskCommand service start }
    for ($taskAttempt = 0; $taskAttempt -lt 20; $taskAttempt++) {
        Start-Sleep -Milliseconds 500
        if (Get-NetTCPConnection -LocalPort 14001 -State Listen -ErrorAction SilentlyContinue) { break }
    }
    Start-Sleep -Seconds 2
    Write-Host '加载会话运行期间，请保留此窗口。'
}
try {
    & $UxpCommand plugin load --manifest (Join-Path $taskRoot 'plugin\manifest.json') --apps PS
    if ($LASTEXITCODE -ne 0) { throw '加载失败。请确认 Photoshop 已启用开发模式，关闭对话框并重启后再加载。' }
    Write-Host '已加载：在 Photoshop 增效工具菜单打开「局部改图」。'
    if ($taskJob) { Read-Host '按 Enter 结束本次开发加载会话' | Out-Null }
} finally {
    if ($taskJob) { Stop-Job $taskJob; Remove-Job $taskJob }
}
