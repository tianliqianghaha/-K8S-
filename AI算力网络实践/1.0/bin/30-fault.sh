#!/usr/bin/env bash
# ============================================================================
# 30-fault.sh —— 故障注入与实验开关
#
# 设计原则（这是从真实运维事故里学来的）：
#   云主机只有一块网卡，tc 挂在 eth0 上是全局生效的 —— 包括你自己的 SSH。
#   所以这里全部用 prio + u32 过滤器，只把"目的地址是 uSID 段"的包挑出来打伤，
#   管理流量走默认 band，SSH 不受影响。
#
# 用法：
#   sudo ./bin/30-fault.sh list
#   sudo ./bin/30-fault.sh inject loss 100        # 平面 0 全丢（模拟链路失效）
#   sudo ./bin/30-fault.sh inject jitter 20 5     # 20ms ± 5ms（光模块抖动）
#   sudo ./bin/30-fault.sh inject policer 50mbit  # 带宽被压到 50M（云带宽超额）
#   sudo ./bin/30-fault.sh inject pmtu-block      # 丢掉 ICMPv6 PTB（黑洞）
#   sudo ./bin/30-fault.sh inject blackhole       # 路由层黑洞（控制面撤路）
#   sudo ./bin/30-fault.sh hash 0|1|3             # ECMP 哈希策略
#   sudo ./bin/30-fault.sh ecn on|off             # ECN 标记 + DCTCP
#   sudo ./bin/30-fault.sh clear                  # 全部还原
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

IFACE="${IFACE:-eth0}"
SID_PREFIX="${USID_BLOCK}:${U_TRANSIT}::/48"   # 只打平面 0 的流量
QFILTER_PARENT="1:"

say()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

need_root() { [ "$(id -u)" -eq 0 ] || { echo "需要 root"; exit 1; }; }

# 统一挂载：prio 三分带，band3 挂伤害，过滤器只挑 uSID 目的地址
ensure_qdisc() {
  if tc qdisc show dev "$IFACE" | grep -q "qdisc prio 1:"; then
    return 0
  fi
  note "挂 prio 三分带（band1 默认=管理流量，band3=实验流量）"
  tc qdisc replace dev "$IFACE" root handle 1: prio bands 3
  tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: pfifo_fast
  tc filter replace dev "$IFACE" parent "$QFILTER_PARENT" protocol ipv6 prio 1 \
     u32 match ip6 dst "$SID_PREFIX" flowid 1:3
}

ensure_qdisc_route() {   # 针对 a 上"两条平面"的区分：按 fwmark 不方便，用目的地址更直观
  ensure_qdisc
}

# 按 UDP 目的端口打伤：这是唯一能"只打某一条平面"的办法。
# 偏移说明：IPv6 头 40B，UDP 源端口在 40，目的端口在 42（无扩展头时）。
ensure_qdisc_port() {
  local port="$1"
  if ! tc qdisc show dev "$IFACE" | grep -q "qdisc prio 1:"; then
    note "挂 prio 三分带（band1 默认=管理流量，band3=实验流量）"
    tc qdisc del dev "$IFACE" root 2>/dev/null
    tc qdisc add dev "$IFACE" root handle 1: prio bands 3
  fi
  # 子队列可能残留上一次的 netem/tbf。prio 会自动给每个 band 挂一个隐式子队列，
  # 此时 replace 会因为"名字不匹配"报 Invalid qdisc name，必须先删再 add。
  tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null
  tc filter replace dev "$IFACE" parent "$QFILTER_PARENT" protocol ipv6 prio 2      u32 match u16 "$port" 0xffff at 42 flowid 1:3
}

cmd_list() {
  say "可注入的故障"
  cat <<'EOF'
   loss <pct>        平面 0 丢包百分比（按 uSID 目的地址匹配）
   lossport <pct> <port>  按 UDP 目的端口丢包，用于只打伤某一条平面
   jitterport <ms> <j> <port>  按 UDP 目的端口加时延抖动
   jitter <ms> <j>   平面 0 时延 <ms> 毫秒、抖动 ±<j> 毫秒
   policer <rate>    平面 0 限速（如 50mbit），模拟云带宽超额/突发额度耗尽
   pmtu-block        本机丢弃 ICMPv6 Packet Too Big（复现 PMTU 黑洞）
   blackhole         路由层把平面 0 指向黑洞（等价于控制面撤路）
   silent            平面 0 静默故障：接口 up、路由在、包全丢
   hash <0|1|3>      ECMP 哈希策略（0=纯三层，1=五元组，3=自定义含 FL）
   ecn <on|off>      ECN 标记 + DCTCP 拥塞控制
   clear             清掉本机所有注入，恢复干净状态
EOF
  say "当前状态"
  tc qdisc show dev "$IFACE" | sed 's/^/   /'
  tc filter show dev "$IFACE" parent "$QFILTER_PARENT" 2>/dev/null | sed 's/^/   /'
}

