"""S4：open-iscsi/nfs 前置 -> Longhorn（3 副本）-> metrics-server。"""
import concurrent.futures as cf
import sys

import fleet

LONGHORN = "1.13.0"
METRICS = "3.13.0"


def deps(host):
    rc, out = fleet.ssh(host, "DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 "
                              "install -y -qq open-iscsi nfs-common >/tmp/iscsi.log 2>&1; "
                              "systemctl enable --now iscsid >/dev/null 2>&1; "
                              "echo iscsid=$(systemctl is-active iscsid) "
                              "iscsi=$(iscsiadm --version 2>/dev/null | awk '{print $3}')", timeout=420)
    return host[0], out


def main():
    with cf.ThreadPoolExecutor(8) as ex:
        for name, out in ex.map(deps, fleet.masters() + fleet.workers()):
            print(f"[{name}] {out}")

    cp1 = fleet.by_name("cp-1")
    base = "export KUBECONFIG=/etc/kubernetes/admin.conf; "
    script = base + f"""
helm repo add longhorn https://charts.longhorn.io >/dev/null 2>&1 || true
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1

echo "=== Longhorn {LONGHORN} ==="
helm upgrade --install longhorn longhorn/longhorn --version {LONGHORN} -n longhorn-system --create-namespace \\
  --set defaultSettings.defaultReplicaCount=3 \\
  --set defaultSettings.defaultDataPath=/var/lib/longhorn \\
  --set defaultSettings.backupTarget="" \\
  --set persistence.defaultClassReplicaCount=3 \\
  --set csi.kubeletRootDir=/var/lib/kubelet \\
  --set longhornUI.replicas=1 \\
  --set ingress.enabled=false --wait --timeout 15m 2>&1 | tail -5

echo "=== metrics-server {METRICS} ==="
helm upgrade --install metrics-server metrics-server/metrics-server --version {METRICS} \\
  -n kube-system --set replicas=2 --set args="{{--kubelet-insecure-tls}}" \\
  --wait --timeout 8m 2>&1 | tail -4
"""
    rc, out = fleet.ssh(cp1, script, timeout=1800)
    print(out)
    print("rc=", rc)


if __name__ == "__main__":
    main()
