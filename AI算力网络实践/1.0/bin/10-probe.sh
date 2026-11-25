#!/usr/bin/env bash
# ============================================================================
# 10-probe.sh —— 云网络通透性探路（整个实验台的生死判据）
#
# 为什么必须先跑这个：
#   公有云的 vSwitch 不是哑交换机，它可能
#     (1) 只按 MAC 转发，不管你外层 IPv6 目的地址是不是 VPC 网段  -> ULA 可用
#     (2) 解析并剥离 SRH 扩展头（很多 vSwitch 不支持 SRH 就丢掉）  -> 标准 SRv6 挂
#     (3) 丢弃不认识的逐跳扩展头（IOAM）                          -> 遥测挂
#     (4) 不给你发 ICMPv6 Packet Too Big                          -> 大包黑洞
#   这四件事在文档里查不到，只能实测。测完才知道后面该走哪条路。
#
# 用法：sudo ./bin/10-probe.sh           全量探测
#       sudo ./bin/10-probe.sh clean     清理探针残留
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

IFACE="${IFACE:-eth0}"
PKG="${LAB_DIR}/probe"; mkdir -p "$PKG"

case "$ROLE" in
  a) PEER_TRANSIT="$NODE_C_IPV6"; PEER_TAIL="$NODE_B_IPV6" ;;
  b) PEER_TRANSIT="$NODE_C_IPV6"; PEER_TAIL="$NODE_A_IPV6" ;;
  c) PEER_TRANSIT="$NODE_A_IPV6"; PEER_TAIL="$NODE_B_IPV6" ;;
  *) echo "ROLE 非法"; exit 1 ;;
esac

# 探针地址
P_C="fcbb:bb00:ffff:1::1"      # 挂在 c 的 lo
P_B1="fcbb:bb00:ffff:2::1"     # 挂在 b 的 lo，当外层 DA
P_B2="fcbb:bb00:ffff:2::2"     # 挂在 b 的 lo，当内层目的
P_B3="fcbb:bb00:ffff:2::3"     # 挂在 b 的 lo，当 SRH 探针的内层目的
P_IOAM="fcbb:bb00:ffff:3::1"   # 挂在 b 的 lo，只用于 IOAM 探针

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   [ ok ] %s\n' "$*"; }
no()   { printf '   [  X  ] %s\n' "$*"; }

need_tcpdump() { command -v tcpdump >/dev/null 2>&1; }

# 抓包：在后台抓 N 秒到 pcap，结束后打印命中数
CAP_PID=""; CAP_FILE=""
cap_start() {
  local file="$1"; shift
  need_tcpdump || return 1
  CAP_FILE="$file"; rm -f "$CAP_FILE"
  tcpdump -i "$IFACE" -nn -s 256 -w "$CAP_FILE" "$@" >/dev/null 2>&1 &
  CAP_PID=$!
  sleep 1
}
cap_stop() {
  [ -n "$CAP_PID" ] || return 0
  kill "$CAP_PID" 2>/dev/null; wait "$CAP_PID" 2>/dev/null; CAP_PID=""
}
# pcap 里某个模式出现了几次（grep -c 无匹配时返回 1，必须吞掉，否则变量变成 "0\n0"）
cap_count() {
  local n=0
  [ -r "$CAP_FILE" ] && n="$(tcpdump -r "$CAP_FILE" -nn 2>/dev/null | grep -c "$1" || true)"
  echo "${n:-0}"
}

clean_probe() {
  info "清理探针残留"
  cap_stop
  if [ "$ROLE" = "c" ]; then
    ip -6 addr del "$P_C/128" dev lo 2>/dev/null
  fi
  if [ "$ROLE" = "b" ]; then
    for a in "$P_B1" "$P_B2" "$P_B3" "$P_IOAM"; do ip -6 addr del "$a/128" dev lo 2>/dev/null; done
  fi
  if [ "$ROLE" = "a" ]; then
    for a in "$P_C" "$P_B1" "$P_B2" "$P_B3" "$P_IOAM"; do
      ip -6 route del "$a/128" 2>/dev/null
    done
    ip -6 route del "fcbb:bb00:ffff::/48" 2>/dev/null
  fi
  ok "已清理"
}

[ "${1:-}" = "clean" ] && { clean_probe; exit 0; }

