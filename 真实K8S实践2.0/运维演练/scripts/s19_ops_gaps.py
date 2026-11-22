"""S19：告警分级投递（P1/P2/P3）+ 命名空间配额 + 周恢复抽验脚本。"""
import sys
from pathlib import Path

import fleet

WORK = Path(__file__).resolve().parent

RECEIVER = '''#!/usr/bin/env python3
"""极简告警落点：按路径分 P1/P2/P3 写文件，用于验证 Alertmanager 路由。"""
import json, os, time
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = "/data/alerts"

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8", "replace")
        lvl = self.path.strip("/") or "unknown"
        os.makedirs(OUT, exist_ok=True)
        with open(f"{OUT}/{lvl}.log", "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.strftime("%F %T"), "body": json.loads(body) if body.startswith("{") else body}, ensure_ascii=False) + "\\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def log_message(self, *a):
        pass

HTTPServer(("0.0.0.0", 8088), H).serve_forever()
'''

AM_CONFIG = """route:
  receiver: p3
  group_by: [alertname, namespace]
  group_wait: 5s
  group_interval: 30s
  repeat_interval: 4h
  routes:
    - matchers: ['severity="critical"']
      receiver: p1
      continue: false
    - matchers: ['severity="warning"']
      receiver: p2
      continue: false
receivers:
  - name: p1
    webhook_configs: [{url: "http://172.23.163.111:8088/p1", send_resolved: true}]
  - name: p2
    webhook_configs: [{url: "http://172.23.163.111:8088/p2", send_resolved: true}]
  - name: p3
    webhook_configs: [{url: "http://172.23.163.111:8088/p3", send_resolved: true}]
"""

RESTORE_CHECK = r"""#!/bin/bash
# 周恢复抽验：把最近一次备份恢复到一个临时 ns，比对标记，然后删掉
set -uo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf
BK=$(kubectl -n velero get backups.velero.io --no-headers --sort-by=.metadata.creationTimestamp 2>/dev/null | tail -1 | awk '{print $1}')
[ -z "$BK" ] && { echo "FAIL 没有可用备份"; exit 1; }
NS=restore-check
kubectl delete ns "$NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1
T0=$(date +%s)
cat <<EOF | kubectl apply -f - >/dev/null 2>&1
apiVersion: velero.io/v1
kind: Restore
metadata: {name: check-$(date +%H%M%S), namespace: velero}
spec:
  backupName: $BK
  includedNamespaces: [demo-app]
  namespaceMapping: {demo-app: $NS}
  restorePVs: false
EOF
for i in $(seq 1 40); do
  m=$(kubectl -n "$NS" get cm marker -o jsonpath='{.data.who}' 2>/dev/null)
  [ "$m" = "k8s20" ] && break; sleep 3
done
T1=$(date +%s)
if [ "$m" = "k8s20" ]; then
  echo "PASS 恢复抽验 backup=$BK 标记=$m 耗时=$((T1-T0))s"
  RES=0
else
  echo "FAIL 恢复抽验 backup=$BK 标记='$m' 耗时=$((T1-T0))s"
  RES=1
fi
kubectl delete ns "$NS" --wait=false >/dev/null 2>&1
exit $RES
"""

QUOTA = """apiVersion: v1
kind: ResourceQuota
metadata: {name: demo-app-quota, namespace: demo-app}
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "30"
    persistentvolumeclaims: "6"
---
apiVersion: v1
kind: LimitRange
metadata: {name: demo-app-limits, namespace: demo-app}
spec:
  limits:
    - type: Container
      default: {cpu: 200m, memory: 128Mi}
      defaultRequest: {cpu: 20m, memory: 32Mi}
      max: {cpu: "2", memory: 2Gi}
"""


