"""
云端 gateway —— AI 算力池的"店门"

职责（对齐大厂推理网关的最小语义集）：
  1. 鉴权        API Key（Authorization: Bearer / X-API-Key）
  2. 限流        每 key 每分钟 N 次（滑动窗口），超限返回 429 + Retry-After
  3. 幂等        Idempotency-Key 命中已完成任务时直接返回缓存结果
  4. 任务队列    任务进入 queued，派给可用 Agent 后转 streaming
  5. 反连派发    通过 /agent 的 WebSocket 长连接把任务推给本地 Agent
  6. 流式回流    Agent 逐 token 回传，这里转成 SSE 给客户端
  7. 断连恢复    Agent 重连后重发 queued 任务；Agent 可主动 resume 未完成的任务
  8. 指标        /metrics 输出队列深度、并发、限流计数（Prometheus 文本格式）

设计取舍：
  - 队列在内存里，gateway 重启会丢未完成任务的上下文，但 Agent 侧保留了 inflight，
    重连时通过 resume 重建 —— 这就是"任务不丢"的真实实现方式。
  - 单 Agent 优先；多 Agent 时轮询派发（预留，不改代码即可扩）。
"""
import asyncio
import json
import os
import time
import uuid
from collections import defaultdict, deque

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

API_KEYS = [k.strip() for k in os.environ.get("API_KEYS", "sk-ai-pool-2026").split(",") if k.strip()]
RATE_LIMIT = int(os.environ.get("RATE_LIMIT", "60"))
TASK_TIMEOUT = int(os.environ.get("TASK_TIMEOUT", "300"))
RESULT_TTL = int(os.environ.get("RESULT_TTL", "600"))

app = FastAPI(title="ai-pool-gateway", version="1.0.0")

stats = defaultdict(int)


# ---------------------------------------------------------------- 限流
class RateLimiter:
    def __init__(self, limit: int):
        self.limit = limit
        self.hits: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str) -> tuple[bool, int]:
        now = time.time()
        dq = self.hits[key]
        while dq and now - dq[0] > 60:
            dq.popleft()
        if len(dq) >= self.limit:
            return False, int(60 - (now - dq[0])) + 1
        dq.append(now)
        return True, 0


limiter = RateLimiter(RATE_LIMIT)


# ---------------------------------------------------------------- 任务
class Task:
    __slots__ = ("id", "payload", "idem", "chunks", "status", "usage",
                 "error", "created", "done_at", "waiters")

    def __init__(self, tid: str, payload: dict, idem: str | None = None):
        self.id = tid
        self.payload = payload
        self.idem = idem
        self.chunks: list[str] = []
        self.status = "queued"
        self.usage = None
        self.error = None
        self.created = time.time()
        self.done_at = None
        self.waiters: list[asyncio.Event] = []


tasks: dict[str, Task] = {}
by_idem: dict[str, str] = {}


def notify(t: Task) -> None:
    for ev in t.waiters:
        if not ev.is_set():
            ev.set()
    t.waiters.clear()


def gc() -> None:
    now = time.time()
    for tid in list(tasks):
        t = tasks[tid]
        if t.status in ("done", "error") and t.done_at and now - t.done_at > RESULT_TTL:
            tasks.pop(tid, None)
            if t.idem and by_idem.get(t.idem) == tid:
                by_idem.pop(t.idem, None)


# ---------------------------------------------------------------- Agent 连接
agents: dict[str, WebSocket] = {}
agent_lock = asyncio.Lock()
send_lock = asyncio.Lock()
rr_index = 0


async def _send(ws: WebSocket, obj: dict) -> bool:
    async with send_lock:
        try:
            await ws.send_json(obj)
            return True
        except Exception:
            return False


async def dispatch(t: Task) -> bool:
    global rr_index
    async with agent_lock:
        if not agents:
            t.status = "queued"
            return False
        items = list(agents.items())
        aid, ws = items[rr_index % len(items)]
        rr_index += 1
    if await _send(ws, {"type": "task", "task_id": t.id, "payload": t.payload}):
        t.status = "streaming"
        stats["tasks_dispatched"] += 1
        return True
    async with agent_lock:
        agents.pop(aid, None)
    t.status = "queued"
    return False


async def redispatch_all() -> None:
    for t in list(tasks.values()):
        if t.status == "queued":
            await dispatch(t)


# ---------------------------------------------------------------- 鉴权
def auth(request: Request) -> str:
    raw = request.headers.get("authorization", "")
    key = raw[7:].strip() if raw.lower().startswith("bearer ") else ""
    key = key or request.headers.get("x-api-key", "").strip()
    if not key:
        stats["auth_missing"] += 1
        raise HTTPException(status_code=401, detail="missing api key")
    if key not in API_KEYS:
        stats["auth_invalid"] += 1
        raise HTTPException(status_code=401, detail="invalid api key")
    return key


def err(msg: str, typ: str, code: int = 400) -> JSONResponse:
    return JSONResponse({"error": {"message": msg, "type": typ}}, status_code=code)


# ---------------------------------------------------------------- 端点
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "agents": len(agents),
        "tasks": len(tasks),
        "queued": sum(1 for t in tasks.values() if t.status == "queued"),
        "streaming": sum(1 for t in tasks.values() if t.status == "streaming"),
    }


@app.get("/metrics")
async def metrics():
    q = sum(1 for t in tasks.values() if t.status == "queued")
    s = sum(1 for t in tasks.values() if t.status == "streaming")
    lines = [
        "# HELP gateway_agents_connected connected agent count",
        "# TYPE gateway_agents_connected gauge",
        f"gateway_agents_connected {len(agents)}",
        "# HELP gateway_queue_depth tasks waiting for an agent",
        "# TYPE gateway_queue_depth gauge",
        f"gateway_queue_depth {q}",
        "# HELP gateway_streaming_tasks tasks currently streaming",
        "# TYPE gateway_streaming_tasks gauge",
        f"gateway_streaming_tasks {s}",
    ]
    for k, v in sorted(stats.items()):
        lines += [
            f"# TYPE gateway_{k}_total counter",
            f"gateway_{k}_total {v}",
        ]
    return PlainTextResponse("\n".join(lines) + "\n")


