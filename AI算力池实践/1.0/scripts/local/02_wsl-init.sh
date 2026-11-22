#!/usr/bin/env bash
# 阶段 C：WSL2 内初始化 —— GPU 直通 → 容器运行时 → K8S 组件
# 在 Ubuntu-24.04 的 shell 里执行：  bash 02_wsl-init.sh
# 幂等：可重复执行，已完成的步骤会跳过。

set -uo pipefail
K8S_MINOR="${K8S_MINOR:-v1.37}"
LOG="/tmp/wsl-init.$(date +%H%M%S).log"

info()  { printf '\n\033[36m=== %s ===\033[0m\n' "$*"; }
ok()    { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m[WARN]\033[0m %s\n' "$*"; }
die()   { printf '  \033[31m[FATAL]\033[0m %s\n' "$*"; exit 1; }
step()  { printf '  -> %s\n' "$*"; }

exec > >(tee -a "$LOG") 2>&1
info "日志：$LOG"

# ---------------------------------------------------------------- 0 环境判定
info "0. 环境判定"
grep -qi microsoft /proc/version && ok "确认在 WSL 内" || die "这脚本必须在 WSL2 里跑"
DISTRO=$(. /etc/os-release && echo "$PRETTY_NAME")
ok "发行版：$DISTRO"
ok "内核：$(uname -r)"
ok "内存：$(free -g | awk '/^Mem:/{print $2"GB 总 / "$7"GB 可用"}')"
CGROUP_FS=$(stat -fc %T /sys/fs/cgroup)
if [ "$CGROUP_FS" = "cgroup2fs" ]; then ok "cgroup v2 已就绪"; else warn "cgroup 类型为 $CGROUP_FS（kubelet 需要 cgroup2）"; fi
if [ "$(id -u)" -eq 0 ]; then die "不要用 root 直接跑，用普通用户 + sudo"; fi

# ---------------------------------------------------------------- 1 systemd
info "1. 启用 systemd"
if [ -d /run/systemd/system ]; then
    ok "systemd 已在运行"
else
    warn "systemd 未运行，写入 /etc/wsl.conf"
    sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true

[interop]
appendWindowsPath=true
EOF
    cat <<'EOF'

  systemd 配置已写入，必须重启 WSL 才能生效：

    在 Windows PowerShell 里执行：  wsl --shutdown
    再重新进入：                  wsl -d Ubuntu-24.04
    然后重新运行本脚本。

EOF
    exit 0
fi

# ---------------------------------------------------------------- 2 apt 源
info "2. 换国内源并更新索引"
SRC_FILE=/etc/apt/sources.list.d/ubuntu.sources
if [ -f "$SRC_FILE" ] && ! grep -q tuna "$SRC_FILE"; then
    sudo cp "$SRC_FILE" "$SRC_FILE.bak"
    sudo sed -i 's|http://archive.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g; s|http://security.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' "$SRC_FILE"
    ok "已切换到清华源（原文件备份 .bak）"
else
    ok "源已是国内源或无需修改"
fi
sudo apt-get update -qq && ok "apt 索引更新完成"

# ---------------------------------------------------------------- 3 GPU 闸门
info "3. GPU 直通闸门（这一步不过，后面全部无意义）"
if command -v nvidia-smi >/dev/null 2>&1; then
    if nvidia-smi >/dev/null 2>&1; then
        ok "nvidia-smi 可用"
        nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | sed 's/^/     /'
    else
        die "nvidia-smi 存在但执行失败 —— 检查 Windows 端驱动是否为 560+ 且 WSL 未禁用 GPU"
    fi
else
    if [ -x /usr/lib/wsl/lib/nvidia-smi ]; then
        warn "nvidia-smi 不在 PATH，临时接入 /usr/lib/wsl/lib"
        export PATH="/usr/lib/wsl/lib:$PATH"
        nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/     /'
    else
        die "找不到 nvidia-smi —— WSL 的 GPU 通道没打开"
    fi
fi

# ---------------------------------------------------------------- 4 基础包
info "4. 基础工具"
sudo apt-get install -y -qq \
    curl ca-certificates gnupg lsb-release jq socat conntrack \
    iptables iproute2 ethtool ca-certificates apt-transport-https >/dev/null
ok "基础工具就绪"

# ---------------------------------------------------------------- 5 nvidia-container-toolkit
info "5. nvidia-container-toolkit"
if command -v nvidia-ctk >/dev/null 2>&1; then
    ok "已安装：$(nvidia-ctk --version 2>/dev/null | head -1)"
else
    step "添加 NVIDIA 容器仓库"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -sL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#^deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq nvidia-container-toolkit >/dev/null
    ok "nvidia-container-toolkit 安装完成"
fi

# WSL2 必须关闭 cgroups 管理，否则容器起不来
NVRTC_CFG=/etc/nvidia-container-runtime/config.toml
if [ -f "$NVRTC_CFG" ]; then
    if grep -qE '^no-cgroups\s*=\s*false' "$NVRTC_CFG"; then
        sudo sed -i 's/^no-cgroups\s*=\s*false/no-cgroups = true/' "$NVRTC_CFG"
        ok "已设 no-cgroups = true（WSL2 必需）"
    elif grep -qE '^no-cgroups\s*=\s*true' "$NVRTC_CFG"; then
        ok "no-cgroups 已是 true"
    else
        echo 'no-cgroups = true' | sudo tee -a "$NVRTC_CFG" >/dev/null
        ok "已追加 no-cgroups = true"
    fi
fi

# ---------------------------------------------------------------- 6 containerd
info "6. containerd + NVIDIA runtime"
if ! command -v containerd >/dev/null 2>&1; then
    sudo apt-get install -y -qq containerd >/dev/null
    ok "containerd 安装完成"
else
    ok "containerd 已存在：$(containerd --version | awk '{print $3}')"
fi

if [ ! -f /etc/containerd/config.toml ] || ! grep -q 'nvidia' /etc/containerd/config.toml 2>/dev/null; then
    step "生成默认配置并注入 NVIDIA runtime"
    sudo mkdir -p /etc/containerd
    containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
    sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
    sudo nvidia-ctk runtime configure --runtime=containerd >/dev/null 2>&1 \
        && ok "NVIDIA runtime 已注入" \
        || warn "nvidia-ctk configure 失败，稍后手工检查 /etc/containerd/config.toml"
else
    ok "containerd 配置里已有 nvidia runtime"
fi
sudo systemctl enable --now containerd >/dev/null 2>&1
systemctl is-active --quiet containerd && ok "containerd 运行中" || die "containerd 启动失败：journalctl -u containerd -n 30"

# ---------------------------------------------------------------- 7 容器内 GPU 验证
info "7. 容器内 GPU 验证（第二道闸门）"
if command -v nerdctl >/dev/null 2>&1; then
    if sudo nerdctl run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null; then
        ok "容器内可见 GPU（CDI/nvidia runtime 生效）"
    else
        warn "容器内看不到 GPU —— 先继续，K8S 侧会再验证一次"
    fi
else
    warn "未装 nerdctl，跳过容器验证（后续由 kubelet + device plugin 验证）"
fi

# ---------------------------------------------------------------- 8 K8S 组件
info "8. K8S 组件 $K8S_MINOR"
if command -v kubelet >/dev/null 2>&1; then
    ok "已安装：$(kubelet --version)"
else
    step "添加 pkgs.k8s.io 仓库（$K8S_MINOR）"
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL "https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/Release.key" \
        | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
    echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/ /" \
        | sudo tee /etc/apt/sources.list.d/kubernetes.list >/dev/null
    sudo apt-get update -qq || die "k8s 仓库不可达（检查 ${K8S_MINOR} 是否存在）"
    sudo apt-get install -y -qq kubelet kubeadm kubectl >/dev/null
    sudo apt-mark hold kubelet kubeadm kubectl >/dev/null
    ok "安装完成：$(kubelet --version)"
fi

# WSL2 有 swap，kubelet 默认会拒绝启动
KL_CFG=/etc/default/kubelet
if [ -f "$KL_CFG" ] && grep -q 'fail-swap-on' "$KL_CFG"; then
    ok "kubelet 启动参数已配"
else
    echo 'KUBELET_EXTRA_ARGS="--fail-swap-on=false --node-ip=$(hostname -I | awk "{print \$1}")"' | sudo tee "$KL_CFG" >/dev/null
    ok "已写 $KL_CFG（含 --fail-swap-on=false）"
fi
sudo systemctl disable --now kubelet >/dev/null 2>&1
ok "kubelet 已安装但暂不启动（等 join 时再起）"

# ---------------------------------------------------------------- 9 Tailscale
info "9. Tailscale"
if command -v tailscale >/dev/null 2>&1; then
    ok "已安装：$(tailscale version | head -1)"
else
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1 \
        && ok "安装完成" || warn "Tailscale 安装失败，稍后手工处理（可换 frp/SSH 反向隧道）"
fi

# ---------------------------------------------------------------- 10 汇总
info "10. 汇总"
printf '  %-28s %s\n' "GPU"            "$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo '不可用')"
printf '  %-28s %s\n' "containerd"     "$(containerd --version 2>/dev/null | awk '{print $3}')"
printf '  %-28s %s\n' "kubelet"        "$(kubelet --version 2>/dev/null | awk '{print $2}')"
printf '  %-28s %s\n' "kubeadm"        "$(kubeadm version -o short 2>/dev/null)"
printf '  %-28s %s\n' "tailscale"      "$(tailscale version 2>/dev/null | head -1 || echo '未装')"
printf '  %-28s %s\n' "cgroup"         "$(stat -fc %T /sys/fs/cgroup)"
printf '  %-28s %s\n' "swap"           "$(free -g | awk '/^Swap:/{print $2"GB"}')"

cat <<'EOF'

---------------------------------------------------------
本地环境三道闸门：
  ① WSL2 能跑 systemd          → systemctl is-system-running
  ② 宿主 GPU 能透进来          → nvidia-smi
  ③ 容器里能看到 GPU           → nerdctl run --gpus all ...

三道全过，才轮到"加入云上集群"。
EOF
