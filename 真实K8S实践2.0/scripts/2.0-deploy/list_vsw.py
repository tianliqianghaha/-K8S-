"""列出目标 VPC 下所有交换机（只读）。"""
import sys
sys.path.insert(0, ".")
import cloud

VPC = "vpc-j6cudzxincue05yd4tuhy"

p = cloud.call("DescribeVSwitches", {"PageSize": 50}, svc="vpc")
for v in p.get("VSwitches", {}).get("VSwitch", []):
    if v.get("VpcId") == VPC:
        print(v["ZoneId"], v["VSwitchId"], v["CidrBlock"], v.get("VSwitchName"))
print("--- 其他 VPC ---")
for v in p.get("VSwitches", {}).get("VSwitch", []):
    if v.get("VpcId") != VPC:
        print(v["ZoneId"], v["VSwitchId"], v["CidrBlock"], v.get("VpcId"))
