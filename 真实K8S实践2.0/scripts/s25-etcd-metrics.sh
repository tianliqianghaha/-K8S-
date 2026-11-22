#!/usr/bin/env bash
# 第 8 章 · 给 etcd 打开 metrics 端点（Prometheus 才能监控 etcd）
# 幂等：已存在该参数则跳过；逐个控制面执行，etcd 不会同时挂
set -uo pipefail

ETCD_MANIFEST="/etc/kubernetes/manifests/etcd.yaml"
FLAG="--listen-metrics-urls=http://0.0.0.0:2381"

if grep -q "listen-metrics-urls=http://0.0.0.0:2381" "${ETCD_MANIFEST}"; then
  echo "[skip] 已监听 0.0.0.0:2381"
elif grep -q "listen-metrics-urls" "${ETCD_MANIFEST}"; then
  # kubeadm 默认只监听 127.0.0.1，Prometheus 从节点 IP 抓不到，必须改回 0.0.0.0
  cp "${ETCD_MANIFEST}" "/root/etcd.yaml.bak-$(date +%s)"   # 备份绝不能留在 staticPodPath 内
  sed -i 's#--listen-metrics-urls=http://127.0.0.1:2381#--listen-metrics-urls=http://0.0.0.0:2381#' "${ETCD_MANIFEST}"
  echo "[fix] 127.0.0.1 -> 0.0.0.0，等待 etcd 重启"
  for i in $(seq 1 30); do
    sleep 4
    if curl -sf --max-time 2 "http://$(hostname -I | awk '{print $1}'):2381/health" >/dev/null 2>&1; then
      echo "[ok] 节点 IP 可访问 metrics（$((i*4))s）"
      break
    fi
  done
else
  cp "${ETCD_MANIFEST}" "/root/etcd.yaml.bak-$(date +%s)"   # 备份绝不能留在 staticPodPath 内
  python3 - <<'PY'
import pathlib
p = pathlib.Path("/etc/kubernetes/manifests/etcd.yaml")
s = p.read_text()
anchor = "    - --listen-client-urls=https://127.0.0.1:2379,https://"
if anchor not in s:
    raise SystemExit("未找到 --listen-client-urls，需人工确认清单结构")
s = s.replace(anchor, "    - --listen-metrics-urls=http://0.0.0.0:2381\n" + anchor, 1)
p.write_text(s)
print("manifest updated")
PY
  echo "[apply] 已插入 ${FLAG}，等待 etcd 重启"
  for i in $(seq 1 30); do
    sleep 4
    if curl -sf --max-time 2 "http://$(hostname -I | awk '{print $1}'):2381/health" >/dev/null 2>&1; then
      echo "[ok] 节点 IP 可访问 metrics（$((i*4))s）"
      break
    fi
  done
fi

echo "--- 本机 metrics 自检 ---"
curl -s --max-time 3 http://127.0.0.1:2381/metrics | grep -E '^etcd_server_has_leader|^etcd_server_leader_changes_seen_total' | head -2
echo "--- 集群成员健康 ---"
export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl -n kube-system exec etcd-cp-1 -- etcdctl endpoint health --cluster \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/server.crt \
  --key /etc/kubernetes/pki/etcd/server.key 2>&1 | tail -3
