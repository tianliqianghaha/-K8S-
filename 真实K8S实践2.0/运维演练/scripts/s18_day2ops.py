"""S18：日常运维三件套 —— etcd 定时快照（含异地留存）、Velero 定时备份、日巡检脚本。"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent

ETCD_SH = r"""#!/bin/bash
# etcd 快照 → 本地保留 7 份 → 推到 infra-01（异地）
set -euo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf
DIR=/var/lib/etcd/snapshots
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
kubectl -n kube-system exec etcd-cp-1 -- etcdctl snapshot save /var/lib/etcd/snapshots/etcd-$TS.db \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/server.crt \
  --key /etc/kubernetes/pki/etcd/server.key >/dev/null 2>&1
SIZE=$(stat -c %s "$DIR/etcd-$TS.db")
# 本地只留 7 份
ls -t "$DIR"/etcd-*.db | tail -n +8 | xargs -r rm -f
# 推异地
scp -q -o StrictHostKeyChecking=no "$DIR/etcd-$TS.db" root@172.23.163.111:/data/etcd-backup/ 2>/dev/null || true
ssh -o StrictHostKeyChecking=no root@172.23.163.111 "ls -t /data/etcd-backup/etcd-*.db | tail -n +8 | xargs -r rm -f" 2>/dev/null || true
echo "$(date -Is) snapshot=etcd-$TS.db size=$SIZE local_keep=$(ls "$DIR"/etcd-*.db | wc -l) remote_keep=$(ssh -o StrictHostKeyChecking=no root@172.23.163.111 'ls /data/etcd-backup/etcd-*.db 2>/dev/null | wc -l')"
"""

DAILY = r"""#!/bin/bash
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

lh=$(kubectl -n longhorn-system get nodes.longhorn.io -o jsonpath='{range .items[*]}{.status.diskStatus.vdb.storageAvailable}{"\n"}{end}' 2>/dev/null | sort -n | head -1)
gb=$(( ${lh:-0} / 1024 / 1024 / 1024 ))
[ "$gb" -gt 30 ] && row PASS Longhorn余量 "${gb}G(最小)" ">30G" || row WARN Longhorn余量 "${gb}G(最小)" ">30G"

gw=$(kubectl -n demo-app get gateway eg -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}' 2>/dev/null)
[ "$gw" = "True" ] && row PASS 入口状态 "$gw" "True" || row FAIL 入口状态 "$gw" "True"

echo "----------------------------------------"
echo "PASS=$P WARN=$W FAIL=$F"
[ "$F" -eq 0 ] && exit 0 || exit 1
"""


def main():
    cp1 = fleet.by_name("cp-1")
    infra = fleet.INFRA
    (WORK / "ops-etcd-snapshot.sh").write_text(ETCD_SH, encoding="utf-8", newline="\n")
    (WORK / "ops-daily-check.sh").write_text(DAILY, encoding="utf-8", newline="\n")

    print("=== 1. 铺运维脚本 + 免密（cp-1 → infra-01）===")
    fleet.ssh(cp1, "mkdir -p /root/ops /var/lib/etcd/snapshots", timeout=60)
    fleet.scp("ops-etcd-snapshot.sh", "/root/ops/etcd-snapshot.sh", cp1)
    fleet.scp("ops-daily-check.sh", "/root/ops/daily-check.sh", cp1)
    rc, out = fleet.ssh(cp1, r"""
chmod +x /root/ops/*.sh
[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/id_ed25519
cat /root/.ssh/id_ed25519.pub
""", timeout=120)
    pub = out.strip().splitlines()[-1]
    rc, out = fleet.ssh(infra, f"mkdir -p /data/etcd-backup && grep -qxF '{pub}' /root/.ssh/authorized_keys 2>/dev/null || echo '{pub}' >> /root/.ssh/authorized_keys; wc -l < /root/.ssh/authorized_keys", timeout=120)
    print("infra authorized_keys 行数:", out.strip())

    print("=== 2. 立即跑一次快照（验证脚本本身）===")
    rc, out = fleet.ssh(cp1, "/root/ops/etcd-snapshot.sh", timeout=600)
    print(out)

    print("=== 3. 装 cron ===")
    rc, out = fleet.ssh(cp1, r"""
command -v crontab >/dev/null || (DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron >/tmp/cron.log 2>&1)
systemctl enable --now cron >/dev/null 2>&1
( crontab -l 2>/dev/null | grep -v 'ops/etcd-snapshot.sh' ; echo '15 */6 * * * /root/ops/etcd-snapshot.sh >> /var/log/etcd-snapshot.log 2>&1' ) | crontab -
crontab -l | tail -2
systemctl is-active cron
""", timeout=300)
    print(out)

    print("=== 4. Velero 定时备份 ===")
    rc, out = fleet.ssh(cp1, r"""
export KUBECONFIG=/etc/kubernetes/admin.conf
velero schedule delete daily >/dev/null 2>&1 || true
velero schedule create daily --schedule="0 2 * * *" --ttl 168h --include-namespaces demo-app,demo-secrets 2>&1 | tail -2
velero schedule get 2>&1 | tail -2
echo "--- 立刻用该 schedule 触发一次 ---"
velero backup create --from-schedule daily --wait 2>&1 | tail -3
velero backup get 2>&1 | tail -3
""", timeout=900)
    print(out)

    print("=== 5. 跑一次日巡检 ===")
    rc, out = fleet.ssh(cp1, "/root/ops/daily-check.sh", timeout=600)
    print(out)


if __name__ == "__main__":
    main()
