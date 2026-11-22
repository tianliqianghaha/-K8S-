#Requires -RunAsAdministrator
# 阶段 A2：让 hypervisor 真正加载（修「重启了但没生效」）
# 现象：InstallState 已是 1，但 HypervisorPresent=False，uptime 仍是很久以前
# 根因：Win10 快速启动（HiberbootEnabled=1）走"关机再开机"会恢复旧内核会话，
#       功能启用的收尾没有真正执行，hypervisor 没被拉起。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[FATAL] 必须以管理员身份运行" -ForegroundColor Red
    exit 1
}

Write-Host "=== 修复前 ===" -ForegroundColor Cyan
$cs = Get-CimInstance Win32_ComputerSystem
"  HypervisorPresent : " + $cs.HypervisorPresent
"  HiberbootEnabled  : " + (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power" -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
"  Uptime            : " + ((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToString("dd\.hh\:mm\:ss")

Write-Host "`n=== 1. 关闭休眠与快速启动 ===" -ForegroundColor Cyan
& powercfg.exe /h off
Write-Host "  powercfg /h off 退出码: $LASTEXITCODE"
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power" -Name HiberbootEnabled -Value 0 -Type DWord
Write-Host "  HiberbootEnabled 已设为 0"

Write-Host "`n=== 2. 确认 hypervisor 启动类型为 auto ===" -ForegroundColor Cyan
& bcdedit.exe /set hypervisorlaunchtype auto
Write-Host "  bcdedit 退出码: $LASTEXITCODE"
& bcdedit.exe /enum "{current}" | Select-String -Pattern "hypervisorlaunchtype" | ForEach-Object { "  " + $_.Line.Trim() }

Write-Host "`n=== 3. 五秒后强制重启（完整重启，不走快速启动）===" -ForegroundColor Yellow
Write-Host "  重启回来后，先跑这一条确认：" -ForegroundColor Yellow
Write-Host "    (Get-CimInstance Win32_ComputerSystem).HypervisorPresent" -ForegroundColor White
Write-Host "  必须是 True，再继续装 Ubuntu。" -ForegroundColor Yellow

& shutdown.exe /r /t 5 /c "Enabling hypervisor for WSL2"
