#!/usr/bin/env bash
# ============================================================================
# 20-topology.sh —— 双平面 uSID 拓扑（a=headend / b=tailend / c=fabric）
#
# 三个角色各自要做什么，一句话说清：
#   a：把业务包塞进外层 IPv6，外层 DA 里直接编码完整路径（无 SRH）
#   c：收到包后，把 DA 最左边那个 uSID 弹掉、整体左移 16 bit，再按新 DA 转发
#   b：收到 DA=block+uDT 的包，解封装，把内层包交付给本机协议栈
#
# 关键点：全程没有 SRH。路径信息全在 128 bit 的 DA 里，共 6 个 16 bit 槽位。
#         这就是 uSID 能在"会剥扩展头"的云 vSwitch 上活下来的原因。
#
# 用法：sudo ./bin/20-topology.sh up|down|status
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

IFACE="${IFACE:-eth0}"
BLOCK_CIDR="${USID_BLOCK}::/32"
LOC_TRANSIT="${USID_BLOCK}:${U_TRANSIT}::/48"
LOC_TAIL="${USID_BLOCK}:${U_TAIL}::/64"
DA_PLANE0="${USID_BLOCK}:${U_TRANSIT}:${U_TAIL}::"
DA_PLANE1="${USID_BLOCK}:${U_TAIL}::"
SVC="$SERVICE_ADDR"

say()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }
run()  { printf '   $ %s\n' "$*"; "$@" || printf '     (命令返回非零，继续)\n'; }

require_addrs() {
  local missing=0
  for v in NODE_A_IPV6 NODE_B_IPV6 NODE_C_IPV6; do
    if [ -z "${!v}" ]; then printf '   [fail] conf/lab.env 里 %s 没填\n' "$v"; missing=1; fi
  done
  [ "$missing" -eq 0 ] || { echo "先补全地址再跑"; exit 1; }
}

# ============================================================================
setup_a() {
  say "node-a：headend（业务流从这里出发）"
  sysctl -qw net.ipv6.conf.all.seg6_enabled=1
  sysctl -qw net.ipv6.conf.${IFACE}.seg6_enabled=1

  say "1) 外层 FIB：ULA 目的段怎么走到 c / b（同子网 via，靠 L2 直达）"
  run ip -6 route replace "fcbb:bb00:${U_TRANSIT}::/48" via "$NODE_C_IPV6" dev "$IFACE"
  run ip -6 route replace "fcbb:bb00:${U_TAIL}::/48"    via "$NODE_B_IPV6" dev "$IFACE"

  say "2) 两条封装路由，分表存放（同一目的，两条不同路径）"
  run ip -6 route replace "$SVC/128" encap seg6 mode encap.red segs "$DA_PLANE0" \
        dev "$IFACE" table "$PLANE0_TABLE"
  run ip -6 route replace "$SVC/128" encap seg6 mode encap.red segs "$DA_PLANE1" \
        dev "$IFACE" table "$PLANE1_TABLE"

  say "2b) 主表给一条默认路径（平面 1）：不带 mark 的流量走这里"
  say "    这样 ping / iperf3 这类不认 mark 的工具也能直接测"
  run ip -6 route replace "$SVC/128" encap seg6 mode encap.red segs "$DA_PLANE1" dev "$IFACE"

  say "3) 策略路由：靠 socket 上的 fwmark 选平面（这就是 EV 表的实现方式）"
  ip -6 rule del fwmark "$PLANE0_MARK" table "$PLANE0_TABLE" 2>/dev/null
  ip -6 rule del fwmark "$PLANE1_MARK" table "$PLANE1_TABLE" 2>/dev/null
  run ip -6 rule add fwmark "$PLANE0_MARK" table "$PLANE0_TABLE" priority 200
  run ip -6 rule add fwmark "$PLANE1_MARK" table "$PLANE1_TABLE" priority 201

  say "4) 校验：同一条流，换一个 mark 就该换一条路"
  printf '   mark %s -> ' "$PLANE0_MARK"; ip -6 route get "$SVC" mark "$PLANE0_MARK" 2>/dev/null | head -1
  printf '   mark %s -> ' "$PLANE1_MARK"; ip -6 route get "$SVC" mark "$PLANE1_MARK" 2>/dev/null | head -1
}

