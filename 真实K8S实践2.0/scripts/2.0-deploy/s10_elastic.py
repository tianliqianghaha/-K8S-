"""S10：HPA（真实扩容/回落）+ 原地扩缩 + VPA 建议 + KEDA（事件驱动）。"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent

BURN = """apiVersion: apps/v1
kind: Deployment
metadata: {name: burn, namespace: demo-app, labels: {app: burn}}
spec:
  replicas: 1
  selector: {matchLabels: {app: burn}}
  template:
    metadata: {labels: {app: burn}}
    spec:
      containers:
        - name: burn
          image: busybox:1.37
          command: ["sh", "-c", "while :; do :; done"]
          resources:
            requests: {cpu: 100m, memory: 32Mi}
            limits: {cpu: 200m, memory: 64Mi}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: burn, namespace: demo-app}
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: burn}
  minReplicas: 1
  maxReplicas: 4
  behavior:
    scaleDown: {stabilizationWindowSeconds: 60}
    scaleUp: {stabilizationWindowSeconds: 0, policies: [{type: Percent, value: 100, periodSeconds: 30}]}
  metrics:
    - type: Resource
      resource: {name: cpu, target: {type: Utilization, averageUtilization: 50}}
"""

KEDA_SO = """apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: {name: burn-keda, namespace: demo-app}
spec:
  scaleTargetRef: {name: burn}
  minReplicaCount: 0
  maxReplicaCount: 3
  cooldownPeriod: 30
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://kps-kube-prometheus-stack-prometheus.monitoring:9090
        query: sum(rate(container_cpu_usage_seconds_total{namespace="demo-app",pod=~"burn.*"}[1m]))
        threshold: "0.05"
"""


def main():
    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    (WORK / "s10-burn.yaml").write_text(BURN, encoding="utf-8")
    fleet.scp("s10-burn.yaml", "/root/s10-burn.yaml", cp1)

    print("=== 1. HPA 实测 ===")
    rc, out = fleet.ssh(cp1, base + r"""
kubectl -n demo-app delete hpa burn --ignore-not-found >/dev/null 2>&1
kubectl apply -f /root/s10-burn.yaml 2>&1 | tail -2
sleep 45
echo "起始副本: $(kubectl -n demo-app get deploy burn -o jsonpath='{.status.readyReplicas}')"
kubectl -n demo-app get hpa burn --no-headers 2>&1
echo "--- 等待 90 秒观察扩容 ---"
for i in $(seq 1 9); do
  sleep 10
  echo "t=${i}0s replicas=$(kubectl -n demo-app get deploy burn -o jsonpath='{.status.readyReplicas}') hpa=$(kubectl -n demo-app get hpa burn -o jsonpath='{.status.currentReplicas}')"
done
""", timeout=900)
    print(out)

    print("=== 2. 原地扩缩（改 requests 不重启）===")
    rc, out = fleet.ssh(cp1, base + r"""
POD=$(kubectl -n demo-app get pod -l app=burn -o name | head -1)
UID0=$(kubectl -n demo-app get $POD -o jsonpath='{.metadata.uid}')
R0=$(kubectl -n demo-app get $POD -o jsonpath='{.status.containerStatuses[0].restartCount}')
echo "before uid=$UID0 restarts=$R0 req=$(kubectl -n demo-app get $POD -o jsonpath='{.spec.containers[0].resources.requests.cpu}')"
kubectl -n demo-app patch deploy burn --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/resources/requests/cpu","value":"300m"}]' >/dev/null
sleep 25
POD2=$(kubectl -n demo-app get pod -l app=burn -o name | head -1)
UID1=$(kubectl -n demo-app get $POD2 -o jsonpath='{.metadata.uid}')
R1=$(kubectl -n demo-app get $POD2 -o jsonpath='{.status.containerStatuses[0].restartCount}')
echo "after  uid=$UID1 restarts=$R1 req=$(kubectl -n demo-app get $POD2 -o jsonpath='{.spec.containers[0].resources.requests.cpu}')"
echo "resize status=$(kubectl -n demo-app get $POD2 -o jsonpath='{.status.containerStatuses[0].resources}' 2>/dev/null)"
""", timeout=600)
    print(out)

    print("=== 3. 装 VPA 与 KEDA ===")
    rc, out = fleet.ssh(cp1, base + r"""
helm repo add fairwinds-stable https://fairwindsops.github.io/charts >/dev/null 2>&1 || true
helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1
helm upgrade --install vpa fairwinds-stable/vpa -n vpa --create-namespace \
  --set recommender.replicaCount=1 --set updater.enabled=true --set admissionController.enabled=true \
  --wait --timeout 8m 2>&1 | tail -3
helm upgrade --install keda kedacore/keda -n keda --create-namespace --wait --timeout 8m 2>&1 | tail -3
kubectl -n vpa get pods --no-headers | awk '{print $1,$3}'
kubectl -n keda get pods --no-headers | awk '{print $1,$3}'
""", timeout=1200)
    print(out)

    print("=== 4. VPA 建议值（Off 模式，只看不改）===")
    rc, out = fleet.ssh(cp1, base + r"""
cat <<'EOF' | kubectl apply -f - 2>&1 | tail -1
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: {name: web-vpa, namespace: demo-app}
spec:
  targetRef: {apiVersion: apps/v1, kind: Deployment, name: web}
  updatePolicy: {updateMode: "Off"}
EOF
sleep 60
kubectl -n demo-app get vpa web-vpa -o jsonpath='{.status.recommendation.containerRecommendations[0]}' 2>&1 | head -c 300; echo
""", timeout=600)
    print(out)

    print("=== 5. KEDA 事件驱动（缩到 0 再拉起）===")
    (WORK / "s10-keda.yaml").write_text(KEDA_SO, encoding="utf-8")
    fleet.scp("s10-keda.yaml", "/root/s10-keda.yaml", cp1)
    rc, out = fleet.ssh(cp1, base + r"""
kubectl -n demo-app delete hpa burn --ignore-not-found >/dev/null 2>&1
kubectl -n demo-app scale deploy burn --replicas=1 >/dev/null
kubectl apply -f /root/s10-keda.yaml 2>&1 | tail -1
for i in $(seq 1 12); do
  sleep 15
  echo "t=${i}x15s replicas=$(kubectl -n demo-app get deploy burn -o jsonpath='{.status.replicas}') hpa=$(kubectl -n demo-app get hpa 2>/dev/null | tail -n +2 | awk '{print $1":"$2}' | tr '\n' ' ')"
done
kubectl -n keda get scaledobject -A --no-headers 2>&1
""", timeout=900)
    print(out)


if __name__ == "__main__":
    main()
