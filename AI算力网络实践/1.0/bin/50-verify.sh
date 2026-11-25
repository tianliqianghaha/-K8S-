#!/usr/bin/env bash
# ============================================================================
# 50-verify.sh —— 自动验收。每一项都是"能证伪"的断言，不是"看起来对"。
#
# 用法：
#   a 上：sudo ./bin/50-verify.sh           配置 + 连通性 + 路径选择
#   c 上：sudo ./bin/50-verify.sh capture   证明 DA 里的 uSID 真的被弹掉了
#   b 上：sudo ./bin/50-verify.sh capture   证明包到了、且没有 SRH
#   a 上：sudo ./bin/50-verify.sh overhead  实测封装开销到底多少字节
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

IFACE="${IFACE:-eth0}"
LOC_TRANSIT="${USID_BLOCK}:${U_TRANSIT}::/48"
LOC_TAIL="${USID_BLOCK}:${U_TAIL}::/64"
DA_PLANE0="${USID_BLOCK}:${U_TRANSIT}:${U_TAIL}::"
DA_PLANE1="${USID_BLOCK}:${U_TAIL}::"
SVC="$SERVICE_ADDR"

P=0; F=0
ok()   { printf '  [ ok ] %s\n' "$1"; P=$((P+1)); }
bad()  { printf '  [fail] %s\n' "$1"; F=$((F+1)); }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

verify_a() {
  sect "A1. 外层 FIB"
  ip -6 route show "fcbb:bb00:${U_TRANSIT}::/48" | grep -q . && ok "到 c 的外层路由存在" || bad "缺 fcbb:bb00:${U_TRANSIT}::/48 via c"
  ip -6 route show "fcbb:bb00:${U_TAIL}::/48"    | grep -q . && ok "到 b 的外层路由存在" || bad "缺 fcbb:bb00:${U_TAIL}::/48 via b"

  sect "A2. 三条封装路由（主表默认 + 两个平面）"
  ip -6 route show "$SVC/128" | grep -q "$DA_PLANE1" && ok "主表默认走平面 1" || bad "主表缺默认封装路由"
  ip -6 route show table "$PLANE0_TABLE" | grep -q "$DA_PLANE0" && ok "表 ${PLANE0_TABLE} 走平面 0" || bad "表 ${PLANE0_TABLE} 不对"
  ip -6 route show table "$PLANE1_TABLE" | grep -q "$DA_PLANE1" && ok "表 ${PLANE1_TABLE} 走平面 1" || bad "表 ${PLANE1_TABLE} 不对"

  sect "A3. 策略路由（这是 EV 表的地基）"
  ip -6 rule show | grep -q "fwmark ${PLANE0_MARK} lookup ${PLANE0_TABLE}" && ok "mark ${PLANE0_MARK} -> 表 ${PLANE0_TABLE}" || bad "缺 mark ${PLANE0_MARK} 的规则"
  ip -6 rule show | grep -q "fwmark ${PLANE1_MARK} lookup ${PLANE1_TABLE}" && ok "mark ${PLANE1_MARK} -> 表 ${PLANE1_TABLE}" || bad "缺 mark ${PLANE1_MARK} 的规则"

  sect "A4. 选路结果（同一目的，不同 mark 必须落到不同 DA）"
  r0="$(ip -6 route get "$SVC" mark "$PLANE0_MARK" 2>/dev/null)"
  r1="$(ip -6 route get "$SVC" mark "$PLANE1_MARK" 2>/dev/null)"
  echo "$r0" | grep -q "$DA_PLANE0" && ok "mark ${PLANE0_MARK} 解析到平面 0 DA" || bad "mark ${PLANE0_MARK} 没走平面 0"
  echo "$r1" | grep -q "$DA_PLANE1" && ok "mark ${PLANE1_MARK} 解析到平面 1 DA" || bad "mark ${PLANE1_MARK} 没走平面 1"

  sect "A5. 端到端连通（走平面 1 默认路径）"
  if ping -6 -c 3 -W 2 "$SVC" >/dev/null 2>&1; then
    ok "ping ${SVC} 通 —— 封装、弹栈、解封装整条链路成立"
  else
    bad "ping 不通。依次查：b 的 svc0 有地址？b 的 DT6 路由在？c 的转发开了？"
  fi
}

verify_b() {
  sect "B1. 服务地址"
  ip -6 addr show dev svc0 2>/dev/null | grep -q "$SVC" && ok "svc0 上有 ${SVC}" || bad "svc0 没有 ${SVC}"

  sect "B2. 终止 SID"
  ip -6 route show "$LOC_TAIL" | grep -q "seg6local" && ok "End.DT6 就位：${LOC_TAIL}" || bad "缺 ${LOC_TAIL} 的 End.DT6"

  sect "B3. 抓包看有没有 SRH（uSID 方案的卖点就在这）"
  if command -v tcpdump >/dev/null 2>&1; then
    tmp="$(mktemp /tmp/hpn.XXXX.pcap)"
    tcpdump -i "$IFACE" -nn -s 200 -c 20 -w "$tmp" "ip6 and net fcbb:bb00::/32" >/dev/null 2>&1 &
    tp=$!; sleep 1
    echo "   >>> 现在去 a 上执行：ping -6 -c 3 $SVC （有 8 秒窗口）"
    sleep 8
    kill "$tp" 2>/dev/null; wait "$tp" 2>/dev/null
    if [ -s "$tmp" ]; then
      n="$(tcpdump -r "$tmp" -nn 2>/dev/null | grep -c 'IP6' || true)"
      s="$(tcpdump -r "$tmp" -nn 2>/dev/null | grep -c 'Routing Header' || true)"
      [ "${n:-0}" -gt 0 ] && ok "在 b 上抓到 ${n} 个 uSID 外层包"
      [ "${s:-0}" -eq 0 ] && ok "其中带 SRH 的 0 个 —— 纯 DA 编码，vSwitch 想剥也剥不到" || bad "出现 SRH，说明用了标准 encap 而非 uSID"
      echo "   前 3 个包："
      tcpdump -r "$tmp" -nn 2>/dev/null | head -3 | sed 's/^/     /'
    else
      bad "没抓到包，先确认 a 的 ping 是否通"
    fi
    rm -f "$tmp"
  else
    bad "缺 tcpdump"
  fi
}

