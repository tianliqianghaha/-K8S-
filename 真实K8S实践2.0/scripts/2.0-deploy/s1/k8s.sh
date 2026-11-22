#!/bin/bash
# S1.4 kubeadm 三件套 v1.37
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

systemctl stop unattended-upgrades apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
pkill -9 unattended-upgr 2>/dev/null || true
sleep 2

mkdir -p /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/kubernetes-apt-keyring.gpg ]; then
  curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.37/deb/Release.key | \
    gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  chmod a+r /etc/apt/keyrings/kubernetes-apt-keyring.gpg
fi
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.37/deb/ /" \
  > /etc/apt/sources.list.d/kubernetes.list

apt-get -o DPkg::Lock::Timeout=180 update -qq
apt-get -o DPkg::Lock::Timeout=180 install -y -qq kubelet kubeadm kubectl >/tmp/s1-k8s-apt.log 2>&1

apt-mark hold kubelet kubeadm kubectl containerd runc >/dev/null
systemctl enable kubelet >/dev/null

echo "kubeadm: $(kubeadm version -o short)"
echo "kubectl: $(kubectl version --client -o yaml 2>/dev/null | awk '/gitVersion/{print $2; exit}')"
echo "hold: $(apt-mark showhold | tr '\n' ' ')"
echo "kubelet: enabled=$(systemctl is-enabled kubelet) active=$(systemctl is-active kubelet || true)"
