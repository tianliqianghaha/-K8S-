"""S17：Dex(OIDC) + apiserver 接入 + 按用户 RBAC。清单先备份，失败可还原。"""
import secrets
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent
CLIENT_ID = "kubelogin"
CLIENT_SECRET = secrets.token_urlsafe(24)
USER = "viewer@k8s.local"
PASS = "Viewer-" + secrets.token_urlsafe(6)
ISSUER = "https://172.23.163.111:5556"

DEX = f"""issuer: {ISSUER}
storage:
  type: memory
web:
  http: 0.0.0.0:5556
  tlsCert: /etc/dex/tls.crt
  tlsKey: /etc/dex/tls.key
oauth2:
  skipApprovalScreen: true
staticClients:
  - id: {CLIENT_ID}
    secret: {CLIENT_SECRET}
    name: kubelogin
    redirectURIs:
      - http://localhost:8000
      - http://127.0.0.1:8000
enablePasswordDB: true
staticPasswords:
  - email: {USER}
    hash: "$2y$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W"
    username: viewer
    userID: "1"
"""

PATCH = r'''import sys
p = '/etc/kubernetes/manifests/kube-apiserver.yaml'
s = open(p).read()
if '--oidc-issuer-url' in s:
    print('already'); sys.exit(0)
flags = ['--oidc-issuer-url=https://172.23.163.111:5556',
         '--oidc-client-id=kubelogin',
         '--oidc-username-claim=email',
         '--oidc-groups-claim=groups',
         '--oidc-ca-file=/etc/kubernetes/pki/oidc-ca.crt']
out = []
for ln in s.split('\n'):
    out.append(ln)
    if ln.strip() == '- kube-apiserver':
        for f in flags:
            out.append('    ' + f)
s = '\n'.join(out)
if 'oidc-ca' not in s:
    s = s.replace('    volumeMounts:\n',
                  '    volumeMounts:\n    - mountPath: /etc/kubernetes/pki/oidc-ca.crt\n      name: oidc-ca\n      readOnly: true\n', 1)
    s = s.replace('  volumes:\n',
                  '  volumes:\n  - hostPath:\n      path: /etc/kubernetes/pki/oidc-ca.crt\n      type: File\n    name: oidc-ca\n', 1)
open(p, 'w').write(s)
print('patched')
'''


def main():
    infra = fleet.INFRA
    print("=== 1. Dex 证书 + 配置 + 启动 ===")
    (WORK / "dex-config.yaml").write_text(DEX, encoding="utf-8")
    rc, out = fleet.ssh(infra, r"""
mkdir -p /etc/dex
if [ ! -f /etc/dex/tls.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout /etc/dex/tls.key -out /etc/dex/tls.crt -subj "/CN=172.23.163.111" \
    -addext "subjectAltName=IP:172.23.163.111,DNS:localhost" 2>/dev/null
fi
""", timeout=180)
    fleet.scp("dex-config.yaml", "/etc/dex/config.yaml", infra)
    rc, out = fleet.ssh(infra, r"""
cd /root
python3 - <<'EOF'
s=open('/root/docker-compose.yaml').read()
if 'container_name: dex' not in s:
    if not s.endswith('\n'): s += '\n'
    s += '''  dex:
    image: ghcr.io/dexidp/dex:v2.44.0
    container_name: dex
    restart: always
    command: ["dex", "serve", "/etc/dex/config.yaml"]
    ports:
      - "5556:5556"
    volumes:
      - /etc/dex:/etc/dex:ro
'''
    open('/root/docker-compose.yaml','w').write(s)
EOF
docker compose up -d dex 2>&1 | tail -3
sleep 10
docker ps --format '{{.Names}} {{.Status}}' | grep dex
curl -sk https://127.0.0.1:5556/dex/.well-known/openid-configuration | head -c 120; echo
""", timeout=600)
    print(out)

    print("=== 2. 分发 CA 到 3 台控制面（必须先于清单改动）===")
    rc, ca_pem = fleet.ssh(infra, "cat /etc/dex/tls.crt", timeout=60)
    Path("oidc-ca.crt").write_text(ca_pem, encoding="utf-8")
    for h in fleet.masters():
        fleet.ssh(h, "cp -a /etc/kubernetes/manifests/kube-apiserver.yaml /root/kube-apiserver.yaml.bak", timeout=60)
        fleet.scp("oidc-ca.crt", "/etc/kubernetes/pki/oidc-ca.crt", h)
        print(f"[{h[0]}] CA 已放置 + 清单已备份")

    print("=== 3. 改 3 台 apiserver 清单 ===")
    Path("patch_apiserver.py").write_text(PATCH, encoding="utf-8")
    for h in fleet.masters():
        fleet.scp("patch_apiserver.py", "/root/patch_apiserver.py", h)
        rc, out = fleet.ssh(h, "python3 /root/patch_apiserver.py; grep -c 'oidc-issuer-url' /etc/kubernetes/manifests/kube-apiserver.yaml", timeout=300)
        print(f"[{h[0]}] {out}")

    print("=== 4. 等 apiserver 恢复 ===")
    cp1 = fleet.by_name("cp-1")
    rc, out = fleet.ssh(cp1, """
export KUBECONFIG=/etc/kubernetes/admin.conf
for i in $(seq 1 40); do kubectl get --raw /healthz >/dev/null 2>&1 && break; sleep 6; done
kubectl get --raw /healthz 2>&1 | head -c 30; echo
kubectl get nodes --no-headers 2>&1 | wc -l
kubectl -n kube-system get pods -l component=kube-apiserver --no-headers 2>&1 | awk '{print $1,$2,$3}'
""", timeout=420)
    print(out)

    print("=== 5. RBAC：OIDC 用户绑定只读角色 ===")
    rbac = f"""apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {{name: oidc-viewer}}
roleRef: {{apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view}}
subjects:
  - {{apiGroup: rbac.authorization.k8s.io, kind: User, name: "{USER}"}}
"""
    (WORK / "s17-rbac.yaml").write_text(rbac, encoding="utf-8")
    fleet.scp("s17-rbac.yaml", "/root/s17-rbac.yaml", cp1)
    rc, out = fleet.ssh(cp1, "export KUBECONFIG=/etc/kubernetes/admin.conf; kubectl apply -f /root/s17-rbac.yaml", timeout=120)
    print(out)

    print("=== 6. 取 token 并验证 ===")
    rc, out = fleet.ssh(cp1, f"""
TOKEN=$(curl -sk -X POST {ISSUER}/token -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' -d 'username={USER}' -d 'password={PASS}' \
  -d 'client_id={CLIENT_ID}' -d 'client_secret={CLIENT_SECRET}' -d 'scope=openid email groups' \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
echo "token_len=${{#TOKEN}}"
echo -n "can-i get pods:    "; kubectl --token "$TOKEN" --server https://172.23.163.97:16443 --insecure-skip-tls-verify auth can-i get pods -n demo-app 2>&1 | tail -1
echo -n "can-i delete pods: "; kubectl --token "$TOKEN" --server https://172.23.163.97:16443 --insecure-skip-tls-verify auth can-i delete pods -n demo-app 2>&1 | tail -1
""", timeout=300)
    print(out)

    cred = WORK / "oidc-cred.txt"
    cred.write_text(f"issuer={ISSUER}\nclient_id={CLIENT_ID}\nclient_secret={CLIENT_SECRET}\nuser={USER}\npassword={PASS}\n", encoding="utf-8")
    print(f"[记录] 凭据写入 {cred.name}")


if __name__ == "__main__":
    main()
