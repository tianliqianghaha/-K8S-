"""S12：Argo Rollouts（按副本比例的 canary）+ Kueue（配额排队）。"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent

ROLLOUT = """apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: {name: canary, namespace: demo-app}
spec:
  replicas: 4
  selector: {matchLabels: {app: canary}}
  template:
    metadata: {labels: {app: canary}}
    spec:
      containers:
        - name: c
          image: registry.k8s.io/e2e-test-images/agnhost:2.45
          command: ["/agnhost", "netexec", "--http-port=8080"]
          resources: {requests: {cpu: 20m, memory: 32Mi}, limits: {cpu: 100m, memory: 64Mi}}
  strategy:
    canary:
      steps:
        - setCanaryScale: {replicas: 1}
        - pause: {duration: 40s}
        - setCanaryScale: {replicas: 2}
        - pause: {duration: 40s}
        - setCanaryScale: {replicas: 4}
"""

KUEUE = """apiVersion: kueue.x-k8s.io/v1beta1
kind: ResourceFlavor
metadata: {name: default-flavor}
---
apiVersion: kueue.x-k8s.io/v1beta1
kind: ClusterQueue
metadata: {name: cluster-queue}
spec:
  namespaceSelector: {}
  resourceGroups:
    - coveredResources: ["cpu", "memory"]
      flavors:
        - name: default-flavor
          resources:
            - {name: "cpu", nominalQuota: "1"}
            - {name: "memory", nominalQuota: "2Gi"}
---
apiVersion: kueue.x-k8s.io/v1beta1
kind: LocalQueue
metadata: {name: lq, namespace: demo-app}
spec:
  clusterQueue: cluster-queue
---
apiVersion: batch/v1
kind: Job
metadata: {name: q1, namespace: demo-app, labels: {kueue.x-k8s.io/queue-name: lq}}
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: c
          image: busybox:1.37
          command: ["sh", "-c", "sleep 120"]
          resources: {requests: {cpu: "800m", memory: 256Mi}, limits: {cpu: "800m", memory: 256Mi}}
---
apiVersion: batch/v1
kind: Job
metadata: {name: q2, namespace: demo-app, labels: {kueue.x-k8s.io/queue-name: lq}}
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: c
          image: busybox:1.37
          command: ["sh", "-c", "sleep 120"]
          resources: {requests: {cpu: "800m", memory: 256Mi}, limits: {cpu: "800m", memory: 256Mi}}
"""


def main():
    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    (WORK / "s12-rollout.yaml").write_text(ROLLOUT, encoding="utf-8")
    (WORK / "s12-kueue.yaml").write_text(KUEUE, encoding="utf-8")
    fleet.scp("s12-rollout.yaml", "/root/s12-rollout.yaml", cp1)
    fleet.scp("s12-kueue.yaml", "/root/s12-kueue.yaml", cp1)

    print("=== 1. Argo Rollouts ===")
    rc, out = fleet.ssh(cp1, base + r"""
helm upgrade --install argo-rollouts argo/argo-rollouts -n argo-rollouts --create-namespace \
  --set dashboard.enabled=true --wait --timeout 8m 2>&1 | tail -3
kubectl -n argo-rollouts get pods --no-headers | awk '{print $1,$3}'
kubectl -n demo-app delete rollout canary --ignore-not-found >/dev/null 2>&1
kubectl apply -f /root/s12-rollout.yaml 2>&1 | tail -1
for i in $(seq 1 8); do
  sleep 20
  echo "t=${i}x20s phase=$(kubectl -n demo-app get rollout canary -o jsonpath='{.status.phase}') canaryReady=$(kubectl -n demo-app get rollout canary -o jsonpath='{.status.canary.currentReplicas}') stable=$(kubectl -n demo-app get rollout canary -o jsonpath='{.status.stable.currentReplicas}')"
done
kubectl -n demo-app get rollout canary -o jsonpath='{.status.conditions}{"\n"}' | head -c 300; echo
""", timeout=1200)
    print(out)

    print("=== 2. Kueue ===")
    rc, out = fleet.ssh(cp1, base + r"""
kubectl apply --server-side -f https://github.com/kubernetes-sigs/kueue/releases/download/v0.13.0/manifests.yaml 2>&1 | tail -3
sleep 45
kubectl -n kueue-system get pods --no-headers 2>&1 | awk '{print $1,$3}'
kubectl apply -f /root/s12-kueue.yaml 2>&1 | tail -2
sleep 30
echo "--- 队列配额 1 CPU，两个各 800m 的 Job 应只放行一个 ---"
kubectl -n demo-app get jobs --no-headers 2>&1
kubectl -n demo-app get workloads.kueue.x-k8s.io --no-headers 2>&1
""", timeout=1200)
    print(out)


if __name__ == "__main__":
    main()
