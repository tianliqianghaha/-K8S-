# 运维日常 SOP · 每天真正会做的动作

> 这套实验台的价值不在于"跑过实验"，而在于**能像运维一个真实集群那样运维它**。
> 下面五个动作覆盖一个网络运维 90% 的日常：巡检、变更、故障、交接、复盘。

---

## 一、班前巡检（5 分钟）

```bash
# 三台各跑一次，看结论行
sudo ./bin/80-daily.sh
# 只想贴到群里
sudo ./bin/80-daily.sh --brief
```

看什么，以及看到之后做什么：

```
FAIL 根分区 > 85%        立刻清 /var/lib/hpnlab 里的 pcap，别等写满
FAIL 接口不是 UP         先看云控制台，可能是实例被回收前兆
FAIL 没有全局 IPv6       查 ENI 的 IPv6 是否还在（重开机后偶发）
WARN rx_errors > 0       虚拟网卡异常或上游抖动，抓 10 秒包看特征
WARN 邻居 INCOMPLETE     ICMPv6 被安全组挡了，或对端没起
WARN 队列有 netem/tbf    上次实验没清理，先 fault clear 再交接
WARN 策略路由 < 2 条     a 上的双平面选路丢了，重跑 hpnlab up
```

**判定标准**：全部 `ok` 才能交接；有 `WARN` 要写明原因和处理人。

---

## 二、变更流程（任何改配置的动作都算）

### 2.1 五步法

```
① 申请    写清：改什么、为什么、影响哪条路径、回滚方式
② 预检    改之前先记录现状（快照），并确认能回滚
③ 执行    一次只改一个变量，改完立刻验证
④ 验证    hpnlab verify + 关键业务指标（rtt / 吞吐 / 丢包）
⑤ 观察    至少 5 分钟，确认没有延迟出现的退化
```

### 2.2 变更前必须留下的三样东西

```bash
cd /opt/hpn-v6-lab3

# 1) 现状快照（路由/规则/队列/计数）
sudo ./bin/hpnlab snap

# 2) 配置基线（文本，便于 diff）
ip -6 route show > /var/lib/hpnlab/change-pre-routes.txt
ip -6 rule  show > /var/lib/hpnlab/change-pre-rules.txt
tc qdisc show    > /var/lib/hpnlab/change-pre-qdisc.txt

# 3) 健康基线
sudo ./bin/hpnlab rtt 200 | tee /var/lib/hpnlab/change-pre-rtt.txt
```

### 2.3 变更记录模板（复制到工单里）

```
变更编号：CHG-YYYYMMDD-NN
目标节点：hpn1(a) / hpn2(b) / hpn3(c)
变更内容：一句话
变更原因：一句话（关联哪个故障/需求）
影响范围：哪条平面 / 哪类流量 / 是否影响管理面
预检结果：verify 通过 N 项，基线 p99 = X ms
执行命令：（原样贴）
验证结果：verify 通过 N 项，p99 = Y ms，变化 +Z%
回滚方式：sudo ./bin/hpnlab down && sudo ./bin/hpnlab up
          （或具体到某条 ip route / tc 命令）
观察期：5 分钟，期间无告警
执行人 / 时间：
```

### 2.4 高危动作清单（做之前必须两人确认）

```
├─ tc qdisc del dev eth0 root       会瞬间恢复默认队列，可能引起突发
├─ ip -6 route del 后不 replace     路由空洞，业务直接断
├─ 改 VPC 路由表条目                影响整个子网，不只是本实验台
├─ 关 SourceDestCheck               安全边界变化，实验结束要评估是否恢复
└─ 重启实例                          拓扑与 sysctl 全丢，必须重跑 up
```

---

## 三、故障处置（五步定位法）

```
Step 1  定性：是"断"还是"慢"还是"抖"
        ├─ ping 不通       → 断
        ├─ ping 通但吞吐低 → 慢（灰故障）
        └─ p99 高而均值正常 → 抖（排队）

Step 2  定层：从下往上，一层层确认，不要跳
        物理/邻居 → 地址 → 路由 → 策略 → 封装 → 队列 → 抓包 → 计数
        （对应命令见 docs/03 末尾的"排障顺序"）

Step 3  定点：二分
        ├─ 分段 ping：先到 c 的 SID，再到 b 的业务地址
        └─ 差值变大 → 问题在 c 之后那一跳

Step 4  定性根因：查 docs/03 的 15 个案例，对症状
Step 5  处置 + 记录：处置完必须把新案例补进 docs/03
```

