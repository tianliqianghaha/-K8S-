#!/bin/bash
# 开启 ztunnel（带 bootstrap 根证书）；失败自动回滚
export KUBECONFIG=/etc/kubernetes/admin.conf
set -uo pipefail

if [ ! -f /root/zt-root.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout /root/zt-root.key \
    -out /root/zt-root.crt -days 3650 -subj "/CN=k8s20-ztunnel-root" 2>/dev/null
fi
echo "root CA: $(openssl x509 -in /root/zt-root.crt -noout -subject)"

CUR=$(helm -n kube-system history cilium --max 1 -o json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['revision'])" 2>/dev/null)
echo "当前 revision=$CUR"

helm upgrade cilium cilium/cilium --version 1.20.4 -n kube-system --reuse-values \
  --set encryption.enabled=true --set encryption.type=ztunnel \
  --set-file encryption.ztunnel.secrets.bootstrapRootCert=/root/zt-root.crt \
  --timeout 8m 2>&1 | tail -3

echo "--- 等 secret ---"
for i in $(seq 1 12); do
  kubectl -n kube-system get secret cilium-ztunnel-secrets >/dev/null 2>&1 && break; sleep 5
done
kubectl -n kube-system get secret cilium-ztunnel-secrets --no-headers 2>&1 | head -2

echo "--- 等 agent 与 ztunnel ---"
kubectl -n kube-system rollout status ds/cilium --timeout=6m 2>&1 | tail -2
kubectl -n kube-system rollout status ds/ztunnel-cilium --timeout=6m 2>&1 | tail -2
kubectl -n kube-system get ds --no-headers 2>&1 | grep -E "cilium |ztunnel"

BAD=$(kubectl -n kube-system get pods -l k8s-app=cilium --no-headers 2>/dev/null | grep -c "Init:")
ZT=$(kubectl -n kube-system get ds ztunnel-cilium -o jsonpath='{.status.numberReady}' 2>/dev/null)
echo "agent_init_stuck=$BAD ztunnel_ready=$ZT"

if [ "${ZT:-0}" -lt 8 ] || [ "${BAD:-1}" -gt 0 ]; then
  echo "!!! 未就绪，执行回滚到 $CUR"
  helm rollback cilium "$CUR" -n kube-system --wait --timeout 8m 2>&1 | tail -2
  kubectl -n kube-system rollout status ds/cilium --timeout=6m 2>&1 | tail -1
  echo "回滚后："; kubectl -n kube-system get ds cilium --no-headers 2>&1
  exit 1
fi

echo "=== 加密状态 ==="
kubectl -n kube-system exec ds/cilium -- cilium-dbg status 2>/dev/null | grep -i encrypt | head -3
echo "=== ztunnel 身份 ==="
kubectl -n kube-system exec ds/ztunnel-cilium -c ztunnel -- ztunnel-config workloads 2>/dev/null | head -6
