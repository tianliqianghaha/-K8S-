"""把 10 台从裸机推到「装好 containerd + kubeadm 三件套」。

流程：密码登录 -> 注入公钥 -> 推 /etc/hosts 与 s1 脚本 -> base -> kernel -> runtime -> k8s -> 挂数据盘
并发 10 台，日志落 s1/logs/<host>.log。
"""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import paramiko

WORK = Path(__file__).resolve().parent
KEY = Path(r"C:\Users\520\WorkBuddy\2026-11-20-09-30-05\k8s-deploy\id_k8s")
PUB = Path(r"C:\Users\520\WorkBuddy\2026-11-20-09-30-05\k8s-deploy\id_k8s.pub")
CREDS = Path(r"C:\Users\520\.workbuddy\skills\aliyun-ecs-one-liner\state\credentials")
LOGS = WORK / "s1" / "logs"
LOGS.mkdir(parents=True, exist_ok=True)

# 角色 -> (云实例名, 数据盘挂载点或 None)
ROLES = {
    "i-j6cb6kihp7cqtdl0luqa": ("cp-1", None),
    "i-j6cb6kihp7cqtdl0luqb": ("cp-2", None),
    "i-j6cb6kihp7cqtdl0luqc": ("cp-3", None),
    "i-j6cderbtuzq9xewjdsv2": ("wk-1", "/var/lib/longhorn"),
    "i-j6cdhfgbe8u3rmpww18i": ("wk-2", "/var/lib/longhorn"),
    "i-j6cbjjam2ymk5yxqzglm": ("wk-3", "/var/lib/longhorn"),
    "i-j6cgtuafdh5vkak6g9g3": ("wk-4", "/var/lib/longhorn"),
    "i-j6c4mhk3f86bzuc8ignd": ("wk-5", "/var/lib/longhorn"),
    "i-j6c4sxsmpvad8xn3ntgs": ("infra-01", "/data"),
    "i-j6c0j83bsp4syim0lb4l": ("spare-01", "/data"),
}

VIP = "172.23.163.97"


def build_hosts(fleet):
    name_of = {r["iid"]: ROLES[r["iid"]][0] for r in fleet}
    lines = ["127.0.0.1 localhost", ""]
    for iid, name in sorted(name_of.items(), key=lambda kv: kv[1]):
        ip = next(r["private"] for r in fleet if r["iid"] == iid)
        lines.append(f"{ip} {name}")
    lines += [f"{VIP} api-vip", ""]
    return "\n".join(lines)


def read_password(cloud_name: str) -> str:
    for cand in (f"{cloud_name}.txt", "k8s-cp-[1,2].txt"):
        p = CREDS / cand
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.startswith("password="):
                    return line.split("=", 1)[1].strip()
    raise RuntimeError(f"找不到 {cloud_name} 的口令文件")


def connect_with_password(host, password):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, 22, "root", password, timeout=25,
              allow_agent=False, look_for_keys=False, banner_timeout=30)
    return c


def connect_with_key(host):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, 22, "root", key_filename=str(KEY), timeout=25,
              allow_agent=False, look_for_keys=False, banner_timeout=30)
    return c


def run(client, cmd, timeout=1800):
    _i, out, err = client.exec_command(cmd, timeout=timeout, get_pty=False)
    rc = out.channel.recv_exit_status()
    return rc, (out.read().decode(errors="replace") + err.read().decode(errors="replace")).strip()


def push(client, local: Path, remote: str):
    sftp = client.open_sftp()
    sftp.put(str(local), remote)
    sftp.close()


def bootstrap(fleet_row, hosts_txt, results, lock):
    iid = fleet_row["iid"]
    host, mount = ROLES[iid]
    pub_ip, cloud_name = fleet_row["public"], fleet_row["name"]
    log = []

    def say(msg):
        log.append(msg)
        print(f"[{host}] {msg}", flush=True)

    try:
        # 1) 注入公钥
        pw = read_password(cloud_name)
        c = connect_with_password(pub_ip, pw)
        pub = PUB.read_text(encoding="utf-8").strip()
        run(c, "mkdir -p /root/.ssh && chmod 700 /root/.ssh && "
               f"grep -qxF '{pub}' /root/.ssh/authorized_keys 2>/dev/null || echo '{pub}' >> /root/.ssh/authorized_keys; "
               "chmod 600 /root/.ssh/authorized_keys; mkdir -p /root/s1")
        c.close()
        say("公钥已注入")

        c = connect_with_key(pub_ip)
        sftp = c.open_sftp()
        for f in ("base.sh", "kernel.sh", "runtime.sh", "k8s.sh", "mount.sh"):
            sftp.put(str(WORK / "s1" / f), f"/root/s1/{f}")
        sftp.close()
        with c.open_sftp() as s:
            with s.file("/tmp/hosts.new", "w") as fh:
                fh.write(hosts_txt)

        for stage, cmd in (
            ("base", f"bash /root/s1/base.sh {host}"),
            ("kernel", "bash /root/s1/kernel.sh"),
            ("runtime", "bash /root/s1/runtime.sh"),
            ("k8s", "bash /root/s1/k8s.sh"),
        ):
            rc, out = run(c, cmd)
            tail = out.strip().splitlines()[-2:]
            say(f"{stage} rc={rc} :: " + " | ".join(tail))
            if rc != 0:
                raise RuntimeError(f"{stage} 失败")

        if mount:
            rc, out = run(c, f"MNT={mount} bash /root/s1/mount.sh")
            say(f"mount rc={rc} :: {out.splitlines()[-1] if out else ''}")
        c.close()
        with lock:
            results[host] = "OK"
    except Exception as exc:  # noqa: BLE001
        say(f"FAILED: {type(exc).__name__}: {exc}")
        with lock:
            results[host] = f"FAIL {exc}"
    finally:
        (LOGS / f"{host}.log").write_text("\n".join(log), encoding="utf-8")


def main():
    fleet = json.loads((WORK / "fleet.json").read_text(encoding="utf-8"))
    hosts_txt = build_hosts(fleet)
    (WORK / "s1" / "hosts.txt").write_text(hosts_txt, encoding="utf-8")
    print(hosts_txt)

    results, lock, threads = {}, threading.Lock(), []
    for row in fleet:
        t = threading.Thread(target=bootstrap, args=(row, hosts_txt, results, lock))
        t.start()
        threads.append(t)
    for t in threads:
        t.join()

    print("\n=== 汇总 ===")
    for k in sorted(results):
        print(f"{k:10s} {results[k]}")


if __name__ == "__main__":
    main()
