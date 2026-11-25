#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collsim.py —— 集合通信流量形态模拟器（无 GPU，只复刻流量）

为什么需要它：
  NCCL 跑不了（没有 GPU），但"网络看到的流量形状"完全可以复刻。
  真正决定网络怎么设计的是四件事：
    ① 一次迭代发多少条消息  ② 每条多大  ③ 谁发给谁  ④ 是否需要等齐
  Ring AllReduce 和 AlltoAll 在这四项上完全不同，网络诉求也完全不同。

四种模式：
  ring    Ring AllReduce 的 Ring 阶段：每轮只和左右邻居换数据，2(N-1) 轮
  tree    Tree AllReduce：递归二分，log2(N) 轮，每轮扇出更大
  a2a     AlltoAll（MoE 专家并行的典型）：每个节点给其余每个节点各发一条
  pipe    流水线并行：单向链 0→1→…→n-1，逐跳转发，不回 ack

★ 两条硬约束（都是踩过的坑）：
  1) 各机器的 time.monotonic() 起点不同，**绝对不能跨机相减**。
     所以本工具不输出"跨机 RTT"，只输出：本地 elapsed、本地收包间隔分位数。
  2) 起跑对齐用"屏障"（RDY/ACK/GO），不依赖时钟，误差只剩单向网络时延。

用法（三台各跑一个 rank，--peers 顺序必须完全一致）：
  sudo python3 collsim.py run --pattern ring --rank 0 \
       --peers <ip_a>,<ip_b>,<ip_c> --port 9100 --size 65536 --count 8 \
       [--mark 0x2] [--dscp 46]
"""
import argparse
import json
import socket
import struct
import sys
import time

MAGIC = b"CSIM"
HDR = struct.Struct("!4sIII")       # magic, pattern_id, seq, slice_idx
                                    # 每一片都要带帧头：只有首片带头的方案会让
                                    # 接收端把后续分片当垃圾丢掉，消息永远收不齐
PATTERN_ID = {"ring": 1, "tree": 2, "a2a": 3, "pipe": 4}
SO_MARK = 36
IPV6_TCLASS = 67


def now_ns():
    return time.monotonic_ns()


def make_sock(bind_port, mark=None, dscp=None, timeout=10.0):
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # 关键：一条 60KB 消息会被切成 43 个包瞬间喷出，默认 ~212KB 收缓冲装不下，
    # 内核直接丢包，接收方表现为"永远等不到最后一包"
    for opt, val in ((socket.SO_RCVBUF, 32 << 20), (socket.SO_SNDBUF, 32 << 20)):
        try:
            s.setsockopt(socket.SOL_SOCKET, opt, val)
        except OSError:
            pass
    if mark is not None:
        s.setsockopt(socket.SOL_SOCKET, SO_MARK, mark)
    if dscp is not None:
        s.setsockopt(socket.IPPROTO_IPV6, IPV6_TCLASS, (dscp & 0x3F) << 2)
    s.bind(("::", bind_port))
    s.settimeout(timeout)
    return s


def payload(pat, seq, slice_idx, mtu):
    """一个 UDP 包 = 帧头 + 填充到 mtu。每片自带帧头，接收端才认得出。"""
    body = HDR.pack(MAGIC, PATTERN_ID[pat], seq, slice_idx)
    return body + b"\x00" * (mtu - HDR.size)


def barrier(s, base_port, peers, rank, timeout=60.0):
    """RDY -> ACK -> GO，纯消息对齐，不依赖任何时钟。

    rank0 会每 2 秒重发 RDY：云上批量下发命令时各机启动时间可能差好几秒，
    单次 RDY 很容易丢在"对端还没起监听"的空窗里。
    """
    s.settimeout(2.0)
    others = [i for i in range(len(peers)) if i != rank]
    t_begin = time.monotonic()
    if rank == 0:
        got = set()
        last_rdy = 0.0
        while len(got) < len(others):
            if time.monotonic() - last_rdy > 2.0:
                for i in others:
                    s.sendto(b"RDY", (peers[i], base_port + i))
                last_rdy = time.monotonic()
            if time.monotonic() - t_begin > timeout:
                raise socket.timeout("rank0 等不到全部 ACK")
            try:
                data, _ = s.recvfrom(64)
            except socket.timeout:
                continue
            if data.startswith(b"ACK:"):
                try:
                    got.add(int(data[4:]))
                except ValueError:
                    pass
        for i in others:
            s.sendto(b"GO", (peers[i], base_port + i))
        s.sendto(b"GO", (peers[rank], base_port + rank))
    else:
        while True:
            if time.monotonic() - t_begin > timeout:
                raise socket.timeout("等不到 GO")
            try:
                data, src = s.recvfrom(64)
            except socket.timeout:
                continue
            if data == b"GO":
                break
            if data == b"RDY":
                s.sendto(b"ACK:" + str(rank).encode(), src)
    s.settimeout(10.0)


def recv_one(s, pat, timeout=3.0):
    """收一条本模式的数据包；返回 seq 或 None。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            data, _ = s.recvfrom(65535)
        except socket.timeout:
            return None
        if len(data) < HDR.size:
            continue
        magic, pid, seq, _sl = HDR.unpack(data[:HDR.size])
        if magic == MAGIC and pid == PATTERN_ID[pat]:
            return seq
    return None