# ============================================================ 探针侧准备
log "0. 探针地址与路由"
if [ "$ROLE" = "c" ]; then
  ip -6 addr replace "$P_C/128" dev lo
  ok "c 的 lo 上挂 ${P_C}"
fi

if [ "$ROLE" = "b" ]; then
  ip -6 addr replace "$P_B1/128" dev lo
  ip -6 addr replace "$P_B2/128" dev lo
  ip -6 addr replace "$P_B3/128" dev lo
  ip -6 addr replace "$P_IOAM/128" dev lo
  ok "b 的 lo 上挂 4 个探针地址"
fi

if [ "$ROLE" = "a" ]; then
  # 外层目的地址是 ULA，必须靠"同子网 via"把包 L2 送到对端 MAC
  ip -6 route replace "${P_C}/128" via "$PEER_TRANSIT" dev "$IFACE"
  ip -6 route replace "fcbb:bb00:ffff:2::/64"  via "$PEER_TAIL"    dev "$IFACE"
  ip -6 route replace "${P_IOAM}/128" via "$PEER_TAIL"    dev "$IFACE"
  ok "a 上把 ULA 探针段指向 c / b（同子网 via）"
fi

# ============================================================ P1
log "P1. 外层 ULA 目的地址能否穿过 vSwitch"
info "原理：vSwitch 按 MAC 转发，不看 IPv6 目的地址。若 P1 通，"
info "      说明我们可以在外层 DA 里随便编码 uSID，不必是云分配的公网段。"
if [ "$ROLE" = "c" ]; then
  cap_start "$PKG/p1.pcap" "ip6 and dst $P_C"
  sleep 6
  cap_stop
  n="$(cap_count "$P_C")"
  if [ "${n:-0}" -gt 0 ]; then
    ok "c 收到 ${n} 个 DA=${P_C} 的包 → 外层 ULA 可达，uSID 方案成立"
  else
    no "c 没收到任何 ULA 包。按顺序查："
    info "  1) ENI 的源/目的检查是否开着（SourceDestCheck=true 会丢自定义目的地址）"
    info "  2) VPC 路由表里有没有给该 ULA 前缀指下一跳（NextHopType=Instance）"
    info "  3) 两件都做了还不通，才考虑退到 UDP 封装"
  fi
elif [ "$ROLE" = "a" ]; then
  out="$(ping -6 -c 3 -W 2 "$P_C" 2>&1)"; rc=$?
  info "$(echo "$out" | tail -2 | tr '\n' ' ')"
  if [ $rc -eq 0 ]; then
    ok "a → c 的 ULA 探针有回包（正向 + 反向都通，最理想）"
  else
    info "无回包。注意：可能只是反向路径被源地址校验拦了，"
    info "务必看 c 端的 P1 抓包结果再下结论。"
  fi
else
  info "本机是 b，本项跳过（由 a/c 两台配合完成）"
fi

# ============================================================ P2
log "P2. SRH 扩展头是否被中间设备剥离（决定走标准 SRv6 还是 uSID）"
info "原理：单段 SID 用 encap.red 不产生 SRH；多段 SID 必然产生 SRH。"
info "      同样到达 b，前者有包后者也有包，但后者若丢 SRH，就说明被剥了。"
if [ "$ROLE" = "a" ]; then
  # 内层目的地址必须不同于外层 DA，否则封装后的外层查询会再撞到自己，形成自封装环
  # case1：内层 P_B2，外层 DA=P_B1，单段 → encap.red 不产生 SRH
  ip -6 route replace "$P_B2/128" encap seg6 mode encap.red segs "$P_B1" dev "$IFACE"
  # case2：内层 P_B3，外层两段 → 必然产生 SRH
  ip -6 route replace "$P_B3/128" encap seg6 mode encap     segs "$P_B1,$P_B2" dev "$IFACE"
  ping -6 -c 1 -W 1 "$P_B2" >/dev/null 2>&1
  ping -6 -c 1 -W 1 "$P_B3" >/dev/null 2>&1
  ok "已分别发出「无 SRH」与「有 SRH」两组包"
  info "注意：这一步 ping 不通是正常的 —— b 上没有对应的解封装，"
  info "      我们要看的只是 b 抓到的包里有没有 Routing Header。"
