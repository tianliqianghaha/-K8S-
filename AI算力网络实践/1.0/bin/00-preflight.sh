#!/usr/bin/env bash
# ============================================================================
# 00-preflight.sh —— 开跑前的体检
# 目的：在花时间配拓扑之前，把"这台机器根本做不了"的情况全部排除掉。
# 用法：sudo ./bin/00-preflight.sh
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_env.sh
source "${HERE}/_env.sh"

PASS=0; WARN=0; FAIL=0
ok()   { printf '  [ ok ] %s\n' "$1"; PASS=$((PASS+1)); }
warn() { printf '  [warn] %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '  [fail] %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "============================================================"
echo " HPN-3 实验台 · 环境体检   角色=${ROLE}  网卡=${IFACE}"
echo "============================================================"

# ---------------------------------------------------------------- 1 权限
echo
echo "-- 1. 权限与身份"
if [ "$(id -u)" -ne 0 ]; then
  bad "需要 root（netns / 路由 / tc 全部要 root）"
else
  ok "root"
fi

case "$ROLE" in
  a|b|c) ok "ROLE=${ROLE}" ;;
  *)     bad "ROLE 必须是 a / b / c，当前是 '${ROLE}'" ;;
esac

# ---------------------------------------------------------------- 2 内核
echo
echo "-- 2. 内核能力（决定 uSID 能不能用）"
KREL="$(uname -r)"
KMAJ="${KREL%%.*}"; KMIN="${KREL#*.}"; KMIN="${KMIN%%.*}"
echo "     内核：${KREL}"
if [ "${KMAJ:-0}" -gt 6 ] || { [ "${KMAJ:-0}" -eq 6 ] && [ "${KMIN:-0}" -ge 1 ]; }; then
  ok ">= 6.1，原生支持 NEXT-C-SID（RFC 9800 uSID）"
else
  bad "< 6.1，没有 uSID 压缩。换 Ubuntu 24.04 或装 HWE 内核"
fi

CFG="/boot/config-${KREL}"
check_cfg() {
  local key="$1" desc="$2"
  if [ -r "$CFG" ]; then
    if grep -qE "^${key}=[ym]" "$CFG"; then ok "${key} ${desc}"; else bad "${key} 未开启 ${desc}"; fi
  elif [ -r /proc/config.gz ]; then
    if zgrep -qE "^${key}=[ym]" /proc/config.gz; then ok "${key} ${desc}"; else bad "${key} 未开启 ${desc}"; fi
  else
    warn "读不到内核配置，跳过 ${key} 检查"
  fi
}
check_cfg CONFIG_IPV6_SEG6_LWTUNNEL "SRv6 封包/解包（seg6local 也在其中）"
check_cfg CONFIG_IPV6_MULTIPLE_TABLES "多路由表（策略路由要用表 100/101）"
if modprobe -n ioam6 >/dev/null 2>&1; then
  ok "ioam6 模块可用（L9 遥测实验可做）"
else
  warn "ioam6 模块不可用，L9 跳过（不影响主线）"
fi

# ---------------------------------------------------------------- 3 iproute2
echo
echo "-- 3. iproute2（决定命令语法能不能被接受）"
IPV="$(ip -V 2>/dev/null | sed -n 's/.*iproute2-\([0-9][0-9.]*\).*/\1/p')"
echo "     iproute2：${IPV:-未知}"
# 功能探测比 grep 帮助文本可靠：真的往一张临时表里装一条 next-csid 路由，装完就删
if ip -6 route replace fcbb:bb00:fffe::/48 encap seg6local action End \
     flavors next-csid lblen 32 nflen 16 dev lo table 12345 2>/dev/null; then
  ip -6 route del fcbb:bb00:fffe::/48 table 12345 2>/dev/null
  ok "next-csid（uSID）可装载 —— 功能探测通过"
else
  bad "装不上 flavors next-csid：需要内核 >=6.1 且 iproute2 配套"
fi
if ip ioam help >/dev/null 2>&1 || ip ioam6 help >/dev/null 2>&1; then
  ok "ip ioam 子命令存在"
else
  warn "ip ioam 子命令不存在，L9 跳过"
fi
command -v tc >/dev/null 2>&1 && ok "tc 可用" || bad "缺 tc（iproute2 未装全）"
command -v python3 >/dev/null 2>&1 && ok "python3 可用" || warn "缺 python3，mrc_lite 不能跑"

# ---------------------------------------------------------------- 4 IPv6
echo
echo "-- 4. IPv6 地址与连通性（这是整个实验的地基）"
if ip -6 addr show dev "$IFACE" scope global 2>/dev/null | grep -q "inet6"; then
  SELF_IP="$(ip -6 addr show dev "$IFACE" scope global | awk '/inet6/{print $2}' | head -1 | cut -d/ -f1)"
  ok "${IFACE} 有全局 IPv6：${SELF_IP}"
else
  bad "${IFACE} 没有全局 IPv6。去 VPC 开 IPv6 子网并给 ENI 分配地址"
  SELF_IP=""
fi

MTU="$(cat "/sys/class/net/${IFACE}/mtu" 2>/dev/null || echo 0)"
echo "     ${IFACE} MTU = ${MTU}"
if [ "${MTU:-0}" -ge 1500 ]; then
  ok "MTU 正常（封包后仍有余量）"
elif [ "${MTU:-0}" -ge 1400 ]; then
  warn "MTU=${MTU}，封 40 字节后大包会触发 PMTU，L3 会重点打这个"
else
  bad "MTU=${MTU} 太小，uSID 封包后基本跑不动"
fi

for n in A B C; do
  var="NODE_${n}_IPV6"; ipv="${!var}"
  if [ -z "$ipv" ]; then
    bad "NODE_${n}_IPV6 未填写"
    continue
  fi
  if [ "$ipv" = "${SELF_IP:-}" ]; then
    ok "NODE_${n} 是本机（${ipv}）"
  elif ping -6 -c 1 -W 2 "$ipv" >/dev/null 2>&1; then
    ok "NODE_${n} 可达（${ipv}）"
  else
    bad "NODE_${n} 不可达（${ipv}）：安全组是否放行 ICMPv6？是否同子网？"
  fi
done

# ---------------------------------------------------------------- 5 转发
echo
echo "-- 5. 转发与伪装"
if [ "$ROLE" = "c" ]; then
  cur="$(sysctl -n net.ipv6.conf.all.forwarding 2>/dev/null || echo 0)"
  [ "$cur" = "1" ] && ok "IPv6 转发已开" || warn "IPv6 转发未开，20-topology.sh 会自动打开"
fi
for p in /proc/sys/net/ipv6/conf/all/disable_ipv6; do
  [ "$(cat $p 2>/dev/null || echo 0)" = "0" ] && ok "IPv6 协议栈未禁用" || bad "IPv6 被 disable_ipv6=1 关掉了"
done

# ---------------------------------------------------------------- 6 结论
echo
echo "============================================================"
printf ' 体检结果：ok=%d  warn=%d  fail=%d\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " 结论：可以继续，执行 sudo ./bin/10-probe.sh 做通透性探测"
else
  echo " 结论：先修 fail 项，否则后面的实验会在半路以奇怪的方式失败"
fi
echo "============================================================"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
