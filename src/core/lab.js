(function (root) {
  'use strict';

  var M = root.TopoModel;

  /*
    X2 故障注入台。
    每个案子是三层：
      现象（作业日志 / 告警 / 监控摘要）→ 取证（X1 终端）→ 根因 + 处置
    判定分两段：根因错 = 0；根因对但处置错 = 半分；两段都对 = 满分。
    理由：查得出来和修得对，是两种能力，不该混成一个对勾。
  */

  function cfgNoNvlink(seed) {
    var cfg = M.generateMachine(seed, 2);
    cfg.nvlink = { enabled: false, links: 0 };
    return cfg;
  }

  function cfgNicsOneNuma(seed) {
    var cfg = M.generateMachine(seed, 2);
    cfg.devices.NIC0.parent = 'S0';
    cfg.devices.NIC1.parent = 'S0';
    return cfg;
  }

  var CASES = [
    {
      id: 'F01',
      plane: 'L1',
      title: '一台机器上的卡少了一张',
      symptom: [
        {
          name: '作业日志',
          text: 'hh:mm:ss  rank 5  NCCL WARN Cuda failure \'an illegal memory access was encountered\'\n' +
            'hh:mm:ss  rank 5  NCCL WARN Call to ibv_reg_mr failed\n' +
            'hh:mm:ss  watchdog: rank 5 timeout after 600s, aborting job'
        },
        { name: '告警', text: '[P1] node-07 GPU 数量异常：期望 8，实际 7（持续 3 分钟）\n[P3] node-07 训练作业 train-9f2 已退出' }
      ],
      world: {
        absent: [5],
        kernel: [
          '[ 8123.441210] NVRM: Xid (PCI:0000:45:00): 79, pid=20481, GPU has fallen off the bus.',
          '[ 8123.442001] nvidia 0000:45:00.0: PCIe Bus Error: severity=Uncorrected',
          '[ 8124.110234] NVRM: GPU 00000000:45:00.0: GPU is lost. Reboot may be required.'
        ]
      },
      cause: {
        q: 'GPU5 从系统里消失，最可能的根因是？',
        options: [
          ['GPU 掉总线：供电瞬断或 PCIe 链路不稳', '正确。XID 79 + PCIe Bus Error + 卡从 nvidia-smi 消失，三者指向物理链路或供电。'],
          ['显存泄漏把进程撑爆了', '不成立。泄漏表现为 OOM，不会让设备从系统里消失。'],
          ['NCCL 版本不兼容', '不成立。版本问题不会导致 total GPU 数量变化。'],
          ['数据集中有坏样本', '不成立。数据问题不会触发 PCIe 总线错误。']
        ], answer: 0
      },
      fix: {
        q: '接下来怎么处置？',
        options: [
          ['把节点标记不可调度，查 BMC 的 SEL 与供电记录，确认后换卡或换基板', '正确。掉总线必须先隔离节点，再看硬件事件，最后才动件。'],
          ['重启机器继续跑，能跑就说明没事', '不成立。掉总线会反复发生，重启只是把问题推迟。'],
          ['调小 batch size 规避', '不成立。与显存压力无关，规避不了。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi', why: '只列出 7 张卡，GPU5 不在表里' },
        { cmd: 'dmesg', why: 'XID 79 与 PCIe Bus Error，指向总线层' },
        { cmd: 'lspci -tv', why: '该卡还在 PCIe 树上，但标注 driver not bound' }
      ],
      knowledge: {
        concept: 'XID 79 = GPU has fallen off the bus，是"设备从 PCIe 总线上掉了"，不是驱动崩溃。',
        pitfall: '看到训练挂就重启，会把硬件故障拖成反复故障。先看 XID，再决定动不动硬件。'
      }
    },

    {
      id: 'F02',
      plane: 'L1',
      title: '训练偶发 NaN，重启就好',
      symptom: [
        {
          name: '作业日志',
          text: 'step 12840  loss 2.317\nstep 12860  loss 2.301\nstep 12880  loss nan\nstep 12900  loss nan\n' +
            'Traceback: RuntimeError: Function AddmmBackward returned an invalid gradient'
        },
        { name: '告警', text: '[P2] node-11 单卡 ECC 异常计数上升（GPU3，过去 1 小时 +3）' }
      ],
      world: {
        gpus: [{ idx: 3, eccDbe: 3, retired: 2 }],
        kernel: [
          '[ 8123.441210] NVRM: Xid (PCI:0000:41:00): 48, pid=20481, Double Bit ECC Error',
          '[ 8123.442001] NVRM: Xid (PCI:0000:41:00): 48, pid=20481, Double Bit ECC Error'
        ]
      },
      cause: {
        q: '偶发 NaN 的根因最可能是？',
        options: [
          ['GPU3 显存出现不可纠正的 ECC 错误，数据被静默损坏', '正确。DBE 是数据已坏且无法纠正，表现为随机数值异常而不是稳定报错。'],
          ['学习率太大导致梯度爆炸', '不成立。梯度爆炸是持续恶化，不会"重启就好"。'],
          ['数据集里有脏样本', '不成立。脏样本在同一份数据上可复现，不会 1% 概率随机出现。'],
          ['框架版本有 bug', '不成立。有 ECC 计数与 XID 48 的直接证据。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['摘除该卡并走 RMA，从最近 checkpoint 重跑；同时把 retired pages 计数纳入巡检', '正确。DBE 意味着这张卡的数据不可信，只能换。'],
          ['关闭 ECC 继续训练', '不成立。关 ECC 只是不报错，数据照样是错的。'],
          ['把学习率降一半观察', '不成立。数值错误的来源不在超参。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi -q', why: 'GPU3 的 Volatile Uncorr. ECC = 3、retired pages = 2' },
        { cmd: 'dmesg', why: 'XID 48 连续出现三次，时间与 NaN 吻合' },
        { cmd: 'nvidia-smi', why: '其余 7 张卡 ECC 全 0，排除整机性问题' }
      ],
      knowledge: {
        concept: 'ECC 分可纠正（SBE）与不可纠正（DBE）。SBE 是预警，DBE 是数据已经错了。',
        pitfall: '把 NaN 当超参问题调。有 DBE 计数时，调参只是在错误的数字上做实验。'
      }
    },

    {
      id: 'F03',
      plane: 'L1',
      title: '卡间通信变慢，偶尔卡死',
      symptom: [
        {
          name: '作业日志',
          text: 'step 9021  iter_time 1.82s  (基线 0.94s)\nstep 9040  iter_time 3.11s\nstep 9055  NCCL WARN Timeout during all-reduce\n' +
            'rank 2  aborting after 600s'
        },
        { name: '告警', text: '[P2] node-04 NVSwitch 端口错误计数增长\n[P3] node-04 单步耗时较基线 +85%' }
      ],
      world: {
        gpus: [{ idx: 2, nvlinkBad: 3, nvlinkCrc: 4312 }],
        kernel: [
          '[ 8044.221001] nvidia-nvswitch: NVSW0 link 11 CRC error threshold reached (count 4312)',
          '[ 8045.002110] NVRM: Xid (PCI:0000:3F:00): 74, pid=20481, NVLink: error 0x1f'
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['GPU2 的 NVLink 链路劣化，CRC 大量重传并触发 XID 74', '正确。CRC 增长 + NVSwitch 端口告警 + XID 74，三点同一件事。'],
          ['网卡带宽不够', '不成立。单步耗时与网卡无关，NVSwitch 已经报了端口错误。'],
          ['显存带宽打满', '不成立。那会让利用率升高而不是报链路错误。'],
          ['NCCL 配置错误', '不成立。配置问题不会产生 NVSwitch 的 CRC 计数。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['先记录计数并把这台机器摘出作业，安排更换基板或链路；不要继续在上面跑长任务', '正确。CRC 增长会先拖慢、再掉链，趁没彻底坏之前换。'],
          ['重启 fabricmanager 清掉计数', '不成立。清计数只是把证据抹掉。'],
          ['把 NCCL 算法从 ring 换成 tree', '不成立。换算法绕不过物理链路劣化。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi nvlink -e', why: 'GPU2 第 3 条链路 CRC 4312，其余为 0' },
        { cmd: 'dmesg', why: 'XID 74 与 NVSwitch 端口阈值告警' },
        { cmd: 'nvidia-smi topo -m', why: '该卡与他卡的关系码从 NV8 掉成 SYS' }
      ],
      knowledge: {
        concept: 'NVLink 有 CRC 校验与重传。计数增长说明链路在劣化，重传吃掉带宽，最终掉链。',
        pitfall: '重启把计数清零，问题被"解决"了但链路还在坏。计数要留档看趋势。'
      }
    },

    {
      id: 'F04',
      plane: 'L1',
      title: '有一张卡只有一半带宽',
      symptom: [
        {
          name: '作业日志',
          text: 'rank 2  step 100  iter_time 1.41s\nrank 3  step 100  iter_time 0.92s\n' +
            'rank 2  D2H copy 3.1 GB/s (同组其他 rank 6.2 GB/s)'
        },
        { name: '告警', text: '[P3] node-02 GPU2 PCIe 链路宽度 x8（期望 x16，LnkCap 仍为 x16）\n[P3] node-02 GPU2 显存带宽与温度正常，SM 利用率 63%' }
      ],
      world: {
        gpus: [{ idx: 2, pcieWidth: 8, pcieGen: 5 }]
      },
      cause: {
        q: '根因是？',
        options: [
          ['该卡只协商到 x8，lane 被其他设备占用或金手指接触不良', '正确。宽度减半直接砍掉一半带宽，与日志里的 3.1 vs 6.2 完全对得上。'],
          ['PCIe 代数从 Gen5 降到 Gen1', '不成立。降代会显示 Link Gen 变化，而这里是宽度 x8。'],
          ['显存带宽不足', '不成立。显存带宽与 PCIe 宽度是两回事。'],
          ['该卡温度过高降频', '不成立。降频影响 SM 频率，不影响链路宽度。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['核对该插槽的 lane 分配，换一个独立 x16 插槽或重插并清洁金手指', '正确。先排分配冲突，再排物理接触。'],
          ['直接换一张新卡', '不成立。没定位就换件，可能换完还是 x8。'],
          ['升级 BIOS 碰运气', '不成立。有明确的链路宽度读数，先按读数处理。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi -q', why: 'GPU2 的 Link Width = 8x，其余 16x' },
        { cmd: 'lspci -tv', why: '该卡 LnkSta 显示 x8，LnkCap 仍是 x16' }
      ],
      knowledge: {
        concept: 'PCIe 链路由"代数 × 宽度"共同决定带宽。Gen5 x8 只有 Gen5 x16 的一半。',
        pitfall: '只看代数不看宽度。x8 的 Gen5 可能比 x16 的 Gen4 还慢。'
      }
    },

    {
      id: 'F05',
      plane: 'L3',
      title: '跨机带宽只有同机的一半',
      symptom: [
        {
          name: '作业日志',
          text: 'NCCL 单机 all-reduce 68 GB/s\nNCCL 跨机 all-reduce 21 GB/s（基线 42 GB/s）\n' +
            'NCCL_DEBUG=INFO  NET/IB : Using [0]mlx5_0:1/IB\n' +
            'NCCL_DEBUG=INFO  NET/IB : Using [1]mlx5_1:1/IB'
        },
        { name: '告警', text: '[P3] 集群跨机带宽较基线下降 50%（过去 2 小时）\n[P3] 同机 all-reduce 正常：66~68 GB/s，与基线一致' }
      ],
      world: {
        config: cfgNicsOneNuma(7),
        nics: [
          { dev: 'mlx5_0', state: 'Active', rate: 400, numa: 0 },
          { dev: 'mlx5_1', state: 'Active', rate: 400, numa: 0 }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['两张网卡都插在 NUMA0，NUMA1 那四张卡每次收发都要过 UPI', '正确。topo 表里 GPU4-7 与 NIC 是 SYS，正好一半的卡吃亏。'],
          ['网卡速率协商到了 200G', '不成立。ibstat 显示 400，且速率减半会让所有卡一起慢。'],
          ['NCCL 只用了 1 张网卡', '不成立。日志里 mlx5_0 与 mlx5_1 都在用。'],
          ['交换机超订比太高', '不成立。超订影响跨 rail，不会恰好是一半的卡。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['把 NIC1 移到 NUMA1 那一路（或按 NUMA 重组 rank），让每张卡都就近', '正确。这是布线问题，改插法最彻底。'],
          ['调大 NCCL_BUFFSIZE', '不成立。缓冲改不了跨 NUMA 的路径。'],
          ['加一台交换机', '不成立。问题在机器内部。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi topo -m', why: 'GPU4-7 与两张网卡全是 SYS，GPU0-3 是 PIX' },
        { cmd: 'ibstat', why: '两张网卡都是 Active 400Gb/s，速率没问题' }
      ],
      knowledge: {
        concept: '8 卡机有两个 NUMA，网卡插哪一路决定了哪些卡"就近"。',
        pitfall: '看到跨机慢就查交换机。先看 topo 表，一半的卡跨 NUMA 是最常见的元凶。'
      }
    },

    {
      id: 'F06',
      plane: 'L3',
      title: '八张网卡只用了一张',
      symptom: [
        {
          name: '作业日志',
          text: 'NCCL_DEBUG=INFO  NET/IB : Using [0]mlx5_0:1/IB\n' +
            'NCCL_DEBUG=INFO  NET/IB : Not using mlx5_1..mlx5_7 (no matching HCA)\n' +
            '跨机 all-reduce 5.1 GB/s（基线 42 GB/s）'
        },
        { name: '告警', text: '[P3] node-08 跨机带宽仅为基线的 12%' }
      ],
      world: {
        nics: [
          { dev: 'mlx5_0', state: 'Active', rate: 400, numa: 0 },
          { dev: 'mlx5_1', state: 'Active', rate: 400, numa: 0 },
          { dev: 'mlx5_2', state: 'Active', rate: 400, numa: 0 },
          { dev: 'mlx5_3', state: 'Active', rate: 400, numa: 0 },
          { dev: 'mlx5_4', state: 'Active', rate: 400, numa: 1 },
          { dev: 'mlx5_5', state: 'Active', rate: 400, numa: 1 },
          { dev: 'mlx5_6', state: 'Active', rate: 400, numa: 1 },
          { dev: 'mlx5_7', state: 'Active', rate: 400, numa: 1 }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['NCCL 默认只挑一张 HCA，需要用 NCCL_IB_HCA 显式列出全部八张', '正确。日志里明写 Not using ... no matching HCA，且 8 张卡都是 Active。'],
          ['七张网卡坏了', '不成立。ibstat 显示八张全是 Active。'],
          ['交换机端口不够', '不成立。端口不够不会表现为"没匹配到 HCA"。'],
          ['光模块不匹配', '不成立。不匹配会 down 或误码。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['在启动脚本里设 NCCL_IB_HCA=mlx5_0,...,mlx5_7，并按 rail 校验实际使用情况', '正确。显式指定 + 事后核对，两步都要做。'],
          ['换更快的网卡', '不成立。网卡已经是 400G。'],
          ['把 NCCL 换成 MPI', '不成立。换库也要配 HCA。']
        ], answer: 0
      },
      chain: [
        { cmd: 'ibstat', why: '八张网卡全部 Active 400Gb/s' },
        { cmd: 'dmesg', why: '内核侧无链路错误，排除硬件' }
      ],
      knowledge: {
        concept: '多网卡机器上，NCCL 的默认选择是保守的：只挑一张。要显式给 NCCL_IB_HCA。',
        pitfall: '把"带宽只有 1/8"当成网络故障查半天。先看 NCCL 的 INFO 日志用了哪几张卡。'
      }
    },

    {
      id: 'F07',
      plane: 'L4',
      title: 'kubectl 全部超时，但容器还在跑',
      symptom: [
        {
          name: '运维终端',
          text: '$ kubectl get nodes\nUnable to connect to the server: dial tcp 10.0.0.12:6443: i/o timeout\n\n' +
            '$ kubectl get pods -n ai\nUnable to connect to the server: net/http: request canceled (Client.Timeout exceeded)'
        },
        { name: '监控', text: 'control-plane-1  CPU 使用率 3%\ncontrol-plane-1  内存使用率 22%\netcd wal_fsync p99 30.4s（基线 0.8ms）' }
      ],
      world: {
        etcd: { fsyncMs: 30412, dbSize: '2.1 GB', leader: true },
        kernel: [
          '[ 9811.220011] etcd: wal: sync took 30.412s (disk may be overloaded)',
          '[ 9815.004421] blk_update_request: I/O error, dev vdb, sector 8842104'
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['etcd 落盘被卡住：云盘 IOPS 打满，控制面写不进去', '正确。CPU 空闲、内存正常、fsync 30 秒——瓶颈在磁盘 IO，不在算力。'],
          ['控制面 CPU 不够', '不成立。监控显示 CPU 3%。'],
          ['内存泄漏导致 OOM', '不成立。内存 22%，也没有 OOM 记录。'],
          ['网络分区', '不成立。同机 etcd 落盘就已经是 30 秒。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['给 etcd 换独立高性能盘，同时查是谁把 IOPS 打满（常见是监控或日志采集），再考虑迁移', '正确。先止血（换盘），再找抢 IO 的人（防止复发）。'],
          ['重启 apiserver', '不成立。重启只清掉等待队列，盘还是慢。'],
          ['扩容控制面副本', '不成立。每个副本都卡在同一类盘上。']
        ], answer: 0
      },
      chain: [
        { cmd: 'etcdctl endpoint status', why: 'wal_fsync p99 30.4 秒，DB 2.1GB' },
        { cmd: 'dmesg', why: 'wal sync 超时 + vdb 的 I/O error' },
        { cmd: 'kubectl get pods', why: '连不上 apiserver，但节点上的容器仍在跑' }
      ],
      knowledge: {
        concept: '控制面假死的第一嫌疑是 etcd 的磁盘，不是 CPU。CPU 空闲 + fsync 暴涨 = IO 瓶颈。',
        pitfall: '看到 kubectl 卡就重启 apiserver。重启能缓 10 分钟，然后照样卡。'
      }
    },

    {
      id: 'F08',
      plane: 'L4',
      title: '每次跑到第六小时就 OOM',
      symptom: [
        {
          name: '作业日志',
          text: 'epoch 3  step 2100  mem 41.2 GB\nepoch 3  step 2600  mem 52.8 GB\nepoch 3  step 3100  mem 66.4 GB\n' +
            'torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB'
        },
        { name: '告警', text: '[P2] job train-7c1 在过去 24 小时内 OOM 退出 4 次，均在启动后 5.8~6.2 小时' }
      ],
      world: {
        gpus: [{ idx: 0, memUsed: 79500, memTotal: 81920, util: 41 }],
        kernel: ['[ 1273.882001] Out of memory: Killed process 20481 (python) total-vm:88421904kB']
      },
      cause: {
        q: '根因是？',
        options: [
          ['显存随步数单调增长，存在泄漏（缓存或张量没释放）', '正确。三次采样 41→52→66 GB 单调上升，且固定在第 6 小时触顶。'],
          ['batch size 设得太大', '不成立。batch 太大会一开始就 OOM，不会跑 6 小时。'],
          ['显卡坏了', '不成立。重启就能恢复，且是稳定增长。'],
          ['数据集太大', '不成立。数据在 CPU 侧，不会体现为显存缓涨。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['用 profiler 定位增长来源（缓存/中间结果），同时把 checkpoint 间隔缩短到 30 分钟降低损失', '正确。定位是根治，缩短间隔是止损，两件事一起做。'],
          ['加一张卡扩容显存', '不成立。泄漏会把任何容量吃满。'],
          ['重启后继续跑同样的配置', '不成立。只是把第 6 小时再演一遍。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi', why: '显存 79500/81920 MiB，利用率只有 41%——不是算力吃满，是显存吃满' },
        { cmd: 'dmesg', why: 'OOM Killer 记录，确认是显存/内存侧而非驱动' }
      ],
      knowledge: {
        concept: '显存泄漏的特征是"单调增长 + 固定时长触顶"。它和"一开始就 OOM"是两种完全不同的病。',
        pitfall: '看到 OOM 就加卡。泄漏问题加多少显存都会在某个时刻吃满。'
      }
    },

    {
      id: 'F09',
      plane: 'L1',
      title: '新算子一上线就崩，同一台机器的其他作业正常',
      symptom: [
        {
          name: '作业日志',
          text: 'step 412  loss 1.882\nstep 413  CUDA error: an illegal memory access was encountered\n' +
            'step 413  Current thread 0x00007f... (most recent call first):\n' +
            '  File "custom_attn.py", line 87, in forward'
        },
        { name: '告警', text: '[P2] node-03 作业 train-4d8 崩溃（第 3 次）\n[P3] node-03 其他作业运行正常，未见硬件告警' }
      ],
      world: {
        kernel: [
          '[ 8021.100234] NVRM: Xid (PCI:0000:3B:00): 31, pid=20481, MMU Fault on address 0x7f2c40000000',
          '[ 8021.100998] NVRM: Xid (PCI:0000:3B:00): 31, pid=20481, MMU Fault on address 0x7f2c40000000'
        ]
      },
      cause: {
        q: '同一台机器别的作业都正常，只有新算子崩，根因最可能是？',
        options: [
          ['自定义算子越界访问显存（用户态 bug），不是硬件问题', '正确。XID 31 是 MMU Fault，指向越界地址；同机其他作业正常，说明硬件本身没坏。'],
          ['显存颗粒出现不可纠正错误', '不成立。DBE 会报 XID 48，且不会只影响一个算子。'],
          ['供电不足导致掉卡', '不成立。掉卡是 XID 79，卡会从 nvidia-smi 消失。'],
          ['驱动版本太旧', '不成立。旧驱动不会只在新算子上崩。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['回滚该算子，用 compute-sanitizer 在单卡上定位越界位置，修好后小流量验证', '正确。先止血再定位，且必须在单卡上复现才有意义。'],
          ['直接换一张卡', '不成立。换卡大概率还是崩在同一个算子。'],
          ['把 batch 调小绕过', '不成立。越界与 batch 大小无关，只会改变触发概率。']
        ], answer: 0
      },
      chain: [
        { cmd: 'dmesg', why: 'XID 31 是 MMU Fault，属于用户态访问了不该访问的地址' },
        { cmd: 'nvidia-smi -q', why: '该卡 ECC 全 0、retired pages 为 0，排除显存硬件' },
        { cmd: 'nvidia-smi', why: '8 张卡都在、温度功耗正常，排除掉卡与降频' }
      ],
      knowledge: {
        concept: 'XID 31/13 这类是"用户态把 GPU 用错了"，XID 48/79 才是"硬件坏了"。两者处置完全不同。',
        pitfall: '一看到 CUDA error 就换卡。先看 XID 号码，再决定是修代码还是修硬件。'
      }
    },

    {
      id: 'F10',
      plane: 'L1',
      title: '吞吐掉了三成，温度却一直很高',
      symptom: [
        {
          name: '作业日志',
          text: 'epoch 1  step 500  iter_time 1.31s  (基线 0.94s)\n' +
            'epoch 1  step 900  iter_time 1.29s\nepoch 2  step 100  iter_time 1.33s'
        },
        { name: '告警', text: '[P2] node-05 单步耗时较基线 +39%（持续 2 小时）\n[P2] node-05 GPU0 温度 87℃ 接近上限' }
      ],
      world: {
        gpus: [{ idx: 0, throttle: 'SW Power Cap', smClock: 1080, temp: 87, power: 699, util: 96 }]
      },
      cause: {
        q: '根因是？',
        options: [
          ['撞到功耗墙/温度墙，SM 频率被压到 1080MHz，算力按比例下降', '正确。温度 87℃ + 功耗贴 700W + SW Power Cap 生效，频率自然掉。'],
          ['显存不够导致换页', '不成立。显存不足会直接 OOM，不会表现为频率下降。'],
          ['跨机网络变慢', '不成立。单步耗时里通信占比没有变化。'],
          ['数据集读取变慢', '不成立。数据慢会让利用率掉下来，而这里是利用率 96%。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['查机柜进风与风扇转速，改善风道；必要时下调功耗上限，用可预期的频率换稳定吞吐', '正确。先解决散热，再用功耗曲线兜底。'],
          ['换一张卡', '不成立。温度高是环境与散热问题，不是单卡故障。'],
          ['把 batch 调大以提升吞吐', '不成立。撞墙时加大负载只会更热。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi -q -i 0', why: 'SM 频率 1080MHz、SW Power Cap 为 Active' },
        { cmd: 'nvidia-smi', why: '温度 87℃、功耗 699W/700W，贴着上限' }
      ],
      knowledge: {
        concept: '功耗墙与温度墙都会压低 SM 频率。频率掉了，FLOPs 就按比例掉，但利用率反而更高（更忙更慢）。',
        pitfall: '看到利用率 96% 就以为跑满了。利用率高只说明没闲着，不代表频率正常。'
      }
    },

    {
      id: 'F11',
      plane: 'L2',
      title: '训练忽快忽慢，有一颗 CPU 核常年满载',
      symptom: [
        {
          name: '作业日志',
          text: 'step 1200  iter_time 0.98s\nstep 1260  iter_time 1.74s\nstep 1290  iter_time 0.96s\n' +
            'step 1340  iter_time 1.81s'
        },
        { name: '告警', text: '[P3] node-06 CPU47 软中断占比 92%（持续 3 小时）\n[P3] node-06 其余 CPU 核空闲' }
      ],
      world: {
        irqHot: true,
        nics: [
          { dev: 'mlx5_0', state: 'Active', rate: 400, numa: 0 },
          { dev: 'mlx5_1', state: 'Active', rate: 400, numa: 0 }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['网卡多队列中断全部落在一颗核上，那颗核成了瓶颈，包一多就排队', '正确。/proc/interrupts 里四条队列全在 CPU47，与"只有一颗核满"完全对得上。'],
          ['GPU 算力不足', '不成立。GPU 侧指标正常，慢的是 Host 侧的包处理。'],
          ['内存带宽不足', '不成立。内存不足会表现为多核同时慢。'],
          ['交换机拥塞', '不成立。拥塞不会只压一颗 CPU 核。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['开 irqbalance 或手动把各队列中断绑到不同核，并把训练进程绑到其余核上', '正确。分散中断 + 隔离计算核，两手都要。'],
          ['换成更快的网卡', '不成立。400G 已经够快，问题是中断分配。'],
          ['减少训练进程的线程数', '不成立。减少线程治不了单核打满。']
        ], answer: 0
      },
      chain: [
        { cmd: 'cat /proc/interrupts', why: 'mlx5_comp0..3 四条队列的中断全落在 CPU47' },
        { cmd: 'lscpu', why: '确认可用核数与 NUMA 分布，决定把训练绑到哪一组' },
        { cmd: 'nvidia-smi', why: 'GPU 侧温度功耗正常，排除卡侧问题' }
      ],
      knowledge: {
        concept: '高吞吐网卡靠多队列 + 多核中断分摊。队列全挤一颗核，网卡再快也没用。',
        pitfall: '看到 si 高就去查网络设备。先看 /proc/interrupts，确认中断落在哪几颗核。'
      }
    },

    {
      id: 'F12',
      plane: 'L2',
      title: '跑二十分钟后整体变慢',
      symptom: [
        {
          name: '作业日志',
          text: '00:00  iter_time 0.92s\n20:00  iter_time 1.61s\n25:00  iter_time 1.88s\n' +
            'WARNING  DataLoader worker (pid 3312) is killed by signal: SIGKILL'
        },
        { name: '告警', text: '[P2] node-09 可用内存低于 15Gi（持续 10 分钟）\n[P3] node-09 swap 使用量持续上升' }
      ],
      world: {
        mem: { avail: '12Gi', swapUsed: '7.4Gi', swapFree: '0.6Gi' }
      },
      cause: {
        q: '根因是？',
        options: [
          ['内存超配触发 swap，训练进程被换出换入；dataloader 又不断申请内存', '正确。swap 已用 7.4Gi、可用只剩 12Gi，且 dataloader 被杀，三个证据同向。'],
          ['显存不够', '不成立。显存问题会先 OOM，不会跑到 20 分钟才变慢。'],
          ['GPU 降频', '不成立。降频不会伴随 swap 增长。'],
          ['磁盘 IO 慢', '不成立。数据集已加载进内存，没在走盘。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['关闭 swap（或 swappiness=0），限制 dataloader worker 数量与预取深度', '正确。先断掉换页这条路，再压住内存申请源。'],
          ['加一张 GPU', '不成立。瓶颈在主机内存，不在算力。'],
          ['换更快的 NVMe', '不成立。问题不是盘慢，是内存不够。']
        ], answer: 0
      },
      chain: [
        { cmd: 'free -h', why: 'Swap 已用 7.4Gi、available 只剩 12Gi' },
        { cmd: 'dmesg', why: '有进程被杀记录，时间点与变慢吻合' },
        { cmd: 'nvidia-smi', why: 'GPU 侧正常，说明是主机侧拖慢' }
      ],
      knowledge: {
        concept: '训练机对内存延迟极敏感。一旦开始换页，吞吐会断崖式下跌，而 GPU 侧指标看起来完全正常。',
        pitfall: '只看 GPU。GPU 正常但整体变慢，第一件事应该看 free -h 的 swap。'
      }
    },

    {
      id: 'F13',
      plane: 'L2',
      title: '升级驱动后卡间通信全变慢',
      symptom: [
        {
          name: '作业日志',
          text: 'NCCL 单机 all-reduce 19 GB/s（升级前 68 GB/s）\n' +
            'NCCL_DEBUG=INFO  Channel 00/07 : 8  （NVL 通道为 0）\n' +
            '训练吞吐较升级前下降 62%'
        },
        { name: '告警', text: '[P1] node-12 全机 GPU 间通信异常\n[P3] node-12 驱动与固件版本已更新至 550.54.15' }
      ],
      world: {
        config: cfgNoNvlink(9),
        kernel: [
          '[   12.100112] nvidia-fabricmanager: version mismatch: driver 550.54.15 vs fabricmanager 535.129.03',
          '[   12.100998] nvidia-fabricmanager: NVSwitch init skipped, NVLink disabled'
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['fabricmanager 还是旧版本，与驱动不匹配，NVSwitch 没被接管，NVLink 整体失效', '正确。dmesg 直接写了版本不匹配 + NVLink disabled，topo 表里也全是 PCIe 码。'],
          ['网卡带宽下降', '不成立。这里是单机卡间通信，不经过网卡。'],
          ['PCIe 链路降级', '不成立。降级只会影响个别卡，不会全机同时退化。'],
          ['显存带宽不足', '不成立。显存带宽与 NVLink 无关。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['安装与驱动同版本的 fabricmanager 并重启该服务，再用 topo -m 验收', '正确。版本必须严格一致，重启后还要验证拓扑恢复 NV8。'],
          ['把驱动回滚到旧版本', '可行但代价大，先试对齐 fabricmanager。'],
          ['重启整机', '不成立。版本不匹配重启多少次都一样。']
        ], answer: 0
      },
      chain: [
        { cmd: 'nvidia-smi topo -m', why: '卡间全是 PIX/SYS，NV8 消失了' },
        { cmd: 'dmesg', why: 'fabricmanager 版本不匹配、NVSwitch init skipped' },
        { cmd: 'lsmod | grep nvidia', why: '驱动模块都在，说明不是没装驱动' }
      ],
      knowledge: {
        concept: 'NVSwitch 机型上，fabricmanager 是 NVLink 的控制面。版本与驱动不一致时，NVLink 直接不工作。',
        pitfall: '升级只看驱动版本。fabricmanager 必须同版本，漏了就是"卡都在，专线全没了"。'
      }
    },

    {
      id: 'F14',
      plane: 'L3',
      title: '跨机通信直接卡在初始化',
      symptom: [
        {
          name: '作业日志',
          text: 'NCCL INFO Bootstrap : Using eth0:10.0.3.21\n' +
            'NCCL INFO NET/IB : Using [0]mlx5_0:1/IB\n' +
            'NCCL WARN Connect to 10.0.4.31<61723> failed : Connection timed out'
        },
        { name: '告警', text: '[P1] node-02 计算网端口异常\n[P3] node-02 跨机 all-reduce 无法建立' }
      ],
      world: {
        nics: [
          { dev: 'mlx5_0', state: 'Down', rate: 400, numa: 0 },
          { dev: 'mlx5_1', state: 'Active', rate: 400, numa: 1 }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['这张网卡的端口在协议层 Down（模块、线缆或对端端口问题），连不通对端', '正确。ibstat 显示 State: Down 而物理层 LinkUp，典型是链路协商或对端问题。'],
          ['NCCL 版本不兼容', '不成立。版本问题不会让单个端口 Down。'],
          ['交换机拥塞', '不成立。拥塞会表现为慢，而不是连不上。'],
          ['防火墙拦了 IB 流量', '不成立。IB 不走 IP 防火墙，且端口状态是 Down。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['核对两端端口状态与光功率，换模块或跳线；恢复前先让作业避开这张卡', '正确。先隔离再换件，别在坏链路上反复重试。'],
          ['调大 NCCL 超时时间', '不成立。端口 Down，等多久都连不上。'],
          ['改用 TCP 通信先跑起来', '可行但会慢一个数量级，只适合临时绕过。']
        ], answer: 0
      },
      chain: [
        { cmd: 'ibstat', why: 'mlx5_0 的 Port 1 State 是 Down，mlx5_1 正常' },
        { cmd: 'dmesg', why: '内核侧链路事件，确认不是 IB 栈配置问题' },
        { cmd: 'nvidia-smi', why: 'GPU 侧正常，问题在网络' }
      ],
      knowledge: {
        concept: '端口状态分两层：物理层 LinkUp 只说明有光，协议层 Active 才说明能通信。两层不一致就是链路问题。',
        pitfall: '看到灯亮就以为链路好。灯亮只代表物理层，ibstat 的 State 才是能不能用。'
      }
    },

    {
      id: 'F15',
      plane: 'L3',
      title: '跨机带宽只有标注速率的一半',
      symptom: [
        {
          name: '作业日志',
          text: 'NCCL 跨机 all-reduce 21 GB/s（基线 42 GB/s）\n' +
            '同机 all-reduce 67 GB/s（正常）'
        },
        { name: '告警', text: '[P2] node-11 计算网端口速率与预期不符\n[P3] node-11 无丢包、无 CRC 增长\n[P3] 同型号其他节点端口速率均为 400G' }
      ],
      world: {
        nics: [
          { dev: 'mlx5_0', state: 'Active', rate: 200, numa: 0 },
          { dev: 'mlx5_1', state: 'Active', rate: 200, numa: 1 }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['端口协商到了 200G 而不是 400G，带宽正好减半', '正确。ibstat 的 Rate 是 200，跨机带宽也正好一半，两者完全一致。'],
          ['NCCL 只用了部分网卡', '不成立。日志里两张都在用，且同机正常。'],
          ['交换机超订', '不成立。超订影响的是峰值，不会稳定卡在一半。'],
          ['PCIe 带宽不足', '不成立。PCIe 不足会同时影响同机通信。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['核对两端模块型号与线缆规格，换回匹配的 400G 模块后复查 Rate', '正确。降速几乎都是模块/线缆规格不匹配或质量不达标。'],
          ['调整 NCCL 参数压榨带宽', '不成立。物理速率就是 200G，压不出 400G。'],
          ['换交换机', '不成立。先把模块对齐。']
        ], answer: 0
      },
      chain: [
        { cmd: 'ibstat', why: '两张网卡的 Rate 都是 200，不是 400' },
        { cmd: 'nvidia-smi', why: 'GPU 侧正常，排除卡间问题' }
      ],
      knowledge: {
        concept: '链路速率是协商结果，不是模块标称值。模块/线缆不匹配时会自动降一档，而且不报错。',
        pitfall: '只看"链路是 Active"就以为没事。Rate 掉一半时，带宽会精确地掉一半，很好认。'
      }
    },

    {
      id: 'F16',
      plane: 'L4',
      title: '8 卡作业排了一小时，集群却说还有空闲卡',
      symptom: [
        {
          name: '调度事件',
          text: 'Warning  FailedScheduling  8m  default-scheduler  0/4 nodes are available:\n' +
            '    4 Insufficient nvidia.com/gpu.'
        },
        { name: '监控', text: '集群 GPU 总量 32，已分配 24，空闲 8\n空闲分布：node-1:3  node-2:3  node-3:2  node-4:0' }
      ],
      world: {
        pods: [
          { name: 'train-a', ns: 'ai', status: 'Running', node: 'node-1', restarts: 0 },
          { name: 'train-b', ns: 'ai', status: 'Running', node: 'node-2', restarts: 0 },
          { name: 'train-c', ns: 'ai', status: 'Running', node: 'node-3', restarts: 0 },
          { name: 'train-8card', ns: 'ai', status: 'Pending', node: '<none>', restarts: 0,
            events: ['  Warning  FailedScheduling  2m  default-scheduler  0/4 nodes are available: 4 Insufficient nvidia.com/gpu.'] }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['资源碎片：空闲的 8 张卡分散在 3 台机器上，凑不出"一台 8 卡"', '正确。调度按单节点分配，跨节点的空闲卡拼不到一起。'],
          ['集群没卡了', '不成立。监控显示空闲 8 张。'],
          ['配额不够', '不成立。配额报错会写 exceeded quota。'],
          ['镜像拉不下来', '不成立。拉镜像失败是 ImagePullBackOff，不是 Pending。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['引入 gang 调度与装箱策略，或先做一次碎片整理（把小作业挤到一台机上）', '正确。要么改变分配方式，要么改变现有分布。'],
          ['直接加 4 台机器', '不成立。加机器能解一时，碎片还会再出现。'],
          ['把作业拆成 3 个 2 卡任务', '不成立。改变不了作业本身的 8 卡需求。']
        ], answer: 0
      },
      chain: [
        { cmd: 'kubectl get pods', why: '三个 4 卡作业在跑，8 卡作业 Pending' },
        { cmd: 'kubectl describe pod train-8card', why: '事件写明 Insufficient nvidia.com/gpu，且 0/4 节点可用' },
        { cmd: 'lscpu', why: '确认节点规格一致，排除某一台配置不同' }
      ],
      knowledge: {
        concept: 'GPU 调度的单位是"节点"。空闲总量够，不等于能拼出一台整机——这就是碎片。',
        pitfall: '看到 Insufficient 就加机器。先看空闲卡分布在几台机上，可能只是排布问题。'
      }
    },

    {
      id: 'F17',
      plane: 'L4',
      title: 'Pod 一直拉不下镜像',
      symptom: [
        {
          name: '调度事件',
          text: 'Normal   Scheduled        10m  default-scheduler  Successfully assigned ai/train-x to node-3\n' +
            'Warning  Failed           9m   kubelet            Failed to pull image "reg.local:5000/ai/train:v3"\n' +
            'Warning  Failed           9m   kubelet            Error: ErrImagePull'
        },
        { name: '监控', text: 'node-3 上其他 Pod 正常\n同一镜像在 node-1 上可以拉取' }
      ],
      world: {
        pods: [
          { name: 'train-x', ns: 'ai', status: 'ImagePullBackOff', node: 'node-3', restarts: 0,
            events: ['  Warning  Failed  9m  kubelet  Failed to pull image "reg.local:5000/ai/train:v3": dial tcp 10.0.7.12:5000: i/o timeout'] },
          { name: 'serve-y', ns: 'ai', status: 'Running', node: 'node-3', restarts: 0 }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['node-3 到私有仓库的网络不通（路由/安全组/防火墙），不是镜像本身的问题', '正确。同一镜像在 node-1 能拉，报错是 dial tcp i/o timeout，指向节点到仓库的路径。'],
          ['镜像不存在', '不成立。不存在会报 manifest unknown，且 node-1 能拉到。'],
          ['仓库磁盘满了', '不成立。会返回 5xx，而不是超时。'],
          ['认证失败', '不成立。认证失败是 401 unauthorized。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['从 node-3 直接测到仓库的连通性与端口，修路由或安全组后重试', '正确。先在故障节点上验证路径，再动配置。'],
          ['重新推一次镜像', '不成立。其他节点能拉，说明镜像没问题。'],
          ['给仓库扩容', '不成立。报错不是容量问题。']
        ], answer: 0
      },
      chain: [
        { cmd: 'kubectl describe pod train-x', why: '事件里是 dial tcp ... i/o timeout' },
        { cmd: 'kubectl get pods', why: '同节点的另一个 Pod 正常，排除整个节点不可用' },
        { cmd: 'dmesg', why: '节点侧无硬件异常，问题在网络路径' }
      ],
      knowledge: {
        concept: '拉镜像失败分三类：拉不到（网络）、拉不对（tag/认证）、拉得慢（体积）。报错文本直接对应其中一类。',
        pitfall: '看到拉取失败就重推镜像。先看错误是 timeout、manifest unknown 还是 unauthorized。'
      }
    },

    {
      id: 'F18',
      plane: 'L4',
      title: '训练跑到一半 Pod 被驱逐',
      symptom: [
        {
          name: '调度事件',
          text: 'Status: Failed\nReason: Evicted\n' +
            'Message: The node was low on resource: memory. Threshold quantity: 100Mi, available: 32Mi.'
        },
        { name: '监控', text: 'node-7 可用内存 32Mi（总量 1Ti）\n同一节点上另有 3 个训练 Pod 被驱逐' }
      ],
      world: {
        mem: { used: '986Gi', free: '1.0Gi', buff: '12Gi', avail: '32Mi', swapUsed: '0Gi', swapFree: '8.0Gi' },
        pods: [
          { name: 'train-0', ns: 'ai', status: 'Evicted', node: 'node-7', restarts: 0,
            events: ['  Warning  Evicted  3m  kubelet  The node was low on resource: memory.'] },
          { name: 'train-1', ns: 'ai', status: 'Running', node: 'node-8', restarts: 0 }
        ]
      },
      cause: {
        q: '根因是？',
        options: [
          ['容器内存 limit 设得过高或 dataloader 申请过多，节点内存被吃光，kubelet 触发驱逐', '正确。事件写明 low on resource: memory，且是同节点多个 Pod 一起被驱逐。'],
          ['显存不足', '不成立。显存不足是 OOM 报错，不是 Evicted。'],
          ['镜像太大占满磁盘', '不成立。事件写的是 memory，不是 ephemeral-storage。'],
          ['GPU 被抢占', '不成立。抢占是 Preempted，不是 Evicted。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['下调容器 memory limit 与 dataloader worker 数，给节点留出安全余量', '正确。驱逐是节点级保护，只能靠限制单 Pod 的内存来避免。'],
          ['给 Pod 加 GPU', '不成立。问题在内存，不在算力。'],
          ['把 Pod 改成特权模式', '不成立。特权模式会让问题更严重。']
        ], answer: 0
      },
      chain: [
        { cmd: 'kubectl describe pod train-0', why: 'Reason: Evicted，Message 写明 low on resource: memory' },
        { cmd: 'free -h', why: '节点 available 只剩 32Mi，确实被打满' },
        { cmd: 'kubectl get pods', why: '同节点多个 Pod 同时 Evicted，说明是节点级压力' }
      ],
      knowledge: {
        concept: 'Evicted 是 kubelet 的自我保护：节点资源低于阈值就赶人。它和 OOMKilled（容器内）是两回事。',
        pitfall: '把 Evicted 当成 OOMKilled 查显存。看清 Message 写的是 memory 还是 nvidia.com/gpu。'
      }
    },

    /* ---------------- L0 场地物理：证据在带外，不在 shell ---------------- */

    {
      id: 'F19',
      plane: 'L0',
      view: 'mon',
      title: '机柜电流顶到 87%，A 路空开跳过一次',
      symptom: [
        {
          name: '告警',
          text: '[P2] rack A01 支路电流不平衡：A 路 52.4A / B 路 9.6A（额定各 60A）\n' +
            '[P2] rack A01 过去 7 天 PDU-A 支路空开跳闸 1 次（已人工复位）\n' +
            '[P3] 同机柜另外 5 台机器运行正常，进风 26°C，无温度告警'
        },
        {
          name: '监控摘要',
          text: '整柜功耗 13.2 kW，其中 node-31 一台占 6.1 kW\n' +
            'node-31 四颗 PSU：PSU1 1580W、PSU2 1560W、PSU3 60W、PSU4 55W\n' +
            'SEL 有一条 "Power Unit redundancy lost"，时间与上次跳闸吻合'
        }
      ],
      world: {
        host: 'node-31',
        mon: {
          rack: {
            id: 'A01', row: 'R03',
            pdu: [
              { name: 'PDU-A', branch: 'L1', loadA: 52.4, capA: 60 },
              { name: 'PDU-B', branch: 'L2', loadA: 9.6, capA: 60 }
            ]
          },
          bmc: {
            inlet: 26, exhaust: 41, fanPct: 74, nodeWatts: 6100,
            psus: [
              { id: 'PSU1', watts: 1580, status: 'ok' },
              { id: 'PSU2', watts: 1560, status: 'ok' },
              { id: 'PSU3', watts: 60, status: 'ok' },
              { id: 'PSU4', watts: 55, status: 'ok' }
            ],
            sel: [
              '   7 | 11/26/2026 | 09:41:02 | Power Unit | Power Unit redundancy lost | Asserted',
              '   8 | 11/26/2026 | 09:41:02 | Power Unit | Power Unit redundancy lost | Deasserted'
            ]
          },
          metrics: {
            pdu_current_a: {
              series: [
                { labels: { rack: 'A01', pdu: 'A' }, v: 52.4 },
                { labels: { rack: 'A01', pdu: 'B' }, v: 9.6 }
              ]
            },
            rack_power_kw: { v: 13.2 }
          }
        }
      },
      cause: {
        q: 'A 路电流到了 87%，而 B 路几乎空载。根因是？',
        options: [
          ['这台机器的四颗 PSU 全接在 A 路 PDU 上，B 路没带载，冗余和均衡都不存在',
            '正确。PSU3/4 只有几十瓦，说明它们虽然插着但没跟着带载，整机负载全压在 A 路。'],
          ['机柜总功耗超过制冷能力，触发了热保护',
            '不成立。进风 26°C、无温度告警，跳的是支路空开不是热保护；总功耗也没超机柜额定。'],
          ['单机功耗太高，需要换低功耗的卡',
            '不成立。8 卡机 6.1 kW 是正常值，问题是这些功率全走了一路，不是总量太大。'],
          ['PDU 铭牌标低了，实际能跑 80A',
            '不成立。按铭牌 60A 跑已经是 87%，把余量当额度就是把空开当装饰。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['把 PSU3/4 的电源线改接到 B 路 PDU，两路各带一半；再对整柜做功率封顶',
            '正确。先恢复"两路各带一半"的物理前提，再用封顶防止后续机型把余量吃回去。'],
          ['直接换一个 63A 的空开，先让它别跳',
            '不成立。换大空开等于拆掉保护，线径和上游配电都要重算，是拿安全换安静。'],
          ['砍掉一半训练卡，把功耗降下来',
            '不成立。牺牲算力掩盖接线错误，换机型或加机器时同样的坑会再来一次。']
        ], answer: 0
      },
      chain: [
        { cmd: 'ipmitool sdr', why: 'PSU1/PSU2 各 1.5 kW，PSU3/PSU4 只有几十瓦——后两颗没在带载' },
        { cmd: "prom query 'pdu_current_a'", why: 'A 路 52.4A、B 路 9.6A，61.8A 的总额几乎全压在 A 路' },
        { cmd: 'ipmitool sel list', why: 'Power Unit redundancy lost：冗余在事件层面已经报过一次' }
      ],
      knowledge: {
        concept: '双路供电的意义是"任一路失电仍能带满全载"，前提是两路各带一半。四颗 PSU 全插一路，等于只有一路。',
        pitfall: '只看整柜总功耗没超标就放心。单路超载和总量超标是两件事，跳闸的是支路空开。'
      }
    },

    {
      id: 'F20',
      plane: 'L0',
      view: 'mon',
      title: '八张卡一起降频，温度齐刷刷 91 度',
      symptom: [
        {
          name: '告警',
          text: '[P2] node-14 全部 8 张卡触发 HW Thermal Slowdown（13:02 起持续）\n' +
            '[P2] 同机柜 node-12 / node-13 也有降频，程度较轻\n' +
            '[P3] 机房 2 号空调机组 12:40 报高压告警，运维正在处理'
        },
        {
          name: '监控摘要',
          text: 'GPU 温度 91°C（8 张一致），进风 34°C，出风 46°C，风扇 100%\n' +
            'SM 频率 1410 → 1180 MHz，单卡算力下降约 16%\n' +
            '整机功耗 6.0 kW，未触及功率墙'
        }
      ],
      world: {
        host: 'node-14',
        gpuAll: { temp: 91, smClock: 1180, throttle: 'HW Thermal Slowdown' },
        mon: {
          bmc: {
            inlet: 34, exhaust: 46, fanPct: 100, nodeWatts: 6040,
            sel: [
              '  12 | 11/26/2026 | 13:02:11 | Temperature | Ambient Temp Upper Critical | Asserted',
              '  13 | 11/26/2026 | 13:02:11 | Fan | Fan redundancy lost | Asserted'
            ]
          },
          metrics: {
            gpu_temp_c: { v: 91 },
            rack_power_kw: { v: 12.1 }
          }
        }
      },
      cause: {
        q: '整机 8 张卡同时降频，最可能的根因是？',
        options: [
          ['冷通道进风 34°C，超过允许上限，卡只能降频自保',
            '正确。ASHRAE 允许的上限是 27°C，进风 34°C 时卡再吹也是热风，降频是保护不是故障。'],
          ['卡老化，硅脂干了导致散热变差',
            '不成立。整机柜多台同时出现、且进风温度先异常，指向环境而不是单卡。'],
          ['风扇策略太保守，转速不够',
            '不成立。风扇已经 100%，没有余量可调；再调策略也不会让 34°C 的进风变凉。'],
          ['机柜功率超限触发了功耗墙',
            '不成立。整机 6.0 kW 没到上限，降频原因是温度；nvidia-smi 里生效的是 Thermal 而不是 Power Cap。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['先查空调与冷通道（2 号机组、盲板缺失、热风回流），同时对机柜做临时功率封顶止损',
            '正确。环境是根因，先恢复冷通道；封顶只是让机器在热环境里别把自己烧了。'],
          ['把这几张卡换掉',
            '不成立。换完还插在同一条热通道里，温度一样。'],
          ['把风扇策略改成 100% 常转',
            '不成立。已经 100%，再改没有意义；真正的动作在机房侧。']
        ], answer: 0
      },
      chain: [
        { cmd: 'ipmitool sdr', why: '进风 34°C、出风 46°C、风扇 100%：机器已经在全力散热，进风本身太热' },
        { cmd: "prom query 'gpu_temp_c'", why: '8 张卡全在 91°C，是环境问题而不是单卡问题' },
        { cmd: 'nvidia-smi -q', why: 'HW Thermal Slowdown = Active，确认降频原因是温度' }
      ],
      knowledge: {
        concept: '进风温度是整机散热的起点。进风 34°C 时，卡再努力也只能把热量搬到同样热的空气里。',
        pitfall: '看到 GPU 温度高就去查卡。整机同温、多机同病、进风先异常——顺序反了会白换一批硬件。'
      }
    },

    {
      id: 'F21',
      plane: 'L0',
      view: 'mon',
      title: 'A 路空开一跳，整机断电，作业全丢',
      symptom: [
        {
          name: '告警',
          text: '[P1] node-21 于 02:17:44 整机断电重启，8 卡作业全部丢失（最近 checkpoint 3 小时前）\n' +
            '[P1] 同机柜其他 5 台机器未受影响\n' +
            '[P3] 机房记录：02:17 该机柜 A 路上游空开跳闸，B 路供电正常'
        },
        {
          name: '监控摘要',
          text: 'SEL：PSU1 与 PSU2 在同一秒报 "Power Supply AC lost"\n' +
            'SEL：PSU3 / PSU4 没有任何记录——两颗电源不在位\n' +
            '重启后 PSU1 无输出，PSU2 单独带载 1.49 kW'
        }
      ],
      world: {
        host: 'node-21',
        mon: {
          bmc: {
            inlet: 25, exhaust: 39, fanPct: 58, nodeWatts: 1490,
            psus: [
              { id: 'PSU1', watts: 0, status: 'fail' },
              { id: 'PSU2', watts: 1490, status: 'ok' },
              { id: 'PSU3', watts: 0, status: 'absent' },
              { id: 'PSU4', watts: 0, status: 'absent' }
            ],
            sel: [
              '   3 | 11/26/2026 | 02:17:44 | Power Supply PSU1 | Power Supply AC lost | Asserted',
              '   4 | 11/26/2026 | 02:17:44 | Power Supply PSU2 | Power Supply AC lost | Asserted',
              '   5 | 11/26/2026 | 02:17:45 | System Event | OS Critical Stop | Asserted',
              '   6 | 11/26/2026 | 02:19:02 | Power Supply PSU2 | Power Supply AC lost | Deasserted'
            ]
          },
          metrics: {
            pdu_current_a: {
              series: [
                { labels: { rack: 'A02', pdu: 'A' }, v: 0 },
                { labels: { rack: 'A02', pdu: 'B' }, v: 6.2 }
              ]
            }
          }
        }
      },
      cause: {
        q: 'A 路一跳就整机断电，根因是？',
        options: [
          ['这台机器只有两颗 PSU 在位，而且都接在 A 路 PDU，冗余从来没建立过',
            '正确。PSU3/4 不在位、PSU1/2 同时 AC lost，说明断电时机器只有一条供电路径。'],
          ['主板供电模块烧了',
            '不成立。重启后能正常跑、PSU2 还能带 1.49 kW；SEL 明确写的是 AC lost，是外部断电。'],
          ['机房温度过高触发了保护',
            '不成立。同机柜其他机器没事，进风 25°C，没有温度事件。'],
          ['训练作业把机器跑挂了',
            '不成立。OS Critical Stop 在 AC lost 之后 1 秒，属于被动掉电的后果。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['补齐 PSU3/4 并接到 B 路 PDU，上架验收加"拔一路"测试；关键作业配 UPS 与更密的 checkpoint',
            '正确。先把冗余真正建起来，再用验收动作证明它在，最后才是减少单次断电的损失。'],
          ['整台机器换新',
            '不成立。硬件没坏，换一台照样只有一条供电路径，下次跳闸一样断电。'],
          ['让机房把 A 路空开换大一点',
            '不成立。跳闸是保护动作，先查负载与线径；换大空开是拆保护。']
        ], answer: 0
      },
      chain: [
        { cmd: 'ipmitool sel list', why: 'PSU1/PSU2 同一秒 AC lost，PSU3/4 完全没有记录' },
        { cmd: 'ipmitool sdr', why: 'PSU3/PSU4 状态 ns（不在位），PSU1 无输出、PSU2 单独带载' },
        { cmd: "prom query 'pdu_current_a'", why: 'A 路 0A、B 路 6.2A：断电时整机确实挂在失电的那一路上' }
      ],
      knowledge: {
        concept: '冗余不是"插了四颗电源"，而是"任一路失电还能带满全载"。PSU 不在位、两路插同一 PDU，都等于没有冗余。',
        pitfall: '上架只数电源数量、不验供电路径。验收时拔掉一路看机器是否还活，比看铭牌可靠。'
      }
    },

    /* ---------------- L5 平台运营：证据在监控与账单 ---------------- */

    {
      id: 'F22',
      plane: 'L5',
      view: 'mon',
      title: 'P99 翻了三倍，GPU 利用率只有 12%',
      symptom: [
        {
          name: '告警',
          text: '[P2] infer-bert 首 token 延迟 P99 780ms（基线 210ms），持续 40 分钟\n' +
            '[P2] GPU 利用率 12%，显存占用 18 / 80 GB\n' +
            '[P3] 网关无 5xx，请求全部成功返回'
        },
        {
          name: '监控摘要',
          text: '排队请求数 0——不是被打满\n' +
            '容器 CPU 限流比例 0.62，CPU 用量长时间顶在 limit 4 核\n' +
            '同一时间段上游请求量仅比基线高 8%'
        }
      ],
      world: {
        host: 'infer-node-03',
        pods: [
          { name: 'infer-bert-0', ns: 'ai', status: 'Running', node: 'infer-node-03', restarts: 0, cpu: '3980m', mem: '3.2Gi' },
          { name: 'infer-bert-1', ns: 'ai', status: 'Running', node: 'infer-node-04', restarts: 0, cpu: '3960m', mem: '3.1Gi' }
        ],
        mon: {
          metrics: {
            gpu_util_pct: { v: 12 },
            ttft_p99_ms: { v: 780 },
            request_queue_depth: { v: 0 },
            container_cpu_throttled_ratio: { v: 0.62 }
          }
        }
      },
      cause: {
        q: '延迟涨、GPU 却闲着。根因最可能是？',
        options: [
          ['CPU 侧预处理（分词、后处理）被 4 核 limit 卡住，GPU 一直在等输入',
            '正确。GPU 12%、排队 0、CPU 限流 0.62 —— 三个数一起指向"数据没送上来"，不是算力不够。'],
          ['GPU 算力不够，需要加卡',
            '不成立。利用率 12%，加卡只会让更多卡一起等 CPU。'],
          ['请求量太大把服务打满',
            '不成立。排队 0、请求只高 8%，网关也没有 5xx。'],
          ['模型版本退化，单次推理变慢',
            '不成立。模型慢会把 GPU 打满而不是闲着；这里 GPU 在等数据。']
        ], answer: 0
      },
      fix: {
        q: '先做什么？',
        options: [
          ['提高 CPU limit，或把预处理拆成独立服务横向扩，再看 GPU 利用率是否上来',
            '正确。先解开车头（预处理），再判断 GPU 够不够；顺序反了就是花钱买闲置。'],
          ['先加两块 GPU 顶上',
            '不成立。瓶颈在 CPU，加卡不改变排队位置，账单还会立刻变大。'],
          ['把 batch 调小以降低单次延迟',
            '不成立。batch 变小意味着单位时间内更多次预处理，CPU 更堵。']
        ], answer: 0
      },
      chain: [
        { cmd: "prom query 'gpu_util_pct'", why: 'GPU 只有 12%：算力不是瓶颈' },
        { cmd: "prom query 'container_cpu_throttled_ratio'", why: '0.62 的限流比例：CPU 长期被 limit 卡住' },
        { cmd: 'kubectl top pods', why: '两个副本 CPU 都顶在 4 核附近，与 limit 相等' }
      ],
      knowledge: {
        concept: '推理链路是"预处理 → GPU → 后处理"。GPU 利用率低而延迟高，说明上游在供数上卡住了。',
        pitfall: '看到延迟高就加 GPU。先看利用率与排队：卡闲着的时候，加卡只是把等待复制一份。'
      }
    },

    {
      id: 'F23',
      plane: 'L5',
      view: 'mon',
      title: '账单翻倍，吞吐一点没涨',
      symptom: [
        {
          name: '账单',
          text: '本月 32 卡常开，卡时 18,432，账单 ¥516,096\n' +
            '上月同样吞吐，账单 ¥248,832\n' +
            '单价未变：¥28 / 卡时'
        },
        {
          name: '监控摘要',
          text: '夜间 00:00-08:00 平均 GPU 利用率 3%\n' +
            '白天平均 62%，全天平均 38.6%\n' +
            '训练常驻副本数夜间保持 32，没有变化'
        }
      ],
      world: {
        host: 'train-node-01',
        mon: {
          bill: {
            team: 'nlp', period: '2026-11-01 ~ 2026-11-25', days: 25,
            resource: 'H100 80G', cards: 32, gpuHours: 18432, price: 28, utilPct: 38.6
          },
          metrics: {
            gpu_util_pct: { v: 3 },
            train_replicas: {
              unit: 'replicas', help: '训练常驻副本数',
              series: [{ labels: { job: 'train-bert' }, v: 32 }]
            }
          }
        }
      },
      cause: {
        q: '钱花了两倍，吞吐没变。根因是？',
        options: [
          ['夜间没有缩容，32 卡常驻空转；按卡时计费，空转照收',
            '正确。夜间 3% 利用率 + 副本数不变 + 单价不变，三个证据把"浪费"钉死在闲置上。'],
          ['单价涨了',
            '不成立。单价仍 ¥28 / 卡时，账单翻倍来自卡时翻倍。'],
          ['训练变慢，同样的任务花了更多卡时',
            '不成立。卡时 = 32 卡 × 576 小时，是常数；任务快慢不影响常驻卡的计费。'],
          ['有跑飞的作业偷偷占卡',
            '不成立。夜间利用率 3%，占卡会体现在利用率上；而且副本数没变。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['按队列长度伸缩、夜间降到基线（或 0），预留实例只覆盖基线；考核改成"有效卡时"',
            '正确。计费口径是卡时，能改的只有"开着但不干活"的那部分。'],
          ['换成更便宜的卡型',
            '不成立。利用率不解决，换便宜卡只是把浪费打折，账单结构不变。'],
          ['把夜间任务挪到白天跑',
            '不成立。白天已经 62%，挤进去只会排队，还得再买卡。']
        ], answer: 0
      },
      chain: [
        { cmd: 'bill report --team nlp', why: '卡时 18,432、有效卡时只有 38.6%，闲置成本占六成' },
        { cmd: "prom query 'gpu_util_pct'", why: '夜间 3%：卡开着但没在算' },
        { cmd: "prom query 'train_replicas'", why: '副本数整夜都是 32，没有缩容动作' }
      ],
      knowledge: {
        concept: '按卡时计费时，成本 = 卡数 × 时长 × 单价。利用率不影响账单，只影响你买到多少有效算力。',
        pitfall: '拿"吞吐没降"证明资源没浪费。吞吐由白天决定，账单由全天决定，两件事要对齐看。'
      }
    },

    {
      id: 'F24',
      plane: 'L5',
      view: 'mon',
      title: '流量涨了三倍，HPA 一个副本都不加',
      symptom: [
        {
          name: '告警',
          text: '[P1] infer-bert 副本数 2 已持续 3 小时，P99 8.2s（SLO 1s）\n' +
            '[P2] 入口排队 240 个请求\n' +
            '[P3] 集群还有 6 张空闲 GPU，节点资源不是瓶颈'
        },
        {
          name: '监控摘要',
          text: 'kubectl get hpa：TARGETS 显示 <unknown>/70%\n' +
            'HPA 事件：failed to get cpu utilization: missing request for cpu\n' +
            'Pod 状态全部 Running，没有 Pending 或 ImagePullBackOff'
        }
      ],
      world: {
        host: 'infer-node-05',
        pods: [
          { name: 'infer-bert-0', ns: 'ai', status: 'Running', node: 'infer-node-05', restarts: 0, cpu: '3900m', mem: '6.8Gi' },
          { name: 'infer-bert-1', ns: 'ai', status: 'Running', node: 'infer-node-06', restarts: 0, cpu: '3880m', mem: '6.6Gi' }
        ],
        hpa: [
          {
            name: 'infer-bert', ns: 'ai', ref: 'Deployment/infer-bert',
            targets: '<unknown>/70%', min: 2, max: 20, replicas: 2,
            events: [
              '  Warning  FailedGetResourceMetric  3m (x42 over 3h)  horizontal-pod-autoscaler  failed to get cpu utilization: missing request for cpu'
            ]
          }
        ],
        mon: {
          metrics: {
            gpu_util_pct: { v: 88 },
            ttft_p99_ms: { v: 8200 },
            request_queue_depth: { v: 240 }
          }
        }
      },
      cause: {
        q: 'HPA 完全不动作，根因是？',
        options: [
          ['容器没写 resources.requests.cpu，HPA 算不出利用率（<unknown>），永远不会触发扩容',
            '正确。TARGETS 是 unknown 就说明分母缺失；事件里直接写了 missing request for cpu。'],
          ['集群没有空闲 GPU',
            '不成立。还有 6 张空闲，而且 HPA 连扩容决策都没做出来。'],
          ['maxReplicas 设得太小',
            '不成立。max 是 20，当前只有 2，上限不是约束。'],
          ['镜像拉取失败，新副本起不来',
            '不成立。没有 Pending / ImagePullBackOff，副本数压根没变。']
        ], answer: 0
      },
      fix: {
        q: '怎么处置？',
        options: [
          ['给容器补 requests.cpu（或改用 DCGM 自定义指标 + adapter），确认 TARGETS 有数后再看扩容',
            '正确。先让分母存在，HPA 的算法才有意义；顺手验证扩容后 P99 是否真的回落。'],
          ['手动把副本数改成 10 就收工',
            '不成立。这次扛过去了，TARGETS 仍然是 unknown，下次流量涨还是不动。'],
          ['把目标利用率从 70% 调到 50%',
            '不成立。目标值再低，unknown 还是 unknown。']
        ], answer: 0
      },
      chain: [
        { cmd: 'kubectl get hpa', why: 'TARGETS 是 <unknown>/70%：分子分母缺一个，扩容不会发生' },
        { cmd: 'kubectl describe hpa infer-bert', why: '事件写得很直白：missing request for cpu' },
        { cmd: "prom query 'request_queue_depth'", why: '排队 240：需求真实存在，只是弹性没生效' }
      ],
      knowledge: {
        concept: 'HPA 的利用率是"实际用量 / requests"。requests 缺失时分母为 0，指标变成 unknown，HPA 不会做任何决策。',
        pitfall: '看到不扩容先怀疑资源不够。TARGETS 那一列是 unknown 还是数字，决定了要查指标还是查容量。'
      }
    }
  ];

  function pick(seed) {
    var r = root.TopoRng.stream(seed, 'X2.lab');
    return CASES[r.int(CASES.length)];
  }

  function byId(id) {
    for (var i = 0; i < CASES.length; i++) if (CASES[i].id === id) return CASES[i];
    return null;
  }

  /*
    两段判定。ans = { cause: 0..3, fix: 0..2 }
    只答了根因：返回 pending，前端据此进入第二步。
  */
  function judge(c, ans) {
    if (!ans || ans.cause === null || ans.cause === undefined) {
      return { ok: false, score: 0, stage: 'none', head: '还没选根因。', items: [] };
    }
    if (ans.cause !== c.cause.answer) {
      var chosen = c.cause.options[ans.cause];
      var right = c.cause.options[c.cause.answer];
      return {
        ok: false, score: 0, stage: 'cause',
        head: '根因不对，先别急着修。',
        items: [
          { tone: 'bad', title: '你选的是：' + chosen[0], text: chosen[1] },
          { tone: 'info', title: '证据指向的是：' + right[0], text: right[1] }
        ]
      };
    }
    if (ans.fix === null || ans.fix === undefined) {
      return { ok: false, score: 0, stage: 'pending', head: '根因对了，接下来选处置。', items: [] };
    }
    if (ans.fix !== c.fix.answer) {
      var cf = c.fix.options[ans.fix];
      var rf = c.fix.options[c.fix.answer];
      return {
        ok: false, score: 0.5, stage: 'fix',
        head: '查对了，但处置不对——这在实际工作里是最贵的一种错。',
        items: [
          { tone: 'bad', title: '你选的是：' + cf[0], text: cf[1] },
          { tone: 'info', title: '更合适的是：' + rf[0], text: rf[1] }
        ]
      };
    }
    return {
      ok: true, score: 1, stage: 'done',
      head: '根因和处置都对。',
      items: [{ tone: 'ok', title: c.fix.options[c.fix.answer][0], text: c.fix.options[c.fix.answer][1] }]
    };
  }

  root.TopoLab = {
    CASES: CASES,
    pick: pick,
    byId: byId,
    judge: judge,
    count: CASES.length
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoLab;
})(typeof globalThis !== 'undefined' ? globalThis : this);
