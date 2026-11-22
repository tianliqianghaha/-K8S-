"""拉取本次 10 台的权威清单，写 fleet.json。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")
import cloud

IDS = [
    "i-j6cb6kihp7cqtdl0luqa", "i-j6cb6kihp7cqtdl0luqb", "i-j6cb6kihp7cqtdl0luqc",
    "i-j6cdhfgbe8u3rmpww18i", "i-j6cgtuafdh5vkak6g9g3",
    "i-j6cderbtuzq9xewjdsv2", "i-j6cbjjam2ymk5yxqzglm",
    "i-j6c4mhk3f86bzuc8ignd", "i-j6c4sxsmpvad8xn3ntgs", "i-j6c0j83bsp4syim0lb4l",
]

p = cloud.call("DescribeInstances", {"InstanceIds": json.dumps(IDS), "PageSize": 50})
insts = p.get("Instances", {}).get("Instance", [])
print("count =", len(insts))

rows = []
for i in insts:
    disks = i.get("DiskDeviceMappings", {}).get("DiskDeviceMapping", [])
    data = [d for d in disks if d.get("Type") == "data"]
    rows.append({
        "iid": i["InstanceId"],
        "name": i.get("InstanceName"),
        "zone": i["ZoneId"],
        "private": i["VpcAttributes"]["PrivateIpAddress"]["IpAddress"][0],
        "public": (i.get("PublicIpAddress", {}).get("IpAddress") or [""])[0],
        "type": i["InstanceType"],
        "cpu": i["Cpu"], "mem_gb": round(i["Memory"] / 1024),
        "sys_disk": next((d["Size"] for d in disks if d.get("Type") == "system"), None),
        "data_disk": next((d["Size"] for d in data), None),
        "status": i["Status"],
    })

rows.sort(key=lambda r: r["name"])
for r in rows:
    print(f"{r['name']:30s} {r['zone']:15s} {r['private']:15s} {r['public']:15s} "
          f"{r['type']:20s} {r['cpu']}C{r['mem_gb']}G sys={r['sys_disk']} data={r['data_disk']} {r['status']}")

Path("fleet.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print("-> fleet.json")
