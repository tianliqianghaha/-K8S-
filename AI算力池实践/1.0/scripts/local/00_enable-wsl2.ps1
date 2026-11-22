#Requires -RunAsAdministrator
# 阶段 A：启用 WSL2 所需的两个 Windows 功能（Win10 19045）
# 必须在"管理员"PowerShell 中运行；执行完需要重启一次。

$ErrorActionPreference = 'Stop'

# 5.1 控制台默认 GBK，显式设 UTF-8 避免中文乱码
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host "[FATAL] 必须以管理员身份运行本脚本" -ForegroundColor Red
        exit 1
    }
}

Assert-Admin

$features = @(
    'Microsoft-Windows-Subsystem-Linux',
    'VirtualMachinePlatform'
)

Write-Host "=== 启用前状态 ===" -ForegroundColor Cyan
foreach ($f in $features) {
    $s = (Get-CimInstance Win32_OptionalFeature -Filter "Name='$f'").InstallState
    Write-Host ("  {0,-40} InstallState={1}" -f $f, $s)
}
Write-Host "  1=已启用  2=已禁用  3=不存在"

foreach ($f in $features) {
    Write-Host "`n=== 启用 $f ===" -ForegroundColor Cyan
    $r = & dism.exe /online /enable-feature /featurename:$f /all /norestart 2>&1
    $r | Select-Object -Last 6 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) {
        Write-Host "[FATAL] $f 启用失败，退出码 $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
    if ($LASTEXITCODE -eq 3010) {
        Write-Host "  (3010 = 成功，需要重启)" -ForegroundColor Yellow
    }
}

Write-Host "`n=== 启用后状态 ===" -ForegroundColor Cyan
foreach ($f in $features) {
    $s = (Get-CimInstance Win32_OptionalFeature -Filter "Name='$f'").InstallState
    Write-Host ("  {0,-40} InstallState={1}" -f $f, $s)
}

Write-Host @"

=========================================================
下一步（必须做）：重启这台电脑

  Restart-Computer

重启后回来执行：
  scripts\local\01_install-wsl.ps1
=========================================================
"@ -ForegroundColor Green
