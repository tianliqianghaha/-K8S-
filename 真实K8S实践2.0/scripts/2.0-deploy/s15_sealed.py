"""S15：Sealed Secrets —— 明文不进 Git，Secret 由 Git 重建。"""
import secrets
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent
PW = "S3cret-" + secrets.token_urlsafe(8)

APP = """apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: secrets
  namespace: argocd
  finalizers: [resources-finalizer.argocd.argoproj.io]
spec:
  project: default
  source:
    repoURL: http://172.23.163.111:3000/gitea_admin/k8s-manifests.git
    targetRevision: HEAD
    path: apps/secrets
  destination:
    server: https://kubernetes.default.svc
    namespace: demo-secrets
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    syncOptions: [CreateNamespace=true]
"""


def main():
    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    script = base + r"""
echo "=== 1. 装控制器 ==="
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1
helm upgrade --install sealed-secrets sealed-secrets/sealed-secrets -n kube-system \
  --set fullnameOverride=sealed-secrets-controller --wait --timeout 8m 2>&1 | tail -3
kubectl -n kube-system get deploy sealed-secrets-controller --no-headers 2>&1

echo "=== 2. 装 kubeseal ==="
if ! command -v kubeseal >/dev/null; then
  V=$(curl -s https://api.github.com/repos/bitnami-labs/sealed-secrets/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)
  echo "latest=$V"
  curl -fsSL "https://github.com/bitnami-labs/sealed-secrets/releases/download/${V}/kubeseal-linux-amd64" -o /usr/local/bin/kubeseal
  chmod +x /usr/local/bin/kubeseal
fi
kubeseal --version 2>&1 | head -1

echo "=== 3. 取公钥并封存一个 Secret ==="
sleep 5
kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
  --fetch-cert > /root/sealed-pub.pem 2>/dev/null && echo "公钥 $(wc -l < /root/sealed-pub.pem) 行"
mkdir -p /root/secretsrc
kubectl create secret generic db-cred -n demo-secrets \
  --from-literal=password='PW_PLACEHOLDER' --dry-run=client -o yaml > /root/secretsrc/plain.yaml 2>/dev/null
kubeseal --cert /root/sealed-pub.pem --format yaml < /root/secretsrc/plain.yaml > /root/secretsrc/sealed.yaml 2>&1
head -8 /root/secretsrc/sealed.yaml
"""
    script = script.replace("PW_PLACEHOLDER", PW)
    rc, out = fleet.ssh(cp1, script, timeout=900)
    print(out)

    print("=== 4. 推进 Git 并让 ArgoCD 接管 ===")
    (WORK / "s15-app.yaml").write_text(APP, encoding="utf-8")
    fleet.scp("s15-app.yaml", "/root/s15-app.yaml", cp1)
    script2 = base + r"""
cd /root/repo
mkdir -p apps/secrets
cp /root/secretsrc/sealed.yaml apps/secrets/db-cred.yaml
git add -A
git -c user.email=a@k8s.local -c user.name=deploy commit -q -m "secrets: add sealed db-cred" 2>&1 | tail -1
git push -q http://gitea_admin:Gitea-9nUdntvQidLi@172.23.163.111:3000/gitea_admin/k8s-manifests.git HEAD:main --force 2>&1 | tail -2
kubectl apply -f /root/s15-app.yaml 2>&1 | tail -1
sleep 40
kubectl -n argocd get applications --no-headers 2>&1
echo "--- Secret 是否被重建 ---"
kubectl -n demo-secrets get secret db-cred --no-headers 2>&1
kubectl -n demo-secrets get secret db-cred -o jsonpath='{.data.password}' 2>/dev/null | base64 -d; echo
echo "--- 删掉再自愈 ---"
kubectl -n demo-secrets delete secret db-cred >/dev/null 2>&1
for i in $(seq 1 15); do kubectl -n demo-secrets get secret db-cred >/dev/null 2>&1 && break; sleep 3; done
kubectl -n demo-secrets get secret db-cred --no-headers 2>&1
"""
    rc, out = fleet.ssh(cp1, script2, timeout=900)
    print(out)
    print(f"[记录] db-cred 明文口令 = {PW}（不进 Git，只在本机留档）")
    (WORK / "sealed-demo-cred.txt").write_text(f"ns=demo-secrets\nname=db-cred\npassword={PW}\n", encoding="utf-8")


if __name__ == "__main__":
    main()