### 3.1 三个高频场景的一分钟处置

```
场景 A：业务突然全断
  a: ip -6 route show | grep fcbb        # 外层路由还在吗
  a: ip -6 rule show                     # 策略路由还在吗
  c: sysctl net.ipv6.conf.all.forwarding # 转发开了吗（重启后会丢）
  → 大概率是"重启后没跑 up"，直接 hpnlab up

场景 B：ping 通但吞吐掉一半
  a: tc -s qdisc show dev eth0 | grep -E "dropped|backlog"
  a: ./bin/hpnlab fault list             # 有没有残留注入
  → 有残留就 fault clear；没残留查 rx_errors 与对端 CPU

场景 C：只有平面 0 不通，平面 1 正常
  a: ip -6 route show fcbb:bb00:2::/48   # 这条最容易被 fault clear 误删
  c: ip -6 route show fcbb:bb00:2::/48   # c 的 uN 还在吗
  → 缺哪条补哪条；c 上重启过就要重跑 up
```

---

## 四、交接班（每班一次，5 分钟）

### 4.1 交接模板

```
【HPN-3 实验台 交接单】
时间：2026-MM-DD HH:MM    交班：___    接班：___

一、当前状态
  巡检结论：ok=__ warn=__ fail=__
  拓扑状态：up / down（三台是否一致：是/否）
  残留注入：无 / 有（具体：netem loss 1% @ a）

二、本班做过的事
  1. （命令 + 结果一句话）
  2.

三、未完成 / 待跟进
  1. （谁在等什么）

四、风险提示
  ├─ 实例自动释放时间：2026-11-25 23:04
  ├─ 抢占式实例随时可能被回收，重要数据是否已落盘：是/否
  └─ 是否有配置漂移未回滚：无/有
```

### 4.2 交接前必须做的三件事

```bash
# 1) 清残留（最容易被忘）
sudo ./bin/hpnlab fault clear

# 2) 三台状态一致
for h in a b c; do echo "== $h"; done   # 分别执行 ./bin/hpnlab status

# 3) 数据落盘
ls -lh /var/lib/hpnlab/obs/ | tail -5
```

---

## 五、周复盘（每周一次，30 分钟）

### 5.1 三个必看指标

```
├─ 故障次数与平均定位时长（MTTD）
│   └─ 目标：从"靠猜"到"5 分钟内定层"
├─ 配置漂移次数
│   └─ 每次 diff 出差异都记一笔，看是不是同一类操作反复出错
└─ 实验完成度
    └─ 40 个实验里这周推进了几个（对照 docs/05 的索引）
```

### 5.2 复盘要产出的东西

```
1. 新故障案例（补进 docs/03，格式：症状/判据/根因/处置）
2. 新脚本或脚本修正（凡是手工重复三次以上的，写成脚本）
3. 一条"下次不再犯"的检查项（加到 80-daily.sh 里）
```

---

## 六、常用命令速查

```
# 状态
./bin/hpnlab status          三台拓扑状态
./bin/hpnlab verify          断言式验收
ip -6 route show fcbb        只看实验相关路由
ip -6 rule show              策略路由
tc -s qdisc show dev eth0    队列与丢弃

# 观测
./bin/hpnlab rtt 200         时延分布
./bin/hpnlab watch 30 1      逐秒采样
./bin/hpnlab snap            快照
./bin/hpnlab stats           协议栈计数

# 故障
./bin/hpnlab fault list      可用故障与当前状态
./bin/hpnlab fault inject loss 1
./bin/hpnlab fault clear     清理（只清自己注入的）

# 业务
./bin/hpnlab send/recv       多路径原型
./bin/hpnlab coll run ...    集合通信流量
./bin/hpnlab qos up|test      QoS 分级
```

---

## 七、这套 SOP 想训练的东西

```
不是"会敲命令"，而是：
├─ 接班先看状态，不等告警
├─ 改之前先能回滚
├─ 故障先定层，不猜
├─ 处置完必留案例
└─ 重复三次以上的手工动作，变成脚本
```
