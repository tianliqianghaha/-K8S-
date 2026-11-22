#!/bin/bash
# 日巡检：10 项，输出 PASS/WARN/FAIL。与"42 项交付验收"不同 —— 那个是一次性基线，这个每天跑。
export KUBECONFIG=/etc/kubernetes/admin.conf
P=0; W=0; F=0
row(){ # 级别 名称 实测 期望
  local lv=$1 name=$2 val=$3 exp=$4
  case $lv in PASS) P=$((P+1));; WARN) W=$((W+1));; FAIL) F=$((F+1));; esac
  printf "%-4s %-24s %-14s %s\n" "$lv" "$name" "$val" "$exp"
}
echo "===== 日巡检 $(date '+%F %T') ====="
printf "%-4s %-24s %-14s %s\n" 级别 项目 实测 期望

n=$(kubectl get nodes --no-headers 2>/dev/null | awk '$2=="Ready"' | wc -l)
[ "$n" -ge 8 ] && row PASS 节点Ready "$n/8" "8" || row FAIL 节点Ready "$n/8" "8"

b=$(kubectl get pods -A --no-headers 2>/dev/null | awk '$4!="Running" && $4!="Completed"' | wc -l)
[ "$b" -eq 0 ] && row PASS 异常Pod 0 "0" || row WARN 异常Pod "$b" "0"

e=$(kubectl -n kube-system exec etcd-cp-1 -- etcdctl member list \
   --cacert /etc/kubernetes/pki/etcd/ca.crt --cert /etc/kubernetes/pki/etcd/server.crt \
   --key /etc/kubernetes/pki/etcd/server.key 2>/dev/null | grep -c started)
[ "$e" -eq 3 ] && row PASS etcd成员 3 "3" || row FAIL etcd成员 "$e" "3"

d=$(kubeadm certs check-expiration 2>/dev/null | grep -oE '[0-9]+d' | head -1 | tr -d d)
[ -z "$d" ] && d=999
[ "$d" -gt 90 ] && row PASS 证书剩余 "${d}d" ">90d" || { [ "$d" -gt 30 ] && row WARN 证书剩余 "${d}d" ">90d" || row FAIL 证书剩余 "${d}d" ">90d"; }

cs=$(kubectl get csr 2>/dev/null | grep -c Pending || true)
[ "${cs:-0}" -eq 0 ] && row PASS 待批CSR 0 "0" || row WARN 待批CSR "$cs" "0"

snap=$(ls -t /var/lib/etcd/snapshots/etcd-*.db 2>/dev/null | head -1)
if [ -n "$snap" ]; then
  age=$(( ( $(date +%s) - $(stat -c %Y "$snap") ) / 3600 ))
  [ "$age" -lt 26 ] && row PASS etcd快照 "${age}h前" "<26h" || row FAIL etcd快照 "${age}h前" "<26h"
else row FAIL etcd快照 无 "存在" ; fi

inv=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@172.23.163.111 'ls /data/etcd-backup/etcd-*.db 2>/dev/null | wc -l' 2>/dev/null || echo 0)
[ "${inv:-0}" -ge 1 ] && row PASS 异地留存 "${inv}份" ">=1" || row WARN 异地留存 "${inv}份" ">=1"

bl=$(velero backup get 2>/dev/null | grep -c Completed || true)
[ "${bl:-0}" -ge 1 ] && row PASS Velero备份 "$bl" ">=1" || row WARN Velero备份 0 ">=1"

lh=$(kubectl -n longhorn-system get nodes.longhorn.io -o json 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    vals=[v.get('storageAvailable') for it in d.get('items',[]) for v in (it.get('status',{}).get('diskStatus') or {}).values()]
    vals=[v for v in vals if isinstance(v,int)]
    print(min(vals) if vals else 0)
except Exception: print(0)" 2>/dev/null)
gb=$(( ${lh:-0} / 1024 / 1024 / 1024 ))
[ "$gb" -gt 30 ] && row PASS Longhorn余量 "${gb}G(最小)" ">30G" || row WARN Longhorn余量 "${gb}G(最小)" ">30G"

gw=$(kubectl -n demo-app get gateway eg -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}' 2>/dev/null)
[ "$gw" = "True" ] && row PASS 入口状态 "$gw" "True" || row FAIL 入口状态 "$gw" "True"

echo "----------------------------------------"
echo "PASS=$P WARN=$W FAIL=$F"
[ "$F" -eq 0 ] && exit 0 || exit 1