def run_pattern(pat, rank, peers, base_port, size, count, mark, dscp, mtu=1400):
    n = len(peers)
    if n < 2:
        raise SystemExit("至少需要 2 个节点")

    s = make_sock(base_port + rank, mark, dscp)
    barrier(s, base_port, peers, rank)

    sent = recv = 0
    arrivals = []
    nchunks = max(1, (size + mtu - 1) // mtu)      # 应用层按 MTU 切片，避免 IP 分片
    t_start = now_ns()

    def send_to(idx, seq):
        nonlocal sent
        dst = (peers[idx], base_port + idx)
        for i in range(nchunks):
            s.sendto(payload(pat, seq, i, mtu), dst)
            sent += 1

    def take(idx):
        nonlocal recv
        last = None
        for _ in range(nchunks):
            got = recv_one(s, pat)
            if got is None:
                return None
            recv += 1
            arrivals.append(now_ns())
            last = got
        return last

    if pat == "ring":
        right = (rank + 1) % n
        left = (rank - 1 + n) % n
        for r in range(2 * (n - 1)):
            send_to(right, r)
            take(left)
    elif pat == "tree":
        step, seq = 1, 0
        while step < n:
            partner = rank ^ step
            if partner < n:
                send_to(partner, seq)
                take(partner)
                seq += 1
            step <<= 1
    elif pat == "a2a":
        for c in range(count):
            for j in range(n):
                if j != rank:
                    send_to(j, c)
            for j in range(n):
                if j != rank:
                    take(j)
    elif pat == "pipe":
        if rank == 0:
            for c in range(count):
                send_to(1, c)
        elif rank < n - 1:
            for c in range(count):
                take(rank - 1)
                send_to(rank + 1, c)
        else:
            for c in range(count):
                take(rank - 1)

    elapsed = (now_ns() - t_start) / 1e9
    gaps = [(arrivals[i] - arrivals[i - 1]) / 1e6 for i in range(1, len(arrivals))]
    gaps.sort()

    def pct(q):
        if not gaps:
            return None
        return round(gaps[min(len(gaps) - 1, int(len(gaps) * q))], 3)

    return {
        "pattern": pat, "rank": rank, "nodes": n,
        "msg_size": size, "mtu_cut": mtu, "chunks_per_msg": nchunks,
        "rounds": count, "sent_pkts": sent, "recv_pkts": recv,
        "sent_msgs": sent // nchunks, "recv_msgs": recv // nchunks,
        "elapsed_s": round(elapsed, 4),
        "msgs_per_s": round((sent / nchunks) / elapsed, 2) if elapsed > 0 else 0,
        "app_mbps": round(sent * mtu * 8 / elapsed / 1e6, 2) if elapsed > 0 else 0,
        "gap_p50_ms": pct(0.50),
        "gap_p99_ms": pct(0.99),
        "note": "elapsed 与 gap 均为本机时钟，不可跨机相减",
    }


def main():
    ap = argparse.ArgumentParser(description="集合通信流量形态模拟器")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--pattern", required=True, choices=list(PATTERN_ID))
    r.add_argument("--rank", type=int, required=True)
    r.add_argument("--peers", required=True, help="逗号分隔，三台顺序必须一致")
    r.add_argument("--port", type=int, default=9100, help="基准端口，实际监听 port+rank")
    r.add_argument("--size", type=int, default=65536)
    r.add_argument("--count", type=int, default=8)
    r.add_argument("--mark", type=lambda x: int(x, 0), default=None)
    r.add_argument("--dscp", type=int, default=None)
    r.add_argument("--mtu", type=int, default=1400, help="应用层切片大小，避免 IP 分片")
    a = ap.parse_args()

    peers = [p.strip() for p in a.peers.split(",") if p.strip()]
    if a.rank >= len(peers):
        print("rank 超出 peers 数量", file=sys.stderr)
        return 2
    # UDP 单包上限 65507 字节（IPv6 头 40 + UDP 头 8 已扣除前的应用层上限）
    if a.size > 60000:
        print(json.dumps({"warning": f"--size {a.size} 超过 UDP 单包上限，已按 60000 发送；"
                                      "要大块数据请用 --count 多次发"}, ensure_ascii=False))
        a.size = 60000
    try:
        res = run_pattern(a.pattern, a.rank, peers, a.port, a.size, a.count,
                          a.mark, a.dscp, a.mtu)
    except socket.timeout:
        print(json.dumps({"error": "等待超时：检查 peers 顺序、端口是否被旧进程占用、其他 rank 是否在跑"},
                         ensure_ascii=False))
        return 1
    except OSError as exc:
        print(json.dumps({"error": f"发送失败 {exc}：size 过大或网卡异常"}, ensure_ascii=False))
        return 1
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
