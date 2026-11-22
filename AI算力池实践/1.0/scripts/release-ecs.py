import sys, time
sys.path.insert(0, '/mnt/c/Users/520/.workbuddy/skills/aliyun-ecs-one-liner/scripts')
import aliyun_rpc as rpc

rpc.load_credentials()

INSTANCE = 'i-j6ccwtdcvplwq4z4z88d'
REGION = 'cn-hongkong'

print("=== 释放前状态 ===")
try:
    r = rpc.call('DescribeInstances', {'RegionId': REGION, 'InstanceIds': f'["{INSTANCE}"]'})
    items = (r.get('Instances') or {}).get('Instance') or []
    if not items:
        print("  实例已不存在")
        sys.exit(0)
    i = items[0]
    print(f"  {i['InstanceId']}  {i.get('InstanceName')}  status={i['Status']}  ip={i.get('PublicIpAddress',{}).get('IpAddress')}")
except Exception as e:
    print("  查询失败:", str(e)[:200])

print("")
print("=== 执行释放（Force，抢占实例删除即释放）===")
try:
    r = rpc.call('DeleteInstance', {
        'RegionId': REGION,
        'InstanceId': INSTANCE,
        'Force': 'true',
    })
    print("  OK  RequestId=", r.get('RequestId', ''))
except Exception as e:
    msg = str(e)
    print("  失败:", msg[:300])
    sys.exit(1)

print("")
print("=== 等待状态变为 Released ===")
for n in range(12):
    time.sleep(5)
    try:
        r = rpc.call('DescribeInstances', {'RegionId': REGION, 'InstanceIds': f'["{INSTANCE}"]'})
        items = (r.get('Instances') or {}).get('Instance') or []
        if not items:
            print(f"  t={n*5}s  实例已消失（释放完成）")
            break
        print(f"  t={n*5}s  status={items[0]['Status']}")
    except Exception as e:
        print(f"  t={n*5}s  查询异常: {str(e)[:100]}")

print("")
print("=== 确认剩余实例 ===")
try:
    r = rpc.call('DescribeInstances', {'RegionId': REGION, 'PageSize': '50'})
    items = (r.get('Instances') or {}).get('Instance') or []
    print(f"  当前香港地域实例数: {len(items)}")
    for i in items:
        print(f"    {i['InstanceId']}  {i.get('InstanceName')}  {i['Status']}")
except Exception as e:
    print("  查询失败:", str(e)[:200])
