#!/usr/bin/env bash
# ============================================================================
# 60-qos.sh —— QoS 分级与带宽保障（对应岗位里的"训练/推理/存储三网分离 + QoS"）
#
# 真实集群里这条是硬需求：训练流、存储流、管理流跑在同一张网上，
# 没有分级就会互相踩。云上做不了 PFC，但 QoS 分类、带宽保障、丢包归属
# 这三件事完全可测。
#
# 用法：
#   sudo ./bin/60-qos.sh up          建三级 HTB（训练高 / 默认中 / 存储低）
#   sudo ./bin/60-qos.sh test        三种 DSCP 各打 15 秒，看每类走了多少、丢了多少
#   sudo ./bin/60-qos.sh show        看每类的字节/包/丢包/队列
#   sudo ./bin/60-qos.sh down        拆除
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

IFACE="${IFACE:-eth0}"
SVC="${SERVICE_ADDR:-fd00:b0b0::1}"
TX_MBIT="${TX_MBIT:-300}"

say() { printf '\n\033[1m-- %s\033[0m\n' "$*"; }

cmd_up() {
  say "建立三级 HTB：训练(DSCP46) / 默认(DSCP0) / 存储(DSCP10)"
  tc qdisc replace dev "$IFACE" root handle 1: htb default 20
  tc class replace dev "$IFACE" parent 1: classid 1:10 htb rate "${TX_MBIT}mbit" ceil "${TX_MBIT}mbit" prio 1
  tc class replace dev "$IFACE" parent 1: classid 1:20 htb rate "$((TX_MBIT*2/3))mbit" ceil "${TX_MBIT}mbit" prio 2
  tc class replace dev "$IFACE" parent 1: classid 1:30 htb rate "$((TX_MBIT/15))mbit" ceil "$((TX_MBIT/2))mbit" prio 3

  # DSCP 46 (EF) → 1:10   网络控制字节 = 46<<2 = 0xb8，掩码 0xfc
  tc filter replace dev "$IFACE" parent 1: protocol ipv6 prio 1 \
     u32 match ip6 priority 0xb8 0xfc flowid 1:10
  # DSCP 10 (AF11) → 1:30  存储/备份类
  tc filter replace dev "$IFACE" parent 1: protocol ipv6 prio 2 \
     u32 match ip6 priority 0x28 0xfc flowid 1:30
  echo "   已建立；未标记流量落默认类 1:20"
  cmd_show
}

cmd_show() {
  say "每类统计（bytes / packets / drops / 队列深度）"
  tc -s class show dev "$IFACE" | sed 's/^/   /'
}

cmd_test() {
  local app="${HERE}/../app/mrc_lite.py"
  say "无 QoS 对照：先拆掉限速，三种 DSCP 各打 10 秒"
  tc qdisc del dev "$IFACE" root 2>/dev/null
  for d in 46 0 10; do
    printf '   DSCP %-3s 发送中…\n' "$d"
    python3 "$app" send --dst "$SVC" --port 9999 --count 4000 --size 1200 \
      --plane 1 --rate 400 2>/dev/null | grep -E "应用层吞吐" | sed 's/^/     /'
  done
  cmd_up >/dev/null 2>&1
  say "有 QoS：同样的三种 DSCP，各 10 秒"
  for d in 46 0 10; do
    printf '   DSCP %-3s 发送中…\n' "$d"
    python3 "$app" send --dst "$SVC" --port 9999 --count 4000 --size 1200 \
      --plane 1 --rate 400 --dscp "$d" 2>/dev/null | grep -E "应用层吞吐" | sed 's/^/     /'
  done
  cmd_show
  say "怎么看结果"
  cat <<'EOF'
   1:10（训练/DSCP46） 应保持满速
   1:20（默认/DSCP0）  被压到 2/3
   1:30（存储/DSCP10） 被压到 1/15，且 ceil 只到一半
   → 关键不是"谁快谁慢"，而是"低优先级被压时，高优先级的 p99 不受影响"
   → 用 ./bin/hpnlab rtt 200 对比开/关 QoS 时的 p99，这一条才是能写进结论的
EOF
}

cmd_down() {
  tc qdisc del dev "$IFACE" root 2>/dev/null && echo "已拆除" || echo "本来就没有"
}

case "${1:-show}" in
  up)   cmd_up ;;
  show) cmd_show ;;
  test) cmd_test ;;
  down) cmd_down ;;
  *) echo "用法：$0 up|test|show|down"; exit 1 ;;
esac
