#!/usr/bin/env bash
# ============================================================================
# 80-daily.sh —— 每日巡检（值班交接班要贴的那一份）
#
# 对应真实工作动作：接班先看一眼"有没有异常"，而不是等告警。
# 输出分五段：主机 / 接口 / 邻居与路由 / 队列 / 平面可用性
# 有任何 WARN 或 FAIL，退出码非 0，可以直接挂到 cron 或监控里。
#
# 用法：sudo ./bin/80-daily.sh [--brief]
#   --brief  只打印结论行（适合贴群里）
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

IFACE="${IFACE:-eth0}"
SVC="${SERVICE_ADDR:-fd00:b0b0::1}"
BRIEF=0
[ "${1:-}" = "--brief" ] && BRIEF=1

OK=0; WARN=0; FAIL=0
declare -a ISSUES=()

ok()   { OK=$((OK+1)); }
warn() { WARN=$((WARN+1)); ISSUES+=("WARN  $1"); }
bad()  { FAIL=$((FAIL+1)); ISSUES+=("FAIL  $1"); }
sec()  { [ "$BRIEF" -eq 1 ] || printf '\n\033[1m== %s\033[0m\n' "$*"; }
row()  { [ "$BRIEF" -eq 1 ] || printf '   %-24s %s\n' "$1" "$2"; }

TS="$(date '+%Y-%m-%d %H:%M:%S')"
[ "$BRIEF" -eq 1 ] || {
  echo "============================================================"
  echo " HPN-3 日常巡检  ${TS}  角色=${ROLE}  节点=$(hostname)"
  echo "============================================================"
}

# ---------------------------------------------------------------- 1 主机
sec "1. 主机资源"
LOAD="$(awk '{print $1}' /proc/loadavg)"
NCPU="$(nproc)"
row "load(1m)/核数" "${LOAD} / ${NCPU}"
awk -v l="$LOAD" -v n="$NCPU" 'BEGIN{exit !(l > n*0.8)}' && warn "负载偏高：${LOAD} > 0.8×${NCPU}" || ok

MEM="$(awk '/MemAvailable/{a=$2}/MemTotal/{t=$2}END{printf "%d", (t-a)*100/t}' /proc/meminfo)"
row "内存使用率" "${MEM}%"
[ "${MEM:-0}" -gt 85 ] && warn "内存使用 ${MEM}%" || ok

DISK="$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')"
row "根分区使用率" "${DISK}%"
[ "${DISK:-0}" -gt 85 ] && bad "根分区 ${DISK}%，随时写满" || ok

# ---------------------------------------------------------------- 2 接口
sec "2. 接口健康"
if ip link show "$IFACE" 2>/dev/null | grep -q "state UP"; then
  row "$IFACE 状态" "UP"; ok
else
  row "$IFACE 状态" "DOWN"; bad "$IFACE 不是 UP"
fi

RXE="$(cat "/sys/class/net/${IFACE}/statistics/rx_errors" 2>/dev/null || echo 0)"
TXE="$(cat "/sys/class/net/${IFACE}/statistics/tx_errors" 2>/dev/null || echo 0)"
RXD="$(cat "/sys/class/net/${IFACE}/statistics/rx_dropped" 2>/dev/null || echo 0)"
row "rx_errors/tx_errors" "${RXE} / ${TXE}"
[ "${RXE:-0}" -gt 0 ] && warn "rx_errors=${RXE}，可能光层或虚拟网卡异常" || ok
[ "${TXE:-0}" -gt 0 ] && warn "tx_errors=${TXE}" || ok
row "rx_dropped" "${RXD}"

MTU="$(cat "/sys/class/net/${IFACE}/mtu" 2>/dev/null || echo 0)"
row "MTU" "$MTU"
[ "${MTU:-0}" -ge 1500 ] && ok || warn "MTU=${MTU}，uSID 封装后余量不足"

# ---------------------------------------------------------------- 3 地址/邻居/路由
sec "3. 地址 · 邻居 · 路由"
V6="$(ip -6 addr show dev "$IFACE" scope global | awk '/inet6/{print $2}' | head -1)"
if [ -n "$V6" ]; then row "全局 IPv6" "$V6"; ok; else row "全局 IPv6" "无"; bad "没有全局 IPv6"; fi

