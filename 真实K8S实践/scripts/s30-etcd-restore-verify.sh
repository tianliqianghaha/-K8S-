#!/usr/bin/env bash
# 第 9 章 · etcd 快照可恢复性验证（不动生产集群）
# 做法：同版本 etcd 镜像在节点上起独立实例，再从一次性容器里用 etcdctl 读回业务对象
# 要点：ctr 起的进程与 SSH 会话同生共死，必须同一条命令里「起 -> 查 -> 停」
set -uo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf

SNAP_DIR=/var/backups/etcd
WORK=/var/tmp/etcd-restore
IMAGE=registry.k8s.io/etcd:3.7.0-0
PORT=12379
PEER=12380
NAME=restored-etcd
EP=http://127.0.0.1:${PORT}

SNAP=$(ls -t ${SNAP_DIR}/*.db | head -1)
echo "=== 快照 ==="
ls -lh "${SNAP}"

echo "=== 清理旧现场 ==="
ctr -n k8s.io task kill -s SIGKILL "${NAME}" >/dev/null 2>&1
ctr -n k8s.io container rm "${NAME}" >/dev/null 2>&1
rm -rf "${WORK}"; mkdir -p "${WORK}/data"

echo "=== 1. 恢复快照到本地目录 ==="
ctr -n k8s.io run --rm \
  --mount type=bind,src="${SNAP_DIR}",dst=/snap,options=rbind:ro \
  --mount type=bind,src="${WORK}",dst=/out,options=rbind:rw \
  "${IMAGE}" restorer \
  etcdutl snapshot restore "/snap/$(basename "${SNAP}")" \
    --data-dir=/out/data --name=restore \
    --initial-cluster=restore=http://127.0.0.1:${PEER} \
    --initial-advertise-peer-urls=http://127.0.0.1:${PEER} --skip-hash-check 2>&1 \
  | grep -E "restored snapshot|error" | tail -2

echo "=== 2. 起独立 etcd（:${PORT}）==="
ctr -n k8s.io run --net-host \
  --mount type=bind,src="${WORK}/data",dst=/data,options=rbind:rw \
  "${IMAGE}" "${NAME}" \
  etcd --data-dir=/data --name=restore \
    --listen-client-urls=http://127.0.0.1:${PORT} \
    --advertise-client-urls=http://127.0.0.1:${PORT} \
    --listen-peer-urls=http://127.0.0.1:${PEER} \
    --initial-cluster=restore=http://127.0.0.1:${PEER} \
    --initial-cluster-state=new > /var/tmp/etcd-restore.log 2>&1 &
sleep 12

# 用一次性容器跑 etcdctl（镜像里没有 shell，只能直接 exec 二进制）
Q() {
  timeout 40 ctr -n k8s.io run --rm --net-host "${IMAGE}" "q-$$-$RANDOM" \
    etcdctl --endpoints="${EP}" "$@" 2>/dev/null
}

echo "=== 3. 健康检查 ==="
Q endpoint health
Q endpoint status -w table 2>/dev/null | tail -3

echo "=== 4. 统计快照内的业务对象 ==="
NS=$(Q get /registry/namespaces --prefix --keys-only | grep -c '^/registry' || true)
SEC=$(Q get /registry/secrets --prefix --keys-only | grep -c '^/registry' || true)
DEP=$(Q get /registry/deployments --prefix --keys-only | grep -c '^/registry' || true)
POD=$(Q get /registry/pods --prefix --keys-only | grep -c '^/registry' || true)
echo "  快照内：namespaces=${NS} secrets=${SEC} deployments=${DEP} pods=${POD}"
echo "  生产集群：namespaces=$(kubectl get ns --no-headers | wc -l) secrets=$(kubectl get secret -A --no-headers | wc -l) deployments=$(kubectl get deploy -A --no-headers | wc -l) pods=$(kubectl get pod -A --no-headers | wc -l)"

echo "=== 5. 抽查真实对象内容（podinfo）==="
Q get /registry/deployments/apps/podinfo -w json > /var/tmp/podinfo.json 2>/dev/null || true
python3 - <<'PY'
import json, base64
try:
    d = json.load(open("/var/tmp/podinfo.json"))
    obj = json.loads(base64.b64decode(d["kvs"][0]["value"]))
    print("  deployment=%s replicas=%s image=%s" % (
        obj["metadata"]["name"], obj["spec"].get("replicas"),
        obj["spec"]["template"]["spec"]["containers"][0]["image"]))
except Exception as e:
    print("  抽样失败:", e)
PY

echo "=== 6. 抽查 Secret 是否也在（加密存储仍是密文）==="
Q get /registry/secrets/monitoring/grafana-admin -w json > /var/tmp/sec.json 2>/dev/null || true
python3 - <<'PY'
import json, base64
try:
    d = json.load(open("/var/tmp/sec.json"))
    raw = base64.b64decode(d["kvs"][0]["value"])
    print("  secret 前 24 字节:", raw[:24])
except Exception as e:
    print("  抽样失败:", e)
PY

echo "=== 7. 收尾 ==="
kill %1 2>/dev/null
sleep 3
ctr -n k8s.io task kill -s SIGKILL "${NAME}" >/dev/null 2>&1
ctr -n k8s.io container rm "${NAME}" >/dev/null 2>&1
du -sh "${WORK}/data" 2>/dev/null
echo "  生产集群 readyz:" $(kubectl get --raw='/readyz' 2>&1 | tail -1)
