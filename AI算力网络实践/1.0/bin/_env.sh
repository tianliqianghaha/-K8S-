#!/usr/bin/env bash
# ============================================================================
# _env.sh —— 统一加载 conf/lab.env
#
# 为什么要这一层：lab.env 很可能在 Windows 上被编辑过，带 CRLF。
# bash 里 IFACE="eth0\r" 是个合法字符串，但 /sys/class/net/eth0\r 不存在，
# 结果就是"MTU=0、没有 IPv6、什么设备都找不到"，且不报语法错。
# 这里统一把 CR 剥掉，避免整类假故障。
# ============================================================================

_LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_LAB_ENV="${LAB_ENV:-${_LAB_ROOT}/conf/lab.env}"

if [ ! -r "$_LAB_ENV" ]; then
  echo "找不到配置文件：$_LAB_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$_LAB_ENV"

for _v in ROLE IFACE NODE_A_IPV6 NODE_B_IPV6 NODE_C_IPV6 \
          USID_BLOCK U_TRANSIT U_TAIL SERVICE_ADDR \
          PLANE0_MARK PLANE1_MARK PLANE0_TABLE PLANE1_TABLE \
          VRF_NAME VRF_TABLE PROBE_ADDR LAB_DIR; do
  if [ -n "${!_v+x}" ]; then
    printf -v "$_v" '%s' "${!_v//$'\r'/}"
  fi
done
unset _v

LAB_DIR="${LAB_DIR:-/var/lib/hpnlab}"
mkdir -p "$LAB_DIR" 2>/dev/null || true
