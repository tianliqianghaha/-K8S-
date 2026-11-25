#!/usr/bin/env bash
# ============================================================================
# 40-observe.sh —— 观测。不用 Prometheus，先把"看得见"这件事做扎实。
#
# 为什么先不上面板：HPN 排障的关键不是看板好看，而是
#   ① 同一时刻，两条路径各自的计数是多少（对比才有意义）
#   ② 时延的分布，不是平均值（尾延迟才是训练杀手）
#   ③ 丢包发生在哪一跳（后面 L9 用 IOAM 回答）
#
# 用法：
#   sudo ./bin/40-observe.sh snap             打一份快照到 /var/lib/hpnlab
#   sudo ./bin/40-observe.sh rtt [次数]       时延分布 p50/p90/p99
#   sudo ./bin/40-observe.sh watch [秒] [间隔] 逐秒采样成 CSV
#   sudo ./bin/40-observe.sh stats            协议栈计数（丢包/错误/分片）
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

IFACE="${IFACE:-eth0}"
SVC="$SERVICE_ADDR"
OUT="${LAB_DIR}/obs"; mkdir -p "$OUT"
TS="$(date +%Y%m%d-%H%M%S)"

say() { printf '\n\033[1m-- %s\033[0m\n' "$*"; }

cmd_snap() {
  local f="${OUT}/snap-${ROLE}-${TS}.txt"
  {
    echo "# HPN-3 snapshot  role=${ROLE}  time=${TS}"
    echo "## kernel"; uname -r
    echo "## link ${IFACE}"
    ip -s link show dev "$IFACE"
    echo "## qdisc"
    tc -s qdisc show dev "$IFACE"
    echo "## routes"
    ip -6 route show
    echo "## rules"
    ip -6 rule show
    echo "## snmp6"
    grep -E "^(Ip6InReceives|Ip6OutRequests|Ip6InHdrErrors|Ip6InAddrErrors|Ip6InDiscards|Ip6OutDiscards|Ip6InNoRoutes|Ip6FragFails|Ip6InTooBigErrors)" /proc/net/snmp6 2>/dev/null
  } > "$f"
  say "快照已写入 $f"
  grep -A2 "## link" "$f" | sed 's/^/   /'
}

# 取 ping 的 time= 值，算分位数
cmd_rtt() {
  local n="${1:-200}"
  echo "对 ${SVC} 发 ${n} 个包（封装路径，平面 1 默认）"
  local raw
  raw="$(ping -6 -c "$n" -i 0.02 -W 2 "$SVC" 2>/dev/null)"
  if [ -z "$raw" ]; then
    say "没有回包。先确认 20-topology.sh up 三台都跑过、b 的 svc0 起来了吗"
    return 1
  fi
  echo "$raw" | tail -3 | sed 's/^/   /'

  if command -v python3 >/dev/null 2>&1; then
    echo "$raw" | grep -o 'time=[0-9.]*' | cut -d= -f2 | python3 -c '
import sys, statistics
v=[float(x) for x in sys.stdin if x.strip()]
if not v: sys.exit(0)
v.sort()
def p(q): return v[min(len(v)-1, int(len(v)*q))]
print("   样本 %d  最小 %.3f  中位 %.3f  p90 %.3f  p99 %.3f  最大 %.3f  (ms)" %
      (len(v), v[0], statistics.median(v), p(0.90), p(0.99), v[-1]))
print("   抖动(最大-最小) %.3f ms" % (v[-1]-v[0]))
'
  fi

  say "同样次数，打裸 IPv6（不封装）作为基线"
  ping -6 -c "$n" -i 0.02 -W 2 "$NODE_B_IPV6" 2>/dev/null | tail -2 | sed 's/^/   /'
}

cmd_watch() {
  local dur="${1:-30}" int="${2:-1}"
  local f="${OUT}/watch-${ROLE}-${TS}.csv"
  echo "ts,rx_bytes,tx_bytes,rx_pkts,tx_pkts" > "$f"
  say "采样 ${dur}s，间隔 ${int}s → $f"
  local end=$(( $(date +%s) + dur ))
  while [ "$(date +%s)" -lt "$end" ]; do
    local rx tx rp tp
    rx=$(cat "/sys/class/net/$IFACE/statistics/rx_bytes")
    tx=$(cat "/sys/class/net/$IFACE/statistics/tx_bytes")
    rp=$(cat "/sys/class/net/$IFACE/statistics/rx_packets")
    tp=$(cat "/sys/class/net/$IFACE/statistics/tx_packets")
    printf '%s,%s,%s,%s,%s\n' "$(date +%H:%M:%S)" "$rx" "$tx" "$rp" "$tp" >> "$f"
    sleep "$int"
  done
  say "完成。快速算一下平均速率："
  awk -F, -v dt="$int" 'NR>2{
    drx=$2-p_rx; dtx=$3-p_tx;
    printf "   %s  rx %.1f Mbps  tx %.1f Mbps\n", $1, drx*8/dt/1e6, dtx*8/dt/1e6
  } {p_rx=$2; p_tx=$3}' "$f" | tail -10
}

cmd_stats() {
  say "IPv6 协议栈计数（只挑与排障相关的）"
  awk '
    /^Ip6InReceives|^Ip6OutRequests|^Ip6InHdrErrors|^Ip6InAddrErrors|^Ip6InDiscards|^Ip6OutDiscards|^Ip6InNoRoutes|^Ip6FragFails|^Ip6InTooBigErrors|^Ip6InTruncatedPkts|^Ip6OutNoRoutes/ {printf "   %-22s %s\n",$1,$2}
  ' /proc/net/snmp6
  say "解读"
  cat <<'EOF'
   Ip6InHdrErrors 上涨   → 封装头被中间设备改坏了（SRH/扩展头被剥的典型信号）
   Ip6InTooBigErrors 涨  → MTU/PMTU 问题，配合 L3
   Ip6InAddrErrors 上涨  → 目的地址不可达（ULA 段没配 via？）
   Ip6OutNoRoutes 上涨   → 策略路由表漏了，mark 选到了空表
EOF
}

case "${1:-snap}" in
  snap)  cmd_snap ;;
  rtt)   shift; cmd_rtt "$@" ;;
  watch) shift; cmd_watch "$@" ;;
  stats) cmd_stats ;;
  *) echo "用法：$0 snap|rtt [n]|watch [秒] [间隔]|stats"; exit 1 ;;
esac
