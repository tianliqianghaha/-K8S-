# 阶段 B：安装 WSL 2 与 Ubuntu 24.04（重启之后执行）
# 不需要管理员权限。若 WSL 仍是 inbox 1.x，本脚本会引导你走 Microsoft Store。

$ErrorActionPreference = 'Stop'

# 5.1 控制台默认 GBK，显式设 UTF-8 避免中文乱码
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== 0a. 重启后自检 ===" -ForegroundColor Cyan
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs.HypervisorPresent) {
    Write-Host "  虚拟化监控程序：已启动 (HypervisorPresent=True)" -ForegroundColor Green
} else {
    Write-Host "  [FATAL] HypervisorPresent=False —— hypervisor 没加载，WSL2 起不来" -ForegroundColor Red
    Write-Host "          先跑 03_fix-hypervisor.ps1（管理员），它会关快速启动并强制重启" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n=== 0. 确认 Windows 功能已启用 ===" -ForegroundColor Cyan
$ok = $true
foreach ($f in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')) {
    $s = (Get-CimInstance Win32_OptionalFeature -Filter "Name='$f'").InstallState
    $mark = 'OK'
    if ($s -ne 1) { $mark = 'NOT-ENABLED'; $ok = $false }
    Write-Host ("  {0,-40} InstallState={1} ({2})" -f $f, $s, $mark)
}
if (-not $ok) {
    Write-Host "[FATAL] 功能未启用。请先跑 00_enable-wsl2.ps1 并重启。" -ForegroundColor Red
    exit 1
}

Write-Host "`n=== 1. 写入 .wslconfig（内存/CPU/swap 上限）===" -ForegroundColor Cyan
$tpl = Join-Path $here 'wslconfig.template'
$dst = Join-Path $env:USERPROFILE '.wslconfig'
if (Test-Path $tpl) {
    Copy-Item $tpl $dst -Force
    Write-Host "  已写入 $dst"
} else {
    Write-Host "  模板缺失，跳过（$tpl）" -ForegroundColor Yellow
}

Write-Host "`n=== 2. 检查 WSL 版本 ===" -ForegroundColor Cyan
$verOut = ''
try { $verOut = (wsl.exe --version 2>&1 | Out-String) } catch { $verOut = '' }
$isNewWsl = $verOut -match 'WSL\s*(版本|version)'

if ($isNewWsl) {
    Write-Host "  已是新版 WSL（支持 systemd）" -ForegroundColor Green
    ($verOut -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 3) | ForEach-Object { Write-Host ("    " + $_.Trim()) }
} else {
    Write-Host "  当前是 inbox 1.x —— 不支持 systemd，kubelet/containerd 会起不来" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  winget 通道会回源 GitHub，本机实测不通（0x80072efd）。改走商店：" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    1) 打开『Microsoft Store』应用" -ForegroundColor White
    Write-Host "    2) 搜索：Windows Subsystem for Linux" -ForegroundColor White
    Write-Host "    3) 点『安装』，等它下完（约 200MB）" -ForegroundColor White
    Write-Host "    4) 装完回到这里，重新运行本脚本" -ForegroundColor White
    Write-Host ""
    Write-Host "  想直接跳转商店，可在任意窗口执行：" -ForegroundColor Yellow
    Write-Host "    start ms-windows-store://search/?query=Windows%20Subsystem%20for%20Linux" -ForegroundColor White
    Write-Host ""
    try {
        $null = Read-Host "  商店装完后按回车继续（Ctrl+C 中止）"
    } catch {
        Write-Host "  （非交互环境，退出）" -ForegroundColor Yellow
        exit 1
    }
    $verOut2 = ''
    try { $verOut2 = (wsl.exe --version 2>&1 | Out-String) } catch { $verOut2 = '' }
    if ($verOut2 -notmatch 'WSL\s*(版本|version)') {
        Write-Host "  仍未检测到新版 WSL，请确认商店安装已完成" -ForegroundColor Red
        exit 1
    }
    Write-Host "  新版 WSL 已就绪" -ForegroundColor Green
}

Write-Host "`n=== 3. 设为默认 WSL2 并确认版本 ===" -ForegroundColor Cyan
wsl.exe --set-default-version 2
wsl.exe --version

Write-Host "`n=== 4. 安装 Ubuntu 24.04（不自动启动，避免交互卡住）===" -ForegroundColor Cyan
wsl.exe --install -d Ubuntu-24.04 --no-launch
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [WARN] 返回 $LASTEXITCODE。也可能已装过，下面列出现有发行版：" -ForegroundColor Yellow
    wsl.exe --list --verbose
}

Write-Host @"

=========================================================
还剩三步（都要你做，因为带 wsl 命令）：

  ① 首次启动，设置 UNIX 用户名密码（建议用户名：k8s）
       wsl -d Ubuntu-24.04
     能进到 shell 就 exit 退出来

  ② 让 systemd 生效（漏了这步 containerd 起不来）
       wsl --shutdown

  ③ 进 WSL 跑初始化
       wsl -d Ubuntu-24.04
       cd /mnt/d/AI算力池实践/1.0/scripts/local
       bash 02_wsl-init.sh
=========================================================
"@ -ForegroundColor Green
