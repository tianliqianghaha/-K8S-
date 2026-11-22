"""
本地 Agent —— 算力池的"跑腿"

职责（对齐大厂边缘 Agent 的最小语义集）：
  1. 反连长连接   主动连云端 gateway 的 /agent（WSS），本地在 NAT 后也能被派活
  2. 断线重连     指数退避 1s → 2s → 4s → 8s → 10s 封顶，永不放弃
  3. 取任务       收到 task 后调本地 vLLM 的流式接口
  4. 增量回传     每吐一个 token 就发一个 chunk，不做整段缓冲
  5. 幂等         已完成的 task_id 记住，重复派发直接回 done，不重复推理
  6. 不丢任务     断线时 inflight 保留，重连后通过 resume 上报，让 gateway 重建上下文
  7. 并发上限     信号量限制同时进行的推理数，防止把本地服务打满

为什么 Agent 要反连而不是云端直连本地：
  WSL 在 NAT 后面，没有固定可达地址。反连是边缘节点接入的标准做法，
  也是实验一"应用层反连"与实验二"内核层注册"对比的关键差异点。
"""
import asyncio
import json
import os
import ssl
import time

import aiohttp
import websockets

GATEWAY_WS = os.environ.get("GATEWAY_WS", "wss://47.238.160.73:30443/agent")
VLLM_URL = os.environ.get("VLLM_URL", "http://127.0.0.1:8000/v1/chat/completions")
AGENT_NAME = os.environ.get("AGENT_NAME", "ai-gpu-1")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "8"))
LOG_EVERY = 30

# 云端用的是自签证书（实验环境没有域名，签不出公共 CA）
# 生产环境这里应换成挂载真实 CA：ssl.create_default_context(cafile=...)
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

inflight: dict[str, dict] = {}
completed: dict[str, dict] = {}
send_lock = asyncio.Lock()
started_at = time.time()
counters = {"tasks": 0, "chunks": 0, "errors": 0, "reconnects": 0}


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


async def send(ws, obj: dict) -> bool:
    async with send_lock:
        try:
            await ws.send(json.dumps(obj, ensure_ascii=False))
            return True
        except Exception:
            return False


_ERR = object()


async def call_vllm(payload: dict, task_id: str, ws) -> object:
    """成功返回 usage（可能是 {}），失败返回 _ERR。"""
    body = dict(payload)
    body["stream"] = True
    body.setdefault("stream_options", {"include_usage": True})
    usage = None
    async with aiohttp.ClientSession() as s:
        try:
            async with s.post(VLLM_URL, json=body,
                              timeout=aiohttp.ClientTimeout(total=600)) as r:
                if r.status != 200:
                    txt = (await r.text())[:200]
                    counters["errors"] += 1
                    await send(ws, {"type": "error", "task_id": task_id,
                                    "error": f"vllm {r.status}: {txt}"})
                    return _ERR
                async for raw in r.content:
                    line = raw.decode("utf-8", "ignore").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        d = json.loads(data)
                    except Exception:
                        continue
                    if d.get("usage"):
                        usage = d["usage"]
                    ch = d.get("choices") or []
                    if ch:
                        delta = (ch[0].get("delta") or {}).get("content") or ""
                        if delta:
                            item = inflight.get(task_id)
                            if item is not None:
                                item["buffer"].append(delta)
                            counters["chunks"] += 1
                            await send(ws, {"type": "chunk", "task_id": task_id, "delta": delta})
        except asyncio.TimeoutError:
            counters["errors"] += 1
            await send(ws, {"type": "error", "task_id": task_id, "error": "vllm timeout"})
            return _ERR
        except Exception as e:
            counters["errors"] += 1
            await send(ws, {"type": "error", "task_id": task_id, "error": f"{type(e).__name__}: {e}"})
            return _ERR
    return usage or {}


async def handle_task(msg: dict, ws, sem: asyncio.Semaphore):
    tid = msg.get("task_id")
    payload = msg.get("payload") or {}
    if not tid:
        return
    async with sem:
        if tid in completed:
            await send(ws, {"type": "done", "task_id": tid, "usage": completed[tid]})
            return
        counters["tasks"] += 1
        # 重连重发的任务：保留已吐出的 buffer，避免客户端看到重复内容
        item = inflight.setdefault(tid, {"payload": payload, "buffer": [], "done": False})
        item["payload"] = payload
        usage = await call_vllm(payload, tid, ws)
        item["done"] = True
        if usage is _ERR:
            inflight.pop(tid, None)
            return
        completed[tid] = usage
        if len(completed) > 200:
            completed.pop(next(iter(completed)))
        await send(ws, {"type": "done", "task_id": tid, "usage": usage})
        inflight.pop(tid, None)


async def run():
    backoff = 1
    sem = asyncio.Semaphore(MAX_CONCURRENT)
    while True:
        try:
            log(f"connecting {GATEWAY_WS}")
            async with websockets.connect(
                GATEWAY_WS,
                ssl=SSL_CTX if GATEWAY_WS.startswith("wss") else None,
                ping_interval=20,
                ping_timeout=20,
                max_queue=128,
                open_timeout=15,
            ) as ws:
                backoff = 1
                log("connected")
                await send(ws, {"type": "hello", "name": AGENT_NAME})

                pending = [{"task_id": k, "payload": v["payload"], "buffer": v["buffer"]}
                           for k, v in inflight.items() if not v["done"]]
                if pending:
                    log(f"resume {len(pending)} unfinished task(s)")
                    await send(ws, {"type": "resume", "tasks": pending})

                async def reader():
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        typ = msg.get("type")
                        if typ == "task":
                            asyncio.create_task(handle_task(msg, ws, sem))
                        elif typ == "welcome":
                            log(f"welcome agent_id={msg.get('agent_id')}")
                        elif typ == "pong":
                            pass

                async def heartbeat():
                    while True:
                        await asyncio.sleep(LOG_EVERY)
                        await send(ws, {"type": "ping"})
                        log("hb", counters, f"inflight={len(inflight)}")

                await asyncio.gather(reader(), heartbeat())
        except Exception as e:
            counters["reconnects"] += 1
            log(f"disconnected: {type(e).__name__}: {e}  retry in {backoff}s")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 10)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log("bye")
