#!/bin/bash
# S1.2 内核基线：模块 / sysctl / THP
set -euo pipefail

cat > /etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
nf_conntrack
EOF
modprobe overlay
modprobe br_netfilter
modprobe nf_conntrack

cat > /etc/sysctl.d/99-kubernetes.conf <<'EOF'
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
net.netfilter.nf_conntrack_max      = 1048576
fs.inotify.max_user_watches         = 524288
fs.inotify.max_user_instances       = 512
EOF
sysctl --system >/dev/null

cat > /etc/systemd/system/disable-thp.service <<'EOF'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=kubelet.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now disable-thp.service >/dev/null

echo "kernel-done: $(hostname) fwd=$(sysctl -n net.ipv4.ip_forward) bnf=$(sysctl -n net.bridge.bridge-nf-call-iptables) thp=$(grep -o '\[never\]' /sys/kernel/mm/transparent_hugepage/enabled || echo NOT-SET)"
