"""一键只读验收：从 cp-1 采集所有关键读数，按阈值判 PASS/FAIL，输出可对比的 JSON。

只读，不创建、不修改任何资源。用法：python verify_all.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import fleet

REMOTE_PATH = Path(__file__).resolve().parent / "verify_remote.sh"


# 检查项：key, 说明, 判定(lambda: bool), 期望值描述
CHECKS = [
    ("nodes_ready",         "节点 Ready",            lambda v: v == v_total("nodes_total", 8), "= 总数"),
    ("pods_bad",            "异常 Pod",              lambda v: v == 0, "0"),
    ("pvc_bound",           "PVC Bound",             lambda v: v == v_total("pvc_total", 0), "= 总数"),
    ("kube_proxy_ds",       "kube-proxy 存在",        lambda v: v == 0, "0"),
    ("kubesvc_chains",      "KUBE-SVC 链",           lambda v: v == 0, "0"),
    ("etcd_members",        "etcd 成员 started",     lambda v: v >= 3, ">=3"),
    ("cilium_ready",        "cilium agent Ready",    lambda v: v >= 8, ">=8"),
    ("prom_ready",          "Prometheus 副本",       lambda v: v >= 2, ">=2"),
    ("am_ready",            "Alertmanager 副本",     lambda v: v >= 3, ">=3"),
    ("grafana_ready",       "Grafana 副本",          lambda v: v >= 2, ">=2"),
    ("alloy_ready",         "Alloy 日志采集",        lambda v: v >= 8, ">=8"),
    ("beyla_ready",         "beyla eBPF 探针",       lambda v: v >= 5, ">=5"),
    ("tempo_ready",         "Tempo",                lambda v: v >= 1, ">=1"),
    ("otelcol_ready",       "OTel Collector",       lambda v: v >= 1, ">=1"),
    ("longhorn_target",     "备份目标可用",          lambda v: v == "true", "true"),
    ("longhorn_healthy",    "Longhorn 卷 healthy",   lambda v: v >= 1, ">=1"),
    ("velero_bsl",          "Velero BSL",           lambda v: v == "Available", "Available"),
    ("velero_backups",      "已完成的备份",          lambda v: v >= 1, ">=1"),
    ("kyverno_policies",    "Kyverno 校验策略",      lambda v: v >= 3, ">=3"),
    ("map_policies",        "原生变更策略",          lambda v: v >= 1, ">=1"),
    ("vpa_objects",         "VPA 对象",             lambda v: v >= 1, ">=1"),
    ("keda_so",             "KEDA ScaledObject",    lambda v: v >= 1, ">=1"),
    ("kueue_wl",            "Kueue Workload",       lambda v: v >= 1, ">=1"),
    ("argo_healthy",        "ArgoCD 健康应用",       lambda v: v >= 1, ">=1"),
    ("rollout_phase",       "Rollout 相位",          lambda v: v in ("Healthy", "Paused", "Progressing"), "Healthy/Paused"),
    ("zone_b",              "b 区节点",             lambda v: v >= 2, ">=2"),
    ("zone_d",              "d 区节点",             lambda v: v >= 2, ">=2"),
    ("zone_c",              "c 区节点",             lambda v: v >= 3, ">=3"),
    ("helm_not_deployed",   "非 deployed 的发布",    lambda v: v == 0, "0"),
    ("encryption",         "东西向加密",              lambda v: v == "Wireguard", "Wireguard"),
    ("sealed_secret",      "Sealed Secret 已生成",     lambda v: v >= 1, ">=1"),
    ("oidc_flags",         "apiserver OIDC 参数",      lambda v: v >= 1, ">=1"),
    ("argo_apps",          "Git 声明的应用数",          lambda v: v >= 10, ">=10"),
    ("gateway_prog",       "Gateway Programmed",      lambda v: v == "True", "True"),
    ("httproute_n",        "HTTPRoute 数量",           lambda v: v >= 2, ">=2"),
    ("cert_ready",         "通配符证书就绪",            lambda v: v == "True", "True"),
    ("ing_https_ok",       "入口 HTTPS 正常 Host",      lambda v: v == 200, "200"),
    ("ing_host_bad",       "入口 错误 Host",           lambda v: v == 404, "404"),
    ("ing_redirect",       "入口 HTTP 跳转",           lambda v: v == 301, "301"),
    ("deviceclass_n",      "DRA DeviceClass",         lambda v: v >= 1, ">=1"),
    ("dra_slices",         "DRA ResourceSlice",       lambda v: v >= 5, ">=5"),
    ("dra_claim_ok",       "DRA 设备已分配",          lambda v: v >= 1, ">=1"),
]


def v_total(key, default):
    return DATA.get(key, default)


DATA = {}


def main():
    global DATA
    cp1 = fleet.by_name("cp-1")
    fleet.scp("verify_remote.sh", "/root/verify_remote.sh", cp1)
    rc, out = fleet.ssh(cp1, "bash /root/verify_remote.sh", timeout=300)
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            try:
                DATA[k] = int(v)
            except ValueError:
                DATA[k] = v
    if len(DATA) < 10:
        print("采集失败，原始输出：\n" + out[:800])
        return 2

    rows, passed = [], 0
    for key, name, rule, expect in CHECKS:
        val = DATA.get(key)
        try:
            ok = bool(rule(val))
        except Exception:
            ok = False
        passed += ok
        rows.append((ok, name, val, expect))

    w = max(len(r[1]) for r in rows)
    print(f"{'结果':6s} {'检查项':<{w}} {'实测':>10s}  期望")
    print("-" * (w + 30))
    for ok, name, val, expect in rows:
        print(f"{'PASS' if ok else 'FAIL':6s} {name:<{w}} {str(val):>10s}  {expect}")

    total = len(rows)
    print("-" * (w + 30))
    print(f"合计 {passed}/{total} 通过")

    state = Path(__file__).resolve().parent / "state"
    state.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    (state / f"verify-{ts}.json").write_text(
        json.dumps({"ts": ts, "passed": passed, "total": total, "data": DATA}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"读数已存 state/verify-{ts}.json")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
