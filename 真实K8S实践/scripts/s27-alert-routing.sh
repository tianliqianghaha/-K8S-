#!/usr/bin/env bash
# 第 8 章 · Alertmanager 三级路由（P1 立即叫 / P2 工作时段 / P3 周报）
# 落点：集群外 alert-receiver（infra-01:8088/p1|p2|p3）
# 做法：把配置放进独立 Secret，用 spec.configSecret 引用（比直接改 spec.config 稳）
set -euo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf

AM="kps-kube-prometheus-stack-alertmanager"
NS="monitoring"
SECRET="alertmanager-custom-config"
RECEIVER="http://172.23.163.106:8088"

echo "=== 1. 备份 CR ==="
kubectl -n "${NS}" get alertmanager "${AM}" -o yaml > "/root/alertmanager-cr.backup-$(date +%s).yaml"

echo "=== 2. 写配置 ==="
cat > /tmp/alertmanager.yaml <<AMCFG
global:
  resolve_timeout: 5m
route:
  receiver: p3-info
  group_by: ['alertname', 'namespace', 'target_name']
  group_wait: 10s
  group_interval: 30s
  repeat_interval: 4h
  routes:
    - matchers:
        - alertname = "Watchdog"
      receiver: "null"
      repeat_interval: 24h
    - matchers:
        - severity = "critical"
      receiver: p1-critical
      group_wait: 5s
      group_interval: 30s
      repeat_interval: 1h
    - matchers:
        - severity = "warning"
      receiver: p2-warning
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
    - matchers:
        - severity = "info"
      receiver: p3-info
      group_wait: 2m
      group_interval: 30m
      repeat_interval: 24h
inhibit_rules:
  - source_matchers:
      - severity = "critical"
    target_matchers:
      - severity =~ "warning|info"
    equal: ['target_name', 'namespace']
receivers:
  - name: "null"
  - name: p1-critical
    webhook_configs:
      - url: ${RECEIVER}/p1
        send_resolved: true
  - name: p2-warning
    webhook_configs:
      - url: ${RECEIVER}/p2
        send_resolved: true
  - name: p3-info
    webhook_configs:
      - url: ${RECEIVER}/p3
        send_resolved: true
AMCFG

echo "=== 3. 建 Secret 并引用 ==="
kubectl -n "${NS}" create secret generic "${SECRET}" \
  --from-file=alertmanager.yaml=/tmp/alertmanager.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${NS}" patch alertmanager "${AM}" --type merge \
  -p "{\"spec\":{\"configSecret\":\"${SECRET}\"}}" >/dev/null

echo "=== 4. 等 reconcile 并确认 pod 内配置 ==="
for i in $(seq 1 40); do
  sleep 5
  N=$(kubectl -n "${NS}" exec "alertmanager-${AM}-0" -c alertmanager -- \
        cat /etc/alertmanager/config/alertmanager.yaml 2>/dev/null | grep -c "172.23.163.106:8088" || true)
  if [ "${N:-0}" -ge 2 ]; then echo "[ok] pod 内配置已加载（$((i*5))s）"; break; fi
done

echo "=== 5. 校验 ==="
kubectl -n "${NS}" exec "alertmanager-${AM}-0" -c alertmanager -- \
  cat /etc/alertmanager/config/alertmanager.yaml 2>/dev/null | grep -E "url:|name: p[0-9]" | head -8
