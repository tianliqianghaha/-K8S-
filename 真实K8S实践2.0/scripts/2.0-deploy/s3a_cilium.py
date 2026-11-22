"""S3-A：Helm + Gateway API CRD + Cilium 1.20.4（eBPF 全接管，无 kube-proxy）。"""
import time

import fleet

CILIUM_VERSION = "1.20.4"
GATEWAY_API = "v1.7.0"


def sh(host, cmd, timeout=600):
    rc, out = fleet.ssh(host, cmd, timeout=timeout)
    print(out)
    return rc, out


def main():
    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "

    print("=== 1. 装 Helm ===")
    sh(cp1, base + r"""
if ! command -v helm >/dev/null; then
  curl -fsSL https://get.helm.sh/helm-v3.19.0-linux-amd64.tar.gz -o /tmp/helm.tgz && \
  tar -C /tmp -xzf /tmp/helm.tgz && install -m755 /tmp/linux-amd64/helm /usr/local/bin/helm
fi
helm version --short
""", 300)

    print("=== 2. Gateway API CRD v1.6.1 ===")
    sh(cp1, base + rf"""
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/{GATEWAY_API}/standard-install.yaml 2>&1 | tail -5
kubectl get crd | grep -c gateway.networking.k8s.io
""", 300)

    print("=== 3. Cilium 仓库与安装 ===")
    sh(cp1, base + rf"""
helm repo add cilium https://helm.cilium.io/ >/dev/null 2>&1 || true
helm repo update cilium >/dev/null 2>&1
helm upgrade --install cilium cilium/cilium --version {CILIUM_VERSION} \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=172.23.163.97 \
  --set k8sServicePort=16443 \
  --set routingMode=tunnel \
  --set tunnelProtocol=vxlan \
  --set ipam.mode=kubernetes \
  --set operator.replicas=2 \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.ui.service.type=NodePort \
  --set bpf.masquerade=true \
  --set ipMasqAgent.enabled=true \
  --wait --timeout 12m 2>&1 | tail -8
""", 1200)

    print("=== 3.5 装 cilium CLI ===")
    sh(cp1, base + r"""
if ! command -v cilium >/dev/null; then
  curl -fsSL https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz \
    | tar -C /usr/local/bin -xz cilium
fi
cilium version --client 2>&1 | head -2
""", 300)

    print("\n=== 4. 等 agent 就绪 ===")
    for _ in range(40):
        rc, out = fleet.ssh(cp1, base + "cilium status --wait --wait-duration 3m 2>&1 | tail -22", timeout=300)
        if "KubeProxyReplacement" in out and "8/8" in out:
            print(out)
            break
        time.sleep(10)
    else:
        print(out)


if __name__ == "__main__":
    main()
