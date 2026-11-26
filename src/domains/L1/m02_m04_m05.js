(function (root) {
  'use strict';

  var F = root.TopoFactory;
  var REG = root.TopoRegistry;

  /* ============================ M02 整机解剖 ============================ */

  var M02 = {
    id: 'M02', plane: 'L1', title: '整机解剖',
    subtitle: '机箱里到底有什么，谁管谁',
    atoms: ['A', 'C', 'B'], requires: ['M00'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.match({
        id: 'M02', key: 's1', title: '认出机箱里的部件',
        make: function () {
          return {
            q: '打开一台 8 卡训练服务器的机箱。把部件和它的职责连起来。',
            left: [
              { id: 'l1', label: 'BMC' },
              { id: 'l2', label: 'DIMM 内存条' },
              { id: 'l3', label: 'NVMe 本地盘' },
              { id: 'l4', label: 'PCIe 桥 / 交换芯片' },
              { id: 'l5', label: 'PSU 电源模块' }
            ],
            right: [
              { id: 'r1', label: '独立芯片独立网口，带外管理，OS 挂了也能进' },
              { id: 'r2', label: '必须按通道插满，否则内存带宽腰斩' },
              { id: 'r3', label: '放数据集与 checkpoint，本地读取不占网络' },
              { id: 'r4', label: '把 CPU 有限的 PCIe lane 扇出给 8 张卡' },
              { id: 'r5', label: 'N+1 冗余，单块故障整机仍能满载' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4', l5: 'r5' },
            why: {
              l1: 'BMC 是主板上另一台小电脑，电源、风扇、远程控制台都归它。',
              l2: '双路 CPU 各有 8 个内存通道，插不满通道数，带宽直接按比例掉。',
              l3: '训练最怕数据加载成为瓶颈，本地 NVMe 是第一道缓冲。',
              l4: 'CPU 只有几十条 lane，8 张卡要靠交换芯片扇出。',
              l5: '8 卡机满载 7 kW，电源坏一块就降频甚至关机。'
            }
          };
        },
        hint: '按"它在管什么"去连，不要按名字像不像。',
        sideNote: '机箱里每一件都在解决一个具体的瓶颈，没有一件是凑数的。'
      }),
      F.calc({
        id: 'M02', key: 's2', title: '算机柜能放几台',
        make: function (r) {
          var u = r.pick([42, 47]);
          var serverU = r.pick([8, 4]);
          var left = u - 3;
          var n = Math.floor(left / serverU);
          return {
            q: '机柜可用高度 ' + u + 'U。要放 ' + serverU + 'U 的 GPU 服务器，\n' +
              '另外还要占 2U 交换机 + 1U PDU。\n\n' +
              '最多能放几台服务器？',
            expected: n, unit: '台', label: '台数', digits: 0,
            steps: ['可用 = ' + u + ' − 2 − 1 = ' + left + 'U',
              left + ' ÷ ' + serverU + ' = ' + (left / serverU).toFixed(2),
              '向下取整 = ' + n + ' 台，占到 ' + (n * serverU) + 'U'],
            misread: [{ f: 1.25, title: '没扣掉交换机和 PDU', text: '3U 是必须先扣掉的。' }],
            sideNote: '8U 机箱放 4 台就是 32U，剩下 10U 全被线缆和空隙吃掉。'
          };
        }
      }),
      F.pick({
        id: 'M02', key: 's3', atom: 'B', title: '只认出 6 张卡',
        cases: [
          {
            k: 'power', t: '8 卡机只识别到 6 张',
            world: {
              absent: [6, 7],
              kernel: [
                '[   12.334567] NVRM: GPU 00000000:47:00.0: RmInitAdapter failed! (0x26:0x56:1432)',
                '[   12.335001] NVRM: GPU 00000000:47:00.0: rm_init_adapter failed, device minor number 6',
                '[   12.335882] NVRM: GPU 00000000:49:00.0: RmInitAdapter failed! (0x26:0x56:1432)'
              ]
            },
            p: '一台 8 卡机开机后，nvidia-smi 只列出 6 张卡。\n' +
              'BMC 里看整机功率比正常低约 25%，缺失的两张卡位置固定（GPU6、GPU7）。\n' +
              'lspci 里能看到这两个 PCIe 设备，但驱动没加载。',
            o: [
              ['基板供电或该路 PCIe 链路异常，先看 BMC 的电源与 SEL 日志', '正确。固定位置 + 功率偏低 + lspci 可见但驱动不认，是典型的供电/链路侧问题，不是驱动。'],
              ['驱动版本不对，重装驱动', '不成立。驱动问题不会固定只影响两张、也不会让整机功率下降。'],
              ['CUDA_VISIBLE_DEVICES 限制了可见卡数', '不成立。这是环境变量层面的过滤，lspci 与功率都不该受影响。'],
              ['GPU 坏了，直接换卡', '不成立。先看日志再换件，否则换完可能还是一样。']
            ], a: 0
          },
          {
            k: 'lane', t: '卡在但带宽只有一半',
            world: {
              gpus: [
                { idx: 2, pcieWidth: 8, pcieGen: 5 },
                { idx: 5, pcieWidth: 8, pcieGen: 5 }
              ]
            },
            p: '8 张卡都在，但 nvidia-smi 显示其中两张的 PCIe 链路是 x8 而不是 x16，\n' +
              '拓扑表里这两张卡的码与其他卡不同。',
            o: [
              ['该卡所在插槽的 lane 被其他设备占用或金手指接触不良，检查插槽分配与重插', '正确。x8 说明只协商到一半 lane，多半是插槽共享或接触问题。'],
              ['显卡驱动限速', '不成立。驱动不会把链路宽度砍半。'],
              ['PCIe 代数下降', '不成立。代数下降会显示 Gen3/Gen4，宽度仍是 x16。'],
              ['GPU 温度过高降频', '不成立。降频影响频率，不影响链路宽度。']
            ], a: 0
          },
          {
            k: 'bmc', t: '装系统时看不到本地盘',
            p: 'PXE 装机进入安装界面，找不到 NVMe 盘。\n' +
              'BMC 的存储页面能看到 4 块盘，状态正常。',
            o: [
              ['RAID 卡或 NVMe 背板未切换到正确模式（直通 / RAID），需要在 BIOS 或 BMC 里改', '正确。BMC 能看到盘说明硬件在，OS 看不到说明控制器模式或驱动不对。'],
              ['硬盘全坏了', '不成立。BMC 显示状态正常。'],
              ['内存不足', '不成立。与存储枚举无关。'],
              ['网卡没插', '不成立。能进 PXE 说明网络是通的。']
            ], a: 0
          }
        ],
        hint: '先问三个问题：硬件在不在（BMC/lspci）、驱动认不认、配置拦没拦。',
        sideNote: '排障的第一原则是分层：带外 → 固件 → 驱动 → 系统 → 应用。'
      })
    ],
    knowledge: {
      concept: '一台 8 卡机由主板、2 颗 CPU、16 条内存、8 张 GPU、1 块基板（含 NVSwitch）、若干 NVMe、网卡、电源和一颗 BMC 组成。',
      why: '每一件都在解决一个具体瓶颈：PCIe 交换芯片解决 lane 不够，内存通道解决带宽，BMC 解决"系统挂了怎么救"。知道谁管谁，才排得动故障。',
      pitfalls: [
        '内存只插容量不管通道。双路各 8 通道，插 4 条就是 1/4 带宽。',
        '把"设备在"当成"能用"。lspci 能看到但驱动不加载，是供电或链路问题。',
        '一上来就换件。先看 BMC 的 SEL 日志和功率读数，能省一半时间。'
      ],
      verify: 'lspci -tv 看树，nvidia-smi -q 看链路宽度与代数，ipmitool sel list 看硬件事件。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M02.quiz');
      return R.shuffle([
        { q: '8 卡机里为什么需要 PCIe 交换芯片？', options: ['为了好看', 'CPU 的 PCIe lane 不够 8 张卡用', '为了供电', '为了散热'], answer: 1, why: '一颗 CPU 通常只有 64~80 条 lane，8 张 x16 卡需要 128 条，必须扇出。' },
        { q: 'OS 里看不到盘，但 BMC 能看到，最可能是什么？', options: ['盘坏了', '控制器模式或驱动不对', '电源不足', '内存坏了'], answer: 1, why: 'BMC 绕过 OS 直接看硬件，两边不一致说明问题在控制器模式或驱动层。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M04 GPU 架构 ============================ */

  var M04 = {
    id: 'M04', plane: 'L1', title: 'GPU 架构',
    subtitle: '显存、算力、MIG，以及它们怎么算',
    atoms: ['C', 'B', 'A'], requires: ['M02'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M04', key: 's1', title: '算训练显存',
        make: function (r) {
          var p = r.pick([7, 13, 70]);
          var kind = r.int(3);
          if (kind === 0) {
            return {
              q: '用 Adam 全量微调一个 ' + p + 'B 参数的模型，混合精度训练。\n' +
                '显存开销：权重 2 字节/参数、梯度 2 字节/参数、Adam 的一阶二阶动量各 4 字节/参数。\n' +
                '（先不算激活值和临时缓冲）\n\n至少要多少 GB 显存？',
              expected: p * 12, unit: 'GB', label: '显存', digits: 0,
              steps: ['每参数 2 + 2 + 4 + 4 = 12 字节',
                p + 'B × 12 = ' + (p * 12) + ' GB',
                '80GB 的卡装不下 ' + p + 'B 的全量微调，必须切分或换 8-bit 优化器'],
              misread: [{ f: 0.333, title: '漏了优化器状态', text: 'Adam 的 m 和 v 各 4 字节，是显存大头。' },
                { f: 0.167, title: '只算了权重', text: '推理才只算权重。训练要加梯度和优化器状态。' }],
              sideNote: '这就是为什么 7B 模型全量微调也要 80GB 卡。'
            };
          }
          if (kind === 1) {
            return {
              q: '同一个 ' + p + 'B 模型，改用 8-bit 优化器（权重与梯度仍 2 字节，动量各 1 字节）。\n\n至少要多少 GB 显存？',
              expected: p * 6, unit: 'GB', label: '显存', digits: 0,
              steps: ['每参数 2 + 2 + 1 + 1 = 6 字节', p + 'B × 6 = ' + (p * 6) + ' GB',
                '比 FP32 优化器省一半，这是 QLoRA 之外最常见的省显存手段'],
              misread: [{ f: 2, title: '按 FP32 优化器算了', text: '8-bit 优化器每参数 1 字节，不是 4 字节。' }],
              sideNote: '省下来的显存可以直接换成更大的 batch。'
            };
          }
          return {
            q: '把 ' + p + 'B 模型用 FP16 做纯推理（batch=1，不算 KV cache）。\n\n光权重占多少 GB？',
            expected: p * 2, unit: 'GB', label: '权重', digits: 0,
            steps: ['FP16 = 2 字节/参数', p + 'B × 2 = ' + (p * 2) + ' GB',
              '推理还要加 KV cache，实测占用通常是权重的 1.2~1.5 倍'],
            misread: [{ f: 6, title: '按训练算了', text: '推理只有权重，没有梯度和优化器状态。' }],
            sideNote: '推理显存 = 权重 + KV cache + 框架开销，后两项常被低估。'
          };
        }
      }),
      F.pick({
        id: 'M04', key: 's2', atom: 'B', title: '利用率高但吞吐低',
        cases: [
          {
            k: 'mem', t: 'GPU 利用率 98%，吞吐只有基线一半',
            p: '训练脚本在 8 卡机上跑，nvidia-smi 显示 8 张卡利用率常年在 97%~99%，\n' +
              '但每秒处理的 token 数只有同型号基线的一半。\n\n' +
              'dmon 里 sm__throughput 很高，dram__throughput 也接近 100%。',
            o: [
              ['卡在显存带宽上，是典型的 memory-bound；要减少数据搬运或换更高带宽的卡', '正确。SM 与 DRAM 同时打满说明不是算力不够，而是每算一次都要等数据。'],
              ['GPU 降频了，看温度和功耗墙', '不成立。降频会表现为利用率或频率异常，而这里两个吞吐都满了。'],
              ['PCIe 带宽不足', '不成立。训练在卡内计算，PCIe 只在通信阶段才忙。'],
              ['数据加载慢', '不成立。数据加载慢会让利用率掉下来，不是打满。']
            ], a: 0
          },
          {
            k: 'throttle', t: '跑十分钟后性能掉两成',
            p: '刚开始训练时吞吐正常，10 分钟后掉到 80%，温度 87℃，SM 频率从 1.7GHz 降到 1.3GHz，\n' +
              '功耗读数稳定在 700W。',
            o: [
              ['撞到温度墙触发降频，检查散热与风道，必要时限制功耗曲线', '正确。频率下降 + 温度高位 + 功耗已到 TDP，是标准的温度墙。'],
              ['显存不够导致换页', '不成立。显存不足会直接 OOM，不会表现为频率下降。'],
              ['网卡限速', '不成立。网速不影响 SM 频率。'],
              ['CPU 降频', '不成立。SM 频率是 GPU 自己的时钟。']
            ], a: 0
          },
          {
            k: 'mig', t: '切了 MIG 之后单任务反而更慢',
            p: '把一张 80GB 卡切成 7 个 1g.10gb 实例，7 个推理任务并行。\n' +
              '每个任务的延迟比独占整卡时高了约 6 倍。',
            o: [
              ['MIG 是硬切分，每个实例只拿到 1/7 的算力和 10GB 显存，单任务变慢是预期行为', '正确。MIG 换的是隔离性和并行度，不是单任务性能。'],
              ['MIG 配置错了，要重切', '不成立。行为符合 MIG 的定义。'],
              ['显存带宽被限制', '部分对，但根因是算力也只给了 1/7，不只是带宽。'],
              ['驱动不支持 MIG', '不成立。能切出来就说明支持。']
            ], a: 0
          }
        ],
        hint: '先分清"利用率低"和"利用率高但慢"：前者是等，后者是堵。',
        sideNote: '利用率 100% 不等于跑得快。要看它把时间花在算还是等。'
      }),
      F.match({
        id: 'M04', key: 's3', title: '认精度与切分',
        make: function () {
          return {
            q: '把四个 GPU 侧的术语和它们的实际含义连起来。',
            left: [
              { id: 'l1', label: 'MIG 1g.10gb' },
              { id: 'l2', label: 'FP16' },
              { id: 'l3', label: 'FP8' },
              { id: 'l4', label: 'TF32' }
            ],
            right: [
              { id: 'r1', label: '硬切出 1/7 算力 + 10GB 显存，实例间互不干扰' },
              { id: 'r2', label: '2 字节浮点，训练默认精度' },
              { id: 'r3', label: '1 字节，需要缩放因子，吞吐约为 FP16 的两倍' },
              { id: 'r4', label: '19 位总宽、10 位尾数，A100 之后的默认张量核心精度' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' },
            why: {
              l1: 'MIG 是按 GPC 和显存切片硬隔离，不是配额。',
              l2: 'FP16 是训练的事实标准，数值范围和精度够用。',
              l3: 'FP8 需要 per-tensor 缩放，H100 之后才有原生支持。',
              l4: 'TF32 是"用 FP32 的范围、FP16 的速度"，默认开启后很多人以为自己在跑 FP32。'
            }
          };
        },
        hint: '按"几个字节"和"切不切卡"两个维度分。',
        sideNote: '精度决定了显存和吞吐，MIG 决定了隔离和并行度，两者经常被混为一谈。'
      })
    ],
    knowledge: {
      concept: 'GPU 是一台"算力 + 显存 + 显存带宽"三者必须匹配的机器。训练显存 ≈ 参数 × 12 字节（Adam 全量），推理 ≈ 参数 × 2 字节 + KV cache。',
      why: '显存决定能不能装下，带宽决定算得快不快，算力决定上限。三者任一不足，表现都是"慢"，但解法完全不同。',
      pitfalls: [
        '只算权重。训练还要梯度和优化器状态，是权重的 6 倍。',
        '把利用率当性能。利用率 100% 只说明卡没闲着，可能在等数据。',
        '以为 MIG 能提升单任务性能。它是切分，单任务只会更慢。'
      ],
      verify: 'nvidia-smi -q 看显存与频率，dmon 看 sm/dram 吞吐，ncu 看单核瓶颈。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M04.quiz');
      return R.shuffle([
        { q: '7B 模型 Adam 全量微调，光权重+梯度+优化器状态要多少显存？', options: ['14 GB', '42 GB', '84 GB', '168 GB'], answer: 2, why: '每参数 12 字节，7B × 12 = 84 GB。' },
        { q: 'MIG 切分后，单个实例的性能会怎样？', options: ['和整卡一样', '按切分比例下降', '反而更快', '取决于网络'], answer: 1, why: 'MIG 是硬切分，1/7 的实例只有 1/7 的算力。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M05 NVLink ============================ */

  var M05 = {
    id: 'M05', plane: 'L1', title: 'NVLink 与 NVSwitch',
    subtitle: '卡间专线，和它撑起的那个"域"',
    atoms: ['A', 'C', 'B'], requires: ['M03', 'M04'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.sort({
        id: 'M05', key: 's1', title: '按带宽排一遍',
        make: function () {
          return {
            q: '把下面五条链路，按"有效单向带宽"从高到低排。',
            items: [
              { id: 'nv', label: 'NVLink 4（H100 卡间）900 GB/s' },
              { id: 'nic', label: '400G 网卡 50 GB/s' },
              { id: 'pix', label: 'PCIe 5.0 x16 P2P 约 24.7 GB/s' },
              { id: 's25', label: '25G 存储网 3.1 GB/s' },
              { id: 'mg', label: '1G 管理网 0.125 GB/s' }
            ],
            correct: ['nv', 'nic', 'pix', 's25', 'mg'],
            why: [
              'NVLink 是卡间专线，比任何外部网络都快一个数量级。',
              '400G 网卡是跨机通信的入口，50 GB/s。',
              '注意它比网卡还慢：卡与卡走 PCIe，反而不如走网卡快。',
              '存储网只服务 checkpoint，不需要更快。',
              '管理网只跑 SSH 和监控。'
            ]
          };
        },
        hint: '先统一单位到 GB/s，再排。400G 是 50，不是 400。',
        sideNote: '这张排序表解释了一件事：为什么同机通信要尽量走 NVLink，而不是"反正都在一台机器里"。'
      }),
      F.calc({
        id: 'M05', key: 's2', title: '算专线省了多少',
        make: function (r) {
          var s = r.pick([4, 8, 16]);
          var kind = r.int(3);
          var pcie = 24.7, nv = 900;
          if (kind === 0) {
            return {
              q: '两张 GPU 之间搬 ' + s + ' GB 数据。\n' +
                '走 PCIe（同一交换芯片，实测 24.7 GB/s），需要多少毫秒？',
              expected: s / pcie * 1000, unit: 'ms', label: '耗时', digits: 1,
              steps: [s + ' GB ÷ 24.7 GB/s = ' + (s / pcie).toFixed(3) + ' s',
                '× 1000 = ' + (s / pcie * 1000).toFixed(1) + ' ms',
                '这个数字放在每一步 all-reduce 里，就是训练慢的直接原因'],
              sideNote: 'PCIe 的 24.7 是实测 P2P 值，不是理论 32。'
            };
          }
          if (kind === 1) {
            return {
              q: '同样 ' + s + ' GB，走 NVLink 4（900 GB/s），需要多少毫秒？',
              expected: s / nv * 1000, unit: 'ms', label: '耗时', digits: 1,
              steps: [s + ' GB ÷ 900 GB/s = ' + (s / nv).toFixed(4) + ' s',
                '× 1000 = ' + (s / nv * 1000).toFixed(1) + ' ms'],
              sideNote: '900 GB/s 是每张卡的双向带宽，单向按 450 算更保守。'
            };
          }
          return {
            q: '同一份 ' + s + ' GB 数据，走 PCIe 24.7 GB/s 与走 NVLink 900 GB/s，\n' +
              '耗时相差多少倍？',
            expected: nv / pcie, unit: '倍', label: '倍数', digits: 1,
            steps: ['比值 = 900 ÷ 24.7 = ' + (nv / pcie).toFixed(1),
              '也就是走 PCIe 要花 ' + (nv / pcie).toFixed(0) + ' 倍的时间',
              '所以 8 卡训练必须让通信留在 NVLink 域内'],
            misread: [{ f: 0.0274, title: '倒过来了', text: '问的是"PCIe 慢多少倍"，不是"NVLink 快多少倍"的倒数写法。' }],
            sideNote: '这个 36 倍，就是 8 卡机为什么要装 NVSwitch 的全部理由。'
          };
        }
      }),
      F.pick({
        id: 'M05', key: 's3', atom: 'B', title: '训练挂了，卡掉出域',
        cases: [
          {
            k: 'link', t: '训练卡住，一张卡掉出 NVLink 域',
            world: {
              gpus: [{ idx: 3, nvlinkBad: 5, nvlinkCrc: 4280 }],
              kernel: [
                '[ 8021.100234] NVRM: Xid (PCI:0000:41:00): 74, pid=20481, NVLink: error 0x1f',
                '[ 8021.101887] nvidia-nvswitch: NVSW0 link 21 down (peer GPU3 link 5)'
              ]
            },
            p: '训练在第 3 个 epoch 卡住不动，NCCL 报 timeout。\n' +
              'nvidia-smi topo -m 里 GPU3 那一行从 NV8 变成了 SYS；\n' +
              'dmesg 里有 XID 74，nvidia-fabricmanager 日志报 NVSwitch 端口 down。',
            o: [
              ['NVLink 链路或 NVSwitch 端口故障，先查 fabricmanager 日志与链路计数，再复位或报修', '正确。拓扑表变化 + XID 74 + 端口 down 三点一致，指向物理链路。'],
              ['NCCL 版本不兼容，升级 NCCL', '不成立。版本问题不会让拓扑表从 NV8 变 SYS。'],
              ['网卡故障', '不成立。NVLink 与网卡是两套硬件。'],
              ['显存 ECC 报错', '不成立。ECC 会报 XID 48/63，不会改拓扑。']
            ], a: 0
          },
          {
            k: 'fm', t: '整机 GPU 都看不到 NVSwitch',
            p: '重启后 nvidia-smi 能看到 8 张卡，但 topo -m 全部显示 SYS，\n' +
              'nvidia-fabricmanager 服务启动失败，日志里报版本不匹配。',
            o: [
              ['fabricmanager 版本必须与驱动版本严格一致，装对应版本并重启服务', '正确。这是 NVSwitch 机型最常见的"装完驱动忘了装对版本"的坑。'],
              ['NVSwitch 硬件坏了', '不成立。日志明确写的是版本不匹配。'],
              ['需要重装 CUDA', '不成立。CUDA 与 fabricmanager 是两层。'],
              ['BIOS 里没开 NVLink', '不成立。PCIe 机型才需要在 BIOS 里配，SXM 机型由 fabricmanager 管理。']
            ], a: 0
          },
          {
            k: 'topo', t: '拓扑表里两张卡是 PIX 不是 NV8',
            p: '一台 8 卡机，topo -m 里 GPU0 与 GPU1 显示 PIX，其余 GPU 之间都是 NV8。\n' +
              '这台机器是 SXM 基板机型。',
            o: [
              ['该卡的 NVLink 未启用或链路未起来，检查 fabricmanager 状态与链路计数', '正确。SXM 机型上出现 PIX 说明这张卡退化到走 PCIe 了。'],
              ['这两张卡本来就是 PCIe 卡', '不成立。同一台 SXM 基板不会混插。'],
              ['PIX 是正常状态', '不成立。SXM 机型卡间应当全是 NV8。'],
              ['需要打开 P2P', '不成立。P2P 是 PCIe 侧的概念。']
            ], a: 0
          }
        ],
        hint: '先看拓扑表变没变。表变了是物理层，表没变是配置层。',
        sideNote: 'NVLink 故障几乎都能从 topo -m 一眼看出来：NV8 变 SYS 就是链路没了。'
      })
    ],
    knowledge: {
      concept: 'NVLink 是 GPU 之间的专用高速链路，NVSwitch 让 8 张（甚至 72 张）卡两两全互联。它构成一个"域"，域内通信不走 PCIe、不走网络。',
      why: '8 卡训练的每一步都要 all-reduce。走 PCIe 比走 NVLink 慢 30 倍以上，这就是 HGX 基板存在的全部理由。',
      pitfalls: [
        '以为同机就一定走 NVLink。SXM 机型掉链后会退化成 PIX/SYS。',
        '忘了 fabricmanager。NVSwitch 机型不装或版本不匹配，NVLink 完全不工作。',
        '把 NVLink 带宽当成单向。900 GB/s 通常是双向合计。'
      ],
      verify: 'nvidia-smi topo -m 看码，nvidia-smi nvlink -s 看每条链路状态，fabricmanager 日志看端口事件。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M05.quiz');
      return R.shuffle([
        { q: 'H100 的 NVLink 4 每卡带宽是多少？', options: ['100 GB/s', '450 GB/s', '900 GB/s', '1800 GB/s'], answer: 2, why: 'NVLink 4 是 900 GB/s（双向合计），NVLink 5 才到 1.8 TB/s。' },
        { q: 'NVSwitch 机型上 topo 显示 SYS 说明什么？', options: ['正常', '该卡 NVLink 没起来，退化走 PCIe', '需要开 P2P', '网卡有问题'], answer: 1, why: 'SXM 机型卡间应当全是 NV8，出现 SYS 就是链路掉了。' }
      ]).slice(0, 2);
    }
  };

  REG.declare(M02);
  REG.declare(M04);
  REG.declare(M05);

  root.M02 = M02;
  root.M04 = M04;
  root.M05 = M05;
})(typeof globalThis !== 'undefined' ? globalThis : this);
