"""S2-C：验 init 产物 → join cp-2/cp-3（控制面）→ join 5 台 worker → 汇总。"""
import concurrent.futures as cf
import re
import time

import fleet

CRI = "unix:///run/containerd/containerd.sock"


def verify_cp1():
    cp1 = fleet.by_name("cp-1")
    rc, out = fleet.ssh(cp1, r"""
export KUBECONFIG=/etc/kubernetes/admin.conf
mkdir -p /root/.kube && cp -f /etc/kubernetes/admin.conf /root/.kube/config
echo '--- manifests ---'; ls /etc/kubernetes/manifests/
echo '--- cert SAN ---'; openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text | grep -A1 'Subject Alternative Name' | tail -1
echo '--- healthz ---'; curl -sk --max-time 5 https://127.0.0.1:6443/healthz; echo
echo '--- vip healthz ---'; curl -sk --max-time 8 https://172.23.163.97:16443/healthz; echo
echo '--- nodes ---'; kubectl get nodes -o wide 2>&1 | head -5
echo '--- etcd members ---'; kubectl -n kube-system exec etcd-cp-1 -- etcdctl member list --cacert /etc/kubernetes/pki/etcd/ca.crt --cert /etc/kubernetes/pki/etcd/server.crt --key /etc/kubernetes/pki/etcd/server.key 2>&1 | tail -5
echo '--- audit log ---'; ls -l /var/log/kubernetes/audit.log 2>&1; tail -1 /var/log/kubernetes/audit.log 2>/dev/null | cut -c1-160
echo '--- kube-proxy ---'; kubectl -n kube-system get ds 2>&1 | tail -3
""", timeout=180)
    print(f"=== cp-1 init 产物（rc={rc}）\n{out}")
    return out


def join_control_plane():
    cp1 = fleet.by_name("cp-1")
    rc, out = fleet.ssh(cp1, "kubeadm token create --print-join-command 2>/dev/null", timeout=120)
    m = re.search(r"kubeadm join (\S+) --token (\S+) --discovery-token-ca-cert-hash (\S+)", out)
    if not m:
        raise SystemExit(f"拿不到 join 命令: {out}")
    endpoint, token, hash_ = m.groups()

    rc, out = fleet.ssh(cp1, "kubeadm init phase upload-certs --upload-certs 2>/dev/null | tail -2", timeout=180)
    cert_key = out.strip().splitlines()[-1].strip()
    print(f"endpoint={endpoint} token={token} cert_key={cert_key[:12]}…")

    for host in [h for h in fleet.masters() if h[0] != "cp-1"]:
        name, ip = host[0], host[2]
        cmd = (f"kubeadm join {endpoint} --token {token} "
               f"--discovery-token-ca-cert-hash {hash_} --control-plane "
               f"--certificate-key {cert_key} --apiserver-advertise-address {ip} "
               f"--node-name {name} --cri-socket {CRI} 2>&1 | tail -8")
        rc, out = fleet.ssh(host, cmd, timeout=900)
        print(f"[join {name}] rc={rc}\n{out}")
        if rc != 0:
            raise SystemExit(f"{name} 加入控制面失败")
        time.sleep(3)
    return endpoint, token, hash_


def join_workers(endpoint, token, hash_):
    def one(host):
        name = host[0]
        cmd = (f"kubeadm join {endpoint} --token {token} "
               f"--discovery-token-ca-cert-hash {hash_} --node-name {name} "
               f"--cri-socket {CRI} 2>&1 | tail -4")
        rc, out = fleet.ssh(host, cmd, timeout=900)
        return name, rc, out

    with cf.ThreadPoolExecutor(max_workers=5) as ex:
        for name, rc, out in ex.map(one, fleet.workers()):
            print(f"[join {name}] rc={rc} {out.strip()[-160:]}")


def summary():
    cp1 = fleet.by_name("cp-1")
    rc, out = fleet.ssh(cp1, r"""
export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl get nodes -o wide
echo '--- etcd ---'
kubectl -n kube-system exec etcd-cp-1 -- etcdctl member list --cacert /etc/kubernetes/pki/etcd/ca.crt --cert /etc/kubernetes/pki/etcd/server.crt --key /etc/kubernetes/pki/etcd/server.key 2>&1
echo '--- endpoint health ---'
kubectl -n kube-system exec etcd-cp-1 -- etcdctl endpoint health --cluster --cacert /etc/kubernetes/pki/etcd/ca.crt --cert /etc/kubernetes/pki/etcd/server.crt --key /etc/kubernetes/pki/etcd/server.key 2>&1
""", timeout=180)
    print(f"\n=== 集群现状（rc={rc}）\n{out}")


if __name__ == "__main__":
    verify_cp1()
    ep, tk, hs = join_control_plane()
    join_workers(ep, tk, hs)
    time.sleep(5)
    summary()
