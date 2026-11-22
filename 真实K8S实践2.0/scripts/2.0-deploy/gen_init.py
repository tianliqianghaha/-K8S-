"""生成 s2-init.yaml：版本取 cp-1 上真实装到的 kubeadm，SAN 按本次拓扑生成。"""
import sys
from pathlib import Path

import fleet

rc, out = fleet.ssh(fleet.by_name("cp-1"), "kubeadm version -o short 2>/dev/null; kubeadm version -o json 2>/dev/null | grep -o '\"gitVersion\":\"[^\"]*\"' | head -1", timeout=60)
print("kubeadm on cp-1:", out.replace("\n", " "))
ver = ""
for line in out.splitlines():
    if line.startswith("v1."):
        ver = line.strip()
if not ver:
    raise SystemExit(f"读不到 kubeadm 版本: {out}")

san = [fleet.VIP] + [h[2] for h in fleet.HOSTS] + [h[0] for h in fleet.HOSTS] + ["api-vip", "127.0.0.1"]
san_block = "\n".join(f"    - {s}" for s in san)

tmpl = f"""apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: 172.23.163.109
  bindPort: 6443
nodeRegistration:
  name: cp-1
  criSocket: unix:///run/containerd/containerd.sock
  imagePullPolicy: IfNotPresent
---
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
clusterName: k8s-prod-practice
kubernetesVersion: {ver}
controlPlaneEndpoint: {fleet.VIP}:{fleet.APISERVER_PORT}
imageRepository: registry.k8s.io
networking:
  podSubnet: 10.244.0.0/16
  serviceSubnet: 10.96.0.0/12
  dnsDomain: cluster.local
etcd:
  local:
    dataDir: /var/lib/etcd
apiServer:
  certSANs:
{san_block}
  extraArgs:
    - name: audit-policy-file
      value: /etc/kubernetes/audit/policy.yaml
    - name: audit-log-path
      value: /var/log/kubernetes/audit.log
    - name: audit-log-maxsize
      value: "100"
    - name: audit-log-maxbackup
      value: "10"
    - name: audit-log-maxage
      value: "7"
    - name: encryption-provider-config
      value: /etc/kubernetes/enc/encryption-config.yaml
  extraVolumes:
    - name: audit-policy
      hostPath: /etc/kubernetes/audit
      mountPath: /etc/kubernetes/audit
      readOnly: true
      pathType: DirectoryOrCreate
    - name: audit-log
      hostPath: /var/log/kubernetes
      mountPath: /var/log/kubernetes
      pathType: DirectoryOrCreate
    - name: enc-config
      hostPath: /etc/kubernetes/enc
      mountPath: /etc/kubernetes/enc
      readOnly: true
      pathType: DirectoryOrCreate
controllerManager:
  extraArgs:
    - name: bind-address
      value: 0.0.0.0
    - name: terminated-pod-gc-threshold
      value: "500"
scheduler:
  extraArgs:
    - name: bind-address
      value: 0.0.0.0
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
systemReserved:
  cpu: 100m
  memory: 200Mi
  ephemeral-storage: 1Gi
kubeReserved:
  cpu: 200m
  memory: 300Mi
  ephemeral-storage: 2Gi
evictionHard:
  memory.available: 200Mi
  nodefs.available: 10%
  imagefs.available: 15%
containerLogMaxSize: 50Mi
containerLogMaxFiles: 5
serverTLSBootstrap: false
rotateCertificates: true
"""
p = Path(__file__).resolve().parent / "s2-init.yaml"
p.write_text(tmpl, encoding="utf-8")
print(f"-> {p.name} kubernetesVersion={ver} san={len(san)}")
