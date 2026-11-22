"""S2-A：部署 haproxy + keepalived（HAVIP 单播 VRRP），并验证 VIP 归属。"""
import time
import fleet

KEEPALIVED = """global_defs {{
    router_id {router_id}
    script_user root
    enable_script_security
    vrrp_garp_interval 0.001
    vrrp_gna_interval 0.0001
}}

vrrp_script chk_haproxy {{
    script "/etc/keepalived/chk_haproxy.sh"
    interval 2
    weight -30
    fall 3
    rise 2
}}

vrrp_instance VI_APISERVER {{
    state BACKUP
    interface eth0
    virtual_router_id 51
    priority {priority}
    advert_int 1
    unicast_src_ip {src_ip}
    unicast_peer {{
{peers}
    }}
    authentication {{
        auth_type PASS
        auth_pass K8sHaVip2026
    }}
    virtual_ipaddress {{
        {vip}/32 dev eth0
    }}
    track_script {{
        chk_haproxy
    }}
}}
"""

PRIORITY = {"cp-1": 150, "cp-2": 140, "cp-3": 130}


def main():
    masters = fleet.masters()
    peer_ips = [m[2] for m in masters]

    for host in masters:
        name, _cloud, ip = host[0], host[1], host[2]
        peers = "\n".join(f"        {p}" for p in peer_ips if p != ip)
        conf = KEEPALIVED.format(router_id=name, priority=PRIORITY[name],
                                 src_ip=ip, peers=peers, vip=fleet.VIP)
        path = fleet.WORK / f"s2-keepalived-{name}.conf"
        path.write_text(conf, encoding="utf-8")

        fleet.scp("s2-haproxy.cfg", "/etc/haproxy/haproxy.cfg", host)
        fleet.scp("s2-chk-haproxy.sh", "/etc/keepalived/chk_haproxy.sh", host)
        fleet.scp(path, "/etc/keepalived/keepalived.conf", host)
        rc, out = fleet.ssh(host, """
chmod +x /etc/keepalived/chk_haproxy.sh
sed -i 's/\\r$//' /etc/haproxy/haproxy.cfg /etc/keepalived/keepalived.conf /etc/keepalived/chk_haproxy.sh
haproxy -c -f /etc/haproxy/haproxy.cfg
systemctl enable --now haproxy >/dev/null 2>&1
systemctl restart haproxy
systemctl enable --now keepalived >/dev/null 2>&1
systemctl restart keepalived
sleep 2
echo "haproxy=$(systemctl is-active haproxy) keepalived=$(systemctl is-active keepalived)"
echo "listening=$(ss -lnt | grep -c ':16443')"
""", timeout=180)
        print(f"[{name}] rc={rc} {out}")

    time.sleep(8)
    print("\n=== VIP 归属与各节点视角 ===")
    for host in masters + fleet.workers():
        rc, out = fleet.ssh(host, f"""
echo "hold=$(ip -4 -o addr show eth0 | grep -c {fleet.VIP})"
ping -c 2 -W 1 {fleet.VIP} >/dev/null 2>&1 && echo "tcp-ping=OK" || echo "tcp-ping=FAIL"
timeout 3 bash -c 'exec 3<>/dev/tcp/{fleet.VIP}/16443' 2>/dev/null && echo "vip16443=OPEN" || echo "vip16443=CLOSED"
""", timeout=60)
        print(f"  {host[0]:6s} {out.replace(chr(10), ' ')}")


if __name__ == "__main__":
    main()
