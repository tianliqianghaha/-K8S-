(function (root) {
  'use strict';

  var M = root.TopoModel;
  var G = root.TopoGrade;
  var PL = root.TopoPlace;
  var R = root.TopoRng;

  /* =====================  s1 · A 还原拓扑  ===================== */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function genA(seed, opts) {
    var hard = !!(opts && opts.hard);
    var machine = M.generateMachine(seed, hard ? 2 : 1);
    var parts = M.formatTopoParts(machine);
    return {
      seed: seed,
      hard: hard,
      machine: machine,
      player: M.blankConfig(machine),
      matrix: M.buildMatrix(machine),
      topoTable: parts.table,
      topoLegend: parts.legend,
      topo: parts.table + '\n\n' + parts.legend,
      lscpu: M.formatLscpu(machine)
    };
  }

  function promptA(scen) {
    return {
      tabs: [
        {
          name: 'nvidia-smi topo -m',
          html: '<pre class="tpre">' + esc(scen.topoTable) + '</pre>' +
            '<div class="tleg">' + esc(scen.topoLegend) + '</div>'
        },
        { name: 'lscpu', text: scen.lscpu }
      ],
      note: '把左边托盘里的零件拖到你认为正确的层级里（也可以点零件、再点目标框）。' +
        '当反算出来的拓扑表与题目给的一模一样，这一关就过了。<br>' +
        '卡片上的 <b>PIX / PXB / PHB / NODE / SYS</b> 说的是远近，不是型号。'
    };
  }

  function judgeA(scen, ans) {
    if (!ans || !ans.config) {
      return { ok: false, score: 0, head: '还没开始摆，托盘里的零件都还在原地。', items: [] };
    }
    var pm = M.buildMatrix(ans.config);
    var diffs = M.compareMatrix(scen.matrix, pm);
    var items = diffs.slice(0, 6).map(function (d) {
      var exp = M.codeInfo(d.expected);
      var act = M.codeInfo(d.actual);
      return {
        tone: 'bad',
        title: d.a + ' ↔ ' + d.b + '：你摆成了 ' + d.actual + '，应该是 ' + d.expected,
        text: '差在【' + exp.layer + '】。' + act.short + '，而题目要求「' + exp.short + '」。' + exp.why
      };
    });
    if (diffs.length > 6) {
      items.push({
        tone: 'bad',
        title: '还有 ' + (diffs.length - 6) + ' 处对不上',
        text: '先把上面这几处改掉，剩下的大多会跟着收敛——一处摆错往往会连带好几对关系。'
      });
    }
    var placed = PL.countPlaced(ans.config);
    var total = M.allParts(ans.config).length;
    var head = diffs.length === 0
      ? '矩阵完全一致，' + total + ' 个零件各就各位。'
      : '还有 ' + diffs.length + ' 对关系对不上（已放置 ' + placed + ' / ' + total + ' 个零件）。';
    return { ok: diffs.length === 0, score: diffs.length ? 0 : 1, diffs: diffs, head: head, items: items };
  }

  function firstWrongPair(scen, ans) {
    var diffs = M.compareMatrix(scen.matrix, M.buildMatrix(ans.config));
    return diffs.length ? diffs[0] : null;
  }

  function hintA(scen, ans, lv) {
    if (lv <= 0) {
      return '先看 lscpu：NUMA node(s) 是几，就要摆几个楼。' +
        '再看拓扑表的对角线两侧——GPU 之间的码和 GPU 与网卡之间的码，是两条独立的线索。';
    }
    var d = firstWrongPair(scen, ans);
    if (!d) return '已经全对了，直接提交。';
    var exp = M.codeInfo(d.expected);
    if (lv === 1) {
      return d.a + ' ↔ ' + d.b + ' 这一对，题目要求 ' + d.expected + '（' + exp.short + '）。' +
        '你现在的摆法是 ' + d.actual + '。先想清这两个零件各自应该落在哪一层。';
    }
    var pa = M.derivePath(scen.machine, d.a);
    return '直说：' + d.a + ' 在 NUMA' + pa.numa + ' / 桥 ' + pa.bridge +
      (pa.switchPath.length ? ' / 交换芯片 ' + pa.switchPath.join(' → ') : '（直连桥，不经过交换芯片）') +
      '。对照着把 ' + d.b + ' 摆成同一层级。';
  }

  function sideA(scen, ans) {
    var pm = M.buildMatrix(ans.config);
    var placed = PL.countPlaced(ans.config);
    var total = M.allParts(ans.config).length;
    return '<div class="side-h">你的拓扑表 · 实时反算</div>' +
      '<div class="side-sub">已放置 ' + placed + ' / ' + total + ' 个零件</div>' +
      '<div class="mx-wrap">' + root.TopoRenderMatrix.html(pm, { compact: true }) + '</div>' +
      '<div class="mx-note">同一个交换芯片下 = PIX；过一层桥 = PXB；一方直连 CPU = PHB；同 NUMA 不同桥 = NODE；跨 NUMA = SYS。</div>';
  }

  function solveA(scen) {
    return { config: JSON.parse(JSON.stringify(scen.machine)) };
  }

  /* =====================  s2 · C 计算  ===================== */

  function genC(seed) {
    var r = R.stream(seed, 'M03.calc');
    var kind = r.int(3);
    var S = kind === 2 ? r.pick([6, 12, 24, 48]) : r.pick([4, 8, 16, 64]);
    var q, expected, steps;

    if (kind === 0) {
      expected = S / 32 * 1000;
      q = '一条 PCIe 5.0 x16 链路，把 ' + S + ' GB 数据从一张 GPU 搬到同一颗交换芯片下的网卡。' +
        '链路单向带宽 32 GB/s，忽略协议开销。需要多少毫秒？';
      steps = ['单向带宽 = 32 GB/s（Gen5 x16 双向 64，单向砍半）',
        '耗时 = ' + S + ' GB ÷ 32 GB/s = ' + G.round(S / 32, 4) + ' s',
        '换算 = ' + G.round(S / 32, 3) + ' × 1000 = ' + G.round(expected, 1) + ' ms'];
    } else if (kind === 1) {
      expected = S / 16 * 1000;
      q = '同一张卡，PCIe 链路协商结果从 Gen5 x16 掉到了 Gen4 x16（单向 16 GB/s），' +
        '传输 ' + S + ' GB 需要多少毫秒？';
      steps = ['Gen4 x16 单向 = 16 GB/s（Gen5 的一半）',
        '耗时 = ' + S + ' ÷ 16 = ' + G.round(S / 16, 4) + ' s',
        '换算 = ' + G.round(expected, 1) + ' ms'];
    } else {
      expected = (S / 12 - S / 32) * 1000;
      q = '两张 GPU 各发 ' + S + ' GB 到网卡：GPU0 与网卡在同一颗交换芯片下（32 GB/s），' +
        'GPU4 与网卡跨 NUMA（实测 12 GB/s）。两条流同时开始，各自跑完的耗时差多少毫秒？';
      steps = ['同芯片：' + S + ' ÷ 32 = ' + G.round(S / 32, 3) + ' s',
        '跨 NUMA：' + S + ' ÷ 12 = ' + G.round(S / 12, 3) + ' s',
        '差值 = ' + G.round(S / 12 - S / 32, 3) + ' s = ' + G.round(expected, 1) + ' ms'];
    }

    return {
      seed: seed, kind: kind, size: S, question: q, q: q,
      expected: expected, steps: steps,
      fields: [{ key: 't', label: '需要', unit: 'ms', ph: '填数字' }],
      unit: 'ms',
    };
  }

  function promptC(scen) {
    return {
      tabs: [{ name: '题目', text: scen.question }],
      note: '只填数字，单位已经给好。所有参数都在题面里，不靠背——但要小心带宽口径。'
    };
  }

  function judgeC(scen, ans) {
    var v = ans.t;
    var ok = G.near(v, scen.expected, 0.005);
    var items = [];
    if (!ok && isFinite(v)) {
      if (G.near(v, scen.expected / 2, 0.02)) {
        items.push({
          tone: 'warn', title: '差得很有规律：正好一半',
          text: '你把 Gen5 x16 的双向 64 GB/s 当成了单向。链路带宽一律用单向值：Gen5 x16 = 32 GB/s。'
        });
      } else if (G.near(v, scen.expected * 2, 0.02)) {
        items.push({
          tone: 'warn', title: '差得很有规律：正好两倍',
          text: '你用的带宽只有应有的一半。Gen5 x16 单向是 32 GB/s，Gen4 x16 才是 16 GB/s。'
        });
      } else if (G.near(v, scen.expected / 1000, 0.02)) {
        items.push({ tone: 'warn', title: '数量级差 1000 倍', text: '你算出来的是秒，题目要毫秒。' });
      } else if (G.near(v, scen.expected * 1000, 0.02)) {
        items.push({ tone: 'warn', title: '数量级差 1000 倍', text: '你多乘了一次 1000，题目要毫秒。' });
      }
    }
    items.push({
      tone: ok ? 'ok' : 'info',
      title: '标准答案 ' + G.round(scen.expected, 1) + ' ms',
      text: scen.steps.map(function (s, i) { return (i + 1) + '. ' + s; }).join('<br>')
    });
    if (!isFinite(v)) {
      return { ok: false, score: 0, head: '还没填数字。', items: items };
    }
    return {
      ok: ok, score: ok ? 1 : 0,
      head: ok ? '算对了。' : ('你填的是 ' + v + ' ms，标准答案 ' + G.round(scen.expected, 1) + ' ms。'),
      items: items
    };
  }

  function hintC(scen, ans, lv) {
    if (lv <= 0) return '先确认单位：这里一律用单向带宽。Gen5 x16 单向 32 GB/s，双向 64 GB/s。';
    if (lv === 1) return '耗时 = 数据量 ÷ 带宽，得到的是秒；题目要毫秒，记得乘 1000。';
    return '把数字代进去：' + scen.steps[1] + ' → ' + scen.steps[2];
  }

  function sideC(scen, ans, res) {
    return '<div class="side-h">量纲</div>' +
      '<div class="side-sub">GB ÷ GB/s = s，再 ×1000 = ms</div>' +
      '<div class="kv"><span>Gen5 x16 单向</span><b>32 GB/s</b></div>' +
      '<div class="kv"><span>Gen4 x16 单向</span><b>16 GB/s</b></div>' +
      '<div class="kv"><span>400G 网卡</span><b>50 GB/s</b></div>' +
      '<div class="mx-note">400G 是 400 Gbps，除以 8 才是 50 GB/s。这两套单位混用是新手第一大坑。</div>';
  }

  function solveC(scen) { return { t: G.round(scen.expected, 1) }; }

  /* =====================  s3 · B 诊断  ===================== */

  var CASES = [
    {
      key: 'sys',
      title: '有一半的卡慢四倍',
      topo: '        GPU0    GPU4    NIC0    NIC1\n' +
        'GPU0     X      SYS     PIX     SYS\n' +
        'GPU4     SYS     X      SYS     PIX\n' +
        'NIC0     PIX     SYS     X      SYS\n' +
        'NIC1     SYS     PIX     SYS     X',
      p2p: 'Device to Device Bandwidth (GB/s), 4 devices\n' +
        '        GPU0    GPU4    NIC0    NIC1\n' +
        'GPU0    0.00    11.92   24.71   12.04\n' +
        'GPU4    11.90   0.00    11.97   24.63\n' +
        'NIC0    24.70   11.95   0.00    12.02\n' +
        'NIC1    12.01   24.60   12.03   0.00\n' +
        '(同芯片基线 24 GB/s 以上)',
      symptom: '8 卡数据并行跑跨机 all-reduce，GPU4-7 这一组的吞吐只有 GPU0-3 的四分之一。',
      options: [
        { label: '跨了 NUMA，数据要经过两颗 CPU 之间的 UPI', detail: '两张卡分属不同 CPU 的 PCIe 根', why: '正确。矩阵里 GPU4 与 NIC0 是 SYS，P2P 实测 11.95 GB/s，正好是 PIX 的一半，正是过 UPI 的量级。' },
        { label: 'IOMMU / ACS 把 P2P 拦成了经 CPU 的内存拷贝', detail: 'P2P 被虚拟化层改写', why: '不成立。ACS 拦 P2P 时带宽会塌到 3 GB/s 量级，而这里的 12 GB/s 是与同芯片 24 GB/s 成比例的，说明路径真的绕了 CPU，不是被改写。' },
        { label: '网卡降速到了 100G', detail: '链路协商失败', why: '不成立。11.95 GB/s 是卡到卡的 P2P 内存带宽，与网口速率无关；而且四条里两条仍然是 24 GB/s。' },
        { label: 'PCIe 从 Gen5 掉到了 Gen1', detail: '链路训练失败', why: '不成立。掉代会同时影响所有链路，不会出现同机一半 24 GB/s、一半 12 GB/s 的分裂。' }
      ],
      answer: 0
    },
    {
      key: 'acs',
      title: '同一个交换芯片下，P2P 只有 3 GB/s',
      topo: '        GPU0    GPU1    NIC0\n' +
        'GPU0     X      PIX     PIX\n' +
        'GPU1    PIX      X      PIX\n' +
        'NIC0    PIX     PIX      X',
      p2p: 'Device to Device Bandwidth (GB/s), 3 devices\n' +
        '        GPU0    GPU1    NIC0\n' +
        'GPU0    0.00    3.12    3.08\n' +
        'GPU1    3.11    0.00    3.09\n' +
        'NIC0    3.07    3.10    0.00\n' +
        '(同芯片机型基线 24 GB/s 以上)',
      symptom: '新装的机器，拓扑表看着完美，但一跑 P2P 就掉到基线的八分之一。',
      options: [
        { label: 'IOMMU / ACS 没关，P2P 被拦成经 CPU 的中转拷贝', detail: '虚拟化默认行为', why: '正确。矩阵是 PIX 说明物理路径没问题，但 P2P 退化成两次 DMA 经内存，带宽掉到 1/8 量级。开 IOMMU 但不关 ACS 就会出现这种"表对、速度不对"。' },
        { label: '两张卡跨了 NUMA', detail: 'NUMA 亲和没配对', why: '不成立。矩阵明确是 PIX，说明在同一个交换芯片、同一个 NUMA 下，不存在跨 UPI。' },
        { label: 'NVLink 没起来', detail: 'fabricmanager 未启动', why: '不成立。这台机器本来就没有 NVLink；就算有，NVLink 缺失会让 GPU 之间显示 SYS 或 PHB，不会显示 PIX。' },
        { label: '显存 ECC 打开了', detail: 'ECC 占用带宽', why: '不成立。ECC 对带宽的影响是个位数百分比，不可能掉到八分之一。' }
      ],
      answer: 0
    },
    {
      key: 'notp2p',
      title: '拓扑和 P2P 都正常，训练还是慢',
      topo: '        GPU0    NIC0    NIC1\n' +
        'GPU0     X      PIX     SYS\n' +
        'NIC0    PIX      X      SYS\n' +
        'NIC1    SYS     SYS      X',
      p2p: 'Device to Device Bandwidth (GB/s), 4 devices\n' +
        '        GPU0    GPU1    NIC0    NIC1\n' +
        'GPU0    0.00    24.66   24.70   11.98\n' +
        'GPU1    24.64   0.00    24.68   12.01\n' +
        'NIC0    24.69   24.67   0.00    12.03\n' +
        'NIC1    11.97   12.00   12.04   0.00',
      symptom: '单机 P2P 全部达标，矩阵也是 PIX，但整机训练吞吐只有同型号基线的 60%。',
      options: [
        { label: '瓶颈不在 P2P：去查网卡与 NUMA 的绑定、NCCL 实际选了哪张卡', detail: '算力侧或网卡侧', why: '正确。P2P 达标只证明卡到卡没问题。训练吞吐由最弱的一环决定：网卡绑错 NUMA、NCCL_IB_HCA 选错、或者计算侧本身就是瓶颈，都会让整体掉到 60% 而 P2P 依然漂亮。' },
        { label: 'PCIe 拓扑摆错了', detail: '层级不对', why: '不成立。矩阵是题目直接给出的，PIX 表示已经是同芯片最优路径。' },
        { label: '需要打开 GPU 之间的 NVLink', detail: '走专线更快', why: '不成立。GPU 与网卡之间没有 NVLink；NVLink 只解决 GPU 之间。' },
        { label: '主板 PCIe 代数不够，要换 Gen5 主板', detail: '链路代际', why: '不成立。24.7 GB/s 已经是 Gen5 x16 的正常量级，换主板不会有收益。' }
      ],
      answer: 0
    },
    {
      key: 'phb',
      title: '网卡直插 CPU，带宽只有一半',
      topo: '        GPU0    GPU1    NIC0\n' +
        'GPU0     X      PIX     PHB\n' +
        'GPU1    PIX      X      PHB\n' +
        'NIC0    PHB     PHB      X',
      p2p: 'Device to Device Bandwidth (GB/s), 3 devices\n' +
        '        GPU0    GPU1    NIC0\n' +
        'GPU0    0.00    24.68   12.41\n' +
        'GPU1    24.66   0.00    12.38\n' +
        'NIC0    12.40   12.39   0.00',
      symptom: '同一台机器，卡和卡之间 24 GB/s，卡和网卡之间却只有一半。',
      options: [
        { label: '网卡直连 CPU 根端口，中间过了一次 Host Bridge', detail: '没有经过交换芯片', why: '正确。PHB 表示一方直接挂在 CPU 的 PCIe 根端口上，路径必须穿过 Host Bridge，带宽约为同芯片的六到七成，这里是 12.4 GB/s。' },
        { label: '网卡和 GPU 跨了 NUMA', detail: '跨越两颗 CPU', why: '不成立。PHB 的前提就是同 NUMA；跨 NUMA 会显示 SYS，而且带宽会更低。' },
        { label: '交换芯片坏了，链路降级', detail: '硬件故障', why: '不成立。这一对之间根本没有交换芯片参与，路径是设备直连根端口。' },
        { label: '网卡是 100G 版本', detail: '网口速率不足', why: '不成立。12.4 GB/s 是 P2P 内存拷贝带宽，跟网口速率无关；而且卡到卡 24 GB/s 说明 PCIe 侧没问题。' }
      ],
      answer: 0
    }
  ];

  function genB(seed) {
    var r = R.stream(seed, 'M03.diag');
    var c = CASES[r.int(CASES.length)];
    return {
      seed: seed,
      key: c.key,
      question: c.title,
      topo: c.topo,
      p2p: c.p2p,
      symptom: c.symptom,
      options: c.options,
      answer: c.answer
    };
  }

  function promptB(scen) {
    return {
      tabs: [
        { name: 'nvidia-smi topo -m', text: scen.topo },
        { name: 'p2pBandwidthLatencyTest', text: scen.p2p },
        { name: '现象', text: scen.symptom }
      ],
      note: '三样东西一起看：拓扑表说"可能有多快"，P2P 实测说"实际多快"，现象说"业务受多大影响"。' +
        '只有表和实测<b>对不上</b>的时候，才是链路层的问题。'
    };
  }

  function judgeB(scen, ans) {
    var pick = ans.pick;
    if (pick === null || pick === undefined) {
      return { ok: false, score: 0, head: '还没选。', items: [] };
    }
    var ok = pick === scen.answer;
    var chosen = scen.options[pick];
    var right = scen.options[scen.answer];
    var items = [{
      tone: ok ? 'ok' : 'bad',
      title: (ok ? '选对了：' : '选错了：') + chosen.label,
      text: chosen.why
    }];
    if (!ok) {
      items.push({
        tone: 'info',
        title: '正确答案是 ' + String.fromCharCode(65 + scen.answer) + '：' + right.label,
        text: right.why
      });
    }
    return {
      ok: ok, score: ok ? 1 : 0,
      head: ok ? '根因判断正确。' : '根因判断错了，看看为什么这一项解释不了现象。',
      items: items
    };
  }

  function hintB(scen, ans, lv) {
    if (lv <= 0) return '先做一件事：把拓扑表的码和 P2P 的数字对上。表说 PIX 就该有 24 GB/s 以上，表说 SYS 就该掉到 10 GB/s 左右。';
    if (lv === 1) {
      var has = scen.topo.indexOf('SYS') >= 0;
      return has ? '这张表里出现了 SYS —— 想想 SYS 的物理含义，数据要从哪过。'
        : '这张表里没有 SYS，全是 PIX 或 PHB。那 P2P 慢就不是"离得远"，而是"被拦住了"。';
    }
    return '排除法：四个选项里有三个和你看到的现象不自洽（带宽量级、影响范围、是否全员一致）。';
  }

  function sideB(scen, ans, res) {
    return '<div class="side-h">读表的顺序</div>' +
      '<div class="steps"><div>1 看对角线两侧有没有 SYS</div>' +
      '<div>2 看有没有 PHB（直连根端口）</div>' +
      '<div>3 把码换算成预期带宽，和实测比</div>' +
      '<div>4 表和实测一致 → 瓶颈不在链路层</div></div>' +
      '<div class="mx-note">这一关考的不是记性，是"能不能用表否掉三个选项"。</div>';
  }

  function solveB(scen) { return { pick: scen.answer }; }

  /* =====================  s4 · D 决策  ===================== */

  function buildD(nic0, nic1) {
    var cfg = {
      seed: 0, level: 1,
      cpuPlacement: { CPU0: 0, CPU1: 1 },
      bridges: { B0: 'CPU0', B1: 'CPU0', B2: 'CPU1', B3: 'CPU1' },
      switches: { S0: 'B0', S2: 'B2', S3: 'B2' },
      devices: {},
      nvlink: { enabled: false, links: 0 },
      meta: { gpuCount: 8, cpuCount: 2, level: 1, nicMode: 'decision' }
    };
    for (var i = 0; i < 8; i++) {
      cfg.devices['GPU' + i] = {
        type: 'gpu', parent: i < 4 ? 'S0' : 'S2', mem: 81920, power: 700
      };
    }
    cfg.devices.NIC0 = { type: 'nic', parent: nic0, speed: 400 };
    cfg.devices.NIC1 = { type: 'nic', parent: nic1, speed: 400 };
    return cfg;
  }

  /*
    每张 GPU 都走"对它最划算"的那张网卡——调度器会这么选，
    所以判分也应该按最优分配算，而不是按"最后一张同 NUMA 的卡"。
  */
  function scoreD(cfg) {
    var total = 0;
    var detail = [];
    for (var i = 0; i < 8; i++) {
      var g = 'GPU' + i;
      var best = null, bestCost = Infinity;
      ['NIC0', 'NIC1'].forEach(function (n) {
        var cost = G.penalty(M.relation(cfg, g, n));
        if (cost < bestCost) { bestCost = cost; best = n; }
      });
      total += bestCost;
      detail.push({ gpu: g, nic: best, code: M.relation(cfg, g, best), cost: bestCost });
    }
    return { total: total, detail: detail };
  }

  function genD(seed) {
    var r = R.stream(seed, 'M03.decision');
    var raw = [
      {
        label: '双路对齐：两张网卡分别插在 NUMA0 / NUMA1 的交换芯片下',
        detail: '8 张卡各走本路网卡，谁都不用跨 UPI',
        cfg: buildD('S0', 'S2')
      },
      {
        label: '走线优先：NIC1 插进 NUMA1 那一路的第二颗交换芯片下',
        detail: '与 GPU4-7 同桥但不同芯片，机柜内走线短一点',
        cfg: buildD('S0', 'S3')
      },
      {
        label: '省槽位：两张网卡都插在 NUMA0 的交换芯片下',
        detail: '只占用一路 PCIe 槽，另一路留给本地盘',
        cfg: buildD('S0', 'B0')
      },
      {
        label: '直连优先：两张网卡都直插 CPU 根端口，不经过交换芯片',
        detail: '少一跳，听起来更快',
        cfg: buildD('B0', 'B2')
      }
    ];
    raw.forEach(function (o) {
      var s = scoreD(o.cfg);
      o.penalty = s.total;
      o.detailScore = s.detail;
    });
    var best = raw.reduce(function (a, b) { return a.penalty <= b.penalty ? a : b; });
    var order = r.shuffle([0, 1, 2, 3]);
    var options = order.map(function (i) { return raw[i]; });
    var answer = options.indexOf(best);

    return {
      seed: seed,
      order: order,
      options: options,
      answer: answer,
      best: best.penalty,
      machine: options[answer].cfg
    };
  }

  function promptD(scen) {
    return {
      tabs: [{
        name: '装机任务',
        text: '一台待装的双路 GPU 服务器：\n' +
          '  CPU0 —— 桥 B0、B1\n' +
          '  CPU1 —— 桥 B2、B3\n' +
          '  GPU0-3 已经挂在 CPU0 的交换芯片 S0 下\n' +
          '  GPU4-7 已经挂在 CPU1 的交换芯片 S2 下\n' +
          '  只剩两张 400G 网卡没插\n\n' +
          '任务：8 卡纯数据并行，每一步都要跨机做 all-reduce。\n' +
          '网卡插哪，决定了每张卡发出去的第一步要不要过 UPI。'
      }],
      note: '没有唯一正确的"好设计"，只有代价不同的取舍。选完会告诉你贵在哪。'
    };
  }

  function judgeD(scen, ans) {
    var pick = ans.pick;
    if (pick === null || pick === undefined) {
      return { ok: false, score: 0, head: '还没选方案。', items: [] };
    }
    var chosen = scen.options[pick];
    var bestOpt = scen.options[scen.answer];
    var res = G.byPenalty(chosen.penalty, scen.best, 8);
    var items = [];

    if (res.grade === 'best') {
      items.push({
        tone: 'ok', title: '就是最优解：总代价 0',
        text: '两张网卡各守一个 NUMA，8 张卡到网卡全是 PIX，一次 UPI 都不用走。'
      });
    } else {
      var worst = chosen.detailScore.filter(function (d) { return d.cost > 0; });
      var groups = {};
      worst.forEach(function (d) {
        groups[d.code] = groups[d.code] || [];
        groups[d.code].push(d.gpu);
      });
      var desc = Object.keys(groups).map(function (code) {
        return groups[code].join('、') + ' → ' + code + '（每张代价 ' + G.penalty(code) + '）';
      }).join('；');
      items.push({
        tone: res.score > 0 ? 'warn' : 'bad',
        title: '这个方案总代价 ' + chosen.penalty + '，最优是 ' + scen.best,
        text: desc + '。代价按 PIX 0 / PXB 1 / PHB 2 / NODE 3 / SYS 6 累加，衡量的是"每张卡发出去要多绕几层"。'
      });
      items.push({
        tone: 'info',
        title: '最优方案：' + bestOpt.label,
        text: bestOpt.detail + '。总代价 0。'
      });
    }

    var head = res.grade === 'best'
      ? '满分，这就是最优解。'
      : (res.grade === 'suboptimal'
        ? '次优：代价 ' + chosen.penalty + '，比最优多绕了一点，但只贵 ' + res.gap + '，工程上可以接受。'
        : '代价 ' + chosen.penalty + '，比最优贵 ' + res.gap + '，这一版上线会明显吃亏。');

    return { ok: res.score >= 0.5, score: res.score, head: head, items: items };
  }

  function hintD(scen, ans, lv) {
    if (lv <= 0) return '先算一件事：每张卡到"它自己的网卡"隔了几层。所谓"自己的"，就是同一路 NUMA 上那张。';
    if (lv === 1) return '只要有一路没有网卡，那一组卡全部要过 UPI，单张代价 6 分。两路都有网卡，代价才可能是 0。';
    return '最优解的特征：两张网卡分居两路，且都挂在各自交换芯片下。';
  }

  var PLABEL = {
    PIX: '同芯片', PXB: '多过一颗桥', PHB: '过 Host Bridge',
    NODE: '同 NUMA 不同桥', SYS: '跨 NUMA'
  };

  /* 惩罚值只在 TopoGrade 定义一次，这里读表，避免两处漂移 */
  function sideD(scen, ans, res) {
    var rows = ['PIX', 'PXB', 'PHB', 'NODE', 'SYS'].map(function (c) {
      return '<div class="kv"><span>' + c + ' ' + PLABEL[c] + '</span><b>' + G.penalty(c) + '</b></div>';
    }).join('');
    return '<div class="side-h">代价怎么算</div>' + rows +
      '<div class="mx-note">8 张卡累加。最优 0 分；比最优多 8 分以内算次优，再多就是错。</div>';
  }

  function solveD(scen) { return { pick: scen.answer }; }

  /* =====================  模块声明  ===================== */

  var QUIZ = [
    {
      q: 'PCIe 5.0 x16 链路的单向带宽是多少？',
      options: ['64 GB/s', '32 GB/s', '16 GB/s', '50 GB/s'],
      answer: 1,
      why: 'x16 双向 64 GB/s，单向砍半 32 GB/s。50 GB/s 是 400G 网卡的换算值，别混。'
    },
    {
      q: '两张卡在拓扑表里是 PIX，但 P2P 实测只有 3 GB/s，最可能是什么？',
      options: ['它们跨了 NUMA', 'IOMMU / ACS 把 P2P 拦成了经 CPU 拷贝', 'PCIe 降到 Gen1', '网卡速率不够'],
      answer: 1,
      why: 'PIX 说明物理路径没问题，速度却掉到 1/8，典型是虚拟化层把 P2P 改写成两次 DMA。'
    },
    {
      q: '8 卡双路机，两张网卡都插在 NUMA0 的交换芯片下，哪几张卡发数据要过 UPI？',
      options: ['全部 8 张', '只有 GPU0-3', '只有 GPU4-7', '一张都不用'],
      answer: 2,
      why: 'GPU4-7 在 NUMA1，本路没有网卡，只能走 NUMA0 的那两张，每次都要跨 UPI。'
    }
  ];

  var MOD = {
    id: 'M03',
    plane: 'L1',
    title: 'PCIe 拓扑',
    subtitle: 'nvidia-smi topo -m 上那七个字母，凭什么这么给',
    atoms: ['A', 'C', 'B', 'D'],
    requires: [],
    stageKeys: ['s1', 's2', 's3', 's4'],
    stages: [
      {
        key: 's1', atom: 'A', title: '还原拓扑', renderer: 'board',
        generate: genA, prompt: promptA, judge: judgeA,
        hint: hintA, side: sideA, solve: solveA,
        renderSpec: function (scen) {
          return {
            renderer: 'board',
            ctx: { config: scen.player, machine: scen.machine }
          };
        }
      },
      {
        key: 's2', atom: 'C', title: '算传输时间', renderer: 'calc',
        generate: genC, prompt: promptC, judge: judgeC,
        hint: hintC, side: sideC, solve: solveC,
        renderSpec: function (scen) {
          return { renderer: 'calc', ctx: { fields: scen.fields } };
        }
      },
      {
        key: 's3', atom: 'B', title: '判根因', renderer: 'choice',
        generate: genB, prompt: promptB, judge: judgeB,
        hint: hintB, side: sideB, solve: solveB,
        renderSpec: function (scen) {
          return { renderer: 'choice', ctx: { options: scen.options } };
        }
      },
      {
        key: 's4', atom: 'D', title: '选装机方案', renderer: 'choice',
        generate: genD, prompt: promptD, judge: judgeD,
        hint: hintD, side: sideD, solve: solveD,
        renderSpec: function (scen) {
          return { renderer: 'choice', ctx: { options: scen.options } };
        }
      }
    ],
    knowledge: {
      concept: 'PCIe 是一棵树：CPU 根端口 → Host Bridge → 桥 → 交换芯片 → 设备。' +
        'nvidia-smi topo -m 用七个码告诉你两台设备之间隔了几层、跨没跨 NUMA。',
      why: 'GPU 之间、GPU 与网卡之间的带宽和延迟，全由这棵树的距离决定。' +
        '跨 NUMA 就要过 CPU 之间的 UPI，带宽掉到四分之一，这是 8 卡机最常见的性能坑。',
      pitfalls: [
        '以为"隔的层多带宽就低"。交换芯片是非阻塞的，多过一颗主要加延迟，不直接降带宽；真正掉带宽的是跨 NUMA、链路降代、宽度砍半。',
        '把 Gen5 x16 的双向 64 GB/s 当单向用，算出来的时间正好少一半——错得很整齐，所以特别难自己发现。',
        '网卡随便插。8 卡机有两个 NUMA，网卡插错一路，一半的卡每个包都要过 UPI。'
      ],
      verify: 'nvidia-smi topo -m 看矩阵，lspci -tv 看树，p2pBandwidthLatencyTest 对账——表和实测对不上，才是链路层的问题。'
    },
    quiz: function (seed) {
      var r = R.stream(seed, 'M03.quiz');
      return r.shuffle(QUIZ.slice()).slice(0, 3);
    }
  };

  root.TopoRegistry.declare(MOD);
  root.M03 = MOD;

  if (typeof module === 'object' && module.exports) module.exports = MOD;
})(typeof globalThis !== 'undefined' ? globalThis : this);
