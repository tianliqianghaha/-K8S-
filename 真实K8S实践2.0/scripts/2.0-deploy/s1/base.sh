#!/bin/bash
# S1.1 系统基线（26.04 适配版）· 本次 10 台拓扑
set -uo pipefail
HN="$1"

swapoff -a 2>/dev/null || true
sed -i '/\sswap\s/s/^/#/' /etc/fstab
systemctl mask swap.target >/dev/null 2>&1 || true

ufw disable 2>/dev/null || true

timedatectl set-timezone Asia/Shanghai
apt-get install -y -qq chrony >/dev/null 2>&1 || true
systemctl enable --now chrony >/dev/null 2>&1 || true
timedatectl set-ntp true

hostnamectl set-hostname "$HN"

# cloud-init 别再改回去
if [ -f /etc/cloud/cloud.cfg ]; then
  grep -q '^preserve_hostname: true' /etc/cloud/cloud.cfg || echo 'preserve_hostname: true' >> /etc/cloud/cloud.cfg
  sed -i 's/^manage_etc_hosts: true/manage_etc_hosts: false/' /etc/cloud/cloud.cfg || true
fi

if [ -f /tmp/hosts.new ]; then cat /tmp/hosts.new > /etc/hosts; fi

systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
pkill -9 unattended-upgr 2>/dev/null || true

echo "base-done: $(hostname) $(hostname -I | awk '{print $1}')"
