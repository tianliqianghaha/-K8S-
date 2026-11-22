"""S9：自愈实测 + PSA + Kyverno 校验侧 + 变更侧（优先原生 MutatingAdmissionPolicy）。"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent

VAP = """apiVersion: policies.kyverno.io/v1
kind: ValidatingPolicy
metadata:
  name: disallow-latest-tag
spec:
  validationActions: [Deny]
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
  validations:
    - expression: "object.spec.containers.all(c, !c.image.endsWith(':latest'))"
      message: "禁止使用 :latest 标签"
---
apiVersion: policies.kyverno.io/v1
kind: ValidatingPolicy
metadata:
  name: require-resources
spec:
  validationActions: [Deny]
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
  validations:
    - expression: "object.spec.containers.all(c, has(c.resources) && has(c.resources.requests) && has(c.resources.limits))"
      message: "必须声明 requests 与 limits"
---
apiVersion: policies.kyverno.io/v1
kind: ValidatingPolicy
metadata:
  name: disallow-privileged
spec:
  validationActions: [Deny]
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
  validations:
    - expression: "object.spec.containers.all(c, !has(c.securityContext) || !has(c.securityContext.privileged) || c.securityContext.privileged == false)"
      message: "禁止 privileged 容器"
"""

MAP = """apiVersion: admissionregistration.k8s.io/v1beta1
kind: MutatingAdmissionPolicy
metadata:
  name: inject-defaults
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]
        resources: ["pods"]
  reinvocationPolicy: Never
  mutations:
    - patchType: ApplyConfiguration
      applyConfiguration:
        expression: >
          Object{ metadata: Object.metadata{ labels: has(Object.metadata.labels)
            ? Object.metadata.labels{'admission.k8s.local/mutated': 'map'} 
            : {'admission.k8s.local/mutated': 'map'} } }
---
apiVersion: admissionregistration.k8s.io/v1beta1
kind: MutatingAdmissionPolicyBinding
metadata:
  name: inject-defaults-binding
spec:
  policyName: inject-defaults
  matchResources:
    namespaceSelector:
      matchLabels: {mutate: enabled}
"""


def main():
    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "

    print("=== 1. ArgoCD 自愈实测 ===")
    rc, out = fleet.ssh(cp1, base + r"""
T0=$(date +%s)
kubectl -n demo-app delete deploy web --wait=false >/dev/null 2>&1
for i in $(seq 1 30); do
  n=$(kubectl -n demo-app get deploy web -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "$n" = "2" ] && break; sleep 2
done
T1=$(date +%s)
echo "自愈耗时=$((T1-T0))s  readyReplicas=$n"
kubectl -n argocd get applications --no-headers
""", timeout=300)
    print(out)

    print("=== 2. PSA restricted ===")
    rc, out = fleet.ssh(cp1, base + r"""
kubectl create ns psa-test --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label ns psa-test pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
kubectl -n psa-test run bad --image=registry.k8s.io/e2e-test-images/agnhost:2.45 --restart=Never 2>&1 | tail -2
""", timeout=240)
    print(out)

    print("=== 3. Kyverno 校验侧 ===")
    rc, out = fleet.ssh(cp1, base + r"""
helm repo add kyverno https://kyverno.github.io/kyverno >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1
helm upgrade --install kyverno kyverno/kyverno -n kyverno --create-namespace \
  --set admissionController.replicas=2 --wait --timeout 12m 2>&1 | tail -3
kubectl -n kyverno get pods --no-headers | awk '{print $3}' | sort | uniq -c
""", timeout=1200)
    print(out)

    (WORK / "s9-kyverno.yaml").write_text(VAP, encoding="utf-8")
    fleet.scp("s9-kyverno.yaml", "/root/s9-kyverno.yaml", cp1)

    print("=== 4. 三条策略实测 ===")
    rc, out = fleet.ssh(cp1, base + r"""
kubectl apply -f /root/s9-kyverno.yaml --server-side 2>&1 | tail -4
sleep 8
echo "--- 测1 latest ---"
kubectl -n demo-app run t1 --image=nginx:latest --restart=Never 2>&1 | tail -1
echo "--- 测2 无 resources ---"
kubectl -n demo-app run t2 --image=nginx:1.27 --restart=Never 2>&1 | tail -1
echo "--- 测3 privileged ---"
cat <<'EOF' | kubectl apply -f - 2>&1 | tail -1
apiVersion: v1
kind: Pod
metadata: {name: t3, namespace: demo-app}
spec:
  containers:
    - name: c
      image: nginx:1.27
      resources: {requests: {cpu: 10m, memory: 16Mi}, limits: {cpu: 50m, memory: 64Mi}}
      securityContext: {privileged: true}
EOF
echo "--- 合规 Pod 应放行 ---"
kubectl -n demo-app run good --image=nginx:1.27 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"good","image":"nginx:1.27","resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"50m","memory":"64Mi"}}}]}}' 2>&1 | tail -1
""", timeout=600)
    print(out)

    print("=== 5. 变更侧：原生 MutatingAdmissionPolicy 是否可用 ===")
    rc, out = fleet.ssh(cp1, base + r"""
kubectl api-resources 2>/dev/null | grep -i mutatingadmissionpolicy || echo "NO-NATIVE-MAP"
""", timeout=120)
    print(out)

    if "MutatingAdmissionPolicy" in out:
        (WORK / "s9-map.yaml").write_text(MAP, encoding="utf-8")
        fleet.scp("s9-map.yaml", "/root/s9-map.yaml", cp1)
        rc, out = fleet.ssh(cp1, base + r"""
kubectl apply -f /root/s9-map.yaml 2>&1 | tail -2
kubectl create ns mutate-test --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label ns mutate-test mutate=enabled --overwrite >/dev/null
sleep 5
kubectl -n mutate-test run m1 --image=nginx:1.27 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"m1","image":"nginx:1.27","resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"50m","memory":"64Mi"}}}]}}' >/dev/null 2>&1
sleep 4
echo "mutated label=$(kubectl -n mutate-test get pod m1 -o jsonpath='{.metadata.labels.admission\.k8s\.local/mutated}')"
""", timeout=300)
        print(out)


if __name__ == "__main__":
    main()
