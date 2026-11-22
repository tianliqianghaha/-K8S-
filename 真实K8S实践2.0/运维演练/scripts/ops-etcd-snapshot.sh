#!/bin/bash
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
