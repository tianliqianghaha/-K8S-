(function (root) {
  'use strict';

  var F = root.TopoFactory;
  var REG = root.TopoRegistry;

  /* ============================ M06 Linux 底座 ============================ */

  var M06 = {
    id: 'M06', plane: 'L2', title: 'Linux 底座',
    subtitle: 'NUMA、大页、cgroup、中断绑核',
    atoms: ['C', 'B', 'A'], requires: ['M02'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M06', key: 's1', title: '算跨 NUMA 的代价',
        make: function (r) {
          var p = r.pick([0.1, 0.2, 0.3, 0.4]);
          var local = 200, remote = 90;
          var eff = 1 / ((1 - p) / local + p / remote);
          return {
            q: '双路机器，本地 NUMA 访存带宽 ' + local + ' GB/s，跨 NUMA 只有 ' + remote + ' GB/s。\n' +
              '某个进程有 ' + Math.round(p * 100) + '% 的访存落在远端。\n\n' +
              '它的平均可用带宽是多少 GB/s？',
            expected: eff, unit: 'GB/s', label: '平均带宽', digits: 1,
            steps: ['平均耗时 = (1−' + p + ') / ' + local + ' + ' + p + ' / ' + remote + ' = ' +
              ((1 - p) / local + p / remote).toFixed(6) + ' s/GB',
              '带宽 = 1 ÷ 上式 = ' + eff.toFixed(1) + ' GB/s',
              '只用 ' + Math.round(p * 100) + '% 的流量跨 NUMA，就掉了 ' + Math.round((1 - eff / local) * 100) + '%'],
            misread: [{ f: 0.8, title: '用了算术平均', text: '带宽要按时间加权（调和平均），不能直接取平均。' }],
            sideNote: '所以 numactl --membind 和进程绑核不是玄学，是直接换带宽。'
          };
        }
      }),
      F.pick({
        id: 'M06', key: 's2', atom: 'B', title: '训练周期性卡顿',
        cases: [
          {
            k: 'thp', t: '每 200ms 卡一下',
            p: '训练吞吐曲线呈锯齿状，每 200ms 左右出现一次 50ms 的停顿。\n' +
              'CPU 侧 perf 显示大量 kcompactd 与 page fault 开销，内存使用接近 100%。',
            o: [
              ['关闭透明大页（THP）或预分配大页，避免运行期内存整理抖动', '正确。kcompactd 频繁唤醒 + 周期性停顿，是 THP 整理内存的典型特征。'],
              ['GPU 降频', '不成立。降频表现为持续下滑，不是周期性锯齿。'],
              ['网络丢包', '不成立。丢包会触发重传，表现为吞吐下降而非精确的 200ms 周期。'],
              ['磁盘 IO 慢', '不成立。数据集已在内存里，没走盘。']
            ], a: 0
          },
          {
            k: 'swap', t: '跑一段时间后整体变慢',
            p: '训练启动 20 分钟后整体吞吐掉一半，free 显示 available 只剩 2GB，\n' +
              'swap 分区使用量持续增长，dmesg 没有 OOM。',
            o: [
              ['内存超配触发了 swap，训练进程被换出换入；应关 swap 并限制数据加载进程的内存', '正确。swap 有增长、无 OOM，是典型的换页拖慢。'],
              ['GPU 显存泄漏', '不成立。显存问题会先 OOM，且不看 free。'],
              ['CPU 核数不够', '不成立。核数不够在启动时就慢，不会 20 分钟后突降。'],
              ['驱动 bug', '不成立。有 swap 使用的直接证据。']
            ], a: 0
          },
          {
            k: 'irq', t: '多卡训练时 CPU 单核 100%',
            p: '8 卡训练，top 显示有一颗 CPU 核常年 100%（si 高），其余核空闲。\n' +
              '网卡中断全部落在这颗核上，训练吞吐随包量波动。',
            o: [
              ['网卡多队列中断没有分散，用 irqbalance 或手动绑核把中断分到多个非训练核', '正确。si 高 + 单核打满 + 中断集中，是中断绑核问题。'],
              ['GPU 算力不足', '不成立。GPU 空闲而 CPU 单核满，说明瓶颈在 CPU 侧。'],
              ['内存带宽不足', '不成立。内存带宽不足会表现为多核同时慢。'],
              ['交换芯片故障', '不成立。与中断分布无关。']
            ], a: 0
          }
        ],
        hint: '看"卡顿的形状"：周期性 = 定时任务或内存整理，持续下滑 = 资源耗尽，单核满 = 中断。',
        sideNote: 'AI 训练机上最贵的不是 CPU，但最容易成为瓶颈的常常是它。'
      }),
      F.match({
        id: 'M06', key: 's3', title: '认内核参数',
        make: function () {
          return {
            q: '把四个内核层面的开关和它的实际作用连起来。',
            left: [
              { id: 'l1', label: 'hugepages（预分配大页）' },
              { id: 'l2', label: 'cgroup v2 memory.max' },
              { id: 'l3', label: 'isolcpus / nohz_full' },
              { id: 'l4', label: 'irqbalance + 中断绑核' }
            ],
            right: [
              { id: 'r1', label: '减少 TLB miss，压掉长尾延迟' },
              { id: 'r2', label: '限制容器内存，超了直接 OOM 而不是拖垮整机' },
              { id: 'r3', label: '把 CPU 从调度器手里拿走，给训练进程独占' },
              { id: 'r4', label: '把网卡中断分散到非训练核，避免单核打满' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' },
            why: {
              l1: '大页把 4KB 页变成 2MB/1GB，一次 TLB 覆盖更大范围。',
              l2: 'cgroup 是容器隔离的执行者，memory.max 一到就杀进程。',
              l3: 'isolcpus 让内核不再往这些核上调度普通进程。',
              l4: '网卡多队列 + 绑核，是解决 si 高的标准做法。'
            }
          };
        },
        hint: '参数名往往就说明了它管哪一层：内存、调度、还是中断。',
        sideNote: '这些开关单独看都很小，叠起来能把长尾延迟从毫秒压到微秒。'
      })
    ],
    knowledge: {
      concept: '训练任务最终跑在 Linux 上。NUMA、大页、cgroup、中断绑核这四件事，决定了硬件的能力能不能真正交到进程手里。',
      why: '同一台机器，绑不绑 NUMA、开不开大页，实测吞吐能差 20% 以上。这些不是"优化"，是"别把已经买到的性能漏掉"。',
      pitfalls: [
        '以为 NUMA 只影响内存分配。它同时影响 PCIe 设备与内存的路径。',
        '开着 THP 跑长任务。运行期内存整理会造成周期性卡顿。',
        '训练机开 swap。一旦换页，吞吐直接腰斩，而且很难从 GPU 侧看出来。'
      ],
      verify: 'numactl -H 看分布，perf top 看热点，/proc/interrupts 看中断落点，cat /sys/kernel/mm/transparent_hugepage/enabled 看大页策略。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M06.quiz');
      return R.shuffle([
        { q: '训练机上建议怎么处理 swap？', options: ['开越大越好', '关闭或设 swappiness=0', '放在 NVMe 上', '无所谓'], answer: 1, why: '一旦换页，训练吞吐会断崖式下跌，且从 GPU 侧完全看不出来。' },
        { q: 'top 里 si 很高、单核 100%，最可能是什么？', options: ['GPU 不够', '网卡中断集中在单核', '内存不足', '磁盘慢'], answer: 1, why: 'si 是软中断，集中在一颗核上说明中断没分散。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M07 驱动与运行时栈 ============================ */

  var M07 = {
    id: 'M07', plane: 'L2', title: '驱动与运行时栈',
    subtitle: '版本对齐，比装什么都重要',
    atoms: ['A', 'B'], requires: ['M03', 'M06'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.sort({
        id: 'M07', key: 's1', title: '排安装顺序',
        make: function () {
          return {
            q: '一台新装的 8 卡 SXM 机器，从裸系统到能跑容器训练，把步骤排对。',
            items: [
              { id: 'a', label: '装 NVIDIA 驱动（含 nvidia-peermem）' },
              { id: 'b', label: '装与驱动同版本的 nvidia-fabricmanager 并启动' },
              { id: 'c', label: '装 CUDA toolkit 与 cuDNN' },
              { id: 'd', label: '装 nvidia-container-toolkit 并配置 containerd runtime' },
              { id: 'e', label: '跑 nvidia-smi 与 topo -m 验收' }
            ],
            correct: ['a', 'b', 'c', 'd', 'e'],
            why: [
              '驱动是所有上层的基础，版本号定了后面全跟着它走。',
              'fabricmanager 管 NVSwitch，版本必须与驱动严格一致，且必须在驱动之后。',
              'CUDA toolkit 依赖驱动提供的能力，版本有最低要求。',
              '容器运行时靠 toolkit 把驱动注入容器，必须在驱动装好之后。',
              '最后验收：卡在、拓扑对、容器里能看到卡。'
            ]
          };
        },
        hint: '记住一条：上面所有东西的版本，都是由驱动版本推出来的。',
        sideNote: '装错顺序的代价不是重装，是"看起来装好了，实际少了一半能力"。'
      }),
      F.match({
        id: 'M07', key: 's2', title: '认四个组件',
        make: function () {
          return {
            q: '把四个组件和它真正负责的事连起来。',
            left: [
              { id: 'l1', label: 'nvidia-peermem' },
              { id: 'l2', label: 'gdrcopy' },
              { id: 'l3', label: 'nvidia-fabricmanager' },
              { id: 'l4', label: 'NVIDIA device plugin' }
            ],
            right: [
              { id: 'r1', label: '让 RDMA 网卡直接读写 GPU 显存，绕开 CPU' },
              { id: 'r2', label: '提供低延迟的显存与主机内存拷贝库' },
              { id: 'r3', label: '管理 NVSwitch，没它 NVLink 不工作' },
              { id: 'r4', label: '把 GPU 作为一种资源暴露给 Kubernetes' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' },
            why: {
              l1: 'peermem 是内核模块，装了才有 GPUDirect RDMA。',
              l2: 'gdrcopy 是用户态库，做小包低延迟拷贝。',
              l3: 'fabricmanager 是 NVSwitch 的控制面，版本要求极严。',
              l4: 'device plugin 是 K8s 侧的适配层，负责分配与健康上报。'
            }
          };
        },
        hint: '按"它插在哪一层"来分：内核模块、用户态库、控制面服务、K8s 适配层。',
        sideNote: '这四个组件任何一个没装，症状都是"能跑但慢"，而不是"跑不起来"。'
      }),
      F.pick({
        id: 'M07', key: 's3', atom: 'B', title: 'RDMA 走了 CPU 拷贝',
        cases: [
          {
            k: 'peermem', t: '跨机带宽上不去，CPU 占用高',
            world: {
              modules: ['nvidia', 'nvidia_uvm', 'nvidia_drm', 'mlx5_core', 'mlx5_ib', 'ib_core'],
              nics: [
                { dev: 'mlx5_0', state: 'Active', rate: 400, numa: 0 },
                { dev: 'mlx5_1', state: 'Active', rate: 400, numa: 0 }
              ]
            },
            p: '跨机 all-reduce 只有 12 GB/s，而链路是 400G（50 GB/s）。\n' +
              'iperf3 能跑满，但 NCCL 测试跑不满；mpstat 显示 CPU 里 memcpy 占比很高。\n' +
              'dmesg 里没有 nvidia-peermem 相关加载记录。',
            o: [
              ['nvidia-peermem 未加载，GPUDirect RDMA 退化为经 CPU 拷贝；装模块并重启', '正确。iperf 满而 NCCL 不满 + CPU 拷贝高，是典型的"没走 GPUDirect"。'],
              ['网卡速率协商错误', '不成立。iperf3 能跑满说明链路没问题。'],
              ['NCCL 版本太旧', '不成立。版本问题不会表现为 CPU memcpy 高。'],
              ['交换机拥塞', '不成立。拥塞会影响 iperf 的稳定性。']
            ], a: 0
          },
          {
            k: 'toolkit', t: '容器里 nvidia-smi 报找不到设备',
            p: '宿主机 nvidia-smi 正常。容器启动后 `nvidia-smi` 报 "No devices were found"，\n' +
              '但容器里能看到 /dev/nvidia0。',
            o: [
              ['容器运行时没配 nvidia runtime，设备节点被挂进来了但驱动库没注入，检查 containerd 的 runtime 配置', '正确。能看到设备节点却找不到设备，是库与节点不匹配。'],
              ['GPU 坏了', '不成立。宿主机正常。'],
              ['驱动版本太新', '不成立。新旧不会导致"节点在、库不在"。'],
              ['镜像里没装 CUDA', '不成立。nvidia-smi 用的是注入的驱动库，不依赖镜像内 CUDA。']
            ], a: 0
          },
          {
            k: 'mismatch', t: '升级驱动后 NVSwitch 失效',
            p: '把驱动从 535 升到 550，重启后 nvidia-smi 能看到 8 张卡，\n' +
              '但 topo -m 全部显示 SYS，fabricmanager 服务起不来。',
            o: [
              ['fabricmanager 还是 535 版本，必须与驱动同版本，升级后重启服务', '正确。这是升级驱动最常踩的坑。'],
              ['需要重新插拔 NVSwitch', '不成立。软件版本问题。'],
              ['需要重装 CUDA', '不成立。与 CUDA 无关。'],
              ['BIOS 需要升级', '不成立。日志已经指出服务版本不匹配。']
            ], a: 0
          }
        ],
        hint: '先确认"物理通路"通不通（iperf），再看"数据走没走显存"（peermem）。',
        sideNote: '驱动栈的故障有个共同点：卡都在，就是能力少一半。'
      })
    ],
    knowledge: {
      concept: '从下往上：内核驱动 → fabricmanager（NVSwitch）→ CUDA/cuDNN → 容器运行时 → device plugin。每一层都要和驱动版本对齐。',
      why: '这套栈的版本是链式依赖的。差一个版本，轻则少一半能力（NVLink 不工作、RDMA 走 CPU），重则容器里根本看不到卡。',
      pitfalls: [
        '只装驱动不装 fabricmanager。SXM 机型上 NVLink 直接不可用。',
        '忘了 nvidia-peermem。RDMA 会静默退化成 CPU 拷贝，带宽掉到 1/4。',
        '升级驱动不升 fabricmanager。这是最经典的"升级后变慢"。'
      ],
      verify: 'nvidia-smi 看驱动版本，nvidia-smi topo -m 看 NVLink，lsmod | grep peermem 看 RDMA 加速，docker run --rm --gpus all nvidia/cuda nvidia-smi 验容器。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M07.quiz');
      return R.shuffle([
        { q: 'nvidia-fabricmanager 的版本要求是？', options: ['无所谓', '必须与驱动完全一致', '只要比驱动新', '只要比驱动旧'], answer: 1, why: '版本不一致时 NVSwitch 不工作，表现为 topo 全 SYS。' },
        { q: 'GPUDirect RDMA 依赖哪个内核模块？', options: ['nvidia-peermem', 'gdrcopy', 'fabricmanager', 'ib_core'], answer: 0, why: 'peermem 让网卡能直接读写显存；缺了它就会退化成经 CPU 拷贝。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M08 可见性与隔离 ============================ */

  var M08 = {
    id: 'M08', plane: 'L2', title: '设备可见性与隔离',
    subtitle: '为什么容器里只看到两张卡',
    atoms: ['B', 'D', 'C'], requires: ['M04', 'M07'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.pick({
        id: 'M08', key: 's1', atom: 'B', title: '容器里少了几张卡',
        cases: [
          {
            k: 'env', t: '容器里只看到 2 张卡',
            p: '宿主机 nvidia-smi 有 8 张卡。容器启动后 nvidia-smi 只显示 2 张（编号 0、1）。\n' +
              '容器启动参数：`--gpus all`，环境变量 `NVIDIA_VISIBLE_DEVICES=0,1`。',
            o: [
              ['NVIDIA_VISIBLE_DEVICES 限定了注入容器的设备，改成 all 或去掉该变量', '正确。toolkit 按这个变量决定把哪些设备挂进容器，--gpus all 会被它覆盖。'],
              ['容器显存不够', '不成立。这是设备枚举，不是显存。'],
              ['驱动只支持 2 卡', '不成立。宿主机能看到 8 张。'],
              ['需要开 MIG', '不成立。MIG 是切分，不是隐藏。']
            ], a: 0
          },
          {
            k: 'index', t: '容器里编号和宿主机对不上',
            p: '宿主机上 GPU5 有问题想避开。容器里用 CUDA_VISIBLE_DEVICES=5 却报越界，\n' +
              '而容器里 nvidia-smi 显示的编号是 0~7 中的一部分。',
            o: [
              ['容器内的 CUDA 编号是按"注入顺序"重排的，要按容器内 nvidia-smi 的编号去选，或用 UUID', '正确。注入后编号会从 0 重排，最稳的是用 GPU UUID。'],
              ['CUDA 版本问题', '不成立。越界是编号语义问题。'],
              ['需要 --privileged', '不成立。特权模式解决不了编号重排。'],
              ['驱动 bug', '不成立。这是设计如此。']
            ], a: 0
          },
          {
            k: 'mig', t: 'MIG 实例在容器里认不出来',
            p: '宿主机上切了 7 个 MIG 实例，nvidia-smi -L 能看到 MIG 设备 UUID。\n' +
              '容器里 nvidia-smi 能看到整卡，但程序用不到 MIG 实例。',
            o: [
              ['需要按 MIG UUID 指定设备（NVIDIA_VISIBLE_DEVICES=MIG-xxx），只给序号不生效', '正确。MIG 的可见性走 UUID，不是序号。'],
              ['MIG 不支持容器', '不成立。官方支持。'],
              ['需要重装驱动', '不成立。宿主机能识别。'],
              ['需要关闭 IOMMU', '不成立。与 MIG 可见性无关。']
            ], a: 0
          }
        ],
        hint: '分清三件事：设备注没注入、注入后怎么编号、MIG 用序号还是 UUID。',
        sideNote: '容器里的 GPU 编号是"重排过的"，这一点坑过无数人。'
      }),
      F.pick({
        id: 'M08', key: 's2', atom: 'D', title: '选隔离方式',
        cases: [
          {
            k: 'choose', t: '多租户该用 MIG 还是 time-slicing',
            p: '一个 8 卡集群要给三个团队共用：\n' +
              'A 团队跑在线推理，要求延迟稳定、不能被别人影响；\n' +
              'B 团队跑离线批处理，只要求吞吐；\n' +
              'C 团队做开发调试，用卡时间短、要快。',
            o: [
              ['A 用 MIG 硬隔离，B 用整卡或 time-slicing 抢空闲，C 用 time-slicing 快速拿到卡', '正确。按"隔离要求"分层：硬隔离给 SLA，软共享给弹性。'],
              ['全部用 MIG，最安全', '不成立。MIG 切死后无法弹性，批处理会浪费，且开发调试拿不到整卡。'],
              ['全部用 time-slicing，最省事', '不成立。time-slicing 是分时假共享，A 的延迟会被别人拖崩。'],
              ['全部独占整卡，最简单', '不成立。利用率会极低，成本翻倍。']
            ], a: 0
          },
          {
            k: 'mps', t: '两个进程跑同一张卡互相拖慢',
            p: '两个推理进程共享一张卡，各自只有 30% 利用率，但延迟都翻倍。\n' +
              '显存各占一半，没有 OOM。',
            o: [
              ['默认的时间片轮转会让两个进程互相抢占 SM，改用 MPS 让它们真正并行，或直接分卡', '正确。分时共享靠上下文切换，MPS 才是同卡并行。'],
              ['显存不够', '不成立。没有 OOM。'],
              ['需要开 NVLink', '不成立。同卡内不需要。'],
              ['CPU 不够', '不成立。两个进程各自利用率都很低，说明在互相等。']
            ], a: 0
          },
          {
            k: 'spec', t: '要保证推理的 P99 延迟',
            p: '在线推理服务要求 P99 延迟稳定在 200ms 内，但同卡上还跑着离线任务。\n' +
              '压测时 P99 会突然飙到 800ms。',
            o: [
              ['离线任务和在线任务必须物理隔离（MIG 或分卡），共享 GPU 无法保证尾延迟', '正确。P99 是排队问题，共享资源就一定会有长尾。'],
              ['加优先级就行', '不成立。GPU 没有可靠的抢占优先级机制。'],
              ['限制离线任务的 batch', '缓解但不够，仍会有干扰。'],
              ['提高 GPU 频率', '不成立。尾延迟来自排队，不是算力。']
            ], a: 0
          }
        ],
        hint: '先问"能不能接受被别人影响"。能接受就共享，不能就硬隔离。',
        sideNote: '隔离等级决定 SLA 上限，共享省下的钱常常用尾延迟还回去。'
      }),
      F.calc({
        id: 'M08', key: 's3', title: '算 MIG 切分账',
        make: function (r) {
          var kind = r.int(2);
          if (kind === 0) {
            return {
              q: '一张 80GB 的卡切成 7 个 1g.10gb 的 MIG 实例。\n\n' +
                '7 个实例加起来的可用显存是多少 GB？',
              expected: 70, unit: 'GB', label: '可用显存', digits: 0,
              steps: ['7 × 10 = 70 GB', '剩下 10GB 是切分的固定开销，不能分配',
                '所以 MIG 不是"把 80GB 分完"，是按切片规格给'],
              misread: [{ f: 1.143, title: '按 80GB 算了', text: '切分有固定开销，7 个实例只拿到 70GB。' }],
              sideNote: '这也是为什么 1g.10gb 的实际可用显存略小于 10GB。'
            };
          }
          return {
            q: '同样切 7 个 1g.10gb 实例，单个实例的算力约占整卡的百分之多少？',
            expected: 100 / 7, unit: '%', label: '算力占比', digits: 1,
            steps: ['1g = 1 个 GPC 切片，整卡 7 个切片', '100% ÷ 7 = ' + (100 / 7).toFixed(1) + '%',
              '显存和算力是同比例切的，不存在"显存多算力少"的实例'],
            sideNote: '切分是等比的，所以 MIG 适合"多个小任务"，不适合"一个大任务"。'
          };
        }
      })
    ],
    knowledge: {
      concept: 'GPU 的"可见"由三层决定：容器运行时注入哪些设备、注入后 CUDA 怎么重排编号、MIG 用 UUID 还是序号。隔离则分三档：独占整卡、MIG 硬切、time-slicing 分时共享。',
      why: '多租户场景下，"看得见"和"跑得稳"是两件事。看得见靠设备注入，跑得稳靠隔离等级。混淆这两件事，就会出现"卡都在但程序用错卡"和"卡都在但延迟崩了"。',
      pitfalls: [
        '以为 --gpus all 就一定是全部卡。NVIDIA_VISIBLE_DEVICES 会覆盖它。',
        '用宿主机编号在容器里选卡。容器内编号是重排过的。',
        '用 time-slicing 承载在线服务。它是分时共享，尾延迟无法保证。'
      ],
      verify: '容器里跑 nvidia-smi -L 看编号与 MIG UUID，再看进程实际绑到哪张卡（nvidia-smi 的进程列表）。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M08.quiz');
      return R.shuffle([
        { q: 'time-slicing 的本质是？', options: ['显存切分', '多个进程分时轮流用整卡', '硬件隔离', '算力配额'], answer: 1, why: '它是时间片轮转，不是隔离，所以尾延迟无法保证。' },
        { q: '容器里用 MIG 实例，最稳的指定方式是？', options: ['用序号 0', '用 MIG UUID', '用 --privileged', '用 hostNetwork'], answer: 1, why: 'MIG 设备在容器里按 UUID 识别，序号会漂。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M09 单机观测与排障 ============================ */

  var M09 = {
    id: 'M09', plane: 'L2', title: '单机观测与排障',
    subtitle: '五条命令，覆盖八个方向',
    atoms: ['A', 'B'], requires: ['M07'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.match({
        id: 'M09', key: 's1', title: '命令能查什么',
        make: function () {
          return {
            q: '把五条命令和它真正能回答的问题连起来。',
            left: [
              { id: 'l1', label: 'nvidia-smi' },
              { id: 'l2', label: 'nvidia-smi topo -m' },
              { id: 'l3', label: 'lspci -tv' },
              { id: 'l4', label: 'numactl -H' },
              { id: 'l5', label: 'ibv_devinfo' }
            ],
            right: [
              { id: 'r1', label: '显存、利用率、温度、功耗、进程占用' },
              { id: 'r2', label: '卡与卡、卡与网卡之间隔了几层' },
              { id: 'r3', label: 'PCIe 树的形状、链路宽度与代数' },
              { id: 'r4', label: 'NUMA 节点、各节点内存与 CPU 分布' },
              { id: 'r5', label: 'IB 设备状态、端口速率、链路层' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4', l5: 'r5' },
            why: {
              l1: '最常用也最容易被误读：利用率高不等于跑得快。',
              l2: '七个关系码的出处。通信慢先看这张表。',
              l3: '看链路是 x16 还是 x8、Gen5 还是 Gen1，一眼定位降级。',
              l4: '判断进程该绑哪个 NUMA，以及内存插得对不对。',
              l5: 'IB 侧的问题：端口 down、速率降级、链路层错误。'
            }
          };
        },
        hint: '按"看卡、看路径、看树、看内存、看网"五个方向分。',
        sideNote: '排障不是靠猜，是靠这五条命令把范围一步步缩小。'
      }),
      F.pick({
        id: 'M09', key: 's2', atom: 'B', title: '下一步敲哪条',
        cases: [
          {
            k: 'next', t: '跨机慢，先查什么',
            p: '8 卡机跨机 all-reduce 只有 12 GB/s。\n' +
              '已知：nvidia-smi 显示 8 张卡正常，CPU 占用不高。\n\n' +
              '下一步最该敲的是？',
            o: [
              ['nvidia-smi topo -m：先确认 GPU 与网卡之间是 PIX 还是 SYS', '正确。跨机慢的第一嫌疑是网卡插错 NUMA，而这张表一眼就能看出来。'],
              ['重装 NCCL', '不成立。还没定位就重装，属于碰运气。'],
              ['换网线', '不成立。先看拓扑，再动物理件。'],
              ['fio 测磁盘', '不成立。磁盘与 all-reduce 无关。']
            ], a: 0
          },
          {
            k: 'ecc', t: '偶发结果不一致',
            p: '训练偶尔出现 loss 突然变成 NaN，重启后恢复，\n' +
              '同一份数据同一份代码，复现概率约 1%。',
            o: [
              ['先查 nvidia-smi -q 的 ECC 与 retired pages，以及 dmesg 里的 XID', '正确。偶发数值异常首先要排除硬件静默错误。'],
              ['调小学习率', '不成立。NaN 不是学习率问题，先排除硬件。'],
              ['换数据集', '不成立。同数据同代码，概率 1%，指向随机性硬件错误。'],
              ['升级框架版本', '不成立。先排除硬件再谈软件。']
            ], a: 0
          },
          {
            k: 'dmon', t: '看 dmon 能得出什么',
            p: 'nvidia-smi dmon 输出：\n' +
              ' gpu  sm  mem  enc  dec   mclk   pclk    pwr  temp\n' +
              '   0  99   98    0    0   2619   1410   690    88\n' +
              '   1  12    9    0    0    2619   1410   180    62',
            o: [
              ['GPU0 在满负荷且已到温度墙附近，GPU1 基本闲置——问题在负载不均衡，不在单卡性能', '正确。sm 99 vs 12、温度 88 vs 62，一眼看出分配不均。'],
              ['GPU1 坏了', '不成立。它只是没活干。'],
              ['需要加显存', '不成立。mem 是显存带宽利用率，不是容量。'],
              ['需要换电源', '不成立。功耗 690W 属正常满载。']
            ], a: 0
          }
        ],
        hint: '排障顺序：先分层（卡/路径/网络/存储），再取证，最后才动手。',
        sideNote: '最有价值的能力不是记住命令，是知道"下一个问题该问谁"。'
      }),
      F.pick({
        id: 'M09', key: 's3', atom: 'B', title: '读 ECC 与 XID',
        cases: [
          {
            k: 'xid48', t: 'dmesg 里的 XID 48',
            world: {
              gpus: [{ idx: 3, eccDbe: 3, retired: 2 }],
              kernel: [
                '[ 8123.441210] NVRM: Xid (PCI:0000:41:00): 48, pid=20481, Double Bit ECC Error',
                '[ 8123.442001] NVRM: Xid (PCI:0000:41:00): 48, pid=20481, Double Bit ECC Error',
                '[ 8190.110234] NVRM: Xid (PCI:0000:41:00): 48, pid=20481, Double Bit ECC Error'
              ]
            },
            p: 'dmesg 反复出现：\n' +
              'NVRM: Xid (PCI:0000:3b:00): 48, pid=..., Double Bit ECC Error\n' +
              'nvidia-smi -q 显示 Volatile ECC Errors: Double Bit = 3。',
            o: [
              ['双比特 ECC 不可纠正，该卡已不可信，应摘除并走 RMA', '正确。DBE 是数据已损坏，继续用会污染训练结果。'],
              ['重启即可恢复', '不成立。DBE 是硬件级不可纠正错误。'],
              ['关闭 ECC 继续跑', '不成立。关 ECC 只是不报错，数据照样错。'],
              ['升级驱动', '不成立。驱动改不了显存颗粒。']
            ], a: 0
          },
          {
            k: 'xid79', t: 'XID 79 掉卡',
            world: {
              absent: [5],
              kernel: [
                '[ 8123.441210] NVRM: Xid (PCI:0000:45:00): 79, pid=20481, GPU has fallen off the bus.',
                '[ 8123.442001] nvidia 0000:45:00.0: PCIe Bus Error: severity=Uncorrected',
                '[ 8124.110234] NVRM: GPU 00000000:45:00.0: GPU is lost. Reboot may be required.'
              ]
            },
            p: '训练中一张卡从 nvidia-smi 消失，dmesg 有：\n' +
              'NVRM: Xid (PCI:0000:5e:00): 79, GPU has fallen off the bus。',
            o: [
              ['GPU 从总线上掉了，多为供电或 PCIe 链路问题；先看 SEL 日志与供电，再考虑换卡', '正确。XID 79 是"掉总线"，最常见的根因是供电瞬断或链路不稳。'],
              ['驱动崩溃，重装驱动', '不成立。掉总线是硬件层。'],
              ['需要扩容显存', '不成立。与显存容量无关。'],
              ['网络超时', '不成立。这是本地 PCIe 事件。']
            ], a: 0
          },
          {
            k: 'crc', t: 'NVLink CRC 持续增长',
            world: {
              gpus: [{ idx: 2, nvlinkBad: 3, nvlinkCrc: 4312 }],
              kernel: [
                '[ 8044.221001] nvidia-nvswitch: NVSW0 link 11 CRC error threshold reached (count 4312)'
              ]
            },
            p: 'nvidia-smi nvlink -e 显示 GPU2 的 Link 3 CRC 错误计数在 10 分钟内从 0 涨到 4000，\n' +
              '但训练暂时没有报错。',
            o: [
              ['链路质量在劣化，虽然还没到掉链，应立即记录并计划更换该链路或基板', '正确。CRC 增长是掉链的前兆，趁没出事处理。'],
              ['CRC 不影响性能，忽略', '不成立。重传会吃掉带宽，迟早掉链。'],
              ['直接重启机器', '不成立。重启清计数，掩盖问题。'],
              ['更换网卡', '不成立。NVLink 与网卡无关。']
            ], a: 0
          }
        ],
        hint: 'XID 的号码就是答案的一半：48 是 ECC，79 是掉总线，74 是 NVLink。',
        sideNote: '硬件故障最怕"能跑就继续"。DBE 和 CRC 增长都该立刻处理。'
      })
    ],
    knowledge: {
      concept: '单机排障只需要五条命令：nvidia-smi 看卡，topo -m 看路径，lspci -tv 看树，numactl -H 看内存，ibv_devinfo 看网。',
      why: '所有单机问题最终都落在"卡、路径、内存、网络"四件事上。先把范围缩到一类，再看具体计数器和日志，比盲目重装快十倍。',
      pitfalls: [
        '把利用率当成性能指标。99% 可能只是在等数据。',
        '看到 CRC 增长不管。它是掉链前兆，不是噪音。',
        'DBE 之后重启继续跑。数据已经错了，训练结果不可信。'
      ],
      verify: 'nvidia-smi -q 看 ECC 与 retired pages，nvidia-smi nvlink -e 看 CRC，ipmitool sel list 看硬件事件。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M09.quiz');
      return R.shuffle([
        { q: 'XID 79 表示什么？', options: ['显存 ECC 错误', 'GPU 从 PCIe 总线上掉线', 'NVLink 降级', '驱动版本不匹配'], answer: 1, why: 'GPU has fallen off the bus，多与供电或链路有关。' },
        { q: '跨机通信慢，第一步该看什么？', options: ['重装 NCCL', 'nvidia-smi topo -m', '换网线', '测磁盘'], answer: 1, why: '先确认 GPU 与网卡的相对位置，插错 NUMA 是最常见原因。' }
      ]).slice(0, 2);
    }
  };

  REG.declare(M06);
  REG.declare(M07);
  REG.declare(M08);
  REG.declare(M09);

  root.M06 = M06;
  root.M07 = M07;
  root.M08 = M08;
  root.M09 = M09;
})(typeof globalThis !== 'undefined' ? globalThis : this);
