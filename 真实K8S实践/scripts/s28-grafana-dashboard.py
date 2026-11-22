#!/usr/bin/env python3
"""第 8 章 · 生成 SLO / 探针 / 证书看板并作为 ConfigMap 下发

Grafana 侧靠 label grafana_dashboard=1 自动加载（kube-prometheus-stack 的 sidecar）。
"""
import json
import pathlib
import subprocess

DS = {"type": "prometheus", "uid": "prometheus"}


def target(expr, legend="", instant=False, ref="A"):
    return {
        "datasource": DS,
        "expr": expr,
        "legendFormat": legend,
        "refId": ref,
        "instant": instant,
        "range": not instant,
    }


def ts_panel(title, targets, unit, x, y, w=12, h=8, thresholds=None):
    return {
        "type": "timeseries",
        "title": title,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "custom": {"lineWidth": 2, "fillOpacity": 8},
                **({"thresholds": thresholds} if thresholds else {}),
            },
            "overrides": [],
        },
        "options": {
            "legend": {"displayMode": "list", "placement": "bottom"},
            "tooltip": {"mode": "multi"},
        },
    }


def stat_panel(title, targets, unit, x, y, w=6, h=6, thresholds=None):
    return {
        "type": "stat",
        "title": title,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": 3,
                **({"thresholds": thresholds} if thresholds else {}),
            },
            "overrides": [],
        },
        "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "value"},
    }


def table_panel(title, targets, x, y, w=12, h=9):
    return {
        "type": "table",
        "title": title,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "transformations": [
            {"id": "organize", "options": {
                "excludeByName": {"Time": True, "__name__": True, "job": False},
                "renameByName": {"job": "探针", "instance": "目标", "Value": "结果(1=通)"},
            }}
        ],
        "fieldConfig": {"defaults": {"custom": {"align": "left"}}, "overrides": []},
    }


SLO_TH = {"mode": "absolute", "steps": [
    {"color": "red", "value": None},
    {"color": "orange", "value": 99.0},
    {"color": "green", "value": 99.9},
]}
CERT_TH = {"mode": "absolute", "steps": [
    {"color": "red", "value": None},
    {"color": "orange", "value": 7},
    {"color": "green", "value": 21},
]}

dashboard = {
    "uid": "k8s-prod-blackbox-slo",
    "title": "生产闭环 · 入口可用性与证书",
    "tags": ["k8s-prod", "slo", "blackbox"],
    "timezone": "browser",
    "schemaVersion": 39,
    "refresh": "30s",
    "time": {"from": "now-6h", "to": "now"},
    "templating": {"list": []},
    "panels": [
        stat_panel("入口可用性（1h）", [target('slo:gateway_availability:ratio_rate1h * 100', "1h", instant=True)],
                   "percent", 0, 0, 6, 6, SLO_TH),
        stat_panel("入口可用性（6h）", [target('slo:gateway_availability:ratio_rate6h * 100', "6h", instant=True)],
                   "percent", 6, 0, 6, 6, SLO_TH),
        stat_panel("30 天错误预算剩余", [target(
            '(1 - (1 - avg_over_time(slo:gateway_availability:ratio_rate1h[30d]))) / 0.001 * 100',
            "预算", instant=True)], "percent", 12, 0, 6, 6, SLO_TH),
        stat_panel("当前严重告警数", [target('count(ALERTS{alertstate="firing",severity="critical"})', "P1", instant=True)],
                   "short", 18, 0, 6, 6),
        table_panel("各探针当前结果", [target("probe_success", "", instant=True)], 0, 6, 12, 9),
        ts_panel("证书剩余天数", [target('(probe_ssl_earliest_cert_expiry - time()) / 86400', "{{target_name}}")],
                 "none", 12, 6, 12, 9, CERT_TH),
        ts_panel("探测耗时（秒）", [target("probe_duration_seconds", "{{job}}")], "s", 0, 15, 12, 8),
        ts_panel("入口请求速率/失败", [
            target('sum(rate(probe_success{job="gateway-https"}[5m]))', "成功率"),
            target('sum(rate(probe_success{job="gateway-https"}[5m] == 0))', "失败率"),
        ], "short", 12, 15, 12, 8),
    ],
}

cm = {
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
        "name": "grafana-dashboard-blackbox-slo",
        "namespace": "monitoring",
        "labels": {"grafana_dashboard": "1"},
    },
    "data": {"k8s-prod-blackbox-slo.json": json.dumps(dashboard, ensure_ascii=False)},
}

out = pathlib.Path("/tmp/dash-cm.json")
out.write_text(json.dumps(cm, ensure_ascii=False), encoding="utf-8")
pathlib.Path("/tmp/dash.json").write_text(json.dumps(dashboard, ensure_ascii=False, indent=2), encoding="utf-8")
print("dashboard panels:", len(dashboard["panels"]), "| cm bytes:", out.stat().st_size)