setup_c() {
  say "node-c：fabric（唯一一个做 uSID 弹栈的节点）"
  sysctl -qw net.ipv6.conf.all.forwarding=1
  sysctl -qw net.ipv6.conf.all.seg6_enabled=1
  sysctl -qw net.ipv6.conf.${IFACE}.seg6_enabled=1

  say "1) 本节点 SID：${LOC_TRANSIT} 装 End + next-csid（RFC 9800 的 uN）"
  say "   lblen 32 = block 长度，nflen 16 = 每个 uSID 长度，与 RFC 9800 默认一致"
  run ip -6 route replace "$LOC_TRANSIT" encap seg6local action End \
        flavors next-csid lblen 32 nflen 16 dev "$IFACE"

  say "2) 弹完自己的 uSID 后，剩下的 DA 指向 b，按普通路由送出去"
  run ip -6 route replace "fcbb:bb00:${U_TAIL}::/48" via "$NODE_B_IPV6" dev "$IFACE"

  say "3) 校验：SID 是否真装上了（装不上=内核不支持 flavors）"
  if ip -6 route show "$LOC_TRANSIT" | grep -q seg6local; then
    printf '   [ ok ] %s\n' "$(ip -6 route show "$LOC_TRANSIT" | head -1)"
  else
    printf '   [fail] SID 没装上。检查内核 >=6.1、iproute2 支持 flavors\n'
  fi
}

setup_b() {
  say "node-b：tailend（解封装并交付给本机协议栈）"
  sysctl -qw net.ipv6.conf.all.seg6_enabled=1
  sysctl -qw net.ipv6.conf.${IFACE}.seg6_enabled=1

  say "1) 服务地址：放在 dummy 口上，业务程序绑这个地址"
  if ! ip link show svc0 >/dev/null 2>&1; then
    run ip link add svc0 type dummy
    run ip link set svc0 up
  fi
  run ip -6 addr replace "$SVC/128" dev svc0

  say "2) 终止 SID：${LOC_TAIL} 装 End.DT6"
  say "   table 255(local) 的意思是：解完封装，直接把内层包按本地地址投递"
  run ip -6 route replace "$LOC_TAIL" encap seg6local action End.DT6 table 255 dev "$IFACE"

  if ip -6 route show "$LOC_TAIL" | grep -q seg6local; then
    printf '   [ ok ] 终止 SID 就位\n'
  else
    printf '   [fail] End.DT6 装不上。改用 VRF 模式（见 docs/01 第 8 节）\n'
  fi

  say "3) 说明：b 的回包直接走普通 IPv6。内层源地址是 a 的真实地址，"
  say "   同子网直连即可送达，不需要额外配反向 SID（路径非对称是正常的）"
}

setup() {
  echo "============================================================"
  echo " 建立拓扑  角色=${ROLE}"
  echo "============================================================"
  require_addrs
  case "$ROLE" in
    a) setup_a ;;
    b) setup_b ;;
    c) setup_c ;;
    *) echo "ROLE 非法"; exit 1 ;;
  esac
  echo
  echo "下一步：三台都执行完后，在 a 上跑 ./bin/50-verify.sh"
}

down() {
  echo "拆除拓扑（角色=${ROLE}）"
  case "$ROLE" in
    a)
      ip -6 rule del fwmark "$PLANE0_MARK" table "$PLANE0_TABLE" 2>/dev/null
      ip -6 rule del fwmark "$PLANE1_MARK" table "$PLANE1_TABLE" 2>/dev/null
      ip -6 route flush table "$PLANE0_TABLE" 2>/dev/null
      ip -6 route flush table "$PLANE1_TABLE" 2>/dev/null
      ip -6 route del "fcbb:bb00:${U_TRANSIT}::/48" 2>/dev/null
      ip -6 route del "fcbb:bb00:${U_TAIL}::/48" 2>/dev/null
      ;;
    b)
      ip -6 route del "$LOC_TAIL" 2>/dev/null
      ip -6 addr del "$SVC/128" dev svc0 2>/dev/null
      ip link del svc0 2>/dev/null
      ;;
    c)
      ip -6 route del "$LOC_TRANSIT" 2>/dev/null
      ip -6 route del "fcbb:bb00:${U_TAIL}::/48" 2>/dev/null
      sysctl -qw net.ipv6.conf.all.forwarding=0
      ;;
  esac
  echo "已拆除"
}

status() {
  echo "=========== 角色 ${ROLE} 当前状态 ==========="
  echo "-- 本机 IPv6 地址"
  ip -6 addr show dev "$IFACE" scope global | sed 's/^/   /'
  echo "-- 主表里与实验相关的路由"
  ip -6 route show | grep -E "fcbb|${SVC}" | sed 's/^/   /'
  echo "-- 策略路由规则"
  ip -6 rule show | sed 's/^/   /'
  for t in "$PLANE0_TABLE" "$PLANE1_TABLE"; do
    if ip -6 route show table "$t" 2>/dev/null | grep -q .; then
      echo "-- 表 ${t}"
      ip -6 route show table "$t" | sed 's/^/   /'
    fi
  done
  echo "-- 转发开关"
  sysctl -n net.ipv6.conf.all.forwarding | sed 's/^/   forwarding = /'
}

case "${1:-}" in
  up)     setup ;;
  down)   down ;;
  status) status ;;
  *) echo "用法：$0 up|down|status"; exit 1 ;;
esac
