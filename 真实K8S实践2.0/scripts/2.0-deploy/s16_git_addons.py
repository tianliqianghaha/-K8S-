"""S16：把 addon 全部声明进 Git（ArgoCD Application），并证明一条自动同步回路。"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent
APP = """apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {name}
  namespace: argocd
  finalizers: [resources-finalizer.argocd.argoproj.io]
  annotations:
    practice.local/note: "{note}"
spec:
  project: default
  source:
    repoURL: {repo}
    chart: {chart}
    targetRevision: {ver}
    helm:
      releaseName: {release}
      valueFiles: []
  destination:
    server: https://kubernetes.default.svc
    namespace: {ns}
  {sync}
"""

# name, chart, version, ns, release, 自动同步?, 说明
ITEMS = [
    ("addon-kyverno",        "kyverno/kyverno",                  "3.6.1",  "kyverno",        "kyverno",        True,  "准入控制器，自动同步用于验证回路"),
    ("addon-keda",           "kedacore/keda",                    "2.18.0", "keda",           "keda",           True,  "事件驱动扩缩"),
    ("addon-vpa",            "cowboysysop/vertical-pod-autoscaler","9.5.0","vpa",            "vpa",            False, "VPA 三件套（版本需按实际）"),
    ("addon-argo-rollouts",  "argo/argo-rollouts",               "2.8.3",  "argo-rollouts",  "argo-rollouts",  False, "渐进发布"),
    ("addon-cert-manager",   "jetstack/cert-manager",            "v1.19.1","cert-manager",  "cert-manager",   False, "证书签发"),
    ("addon-metrics-server", "metrics-server/metrics-server",    "3.13.0", "kube-system",    "metrics-server", False, "指标聚合"),
    ("addon-sealed-secrets", "sealed-secrets/sealed-secrets",    "2.18.1", "kube-system",    "sealed-secrets", False, "密钥封存"),
    ("addon-velero",         "vmware-tanzu/velero",              "11.0.0", "velero",         "velero",         False, "对象级备份"),
    ("addon-longhorn",       "longhorn/longhorn",                "1.13.0", "longhorn-system","longhorn",       False, "数据面存储，禁止自动 reconcile"),
    ("addon-cilium",         "cilium/cilium",                    "1.20.4", "kube-system",    "cilium",         False, "数据面网络，禁止自动 reconcile"),
]

REPOS = {
    "kyverno": "https://kyverno.github.io/kyverno",
    "kedacore": "https://kedacore.github.io/charts",
    "cowboysysop": "https://cowboysysop.github.io/charts/",
    "argo": "https://argoproj.github.io/argo-helm",
    "jetstack": "https://charts.jetstack.io",
    "metrics-server": "https://kubernetes-sigs.github.io/metrics-server/",
    "sealed-secrets": "https://bitnami-labs.github.io/sealed-secrets",
    "vmware-tanzu": "https://vmware-tanzu.github.io/helm-charts",
    "longhorn": "https://charts.longhorn.io",
    "cilium": "https://helm.cilium.io/",
}


def main():
    out_dir = WORK / "apps_addons"
    out_dir.mkdir(exist_ok=True)
    files = []
    for name, chart, ver, ns, rel, auto, note in ITEMS:
        repo = REPOS[chart.split("/")[0]]
        sync = ("syncPolicy:\n    automated: {prune: false, selfHeal: true}\n    syncOptions: [ServerSideApply=true]"
                if auto else "syncPolicy: null")
        body = APP.format(name=name, chart=chart.split("/")[1], ver=ver, ns=ns,
                          release=rel, repo=repo, sync=sync, note=note)
        p = out_dir / f"{name}.yaml"
        p.write_text(body, encoding="utf-8")
        files.append(p.name)
    print("生成", len(files), "个 Application")

    cp1 = fleet.by_name("cp-1")
    pw = [l.split("=", 1)[1].strip() for l in (WORK / "gitea-admin.txt").read_text(encoding="utf-8").splitlines() if l.startswith("password=")][0]

    fleet.ssh(cp1, "mkdir -p /root/repo/apps/addons && rm -f /root/repo/apps/addons/*.yaml", timeout=60)
    for f in files:
        fleet.scp(str(out_dir / f), f"/root/repo/apps/addons/{f}", cp1)

    script = f"""export KUBECONFIG=/etc/kubernetes/admin.conf
cd /root/repo
git add -A
git -c user.email=a@k8s.local -c user.name=deploy commit -q -m "addons: declare all releases as ArgoCD Applications" 2>&1 | tail -1
git push -q http://gitea_admin:{pw}@172.23.163.111:3000/gitea_admin/k8s-manifests.git HEAD:main --force 2>&1 | tail -1
kubectl apply -f /root/repo/apps/addons/ 2>&1 | tail -3
sleep 45
kubectl -n argocd get applications --no-headers 2>&1
echo "--- 自动同步的 kyverno 是否真的被接管 ---"
kubectl -n argocd get application addon-kyverno -o jsonpath='{{.status.sync.status}} {{.status.health.status}}{{"\\n"}}' 2>&1
"""
    rc, out = fleet.ssh(cp1, script, timeout=900)
    print(out)


if __name__ == "__main__":
    main()
