"""S8：Gitea 建仓 → ArgoCD 安装 → app-of-apps → 自愈实测。"""
import secrets
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent
GITEA_PW = "Gitea-" + secrets.token_urlsafe(9)
GITEA = "http://172.23.163.111:3000"

APP = """apiVersion: v1
kind: Namespace
metadata:
  name: demo-app
  labels: {app.kubernetes.io/part-of: demo}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: marker
  namespace: demo-app
data:
  who: k8s20
  managed-by: argocd
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: demo-app
  labels: {app: web}
spec:
  replicas: 2
  selector:
    matchLabels: {app: web}
  template:
    metadata:
      labels: {app: web}
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: {app: web}
      containers:
        - name: agnhost
          image: registry.k8s.io/e2e-test-images/agnhost:2.45
          command: ["/agnhost", "netexec", "--http-port=8080"]
          ports: [{containerPort: 8080}]
          resources:
            requests: {cpu: 20m, memory: 32Mi}
            limits: {cpu: 200m, memory: 128Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: demo-app
spec:
  selector: {app: web}
  ports: [{name: http, port: 80, targetPort: 8080}]
"""

APP_OF_APPS = """apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: demo-app
  namespace: argocd
  finalizers: [resources-finalizer.argocd.argoproj.io]
spec:
  project: default
  source:
    repoURL: http://172.23.163.111:3000/gitea_admin/k8s-manifests.git
    targetRevision: HEAD
    path: apps/demo-app
  destination:
    server: https://kubernetes.default.svc
    namespace: demo-app
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    syncOptions: [CreateNamespace=true]
"""


def main():
    infra = fleet.INFRA
    print("=== 1. Gitea 建管理员与仓库 ===")
    rc, out = fleet.ssh(infra, f"""
docker exec -u git gitea gitea admin user create --username gitea_admin \
  --password '{GITEA_PW}' --email admin@k8s.local --admin --must-change-password=false 2>&1 | tail -2
sleep 3
curl -s -u gitea_admin:'{GITEA_PW}' -H 'Content-Type: application/json' \
  -d '{{"name":"k8s-manifests","auto_init":true,"private":false,"default_branch":"main"}}' \
  {GITEA}/api/v1/user/repos | head -c 160; echo
""", timeout=300)
    print(out)

    print("=== 2. 本地准备仓库内容并推送 ===")
    repo = WORK / "repo"
    (repo / "apps" / "demo-app").mkdir(parents=True, exist_ok=True)
    (repo / "apps" / "demo-app" / "all.yaml").write_text(APP, encoding="utf-8")
    (repo / "apps" / "demo-app" / "README.md").write_text("# demo-app\n", encoding="utf-8")
    (repo / "apps" / "app-of-apps.yaml").write_text(APP_OF_APPS, encoding="utf-8")
    (repo / "README.md").write_text("# k8s-manifests (2.0)\n", encoding="utf-8")

    cp1 = fleet.by_name("cp-1")
    fleet.ssh(cp1, "rm -rf /root/repo && mkdir -p /root/repo/apps/demo-app", timeout=60)
    fleet.scp("repo/apps/demo-app/all.yaml", "/root/repo/apps/demo-app/all.yaml", cp1)
    fleet.scp("repo/apps/app-of-apps.yaml", "/root/repo/apps/app-of-apps.yaml", cp1)
    rc, out = fleet.ssh(cp1, f"""
cd /root/repo
git init -q -b main 2>/dev/null || true
printf '# k8s-manifests 2.0\\n' > README.md
git add -A
git -c user.email=a@k8s.local -c user.name=deploy commit -q -m "init: demo-app + app-of-apps" 2>&1 | tail -2
git push -q http://gitea_admin:{GITEA_PW}@172.23.163.111:3000/gitea_admin/k8s-manifests.git HEAD:main --force 2>&1 | tail -3
echo "push rc=$?"
git ls-remote http://gitea_admin:{GITEA_PW}@172.23.163.111:3000/gitea_admin/k8s-manifests.git 2>&1 | head -2
""", timeout=300)
    print(out)

    print("=== 3. ArgoCD ===")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    script = base + f"""
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1
helm upgrade --install argocd argo/argo-cd -n argocd --create-namespace \\
  --set global.domain=argocd.k8s.local \\
  --set server.replicas=2 --set repoServer.replicas=2 --set applicationSet.replicas=2 \\
  --set configs.params."server\\.insecure"=true \\
  --set server.service.type=NodePort --set server.service.nodePortHttp=30080 \\
  --wait --timeout 15m 2>&1 | tail -4

echo "=== 4. 仓库凭据 + Application ==="
kubectl -n argocd create secret generic gitea-repo \\
  --from-literal=type=git \\
  --from-literal=url=http://172.23.163.111:3000/gitea_admin/k8s-manifests.git \\
  --from-literal=username=gitea_admin \\
  --from-literal=password='{GITEA_PW}' \\
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n argocd label secret gitea-repo argocd.argoproj.io/secret-type=repository --overwrite >/dev/null

kubectl apply -f /root/repo/apps/app-of-apps.yaml 2>&1 | tail -1
sleep 25
kubectl -n argocd get applications 2>&1
kubectl -n demo-app get pods --no-headers 2>&1 | head -4
"""
    fleet.scp("repo/apps/app-of-apps.yaml", "/root/app-of-apps.yaml", cp1)
    rc, out = fleet.ssh(cp1, script, timeout=1800)
    print(out)

    (WORK / "gitea-admin.txt").write_text(f"user=gitea_admin\npassword={GITEA_PW}\n", encoding="utf-8")


if __name__ == "__main__":
    main()
