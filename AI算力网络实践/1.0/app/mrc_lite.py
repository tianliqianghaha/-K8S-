#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mrc_lite.py —— 一个 200 行的"端侧多路径"原型。

它复刻的是 MRC 论文里最核心的三个动作，而不是它的性能：
  1) 每个包单独选路径（EV 轮转），而不是一条流绑一条路
  2) 接收端容忍乱序（打散必然乱序，不容忍就没法用）
  3) 输出"乱序率 / 丢包率 / 尾延迟"——这三项才是训练关心的量

路径怎么选：靠 SO_MARK 打标，a 上的 ip rule 把不同 mark 导到不同路由表，
每个表里是一条指向不同 uSID 的封装路由。全程不需要改内核、不需要 DPDK。

用法（接收端，b 上）：
    sudo python3 mrc_lite.py recv --port 9999 --count 20000

用法（发送端，a 上）：
    sudo python3 mrc_lite.py send --dst fd00:b0b0::1 --port 9999 \
         --count 20000 --size 64 --plane both --rate 20000

    --plane 0/1/both  0=绕行平面，1=直达平面，both=逐包交替（真正的喷洒）
"""
import argparse
import os
import socket
import struct
import sys
import time
from collections import deque

HDR = struct.Struct("!QQB")          # seq, ts_ns, plane
SOL_SOCKET = socket.SOL_SOCKET
SO_MARK = 36                          # Linux 常量，Python 没导出
IPV6_TCLASS = 67


def now_ns():
    return time.monotonic_ns()


def build_payload(seq, plane, size):
    body = HDR.pack(seq, now_ns(), plane)
    if len(body) < size:
        body += b"\x00" * (size - len(body))
    return body[:max(size, HDR.size)]


def do_send(args):
    mark = {0: args.mark0, 1: args.mark1}
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    if args.size < HDR.size:
        print(f"size 至少 {HDR.size}", file=sys.stderr)
        return 2
    if getattr(args, "dscp", None) is not None:
        s.setsockopt(socket.IPPROTO_IPV6, IPV6_TCLASS, (args.dscp & 0x3F) << 2)

    interval = 1.0 / args.rate if args.rate > 0 else 0.0
    start = time.monotonic()
    sent = {0: 0, 1: 0}
    for seq in range(args.count):
        if args.plane == "both":
            plane = seq & 1              # 逐包交替 = 最朴素的喷洒
        else:
            plane = int(args.plane)
        try:
            s.setsockopt(SOL_SOCKET, SO_MARK, mark[plane])
        except PermissionError:
            print("设置 SO_MARK 需要 root（CAP_NET_ADMIN）", file=sys.stderr)
            return 3
        s.sendto(build_payload(seq, plane, args.size), (args.dst, args.port))
        sent[plane] += 1
        if interval:
            nxt = start + (seq + 1) * interval
            d = nxt - time.monotonic()
            if d > 0:
                time.sleep(d)

    dur = time.monotonic() - start
    total_bytes = args.count * args.size
    print("发送完成")
    print(f"  包数 {args.count}   载荷 {args.size} B   用时 {dur:.3f} s")
    print(f"  平面 0 发出 {sent[0]}   平面 1 发出 {sent[1]}")
    print(f"  应用层吞吐 {total_bytes * 8 / dur / 1e6:.2f} Mbps   "
          f"{args.count / dur:.0f} pps")
    return 0


def do_recv(args):
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind((args.bind, args.port))
    s.settimeout(args.idle)

    seen = set()
    max_seq = -1
    reorder = 0
    dup = 0
    per_plane = {0: 0, 1: 0}
    arrivals = []
    first = None
    last = None

    print(f"监听 [{args.bind}]:{args.port} 等待 {args.count} 个包…")
    try:
        while len(seen) < args.count:
            data, _ = s.recvfrom(65535)
            t = now_ns()
            if len(data) < HDR.size:
                continue
            seq, ts, plane = HDR.unpack(data[:HDR.size])
            if first is None:
                first = t
            last = t

            if seq in seen:
                dup += 1
                continue
            if seq < max_seq:
                reorder += 1
            else:
                max_seq = seq
            seen.add(seq)
            per_plane[plane] = per_plane.get(plane, 0) + 1
            arrivals.append(t)
    except socket.timeout:
        pass

    got = len(seen)
    if got == 0:
        print("一个包都没收到")
        return 1

    expected = max_seq + 1
    lost = expected - got
    dur = (last - first) / 1e9 if last and first and last > first else 0

    gaps = [(arrivals[i] - arrivals[i - 1]) / 1e6 for i in range(1, len(arrivals))]
    gaps.sort()

    def pct(q):
        if not gaps:
            return 0.0
        return gaps[min(len(gaps) - 1, int(len(gaps) * q))]

    print("\n接收结果")
    print(f"  收到 {got}   期望 {expected}   丢 {lost} ({(lost/expected*100 if expected else 0):.2f}%)")
    print(f"  乱序 {reorder} ({(reorder/got*100):.1f}%)   重复 {dup}")
    print(f"  平面 0 {per_plane.get(0,0)}   平面 1 {per_plane.get(1,0)}")
    if dur > 0:
        print(f"  接收时长 {dur:.3f} s   包间隔中位 {pct(0.5):.3f} ms   p99 {pct(0.99):.3f} ms  最大 {gaps[-1] if gaps else 0:.3f} ms")
    print()
    print("  怎么读这三个数：")
    print("   乱序率高但丢包 0  → 喷洒生效了。这时如果端侧不容忍乱序，性能会崩")
    print("   丢包率高           → 某条路径真坏了，或 ECN/限速把它压死了")
    print("   p99 远大于中位     → 尾延迟被拥塞点支配，去 L9 用 IOAM 定位")
    return 0


def main():
    ap = argparse.ArgumentParser(description="MRC-lite：逐包多路径原型")
    sub = ap.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("send")
    ps.add_argument("--dst", required=True)
    ps.add_argument("--port", type=int, default=9999)
    ps.add_argument("--count", type=int, default=10000)
    ps.add_argument("--size", type=int, default=64)
    ps.add_argument("--plane", default="both", choices=["0", "1", "both"])
    ps.add_argument("--rate", type=float, default=0, help="pps，0=不限速")
    ps.add_argument("--mark0", type=lambda x: int(x, 0), default=0x2)
    ps.add_argument("--mark1", type=lambda x: int(x, 0), default=0x1)
    ps.add_argument("--dscp", type=int, default=None, help="IPv6 Traffic Class 的 DSCP 值，用于 QoS 实验")

    pr = sub.add_parser("recv")
    pr.add_argument("--bind", default="fd00:b0b0::1")
    pr.add_argument("--port", type=int, default=9999)
    pr.add_argument("--count", type=int, default=10000)
    pr.add_argument("--idle", type=float, default=3.0, help="多少秒没包就收工")

    a = ap.parse_args()
    return do_send(a) if a.cmd == "send" else do_recv(a)


if __name__ == "__main__":
    sys.exit(main())
