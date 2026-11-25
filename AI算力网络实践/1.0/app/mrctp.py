#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mrctp.py —— MRC/UEC 传输思想的可用原型（SACK 选择性重传 + 即时 NACK + 逐包喷洒）

它解决的问题，就是十万卡集群那篇论文的核心：
  RoCEv2 一旦丢包，源端只能 Go-back-N（整窗重传），代价极高；
  所以生产上要靠 PFC 保证不丢。而 MRC 反过来了：
    ① 每个包单独选路径（喷洒），把链路用满
    ② 接收端用 SACK 精确告诉发送端"哪几个洞"
    ③ 发送端只补洞，不整窗回退
    ④ 一旦发现洞就立刻 NACK（不等超时）——这是 packet trimming 的等价收益
  于是可以在"有损网络"上跑，从而关掉 PFC。

三种模式可切，用于量化对比：
  --retx gbn    洞出现后从第一个洞开始整窗重发（RoCEv2 式）
  --retx sack   只重发 SACK 位图里的洞（MRC 式）
  --nack on/off 立刻 NACK 还是等 RTO（trimming 的收益来源）
  --paths 1|2   单路径 / 双平面逐包喷洒

用法（两端各跑一个角色，接收端先起）：
  b: sudo python3 mrctp.py run --role recv --port 9400 --msg-mb 4
  a: sudo python3 mrctp.py run --role send --peer <b的IPv6> --port 9400 \
       --msg-mb 4 --paths 2 --retx sack --nack on

性能相关的三条实现约束（v2 修掉的）：
  1. 洞的定位必须是 O(1)：维护 cbase 指针，不做 range(0, max(st)) 扫描
  2. 同一个洞不能在抑制窗口内重复 NACK：否则发送端被"假洞"打爆重传
  3. 发送端只对 inflight 做 RTO 扫描，且分片载荷预生成，不在热路径 pack
