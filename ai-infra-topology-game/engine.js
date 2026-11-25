(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TopoEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

  function shuffle(rnd, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function sameArray(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function pad(s, n) {
    s = String(s);
    var out = s;
    while (out.length < n) out += ' ';
    return out;
  }

  function deviceIds(config) { return Object.keys(config.devices).sort(gpuSort); }

  function gpuSort(a, b) {
    function key(s) {
      var m = /^(\D+)(\d+)$/.exec(s);
      if (!m) return [s === '' ? '' : s, 0];
      return [m[1], parseInt(m[2], 10)];
    }
    var ka = key(a), kb = key(b);
    if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
    return ka[1] - kb[1];
  }

  function generateMachine(seed, level) {
    level = level || 1;
    var rnd = mulberry32((seed >>> 0) + level * 7919);
    var gpuCount, cpuCount, hasNVLink, links, nicMode;

    if (level === 1) {
      gpuCount = pick(rnd, [2, 4, 8]);
      cpuCount = gpuCount >= 4 ? pick(rnd, [1, 2]) : 1;
      hasNVLink = rnd() < 0.65;
      links = pick(rnd, [4, 8]);
      nicMode = rnd() < 0.15 ? 'phb' : (rnd() < 0.3 ? 'pxb' : 'pix');
    } else if (level === 2) {
      gpuCount = 8;
      cpuCount = 2;
      hasNVLink = true;
      links = 8;
      nicMode = rnd() < 0.5 ? 'pix' : 'pxb';
    } else {
      gpuCount = 8;
      cpuCount = 2;
      hasNVLink = true;
      links = 8;
      nicMode = 'node';
    }

    var config = {
      seed: seed >>> 0,
      level: level,
      cpuPlacement: {},
      bridges: {},
      switches: {},
      devices: {},
      nvlink: { enabled: hasNVLink, links: links },
      meta: { gpuCount: gpuCount, cpuCount: cpuCount, nicMode: nicMode, level: level }
    };

    var c;
    for (c = 0; c < cpuCount; c++) config.cpuPlacement['CPU' + c] = c;

    var half = Math.ceil(gpuCount / cpuCount);
    var i, bridge, sw, cpu;
    for (i = 0; i < gpuCount; i++) {
      cpu = cpuCount === 1 ? 0 : (i < half ? 0 : 1);
      bridge = 'B' + i;
      sw = 'S' + i;
      config.bridges[bridge] = 'CPU' + cpu;
      config.switches[sw] = bridge;
      config.devices['GPU' + i] = { type: 'gpu', parent: sw, mem: 81920, power: 700 };
    }

    var nic0Parent;
    if (nicMode === 'phb') {
      nic0Parent = 'B0';
    } else if (nicMode === 'pxb') {
      config.switches['S0x'] = 'B0';
      nic0Parent = 'S0x';
    } else {
      nic0Parent = 'S0';
    }
    config.devices['NIC0'] = { type: 'nic', parent: nic0Parent, speed: 400 };

    if (cpuCount === 2 && nicMode !== 'node') {
      var otherGpu = Math.min(half, gpuCount - 1);
      config.devices['NIC1'] = { type: 'nic', parent: 'S' + otherGpu, speed: 400 };
    } else {
      var extraBridge = 'Bnic';
      config.bridges[extraBridge] = 'CPU' + (cpuCount === 2 ? 0 : 0);
      config.devices['NIC1'] = { type: 'nic', parent: extraBridge, speed: 400 };
    }

    return config;
  }

  function derivePath(config, devId) {
    var dev = config.devices[devId];
    if (!dev) return { numa: null, cpu: null, bridge: null, switchPath: [], missing: true };
    var cur = dev.parent;
    var switchPath = [];
    var bridge = null;
    var cpu = null;
    var numa = null;
    var seen = {};
    while (cur && !seen[cur]) {
      seen[cur] = true;
      if (Object.prototype.hasOwnProperty.call(config.switches, cur)) {
        switchPath.unshift(cur);
        cur = config.switches[cur];
      } else if (Object.prototype.hasOwnProperty.call(config.bridges, cur)) {
        bridge = cur;
        cpu = config.bridges[cur];
        if (cpu && Object.prototype.hasOwnProperty.call(config.cpuPlacement, cpu)) {
          numa = config.cpuPlacement[cpu];
        }
        cur = null;
      } else {
        cur = null;
      }
    }
    return { numa: numa, cpu: cpu, bridge: bridge, switchPath: switchPath };
  }

  function relation(config, aId, bId) {
    if (aId === bId) return 'X';
    var a = config.devices[aId], b = config.devices[bId];
    if (!a || !b) return '?';
    if (a.type === 'gpu' && b.type === 'gpu' && config.nvlink.enabled) {
      return 'NV' + config.nvlink.links;
    }
    var pa = derivePath(config, aId), pb = derivePath(config, bId);
    if (pa.numa === null || pb.numa === null) return '?';
    if (pa.numa !== pb.numa) return 'SYS';
    if (pa.bridge !== pb.bridge) return 'NODE';
    if (sameArray(pa.switchPath, pb.switchPath)) return 'PIX';
    if (pa.switchPath.length === 0 || pb.switchPath.length === 0) return 'PHB';
    return 'PXB';
  }

  function buildMatrix(config) {
    var ids = deviceIds(config);
    var cells = {};
    ids.forEach(function (a) {
      cells[a] = {};
      ids.forEach(function (b) { cells[a][b] = relation(config, a, b); });
    });
    return { ids: ids, cells: cells };
  }

  function blankConfig(machine) {
    var blank = {
      seed: machine.seed,
      level: machine.level,
      cpuPlacement: {},
      bridges: {},
      switches: {},
      devices: {},
      nvlink: machine.nvlink,
      meta: machine.meta
    };
    Object.keys(machine.cpuPlacement).forEach(function (c) { blank.cpuPlacement[c] = null; });
    Object.keys(machine.bridges).forEach(function (b) { blank.bridges[b] = null; });
    Object.keys(machine.switches).forEach(function (s) { blank.switches[s] = null; });
    Object.keys(machine.devices).forEach(function (d) {
      blank.devices[d] = { type: machine.devices[d].type, parent: null };
    });
    return blank;
  }

  function compareMatrix(truth, player) {
    var diffs = [];
    truth.ids.forEach(function (a) {
      truth.ids.forEach(function (b) {
        var expected = truth.cells[a][b];
        var actual = player.cells[a] ? player.cells[a][b] : '?';
        if (expected !== actual) diffs.push({ a: a, b: b, expected: expected, actual: actual });
      });
    });
    return diffs;
  }

  function affinityText(numa) {
    if (numa === null || numa === undefined) return '-';
    return numa === 0 ? '0-47' : '48-95';
  }

  function formatTopo(config) {
    var ids = deviceIds(config);
    var width = 6;
    var lines = [];
    lines.push(pad('', 7) + ids.map(function (id) { return pad(id, width); }).join('') + 'CPU Affinity');
    ids.forEach(function (id) {
      var row = pad(id, 7);
      ids.forEach(function (other) { row += pad(relation(config, id, other), width); });
      row += affinityText(derivePath(config, id).numa);
      lines.push(row);
    });
    return lines.join('\n');
  }

  function formatLscpu(config) {
    var n = config.meta.cpuCount;
    var lines = [
      'Architecture:        x86_64',
      'CPU(s):              ' + (n * 48),
      'Socket(s):           ' + n,
      'NUMA node(s):        ' + n,
      'NUMA node0 CPU(s):   0-47'
    ];
    if (n > 1) lines.push('NUMA node1 CPU(s):   48-95');
    lines.push('Model name:          Intel(R) Xeon(R) Platinum 8480C');
    return lines.join('\n');
  }

  function formatNvidiaSmi(config) {
    var lines = [
      'GPU  Name        Persistence-M  Bus-Id          Memory-Usage        Power        GPU-Util',
      '0    H800        On             00000000:01:00.0  0MiB / 81920MiB    43W / 700W   0%',
      '1    H800        On             00000000:02:00.0  0MiB / 81920MiB    41W / 700W   0%'
    ];
    var gpus = deviceIds(config).filter(function (d) { return config.devices[d].type === 'gpu'; });
    if (gpus.length > 2) {
      lines.push('...  ' + (gpus.length - 2) + ' more GPUs');
    }
    lines.push('');
    lines.push('Processes: No running processes found');
    lines.push('');
    lines.push('NVLink: ' + (config.nvlink.enabled ? config.nvlink.links + ' links per GPU' : 'not available'));
    return lines.join('\n');
  }

  var QUIZ_BANK = [
    {
      q: '400G 网卡标称的 400，换算成每秒多少 GB？',
      options: ['约 50 GB/s', '约 400 GB/s', '约 800 GB/s', '约 4 GB/s'],
      answer: 0,
      why: '网卡按比特标：400 Gb/s 除以 8，约 50 GB/s。'
    },
    {
      q: '家里 1000 兆宽带，理论最大下载速度约是多少？',
      options: ['约 125 MB/s', '约 1000 MB/s', '约 100 MB/s', '约 8 MB/s'],
      answer: 0,
      why: '1000 Mb/s 除以 8，约 125 MB/s。'
    },
    {
      q: '54 GB 权重从硬盘读入内存，实测 3.3 GB/s，大约要多久？',
      options: ['约 16 秒', '约 3 秒', '约 1 分钟', '约 54 秒'],
      answer: 0,
      why: '54 除以 3.3 约等于 16 秒。'
    },
    {
      q: '模型权重 54 GB，单卡显存 80 GB，能放下吗？',
      options: ['能，还有余量', '不能', '要看 1 TB 内存够不够', '要看 CPU 核数'],
      answer: 0,
      why: '54 小于 80，能放下。1 TB 内存不参与这一步。'
    },
    {
      q: '8 张 H800 每张功耗上限 700 W，光显卡合计多少？',
      options: ['5600 W', '700 W', '800 W', '56000 W'],
      answer: 0,
      why: '700 乘以 8 等于 5600 W，还没算 CPU 和风扇。'
    },
    {
      q: '数据已经在内存里，GPU 能直接拿来算吗？',
      options: ['不能，要先拷进显存', '能，内存够大就行', '能，CPU 会自动转过去', '能，只是慢一点'],
      answer: 0,
      why: 'GPU 只能算自己显存里的数据，必须先拷过去。'
    },
    {
      q: '下面哪一段最可能成为模型加载的瓶颈？',
      options: ['硬盘读入与拷进显存', 'NVLink 卡间通信', '显存内部读取', 'CPU 缓存命中'],
      answer: 0,
      why: '实测 3.3 和 5.5 GB/s，远比 NVLink 的 200+ 和显存的 3000+ 窄。'
    }
  ];

  function generateQuiz(seed, count) {
    var rnd = mulberry32((seed >>> 0) + 104729);
    var chosen = shuffle(rnd, QUIZ_BANK).slice(0, count || 2);
    return chosen.map(function (item) {
      var order = shuffle(rnd, [0, 1, 2, 3]);
      var options = order.map(function (i) { return item.options[i]; });
      var answer = order.indexOf(item.answer);
      return { q: item.q, options: options, answer: answer, why: item.why };
    });
  }

  function validateConfig(config) {
    var errors = [];
    Object.keys(config.bridges).forEach(function (b) {
      var cpu = config.bridges[b];
      if (cpu !== null && !Object.prototype.hasOwnProperty.call(config.cpuPlacement, cpu)) {
        errors.push('bridge ' + b + ' references unknown cpu ' + cpu);
      }
    });
    Object.keys(config.switches).forEach(function (s) {
      var parent = config.switches[s];
      if (parent === null) return;
      if (!Object.prototype.hasOwnProperty.call(config.bridges, parent) &&
          !Object.prototype.hasOwnProperty.call(config.switches, parent)) {
        errors.push('switch ' + s + ' references unknown parent ' + parent);
      }
    });
    Object.keys(config.switches).forEach(function (s) {
      var seen = {};
      var cur = s;
      while (cur) {
        if (seen[cur]) { errors.push('switch cycle at ' + cur); break; }
        seen[cur] = true;
        cur = config.switches[cur];
      }
    });
    Object.keys(config.devices).forEach(function (d) {
      var parent = config.devices[d].parent;
      if (parent === null) return;
      if (!Object.prototype.hasOwnProperty.call(config.bridges, parent) &&
          !Object.prototype.hasOwnProperty.call(config.switches, parent)) {
        errors.push('device ' + d + ' references unknown parent ' + parent);
      }
    });
    var m = buildMatrix(config);
    m.ids.forEach(function (a) {
      if (m.cells[a][a] !== 'X') errors.push('self relation of ' + a + ' is not X');
      m.ids.forEach(function (b) {
        if (m.cells[a][b] !== m.cells[b][a]) errors.push('matrix not symmetric at ' + a + '/' + b);
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  function selfTest(iterations) {
    var failures = [];
    var n = iterations || 12;
    for (var seed = 0; seed < n; seed++) {
      [1, 2, 3].forEach(function (level) {
        var machine = generateMachine(seed, level);
        var check = validateConfig(machine);
        if (!check.ok) failures.push('seed ' + seed + ' level ' + level + ': ' + check.errors.join('; '));
        var truth = buildMatrix(machine);
        var blank = blankConfig(machine);
        var blankMatrix = buildMatrix(blank);
        blank.ids = blankMatrix.ids;
        var diffs = compareMatrix(truth, blankMatrix);
        if (diffs.length === 0) failures.push('seed ' + seed + ' level ' + level + ': blank config matched truth');
        var quiz = generateQuiz(seed, 2);
        if (quiz.length !== 2 || quiz[0].answer < 0 || quiz[0].answer > 3) {
          failures.push('seed ' + seed + ': bad quiz');
        }
      });
    }
    return { ok: failures.length === 0, failures: failures, count: n * 3 };
  }

  function ensureNicAffinity(conf) {
    var gpus = deviceIds(conf).filter(function (d) { return conf.devices[d].type === 'gpu'; });
    var otherStart = Math.ceil(gpus.length / 2);
    conf.devices.NIC0.parent = conf.devices[gpus[0]].parent;
    conf.devices.NIC1.parent = conf.devices[gpus[otherStart]].parent;
    delete conf.switches.S0x;
    var usedBnic = Object.keys(conf.devices).some(function (d) { return conf.devices[d].parent === 'Bnic'; });
    if (!usedBnic) delete conf.bridges.Bnic;
  }

  function computeBindingTruth(conf) {
    var out = {};
    deviceIds(conf).forEach(function (d) {
      if (conf.devices[d].type !== 'gpu') return;
      out[d] = derivePath(conf, d).numa === 0 ? 'NIC0' : 'NIC1';
    });
    return out;
  }

  function makeMistakes(truth, rnd, count) {
    var p = JSON.parse(JSON.stringify(truth));
    var movable = [];
    Object.keys(p.devices).forEach(function (d) { movable.push({ kind: 'device', id: d }); });
    Object.keys(p.bridges).forEach(function (b) { movable.push({ kind: 'bridge', id: b }); });
    shuffle(rnd, movable).slice(0, count).forEach(function (item) {
      var choices;
      if (item.kind === 'device') {
        choices = Object.keys(p.switches).filter(function (s) { return s !== p.devices[item.id].parent; });
        if (choices.length) p.devices[item.id].parent = choices[Math.floor(rnd() * choices.length)];
      } else {
        choices = Object.keys(p.cpuPlacement).filter(function (c) { return c !== p.bridges[item.id]; });
        if (choices.length) p.bridges[item.id] = choices[Math.floor(rnd() * choices.length)];
      }
    });
    return p;
  }

  function forceMistake(truth, puzzle, rnd) {
    var gpus = deviceIds(puzzle).filter(function (d) { return puzzle.devices[d].type === 'gpu'; });
    var g = gpus[Math.floor(rnd() * gpus.length)];
    var targetNuma = 1 - derivePath(truth, g).numa;
    var candidates = Object.keys(puzzle.switches).filter(function (s) {
      var br = puzzle.switches[s];
      var cpu = puzzle.bridges[br];
      return puzzle.cpuPlacement[cpu] === targetNuma;
    });
    if (candidates.length) puzzle.devices[g].parent = candidates[0];
  }

  function generateScenario(seed, level) {
    level = level || 1;
    if (level === 1) {
      var single = generateMachine(seed, 1);
      return { seed: seed >>> 0, level: 1, machine: single };
    }
    var rnd = mulberry32((seed >>> 0) + 31337);
    var confA = generateMachine(seed, 2);
    var confB = generateMachine((seed + 1) >>> 0, 2);
    ensureNicAffinity(confA);
    ensureNicAffinity(confB);
    var puzzleA = makeMistakes(confA, rnd, 3);
    var puzzleB = makeMistakes(confB, rnd, 3);
    if (compareMatrix(buildMatrix(confA), buildMatrix(puzzleA)).length === 0) forceMistake(confA, puzzleA, rnd);
    if (compareMatrix(buildMatrix(confB), buildMatrix(puzzleB)).length === 0) forceMistake(confB, puzzleB, rnd);
    return {
      seed: seed >>> 0,
      level: 2,
      machines: [confA, confB],
      puzzles: [puzzleA, puzzleB],
      truths: [buildMatrix(confA), buildMatrix(confB)],
      bindings: [computeBindingTruth(confA), computeBindingTruth(confB)]
    };
  }

  function bindingRelation(conf, gpuId, nicId) {
    return relation(conf, gpuId, nicId);
  }

  function bindingPenalty(rel) {
    if (rel === 'PIX' || rel.indexOf('NV') === 0) return 1;
    if (rel === 'PXB' || rel === 'PHB') return 2;
    if (rel === 'NODE') return 3;
    if (rel === 'SYS') return 6;
    return 9;
  }

  function compareScenario(scenario, player) {
    var result = { topologyDiffs: [], bindingDiffs: [], ok: false };
    scenario.truths.forEach(function (truth, i) {
      var pm = player.matrices[i];
      compareMatrix(truth, pm).forEach(function (d) {
        result.topologyDiffs.push({
          machine: i, a: d.a, b: d.b, expected: d.expected, actual: d.actual
        });
      });
    });
    scenario.bindings.forEach(function (truthMap, i) {
      Object.keys(truthMap).forEach(function (gpu) {
        var actual = player.bindings[i][gpu];
        if (actual !== truthMap[gpu]) {
          result.bindingDiffs.push({ machine: i, gpu: gpu, expected: truthMap[gpu], actual: actual });
        }
      });
    });
    result.ok = result.topologyDiffs.length === 0 && result.bindingDiffs.length === 0;
    return result;
  }

  function formatScenarioCommand(scenario) {
    var lines = [];
    scenario.machines.forEach(function (conf, i) {
      lines.push('=== 节点 ' + (i === 0 ? 'A' : 'B') + ' · nvidia-smi topo -m ===');
      lines.push(formatTopo(conf));
      lines.push('');
    });
    lines.push('=== 跨机链路 ===');
    lines.push('节点 A 的 NIC0 / NIC1  <-->  TOR 交换机  <-->  节点 B 的 NIC0 / NIC1');
    lines.push('每机 8 卡双路：GPU0-3 在 NUMA 0，GPU4-7 在 NUMA 1。');
    lines.push('跨机通信要走离自己最近的网卡，走反了每次都要跨楼。');
    return lines.join('\n');
  }

  function evaluateCluster(cluster, allocation) {
    var loads = cluster.machines.map(function () { return [0, 0]; });
    cluster.flows.forEach(function (f) {
      var choice = allocation[f.id];
      if (choice === undefined || choice === null) return;
      var ni = parseInt(choice, 10);
      if (ni === 0 || ni === 1) loads[f.src][ni] += f.size;
    });
    var times = [];
    cluster.machines.forEach(function (m, mi) {
      m.nics.forEach(function (n, ni) {
        if (n.bw <= 0) times.push(loads[mi][ni] > 0 ? Infinity : 0);
        else times.push(loads[mi][ni] / n.bw);
      });
    });
    var total = Math.max.apply(null, times);
    var bottleneck = -1;
    times.forEach(function (t, i) { if (t === total) bottleneck = i; });
    return { loads: loads, times: times, total: total, bottleneck: bottleneck };
  }

  function generateClusterScenario(seed) {
    var rnd = mulberry32((seed >>> 0) + 7717);
    var names = ['A', 'B', 'C', 'D'];
    var machines = names.map(function (name) {
      return {
        id: name,
        nvlink: rnd() < 0.7 ? 8 : 4,
        nics: [
          { id: 'NIC0', numa: 0, bw: 50, status: 'ok' },
          { id: 'NIC1', numa: 1, bw: 50, status: 'ok' }
        ]
      };
    });

    var ports = [];
    machines.forEach(function (m, mi) {
      m.nics.forEach(function (n, ni) { ports.push({ m: mi, n: ni }); });
    });
    shuffle(rnd, ports);
    var usedMachines = {};
    var injected = 0;
    for (var p = 0; p < ports.length && injected < 2; p++) {
      var port = ports[p];
      if (usedMachines[port.m]) continue;
      usedMachines[port.m] = true;
      var nic = machines[port.m].nics[port.n];
      nic.status = rnd() < 0.35 ? 'down' : 'degraded';
      nic.bw = nic.status === 'down' ? 0 : Math.round(8 + rnd() * 10);
      injected++;
    }

    var sizes = [5, 12, 27, 54, 8, 36, 18, 64];
    var flows = sizes.map(function (size, i) {
      var src = i % 4;
      var dst = (src + 1 + Math.floor(rnd() * 3)) % 4;
      var numa = rnd() < 0.5 ? 0 : 1;
      return {
        id: 'F' + i,
        from: machines[src].id + '.GPU' + (numa * 4),
        to: machines[dst].id + '.GPU' + (numa * 4),
        size: size,
        src: src,
        numa: numa
      };
    });

    var cluster = { seed: seed >>> 0, level: 3, machines: machines, flows: flows };
    var best = Infinity;
    var bestAllocation = null;
    for (var mask = 0; mask < 256; mask++) {
      var alloc = {};
      flows.forEach(function (f, i) { alloc[f.id] = (mask >> i) & 1; });
      var result = evaluateCluster(cluster, alloc);
      if (result.total < best) { best = result.total; bestAllocation = alloc; }
    }
    cluster.bestTime = best;
    cluster.bestAllocation = bestAllocation;
    return cluster;
  }

  function clusterPortText(cluster, mi, ni) {
    var nic = cluster.machines[mi].nics[ni];
    if (nic.status === 'down') return '故障 · 不可用';
    if (nic.status === 'degraded') return '降速 · ' + nic.bw + ' GB/s';
    return '正常 · ' + nic.bw + ' GB/s';
  }

  function formatClusterCommand(cluster) {
    var lines = ['=== 4 机 32 卡 · 跨机通信流 ===', ''];
    cluster.machines.forEach(function (m, mi) {
      lines.push('节点 ' + m.id + '：8 卡双路，NVLink ' + m.nvlink + ' 条 · ' +
        'NIC0：' + clusterPortText(cluster, mi, 0) + ' · NIC1：' + clusterPortText(cluster, mi, 1));
    });
    lines.push('');
    cluster.flows.forEach(function (f) {
      lines.push(f.id + '  ' + f.from + ' → ' + f.to + '  ' + f.size + ' GB');
    });
    lines.push('');
    lines.push('目标：把每条流放到它源机器的网卡上，避开降速/故障端口，压低最慢端口的时间。');
    lines.push('整轮耗时由最慢的那个端口决定 —— 最窄的一段说了算。');
    return lines.join('\n');
  }

  return {
    generateMachine: generateMachine,
    blankConfig: blankConfig,
    derivePath: derivePath,
    relation: relation,
    buildMatrix: buildMatrix,
    compareMatrix: compareMatrix,
    formatTopo: formatTopo,
    formatLscpu: formatLscpu,
    formatNvidiaSmi: formatNvidiaSmi,
    generateQuiz: generateQuiz,
    validateConfig: validateConfig,
    selfTest: selfTest,
    deviceIds: deviceIds,
    generateScenario: generateScenario,
    computeBindingTruth: computeBindingTruth,
    bindingRelation: bindingRelation,
    bindingPenalty: bindingPenalty,
    compareScenario: compareScenario,
    formatScenarioCommand: formatScenarioCommand,
    generateClusterScenario: generateClusterScenario,
    evaluateCluster: evaluateCluster,
    clusterPortText: clusterPortText,
    formatClusterCommand: formatClusterCommand
  };
});
