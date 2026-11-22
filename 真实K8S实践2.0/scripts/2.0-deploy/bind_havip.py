"""把 HAVIP 绑到 3 台控制面（幂等：已绑的跳过）。"""
import sys
sys.path.insert(0, ".")
import cloud

import fleet

HAVIP = fleet.HAVIP_ID
ids = {h[0]: h[4] for h in fleet.masters()}

for name in ("cp-1", "cp-2", "cp-3"):
    iid = ids[name]
    try:
        r = cloud.call("AssociateHaVip", {
            "HaVipId": HAVIP, "InstanceId": iid, "InstanceType": "EcsInstance",
        }, svc="vpc")
        print(f"{name} {iid} -> associated (RequestId={r.get('RequestId')})")
    except cloud.ApiError as exc:
        print(f"{name} {iid} -> {exc.code}: {exc.message}")

p = cloud.call("DescribeHaVips", {"HaVipId": HAVIP}, svc="vpc")
for h in p.get("HaVips", {}).get("HaVip", []):
    inst = h.get("AssociatedInstances", {}).get("associatedInstance", [])
    print("state:", h.get("Status"), "ip:", h.get("IpAddress"),
          "instances:", [i.get("InstanceId") for i in inst])