elif [ "$ROLE" = "b" ]; then
  cap_start "$PKG/p2.pcap" "ip6 and dst fcbb:bb00:ffff:2::/64"
  sleep 8
  cap_stop
  total="$(cap_count 'IP6')"
  srh="$(cap_count 'Routing Header')"
  info "抓到 ${total} 个包，其中带 Routing Header 的 ${srh} 个"
  if [ "${srh:-0}" -gt 0 ]; then
    ok "SRH 原样到达 → 标准 SRv6 也能用（但没必要，uSID 更省）"
  elif [ "${total:-0}" -gt 0 ]; then
    no "包到了但 SRH 没了 → vSwitch 剥扩展头。必须走 uSID（路径全在 DA 里）"
  else
    info "一个包都没抓到，先确认 P1 是否通"
  fi
fi

# ============================================================ P3
log "P3. 封装后的真实 MTU 上限（黑产：大包黑洞）"
if [ "$ROLE" = "a" ]; then
  mtu="$(cat /sys/class/net/$IFACE/mtu)"
  info "网卡 MTU=${mtu}"
  info "裸 IPv6 的理论最大 ping 载荷 = MTU - 40(IPv6) - 8(ICMPv6) = $((mtu-48)) B"
  info "再封一层 uSID 后还要减 40 B，也就是 $((mtu-88)) B"
  for sz in $((mtu-48)) $((mtu-88)) $((mtu-60)); do
    if ping -6 -c 1 -W 2 -M do -s "$sz" "$PEER_TAIL" >/dev/null 2>&1; then
      printf '   载荷 %-5s : 通过\n' "$sz"
    else
      printf '   载荷 %-5s : 失败（可能是 MTU，也可能是对端没放行 ICMPv6）\n' "$sz"
    fi
  done
  info "若大包全失败而小包通 → 典型 PMTU 黑洞，L3 会专门复现并给解法"
else
  info "本项在 a 上执行"
fi

# ============================================================ P4
log "P4. 逐跳扩展头（IOAM）能否穿过（决定 L9 遥测实验）"
if [ "$ROLE" = "a" ]; then
  if ip ioam help >/dev/null 2>&1 || ip ioam6 help >/dev/null 2>&1; then
    IOAM="ip ioam"; ip ioam help >/dev/null 2>&1 || IOAM="ip ioam6"
    $IOAM namespace add 777 data 0xdeadbeef >/dev/null 2>&1
    if ip -6 route replace "$P_IOAM/128" encap ioam6 mode inline trace prealloc \
         type 0x800000 ns 777 size 12 via "$PEER_TAIL" dev "$IFACE" 2>/dev/null; then
      ping -6 -c 2 -W 2 "$P_IOAM" >/dev/null 2>&1
      ok "已发出带 IOAM HbH 的包，去 b 上看 P4 结果"
    else
      no "ioam6 路由装不上（内核或 iproute2 不支持），L9 跳过"
    fi
  else
    no "ip ioam 子命令不存在，L9 跳过"
  fi
elif [ "$ROLE" = "b" ]; then
  cap_start "$PKG/p4.pcap" "ip6 and dst $P_IOAM"
  sleep 6
  cap_stop
  if [ "$(cap_count 'ioam')" -gt 0 ] || [ "$(cap_count 'Hop-by-Hop')" -gt 0 ]; then
    ok "IOAM/HbH 到达 b → L9 带内遥测可做"
  else
    no "没看到 IOAM/HbH：要么发送端没发（ip ioam 缺失），要么 vSwitch 丢了逐跳扩展头；L9 需实测确认"
  fi
fi

# ============================================================ 汇总
log "探路结论（把这句话抄到实验记录里）"
cat <<EOF
   本机角色：${ROLE}
   P1 外层 ULA 目的地址 ....... 见上（a/c 两台对照）
   P2 SRH 是否被剥 ............ 见上（b 端结论）
   P3 封装后可用载荷 .......... 见上
   P4 逐跳扩展头 .............. 见上
   决策：
     ├─ P1 通 + P2 SRH 被剥  -> 走 uSID（本实验台默认），完全绕开 SRH
     ├─ P1 通 + P2 SRH 保留  -> uSID 仍然更优：开销从 80B 降到 40B
     ├─ P1 不通 → 先关 SourceDestCheck，再给 ULA 前缀加 VPC 路由（NextHopType=Instance）
     └─ 两者都不行 → 外层只能用云分配地址，改用 UDP 封装做覆盖层
   清理：sudo ./bin/10-probe.sh clean
EOF
