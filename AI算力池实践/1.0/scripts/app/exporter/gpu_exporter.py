#!/usr/bin/env python3
"""
GPU 指标导出器 —— DCGM Exporter 的替代品

为什么不用 DCGM：DCGM 需要 nv-hostengine 与特权设备访问，
WSL2 只暴露 /dev/dxg，DCGM 通常起不来。这里用 nvidia-smi 轮询导出同样的指标，
数值是真的，只是采样粒度粗（每次请求时实时取）。

暴露在 :9101/metrics，Prometheus 文本格式。
"""
import http.server
import os
import shutil
import socketserver
import subprocess

QUERY = "name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw"

# WSL 把 nvidia-smi 放在 /usr/lib/wsl/lib 下，systemd 的 PATH 里没有
_CANDIDATES = (
    "/usr/lib/wsl/lib/nvidia-smi",
    "/usr/bin/nvidia-smi",
    "/usr/local/bin/nvidia-smi",
)
NVIDIA_SMI = (
    shutil.which("nvidia-smi")
    or next((p for p in _CANDIDATES if os.path.exists(p)), "nvidia-smi")
)


def collect() -> str:
    try:
        out = subprocess.run(
            [NVIDIA_SMI, f"--query-gpu={QUERY}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout.strip()
    except Exception as e:
        return f"# error: {type(e).__name__} {e}\n"

    rows = []
    for i, line in enumerate(out.splitlines()):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            continue
        name, used, total, util, temp, power = parts[:6]
        lbl = f'{{gpu="{i}",model="{name}"}}'
        rows.append(f"gpu_memory_used_bytes{lbl} {int(float(used)) * 1048576}")
        rows.append(f"gpu_memory_total_bytes{lbl} {int(float(total)) * 1048576}")
        rows.append(f"gpu_utilization_percent{lbl} {util}")
        rows.append(f"gpu_temperature_celsius{lbl} {temp}")
        if power not in ("[N/A]", "[Not Supported]", ""):
            rows.append(f"gpu_power_watts{lbl} {power}")

    header = [
        "# HELP gpu_memory_used_bytes GPU memory in use",
        "# TYPE gpu_memory_used_bytes gauge",
    ]
    return "\n".join(header + rows) + "\n"


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/metrics", "/"):
            self.send_response(404)
            self.end_headers()
            return
        body = collect().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", 9101), Handler) as srv:
        print("gpu-exporter listening on :9101", flush=True)
        srv.serve_forever()
