#!/bin/bash
# 周恢复抽验：把最近一次备份恢复到一个临时 ns，比对标记，然后删掉
set -uo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf
BK=$(kubectl -n velero get backups.velero.io --no-headers --sort-by=.metadata.creationTimestamp 2>/dev/null | tail -1 | awk '{print $1}')
[ -z "$BK" ] && { echo "FAIL 没有可用备份"; exit 1; }
NS=restore-check
kubectl delete ns "$NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1
T0=$(date +%s)
cat <<EOF | kubectl apply -f - >/dev/null 2>&1
apiVersion: velero.io/v1
kind: Restore
metadata: {name: check-$(date +%H%M%S), namespace: velero}
spec:
  backupName: $BK
  includedNamespaces: [demo-app]
  namespaceMapping: {demo-app: $NS}
  restorePVs: false
EOF
for i in $(seq 1 40); do
  m=$(kubectl -n "$NS" get cm marker -o jsonpath='{.data.who}' 2>/dev/null)
  [ "$m" = "k8s20" ] && break; sleep 3
done
T1=$(date +%s)
if [ "$m" = "k8s20" ]; then
  echo "PASS 恢复抽验 backup=$BK 标记=$m 耗时=$((T1-T0))s"
  RES=0
else
  echo "FAIL 恢复抽验 backup=$BK 标记='$m' 耗时=$((T1-T0))s"
  RES=1
fi
kubectl delete ns "$NS" --wait=false >/dev/null 2>&1
exit $RES
