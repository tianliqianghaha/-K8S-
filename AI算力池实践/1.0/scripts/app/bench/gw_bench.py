import json, time, threading, urllib.request, statistics, ssl

URL = "https://47.238.160.73:31154/v1/chat/completions"
KEY = "sk-ai-pool-2026"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
PROMPT = "请用大约八十个字说明为什么需要给显卡散热，涉及功耗和温度。"
OUT = "/mnt/c/Users/520/AppData/Local/Temp/gw-bench.txt"

lines = []
def log(s):
    print(s, flush=True)
    lines.append(s)

def one(results, max_tokens=80):
    body = json.dumps({
        "model": "qwen",
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {KEY}",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180, context=CTX) as r:
            d = json.loads(r.read())
        toks = (d.get("usage") or {}).get("completion_tokens") or 0
        results.append((time.time() - t0, toks, None))
    except urllib.error.HTTPError as e:
        results.append((time.time() - t0, 0, f"HTTP {e.code}"))
    except Exception as e:
        results.append((time.time() - t0, 0, type(e).__name__))

def pct(vals, p):
    if not vals: return 0.0
    s = sorted(vals)
    return s[max(0, min(len(s) - 1, int(round(p / 100.0 * (len(s) - 1)))))]

def main():
    log("=== 经云端 gateway 全链路压测（HTTPS + 鉴权 + WS 反连）===")
    log("")
    log("并发 | 总耗时 | 平均延迟 | P95延迟 | 完成/失败")
    log("-----|--------|----------|---------|----------")
    for conc in [1, 4, 8, 16]:
        results = []
        ths = [threading.Thread(target=one, args=(results,)) for _ in range(conc)]
        t0 = time.time()
        for t in ths: t.start()
        for t in ths: t.join()
        wall = time.time() - t0
        ok = [r for r in results if r[2] is None]
        bad = [r for r in results if r[2] is not None]
        lat = [r[0] for r in ok]
        log(f"{conc:>4} | {wall:5.2f}s | {statistics.mean(lat) if lat else 0:7.2f}s | {pct(lat,95):6.2f}s | {len(ok)}/{len(bad)}")
        if bad:
            log(f"      失败原因: {bad[0][2]}")
        time.sleep(2)

    log("")
    log("=== 限流验证（配额 60/分钟，继续打轻请求）===")
    got429 = 0
    for i in range(40):
        results = []
        one(results, max_tokens=2)
        if results[0][2] and "429" in str(results[0][2]):
            got429 += 1
            if got429 == 1:
                log(f"  第 {i+1} 次连续轻请求触发 429 限流 ✓")
        elif got429 and got429 < 3:
            log(f"  第 {i+1} 次仍被限流")
    log(f"  共触发 429: {got429} 次")
    log("")
    log("DONE")

try:
    main()
except Exception as e:
    log(f"FATAL {e}")
finally:
    with open(OUT, "w") as f:
        f.write("\n".join(lines) + "\n")
