"""本次 10 台的唯一事实源（2026-11-21 重建 · 工作节点跨 3 个可用区）。

控制面 3 台必须在同一交换机/可用区（HAVIP 限制）：cn-hongkong-c。
工作节点打散：b / d / c。
"""
import re
import subprocess
from pathlib import Path

WORK = Path(__file__).resolve().parent
KEY = Path(r"C:\Users\520\WorkBuddy\2026-11-20-09-30-05\k8s-deploy\id_k8s")

# 主机名, 云实例名, 内网IP, 公网IP, 实例ID, 角色
HOSTS = [
    ("cp-1", "k8s-cp-01", "172.23.163.109", "47.86.17.91",   "i-j6cb6kihp7cqtdl0luqa", "control-plane"),
    ("cp-2", "k8s-cp-02", "172.23.163.108", "47.238.231.21", "i-j6cb6kihp7cqtdl0luqb", "control-plane"),
    ("cp-3", "k8s-cp-03", "172.23.163.107", "47.239.14.55",  "i-j6cb6kihp7cqtdl0luqc", "control-plane"),
    ("wk-1", "k8s-wkb1-20261121-001", "172.23.119.116", "47.243.13.7",    "i-j6cderbtuzq9xewjdsv2", "worker"),
    ("wk-2", "k8s-wkd1-20261121-001", "172.23.140.191", "47.238.158.192", "i-j6cdhfgbe8u3rmpww18i", "worker"),
    ("wk-3", "k8s-wkb2-20261121-001", "172.23.119.117", "47.242.14.208",  "i-j6cbjjam2ymk5yxqzglm", "worker"),
    ("wk-4", "k8s-wkd2-20261121-001", "172.23.140.192", "8.218.7.89",     "i-j6cgtuafdh5vkak6g9g3", "worker"),
    ("wk-5", "k8s-wkc1-20261121-001", "172.23.163.110", "47.86.36.195",   "i-j6c4mhk3f86bzuc8ignd", "worker"),
]

INFRA = ("infra-01", "infra-01-20261121-001", "172.23.163.111", "47.86.43.70", "i-j6c4sxsmpvad8xn3ntgs", "infra")
SPARE = ("spare-01", "spare-01-20261121-001", "172.23.140.193", "47.238.68.205", "i-j6c0j83bsp4syim0lb4l", "spare")

VIP = "172.23.163.97"
HAVIP_ID = "havip-j6crlqrs65eu0p9ulankm"
VSWITCH = "vsw-j6c11dksdhw9isjz5eahg"
VPC = "vpc-j6cudzxincue05yd4tuhy"
SECGROUP = "sg-j6cdzcn3nl1ab9vms1k6"
APISERVER_PORT = 16443

# 各节点所在交换机/可用区（写清楚，跨 AZ 调度与排查都靠它）
ZONE = {
    "cp-1": ("cn-hongkong-c", "172.23.163.0/24"),
    "cp-2": ("cn-hongkong-c", "172.23.163.0/24"),
    "cp-3": ("cn-hongkong-c", "172.23.163.0/24"),
    "wk-1": ("cn-hongkong-b", "172.23.112.0/20"),
    "wk-2": ("cn-hongkong-d", "172.23.128.0/20"),
    "wk-3": ("cn-hongkong-b", "172.23.112.0/20"),
    "wk-4": ("cn-hongkong-d", "172.23.128.0/20"),
    "wk-5": ("cn-hongkong-c", "172.23.163.0/24"),
}

WORKERS_MEM = {"wk-1", "wk-2"}   # ecs.u1-c1m4 4C16G


def workers():
    return [h for h in HOSTS if h[5] == "worker"]


def masters():
    return [h for h in HOSTS if h[5] == "control-plane"]


def hosts_block():
    lines = [f"{ip} {name}" for name, _c, ip, _p, _i, _r in HOSTS]
    lines += [f"{INFRA[2]} {INFRA[0]}", f"{SPARE[2]} {SPARE[0]}", f"{VIP} api-vip"]
    return "\n".join(lines) + "\n"


def infra():
    return INFRA


def by_name(name):
    for h in HOSTS:
        if h[0] == name:
            return h
    for h in (INFRA, SPARE):
        if h[0] == name:
            return h
    raise KeyError(name)


def ssh(host, cmd, timeout=900):
    name, _cloud, _ip, pub, _iid, _role = host if isinstance(host, tuple) else by_name(host)
    p = subprocess.run(
        ["ssh", "-i", str(KEY), "-o", "StrictHostKeyChecking=no",
         "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
         "-o", "ConnectTimeout=10", f"root@{pub}", cmd],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )
    return p.returncode, (p.stdout + p.stderr).strip()


def scp(local, remote_path, host):
    name, _cloud, _ip, pub, _iid, _role = host if isinstance(host, tuple) else by_name(host)
    p = subprocess.run(
        ["scp", "-i", str(KEY), "-o", "StrictHostKeyChecking=no",
         "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
         str(local), f"root@{pub}:{remote_path}"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
    )
    return p.returncode, (p.stdout + p.stderr).strip()


def password(role="control-plane"):
    fname = "k8s-cp-[1,2].txt" if role == "control-plane" else "k8s-wkb1-20261121-001.txt"
    txt = Path(r"C:\Users\520\.workbuddy\skills\aliyun-ecs-one-liner\state\credentials") / fname
    return re.search(r"password=(.+)", txt.read_text(encoding="utf-8")).group(1).strip()
