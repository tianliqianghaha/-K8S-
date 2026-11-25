# hpn-v6-lab3 · 三节点 IPv6 高性能网络实验台

在一台普通云服务器上做 HPN（AI 高性能网络）实验，最难的从来不是"配不出来"，
而是**配出来了但不知道为什么对、也不知道哪里会错**。

这个实验台只做一件事：把 HPN 的每个设计决定，变成一个**能证伪的实验**。
关掉它，指标必须变差；不关，你就不知道该信哪一条。

```
交付物
├─ conf/lab.env            唯一要改的文件（角色 + 三个地址）
├─ bin/00-preflight.sh     体检：内核/iproute2/地址/连通性
├─ bin/10-probe.sh         探路：云 vSwitch 允许你做什么（最关键的一步）
├─ bin/20-topology.sh      建双平面 uSID 拓扑
├─ bin/30-fault.sh         故障注入（只打实验流量，不断 SSH）
├─ bin/40-observe.sh       观测：时延分布 / 逐秒采样 / 协议栈计数
├─ bin/50-verify.sh        自动验收：每项都是断言，不是"看起来对"
├─ bin/hpnlab              统一入口
├─ app/mrc_lite.py         逐包多路径原型（SO_MARK + 序号 + 乱序统计）
├─ app/collsim.py          集合通信流量模拟（ring/tree/a2a/pipe 四种形状）
├─ app/mrctp.py            MRC/UEC 传输原型（SACK 选择性重传 + 逐包喷洒）
├─ bin/60-qos.sh           QoS 三级分级与带宽保障
├─ bin/80-daily.sh         日常巡检（班前 5 分钟，输出可交接的报告）
└─ docs/
   ├─ 01-设计.md            三约束→三决定、uSID vs SRv6、一个包的逐跳旅程
   ├─ 02-实验手册.md        L0–L9 基础实验
   ├─ 03-运维故障字典.md    21 个真实故障（含工具层自己踩的 5 个）
   ├─ 04-云上部署实录.md    真机部署与四个云平台坑
   ├─ 05-实验体系总览.md    40 个实验 × 12 个能力域 × 8 层
   ├─ 06-实验手册-进阶篇.md 进阶实验逐步命令
   └─ 07-运维日常SOP.md     巡检/变更/故障/交接/复盘 五个日常动作
reports/
└─ 实测数据-2026-11-25.md  真机跑出来的全部数字，每一条都带边界
```

---

## 五分钟上手

```
准备
  三台 Linux（推荐 Ubuntu 24.04，内核 6.8+），同一 VPC、同一子网，
  都分配了 IPv6 地址，安全组放行 ICMPv6 与 UDP 9999。

0) 三台都放同一份代码，改 conf/lab.env
   ROLE="a" / "b" / "c"
   NODE_A_IPV6 / NODE_B_IPV6 / NODE_C_IPV6   三台填一样的

1) 三台都先体检
   sudo ./bin/hpnlab check

2) 三台依次探路（先 c 挂抓包，再 b，最后 a 发包）
   sudo ./bin/hpnlab probe

3) 三台建拓扑
   sudo ./bin/hpnlab up

4) 三台各自验收
   sudo ./bin/hpnlab verify
   （c 上再跑一次 verify capture，同时去 a 上 ping，能看到 uSID 弹栈）

5) 跑第一个真实验
   b 上：sudo ./bin/hpnlab recv --count 2000
   a 上：sudo ./bin/hpnlab send --dst fd00:b0b0::1 --count 2000 --plane both
```

---

## 三条能立刻跑出结论的实验（真机已验证）

```
① 丢包到底多贵（10 分钟）
   a: ./bin/30-fault.sh inject lossport 2 9601     # 只打伤平面 1
   b: setsid nohup python3 -u app/mrctp.py run --role recv --peer <a> --port 9600 --msg-mb 1 &
   a: python3 app/mrctp.py run --role send --peer <b> --port 9600 --port1 9601         --msg-mb 1 --msgs 20 --paths 1 --retx sack --nack on
   看：无丢包 515.8 Mbps → 2% 丢包 13.1 Mbps（塌 40 倍）
   换 --retx gbn 再跑：重传量翻倍（12.17% vs 6.27%）

② 多路径喷洒值不值（10 分钟）
   同上，把 --paths 1 换成 --paths 2
   看：13.1 → 20.2 Mbps（+55%），重传 6.27% → 5.66%
   再试 --paths 2 --retx gbn：重传飙到 20.48%，比不喷还差

③ 小包还是大包（5 分钟）
   三台后台各起一个 rank：
   for r in 0 1 2; do setsid nohup python3 app/collsim.py run --pattern a2a      --rank $r --peers <a>,<b>,<c> --port 12110 --size 1400 --count 200 > /tmp/c$r.json 2>&1 & done
   换 --size 60000 再跑一次
   看：1400 B 时 80 Mbps / 7153 msg/s；60000 B 时 682 Mbps / 1416 msg/s
```

---

## 角色分工（三台机器各管一段）

```
node-a  headend
  把业务包塞进外层 IPv6，路径直接写在目的地址里（无 SRH）
  两条 encap 路由 + fwmark 策略路由 = 端侧选路

node-c  fabric
  唯一做 uSID 弹栈的节点：DA 最左边 16 bit 弹掉，整体左移
  打挂它只影响平面 0，平面 1 完好 —— 这就是故障域隔离的最小实证

node-b  tailend
  收到 DA=block+uDT 的包，解封装，交付给本机协议栈（dummy 口 svc0）
```

`a→b` 直连是平面 1，`a→c→b` 绕行是平面 0。两条路径在 vSwitch 里真实分离。

---

## 三个必须知道的限制

```
1. 两条平面共享 a 的 eth0 出口带宽
   → 只比相对值（一条 vs 两条、开 ECN 前后），不报绝对带宽

2. 没有 PFC、没有 RDMA 网卡、没有 400G
   → 不宣称"复刻了无损"，只证明"丢包的代价"和"拥塞信号的收益"

3. 外层用 ULA（fcbb:bb00::/32），云上要两个额外动作才通
   → 关 ENI 源/目的检查（SourceDestCheck=false）
   → VPC 路由表给每个 ULA 前缀加静态条目（NextHopType=Instance）
   → 实测结论：VPC 内不是二层转发，是按 IPv6 目的地址路由（见 docs/04）
```

---

## 建议的阅读顺序

```
先看 docs/01-设计.md      为什么这么设计（含一个包的逐跳旅程）
再跑 docs/02-实验手册.md  L0→L9，每个 lab 都有"预期现象"
遇故障查 docs/03-运维故障字典.md  症状 → 一条命令判据 → 处置
```

---

## 一句话总结这个实验台在证明什么

> 路径由端侧决定，不由哈希和运气决定；
> 网络故障由端侧绕行，不等控制面收敛；
> 每一层都能被抓包和计数验证，不靠"应该如此"。
