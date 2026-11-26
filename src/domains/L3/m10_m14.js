(function (root) {
  'use strict';

  var F = root.TopoFactory;
  var REG = root.TopoRegistry;

  /* ============================ M10 网卡与 RDMA ============================ */

  var M10 = {
    id: 'M10', plane: 'L3', title: '网卡与 RDMA',
    subtitle: '400G 到底是多少，以及数据怎么绕开 CPU',
    atoms: ['C', 'A', 'B'], requires: ['M03'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M10', key: 's1', title: '算带宽时延积',
        make: function (r) {
          var rtt = r.pick([2, 5, 10]);
          var bw = r.pick([50, 25]);
          return {
            q: '一条 ' + (bw * 8) + 'G 链路，单向带宽 ' + bw + ' GB/s，端到端往返时延 ' + rtt + ' μs。\n\n' +
              '带宽时延积（BDP）是多少 KB？（1 GB = 10⁹ 字节）',
            expected: bw * rtt, unit: 'KB', label: 'BDP', digits: 0,
            steps: [bw + ' GB/s = ' + (bw * 1e9) + ' 字节/s',
              '× ' + rtt + ' μs（' + (rtt * 1e-6) + ' s）= ' + (bw * 1e9 * rtt * 1e-6) + ' 字节',
              '= ' + (bw * rtt) + ' KB'],
            misread: [{ f: 0.5, title: '按单向时延算了', text: 'BDP 用的是往返时延 RTT，不是单向。' }],
            sideNote: 'BDP 就是"管道里同时在飞的数据量"，它决定了窗口和缓冲要开多大。'
          };
        }
      }),
      F.match({
        id: 'M10', key: 's2', title: '认四种网络技术',
        make: function () {
          return {
            q: '把四个网络侧的技术和它的本质连起来。',
            left: [
              { id: 'l1', label: 'RoCEv2' },
              { id: 'l2', label: 'InfiniBand' },
              { id: 'l3', label: 'GPUDirect RDMA' },
              { id: 'l4', label: 'SR-IOV' }
            ],
            right: [
              { id: 'r1', label: '在以太网上跑 RDMA，必须靠 PFC/ECN 做成无损' },
              { id: 'r2', label: '专用网络，原生无损，自带拥塞控制' },
              { id: 'r3', label: '网卡直接读写 GPU 显存，全程不经过 CPU' },
              { id: 'r4', label: '一张物理网卡虚拟出多个 VF，直通给虚拟机或容器' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' },
            why: {
              l1: 'RoCE 是"用便宜以太网干 IB 的活"，代价是要自己造无损。',
              l2: 'IB 从协议层就为低时延设计，但生态封闭、成本高。',
              l3: '这是跨机训练能跑满的关键：数据从显存直接进网卡。',
              l4: 'SR-IOV 让容器/虚拟机拿到接近原生的网络性能。'
            }
          };
        },
        hint: '按"哪一层"分：链路协议、物理网络、数据路径、虚拟化。',
        sideNote: 'RoCE 和 IB 的差别不在速度，在"无损是买来的还是做出来的"。'
      }),
      F.pick({
        id: 'M10', key: 's3', atom: 'B', title: '带宽只跑到四分之一',
        cases: [
          {
            k: 'mtu', t: '小包跑不满，大包能跑满',
            p: '网卡协商 400G，NCCL 实测只有 20 GB/s。\n' +
              '用 ib_write_bw 测：64KB 以上能到 45 GB/s，4KB 只有 8 GB/s。',
            o: [
              ['小包性能受限于包速率（PPS）与中断/轮询开销，这是正常的；训练用的都是大包，应以大包结果为准', '正确。小包测的是 PPS 上限，不是带宽上限。'],
              ['网卡坏了', '不成立。大包能跑满说明硬件正常。'],
              ['交换机限速', '不成立。限速会在大包上同样生效。'],
              ['光模块不匹配', '不成立。不匹配会误码或降速，不会只影响小包。']
            ], a: 0
          },
          {
            k: 'rail', t: '两条流抢一张网卡',
            world: {
              nics: [
                { dev: 'mlx5_0', state: 'Active', rate: 400, numa: 0 },
                { dev: 'mlx5_1', state: 'Active', rate: 400, numa: 0 }
              ]
            },
            p: '8 卡机只插了 2 张 400G 网卡。跨机 all-reduce 时，\n' +
              '每张网卡上都有 4 张 GPU 的流量，实测每卡 48 GB/s 但整体只有 100 GB/s。',
            o: [
              ['8 卡只配 2 卡，出口带宽就是 100 GB/s 封顶，要提升必须补到 8 卡 8 rail', '正确。端口数是硬上限，流量分配再好也超不过 2×50。'],
              ['NCCL 参数没调好', '不成立。参数调不出物理端口。'],
              ['交换芯片带宽不足', '不成立。瓶颈在网卡数量。'],
              ['需要开 PFC', '不成立。与端口数无关。']
            ], a: 0
          },
          {
            k: 'cpu', t: 'RDMA 测试 CPU 占用异常高',
            p: 'ib_write_bw 跑出 45 GB/s，但 mpstat 显示 CPU 有 60% 花在软中断与 memcpy 上，\n' +
              '且延迟比同型号机器高一倍。',
            o: [
              ['RDMA 没有真正落地，走了 CPU 拷贝路径；检查 peermem、内存注册与 ibv_devinfo 的加速标志', '正确。真 RDMA 的 CPU 占用应接近 0。'],
              ['CPU 性能不足', '不成立。RDMA 的意义就是不占 CPU。'],
              ['网卡速率不够', '不成立。45 GB/s 已接近 400G 上限。'],
              ['交换机拥塞', '不成立。拥塞不表现为本地 memcpy。']
            ], a: 0
          }
        ],
        hint: '先分清"带宽上限"和"实际吞吐"：端口数、包长、是否走 CPU，三个都要排。',
        sideNote: 'RDMA 跑通不等于跑对。CPU 占用是最诚实的指标。'
      })
    ],
    knowledge: {
      concept: '400G 网卡 = 50 GB/s。RDMA 让网卡直接读写内存甚至显存，把 CPU 从数据路径上彻底摘掉。',
      why: '跨机训练的每一步都要交换梯度。走 CPU 拷贝，带宽掉一半、CPU 被打满、延迟翻倍。GPUDirect RDMA 是 8 卡机跨机跑满的前提。',
      pitfalls: [
        '把 400G 当 400 GB/s。差 8 倍。',
        '用小包测带宽。小包测的是 PPS，不是带宽。',
        '以为装了 RDMA 就一定走 RDMA。CPU 占用高说明退回了拷贝路径。'
      ],
      verify: 'ibv_devinfo 看端口状态，ib_write_bw 分别测 4KB 与 64KB，同时看 mpstat 的 CPU 占用。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M10.quiz');
      return R.shuffle([
        { q: '400G 网卡的带宽时延积（RTT 2μs）大约是多少？', options: ['10 KB', '100 KB', '1 MB', '10 MB'], answer: 1, why: '50 GB/s × 2μs = 100 KB。' },
        { q: '真 RDMA 传输时，CPU 占用应该是什么水平？', options: ['接近 0', '30% 左右', '50% 以上', '单核 100%'], answer: 0, why: '数据由网卡直接搬进内存/显存，CPU 只做控制面。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M11 无损与拥塞控制 ============================ */

  var M11 = {
    id: 'M11', plane: 'L3', title: '无损与拥塞控制',
    subtitle: 'PFC、ECN、DCQCN，以及 PFC 风暴',
    atoms: ['C', 'B', 'D'], requires: ['M10'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M11', key: 's1', title: '算 PFC 缓冲要多大',
        make: function (r) {
          var rtt = r.pick([10, 20, 30]);
          var bw = 50;
          return {
            q: '一个 400G 端口（50 GB/s）要开 PFC。\n' +
              '从发出暂停帧到对端真正停发，往返需要 ' + rtt + ' μs。\n\n' +
              '这个端口至少需要多少 KB 的 headroom 缓冲，才能保证不丢包？',
            expected: bw * rtt, unit: 'KB', label: '缓冲', digits: 0,
            steps: ['在 ' + rtt + ' μs 内，对端仍会继续发送',
              '50 GB/s × ' + rtt + ' μs = ' + (bw * rtt) + ' KB',
              '所以 headroom 必须 ≥ ' + (bw * rtt) + ' KB，否则暂停帧还没生效包就丢了'],
            misread: [{ f: 0.5, title: '按单程算了', text: '暂停帧要过去、对端要停下，是往返时间。' }],
            sideNote: '这就是为什么无损网络对交换机缓冲区要求极高，也是 PFC 会反压全网的原因。'
          };
        }
      }),
      F.pick({
        id: 'M11', key: 's2', atom: 'B', title: '全网吞吐塌了但没丢包',
        cases: [
          {
            k: 'storm', t: '吞吐塌到 10%，端口零丢包',
            p: '整个 rail 平面的有效吞吐突然掉到 10%，持续十几秒后恢复，反复发生。\n' +
              '端口统计：丢包 0，PFC pause 帧数量暴涨，某些端口持续收到 pause。',
            o: [
              ['PFC 反压扩散形成风暴（PFC storm / 死锁），需要检查 PFC 配置范围与 watchdog', '正确。零丢包 + pause 暴涨 + 全网塌，是 PFC 反压扩散的标准特征。'],
              ['光模块故障', '不成立。零丢包，且是全网范围。'],
              ['网卡驱动 bug', '不成立。pause 计数是链路层事实。'],
              ['路由环路', '不成立。环路会表现为广播风暴与高丢包。']
            ], a: 0
          },
          {
            k: 'ecn', t: '长流被压到很低但短流正常',
            p: '大消息 all-reduce 吞吐只有基线 40%，小消息正常。\n' +
              '交换机 ECN 标记计数很高，发送端降速后没有恢复。',
            o: [
              ['DCQCN 的恢复参数过保守或 ECN 阈值过低，长流被持续压制，需要调阈值与速率恢复', '正确。短流正常、长流被压，是拥塞控制参数问题。'],
              ['带宽不够', '不成立。小消息能正常说明链路有余量。'],
              ['需要关闭 ECN', '不成立。关了会丢包，无损就破了。'],
              ['需要加光模块', '不成立。与光层无关。']
            ], a: 0
          },
          {
            k: 'lossy', t: '偶发重传导致训练抖动',
            p: 'RoCE 网络偶尔出现丢包，NCCL 会卡住几秒再恢复。\n' +
              '交换机上 PFC 只在部分端口开启。',
            o: [
              ['PFC 未在全路径一致开启，任何一跳有损都会丢包；需要端到端统一配置', '正确。无损要求全路径一致，断一环就等于有损。'],
              ['需要关闭 RDMA', '不成立。关了就退化成 TCP。'],
              ['加带宽即可', '不成立。丢包不是带宽问题。'],
              ['换 IB 网络', '可行但成本高，先修配置。']
            ], a: 0
          }
        ],
        hint: '看两个计数器：丢包和 PFC pause。一个为 0 一个暴涨，就是反压。',
        sideNote: '无损网络的代价是"拥堵会传染"，一个端口堵住能拖垮整个平面。'
      }),
      F.pick({
        id: 'M11', key: 's3', atom: 'D', title: 'PFC 与 ECN 怎么配',
        cases: [
          {
            k: 'tune', t: '阈值调高还是调低',
            p: '一个 64 节点的 RoCE 集群要在"零丢包"和"高吞吐"之间取舍。\n' +
              '两种思路：\n' +
              '甲：PFC 阈值调高、ECN 阈值调低 —— 尽量靠降速避免触发暂停；\n' +
              '乙：PFC 阈值调低、ECN 阈值调高 —— 尽快反压，保证零丢包。',
            o: [
              ['甲更合适：优先用 ECN 让发送端主动降速，PFC 只做最后兜底，避免反压扩散', '正确。PFC 是"急刹车"，用多了会传染；ECN 是"提前松油门"。'],
              ['乙更合适：零丢包最重要', '不成立。PFC 频繁触发会导致反压扩散，甚至死锁。'],
              ['两个都调到最低', '不成立。会同时触发反压与降速，吞吐崩。'],
              ['关掉 PFC 只留 ECN', '不成立。ECN 不能保证零丢包。']
            ], a: 0
          },
          {
            k: 'watchdog', t: '要不要开 PFC watchdog',
            p: '生产集群里有人建议关掉 PFC watchdog，理由是"它会误杀流量"。',
            o: [
              ['必须开。watchdog 是 PFC 死锁的唯一自动逃生通道，误杀的代价远小于全网死锁', '正确。宁可丢一点流量，也不能让整个平面卡死。'],
              ['关掉，避免误伤', '不成立。死锁时没有逃生机制，只能人工破环。'],
              ['改成只告警不动作', '不成立。告警没人看的时候照样死锁。'],
              ['用 QoS 代替', '不成立。QoS 管不了反压传播。']
            ], a: 0
          },
          {
            k: 'scope', t: 'PFC 开在哪些优先级',
            p: '交换机支持 8 个优先级，业务有 RDMA 和管理流量。',
            o: [
              ['只在 RDMA 的专用优先级上开 PFC，其他优先级保持有损，避免管理流量被卷进反压', '正确。PFC 是按优先级生效的，这正是它相对全局流控的优势。'],
              ['所有优先级都开，最安全', '不成立。会把管理流量也拖进反压域。'],
              ['只开在优先级 0', '不成立。要跟 DSCP 映射对齐，不能随便选。'],
              ['不开，靠应用重试', '不成立。训练等不起重试。']
            ], a: 0
          }
        ],
        hint: 'PFC 是急刹车，ECN 是提前松油门。能用后者就别用前者。',
        sideNote: '无损网络调优的本质：让降速发生在丢包之前，让反压尽量不扩散。'
      })
    ],
    knowledge: {
      concept: 'RDMA 要求"不丢包"。以太网本身会丢包，所以要用 PFC（按优先级反压）造出无损，再用 ECN + DCQCN 让发送端提前降速。',
      why: '丢一个包，整个消息要重传，训练会卡几秒。但 PFC 用过头会反压扩散成风暴，把整个平面拖死。这是一场"丢包 vs 反压"的平衡。',
      pitfalls: [
        '以为开了 PFC 就无损。全路径任何一跳没开，就等于没开。',
        'PFC 阈值调得过低。频繁触发会导致反压扩散甚至死锁。',
        '关掉 PFC watchdog。它是死锁时唯一的自动逃生通道。'
      ],
      verify: '看交换机端口的 PFC pause 计数与 ECN 标记计数，再看 DCQCN 的降速/恢复曲线。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M11.quiz');
      return R.shuffle([
        { q: '零丢包但吞吐塌到 10%，最可能是什么？', options: ['光模块坏', 'PFC 反压扩散成风暴', '带宽不足', '路由环路'], answer: 1, why: '零丢包 + pause 暴涨 + 全网塌，是 PFC 风暴的标准特征。' },
        { q: 'PFC watchdog 的作用是？', options: ['提升带宽', '检测死锁并自动恢复', '加密流量', '负载均衡'], answer: 1, why: '它监控 pause 持续时间，超时就丢弃并恢复，是死锁的逃生通道。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M12 拓扑形态 ============================ */

  var M12 = {
    id: 'M12', plane: 'L3', title: '拓扑形态',
    subtitle: 'Spine-Leaf、rail 平面、超订比',
    atoms: ['A', 'C', 'B'], requires: ['M01', 'M10'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.sort({
        id: 'M12', key: 's1', title: '排跨机路径',
        make: function () {
          return {
            q: '数据从 A 机器的 GPU0 出发，到 B 机器的 GPU0，把经过的设备排一遍。',
            items: [
              { id: 'gpu', label: 'A 机 GPU0' },
              { id: 'nic', label: 'A 机网卡（GPUDirect，不经 CPU）' },
              { id: 'tor', label: 'A 机柜顶 ToR' },
              { id: 'leaf', label: 'A 所在 rail 的 Leaf' },
              { id: 'spine', label: 'Spine' },
              { id: 'leaf2', label: 'B 所在 rail 的 Leaf' },
              { id: 'nic2', label: 'B 机网卡' },
              { id: 'gpu2', label: 'B 机 GPU0' }
            ],
            correct: ['gpu', 'nic', 'tor', 'leaf', 'spine', 'leaf2', 'nic2', 'gpu2'],
            why: [
              '起点是显存里的数据。',
              'GPUDirect 让网卡直接读显存，这一步跳过 CPU。',
              '机柜内的第一跳。',
              'rail 设计里，同号卡走同号 Leaf。',
              '跨 rail 才需要上 Spine，这一步最贵。',
              '落到对端的 rail。',
              '再进对端显存。',
              '终点。'
            ]
          };
        },
        hint: '记住"同 rail 不上 Spine"：能省一跳就省一跳。',
        sideNote: '这条路径的跳数，直接决定跨机 all-reduce 的延迟。'
      }),
      F.calc({
        id: 'M12', key: 's2', title: '算超订后的真实带宽',
        make: function (r) {
          var ports = r.pick([48, 96, 128]);
          var ratio = r.pick([2, 3, 4]);
          var down = ports * 50;
          return {
            q: '一组 Leaf 有 ' + ports + ' 个 400G 下行端口接服务器，\n' +
              '上行到 Spine 的超订比是 ' + ratio + ':1。\n\n' +
              '这组 Leaf 的上行总带宽是多少 GB/s？',
            expected: down / ratio, unit: 'GB/s', label: '上行带宽', digits: 0,
            steps: [ports + ' × 50 = ' + down + ' GB/s 下行',
              '上行 = ' + down + ' ÷ ' + ratio + ' = ' + (down / ratio) + ' GB/s',
              '意味着一半以上的机器同时满速时，上行必然拥塞'],
            misread: [{ f: ratio, title: '乘反了', text: '超订比是"下行比上行"，上行 = 下行 ÷ 比值。' }],
            sideNote: '1:1 无超订最贵，3:1 是训练集群的常见折中。'
          };
        }
      }),
      F.pick({
        id: 'M12', key: 's3', atom: 'B', title: '同 rail 达标，跨 rail 只有 1/3',
        cases: [
          {
            k: 'rail', t: '跨 rail 带宽掉到三分之一',
            p: '64 台 8 卡机，rail-optimized 组网（8 个 rail 平面，每平面 1:1）。\n' +
              '同 rail 之间实测 48 GB/s，跨 rail 只有 16 GB/s。',
            o: [
              ['rail 平面之间只通过 Spine 互联且存在超订或收敛，跨 rail 流量必然受限；应让通信尽量留在同 rail（如按 rail 编排 rank）', '正确。rail 设计的前提就是"大多数通信发生在同 rail"。'],
              ['网卡坏了一半', '不成立。同 rail 正常说明硬件没问题。'],
              ['NCCL 版本问题', '不成立。版本不会造成 rail 间差异。'],
              ['需要开 PFC', '不成立。这是拓扑收敛问题。']
            ], a: 0
          },
          {
            k: 'oversub', t: '训练规模一大就慢',
            p: '32 卡规模时线性扩展良好，扩到 256 卡后效率掉到 60%。\n' +
              '网络是 3:1 超订的两层 spine-leaf。',
            o: [
              ['规模上去后跨 pod 流量占比上升，撞到 3:1 超订的上行瓶颈；要么改 1:1，要么做拓扑感知的作业编排', '正确。超订在小规模看不出来，大规模必现。'],
              ['GPU 性能不够', '不成立。小规模线性良好说明单卡没问题。'],
              ['需要更多存储', '不成立。与计算网络效率无关。'],
              ['驱动问题', '不成立。规模相关，不是版本相关。']
            ], a: 0
          },
          {
            k: 'torus', t: '环面拓扑下邻居选择很重要',
            p: '一个 torus 拓扑的集群，同一作业内相邻 rank 通信很快，\n' +
              '但 rank 编号跨维度时延迟明显上升。',
            o: [
              ['torus 的跳数依赖维度距离，rank 映射必须与物理拓扑对齐，否则会出现长绕路', '正确。torus 下 rank 编排错了，一跳能变五跳。'],
              ['torus 不适合训练', '不成立。它成本低、扩展性好，但要配套编排。'],
              ['需要换 IB', '不成立。先修映射。'],
              ['需要关 PFC', '不成立。与无损无关。']
            ], a: 0
          }
        ],
        hint: '先问"这条流量跨了几个平面"，再看超订比。',
        sideNote: 'rail 优化的全部价值在于"让大多数流量不上 Spine"。'
      })
    ],
    knowledge: {
      concept: '两层 Spine-Leaf 是所有 AI 集群的底图。在其上，rail-optimized 把 8 个 rail 做成 8 个平行平面，让同号 GPU 走同号 Leaf。超订比决定了"多少台机器能同时满速"。',
      why: 'GPU 数量翻倍时，网络必须同步扩张，否则算力全堵在跨 rail 的几跳上。拓扑不是背景板，它直接决定大规模训练能不能线性扩展。',
      pitfalls: [
        '只看端口速率不看超订比。3:1 超订下，一半机器满速就拥塞。',
        'rail 布好了但 rank 编排乱。同 rail 的卡被编到不同 rail 的通信组里。',
        '以为 torus 随便连就行。rank 映射错一维，延迟翻几倍。'
      ],
      verify: '看 Leaf 的上行利用率与 Spine 的拥塞计数，再跑同 rail / 跨 rail 两组带宽对比。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M12.quiz');
      return R.shuffle([
        { q: 'rail-optimized 的核心思想是？', options: ['所有卡共用一个平面', '同号 GPU 走同号 Leaf，减少跨 rail', '只做一层交换', '用无线连接'], answer: 1, why: '把 8 个 rail 做成平行平面，让大部分通信留在本平面内。' },
        { q: '3:1 超订意味着什么？', options: ['下行是上行的 3 倍', '上行是下行的 3 倍', '延迟是 3 倍', '带宽是 3 倍'], answer: 0, why: '下行端口能力是上行的 3 倍，即上行收敛。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M13 NCCL ============================ */

  var M13 = {
    id: 'M13', plane: 'L3', title: 'NCCL',
    subtitle: 'ring 算法、通信量、环境变量',
    atoms: ['C', 'B', 'D'], requires: ['M05', 'M10', 'M12'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M13', key: 's1', title: '算 ring all-reduce 的通信量',
        make: function (r) {
          var n = r.pick([4, 8, 16]);
          var s = r.pick([4, 8, 16]);
          var bw = r.pick([450, 900]);
          var kind = r.int(2);
          var vol = 2 * (n - 1) / n * s;
          if (kind === 0) {
            return {
              q: n + ' 张卡做 ring all-reduce，每张卡的数据量 ' + s + ' GB。\n' +
                'ring 算法的通信量公式是 2(N−1)/N × S。\n\n' +
                '每张卡一共要收发多少 GB？',
              expected: vol, unit: 'GB', label: '通信量', digits: 2,
              steps: ['2 × (' + n + '−1) / ' + n + ' = ' + (2 * (n - 1) / n).toFixed(3),
                '× ' + s + ' GB = ' + vol.toFixed(2) + ' GB',
                '注意：不是 2S，规模越大越接近 2S，小规模会少一点'],
              misread: [{ f: 2 * s / vol, title: '用了 2S', text: 'ring 的通信量是 2(N−1)/N × S，N 有限时小于 2S。' }],
              sideNote: '这个公式是估算一切 all-reduce 耗时的起点。'
            };
          }
          return {
            q: n + ' 张卡、每卡 ' + s + ' GB，ring all-reduce 通信量 ' + vol.toFixed(2) + ' GB。\n' +
              '卡间带宽按单向 ' + bw + ' GB/s。\n\n' +
              '理论上这一步至少要多少毫秒？',
            expected: vol / bw * 1000, unit: 'ms', label: '耗时', digits: 1,
            steps: ['通信量 = ' + vol.toFixed(2) + ' GB',
              '÷ ' + bw + ' GB/s = ' + (vol / bw).toFixed(4) + ' s',
              '× 1000 = ' + (vol / bw * 1000).toFixed(1) + ' ms（这是纯通信下限，不含计算）'],
            sideNote: '实测通常比这个数大 20%~50%，差额就是协议开销和拥塞。'
          };
        }
      }),
      F.pick({
        id: 'M13', key: 's2', atom: 'B', title: 'NCCL 初始化超时',
        cases: [
          {
            k: 'iface', t: '卡 30 秒后 timeout',
            p: '多机训练启动，每台机器都卡在 NCCL init，30 秒后报 timeout。\n' +
              'NCCL_DEBUG=INFO 日志停在 "Bootstrap : Using ... " 之后没有下文。\n' +
              '机器之间 ping 通，SSH 也通，但计算网的 IP 段是独立的。',
            o: [
              ['NCCL 用了管理网而不是计算网做 bootstrap，需要指定 NCCL_SOCKET_IFNAME 与 NCCL_IB_HCA', '正确。ping 通是管理网，NCCL 走错了网口就永远握不上手。'],
              ['网卡坏了', '不成立。管理网通畅说明网络本身没坏。'],
              ['NCCL 版本太旧', '不成立。版本问题不会表现为固定 30 秒超时。'],
              ['需要开 PFC', '不成立。还没到数据面。']
            ], a: 0
          },
          {
            k: 'hca', t: '多网卡机器选错设备',
            p: '8 张 IB 网卡的机器，NCCL 只用了 1 张，跨机带宽只有 1/8。\n' +
              '日志里 "NET/IB : Using [0]mlx5_0:1"。',
            o: [
              ['NCCL 默认只用一张，必须用 NCCL_IB_HCA 显式列出全部 8 张，并配合 rail 配置', '正确。默认行为是保守的，多网卡一定要显式指定。'],
              ['网卡驱动问题', '不成立。日志显示正常使用了 mlx5_0。'],
              ['需要加交换机', '不成立。端口没用起来。'],
              ['需要关掉 IB', '不成立。']
            ], a: 0
          },
          {
            k: 'timeout', t: '偶发超时但重跑就好',
            p: '训练偶尔在启动阶段超时，重跑就正常，日志里有 "Watchdog caught collective operation timeout"。',
            o: [
              ['存在慢节点或链路抖动导致集合通信不同步；先查是否有机器降速、PFC 反压或某张卡异常', '正确。偶发超时几乎都是"某一次集合操作里有节点没跟上"。'],
              ['NCCL 版本不稳定', '不成立。偶发且重跑正常，指向环境而非二进制。'],
              ['需要调大 timeout 掩盖', '不成立。调大只是延迟暴露。'],
              ['内存不足', '不成立。']
            ], a: 0
          }
        ],
        hint: '初始化阶段的超时，九成是"网选错了"或"端口没列全"。',
        sideNote: 'NCCL_DEBUG=INFO 的日志要会读：看它选了哪张卡、哪个 IP、哪个算法。'
      }),
      F.pick({
        id: 'M13', key: 's3', atom: 'D', title: '选 ring 还是 tree',
        cases: [
          {
            k: 'algo', t: '大消息、多机、要最大带宽',
            p: '64 张卡跨 8 台机器，每步 all-reduce 的数据量 2GB，追求最大带宽。\n' +
              '可选算法：Ring（环）、Tree（树）、CollNet（网内归约）。',
            o: [
              ['优先 CollNet（若交换机支持），否则用 Ring；Tree 适合小消息低延迟，不适合大消息', '正确。大消息看带宽，ring 的链路利用率最高。'],
              ['用 Tree，因为树形结构更短', '不成立。树的跳数少但链路利用率低，大消息吃亏。'],
              ['用 Ring，因为最简单', '部分对，但忽略了 CollNet 这个更优选项。'],
              ['随便，NCCL 会自动选对', '不成立。自动选择有启发式，边界情况需要手动干预。']
            ], a: 0
          },
          {
            k: 'small', t: '小消息、延迟敏感',
            p: '梯度很小（每步几十 KB），机器多，延迟成为主要成本。',
            o: [
              ['用 Tree：跳数是 log(N)，小消息下延迟明显低于 Ring 的 2(N−1) 跳', '正确。小消息看延迟，树的对数跳数占优。'],
              ['用 Ring，带宽利用率高', '不成立。小消息带宽用不满，延迟才是关键。'],
              ['用 AllGather 代替', '不成立。算子语义不同。'],
              ['关掉 NCCL 用 MPI', '不成立。MPI 不会更快。']
            ], a: 0
          },
          {
            k: 'env', t: '要不要强行指定算法',
            p: '有人建议把 NCCL_ALGO 固定成 Ring 以"稳定性能"。',
            o: [
              ['不要长期写死。应让 NCCL 按拓扑自动选，只在明确复现问题时临时指定以定位', '正确。写死会让不同规模的作业都吃同一个次优解。'],
              ['应该写死，稳定优先', '不成立。稳定的是"可预测的差"。'],
              ['写死成 Tree', '不成立。同理。'],
              ['把 NCCL_ALGO 设成空', '不成立。空值行为不确定。']
            ], a: 0
          }
        ],
        hint: '大消息看带宽（ring），小消息看延迟（tree）。',
        sideNote: 'NCCL 的自动选择在多数场景是对的，人干预的价值在于定位问题。'
      })
    ],
    knowledge: {
      concept: 'NCCL 是 GPU 间的集合通信库。它把 all-reduce 拆成 reduce-scatter + all-gather，用 ring 或 tree 在卡间传递，通信量约 2(N−1)/N × S。',
      why: '训练每一步都要 all-reduce。这一步占总时间的比例，决定了加卡能不能加速。算得清通信量，才知道瓶颈在算还是在传。',
      pitfalls: [
        '以为通信量是 S。ring 要搬两遍（scatter + gather），接近 2S。',
        '多网卡机器不指定 NCCL_IB_HCA。默认只用一张，带宽直接 1/8。',
        '初始化超时就调大 timeout。真正的问题是网选错了。'
      ],
      verify: 'NCCL_DEBUG=INFO 看选中的 HCA 与算法，nccl-tests 跑 all_reduce_perf 对比理论值。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M13.quiz');
      return R.shuffle([
        { q: '8 卡 ring all-reduce，每卡 8GB，通信量约是多少？', options: ['8 GB', '14 GB', '16 GB', '64 GB'], answer: 1, why: '2×(7/8)×8 = 14 GB。' },
        { q: '多网卡机器上 NCCL 默认会用几张网卡？', options: ['全部', '一张', '一半', '按带宽自动'], answer: 1, why: '默认保守，必须用 NCCL_IB_HCA 显式列出。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M14 集合通信与并行策略 ============================ */

  var M14 = {
    id: 'M14', plane: 'L3', title: '集合通信与并行策略',
    subtitle: '四种算子，三种并行，谁在传什么',
    atoms: ['C', 'D', 'B'], requires: ['M13'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M14', key: 's1', title: '算各算子的通信量',
        make: function (r) {
          var n = r.pick([8, 16, 32]);
          var s = r.pick([2, 4, 8]);
          var kind = r.int(3);
          if (kind === 0) {
            return {
              q: n + ' 张卡做 AllGather，每张卡的输入是 ' + s + ' GB。\n' +
                'ring all-gather 每位参与者的通信量是 (N−1)/N × S。\n\n' +
                '每张卡要收发多少 GB？',
              expected: (n - 1) / n * s, unit: 'GB', label: '通信量', digits: 2,
              steps: ['(' + n + '−1)/' + n + ' = ' + ((n - 1) / n).toFixed(3),
                '× ' + s + ' GB = ' + ((n - 1) / n * s).toFixed(2) + ' GB',
                'AllGather 是 all-reduce 的一半，因为它只搬一次'],
              sideNote: 'AllReduce = ReduceScatter + AllGather，所以是两倍。'
            };
          }
          if (kind === 1) {
            return {
              q: n + ' 张卡做 AllReduce，数据量 ' + s + ' GB。\n' +
                '如果拆成 ReduceScatter + AllGather 两步，每张卡总共收发多少 GB？\n' +
                '（每步 (N−1)/N × S）',
              expected: 2 * (n - 1) / n * s, unit: 'GB', label: '通信量', digits: 2,
              steps: ['ReduceScatter：' + ((n - 1) / n * s).toFixed(2) + ' GB',
                'AllGather：' + ((n - 1) / n * s).toFixed(2) + ' GB',
                '合计 = ' + (2 * (n - 1) / n * s).toFixed(2) + ' GB'],
              misread: [{ f: 0.5, title: '只算了一步', text: 'AllReduce 是两步拼起来的。' }],
              sideNote: '这就是为什么 all-reduce 比 all-gather 贵一倍。'
            };
          }
          return {
            q: n + ' 张卡做 AlltoAll（专家并行里最常见），每张卡要发给其他每一张卡 ' + s + ' GB。\n\n' +
              '每张卡总发送量是多少 GB？',
            expected: (n - 1) * s, unit: 'GB', label: '发送量', digits: 0,
            steps: ['每个对端 ' + s + ' GB，共 ' + (n - 1) + ' 个对端',
              '(' + n + '−1) × ' + s + ' = ' + ((n - 1) * s) + ' GB',
              'AlltoAll 的通信量随卡数线性增长，这是专家并行最难扩的原因'],
            sideNote: 'AlltoAll 是唯一"规模越大越痛"的算子。'
          };
        }
      }),
      F.pick({
        id: 'M14', key: 's2', atom: 'D', title: '选并行切分',
        cases: [
          {
            k: 'plan', t: '96 卡训 70B 怎么切',
            p: '96 张卡（12 台 8 卡机），训练 70B 模型，单卡 80GB。\n' +
              '要求：显存能装下，且跨机通信尽量少。',
            o: [
              ['TP=8（机内）、PP=4、DP=3：TP 留在 NVLink 域内，PP 与 DP 的通信量最小', '正确。TP 最吃带宽，必须留在机内；PP 只传边界激活，DP 只在步末同步。'],
              ['TP=16、PP=2、DP=3：TP 更大，单层切得更细', '不成立。TP 跨机会把最吃带宽的通信放到最慢的链路上。'],
              ['DP=96，纯数据并行', '不成立。70B 的优化器状态单卡放不下。'],
              ['TP=8、PP=12、DP=1：每台一个流水段', '部分可行，但 DP=1 会让流水气泡无法用数据并行填，吞吐低。']
            ], a: 0
          },
          {
            k: 'zero', t: '显存不够，要不要上 ZeRO',
            p: '8 卡单机训 13B，Adam 全量需要 156GB/卡的等价开销，单卡 80GB 放不下。',
            o: [
              ['用 ZeRO-2/FSDP 把优化器状态和梯度分片到 8 张卡，权重仍复制', '正确。ZeRO 分片的是状态，不是模型结构，通信量比 TP 小得多。'],
              ['用 TP=8 切模型', '可行但通信量大，机内尚可，跨机不行。'],
              ['减少 batch 到 1', '不成立。省的是激活，不是权重与优化器。'],
              ['换 8bit 优化器', '缓解一半，但 78GB 仍逼近上限，且精度有损。']
            ], a: 0
          },
          {
            k: 'ep', t: 'MoE 模型通信爆炸',
            p: '把 dense 模型换成 MoE 后，专家并行带来大量 AlltoAll，训练吞吐反而下降。',
            o: [
              ['AlltoAll 通信量随卡数线性增长，需要限制 EP 规模并把专家放在同一台机器内', '正确。EP 的瓶颈就是 AlltoAll 的规模效应。'],
              ['加大 TP', '不成立。TP 解决不了 AlltoAll。'],
              ['换更快的网卡就能解决', '缓解但不是根因，规模继续涨还会撞墙。'],
              ['关掉 all-reduce', '不成立。']
            ], a: 0
          }
        ],
        hint: '按"通信量大小"排序：TP 最大、PP 最小、DP 在步末、EP 随规模爆炸。',
        sideNote: '并行策略的本质是"把最贵的通信放进最快的链路里"。'
      }),
      F.pick({
        id: 'M14', key: 's3', atom: 'B', title: '加了卡反而不加速',
        cases: [
          {
            k: 'scale', t: '从 64 卡扩到 128 卡，吞吐只涨 20%',
            p: '同一模型，64 卡时每秒 1000 step，128 卡时只有 1200 step。\n' +
              'GPU 利用率从 92% 掉到 55%，通信时间占比从 10% 涨到 45%。',
            o: [
              ['并行度提高后跨机通信占比上升，需要调整切分方式（减少 TP/EP、增大 DP）或提升网络', '正确。通信占比从 10% 涨到 45%，说明新增的卡主要在等通信。'],
              ['GPU 性能不一致', '不成立。利用率整体下降，不是个别卡。'],
              ['数据加载跟不上', '不成立。数据加载慢会先表现在 CPU 侧。'],
              ['需要更多显存', '不成立。没有 OOM。']
            ], a: 0
          },
          {
            k: 'bubble', t: '流水并行有大量气泡',
            p: 'PP=8 的训练，GPU 利用率呈规律性方波，每步有约 35% 的时间在等。',
            o: [
              ['流水气泡，需要增加 micro-batch 数量或改用交错式流水（interleaved 1F1B）填充', '正确。方波 + 固定比例空闲，是流水气泡的典型形状。'],
              ['通信带宽不足', '不成立。气泡是计算空转，不是传输等待。'],
              ['需要加卡', '不成立。加卡不会减少气泡比例。'],
              ['学习率问题', '不成立。']
            ], a: 0
          },
          {
            k: 'overlap', t: '通信和计算没有重叠',
            p: 'profiler 时间线上，all-reduce 与 backward 计算是串行的两段，没有交叠。',
            o: [
              ['没有开启梯度分桶与通信重叠，调整 bucket 大小并确认 NCCL 异步执行', '正确。默认应该重叠，串行说明分桶或流配置有问题。'],
              ['带宽不够导致无法重叠', '不成立。带宽不足会让重叠变慢，不会变成完全串行。'],
              ['需要换 GPU', '不成立。'],
              ['改成所有通信串行执行，方便调试', '不成立。串行只会更慢，而且掩盖真实问题。']
            ], a: 0
          }
        ],
        hint: '看两个比例：通信时间占比、GPU 空转比例。前者是切分问题，后者是流水问题。',
        sideNote: '加卡不加速，九成是通信占比被并行度推高了。'
      })
    ],
    knowledge: {
      concept: '四种算子：AllReduce（梯度同步）、AllGather（收集）、ReduceScatter（归约分片）、AlltoAll（全交换）。三种并行：数据并行（DP）、张量并行（TP）、流水并行（PP），再加上专家并行（EP）。',
      why: '每种并行对通信的要求完全不同：TP 每层都要通信、PP 只传边界、DP 只在步末、EP 是 AlltoAll。把最贵的那种放进最慢的链路，加卡就等于加等待。',
      pitfalls: [
        '把 TP 跨机放。TP 每层都要 all-reduce，跨机就是灾难。',
        '以为 AllReduce 通信量是 S。它是 2(N−1)/N × S。',
        'MoE 直接放大 EP。AlltoAll 随卡数线性增长，很快就撞墙。'
      ],
      verify: '看 profiler 里通信与计算的时间占比，再算一遍理论通信量，两者差太多就是切分不对。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M14.quiz');
      return R.shuffle([
        { q: 'AllReduce 由哪两步组成？', options: ['Gather + Scatter', 'ReduceScatter + AllGather', 'Broadcast + Reduce', 'Send + Recv'], answer: 1, why: '先归约分片，再全收集，所以通信量是单步的两倍。' },
        { q: '哪种并行对带宽要求最高？', options: ['数据并行', '流水并行', '张量并行', '专家并行'], answer: 2, why: 'TP 每层都要 all-reduce，必须留在 NVLink 域内。' }
      ]).slice(0, 2);
    }
  };

  REG.declare(M10);
  REG.declare(M11);
  REG.declare(M12);
  REG.declare(M13);
  REG.declare(M14);

  root.M10 = M10;
  root.M11 = M11;
  root.M12 = M12;
  root.M13 = M13;
  root.M14 = M14;
})(typeof globalThis !== 'undefined' ? globalThis : this);
