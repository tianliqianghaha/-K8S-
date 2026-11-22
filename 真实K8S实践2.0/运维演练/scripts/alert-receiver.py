#!/usr/bin/env python3
"""极简告警落点：按路径分 P1/P2/P3 写文件，用于验证 Alertmanager 路由。"""
import json, os, time
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = "/data/alerts"

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8", "replace")
        lvl = self.path.strip("/") or "unknown"
        os.makedirs(OUT, exist_ok=True)
        with open(f"{OUT}/{lvl}.log", "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.strftime("%F %T"), "body": json.loads(body) if body.startswith("{") else body}, ensure_ascii=False) + "\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def log_message(self, *a):
        pass

HTTPServer(("0.0.0.0", 8088), H).serve_forever()