def main():
    cp1 = fleet.by_name("cp-1")
    infra = fleet.INFRA

    print("=== 1. infra-01 起告警落点 ===")
    (WORK / "alert-receiver.py").write_text(RECEIVER, encoding="utf-8", newline="\n")
    fleet.scp("alert-receiver.py", "/root/alert-receiver.py", infra)
    rc, out = fleet.ssh(infra, r"""
mkdir -p /data/alerts
cat > /etc/systemd/system/alert-receiver.service <<'EOF'
[Unit]
Description=Alert Receiver
After=network.target
[Service]
ExecStart=/usr/bin/python3 /root/alert-receiver.py
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now alert-receiver >/dev/null 2>&1
sleep 2
curl -s -X POST -d '{"probe":1}' http://127.0.0.1:8088/p3 -o /dev/null -w '%{http_code}\n'
systemctl is-active alert-receiver
""", timeout=300)
    print(out)

    print("=== 2. Alertmanager 路由（P1/P2/P3）===")
    (WORK / "am-config.yaml").write_text(AM_CONFIG, encoding="utf-8", newline="\n")
    fleet.scp("am-config.yaml", "/root/am-config.yaml", cp1)
    rc, out = fleet.ssh(cp1, r"""export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl -n monitoring create secret generic alertmanager-kps-kube-prometheus-stack-alertmanager \
  --from-file=alertmanager.yaml=/root/am-config.yaml --dry-run=client -o yaml | kubectl apply -f - 2>&1 | tail -1
kubectl -n monitoring rollout restart statefulset alertmanager-kps-kube-prometheus-stack-alertmanager >/dev/null 2>&1
sleep 45
kubectl -n monitoring get pods -l alertmanager=kps-kube-prometheus-stack-alertmanager --no-headers | awk '{print $1,$2,$3}'
""", timeout=600)
    print(out)

    print("=== 3. 造三条不同严重级告警 ===")
    rule = """apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata: {name: drill-alerts, namespace: monitoring, labels: {release: kps}}
spec:
  groups:
    - name: drill
      interval: 15s
      rules:
        - alert: DrillCritical
          expr: vector(1)
          for: 10s
          labels: {severity: critical, namespace: monitoring}
          annotations: {summary: "演练-P1"}
        - alert: DrillWarning
          expr: vector(1)
          for: 10s
          labels: {severity: warning, namespace: monitoring}
          annotations: {summary: "演练-P2"}
        - alert: DrillInfo
          expr: vector(1)
          for: 10s
          labels: {severity: info, namespace: monitoring}
          annotations: {summary: "演练-P3"}
"""
    (WORK / "s19-rule.yaml").write_text(rule, encoding="utf-8", newline="\n")
    fleet.scp("s19-rule.yaml", "/root/s19-rule.yaml", cp1)
    rc, out = fleet.ssh(cp1, r"""export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl apply -f /root/s19-rule.yaml 2>&1 | tail -1
sleep 90
""", timeout=600)
    print(out)

    rc, out = fleet.ssh(infra, "for l in p1 p2 p3; do echo -n \"$l: \"; grep -c Drill $l.log 2>/dev/null || echo 0; done; echo '--- p1 首条 ---'; tail -1 p1.log 2>/dev/null | head -c 200", timeout=180)
    print(out)

    print("=== 4. 配额与限额 ===")
    (WORK / "s19-quota.yaml").write_text(QUOTA, encoding="utf-8", newline="\n")
    fleet.scp("s19-quota.yaml", "/root/s19-quota.yaml", cp1)
    rc, out = fleet.ssh(cp1, r"""export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl apply -f /root/s19-quota.yaml 2>&1 | tail -2
kubectl -n demo-app describe quota demo-app-quota 2>&1 | tail -8
""", timeout=300)
    print(out)

    print("=== 5. 周恢复抽验脚本 ===")
    (WORK / "ops-weekly-restore.sh").write_text(RESTORE_CHECK, encoding="utf-8", newline="\n")
    fleet.scp("ops-weekly-restore.sh", "/root/ops/weekly-restore.sh", cp1)
    rc, out = fleet.ssh(cp1, "chmod +x /root/ops/weekly-restore.sh; /root/ops/weekly-restore.sh", timeout=900)
    print(out)


if __name__ == "__main__":
    main()
