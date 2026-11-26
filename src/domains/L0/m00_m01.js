(function (root) {
  'use strict';

  var F = root.TopoFactory;
  var REG = root.TopoRegistry;

  /* ============================ M00 机房与机柜 ============================ */

  var M00 = {
    id: 'M00', plane: 'L0', title: '机房与机柜',
    subtitle: '功率密度、供电冗余、制冷路径',
    atoms: ['C', 'B', 'A'], requires: [],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M00', key: 's1', title: '算机柜功率',
        make: function (r) {
          var racks = r.pick([4, 6, 8]);
          var gpus = 8;
          var watt = 700;
          var other = 1.5;
          var kind = r.int(3);
          var it = racks * (gpus * watt / 1000 + other);
          if (kind === 0) {
            return {
              q: '一个机柜放 ' + racks + ' 台 8 卡服务器。\n' +
                '每张 GPU 满载 ' + watt + 'W，每台整机的 CPU / 内存 / 本地盘 / 风扇再算 ' + other + ' kW。\n\n' +
                '这一柜的 IT 负载是多少 kW？',
              expected: it, unit: 'kW', label: 'IT 负载', digits: 1,
              steps: ['单台 = ' + gpus + ' × ' + watt + 'W = ' + (gpus * watt / 1000) + ' kW，再 + ' + other + ' kW 整机 = ' + (gpus * watt / 1000 + other) + ' kW',
                racks + ' 台 = ' + (gpus * watt / 1000 + other) + ' × ' + racks + ' = ' + it + ' kW',
                '注意：GPU 功耗只是整机的一部分，漏掉 ' + other + ' kW 会少算两成'],
              misread: [{ f: 0.79, title: '少算了整机功耗', text: '只乘了 GPU 功耗。整机的 CPU、内存、盘、风扇还要再加。' }],
              sideNote: '风冷单柜上限约 15 kW，超过就必须上冷板或浸没。'
            };
          }
          if (kind === 1) {
            return {
              q: '某柜 IT 负载 ' + (it / 1).toFixed(1) + ' kW，机房 PUE 为 1.4。\n\n' +
                '整个机房的总功耗（IT + 制冷 + 配电损耗）是多少 kW？',
              expected: it * 1.4, unit: 'kW', label: '总功耗', digits: 1,
              steps: ['PUE = 总功耗 ÷ IT 负载', '总功耗 = ' + it.toFixed(1) + ' × 1.4 = ' + (it * 1.4).toFixed(1) + ' kW', '多出来的 ' + (it * 0.4).toFixed(1) + ' kW 全花在制冷和配电上'],
              misread: [{ f: 0.714, title: '把 PUE 当成了损耗率', text: 'PUE 是倍数不是百分比。1.4 的意思是总功耗是 IT 的 1.4 倍。' }],
              sideNote: 'PUE 1.2 以下算优秀，1.4 是普通机房，1.8 以上基本是风冷老机房。'
            };
          }
          return {
            q: '某柜 IT 负载 ' + it.toFixed(1) + ' kW，PUE 1.4，电价 0.6 元/度。\n\n' +
              '这一柜一年的电费是多少万元？（一年按 8760 小时）',
            expected: it * 1.4 * 8760 * 0.6 / 10000, unit: '万元', label: '年电费', digits: 1,
            steps: ['总功耗 = ' + it.toFixed(1) + ' × 1.4 = ' + (it * 1.4).toFixed(1) + ' kW',
              '年耗电 = ' + (it * 1.4).toFixed(1) + ' × 8760 = ' + Math.round(it * 1.4 * 8760) + ' 度',
              '电费 = ' + Math.round(it * 1.4 * 8760) + ' × 0.6 ÷ 10000 = ' + (it * 1.4 * 8760 * 0.6 / 10000).toFixed(1) + ' 万元'],
            misread: [{ f: 0.714, title: '漏了 PUE', text: '只算了 IT 负载的电费，把制冷那一份漏了。' }],
            sideNote: '一台 8 卡机的电费，五年下来常常超过半张卡的钱。'
          };
        }
      }),
      F.pick({
        id: 'M00', key: 's2', atom: 'B', title: '判 UPS 告警',
        cases: [
          {
            k: 'overload', t: '机柜频繁触发 UPS 过载告警',
            p: '某柜 8 台 8 卡机，双路 PDU 各接一路 UPS。\n' +
              '上线后每台机器满载跑训练，UPS 就开始报过载，但市电侧总闸没跳。\n\n' +
              'PDU 面板读数：A 路 31 kW，B 路 24 kW，额定单路 32 kW。',
            o: [
              ['两路 PDU 负载严重不均，A 路已接近额定，需要重新分配电源线', '正确。31 与 24 kW 差了 7 kW，A 路只剩 3% 余量。双路是"任一路都能带全载"，不是"两路各带一半"。'],
              ['UPS 容量买小了，要换更大功率的 UPS', '不成立。总负载 55 kW 没超过两路合计的 64 kW，问题是分配不均，不是总量不足。'],
              ['服务器电源效率太低，换钛金电源', '不成立。效率影响的是 1~2 个百分点，不会造成 7 kW 的偏载。'],
              ['机房温度过高导致 UPS 降额', '不成立。真降额会两路一起报，不会只有 A 路。']
            ], a: 0
          },
          {
            k: 'phase', t: '同一柜的设备总是跳闸',
            p: '新机柜上电，只要同时启动 8 台机器，总空开就跳。\n' +
              '逐台启动没问题，测量三相电流：L1 42A、L2 18A、L3 20A。',
            o: [
              ['三相严重不平衡，把电源线按相序重新分配', '正确。三相不平衡会让中性线电流剧增并触发保护。42/18/20 已经是明显的偏相。'],
              ['总空开额定电流选小了', '不成立。三相之和没超，是分配问题导致单相过流。'],
              ['服务器电源有浪涌，加装软启动', '不成立。逐台启动正常，说明不是浪涌叠加。'],
              ['接地电阻不合格', '不成立。接地问题会表现为漏保跳闸，不是过流跳闸。']
            ], a: 0
          },
          {
            k: 'cool', t: '机柜进风温度正常，出风烫手',
            p: '冷通道 22℃，机柜前门进风 23℃，但柜顶出风 48℃。\n' +
              'GPU 温度持续在 85℃ 以上并开始降频。',
            o: [
              ['柜内存在热风回流或盲板缺失，冷风短路，需要补盲板并整理走线', '正确。进风正常而出风极热，说明柜内风量不足或冷热风混流。'],
              ['冷通道温度设太高，调低到 18℃', '不成立。进风 23℃ 完全正常，问题在柜内。'],
              ['GPU 散热器坏了', '不成立。8 台机器同时出问题，不会是硬件集体损坏。'],
              ['机房 PUE 太高', '不成立。PUE 是能效指标，不直接导致单柜过热。']
            ], a: 0
          }
        ],
        hint: '先看数字：两路读数、三相电流、进出风温度。哪个数字本身就不合理？',
        sideNote: '机柜问题九成能在"读数"里看出来：偏载、偏相、温差。'
      }),
      F.sort({
        id: 'M00', key: 's3', title: '排散热路径',
        make: function () {
          return {
            q: '把一台风冷 8 卡机的散热路径，从冷源到回到冷源排一遍。',
            items: [
              { id: 'crac', label: 'CRAC 精密空调送出冷风' },
              { id: 'cold', label: '冷通道（地板下送风）' },
              { id: 'door', label: '机柜前门进风' },
              { id: 'fan', label: '服务器风扇' },
              { id: 'sink', label: 'GPU 散热器 / 冷板' },
              { id: 'hot', label: '机柜后门 → 热通道' },
              { id: 'back', label: 'CRAC 回风' }
            ],
            correct: ['crac', 'cold', 'door', 'fan', 'sink', 'hot', 'back'],
            why: [
              '冷源在最前面，没有它后面全是空谈。',
              '冷风先到冷通道，再进柜。',
              '进风温度是判断机房是否正常的第一个读数。',
              '风扇负责把冷风压过散热器，是耗电大户。',
              '热量真正被带走的地方在散热器，不在芯片表面。',
              '热风必须被约束在热通道，混流就前功尽弃。',
              '回风温度决定 CRAC 的负载，也决定 PUE。'
            ]
          };
        },
        hint: '找"热的来源"和"热的终点"：热量在 GPU 上产生，最后要回到空调。',
        sideNote: '这条链路任何一段出问题，表现都是"GPU 温度高"，但根因可能在天花板后面。'
      })
    ],
    knowledge: {
      concept: '机房是一个"供电 + 散热"的容器。机柜的功率密度决定了你能放什么机器，制冷方式决定了你能放多密。',
      why: '算力不是插上电就能跑。8 卡机满载接近 7 kW，一台柜塞 8 台就是 57 kW，风冷根本压不住。所有上层的性能问题，先要确认电和冷没有卡住。',
      pitfalls: [
        '把双路 PDU 当成"各带一半"。双路是任一路都能带全载，两路必须均衡，偏载就是隐患。',
        '只算 GPU 功耗。整机的 CPU、内存、盘、风扇还要再加 15%~20%。',
        '以为 PUE 是损耗百分比。PUE 1.4 表示总功耗是 IT 的 1.4 倍，不是损耗 40%。'
      ],
      verify: '上架前先算：机柜 IT 功率 × 1.2 余量 < 单路 PDU 额定；再看制冷方式能不能扛住这个密度。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M00.quiz');
      return R.shuffle([
        { q: '风冷机柜的功率密度上限大约是多少？', options: ['5 kW', '15 kW', '50 kW', '100 kW'], answer: 1, why: '风冷大约 15 kW/柜封顶，再往上必须换冷板液冷或浸没。' },
        { q: '双路 PDU 的正确理解是？', options: ['两路各承担一半负载', '任一路都能独立承担全载', '两路轮流供电', '一路市电一路 UPS'], answer: 1, why: '冗余的意思是坏一路另一路能顶上，所以每路都要按全载设计，且两路要均衡。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M01 布线 · 三网分离 ============================ */

  var M01 = {
    id: 'M01', plane: 'L0', title: '布线、光模块与三网分离',
    subtitle: '计算网 / 存储网 / 管理网，为什么要分开',
    atoms: ['A', 'C', 'B'], requires: ['M00'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.match({
        id: 'M01', key: 's1', title: '认出四张网',
        make: function (r) {
          return {
            q: '一台 8 卡训练服务器上有四类网口。把它们和各自的职责连起来。',
            left: [
              { id: 'l1', label: '计算网（IB / RoCE）' },
              { id: 'l2', label: '存储网（以太）' },
              { id: 'l3', label: '带内管理网' },
              { id: 'l4', label: '带外管理（BMC）' }
            ],
            right: [
              { id: 'r1', label: '200G~400G，跑 all-reduce 梯度与参数同步' },
              { id: 'r2', label: '25G，挂并行文件系统，读写 checkpoint' },
              { id: 'r3', label: '1G，SSH 登录、拉监控、传日志' },
              { id: 'r4', label: '独立小口，OS 挂了也能进控制台' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' },
            why: {
              l1: '计算网的时延和带宽直接决定训练效率，必须独立组网、不走三层转发。',
              l2: 'checkpoint 是突发大流量，和计算网混在一起会把梯度同步挤掉。',
              l3: '运维流量很小但绝不能断，混进计算网就会被大流量饿死。',
              l4: 'BMC 是独立芯片独立网口，服务器宕机、系统装不上时唯一的入口。'
            }
          };
        },
        hint: '按"流量大小"和"断了会怎样"两个维度去分。',
        sideNote: '三网分离不是为了好看，是为了"一种流量出事不牵连另外两种"。'
      }),
      F.calc({
        id: 'M01', key: 's2', title: '算出口带宽',
        make: function (r) {
          var nodes = r.pick([8, 16, 32]);
          var rails = 8;
          var speed = 400;
          var kind = r.int(2);
          var perNode = rails * speed / 8;
          if (kind === 0) {
            return {
              q: '一台 8 卡机配 ' + rails + ' 张 ' + speed + 'G 网卡，一卡对一卡（8 个 rail）。\n\n' +
                '这台机器的计算网总出口带宽是多少 GB/s？',
              expected: perNode, unit: 'GB/s', label: '单机出口', digits: 1,
              steps: [speed + ' Gbps ÷ 8 = ' + (speed / 8) + ' GB/s（每张卡）',
                rails + ' 张 × ' + (speed / 8) + ' = ' + perNode + ' GB/s',
                '注意 Gbps 与 GB/s 差 8 倍，这是最常见的错'],
              misread: [{ f: 8, title: 'Gbps 当成了 GB/s', text: '400G 是 400 Gbps，除以 8 才是 50 GB/s。' }],
              sideNote: '8 个 rail 意味着 8 张卡各走各的网卡，没有两张卡抢一张卡。'
            };
          }
          return {
            q: '集群有 ' + nodes + ' 台 8 卡机，每台 8 张 ' + speed + 'G 网卡。\n\n' +
              '整个计算网的下行总带宽是多少 TB/s？',
            expected: nodes * perNode / 1000, unit: 'TB/s', label: '全网带宽', digits: 2,
            steps: ['单机 = 8 × 50 = 400 GB/s',
              nodes + ' 台 × 400 = ' + (nodes * perNode) + ' GB/s',
              '换算 = ' + (nodes * perNode / 1000) + ' TB/s'],
            misread: [{ f: 8, title: 'Gbps 当成了 GB/s', text: '整条链路都少除了 8。' }],
            sideNote: '这就是为什么 32 台机器的集群，网络预算能顶上半台存储阵列。'
          };
        }
      }),
      F.pick({
        id: 'M01', key: 's3', atom: 'B', title: '判链路误码',
        cases: [
          {
            k: 'dirty', t: '一条链路误码率高，模块指示灯正常',
            p: '某台机器的 IB 端口 CRC 错误计数持续增长，速率协商正常（400G），\n' +
              '光模块指示灯绿色，换端口无效，换机器无效，换模块后恢复。',
            o: [
              ['光模块端面污染或连接器脏，需要清洁或更换模块', '正确。换模块就好、换端口无效，指向模块本体或端面。'],
              ['交换机端口坏了', '不成立。换端口无效，说明不是端口问题。'],
              ['光纤极性接反', '不成立。极性接反会直接链路 down，不会是"通但有误码"。'],
              ['服务器 PCIe 带宽不足', '不成立。CRC 是光链路层计数，与 PCIe 无关。']
            ], a: 0
          },
          {
            k: 'polarity', t: '新布的一批链路全部 down',
            p: '新机房布了 64 条 MPO 主干，上电后 32 条正常、32 条完全 down。\n' +
              '模块型号一致，长度一致，端口配对按图纸做的。',
            o: [
              ['MPO 极性接反（A/B/C 型混用），需要统一极性或换转换跳线', '正确。一半好一半坏、且是整批，最典型的就是极性类型混用。'],
              ['光模块批次不良', '不成立。不良率不会恰好一半，也不会这么整齐。'],
              ['交换机端口配置错误', '不成立。配置错误通常整组不通，不会按 32 条切分。'],
              ['距离超过模块传输距离', '不成立。长度一致，不会一半超一半不超。']
            ], a: 0
          },
          {
            k: 'mix', t: '跨机带宽只有一半',
            p: '两台机器之间 all-reduce 只有 200G 左右，本机内正常。\n' +
              '查两端：一端插的是 400G DR4，另一端插的是 400G FR4，中间跳线是单模。',
            o: [
              ['DR4 与 FR4 的波长和传输距离不同，混用导致部分 lane 无法建链，需要两端模块型号一致', '正确。DR4 是 500m 短距并行，FR4 是 2km 波分，混插会退化甚至只起部分 lane。'],
              ['光纤长度不够', '不成立。长度只影响能不能通，不会让带宽减半。'],
              ['交换机限速配置', '不成立。限速会有明确配置痕迹，且通常是整数速率。'],
              ['网卡固件版本不一致', '不成立。固件不一致一般影响功能，不直接砍一半带宽。']
            ], a: 0
          }
        ],
        hint: '先分清"通不通"和"通得好不好"：极性、距离、波长各管一头。',
        sideNote: '链路问题先看计数器：CRC、symbol error、lane 状态，比看灯靠谱。'
      })
    ],
    knowledge: {
      concept: '一台 AI 服务器至少有三张网：计算网跑梯度、存储网读写 checkpoint、管理网做运维；再加一条带外管理，OS 挂了也能进。',
      why: '三种流量的特征完全不同：计算网要极低时延，存储网是突发大包，管理网流量小但不能断。混在一起，任何一方出事都会牵连另外两方。',
      pitfalls: [
        '把 Gbps 当 GB/s。400G 网卡是 50 GB/s，不是 400 GB/s，差 8 倍。',
        '以为链路"能通"就没问题。误码率高、只起部分 lane 的链路照样 up，但带宽减半。',
        '光模块混插。DR4 / FR4 / SR8 的波长和距离不同，两端必须匹配。'
      ],
      verify: '看交换机端口计数器：CRC 错误、symbol error、lane 状态；再跑一次 NCCL 的单机与跨机对比。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M01.quiz');
      return R.shuffle([
        { q: '400G 网卡的实际带宽是多少？', options: ['400 GB/s', '50 GB/s', '100 GB/s', '25 GB/s'], answer: 1, why: '400 Gbps ÷ 8 = 50 GB/s。' },
        { q: '为什么 checkpoint 流量不能和梯度同步共用一张网？', options: ['协议不兼容', '突发大流量会挤占计算网，拖慢训练', '存储网更便宜', 'IP 地址冲突'], answer: 1, why: 'checkpoint 是突发的超大包，和低时延的梯度同步混在一起必然互相伤害。' }
      ]).slice(0, 2);
    }
  };

  REG.declare(M00);
  REG.declare(M01);

  root.M00 = M00;
  root.M01 = M01;
})(typeof globalThis !== 'undefined' ? globalThis : this);