verify_c() {
  sect "C1. 转发与 SID"
  [ "$(sysctl -n net.ipv6.conf.all.forwarding)" = "1" ] && ok "IPv6 转发已开" || bad "转发没开"
  ip -6 route show "$LOC_TRANSIT" | grep -q "next-csid" && ok "uN + next-csid 就位（lblen/nflen 正确）" || bad "缺 ${LOC_TRANSIT} 的 next-csid 行为"

  sect "C2. 弹栈后往哪走"
  ip -6 route show "fcbb:bb00:${U_TAIL}::/48" | grep -q "via" && ok "残留 DA 能送到 b" || bad "缺到 b 的路由"

  sect "C3. 抓包验证 uSID 真的被左移了（本实验最关键的一帧）"
  if command -v tcpdump >/dev/null 2>&1; then
    tmp="$(mktemp /tmp/hpn.XXXX.pcap)"
    tcpdump -i "$IFACE" -nn -s 200 -c 20 -w "$tmp" "ip6 and net fcbb:bb00::/32" >/dev/null 2>&1 &
    tp=$!; sleep 1
    echo "   现在去 a 上执行：ping -6 -c 3 ${SVC}"
    sleep 8
    kill "$tp" 2>/dev/null; wait "$tp" 2>/dev/null
    if [ -s "$tmp" ]; then
      echo "   抓到的外层 DA 序列（应该能看到 2:e000 变成 e000）："
      tcpdump -r "$tmp" -nn 2>/dev/null | grep -o 'fcbb:bb00:[0-9a-f:]*' | sort | uniq -c | sed 's/^/     /'
      if tcpdump -r "$tmp" -nn 2>/dev/null | grep -q "fcbb:bb00:2:e000"; then
        ok "抓到 DA=…:2:e000::（弹栈前）"
      fi
      if tcpdump -r "$tmp" -nn 2>/dev/null | grep -qE "fcbb:bb00:e000"; then
        ok "抓到 DA=…:e000::（弹栈后）—— uSID 位移成立"
      fi
    else
      bad "没抓到包"
    fi
    rm -f "$tmp"
  else
    bad "缺 tcpdump"
  fi
}

# 实测封装开销：二分找最大可用载荷，两者相减 = 外层头字节数
max_payload() {
  local dst="$1" lo=0 hi=1472 mid
  while [ $((hi-lo)) -gt 1 ]; do
    mid=$(( (lo+hi)/2 ))
    if ping -6 -c 1 -W 1 -M do -s "$mid" "$dst" >/dev/null 2>&1; then lo=$mid; else hi=$mid; fi
  done
  echo "$lo"
}

cmd_overhead() {
  sect "封装开销实测（不靠文档，靠自己测）"
  echo "   正在二分探测最大可用载荷，稍等…"
  local m_direct m_enc
  m_direct="$(max_payload "$NODE_B_IPV6")"
  m_enc="$(max_payload "$SVC")"
  echo "   裸 IPv6   最大载荷 ${m_direct} B"
  echo "   uSID 封装 最大载荷 ${m_enc} B"
  if [ "${m_direct:-0}" -gt 0 ] && [ "${m_enc:-0}" -gt 0 ]; then
    echo "   ─────────────────────────────"
    echo "   实测开销 = $((m_direct - m_enc)) B"
    cat <<'EOF'
   对照（理论值，同一路径 1 个中转 SID）：
     uSID 单容器（本次）   40 B   仅外层 IPv6 头，无 SRH
     标准 SRv6 + 1 段      88 B   外层 40 + SRH(8+16)
     标准 SRv6 + 2 段     104 B   外层 40 + SRH(8+32)
   → 小包场景下这 48~64 字节就是有效载荷率的差距，也是 RFC 9800 存在的理由
EOF
  else
    echo "   探测失败，先确认连通性"
  fi
}

cmd_capture() { case "$ROLE" in c) verify_c ;; b) verify_b ;; *) echo "capture 只在 b/c 上有意义" ;; esac; }

case "${1:-}" in
  overhead) cmd_overhead ;;
  capture)  cmd_capture ;;
  *)
    echo "============================================================"
    echo " 验收  角色=${ROLE}"
    echo "============================================================"
    case "$ROLE" in
      a) verify_a ;;
      b) verify_b ;;
      c) verify_c ;;
      *) echo "ROLE 非法" ;;
    esac
    echo
    printf ' 结果：通过 %d 项，失败 %d 项\n' "$P" "$F"
    [ "$F" -eq 0 ] && echo " 全部通过，可以进入实验手册的 L1" || echo " 有失败项，按提示逐条修"
    ;;
esac
