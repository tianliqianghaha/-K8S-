#!/usr/bin/env bash
# 第 7 章 · 密钥闭环（Sealed Secrets）
# 用途：把 Secret 加密成可安全进 Git 的 SealedSecret
# 幂等：可重复执行
# 说明：仓库 2026 年已从 bitnami-labs 迁到 bitnami，旧地址会 404，这里用新地址
set -euo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf

REPO_URL="https://bitnami.github.io/sealed-secrets"
CHART_VERSION="2.22.0"
KUBESEAL_VER="0.41.2"
NS="kube-system"
NAME="sealed-secrets"

echo "=== 1. kubeseal CLI ==="
if ! command -v kubeseal >/dev/null 2>&1; then
  curl -fsSL "https://github.com/bitnami/sealed-secrets/releases/download/v${KUBESEAL_VER}/kubeseal-${KUBESEAL_VER}-linux-amd64.tar.gz" \
    -o /tmp/kubeseal.tgz
  tar -C /usr/local/bin -xzf /tmp/kubeseal.tgz kubeseal
  chmod +x /usr/local/bin/kubeseal
fi
kubeseal --version

echo "=== 2. 控制器（单副本，原因见文档 7.2）==="
helm repo add sealed-secrets "${REPO_URL}" >/dev/null 2>&1 || true
helm repo update sealed-secrets >/dev/null 2>&1
helm upgrade --install "${NAME}" sealed-secrets/sealed-secrets \
  --version "${CHART_VERSION}" \
  -n "${NS}" \
  --set fullnameOverride=sealed-secrets-controller \
  --set resources.requests.cpu=20m \
  --set resources.requests.memory=64Mi \
  --set resources.limits.cpu=200m \
  --set resources.limits.memory=256Mi \
  --wait --timeout 5m

kubectl -n "${NS}" rollout status deploy/sealed-secrets-controller --timeout=180s
kubectl -n "${NS}" get pod -l app.kubernetes.io/name=sealed-secrets --no-headers

echo "=== 3. 取集群公钥（加密用，可公开）==="
kubeseal --controller-name=sealed-secrets-controller \
         --controller-namespace="${NS}" \
         --fetch-cert > /etc/kubernetes/sealed-secrets.pem
openssl x509 -in /etc/kubernetes/sealed-secrets.pem -noout -subject -dates
echo "cert_sha256=$(sha256sum /etc/kubernetes/sealed-secrets.pem | cut -d' ' -f1)"

echo "=== 4. 备份控制器私钥（丢了所有 SealedSecret 都解不开）==="
kubectl -n "${NS}" get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
  -o yaml > /etc/kubernetes/sealed-secrets-key.backup.yaml
chmod 600 /etc/kubernetes/sealed-secrets-key.backup.yaml
echo "key_backup_bytes=$(stat -c %s /etc/kubernetes/sealed-secrets-key.backup.yaml)"

echo "=== OK ==="
