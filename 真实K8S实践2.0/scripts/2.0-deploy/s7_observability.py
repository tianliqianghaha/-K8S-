"""S7：kube-prometheus-stack + Loki(S3 后端) + Alloy 日志采集。"""
import secrets
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent
cred = dict(l.split("=", 1) for l in (WORK / "infra-s3-cred.txt").read_text(encoding="utf-8").splitlines() if "=" in l)
AK, SK = cred["access_key"], cred["secret_key"]
S3HOST = "172.23.163.111:9000"
GRAFANA_PW = "Grafana-" + secrets.token_urlsafe(9)

KPS = """grafana:
  enabled: true
  replicas: 2
  adminPassword: "%s"
  persistence:
    enabled: true
    storageClassName: longhorn
    size: 5Gi
  service:
    type: NodePort
    nodePort: 30300
  defaultDashboardsEnabled: true
prometheus:
  prometheusSpec:
    replicas: 2
    retention: 7d
    retentionSize: "18GB"
    resources:
      requests: {cpu: 200m, memory: 512Mi}
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: longhorn
          resources:
            requests: {storage: 20Gi}
    podAntiAffinity: hard
alertmanager:
  alertmanagerSpec:
    replicas: 3
    resources:
      requests: {cpu: 50m, memory: 64Mi}
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: longhorn
          resources:
            requests: {storage: 2Gi}
    podAntiAffinity: hard
prometheusOperator:
  resources:
    requests: {cpu: 100m, memory: 128Mi}
kubeEtcd:
  enabled: false
kubeControllerManager:
  enabled: false
kubeScheduler:
  enabled: false
kubeProxy:
  enabled: false
""" % GRAFANA_PW

LOKI = """deploymentMode: SingleBinary
loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  storage:
    type: s3
    bucketNames:
      chunks: loki-chunks
      ruler: loki-ruler
      admin: loki-admin
    s3:
      endpoint: %s
      accessKeyId: "%s"
      secretAccessKey: "%s"
      s3ForcePathStyle: true
      insecure: true
  schemaConfig:
    configs:
      - from: "2024-04-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h
  limits_config:
    retention_period: 72h
singleBinary:
  replicas: 1
  resources:
    requests: {cpu: 200m, memory: 512Mi}
  persistence:
    enabled: true
    storageClassName: longhorn
    size: 10Gi
backend: {replicas: 0}
read: {replicas: 0}
write: {replicas: 0}
gateway:
  enabled: true
  replicas: 1
minio:
  enabled: false
lokiCanary:
  enabled: false
test:
  enabled: false
chunksCache:
  enabled: false
resultsCache:
  enabled: false
""" % (S3HOST, AK, SK)

ALLOY = """alloy:
  configMap:
    create: true
    content: |
      discovery.kubernetes "pods" {
        role = "pod"
      }
      discovery.relabel "pods" {
        targets = discovery.kubernetes.pods.targets
        rule {
          source_labels = ["__meta_kubernetes_namespace"]
          target_label  = "namespace"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_name"]
          target_label  = "pod"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_container_name"]
          target_label  = "container"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_node_name"]
          target_label  = "node"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_label_app"]
          target_label  = "app"
        }
      }
      loki.source.kubernetes "pods" {
        targets    = discovery.relabel.pods.output
        forward_to = [loki.write.default.receiver]
      }
      loki.write "default" {
        endpoint {
          url = "http://loki-gateway.loki.svc.cluster.local/loki/api/v1/push"
        }
      }
controller:
  type: daemonset
  tolerations:
    - operator: Exists
"""


def main():
    infra = fleet.INFRA
    fleet.ssh(infra, r"""
for b in loki-ruler loki-admin; do
  echo "s3.bucket.create -name $b" | docker exec -i seaweedfs weed shell -master=localhost:9333 2>&1 | grep -v scaffold | tail -1
done
""", timeout=180)

    for name, body in (("s7-kps-values.yaml", KPS), ("s7-loki-values.yaml", LOKI), ("s7-alloy-values.yaml", ALLOY)):
        (WORK / name).write_text(body, encoding="utf-8")

    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    for f in ("s7-kps-values.yaml", "s7-loki-values.yaml", "s7-alloy-values.yaml"):
        fleet.scp(f, f"/root/{f}", cp1)

    script = base + """
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1

echo "=== kube-prometheus-stack ==="
helm upgrade --install kps prometheus-community/kube-prometheus-stack --version 93.4.1 \
  -n monitoring --create-namespace -f /root/s7-kps-values.yaml --wait --timeout 20m 2>&1 | tail -4

echo "=== loki ==="
helm upgrade --install loki grafana/loki --version 7.7.0 -n loki --create-namespace \
  -f /root/s7-loki-values.yaml --wait --timeout 15m 2>&1 | tail -6

echo "=== alloy ==="
helm upgrade --install alloy grafana/alloy --version 1.9.2 -n monitoring \
  -f /root/s7-alloy-values.yaml --wait --timeout 10m 2>&1 | tail -5

echo "=== 状态 ==="
kubectl -n monitoring get pods --no-headers | awk '{print $3}' | sort | uniq -c
kubectl -n loki get pods --no-headers | awk '{print $1,$3}'
"""
    rc, out = fleet.ssh(cp1, script, timeout=2400)
    print(out)
    print("rc=", rc)
    (WORK / "grafana-admin.txt").write_text(f"user=admin\npassword={GRAFANA_PW}\n", encoding="utf-8")


if __name__ == "__main__":
    main()
