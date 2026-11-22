# 阶段 B（离线通道二）：用 Canonical 的 .wsl 镜像安装 Ubuntu 24.04
# 适用：wsl --install -d 无法从 GitHub 取分发清单（WININET_E_CANNOT_CONNECT）
# 不需要管理员权限

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$img        = "C:\Users\520\AppData\Local\Temp\wsl-install\noble-wsl-amd64.wsl"
$distroName = "Ubuntu-24.04"
$installDir = "C:\WSL\Ubuntu-24.04"
$expected   = "BB415D824822C4B878125729AF451A5D18FB13D1CF5CBED9A7393AD64AC6039E"

Write-Host "=== 1. 校验镜像 ===" -ForegroundColor Cyan
if (-not (Test-Path $img)) {
    Write-Host "[FATAL] 找不到 $img" -ForegroundColor Red
    exit 1
}
$fi = Get-Item $img
Write-Host ("  大小: {0:N1} MB" -f ($fi.Length / 1MB))
Write-Host "  正在计算 SHA256（371MB，约 5-15 秒）..."
$hash = (Get-FileHash -Path $img -Algorithm SHA256).Hash
Write-Host "  实得: $hash"
Write-Host "  期望: $expected"
if ($hash -ne $expected) {
    Write-Host "[FATAL] 哈希不匹配，文件可能损坏，请重新下载" -ForegroundColor Red
    exit 1
}
Write-Host "  ✅ 校验通过" -ForegroundColor Green

Write-Host "`n=== 2. 检查是否已存在同名发行版 ===" -ForegroundColor Cyan
$list = wsl.exe --list --quiet 2>$null
if ($list -match [regex]::Escape($distroName)) {
    Write-Host "  已存在 $distroName，跳过安装" -ForegroundColor Yellow
    wsl.exe --list --verbose
    exit 0
}
Write-Host "  未安装，继续"

Write-Host "`n=== 3. 安装（依次尝试两种方式）===" -ForegroundColor Cyan

function Test-Installed {
    $l = wsl.exe --list --quiet 2>$null
    return ($l -match [regex]::Escape($distroName))
}

Write-Host "  [方式 A] wsl --install --from-file" -ForegroundColor White
wsl.exe --install --from-file $img --name $distroName 2>&1 | ForEach-Object { "    $_" }
if (Test-Installed) {
    Write-Host "  ✅ 方式 A 成功" -ForegroundColor Green
} else {
    Write-Host "  方式 A 未生效，改试方式 B" -ForegroundColor Yellow

    Write-Host "  [方式 B] wsl --import（指定安装到 D 盘）" -ForegroundColor White
    if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
    wsl.exe --import $distroName $installDir $img --version 2 2>&1 | ForEach-Object { "    $_" }

    if (Test-Installed) {
        Write-Host "  ✅ 方式 B 成功" -ForegroundColor Green
    } else {
        Write-Host "[FATAL] 两种方式都没成功。" -ForegroundColor Red
        Write-Host "  请把上面的输出发给我。" -ForegroundColor Yellow
        exit 1
    }
}

Write-Host "`n=== 4. 结果 ===" -ForegroundColor Cyan
wsl.exe --list --verbose

Write-Host @"

=========================================================
Ubuntu 已就位。接下来三步（都要你做）：

  ① 以 root 进入，创建日常用户并开 systemd
       wsl -d Ubuntu-24.04 -u root
       cd /mnt/d/AI算力池实践/1.0/scripts/local
       bash 06_setup-user.sh

  ② 让 systemd 与默认用户生效
       wsl --shutdown

  ③ 以普通用户进入，跑初始化
       wsl -d Ubuntu-24.04
       cd /mnt/d/AI算力池实践/1.0/scripts/local
       bash 02_wsl-init.sh
=========================================================
"@ -ForegroundColor Green
