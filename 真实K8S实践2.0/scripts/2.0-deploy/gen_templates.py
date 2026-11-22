"""从技能模板派生 8 份分组模板（不碰凭据，只改区域/规格/盘/命名）。"""
import copy
import json
from pathlib import Path

SKILL = Path(r"C:\Users\520\.workbuddy\skills\aliyun-ecs-one-liner\assets")
OUT = Path(__file__).resolve().parent / "tpl"
OUT.mkdir(exist_ok=True)

base_master = json.loads((SKILL / "hk-k8s-master.template.json").read_text(encoding="utf-8"))
base_worker = json.loads((SKILL / "hk-k8s-worker.template.json").read_text(encoding="utf-8"))
base_infra = json.loads((SKILL / "hk-infra.template.json").read_text(encoding="utf-8"))

# 名字, 基模板, 可用区, 规格, 台数, 数据盘G, 命名前缀, 角色标签
PLAN = [
    ("cp",      base_master, "cn-hongkong-c", "ecs.e-c1m2.xlarge",  3, None, "k8s-cp",      "control-plane", "k8s-cp-[1,2]"),
    ("wk-d-u1", base_worker, "cn-hongkong-d", "ecs.u1-c1m4.xlarge", 1, 150,  "k8s-wkd1",    "worker",        None),
    ("wk-d-e",  base_worker, "cn-hongkong-d", "ecs.e-c1m2.xlarge",  1, 150,  "k8s-wkd2",    "worker",        None),
    ("wk-b-u1", base_worker, "cn-hongkong-b", "ecs.u1-c1m4.xlarge", 1, 150,  "k8s-wkb1",    "worker",        None),
    ("wk-b-e",  base_worker, "cn-hongkong-b", "ecs.e-c1m2.xlarge",  1, 150,  "k8s-wkb2",    "worker",        None),
    ("wk-c-e",  base_worker, "cn-hongkong-c", "ecs.e-c1m2.xlarge",  1, 150,  "k8s-wkc1",    "worker",        None),
    ("infra",   base_infra,  "cn-hongkong-c", "ecs.e-c1m2.xlarge",  1, 200,  "infra-01",    "infra-external", None),
    ("spare",   base_infra,  "cn-hongkong-d", "ecs.e-c1m2.xlarge",  1, 100,  "spare-01",    "spare-drill",   None),
]

for key, base, zone, itype, amount, data, prefix, role, pattern in PLAN:
    tpl = copy.deepcopy(base)
    tpl["template_name"] = f"hk-spot-{key}"
    tpl["region"]["zone_id"] = zone
    tpl["instance"]["instance_type"] = itype
    tpl["instance"]["amount"] = amount
    tpl["instance"]["instance_name_prefix"] = prefix
    if pattern:
        tpl["instance"]["ordered_name_pattern"] = pattern
    else:
        tpl["instance"].pop("ordered_name_pattern", None)
    # 数据盘：SSD 云盘（PL1），不是 ESSD Entry —— Longhorn 三副本 rebuild 要随机 IO
    if data:
        tpl["disks"]["data_disk"] = {
            "category": "cloud_essd",
            "size": data,
            "delete_with_instance": True,
        }
    else:
        tpl["disks"]["data_disk"] = None
    # 自动释放 72 小时（防忘关烧钱，需要更久就改这个数）
    tpl["lifecycle"]["max_lifetime_hours"] = 72
    tpl["tags"] = {
        "project": "k8s-advanced-practice",
        "role": role,
        "created_by": "aliyun-ecs-one-liner",
        "zone": zone,
    }
    path = OUT / f"{key}.json"
    path.write_text(json.dumps(tpl, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{path.name:16s} {zone}  {itype:20s} x{amount}  data={data}")
