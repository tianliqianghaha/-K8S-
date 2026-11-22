# 阶段 B（离线通道）：用已下载的 msixbundle 安装 WSL
# 适用：GitHub 直连不通、商店不提供该应用时
# 不需要管理员权限（per-user 安装）

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# 该包内嵌 Windows 服务，安装打包服务需要管理员权限（0x80073D28）
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "需要管理员权限，正在请求提权（会弹 UAC，请点『是』）..." -ForegroundColor Yellow
    $argList = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    try {
        Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $argList -Verb RunAs
    } catch {
        Write-Host "[FATAL] 提权被拒绝：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "        请手动以管理员身份打开 PowerShell，再运行本脚本。" -ForegroundColor Yellow
    }
    exit
}

$msix = "C:\Users\520\AppData\Local\Temp\wsl-install\Microsoft.WSL_3.0.5.0.msixbundle"

Write-Host "=== 1. 校验安装包 ===" -ForegroundColor Cyan
if (-not (Test-Path $msix)) {
    Write-Host "[FATAL] 找不到 $msix" -ForegroundColor Red
    exit 1
}
$fi = Get-Item $msix
$sizeMB = [math]::Round($fi.Length / 1MB, 1)
Write-Host "  路径: $($fi.FullName)"
Write-Host "  大小: $sizeMB MB"
if ($fi.Length -lt 300MB) {
    Write-Host "[FATAL] 文件偏小，可能下载不完整。请重新下载。" -ForegroundColor Red
    exit 1
}

Write-Host "`n=== 2. 检查是否已安装 ===" -ForegroundColor Cyan
$existing = Get-AppxPackage -Name "MicrosoftCorporationII.WindowsSubsystemForLinux" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  已安装版本: $($existing.Version) —— 跳过安装" -ForegroundColor Yellow
} else {
    Write-Host "`n=== 3. 安装 ===" -ForegroundColor Cyan
    try {
        Add-AppxPackage -Path $msix -ErrorAction Stop
        Write-Host "  安装命令执行完成" -ForegroundColor Green
    } catch {
        Write-Host "[FATAL] 安装失败：" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        Write-Host "  常见原因与对策：" -ForegroundColor Yellow
        Write-Host "    0x80073CF3 依赖缺失 → 需要 VCLibs，见下方命令" -ForegroundColor White
        Write-Host "    0x80073D02 包正在被占用 → 先 wsl --shutdown 再试" -ForegroundColor White
        Write-Host "    0x80073CF9 注册失败 → 换用管理员 PowerShell 再跑一次" -ForegroundColor White
        exit 1
    }
}

Write-Host "`n=== 4. 验证注册 ===" -ForegroundColor Cyan
$pkg = Get-AppxPackage -Name "MicrosoftCorporationII.WindowsSubsystemForLinux" -ErrorAction SilentlyContinue
if ($pkg) {
    Write-Host "  包名:     $($pkg.Name)"
    Write-Host "  版本:     $($pkg.Version)"
    Write-Host "  安装位置: $($pkg.InstallLocation)"
    Write-Host "  ✅ WSL 平台包已注册" -ForegroundColor Green
} else {
    Write-Host "  [FATAL] 注册表里查不到该包，安装没生效" -ForegroundColor Red
    exit 1
}

Write-Host @"

=========================================================
下一步（需要你执行，因为带 wsl 命令）：

  ① 确认版本（应显示 WSL 3.x）
       wsl --version

  ② 设为默认 WSL2
       wsl --set-default-version 2

  ③ 装 Ubuntu 24.04
       wsl --install -d Ubuntu-24.04 --no-launch

  ④ 首次进入设置用户名密码（建议 k8s）
       wsl -d Ubuntu-24.04

  ⑤ 让 systemd 生效
       wsl --shutdown

  ⑥ 进 WSL 跑初始化
       wsl -d Ubuntu-24.04
       cd /mnt/d/AI算力池实践/1.0/scripts/local
       bash 02_wsl-init.sh

若 ③ 也因网络失败（它要下发行版），告诉我，我用同样的镜像方式处理。
=========================================================
"@ -ForegroundColor Green