cmd_inject() {
  need_root
  local kind="${1:-}"; shift || true
  case "$kind" in
    loss)
      local pct="${1:-100}"
      ensure_qdisc
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: netem loss "${pct}%"
      note "平面 0 丢包 ${pct}% 已生效（管理流量不受影响）"
      ;;
    lossport)
      # 只打伤某一条平面：UDP 目的端口 = 平面编号，这是 MRC 里"每 QP 一条平面"的等价物
      local pct="${1:-10}" port="${2:-9600}"
      ensure_qdisc_port "$port"
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: netem loss "${pct}%"
      note "udp dst :$port 丢包 ${pct}% 已生效（管理流量与其他端口不受影响）"
      ;;
    jitterport)
      local ms="${1:-20}" j="${2:-5}" port="${3:-9600}"
      ensure_qdisc_port "$port"
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: netem delay "${ms}ms" "${j}ms" distribution normal
      note "udp dst :$port 时延 ${ms}ms ± ${j}ms 已生效"
      ;;
    jitter)
      local ms="${1:-20}" j="${2:-5}"
      ensure_qdisc
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: netem delay "${ms}ms" "${j}ms" distribution normal
      note "平面 0 时延 ${ms}ms ± ${j}ms 已生效"
      ;;
    policer)
      local rate="${1:-50mbit}"
      ensure_qdisc
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: tbf rate "$rate" burst 32k latency 50ms
      note "平面 0 限速 ${rate} 已生效"
      ;;
    pmtu-block)
      if command -v ip6tables >/dev/null 2>&1; then
        ip6tables -C INPUT -p icmpv6 --icmpv6-type 2 -m comment --comment hpnlab -j DROP 2>/dev/null || \
        ip6tables -I INPUT -p icmpv6 --icmpv6-type 2 -m comment --comment hpnlab -j DROP
        note "已丢弃入向 ICMPv6 PTB —— 现在大包应该会黑洞，小包仍然通"
      else
        note "没有 ip6tables，用 nft 手工加：nft add rule ip6 filter input icmpv6 type packet-too-big drop"
      fi
      ;;
    blackhole)
      ip -6 route replace "$SID_PREFIX" blackhole
      note "平面 0 在 a 的路由表里变成 blackhole —— 等价于控制面把路径撤了"
      ;;
    silent)
      ensure_qdisc
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: netem loss 100%
      note "静默故障已注入：接口 up、路由在、包全丢（最难查的那一类）"
      ;;
    *) echo "未知故障：$kind"; cmd_list ;;
  esac
}

cmd_hash() {
  need_root
  local v="${1:-0}"
  sysctl -qw "net.ipv6.fib_multipath_hash_policy=${v}"
  if [ "$v" = "3" ]; then
    sysctl -qw net.ipv6.fib_multipath_hash_fields=0x3F
    note "policy=3, fields=0x3F（src/dst/proto/FlowLabel/sport/dport 全参与）"
  else
    note "policy=${v}（0=三层含 Flow Label，1=五元组）"
  fi
}

cmd_ecn() {
  need_root
  case "${1:-on}" in
    on)
      ensure_qdisc
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: red limit 100000 min 20000 max 60000 avpkt 1000 burst 20 ecn
      sysctl -qw net.ipv4.tcp_ecn=1
      if sysctl -n net.ipv4.tcp_available_congestion_control | grep -q dctcp; then
        sysctl -qw net.ipv4.tcp_congestion_control=dctcp
        note "RED+ECN 已挂，拥塞控制切到 dctcp"
      else
        note "RED+ECN 已挂，但内核没有 dctcp 模块（modprobe tcp_dctcp 试试）"
      fi
      ;;
    off)
      ensure_qdisc
      tc qdisc del dev "$IFACE" parent 1:3 2>/dev/null; tc qdisc add dev "$IFACE" parent 1:3 handle 30: pfifo_fast
      sysctl -qw net.ipv4.tcp_congestion_control=cubic
      sysctl -qw net.ipv4.tcp_ecn=0
      note "ECN 已关闭，回到 cubic"
      ;;
  esac
}

cmd_clear() {
  need_root
  say "清理所有注入"
  tc qdisc del dev "$IFACE" root 2>/dev/null && note "tc 根队列已删" || note "没有 tc 注入"
  if command -v ip6tables >/dev/null 2>&1; then
    # 必须用"与添加时完全一致的规则串"来删，否则 -D 匹配不到
    local n=0
    while ip6tables -D INPUT -p icmpv6 --icmpv6-type 2 -m comment --comment hpnlab -j DROP 2>/dev/null; do
      n=$((n+1))
    done
    note "ip6tables 规则已清（删了 ${n} 条）"
  fi
  # 只撤自己注入的 blackhole，绝不能无条件 del —— 否则会把正常的外层路由一起删掉，
  # 表现为"故障清了，但平面 0 从此不通"，极难排查
  if ip -6 route show "$SID_PREFIX" 2>/dev/null | grep -q blackhole; then
    ip -6 route del "$SID_PREFIX" && note "blackhole 已撤"
  else
    note "没有 blackhole 需要撤（正常路由保持不动）"
  fi
  note "提示：路由与地址不会被这里删掉，用 20-topology.sh down"
}

case "${1:-list}" in
  inject) shift; cmd_inject "$@" ;;
  hash)   shift; cmd_hash "$@" ;;
  ecn)    shift; cmd_ecn "$@" ;;
  clear)  cmd_clear ;;
  list|*) cmd_list ;;
esac
