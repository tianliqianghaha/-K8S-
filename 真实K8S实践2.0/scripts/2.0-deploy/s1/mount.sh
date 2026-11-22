#!/bin/bash
# 数据盘挂到 MNT（默认 /var/lib/longhorn；infra/spare 用 /data）
set -euo pipefail
DEV=/dev/vdb
MNT=${MNT:-/var/lib/longhorn}

if mountpoint -q "$MNT"; then echo "already mounted: $MNT"; exit 0; fi
if ! blkid "$DEV" >/dev/null 2>&1; then
  mkfs.ext4 -F -L data "$DEV" >/dev/null
fi
mkdir -p "$MNT"
UUID=$(blkid -s UUID -o value "$DEV")
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $MNT ext4 defaults,noatime 0 2" >> /etc/fstab
mount "$MNT"
echo "mounted $(df -h "$MNT" | tail -1 | awk '{print $2" total, "$4" free"') on $MNT"
