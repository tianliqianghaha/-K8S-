#!/bin/bash
# S1.3 运行时：containerd 2.2.2（Ubuntu 26.04 resolute 源）+ runc 1.4 + crictl 1.37
# 与文档差异：不装 Docker 源 containerd.io（resolute 无该源），用发行版维护的 2.2.2
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# 清掉后台上自动更新抢锁（文档第①类坑）
systemctl stop unattended-upgrades apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
pkill -9 unattended-upgr 2>/dev/null || true
sleep 2

# 若之前被 hold 过（先跑过 k8s 脚本的情况），先解 hold 再装
apt-mark unhold containerd runc >/dev/null 2>&1 || true
apt-get -o DPkg::Lock::Timeout=180 update -qq
apt-get -o DPkg::Lock::Timeout=180 install -y -qq containerd runc >/tmp/s1-runtime-apt.log 2>&1
apt-mark hold containerd runc >/dev/null

mkdir -p /etc/containerd
containerd config default > /etc/containerd/config.toml

# ① cgroup 驱动 systemd（2.x 键位于 cri.v1.runtime.runc.options）
sed -i 's/^\(\s*\)SystemdCgroup = false/\1SystemdCgroup = true/' /etc/containerd/config.toml

# ② 只改 CRI images.registry 的 config_path（第一处；transfer.local 那处不能动）
sed -i "0,/^\(\s*\)config_path = ''/s//\1config_path = '\/etc\/containerd\/certs.d'/" /etc/containerd/config.toml
mkdir -p /etc/containerd/certs.d

# ③ sandbox 镜像：香港直连 registry.k8s.io 可达，保留官方默认 pause:3.10.1
grep -q "pinned_images" /etc/containerd/config.toml || true

systemctl daemon-reload
systemctl enable --now containerd >/dev/null
systemctl restart containerd

if [ ! -x /usr/local/bin/crictl ]; then
  curl -fsSL -o /tmp/crictl.tar.gz \
    https://github.com/kubernetes-sigs/cri-tools/releases/download/v1.37.0/crictl-v1.37.0-linux-amd64.tar.gz
  tar -C /usr/local/bin -xzf /tmp/crictl.tar.gz crictl
fi
cat > /etc/crictl.yaml <<'EOF'
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 20
debug: false
EOF

echo "containerd: $(containerd --version | awk '{print $3}')"
echo "runc: $(runc --version | head -1)"
echo "systemdcgroup: $(grep -c 'SystemdCgroup = true' /etc/containerd/config.toml)"
echo "cri-registry-config_path: $(grep -n "cri.v1.images'.registry" -A2 /etc/containerd/config.toml | grep config_path | tr -s ' ')"