TENT="$(ip -6 addr show dev "$IFACE" 2>/dev/null | grep -c tentative || true)"
[ "${TENT:-0}" -gt 0 ] && warn "有 ${TENT} 个地址处于 tentative（DAD 未完成或冲突）" || ok

NEIGH_BAD="$(ip -6 neigh show dev "$IFACE" 2>/dev/null | grep -cE "INCOMPLETE|FAILED" || true)"
row "邻居异常项" "$NEIGH_BAD"
[ "${NEIGH_BAD:-0}" -gt 0 ] && warn "邻居表有 ${NEIGH_BAD} 项 INCOMPLETE/FAILED" || ok

ROUTES="$(ip -6 route show | wc -l)"
row "IPv6 路由条数" "$ROUTES"

# 重建拓扑后马上巡检时，路由可能还在内核里同步，重试一次避免误报
_have_sid=0
for _ in 1 2 3; do
  ip -6 route show | grep -q "fcbb:bb00" && { _have_sid=1; break; }
  sleep 0.5
done
if [ "$_have_sid" = "1" ]; then
  row "uSID 前缀路由" "存在"; ok
else
  row "uSID 前缀路由" "缺失"; warn "没有 fcbb:bb00 前缀路由（拓扑可能没起，跑 ./bin/hpnlab up）"
fi

if [ "$ROLE" = "a" ]; then
  RULES="$(ip -6 rule show | grep -c fwmark || true)"
  row "策略路由规则" "$RULES 条"
  [ "${RULES:-0}" -ge 2 ] && ok || warn "策略路由规则只有 ${RULES} 条，双平面选路可能不完整"
fi

# ---------------------------------------------------------------- 4 队列
sec "4. 队列与限速"
QD="$(tc qdisc show dev "$IFACE" | head -1)"
row "根队列" "$(echo "$QD" | awk '{print $2}')"
DROPS="$(tc -s qdisc show dev "$IFACE" 2>/dev/null | awk '/dropped/{s+=$3}END{print s+0}')"
row "累计 dropped(队列)" "$DROPS"
[ "${DROPS:-0}" -gt 1000 ] && warn "队列累计丢弃 ${DROPS}，检查是否有残留注入" || ok

if tc qdisc show dev "$IFACE" | grep -qE "netem|tbf|red"; then
  warn "存在 netem/tbf/red 注入残留 —— 实验完要 fault clear"
else
  ok
fi

# ---------------------------------------------------------------- 5 业务面
sec "5. 平面可用性"
if [ "$ROLE" = "c" ]; then
  row "业务面" "fabric 节点，不承载业务地址，跳过"; ok
elif ping -6 -c 3 -W 2 "$SVC" >/dev/null 2>&1; then
  RTT="$(ping -6 -c 5 -W 2 "$SVC" 2>/dev/null | awk -F'/' '/rtt|round-trip/{print $5}')"
  row "平面 1（直达）" "通，avg ${RTT:-?} ms"; ok
else
  row "平面 1（直达）" "不通"; bad "ping ${SVC} 失败"
fi

if [ "$ROLE" = "a" ]; then
  # 平面 0 的健康度用"c 的 SID 路由是否存在 + c 是否可达"判断，避免依赖探针地址
  if ip -6 route show fcbb:bb00:2::/48 | grep -q . && ping -6 -c 2 -W 2 "$NODE_C_IPV6" >/dev/null 2>&1; then
    row "平面 0（绕行）" "通（经 c）"; ok
  else
    row "平面 0（绕行）" "不通"; warn "绕行路径不可达：c 的 SID 路由缺失或 c 不可达"
  fi
fi

# ---------------------------------------------------------------- 结论
echo
if [ "$BRIEF" -eq 0 ]; then
  echo "------------------------------------------------------------"
  printf ' 巡检结论：ok=%d  warn=%d  fail=%d\n' "$OK" "$WARN" "$FAIL"
fi
if [ "${#ISSUES[@]}" -gt 0 ]; then
  for i in "${ISSUES[@]}"; do echo "  $i"; done
else
  echo " 全部正常，可交接"
fi
[ "$BRIEF" -eq 0 ] && echo "------------------------------------------------------------"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 2)
