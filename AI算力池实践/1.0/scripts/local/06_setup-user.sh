#!/usr/bin/env bash
# 阶段 B2：导入后的首次配置（以 root 身份运行）
#   wsl -d Ubuntu-24.04 -u root
#   cd /mnt/d/AI算力池实践/1.0/scripts/local && bash 06_setup-user.sh
# 作用：换源 → 建日常用户 → 开 systemd → 设默认用户

set -uo pipefail
NEWUSER="${NEWUSER:-k8s}"

info() { printf '\n\033[36m=== %s ===\033[0m\n' "$*"; }
ok()   { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m[FATAL]\033[0m %s\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "必须以 root 运行：wsl -d Ubuntu-24.04 -u root"

info "0. 系统信息"
. /etc/os-release && ok "$PRETTY_NAME"
ok "内核 $(uname -r)"

info "1. 换国内源"
CHANGED=0
for f in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    if [ -f "$f" ] && ! grep -q tuna "$f"; then
        cp "$f" "$f.bak"
        sed -i 's|http://archive.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g; s|http://security.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g; s|http://ports.ubuntu.com/ubuntu-ports|https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports|g' "$f"
        CHANGED=1
        ok "已处理 $f"
    fi
done
[ "$CHANGED" -eq 0 ] && ok "源无需修改"

info "2. 更新索引"
apt-get update -qq && ok "完成" || warn "update 有告警，继续"

info "3. 基础包"
apt-get install -y -qq sudo ca-certificates curl gnupg lsb-release >/dev/null 2>&1
ok "sudo 等基础包就绪"

info "4. 创建用户 $NEWUSER"
if id "$NEWUSER" >/dev/null 2>&1; then
    ok "用户已存在"
else
    useradd -m -s /bin/bash -G sudo "$NEWUSER" || die "创建用户失败"
    ok "已创建 $NEWUSER（家目录 /home/$NEWUSER）"
fi

if [ ! -f "/etc/sudoers.d/90-$NEWUSER" ]; then
    echo "$NEWUSER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$NEWUSER"
    chmod 440 "/etc/sudoers.d/90-$NEWUSER"
    ok "已配置 sudo 免密"
else
    ok "sudo 配置已存在"
fi

info "5. 写 /etc/wsl.conf（systemd + 默认用户）"
cat > /etc/wsl.conf <<EOF
[boot]
systemd=true

[user]
default=$NEWUSER

[interop]
appendWindowsPath=true
EOF
ok "已写入"

info "6. 检查 sudo 密码状态"
if passwd -S "$NEWUSER" 2>/dev/null | grep -q " L "; then
    warn "用户 $NEWUSER 当前为锁定状态（未设密码）。sudo 已免密，可正常使用。"
    warn "若你希望设置密码，执行：  passwd $NEWUSER"
else
    ok "密码状态正常"
fi

cat <<EOF

=========================================================
下一步（必须做）：

  退出当前 shell（exit），然后在 Windows PowerShell 里执行：

     wsl --shutdown

  等 10 秒，再以普通用户进入：

     wsl -d Ubuntu-24.04

  进去后确认两件事：

     id -un                 → 应显示 $NEWUSER
     systemctl is-system-running   → 应显示 running 或 degraded

  两条都对，就继续跑初始化：

     cd /mnt/d/AI算力池实践/1.0/scripts/local
     bash 02_wsl-init.sh
=========================================================
EOF
