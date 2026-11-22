#!/usr/bin/env python3
"""第 7 章 · 把集群里的明文 Secret 加密成可进 Git 的 SealedSecret

用法:
    python3 s20-seal-secrets.py list                 # 列出待处理 Secret
    python3 s20-seal-secrets.py seal <ns>/<name>     # 只加密，不删原 Secret
    python3 s20-seal-secrets.py migrate <ns>/<name>  # 加密 -> 删原 Secret -> 解封 -> 校验

原则:
  1. 加密产物直接写 Git 工作副本，明文永不落盘到仓库
  2. 迁移前把原 Secret 备份到 /root/secret-backup/，失败可秒回滚
  3. 解封后比对 data 的 sha256，必须完全一致
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

KUBECONFIG = "/etc/kubernetes/admin.conf"
CERT = "/etc/kubernetes/sealed-secrets.pem"
REPO = Path("/root/manifests")
OUT_DIR = REPO / "secrets"
BACKUP = Path("/root/secret-backup")

# 要纳管的 Secret：namespace/name  ->  说明
TARGETS = {
    "monitoring/grafana-admin": "Grafana 管理员口令",
    "longhorn-system/longhorn-backup-credentials": "Longhorn 备份到 S3 的 AK/SK",
    "velero/cloud-credentials": "Velero 备份到 S3 的凭据",
    "argocd/gitea-repo": "ArgoCD 拉取 Git 仓库的凭据",
}


def run(cmd, check=True, stdin=None):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                       input=stdin, env={**os.environ, "KUBECONFIG": KUBECONFIG})
    if check and p.returncode != 0:
        raise RuntimeError(f"FAILED: {cmd}\n{p.stdout}\n{p.stderr}")
    return p


def clean_secret(ns, name):
    """取 Secret 并去掉服务端字段，只留可加密的最小结构"""
    out = run(f"kubectl -n {ns} get secret {name} -o json").stdout
    d = json.loads(out)
    body = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": name, "namespace": ns},
    }
    if d.get("type"):
        body["type"] = d["type"]
    if d.get("data"):
        body["data"] = d["data"]
    if d.get("stringData"):
        body["stringData"] = d["stringData"]
    return body


def data_sha(body):
    """对 data 的 key/value 取稳定指纹（用于迁移前后比对）"""
    data = body.get("data") or {}
    blob = json.dumps(data, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def seal(ns, name):
    body = clean_secret(ns, name)
    before = data_sha(body)
    plain = json.dumps(body)
    r = run(f"kubeseal --cert {CERT} --format yaml", stdin=plain)
    sealed = r.stdout
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    f = OUT_DIR / f"{ns}__{name}.yaml"
    f.write_text(sealed, encoding="utf-8")
    return f, before


def migrate(ns, name):
    BACKUP.mkdir(parents=True, exist_ok=True)
    # 1) 备份明文（本地 root 目录，权限 600，不进 Git）
    raw = run(f"kubectl -n {ns} get secret {name} -o yaml").stdout
    bak = BACKUP / f"{ns}__{name}.yaml"
    bak.write_text(raw, encoding="utf-8")
    bak.chmod(0o600)
    before = data_sha(clean_secret(ns, name))

    # 2) 加密
    f, _ = seal(ns, name)

    # 3) 删原 Secret -> 立刻 apply SealedSecret
    run(f"kubectl -n {ns} delete secret {name} --ignore-not-found")
    run(f"kubectl apply -f {f}")

    # 4) 等 controller 解封
    import time
    for _ in range(20):
        p = run(f"kubectl -n {ns} get secret {name} -o json", check=False)
        if p.returncode == 0:
            break
        time.sleep(1)
    else:
        run(f"kubectl -n {ns} apply -f {bak}")   # 回滚
        raise RuntimeError(f"{ns}/{name} 解封超时，已回滚")

    after = data_sha(clean_secret(ns, name))
    ok = before == after
    if not ok:
        run(f"kubectl -n {ns} delete secret {name} --ignore-not-found")
        run(f"kubectl -n {ns} apply -f {bak}")
        raise RuntimeError(f"{ns}/{name} 数据不一致 {before} != {after}，已回滚")
    return f, before, after


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    act = sys.argv[1]
    if act == "list":
        for k, v in TARGETS.items():
            print(f"{k:52s} {v}")
        print("\n也可直接处理任意 Secret：seal <ns>/<name>")
        return 0

    target = sys.argv[2]
    ns, name = target.split("/", 1)

    if act == "seal":
        f, before = seal(ns, name)
        print(f"[seal] {ns}/{name} -> {f}  data_sha256={before}")
        print(f"       size={f.stat().st_size}B  明文未落盘")
        return 0

    if act == "migrate":
        f, before, after = migrate(ns, name)
        print(f"[migrate] {ns}/{name}")
        print(f"  sealed   : {f} ({f.stat().st_size}B)")
        print(f"  backup   : {BACKUP / (ns + '__' + name + '.yaml')}")
        print(f"  data_sha : {before} -> {after}  {'一致' if before == after else '不一致'}")
        return 0

    print(f"未知动作 {act}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
