"""S2-B：下发加密/审计配置 → 校验 kubeadm 配置 → （可选 reset）→ cp-1 init。"""
import base64
import secrets
import sys

import fleet

ENC_TMPL = """apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: {key}
      - identity: {{}}
"""


def prepare():
    keyfile = fleet.WORK / "enc-key.b64"
    if keyfile.exists():
        key = keyfile.read_text(encoding="utf-8").strip()
        print("复用已有加密 key")
    else:
        key = base64.b64encode(secrets.token_bytes(32)).decode()
        keyfile.write_text(key + "\n", encoding="utf-8")
        print("生成新加密 key（aes-256-cbc，落本地 enc-key.b64，勿外传）")
    enc = fleet.WORK / "s2-encryption-config.yaml"
    enc.write_text(ENC_TMPL.format(key=key), encoding="utf-8")

    for host in fleet.masters():
        # 先建目录，否则 scp 会静默失败（第一次就栽在这）
        fleet.ssh(host, "mkdir -p /etc/kubernetes/audit /etc/kubernetes/enc /var/log/kubernetes",
                  timeout=30)
        r1 = fleet.scp("s2-audit-policy.yaml", "/etc/kubernetes/audit/policy.yaml", host)
        r2 = fleet.scp("s2-encryption-config.yaml", "/etc/kubernetes/enc/encryption-config.yaml", host)
        rc, out = fleet.ssh(host, """
chmod 700 /etc/kubernetes/enc /etc/kubernetes/audit
chmod 600 /etc/kubernetes/enc/encryption-config.yaml
sed -i 's/\\r$//' /etc/kubernetes/audit/policy.yaml /etc/kubernetes/enc/encryption-config.yaml
echo "present=$(ls /etc/kubernetes/audit/policy.yaml /etc/kubernetes/enc/encryption-config.yaml 2>/dev/null | wc -l)"
""", timeout=60)
        print(f"[{host[0]}] scp(rc {r1[0]}/{r2[0]}) {out}")


def reset_cp1():
    cp1 = fleet.by_name("cp-1")
    rc, out = fleet.ssh(cp1, """
kubeadm reset -f --cri-socket unix:///run/containerd/containerd.sock >/dev/null 2>&1 || true
rm -rf /etc/kubernetes/manifests/*.yaml /var/lib/etcd /etc/cni/net.d/* /var/lib/kubelet/config.yaml
systemctl restart containerd kubelet
sleep 3
echo "reset done: manifests=$(ls /etc/kubernetes/manifests 2>/dev/null | wc -l) etcd=$(test -d /var/lib/etcd && echo exists || echo clean)"
""", timeout=180)
    print(f"[reset] rc={rc} {out}")


def validate_and_init():
    cp1 = fleet.by_name("cp-1")
    fleet.scp("s2-init.yaml", "/root/s2-init.yaml", cp1)
    rc, out = fleet.ssh(cp1, "sed -i 's/\\r$//' /root/s2-init.yaml; kubeadm config validate --config /root/s2-init.yaml 2>&1 | tail -12", timeout=120)
    print(f"\n=== kubeadm config validate rc={rc}\n{out}")
    if rc != 0:
        raise SystemExit("配置校验未通过，禁止 init")

    print("\n=== kubeadm init（--skip-phases=addon/kube-proxy，Cilium 接管）===")
    rc, out = fleet.ssh(cp1, """
kubeadm init --config /root/s2-init.yaml --upload-certs --skip-phases=addon/kube-proxy 2>&1 | tail -25
""", timeout=900)
    print(f"rc={rc}\n{out}")
    return rc


if __name__ == "__main__":
    prepare()
    if "--reset" in sys.argv:
        reset_cp1()
    sys.exit(validate_and_init())
