#!/usr/bin/env bash
# 第 8 章 · 让 etcd 静态 Pod 重读清单（安全版）
# 关键：备份文件必须移出 staticPodPath，否则 kubelet 会把它当成第二个 etcd 清单解析
set -uo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf

echo "=== 清理 staticPodPath 内的非清单备份 ==="
find /etc/kubernetes/manifests -maxdepth 1 -type f \( -name '*.bak' -o -name '*.bak-*' -o -name '*.orig' \) -print -exec mv {} /root/ \;

echo "=== 触发 kubelet 重读 ==="
touch /etc/kubernetes/manifests/etcd.yaml

NODE_IP=$(hostname -I | awk '{print $1}')
for i in $(seq 1 30); do
  sleep 4
  if curl -sf --max-time 2 "http://${NODE_IP}:2381/health" >/dev/null 2>&1; then
    echo "[ok] ${NODE_IP}:2381 可访问（$((i*4))s）"
    break
  fi
done

echo "=== 当前参数 ==="
CID=$(crictl ps --name etcd -q | head -1)
crictl inspect "${CID}" 2>/dev/null | grep -o 'listen-metrics-urls=[^"]*' | head -1
ss -lnt | grep 2381
