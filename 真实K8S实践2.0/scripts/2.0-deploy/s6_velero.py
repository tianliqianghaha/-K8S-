"""S6：bucket + Longhorn BackupTarget + Velero（集群外 S3）。"""
import re
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent
cred = dict(
    line.split("=", 1) for line in
    (WORK / "infra-s3-cred.txt").read_text(encoding="utf-8").splitlines() if "=" in line
)
AK, SK = cred["access_key"], cred["secret_key"]
S3 = "http://172.23.163.111:9000"
VELERO = "1.17.0"


def main():
    infra = fleet.INFRA
    print("=== 1. 建 bucket ===")
    rc, out = fleet.ssh(infra, r"""
for b in longhorn-backup velero-backup loki-chunks tempo-traces; do
  echo "s3.bucket.create -name $b" | docker exec -i seaweedfs weed shell -master=localhost:9333 2>&1 | grep -v scaffold | tail -2
done
echo "s3.bucket.list" | docker exec -i seaweedfs weed shell -master=localhost:9333 2>&1 | grep -v scaffold | tail -8
""", timeout=300)
    print(out)

    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "

    print("=== 2. Longhorn BackupTarget ===")
    yaml = f"""apiVersion: v1
kind: Secret
metadata:
  name: longhorn-backup-secret
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "{AK}"
  AWS_SECRET_ACCESS_KEY: "{SK}"
  AWS_ENDPOINTS: "{S3}"
  AWS_REGION: "us-east-1"
---
apiVersion: longhorn.io/v1beta2
kind: BackupTarget
metadata:
  name: default
  namespace: longhorn-system
spec:
  backupTargetURL: "s3://longhorn-backup@us-east-1/"
  credentialSecret: longhorn-backup-secret
  pollInterval: "1m"
"""
    (WORK / "s6-longhorn-backup.yaml").write_text(yaml, encoding="utf-8")
    fleet.scp("s6-longhorn-backup.yaml", "/root/s6-longhorn-backup.yaml", cp1)
    rc, out = fleet.ssh(cp1, base + "kubectl apply -f /root/s6-longhorn-backup.yaml 2>&1 | tail -3; "
                              "sleep 5; kubectl -n longhorn-system get backuptarget default "
                              "-o jsonpath='{.status.backupTargetURL}{\" \"}{.status.available}{\"\\n\"}'", timeout=180)
    print(out)

    print("=== 3. Velero ===")
    script = base + f"""
if ! command -v velero >/dev/null; then
  curl -fsSL https://github.com/vmware-tanzu/velero/releases/download/v{VELERO}/velero-v{VELERO}-linux-amd64.tar.gz -o /tmp/velero.tgz
  tar -C /tmp -xzf /tmp/velero.tgz
  install -m755 /tmp/velero-v{VELERO}-linux-amd64/velero /usr/local/bin/velero
fi
cat > /root/velero-credentials <<'EOF'
[default]
aws_access_key_id={AK}
aws_secret_access_key={SK}
EOF
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1
velero install --provider aws --plugins velero/velero-plugin-for-aws:v1.11.0 \
  --bucket velero-backup --secret-file /root/velero-credentials \
  --use-volume-snapshots=false --no-default-backup-location \
  --backup-location-config region=us-east-1,s3ForcePathStyle="true",s3Url={S3} \
  --namespace velero --wait 2>&1 | tail -6
cat > /root/bsl.yaml <<'EOF'
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backup
  config:
    region: us-east-1
    s3ForcePathStyle: "true"
    s3Url: {S3}
EOF
kubectl apply -f /root/bsl.yaml >/dev/null 2>&1
sleep 15
kubectl -n velero get bsl default -o jsonpath='{{.status.phase}}{{"\\n"}}'
kubectl -n velero get pods --no-headers | head -3
"""
    rc, out = fleet.ssh(cp1, script, timeout=1200)
    print(out)


if __name__ == "__main__":
    main()