"""
import argparse
import json
import select
import socket
import struct
import sys
import time

SO_MARK = 36
CHUNK = 1400
HDR = struct.Struct("!IIIBI")     # msg_id, chunk_idx, total_chunks, flags, ts_ms
MSG_DONE = 1                      # flags: 该 msg 的最后一个 chunk

SACK = struct.Struct("!IIH")      # msg_id, base(第一个未收到的 chunk), nbits
NACK = struct.Struct("!II")       # msg_id, chunk_idx（立刻要求重传的洞）

NACK_SUPPRESS = 0.02              # 同一个洞 20ms 内只 NACK 一次（防 NACK 风暴）
RETX_SUPPRESS = 0.02              # 同一个片 20ms 内收到多次 NACK 只重发一次


def mk_sock(bind_port, mark=None):
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 32 << 20)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 32 << 20)
    except OSError:
        pass
    if mark is not None:
        try:
            s.setsockopt(socket.SOL_SOCKET, SO_MARK, mark)
        except OSError:
            print("设置 SO_MARK 失败（需 root 或非 Linux）", file=sys.stderr)
    s.bind(("::", bind_port))
    s.setblocking(False)
    return s


def total_chunks(msg_mb):
    return max(1, int(msg_mb * 1024 * 1024 / CHUNK))


# ----------------------------------------------------------------- 发送端
def run_sender(a):
    # 发送端绑定临时端口：SACK/NACK 会被对端按这个源端口回送。
    # 如果也绑 a.port，同机测试时两端会抢同一个 UDP 端口，收包互相串台。
    s = mk_sock(0)
    nch = total_chunks(a.msg_mb)
    if a.paths == 2:
        # 每条平面一个独立目的端口 + 独立 fwmark。
        # 端口分开是为了让 tc 能只打伤其中一条平面（u32 match u16 dport），
        # 这也是真实 MRC 的做法：每个 QP 绑定一条平面，而不是靠五元组哈希碰运气。
        marks = [a.mark0, a.mark1]
        ports = [a.port, a.port1]
    else:
        marks = [a.mark1]
        ports = [a.port1]

    acked = set()        # (msg,idx)
    attempts = {}        # (msg,idx) -> 次数
    inflight = {}        # (msg,idx) -> 上次发送时刻（只放未确认的）
    retx = 0
    spurious = 0
    total_tx = 0
    t_start = time.monotonic()
    next_chunk = 0
    msg = 0
    done_msgs = 0
    completion = []
    cwnd = a.window
    rr = 0
    sacks_recv = 0
    bits_acked = 0
    acked_cnt = {}
    cur_mark = None
    pkt_cache = (None, None)             # (msg, list[bytes])

    payload = b"\x00" * (CHUNK - HDR.size)

    def packets_for(m):
        nonlocal pkt_cache
        if pkt_cache[0] == m:
            return pkt_cache[1]
        pk = []
        for i in range(nch):
            h = HDR.pack(m, i, nch, MSG_DONE if i == nch - 1 else 0, 0)
            pk.append(h + payload)
        pkt_cache = (m, pk)
        return pk

    def emit(m, idx):
        nonlocal rr, cur_mark, total_tx
        i = rr % len(marks)
        mark = marks[i]
        dst_port = ports[i]
        rr += 1
        if mark != cur_mark:                 # 只在切换路径时改，别每包都 setsockopt
            try:
                s.setsockopt(socket.SOL_SOCKET, SO_MARK, mark)
                cur_mark = mark
            except OSError:
                cur_mark = mark
        s.sendto(packets_for(m)[idx], (a.peer, dst_port))
        key = (m, idx)
        attempts[key] = attempts.get(key, 0) + 1
        inflight[key] = time.monotonic()
        total_tx += 1

    deadline = t_start + a.timeout
    while time.monotonic() < deadline and done_msgs < a.msgs:
        # 1) 发新数据
        while len(inflight) < cwnd and next_chunk < nch:
            emit(msg, next_chunk)
            next_chunk += 1

        # 2) 本消息是否已全部确认
        if acked_cnt.get(msg, 0) >= nch:
            done_msgs += 1
            completion.append(time.monotonic() - t_start)
            inflight = {k: v for k, v in inflight.items() if k[0] != msg}
            msg += 1
            next_chunk = 0
            continue

        # 3) 收 SACK / NACK
        r, _, _ = select.select([s], [], [], 0.005)
        if r:
            for _ in range(512):
                try:
                    data = s.recv(2048)
                except BlockingIOError:
                    break
                if len(data) >= 1 + SACK.size and data[:1] == b"S":
                    sacks_recv += 1
                    m, base, nbits = SACK.unpack(data[1:1 + SACK.size])
                    if m not in acked_cnt:
                        acked_cnt.setdefault(m, 0)
                    # base 之前的全部视为已确认（累积 ACK）
                    for k in [k for k in inflight if k[0] == m and k[1] < base]:
                        del inflight[k]
                        acked.add(k)
                        bits_acked += 1
                        acked_cnt[m] = acked_cnt.get(m, 0) + 1
                    # 位图里的 1 = 收到
                    bm = data[1 + SACK.size:]
                    if nbits and bm:
                        for bit in range(nbits):
                            if bm[bit >> 3] & (1 << (bit & 7)):
                                key = (m, base + bit)
                                if key in inflight:
                                    del inflight[key]
                                    acked.add(key)
                                    bits_acked += 1
                                    acked_cnt[m] = acked_cnt.get(m, 0) + 1
                elif len(data) >= 1 + NACK.size and data[:1] == b"N":
                    m, idx = NACK.unpack(data[1:1 + NACK.size])
                    key = (m, idx)
                    if key in acked or a.nack_ignore:
                        continue
                    last = inflight.get(key)
                    if last is not None and time.monotonic() - last < RETX_SUPPRESS:
                        continue          # 刚发过，别被重复 NACK 打爆
                    retx += 1
                    emit(m, idx)

        # 4) RTO 兜底（只扫 inflight，规模 <= cwnd + 少量重传）
        now = time.monotonic()
        holes = [k for k, t in inflight.items() if now - t > a.rto]
        if holes:
            if a.retx == "gbn":
                first = min(k[1] for k in holes)
                for idx in range(first, min(first + cwnd, nch)):
                    key = (msg, idx)
                    if key not in acked:
                        if key in inflight:
                            spurious += 1
                        retx += 1
                        emit(msg, idx)
            else:
                for k in holes:
                    if k in inflight:
                        spurious += 1
                    retx += 1
                    emit(*k)

    elapsed = time.monotonic() - t_start
    sent_bytes = a.msgs * a.msg_mb * 1024 * 1024
    c = sorted(completion)
    return {
        "role": "send", "mode": a.retx, "paths": a.paths, "nack": not a.nack_ignore,
        "msgs_done": done_msgs, "msgs_target": a.msgs,
        "elapsed_s": round(elapsed, 3),
        "goodput_mbps": round(sent_bytes * 8 / elapsed / 1e6, 2) if elapsed else 0,
        "retx_pkts": retx, "spurious_retx": spurious, "pkt_attempts": total_tx,
        "retx_ratio_pct": round(retx * 100.0 / max(1, total_tx), 2),
        "sacks_recv": sacks_recv, "bits_acked": bits_acked,
        "inflight_left": len(inflight),
        "msg_p50_s": round(c[len(c) // 2], 3) if c else None,
        "msg_p99_s": round(c[min(len(c) - 1, int(len(c) * 0.99))], 3) if c else None,
    }


# ----------------------------------------------------------------- 接收端
def run_receiver(a):
    socks = [mk_sock(a.port), mk_sock(a.port + 1)]
    dest = {}                # sock -> 发送端地址（在哪个 socket 上收到就回哪个）
    have = {}          # msg -> set(idx)
    total = {}         # msg -> nch
    cbase = {}         # msg -> 累积 ACK 点（第一个洞）
    nacked = {}        # (msg,idx) -> 上次 NACK 时刻
    reorder = 0
    dup = 0
    uniq = 0
    max_seen = {}
    done = 0
    t_start = time.monotonic()
    completion = []
    last_sack = {}
    sack_sent = 0
    nack_sent = 0

    deadline = t_start + a.timeout
    while time.monotonic() < deadline:
        r, _, _ = select.select(socks, [], [], 0.02)
        for sk in r:
            for _ in range(1024):
                try:
                    data, addr = sk.recvfrom(4096)
                except BlockingIOError:
                    break
                if len(data) < HDR.size:
                    continue
                m, idx, nch, _flags, _ts = HDR.unpack(data[:HDR.size])
                dest[sk] = addr               # 用学到的源地址回发 SACK/NACK
                if m not in total:
                    total[m] = nch
                    cbase[m] = 0
                    last_sack[m] = 0.0
                st = have.setdefault(m, set())
                if idx in st:
                    dup += 1
                    continue
                if idx < max_seen.get(m, -1):
                    reorder += 1
                max_seen[m] = idx if idx > max_seen.get(m, -1) else max_seen.get(m, -1)
                st.add(idx)
                uniq += 1

                # O(1) 推进累积 ACK 点
                cb = cbase[m]
                if idx == cb:
                    while cb in st:
                        cb += 1
                    cbase[m] = cb

                # 即时 NACK：只针对 cbase 这一个洞，且有抑制窗口
                if not a.no_nack and cb < nch and cb not in st:
                    key = (m, cb)
                    now = time.monotonic()
                    if now - nacked.get(key, 0.0) > NACK_SUPPRESS:
                        nacked[key] = now
                        sk.sendto(b"N" + NACK.pack(m, cb), addr)
                        nack_sent += 1

                if len(st) >= nch:
                    # 先发终态 SACK 再清状态，否则发送端永远不知道收齐了
                    sk.sendto(b"S" + SACK.pack(m, nch, 0), addr)
                    done += 1
                    completion.append(time.monotonic() - t_start)
                    have[m] = set()

        # 周期 SACK（放在收包循环外，避免每包都算位图）
        now = time.monotonic()
        for m, st in list(have.items()):
            if not st or m not in total:
                continue
            if now - last_sack.get(m, 0.0) < a.sack_interval:
                continue
            nch = total[m]
            base = cbase[m]
            nbits = min(256, nch - base)
            last_sack[m] = now
            if nbits <= 0:
                for sk, d in dest.items():
                    sk.sendto(b"S" + SACK.pack(m, nch, 0), d)
                sack_sent += 1
                continue
            bm = bytearray((nbits + 7) // 8)
            for i in range(nbits):
                if base + i in st:
                    bm[i >> 3] |= 1 << (i & 7)
            pkt = b"S" + SACK.pack(m, base, nbits) + bytes(bm)
            for sk, d in dest.items():
                sk.sendto(pkt, d)
            sack_sent += 1

    c = sorted(completion)
    elapsed = time.monotonic() - t_start
    recv_bytes = uniq * CHUNK
    return {
        "role": "recv", "msgs_done": done,
        "elapsed_s": round(elapsed, 3),
        "recv_mbytes": round(recv_bytes / 1e6, 1),
        "goodput_mbps": round(recv_bytes * 8 / elapsed / 1e6, 2) if elapsed else 0,
        "out_of_order": reorder, "dup": dup,
        "sack_sent": sack_sent, "nack_sent": nack_sent,
        "msg_p50_s": round(c[len(c) // 2], 3) if c else None,
        "msg_p99_s": round(c[min(len(c) - 1, int(len(c) * 0.99))], 3) if c else None,
    }


def main():
    ap = argparse.ArgumentParser(description="MRC 传输原型（SACK 选择性重传）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("--role", required=True, choices=["send", "recv"])
    p.add_argument("--peer", default="::1", help="接收端填发送端地址（用于主动回发 SACK）")
    p.add_argument("--port", type=int, default=9400, help="平面 0 端口（接收端同时监听 port 与 port+1）")
    p.add_argument("--port1", type=int, default=None, help="平面 1 端口，默认 port+1")
    p.add_argument("--msg-mb", type=float, default=4)
    p.add_argument("--msgs", type=int, default=4)
    p.add_argument("--paths", type=int, default=1, choices=[1, 2])
    p.add_argument("--retx", default="sack", choices=["sack", "gbn"])
    p.add_argument("--nack", default="on", choices=["on", "off"])
    p.add_argument("--window", type=int, default=256)
    p.add_argument("--rto", type=float, default=0.30)
    p.add_argument("--timeout", type=float, default=60)
    p.add_argument("--sack-interval", type=float, default=0.002)
    p.add_argument("--mark0", type=lambda x: int(x, 0), default=0x2)
    p.add_argument("--mark1", type=lambda x: int(x, 0), default=0x1)
    a = ap.parse_args()
    if a.port1 is None:
        a.port1 = a.port + 1
    a.nack_ignore = (a.nack == "off")
    a.no_nack = (a.nack == "off")

    if a.role == "send":
        res = run_sender(a)
    else:
        res = run_receiver(a)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
