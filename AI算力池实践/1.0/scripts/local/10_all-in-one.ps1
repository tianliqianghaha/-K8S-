# 全流程：导入 Ubuntu → 建用户/systemd → WSL 内初始化
# 前提：wsl.exe 不在安全黑名单中；noble-wsl-amd64.wsl 已下载并通过校验
# 执行者：自动化（无需人工干预）

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$img        = "C:\Users\520\AppData\Local\Temp\wsl-install\noble-wsl-amd64.wsl"
$distroName = "Ubuntu-24.04"
$installDir = "C:\WSL\Ubuntu-24.04"
$expected   = "BB415D824822C4B878125729AF451A5D18FB13D1CF5CBED9A7393AD64AC6039E"
$scriptsDir = "D:\AI算力池实践\1.0\scripts\local"

$stateDir = "D:\AI算力池实践\1.0\state"
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
$logPath = Join-Path $stateDir ("local-setup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $logPath -Force | Out-Null
Write-Host "日志: $logPath" -ForegroundColor DarkGray

function Step($n, $t) { Write-Host "`n=== $n. $t ===" -ForegroundColor Cyan }
function OK($m)       { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m)     { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail($m)     { Write-Host "  [FAIL] $m" -ForegroundColor Red }

# ---------------------------------------------------------------- 1 校验
Step 1 "校验镜像"
if (-not (Test-Path $img)) { Fail "找不到 $img"; exit 1 }
$len = (Get-Item $img).Length
Write-Host ("  大小 {0:N0} 字节 ({1:N1} MB)" -f $len, ($len / 1MB))
$hash = (Get-FileHash $img -Algorithm SHA256).Hash
if ($hash -ne $expected) { Fail "SHA256 不匹配: $hash"; exit 1 }
OK "SHA256 匹配"

# ---------------------------------------------------------------- 2 导入
Step 2 "导入发行版"
$existing = (wsl.exe --list --quiet 2>$null) -join ","
if ($existing -match [regex]::Escape($distroName)) {
    Warn "$distroName 已存在，跳过导入"
} else {
    Write-Host "  [A] wsl --install --from-file"
    wsl.exe --install --from-file $img --name $distroName 2>&1 | ForEach-Object { "      $_" }
    $after = (wsl.exe --list --quiet 2>$null) -join ","
    if ($after -notmatch [regex]::Escape($distroName)) {
        Write-Host "  [B] wsl --import -> $installDir"
        if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
        wsl.exe --import $distroName $installDir $img --version 2 2>&1 | ForEach-Object { "      $_" }
    }
}
$after = (wsl.exe --list --quiet 2>$null) -join ","
if ($after -notmatch [regex]::Escape($distroName)) { Fail "导入失败"; exit 1 }
OK "已注册 $distroName"

# ---------------------------------------------------------------- 3 建用户 + systemd
Step 3 "以 root 执行 06_setup-user.sh"
wsl.exe -d $distroName -u root -- bash -lc "cd /mnt/d/AI算力池实践/1.0/scripts/local && bash 06_setup-user.sh" 2>&1 | ForEach-Object { "  $_" }

# ---------------------------------------------------------------- 4 重启实例
Step 4 "wsl --shutdown 使 systemd 生效"
wsl.exe --shutdown
Start-Sleep -Seconds 8
OK "已重启实例"

# ---------------------------------------------------------------- 5 WSL 内初始化
Step 5 "以 k8s 执行 02_wsl-init.sh"
wsl.exe -d $distroName -u k8s -- bash -lc "cd /mnt/d/AI算力池实践/1.0/scripts/local && bash 02_wsl-init.sh" 2>&1 | ForEach-Object { "  $_" }

$sd = ((wsl.exe -d $distroName -u k8s -- bash -lc "systemctl is-system-running" 2>&1) -join ' ').Trim()
if ($sd -notmatch 'running|degraded') {
    Warn "systemd 未就绪（当前: $sd），再 shutdown 一次后重试 02"
    wsl.exe --shutdown
    Start-Sleep -Seconds 12
    wsl.exe -d $distroName -u k8s -- bash -lc "cd /mnt/d/AI算力池实践/1.0/scripts/local && bash 02_wsl-init.sh" 2>&1 | ForEach-Object { "  $_" }
} else {
    OK "systemd: $sd"
}

# ---------------------------------------------------------------- 6 三道闸门
Step 6 "三道闸门复验"
$gates = @(
    @{ n = 'systemd'; cmd = "systemctl is-system-running" },
    @{ n = 'GPU';     cmd = "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader" },
    @{ n = 'cgroup';  cmd = "stat -fc %T /sys/fs/cgroup" }
)
foreach ($g in $gates) {
    $out = (wsl.exe -d $distroName -u k8s -- bash -lc $g.cmd 2>&1) -join ' '
    Write-Host ("  {0,-8} {1}" -f $g.n, $out.Trim())
}
""
wsl.exe -d $distroName -u k8s -- bash -lc "containerd --version; kubelet --version; tailscale version | head -1; free -g | head -2"

Write-Host "`n日志已保存: $logPath" -ForegroundColor Green
Stop-Transcript | Out-Null
