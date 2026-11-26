(function (root) {
  'use strict';

  var F = root.TopoFactory;
  var REG = root.TopoRegistry;

  /* ============================ M15 K8s 底座 ============================ */

  var M15 = {
    id: 'M15', plane: 'L4', title: 'K8s 底座',
    subtitle: '一个 Pod 是怎么被造出来的',
    atoms: ['A', 'B'], requires: ['M06'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.sort({
        id: 'M15', key: 's1', title: '排调度链路',
        make: function () {
          return {
            q: '一次 `kubectl apply` 到容器真正跑起来，把经过的环节排一遍。',
            items: [
              { id: 'a', label: 'kubectl 把 YAML 发给 API Server' },
              { id: 'b', label: 'API Server 校验并写入 etcd' },
              { id: 'c', label: 'Scheduler 监听到未绑定的 Pod，选节点' },
              { id: 'd', label: 'kubelet 在自己节点上看到该 Pod' },
              { id: 'e', label: 'kubelet 调用 CRI 创建容器' },
              { id: 'f', label: 'CNI 给 Pod 配网络、CSI 挂存储' },
              { id: 'g', label: '容器启动，探针开始工作' }
            ],
            correct: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
            why: [
              '所有操作的入口只有一个：API Server。',
              'etcd 是唯一的事实来源，写进去才算存在。',
              '调度器只做一件事：给 Pod 选一个节点，它不创建容器。',
              'kubelet 是节点上的常驻代理，负责"让实际状态等于期望状态"。',
              'CRI 是 kubelet 与容器运行时的接口。',
              '网络和存储是 Pod 能对外服务的前提。',
              '探针通过后，Service 才会把流量导进来。'
            ]
          };
        },
        hint: '记住"Scheduler 只选节点、kubelet 才真正干活"。',
        sideNote: '排障时按这条链路逐段验证，比看日志猜快得多。'
      }),
      F.match({
        id: 'M15', key: 's2', title: '认三个接口',
        make: function () {
          return {
            q: '把 K8s 的四个扩展点和它负责的事连起来。',
            left: [
              { id: 'l1', label: 'CRI' },
              { id: 'l2', label: 'CNI' },
              { id: 'l3', label: 'CSI' },
              { id: 'l4', label: 'Device Plugin' }
            ],
            right: [
              { id: 'r1', label: 'kubelet 与容器运行时之间的接口（containerd / CRI-O）' },
              { id: 'r2', label: '给 Pod 配网络：IP、路由、多网卡' },
              { id: 'r3', label: '给 Pod 挂存储卷：创建、挂载、扩容' },
              { id: 'r4', label: '把 GPU / RDMA 这类专用硬件暴露成可调度资源' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' },
            why: {
              l1: 'CRI 让 K8s 不绑定具体运行时。',
              l2: 'CNI 是网络插件的标准，Calico / Cilium / Multus 都实现它。',
              l3: 'CSI 让存储厂商不用改 K8s 代码。',
              l4: 'Device Plugin 是 GPU 能不能被调度到的关键。'
            }
          };
        },
        hint: '按"网络、存储、运行时、硬件"四个方向对。',
        sideNote: 'K8s 本身什么都不做，它只是把四件事定义成接口，让别人实现。'
      }),
      F.pick({
        id: 'M15', key: 's3', atom: 'B', title: 'Pod 为什么 Pending',
        cases: [
          {
            k: 'taint', t: 'Pod 一直 Pending',
            p: 'GPU 节点有 8 张空闲卡，Pod 事件里只有一行：\n' +
              '`0/12 nodes are available: 12 node(s) had untolerated taint {nvidia.com/gpu: true}`',
            o: [
              ['节点带了专用污点，Pod 需要加对应的 toleration 才能调度上去', '正确。事件里写得很清楚：untolerated taint。'],
              ['GPU 不够', '不成立。有 8 张空闲。'],
              ['镜像拉不下来', '不成立。那是 ImagePullBackOff，不是 Pending。'],
              ['PVC 没绑定', '不成立。事件里没提存储。']
            ], a: 0
          },
          {
            k: 'resource', t: 'Pending 且事件说资源不足',
            p: '`0/12 nodes are available: 12 Insufficient nvidia.com/gpu`。\n' +
              '但 nvidia-smi 显示每台机器都有空闲卡。',
            o: [
              ['Device Plugin 没在节点上正常运行或未上报资源，检查 plugin 的 DaemonSet 与 kubelet 的 device plugin socket', '正确。卡在但 K8s 看不到，说明上报环节断了。'],
              ['显卡坏了', '不成立。nvidia-smi 能看到。'],
              ['调度器配置错误', '不成立。调度器只是读节点上报的资源。'],
              ['需要加节点', '不成立。']
            ], a: 0
          },
          {
            k: 'pvc', t: 'Pending 且卡在存储',
            p: '`pod has unbound immediate PersistentVolumeClaims`。\n' +
              'PVC 状态 Pending，StorageClass 是 local-storage。',
            o: [
              ['本地 PV 不支持动态供应或节点亲和冲突，需要先创建对应节点的 PV 或改用支持动态供应的存储类', '正确。local-storage 通常要手工建 PV 并绑定节点。'],
              ['镜像问题', '不成立。'],
              ['网络问题', '不成立。'],
              ['GPU 不够', '不成立。']
            ], a: 0
          }
        ],
        hint: 'Pending 一定要看 describe 的 Events，事件里已经写了原因。',
        sideNote: 'K8s 的报错很啰嗦，但它几乎总是把答案写在第一行。'
      })
    ],
    knowledge: {
      concept: 'K8s 只做一件事：让实际状态等于期望状态。它把这个过程拆成 API Server（入口）、etcd（事实）、Scheduler（选节点）、kubelet（执行）四段。',
      why: 'AI 集群的复杂度在于"资源不只是 CPU 和内存"，还有 GPU、RDMA、NUMA。理解这条链路，才知道 GPU 为什么"在机器上但调度不到"。',
      pitfalls: [
        '把 Scheduler 当成创建容器的人。它只选节点。',
        'Pod Pending 就加机器。先看 Events，多半是污点或 device plugin。',
        '以为 GPU 插上就能被调度。没有 Device Plugin，K8s 看不见它。'
      ],
      verify: 'kubectl describe pod 看 Events，kubectl get nodes -o yaml 看 allocatable 里的 nvidia.com/gpu。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M15.quiz');
      return R.shuffle([
        { q: '谁负责给 Pod 选节点？', options: ['kubelet', 'Scheduler', 'API Server', 'etcd'], answer: 1, why: 'Scheduler 只做调度决策，创建容器是 kubelet 的事。' },
        { q: 'GPU 在机器上但 Pod 报资源不足，最可能是？', options: ['显卡坏了', 'Device Plugin 没上报', '调度器 bug', '网络问题'], answer: 1, why: 'K8s 依靠 device plugin 上报 nvidia.com/gpu 这种扩展资源。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M16 GPU 调度 ============================ */

  var M16 = {
    id: 'M16', plane: 'L4', title: 'GPU 调度',
    subtitle: '碎片、gang、配额与抢占',
    atoms: ['B', 'D', 'C'], requires: ['M15'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.pick({
        id: 'M16', key: 's1', atom: 'B', title: '每台都闲 3 张却调度不上',
        cases: [
          {
            k: 'frag', t: '8 卡作业永远 Pending',
            p: '4 台机器，每台 8 卡。已经跑了 3 个 4 卡作业，分布在 3 台机器上（每台占 4 张）。\n' +
              '现在提交一个 8 卡作业，一直 Pending。\n' +
              'nvidia-smi 看总共还有 20 张空闲。',
            o: [
              ['资源碎片：空闲卡分散在多台机器上，凑不出一台 8 卡；需要 gang 调度或拓扑感知的装箱策略', '正确。K8s 默认按单节点分配，跨节点的空闲卡不能拼。'],
              ['GPU 数量不够', '不成立。总量够，是分布问题。'],
              ['配额限制', '不成立。事件会说 quota。'],
              ['镜像问题', '不成立。']
            ], a: 0
          },
          {
            k: 'gang', t: '分布式作业起了一半',
            p: '8 个 Pod 的训练作业，起来了 6 个，2 个 Pending。\n' +
              '已起的 6 个一直占着卡空转，等另外 2 个。',
            o: [
              ['缺少 gang scheduling：作业要么全起要么全不起，需要 Volcano / Kueue 这类调度器', '正确。默认调度是逐个 Pod 决策，会出现"起一半卡死"。'],
              ['应该加机器', '缓解但没解决根本问题。'],
              ['需要把 Pod 改成 Job', '不成立。Job 也是逐个调度。'],
              ['需要 GPU 亲和', '不成立。']
            ], a: 0
          },
          {
            k: 'numa', t: '调度上去了但性能差',
            p: 'Pod 分到 2 张卡，跑起来比预期慢 40%。\n' +
              '进容器看，两张卡分属不同 NUMA，网卡在第三个 NUMA。',
            o: [
              ['调度只保证"有卡"，不保证"卡与网卡同 NUMA"；需要拓扑感知调度（NUMA / NVLink 域对齐）', '正确。默认 device plugin 是"随便给两张"。'],
              ['卡性能不一致', '不成立。'],
              ['需要开 MIG', '不成立。'],
              ['需要更多显存', '不成立。']
            ], a: 0
          }
        ],
        hint: '先分"总量够不够"和"能不能拼成一台"，再看"拼的位置对不对"。',
        sideNote: 'GPU 调度的三层：有没有、拼不拼得上、拼得好不好。'
      }),
      F.pick({
        id: 'M16', key: 's2', atom: 'D', title: '配额还是抢占',
        cases: [
          {
            k: 'policy', t: '两个团队抢同一批卡',
            p: '集群 64 卡，两个团队共用：\n' +
              'A 团队跑在线推理，必须随时能扩；\n' +
              'B 团队跑离线训练，可以等，但希望吃满空闲。',
            o: [
              ['给 A 设保底配额 + 高优先级可抢占，B 用剩余资源且可被抢占，B 的任务支持 checkpoint 续跑', '正确。保底保证 SLA，抢占保证利用率，checkpoint 让抢占可承受。'],
              ['两边平分配额，谁也不许多用', '不成立。会浪费大量空闲，且 A 扩容受限。'],
              ['先到先得，谁抢到算谁的', '不成立。A 的 SLA 无法保证。'],
              ['全部给 A，B 排队', '不成立。利用率极低。']
            ], a: 0
          },
          {
            k: 'preempt', t: '抢占会不会把训练打断',
            p: '开启抢占后，B 团队的训练任务经常被踢，每次都从头开始。',
            o: [
              ['抢占策略必须配合 checkpoint 与断点续训；否则抢占的代价就是全部重算', '正确。抢占本身没错，没有续训能力才是问题。'],
              ['应该关闭抢占', '不成立。会退回低利用率。'],
              ['应该提高 B 的优先级', '不成立。那 A 就没法扩了。'],
              ['应该加机器', '缓解成本问题，不是机制问题。']
            ], a: 0
          },
          {
            k: 'quota', t: '配额满了但集群很空',
            p: '某命名空间报 `exceeded quota: gpu-quota`，但集群整体还有 40 张空闲卡。',
            o: [
              ['ResourceQuota 是按命名空间的上限，集群有空不等于该租户能用；需要调整配额或走共享池', '正确。配额是治理手段，与物理空闲无关。'],
              ['集群资源统计错误', '不成立。'],
              ['需要重装 device plugin', '不成立。'],
              ['GPU 坏了', '不成立。']
            ], a: 0
          }
        ],
        hint: '先分清"物理有没有"和"你有没有资格用"。',
        sideNote: '配额管公平，抢占管效率，两者必须一起设计。'
      }),
      F.calc({
        id: 'M16', key: 's3', title: '算碎片率',
        make: function (r) {
          var nodes = r.pick([4, 8]);
          var per = 8;
          var used = r.pick([3, 5, 6]);
          var free = nodes * per - used * 4;
          var frag = free / (nodes * per) * 100;
          return {
            q: nodes + ' 台机器，每台 ' + per + ' 张卡。已跑 ' + used + ' 个 4 卡作业，各占一台机器的一半。\n\n' +
              '当前 GPU 空闲率是多少 %？（保留一位小数）',
            expected: frag, unit: '%', label: '空闲率', digits: 1,
            steps: ['总量 = ' + nodes + ' × ' + per + ' = ' + (nodes * per) + ' 张',
              '已用 = ' + used + ' × 4 = ' + (used * 4) + ' 张，空闲 = ' + free + ' 张',
              '空闲率 = ' + free + ' / ' + (nodes * per) + ' = ' + frag.toFixed(1) + '%'],
            misread: [{ f: (nodes * per) / free, title: '除反了', text: '空闲率 = 空闲 ÷ 总量。' }],
            sideNote: '空闲率高但大作业排不上，这就是碎片——空闲的卡凑不成一整台。'
          };
        }
      })
    ],
    knowledge: {
      concept: 'GPU 调度要解决三件事：整卡分配（device plugin）、成组调度（gang）、拓扑感知（NUMA/NVLink 对齐）。再往上才是配额、抢占、公平共享。',
      why: 'GPU 是最贵的资源，利用率差 20% 就是真金白银。而碎片、半启动、跨 NUMA 这三个问题，都会让"卡都在忙"变成"卡都在等"。',
      pitfalls: [
        '以为空闲卡能自动拼起来。K8s 按单节点分配，跨节点拼不了。',
        '不做 gang 调度。分布式作业会"起一半、卡死一半"。',
        '只看有没有卡，不看卡和网卡是否同 NUMA。'
      ],
      verify: 'kubectl describe node 看 Allocated resources，看 Pod 事件里的 Insufficient 与 taint，再看容器内 topo。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M16.quiz');
      return R.shuffle([
        { q: 'gang scheduling 解决什么问题？', options: ['提升单卡性能', '作业要么全起要么全不起', '节省显存', '加速镜像拉取'], answer: 1, why: '避免分布式作业"起一半、剩下的永远等不到"。' },
        { q: '空闲卡很多但 8 卡作业排不上，原因是？', options: ['卡坏了', '资源碎片，凑不出一台整机', '配额满了', '镜像太大'], answer: 1, why: '默认按单节点分配，跨节点的空闲卡拼不到一起。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M17 训练作业与弹性 ============================ */

  var M17 = {
    id: 'M17', plane: 'L4', title: '训练作业与弹性',
    subtitle: 'checkpoint、断点续训、故障重试',
    atoms: ['B', 'C', 'A'], requires: ['M16', 'M13'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.pick({
        id: 'M17', key: 's1', atom: 'B', title: '跑 6 小时必挂',
        cases: [
          {
            k: 'leak', t: '每次跑到第 6 小时就 OOM',
            p: '训练脚本每次跑到约 6 小时就显存 OOM 退出，重启后又正常，\n' +
              'nvidia-smi 显示显存随步数缓慢上升。',
            o: [
              ['显存泄漏：某个缓存或张量没释放，随步数累积；先定位增长源，同时用 checkpoint 降低损失', '正确。缓慢单调上升是泄漏的典型形状，不是 batch 太大。'],
              ['卡坏了', '不成立。重启就好。'],
              ['数据有问题', '不成立。'],
              ['需要加显存', '不成立。泄漏最终会吃满任何容量。']
            ], a: 0
          },
          {
            k: 'nccl', t: '每隔一段时间 NCCL 超时',
            p: '训练偶尔卡住，日志报 NCCL timeout，重启后恢复，间隔不固定。\n' +
              '发生在某台机器的某张卡上。',
            o: [
              ['某节点或某张卡不稳定导致集合通信不同步，先查该机的 XID / NVLink CRC / 网络计数', '正确。NCCL 超时是"有人没跟上"的症状，不是原因。'],
              ['需要调大 timeout', '不成立。掩盖问题。'],
              ['NCCL 版本问题', '不成立。间隔不固定且绑定特定卡。'],
              ['学习率太大', '不成立。']
            ], a: 0
          },
          {
            k: 'evict', t: '作业被驱逐',
            p: '训练跑到一半 Pod 被 Evicted，事件显示 `The node was low on resource: memory`。',
            o: [
              ['容器内存 limit 设得过低或数据加载进程吃光了节点内存；调整 limit 并限制 dataloader worker 数', '正确。Evicted 是节点级内存压力，不是 GPU 问题。'],
              ['GPU 显存不足', '不成立。事件写的是 memory，不是 nvidia.com/gpu。'],
              ['需要加 GPU', '不成立。'],
              ['镜像太大', '不成立。']
            ], a: 0
          }
        ],
        hint: '看"挂的形状"：缓慢上升是泄漏，偶发是硬件，突然被杀是资源限制。',
        sideNote: '长跑任务的可靠性，靠的是"挂了能续"，不是"保证不挂"。'
      }),
      F.calc({
        id: 'M17', key: 's2', title: '算 checkpoint 的代价',
        make: function (r) {
          var size = r.pick([200, 500, 1000]);
          var bw = r.pick([2, 5, 10]);
          var interval = r.pick([10, 30, 60]);
          var cost = size / bw;
          return {
            q: '模型 checkpoint ' + size + ' GB，存储写入带宽 ' + bw + ' GB/s，\n' +
              '每 ' + interval + ' 分钟存一次。\n\n' +
              '保存一次要多少秒？',
            expected: cost, unit: 's', label: '耗时', digits: 0,
            steps: [size + ' GB ÷ ' + bw + ' GB/s = ' + cost + ' s',
              '每 ' + interval + ' 分钟（' + (interval * 60) + ' s）一次',
              '占比 = ' + (cost / (interval * 60) * 100).toFixed(2) + '% 的训练时间'],
            sideNote: '存得太勤会被 IO 拖慢，存得太稀会重算太多。'
          };
        }
      }),
      F.sort({
        id: 'M17', key: 's3', title: '排故障恢复流程',
        make: function () {
          return {
            q: '训练中一台机器宕机，从故障到恢复训练，把动作排一遍。',
            items: [
              { id: 'a', label: '某个 rank 失联，NCCL 集合通信超时' },
              { id: 'b', label: '作业管理器判定失败并终止整组进程' },
              { id: 'c', label: '节点被标记 NotReady，Pod 被重建或迁移' },
              { id: 'd', label: '从最近的 checkpoint 加载权重与优化器状态' },
              { id: 'e', label: '重新建立通信组（rendezvous）' },
              { id: 'f', label: '从断点步数继续训练' }
            ],
            correct: ['a', 'b', 'c', 'd', 'e', 'f'],
            why: [
              '故障的第一表现永远是"某个集合操作等不到人"。',
              '必须整组退出，不能只重启一个 rank，否则通信组对不上。',
              'K8s 侧把故障节点摘掉，新 Pod 起来。',
              '先恢复状态，再建通信组。',
              '所有 rank 重新握手，确定新的 world size 与拓扑。',
              '从断点继续，前面的计算不浪费。'
            ]
          };
        },
        hint: '顺序的关键是"先有状态，再有通信组"。',
        sideNote: '这条流程走顺了，节点故障就只是"损失几分钟"，不是"损失几天"。'
      })
    ],
    knowledge: {
      concept: '长跑训练任务的可靠性 = checkpoint 策略 + 故障检测 + 整组重启 + 断点续训。K8s 侧的 PyTorchJob / MPI Operator / Ray 都在做这件事。',
      why: '千卡集群一天挂几次是常态。决定项目周期的是"挂一次损失多少"，而不是"多久挂一次"。',
      pitfalls: [
        '只重启一个 rank。通信组对不上，必然再次失败。',
        'checkpoint 存得太稀。挂一次损失几小时。',
        '以为调大 NCCL timeout 能解决问题。它只是把暴露时间推后。'
      ],
      verify: '手动 kill 一个 rank，看作业能否自动恢复到最近 checkpoint，并记录恢复耗时。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M17.quiz');
      return R.shuffle([
        { q: '一个 rank 挂了，正确做法是？', options: ['只重启那一个', '整组退出后一起重启', '忽略继续跑', '换一张卡'], answer: 1, why: '通信组要求所有 rank 状态一致，必须整组重建。' },
        { q: 'checkpoint 频率怎么定？', options: ['越勤越好', '在"IO 开销"和"重算损失"之间取平衡', '每小时一次固定', '不用存'], answer: 1, why: '存一次有成本，挂一次有损失，两者相等时最优。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M18 网络与存储接入 ============================ */

  var M18 = {
    id: 'M18', plane: 'L4', title: '网络与存储接入',
    subtitle: 'Pod 怎么拿到 RDMA 卡和共享存储',
    atoms: ['A', 'C', 'B'], requires: ['M10', 'M15'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.match({
        id: 'M18', key: 's1', title: '认四种接入方式',
        make: function () {
          return {
            q: '把四个 K8s 侧的网络/存储接入方式和它的作用连起来。',
            left: [
              { id: 'l1', label: 'Multus' },
              { id: 'l2', label: 'SR-IOV CNI' },
              { id: 'l3', label: 'CSI' },
              { id: 'l4', label: 'hostNetwork' }
            ],
            right: [
              { id: 'r1', label: '给一个 Pod 挂多张网卡（管理网 + 计算网 + 存储网）' },
              { id: 'r2', label: '把网卡的 VF 直通给 Pod，接近原生性能' },
              { id: 'r3', label: '把并行文件系统 / 块存储挂进容器' },
              { id: 'r4', label: 'Pod 直接用宿主机网络栈，省一层 NAT 但失去隔离' }
            ],
            pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' },
            why: {
              l1: 'Multus 是"多网卡的元插件"，它自己不实现网络，只负责编排。',
              l2: 'SR-IOV 绕过内核协议栈，RDMA 场景必用。',
              l3: 'CSI 是存储的标准接口，Lustre/GPFS 也有对应的驱动。',
              l4: 'hostNetwork 最省事，但端口冲突和隔离问题会接踵而来。'
            }
          };
        },
        hint: '按"多网卡、直通、存储、宿主网络"四个词对。',
        sideNote: '训练 Pod 通常要三张网：管理、计算（RDMA）、存储。'
      }),
      F.calc({
        id: 'M18', key: 's2', title: '算落盘占比',
        make: function (r) {
          var size = r.pick([400, 800]);
          var bw = r.pick([4, 8]);
          var hours = r.pick([4, 8]);
          var cost = size / bw;
          return {
            q: '训练 ' + hours + ' 小时存一次 checkpoint，大小 ' + size + ' GB，\n' +
              '存储带宽 ' + bw + ' GB/s。\n\n' +
              '这次落盘占总训练时间的百分之几？（保留两位小数）',
            expected: cost / (hours * 3600) * 100, unit: '%', label: '占比', digits: 2,
            steps: ['落盘耗时 = ' + size + ' ÷ ' + bw + ' = ' + cost + ' s',
              '训练总时长 = ' + hours + ' × 3600 = ' + (hours * 3600) + ' s',
              '占比 = ' + cost + ' / ' + (hours * 3600) + ' = ' + (cost / (hours * 3600) * 100).toFixed(2) + '%'],
            misread: [{ f: 100, title: '忘了乘 100', text: '题目要百分比。' }],
            sideNote: '占比小不代表可以忽略：落盘期间 GPU 是闲着的，这部分是纯浪费。'
          };
        }
      }),
      F.pick({
        id: 'M18', key: 's3', atom: 'B', title: 'Pod 里没有 RDMA 设备',
        cases: [
          {
            k: 'vf', t: '容器里看不到 IB 设备',
            p: 'Pod 申请了 `rdma/rdma_shared_device_a: 1`，但容器里 ibv_devinfo 什么也没有。\n' +
              '节点上 ibstat 正常，SR-IOV operator 也在运行。',
            o: [
              ['需要 RDMA 共享设备插件或 SR-IOV 网络附件（NetworkAttachmentDefinition），只申请资源不会自动挂设备', '正确。资源申请与设备注入是两件事，要配套 CNI/device plugin。'],
              ['网卡坏了', '不成立。节点上 ibstat 正常。'],
              ['需要 --privileged', '可行但不该是首选，共享设备插件是标准做法。'],
              ['驱动没装', '不成立。节点正常。']
            ], a: 0
          },
          {
            k: 'mtu', t: '跨节点吞吐只有一半',
            p: 'Pod 之间走计算网通信，实测 25 GB/s，宿主机上直连能到 48 GB/s。\n' +
              'Pod 的网卡是 veth，MTU 1500。',
            o: [
              ['Pod 走了默认的 overlay/veth 路径而不是 SR-IOV 直通，MTU 与协议栈开销都会拖慢；应改用 SR-IOV 或 hostNetwork', '正确。veth + 1500 MTU 是典型的性能损失来源。'],
              ['交换机限速', '不成立。宿主机直连能跑满。'],
              ['需要开 PFC', '不成立。'],
              ['GPU 不够', '不成立。']
            ], a: 0
          },
          {
            k: 'pvc', t: '多个 Pod 要共享同一份数据',
            p: '8 个训练 Pod 都要读同一份数据集，用 PVC 挂载后只有第一个能写，其余报 read-only。',
            o: [
              ['PVC 的访问模式是 RWO，需要改成 RWX（共享文件系统）或每 Pod 各挂一份只读副本', '正确。RWO 是单节点读写，多 Pod 跨节点必须 RWX。'],
              ['存储坏了', '不成立。报的是只读。'],
              ['需要加磁盘', '不成立。'],
              ['权限问题', '不成立。是访问模式限制。']
            ], a: 0
          }
        ],
        hint: '先看数据走的是哪条路径：veth、SR-IOV、还是宿主网络。',
        sideNote: 'K8s 里的"能用"和"跑得快"差着一整套 CNI 配置。'
      })
    ],
    knowledge: {
      concept: '训练 Pod 需要三张网（管理、计算、存储）和一份共享数据。Multus 负责多网卡，SR-IOV 负责直通，CSI 负责存储，hostNetwork 是省事的退路。',
      why: '默认的 overlay 网络是为微服务设计的，MTU 和协议栈开销会让 RDMA 性能腰斩。AI 场景必须把计算网从 overlay 里拿出来。',
      pitfalls: [
        '以为申请了 rdma 资源就有设备。资源与设备注入是两套机制。',
        '用 RWO 的 PVC 给多 Pod 共享。跨节点必然只读冲突。',
        '计算网走 veth。带宽直接掉一半。'
      ],
      verify: '容器里 ibv_devinfo 看设备，ip link 看 MTU，kubectl get pvc 看访问模式。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M18.quiz');
      return R.shuffle([
        { q: 'Multus 的作用是？', options: ['加速网络', '给 Pod 挂多张网卡', '做存储', '做调度'], answer: 1, why: '它是多网卡的元插件，把多张网卡编排进一个 Pod。' },
        { q: '多 Pod 跨节点共享同一份数据，PVC 要用哪种访问模式？', options: ['RWO', 'ROX', 'RWX', '随便'], answer: 2, why: 'RWX 支持多节点读写，通常依赖共享文件系统。' }
      ]).slice(0, 2);
    }
  };

  /* ============================ M19 镜像与离线交付 ============================ */

  var M19 = {
    id: 'M19', plane: 'L4', title: '镜像与离线交付',
    subtitle: '20GB 的镜像怎么发到 32 个节点',
    atoms: ['C', 'B', 'A'], requires: ['M15'],
    stageKeys: ['s1', 's2', 's3'],
    stages: [
      F.calc({
        id: 'M19', key: 's1', title: '算镜像分发时间',
        make: function (r) {
          var nodes = r.pick([16, 32, 64]);
          var size = r.pick([10, 20]);
          var bw = r.pick([1, 2, 4]);
          return {
            q: '集群 ' + nodes + ' 个节点，每个节点都要拉一份 ' + size + ' GB 的训练镜像。\n' +
              '镜像仓库的总出口带宽是 ' + bw + ' GB/s（所有节点共享）。\n\n' +
              '全部拉完至少需要多少秒？',
            expected: nodes * size / bw, unit: 's', label: '总时间', digits: 0,
            steps: ['总数据量 = ' + nodes + ' × ' + size + ' = ' + (nodes * size) + ' GB',
              '÷ 出口带宽 ' + bw + ' GB/s = ' + (nodes * size / bw) + ' s',
              '这就是为什么大集群要用 P2P 分发（dragonfly 之类）'],
            misread: [{ f: 1 / nodes, title: '以为可以并行就无限快', text: '瓶颈是仓库出口，节点再多也不会更快。' }],
            sideNote: '镜像越大，仓库出口越是唯一的瓶颈。'
          };
        }
      }),
      F.pick({
        id: 'M19', key: 's2', atom: 'B', title: '镜像拉取超时',
        cases: [
          {
            k: 'pull', t: 'Pod 卡在 ImagePullBackOff',
            p: 'Pod 事件：`Failed to pull image: ... dial tcp 10.x.x.x:5000: i/o timeout`。\n' +
              '节点上 curl 这个地址也不通，但同网段其他机器能通。',
            o: [
              ['该节点到私有仓库的网络不通（路由/安全组/防火墙），先修网络而不是重推镜像', '正确。同网段其他机器能通，说明是单节点路径问题。'],
              ['镜像不存在', '不成立。不存在会报 manifest unknown。'],
              ['仓库磁盘满了', '不成立。会报 500。'],
              ['需要加 --insecure-registry', '不成立。insecure 是 TLS 问题，不是 timeout。']
            ], a: 0
          },
          {
            k: 'size', t: '拉取很慢但不报错',
            p: '镜像 25GB，每台机器拉取耗时 40 分钟，滚动发布一次要等两小时。',
            o: [
              ['镜像过大且没有分层缓存与预拉取；应拆分镜像、节点预热、或用 P2P 分发', '正确。40 分钟的绝对时间说明是体积与出口带宽问题。'],
              ['网络坏了', '不成立。能拉完，只是慢。'],
              ['需要换仓库', '可能缓解，但不解决体积问题。'],
              ['需要加内存', '不成立。']
            ], a: 0
          },
          {
            k: 'digest', t: '镜像 tag 一样但内容不同',
            p: '两个节点拉同一个 tag，跑出来的行为不一致。',
            o: [
              ['tag 是可变的，同一 tag 可能指向不同 digest；生产必须用 digest 固定版本', '正确。tag 只是别名，digest 才是内容地址。'],
              ['镜像仓库坏了', '不成立。'],
              ['节点时钟不同步', '不成立。'],
              ['需要清理缓存', '缓解但没解决可复现性问题。']
            ], a: 0
          }
        ],
        hint: '区分"拉不到"和"拉得慢"：前者是网络或权限，后者是体积与带宽。',
        sideNote: '生产环境用 digest 而不是 tag，是可复现性的底线。'
      }),
      F.sort({
        id: 'M19', key: 's3', title: '排离线交付流程',
        make: function () {
          return {
            q: '把一套训练镜像交付到完全隔离的内网集群，把步骤排一遍。',
            items: [
              { id: 'a', label: '在外网环境构建并打上 digest' },
              { id: 'b', label: 'docker save 导出为 tar（含所有层）' },
              { id: 'c', label: '通过摆渡机把 tar 送进内网' },
              { id: 'd', label: '在内网私有仓库 docker load 并 push' },
              { id: 'e', label: '校验内网镜像 digest 与外网一致' },
              { id: 'f', label: '节点预拉取并部署' }
            ],
            correct: ['a', 'b', 'c', 'd', 'e', 'f'],
            why: [
              '先在能联网的地方把镜像造好，并记录 digest。',
              'save 会把所有层打成一个包，体积大但完整。',
              '物理隔离只能靠摆渡，这也是最慢的一步。',
              '内网仓库是节点唯一能访问的镜像源。',
              'digest 一致才说明内容没被改动。',
              '预拉取能把发布时的等待时间挪到前面。'
            ]
          };
        },
        hint: '关键是"内容地址"：digest 一致，才算同一份镜像。',
        sideNote: '离线交付的痛点不是技术，是流程与校验。'
      })
    ],
    knowledge: {
      concept: '镜像分发 = 体积 × 节点数 ÷ 出口带宽。大集群要靠 P2P 分发、节点预热、镜像精简来摊薄这个成本。',
      why: '训练镜像动辄 20GB，32 个节点就是 640GB。发布一次等两小时，迭代速度直接被拖死。',
      pitfalls: [
        '用 tag 当版本。tag 可变，digest 才是内容地址。',
        '以为节点多拉得快。瓶颈是仓库出口。',
        '离线环境不校验 digest。传坏了也看不出来。'
      ],
      verify: 'docker images --digests 看 digest，crictl pull 计时，节点上 crictl images 确认层齐全。'
    },
    quiz: function (seed) {
      var R = root.TopoRng.stream(seed, 'M19.quiz');
      return R.shuffle([
        { q: '32 节点 × 20GB 镜像，仓库出口 1GB/s，至少多久？', options: ['20 秒', '640 秒', '6400 秒', '1 小时'], answer: 1, why: '640GB ÷ 1GB/s = 640 秒。' },
        { q: '生产环境固定镜像版本应该用？', options: ['latest', 'tag', 'digest', '文件名'], answer: 2, why: 'digest 是内容哈希，tag 可以被重新指向。' }
      ]).slice(0, 2);
    }
  };

  REG.declare(M15);
  REG.declare(M16);
  REG.declare(M17);
  REG.declare(M18);
  REG.declare(M19);

  root.M15 = M15;
  root.M16 = M16;
  root.M17 = M17;
  root.M18 = M18;
  root.M19 = M19;
})(typeof globalThis !== 'undefined' ? globalThis : this);
