#!/usr/bin/env python3
"""集群外告警接收端（模拟企业微信/钉钉/短信网关的落点）

用途：验证 Alertmanager 分级路由真的把 P1/P2/P3 送到不同出口。
生产替换：把 Alertmanager 的 webhook url 换成真实机器人地址即可，本服务可下线。

端点：
  POST /p1 /p2 /p3   接收各自级别的告警，追加写入 /data/alerts/<level>.log
  GET  /dump         返回三个级别的累计条数与最后一条
  GET  /healthz      存活探针
"""
import json
import pathlib
import http.server
import socketserver

DATA = pathlib.Path("/data/alerts")
DATA.mkdir(parents=True, exist_ok=True)
LEVELS = ("p1", "p2", "p3")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "alert-receiver/1.0"

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        level = self.path.strip("/").split("/")[0] or "unknown"
        if level not in LEVELS:
            self._json({"error": "unknown level"}, 404)
            return
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n)
        try:
            payload = json.loads(raw)
            alerts = payload.get("alerts", [])
            names = [a.get("labels", {}).get("alertname") for a in alerts]
        except Exception:
            names = ["<unparsable>"]
        with open(DATA / f"{level}.log", "a", encoding="utf-8") as f:
            f.write(raw.decode(errors="replace") + "\n")
        print(f"[{level}] received {len(names)} alert(s): {names}", flush=True)
        self._json({"status": "ok", "level": level, "count": len(names)})

    def do_GET(self):
        if self.path.startswith("/healthz"):
            self._json({"status": "up"})
            return
        if self.path.startswith("/dump"):
            out = {}
            for lv in LEVELS:
                f = DATA / f"{lv}.log"
                raw = f.read_text(encoding="utf-8").splitlines() if f.exists() else []
                lines = [ln for ln in raw if ln.strip()]
                last = None
                if lines:
                    try:
                        last = json.loads(lines[-1])
                    except json.JSONDecodeError:
                        last = {"unparsable": lines[-1][:200]}
                out[lv] = {"count": len(lines), "last": last}
            self._json(out)
            return
        self._json({"endpoints": ["/p1", "/p2", "/p3", "/dump", "/healthz"]})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", 8088), Handler) as httpd:
        print("alert-receiver listening on :8088", flush=True)
        httpd.serve_forever()
