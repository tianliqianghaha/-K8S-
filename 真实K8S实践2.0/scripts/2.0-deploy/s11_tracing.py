"""S11：Tempo(S3) + OTel Collector + Alloy eBPF 自动埋点 → 零代码改动出 trace。"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent
cred = dict(l.split("=", 1) for l in (WORK / "infra-s3-cred.txt").read_text(encoding="utf-8").splitlines() if "=" in l)
AK, SK = cred["access_key"], cred["secret_key"]
S3 = "172.23.163.111:9000"

TEMPO = f"""tempo:
  storage:
    trace:
      backend: s3
      s3:
        bucket: tempo-traces
        endpoint: {S3}
        access_key: "{AK}"
        secret_key: "{SK}"
        insecure: true
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
  resources:
    requests: {{cpu: 200m, memory: 512Mi}}
persistence:
  enabled: true
  storageClassName: longhorn
  size: 10Gi
"""

OTELCOL = f"""mode: deployment
replicaCount: 1
image:
  repository: otel/opentelemetry-collector-contrib
config:
  receivers:
    otlp:
      protocols:
        grpc: {{endpoint: 0.0.0.0:4317}}
        http: {{endpoint: 0.0.0.0:4318}}
  processors:
    batch: {{}}
    memory_limiter:
      check_interval: 1s
      limit_percentage: 75
      spike_limit_percentage: 20
  exporters:
    otlp/tempo:
      endpoint: tempo.monitoring.svc.cluster.local:4317
      tls: {{insecure: true}}
  service:
    pipelines:
      traces:
        receivers: [otlp]
        processors: [memory_limiter, batch]
        exporters: [otlp/tempo]
"""

ALLOY = """alloy:
  configMap:
    create: true
    content: |
      discovery.kubernetes "pods" { role = "pod" }
      discovery.relabel "pods" {
        targets = discovery.kubernetes.pods.targets
        rule { source_labels = ["__meta_kubernetes_namespace"]; target_label = "namespace" }
        rule { source_labels = ["__meta_kubernetes_pod_name"];  target_label = "pod" }
        rule { source_labels = ["__meta_kubernetes_pod_container_name"]; target_label = "container" }
        rule { source_labels = ["__meta_kubernetes_pod_node_name"]; target_label = "node" }
        rule { source_labels = ["__meta_kubernetes_pod_label_app"]; target_label = "app" }
      }
      loki.source.kubernetes "pods" {
        targets    = discovery.relabel.pods.output
        forward_to = [loki.write.default.receiver]
      }
      loki.write "default" {
        endpoint { url = "http://loki-gateway.loki.svc.cluster.local/loki/api/v1/push" }
      }

      // === eBPF 自动埋点（OBI）：应用零改动，从内核拿 span ===
      otelcol.receiver.ebpf "default" {
        open_port = 0
        output {
          metrics = [otelcol.processor.batch.ebpf.input]
          traces  = [otelcol.processor.batch.ebpf.input]
        }
      }
      otelcol.processor.batch "ebpf" {
        output {
          metrics = [otelcol.exporter.otlp.tempo.input]
          traces  = [otelcol.exporter.otlp.tempo.input]
        }
      }
      otelcol.exporter.otlp "tempo" {
        client {
          endpoint = "otelcol-opentelemetry-collector.monitoring.svc.cluster.local:4317"
          tls { insecure = true }
        }
      }
controller:
  type: daemonset
  tolerations: [{operator: Exists}]
alloy:
  securityContext:
    privileged: true
    runAsUser: 0
  mounts:
    varlog: true
    dockercontainers: false
  resources:
    requests: {cpu: 100m, memory: 256Mi}
"""


def main():
    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    for name, body in (("s11-tempo-values.yaml", TEMPO), ("s11-otelcol-values.yaml", OTELCOL), ("s11-alloy-values.yaml", ALLOY)):
        (WORK / name).write_text(body, encoding="utf-8")
        fleet.scp(name, f"/root/{name}", cp1)

    script = base + """
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1

echo "=== Tempo ==="
helm upgrade --install tempo grafana/tempo --version 1.24.4 -n monitoring \
  -f /root/s11-tempo-values.yaml --wait --timeout 10m 2>&1 | tail -4

echo "=== OTel Collector ==="
helm upgrade --install otelcol open-telemetry/opentelemetry-collector --version 0.120.0 \\
  -n monitoring -f /root/s11-otelcol-values.yaml --wait --timeout 8m 2>&1 | tail -4

echo "=== Alloy（重装带 eBPF）==="
helm upgrade --install alloy grafana/alloy --version 1.16.0 -n monitoring \
  -f /root/s11-alloy-values.yaml --wait --timeout 10m 2>&1 | tail -4

kubectl -n monitoring get pods --no-headers | grep -E 'tempo|otelcol|alloy' | head -12
"""
    rc, out = fleet.ssh(cp1, script, timeout=1800)
    print(out)
    print("rc=", rc)


if __name__ == "__main__":
    main()