def full_response(t: Task, model: str, idem_hit: bool = False) -> dict:
    return {
        "id": t.id,
        "object": "chat.completion",
        "created": int(t.created),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "".join(t.chunks)},
            "finish_reason": "stop",
        }],
        "usage": t.usage or {},
        "gateway": {"idempotent_hit": idem_hit},
    }


@app.post("/v1/chat/completions")
async def chat(request: Request):
    key = auth(request)
    allowed, retry = limiter.allow(key)
    if not allowed:
        stats["rate_limited"] += 1
        return JSONResponse(
            {"error": {"message": "rate limit exceeded", "type": "rate_limit_error"}},
            status_code=429,
            headers={"Retry-After": str(retry)},
        )

    try:
        body = await request.json()
    except Exception:
        return err("invalid json body", "invalid_request_error")

    model = body.get("model") or "qwen"
    stream = bool(body.get("stream"))
    idem = request.headers.get("idempotency-key")

    gc()
    if idem and idem in by_idem:
        old = tasks.get(by_idem[idem])
        if old and old.status == "done":
            stats["idempotent_hits"] += 1
            return JSONResponse(full_response(old, model, idem_hit=True))

    tid = "task-" + uuid.uuid4().hex[:16]
    t = Task(tid, body, idem)
    tasks[tid] = t
    if idem:
        by_idem[idem] = tid
    stats["requests_total"] += 1

    # 没有可用 Agent 时不要把请求打回去，而是留在队列里等 —— 这是"任务不丢"的前提。
    # 客户端（SSE）会挂在那里等，Agent 重连后自动续上。
    if await dispatch(t):
        stats["tasks_dispatched"] += 1
    else:
        stats["tasks_queued"] += 1

    if stream:
        return StreamingResponse(
            sse(t, model),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    ev = asyncio.Event()
    t.waiters.append(ev)
    try:
        await asyncio.wait_for(ev.wait(), TASK_TIMEOUT)
    except asyncio.TimeoutError:
        t.status = "error"
        t.error = "task timeout"
        t.done_at = time.time()
        return err("task timeout", "timeout_error", 504)

    if t.status == "error":
        return err(t.error or "agent error", "upstream_error", 502)
    return JSONResponse(full_response(t, model))


async def sse(t: Task, model: str):
    idx = 0
    deadline = t.created + TASK_TIMEOUT
    yield ": connected\n\n"
    while True:
        while idx < len(t.chunks):
            delta = t.chunks[idx]
            idx += 1
            chunk = {
                "id": t.id, "object": "chat.completion.chunk",
                "created": int(t.created), "model": model,
                "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
        if t.status == "done":
            end = {
                "id": t.id, "object": "chat.completion.chunk",
                "created": int(t.created), "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": t.usage or {},
            }
            yield f"data: {json.dumps(end, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return
        if t.status == "error":
            yield f"data: {json.dumps({'error': {'message': t.error}}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return
        if time.time() > deadline:
            t.status = "error"
            t.error = "task timeout"
            yield f"data: {json.dumps({'error': {'message': 'task timeout'}}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return
        await asyncio.sleep(0.02)


@app.websocket("/agent")
async def agent_ws(ws: WebSocket):
    await ws.accept()
    aid = "agent-" + uuid.uuid4().hex[:8]
    async with agent_lock:
        agents[aid] = ws
    stats["agent_connects"] += 1
    try:
        await _send(ws, {"type": "welcome", "agent_id": aid, "task_timeout": TASK_TIMEOUT})
        async with agent_lock:
            queued = [t for t in tasks.values() if t.status == "queued"]
        for t in queued:
            if await _send(ws, {"type": "task", "task_id": t.id, "payload": t.payload}):
                t.status = "streaming"

        while True:
            msg = await ws.receive_json()
            typ = msg.get("type")
            tid = msg.get("task_id")

            if typ == "chunk":
                t = tasks.get(tid)
                if t:
                    t.chunks.append(msg.get("delta", ""))
                    t.status = "streaming"
                    notify(t)
            elif typ == "done":
                t = tasks.get(tid)
                if t:
                    t.status = "done"
                    t.usage = msg.get("usage")
                    t.done_at = time.time()
                    stats["tasks_done"] += 1
                    notify(t)
            elif typ == "error":
                t = tasks.get(tid)
                if t:
                    t.status = "error"
                    t.error = msg.get("error", "agent error")
                    t.done_at = time.time()
                    stats["tasks_failed"] += 1
                    notify(t)
            elif typ == "resume":
                stats["agent_resumes"] += 1
                for item in msg.get("tasks", []):
                    rid = item.get("task_id")
                    if not rid:
                        continue
                    t = tasks.get(rid)
                    if t is None:
                        t = Task(rid, item.get("payload", {}))
                        t.chunks = list(item.get("buffer", []))
                        tasks[rid] = t
                    t.status = "streaming"
                    await _send(ws, {"type": "task", "task_id": rid, "payload": t.payload})
            elif typ == "ping":
                await _send(ws, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with agent_lock:
            agents.pop(aid, None)
        stats["agent_disconnects"] += 1
        # 断连的 Agent 手上的任务退回队列，等下一个 Agent（或它自己重连）
        for t in tasks.values():
            if t.status == "streaming" and not t.chunks:
                t.status = "queued"
        asyncio.create_task(redispatch_all())
