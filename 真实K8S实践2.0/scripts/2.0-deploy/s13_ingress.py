"""S13：入口 —— cert-manager(内部CA) + Envoy Gateway + Gateway(TLS) + HTTPRoute。

验收三条：HTTPS 200 / 错误 Host 404 / HTTP 301。
"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent

PKI = """apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: {name: selfsigned-bootstrap}
spec: {selfSigned: {}}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: {name: internal-ca, namespace: cert-manager}
spec:
  isCA: true
  commonName: k8s20-internal-ca
  secretName: internal-ca-keypair
  privateKey: {algorithm: ECDSA, size: 256}
  issuerRef: {name: selfsigned-bootstrap, kind: ClusterIssuer}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: {name: internal-ca}
spec:
  ca: {secretName: internal-ca-keypair}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: {name: apps-wildcard, namespace: cert-manager}
spec:
  secretName: apps-wildcard-tls
  commonName: "*.apps.k8s.local"
  dnsNames: ["*.apps.k8s.local", "apps.k8s.local"]
  duration: 2160h
  renewBefore: 720h
  privateKey: {algorithm: ECDSA, size: 256}
  issuerRef: {name: internal-ca, kind: ClusterIssuer}
"""

GW = """apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: eg
  namespace: demo-app
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces: {from: Same}
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - {name: apps-wildcard-tls, namespace: cert-manager}
      allowedRoutes:
        namespaces: {from: Same}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {name: demo-redirect, namespace: demo-app}
spec:
  parentRefs: [{name: eg, sectionName: http}]
  hostnames: ["demo.apps.k8s.local"]
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect: {scheme: https, statusCode: 301}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {name: demo, namespace: demo-app}
spec:
  parentRefs: [{name: eg, sectionName: https}]
  hostnames: ["demo.apps.k8s.local"]
  rules:
    - backendRefs: [{name: web, port: 80}]
"""


def main():
    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    for n, b in (("s13-pki.yaml", PKI), ("s13-gateway.yaml", GW)):
        (WORK / n).write_text(b, encoding="utf-8")
        fleet.scp(n, f"/root/{n}", cp1)

    script = base + r"""
set -o pipefail
echo "=== 0. 准入排除名单加两个新命名空间 ==="
for p in disallow-latest-tag require-resources disallow-privileged; do
  kubectl get validatingpolicy.policies.kyverno.io $p -o json 2>/dev/null | \
    python3 -c "
import json,sys
d=json.load(sys.stdin)
mc=d['spec'].get('matchConditions',[])
for m in mc:
    m['expression']=m['expression'].replace(\"'monitoring'\", \"'monitoring','cert-manager','envoy-gateway-system'\")
print(json.dumps(d['spec']['matchConditions']))
" > /tmp/mc-$p.json 2>/dev/null
  kubectl patch validatingpolicy.policies.kyverno.io $p --type=merge \
    --patch "{\"spec\":{\"matchConditions\":$(cat /tmp/mc-$p.json)}}" >/dev/null 2>&1
done
kubectl get validatingpolicy.policies.kyverno.io -o custom-columns=NAME:.metadata.name 2>/dev/null | tail -3

echo "=== 1. cert-manager ==="
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1
helm upgrade --install cert-manager jetstack/cert-manager --version v1.19.1 -n cert-manager --create-namespace \
  --set crds.enabled=true --set replicaCount=2 --wait --timeout 10m 2>&1 | tail -3

echo "=== 2. 内部 CA + 通配符证书 ==="
kubectl apply -f /root/s13-pki.yaml 2>&1 | tail -4
for i in $(seq 1 24); do
  s=$(kubectl -n cert-manager get certificate apps-wildcard -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
  [ "$s" = "True" ] && break; sleep 5
done
echo "wildcard cert ready=$s"
kubectl -n cert-manager get secret apps-wildcard-tls -o jsonpath='{.data.tls\.crt}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -enddate 2>/dev/null

echo "=== 3. Envoy Gateway 1.10.0（用 release manifest，避开 OCI 拉取）==="
kubectl apply --server-side -f https://github.com/envoyproxy/gateway/releases/download/v1.10.0/install.yaml 2>&1 | tail -3
kubectl -n envoy-gateway-system rollout status deploy/envoy-gateway --timeout=8m 2>&1 | tail -2
kubectl get gatewayclass 2>&1

echo "=== 4. Gateway + HTTPRoute ==="
kubectl apply -f /root/s13-gateway.yaml 2>&1 | tail -3
for i in $(seq 1 24); do
  p=$(kubectl -n demo-app get gateway eg -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}' 2>/dev/null)
  [ "$p" = "True" ] && break; sleep 5
done
echo "gateway programmed=$p"
kubectl -n demo-app get gateway,httproute 2>&1 | head -6

echo "=== 5. 把 EG 生成的服务改成 NodePort ==="
SVC=$(kubectl -n envoy-gateway-system get svc -o name | grep envoy | head -1 | cut -d/ -f2)
echo "svc=$SVC"
kubectl -n envoy-gateway-system patch svc $SVC --type=merge \
  -p '{"spec":{"type":"NodePort"}}' >/dev/null 2>&1
sleep 8
kubectl -n envoy-gateway-system get svc $SVC -o jsonpath='{.spec.type} {range .spec.ports[*]}{.name}={.nodePort} {end}{"\n"}'
echo "=== 6. 三条验收 ==="
HTTPS_NP=$(kubectl -n envoy-gateway-system get svc $SVC -o jsonpath='{.spec.ports[?(@.name=="https")].nodePort}')
HTTP_NP=$(kubectl -n envoy-gateway-system get svc $SVC -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}')
echo "https_nodeport=$HTTPS_NP http_nodeport=$HTTP_NP"
NODE=172.23.163.110
echo -n "① 正确 Host + HTTPS  -> "; curl -sk --resolve demo.apps.k8s.local:$HTTPS_NP:$NODE -o /dev/null -w '%{http_code}\n' https://demo.apps.k8s.local:$HTTPS_NP/
echo -n "② 错误 Host          -> "; curl -sk --resolve wrong.apps.k8s.local:$HTTPS_NP:$NODE -o /dev/null -w '%{http_code}\n' https://wrong.apps.k8s.local:$HTTPS_NP/
echo -n "③ HTTP 跳 HTTPS      -> "; curl -s -o /dev/null -w '%{http_code} loc=%{redirect_url}\n' http://$NODE:$HTTP_NP/ -H 'Host: demo.apps.k8s.local'
echo -n "④ 证书链             -> "; echo | openssl s_client -connect $NODE:$HTTPS_NP -servername demo.apps.k8s.local 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null | tr '\n' ' '
echo
"""
    rc, out = fleet.ssh(cp1, script, timeout=1800)
    print(out)
    print("rc=", rc)


if __name__ == "__main__":
    main()
