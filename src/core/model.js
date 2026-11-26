(function (root) {
  'use strict';

  var CODE = {
    SELF: 'X', SYS: 'SYS', NODE: 'NODE', PIX: 'PIX', PXB: 'PXB', PHB: 'PHB', UNK: '?'
  };

  function num(id) {
    var m = String(id).match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function deviceIds(cfg) {
    var ids = Object.keys(cfg.devices || {});
    ids.sort(function (a, b) {
      var ta = cfg.devices[a].type, tb = cfg.devices[b].type;
      if (ta !== tb) return ta === 'gpu' ? -1 : 1;
      return num(a) - num(b);
    });
    return ids;
  }

  function partType(cfg, id) {
    if (has(cfg.cpuPlacement, id)) return 'cpu';
    if (has(cfg.bridges, id)) return 'bridge';
    if (has(cfg.switches, id)) return 'switch';
    if (has(cfg.devices, id)) return cfg.devices[id].type === 'nic' ? 'nic' : 'gpu';
    return 'unknown';
  }

  function allParts(cfg) {
    var out = [];
    Object.keys(cfg.cpuPlacement).forEach(function (id) { out.push({ id: id, type: 'cpu' }); });
    Object.keys(cfg.bridges).forEach(function (id) { out.push({ id: id, type: 'bridge' }); });
    Object.keys(cfg.switches).forEach(function (id) { out.push({ id: id, type: 'switch' }); });
    Object.keys(cfg.devices).forEach(function (id) {
      out.push({ id: id, type: cfg.devices[id].type });
    });
    return out;
  }

  /* 从设备往根走，收集交换芯片链，最后落在桥 / CPU / NUMA 上 */
  function derivePath(cfg, id) {
    var d = cfg.devices && cfg.devices[id];
    var empty = { numa: null, cpu: null, bridge: null, switchPath: [], known: false };
    if (!d || !d.parent) return empty;

    var sw = [];
    var p = d.parent;
    var guard = 0;
    while (has(cfg.switches, p)) {
      sw.unshift(p);
      p = cfg.switches[p];
      if (++guard > 8) return empty;
    }

    var bridge = has(cfg.bridges, p) ? p : null;
    var cpu = bridge ? cfg.bridges[bridge] : null;
    var numa = null;
    if (cpu && has(cfg.cpuPlacement, cpu) && cfg.cpuPlacement[cpu] !== null) {
      numa = cfg.cpuPlacement[cpu];
    }
    return {
      numa: numa, cpu: cpu || null, bridge: bridge,
      switchPath: sw, known: numa !== null
    };
  }

  function samePath(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /*
    判定顺序不可换：
    自己 → NVLink → NUMA → 桥 → 交换芯片路径 → 缺失
    NVLink 优先于 NUMA，因为 NVSwitch 跨 NUMA，物理上仍是卡间专线。
  */
  function relation(cfg, a, b) {
    if (a === b) return CODE.SELF;
    var da = (cfg.devices && cfg.devices[a]) || {};
    var db = (cfg.devices && cfg.devices[b]) || {};
    if (da.type === 'gpu' && db.type === 'gpu' && cfg.nvlink && cfg.nvlink.enabled) {
      return 'NV' + (cfg.nvlink.links || 4);
    }
    var pa = derivePath(cfg, a);
    var pb = derivePath(cfg, b);
    if (pa.numa === null || pb.numa === null) return CODE.UNK;
    if (pa.numa !== pb.numa) return CODE.SYS;
    if (pa.bridge !== pb.bridge) return CODE.NODE;
    if (pa.switchPath.length === 0 || pb.switchPath.length === 0) return CODE.PHB;
    if (samePath(pa.switchPath, pb.switchPath)) return CODE.PIX;
    return CODE.PXB;
  }

  function buildMatrix(cfg) {
    var ids = deviceIds(cfg);
    var cells = {};
    ids.forEach(function (a) {
      cells[a] = {};
      ids.forEach(function (b) { cells[a][b] = relation(cfg, a, b); });
    });
    return { ids: ids, cells: cells };
  }

  /* 只比 unordered pair，且不看零件标签 */
  function compareMatrix(truth, player) {
    var diffs = [];
    var ids = truth.ids.filter(function (id) { return player.cells[id]; });
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        var a = ids[i], b = ids[j];
        var exp = truth.cells[a][b];
        var act = player.cells[a][b];
        if (exp !== act) diffs.push({ a: a, b: b, expected: exp, actual: act });
      }
    }
    return diffs;
  }

  function blankConfig(cfg) {
    var out = JSON.parse(JSON.stringify(cfg));
    Object.keys(out.cpuPlacement).forEach(function (c) { out.cpuPlacement[c] = null; });
    Object.keys(out.bridges).forEach(function (b) { out.bridges[b] = null; });
    Object.keys(out.switches).forEach(function (s) { out.switches[s] = null; });
    Object.keys(out.devices).forEach(function (d) { out.devices[d].parent = null; });
    return out;
  }

  function validateConfig(cfg) {
    var errors = [];
    if (!cfg || !cfg.meta) return { ok: false, errors: ['缺少 meta'] };
    var cpuIds = Object.keys(cfg.cpuPlacement || {});
    if (cpuIds.length !== cfg.meta.cpuCount) {
      errors.push('CPU 数量 ' + cpuIds.length + ' 与 meta ' + cfg.meta.cpuCount + ' 不符');
    }
    cpuIds.forEach(function (c) {
      var n = cfg.cpuPlacement[c];
      if (n === null) return;
      if (typeof n !== 'number' || n < 0 || n >= cfg.meta.cpuCount) {
        errors.push(c + ' 落在非法 NUMA ' + n);
      }
    });
    Object.keys(cfg.bridges || {}).forEach(function (b) {
      var cpu = cfg.bridges[b];
      if (cpu === null) return;
      if (!has(cfg.cpuPlacement, cpu)) errors.push(b + ' 挂在未知 CPU ' + cpu);
    });
    Object.keys(cfg.switches || {}).forEach(function (s) {
      var p = cfg.switches[s];
      if (p === null) return;
      if (!has(cfg.switches, p) && !has(cfg.bridges, p)) {
        errors.push(s + ' 挂在未知父节点 ' + p);
      }
      var guard = 0, cur = p, seen = {};
      while (cur && guard++ < 12) {
        if (seen[cur]) { errors.push(s + ' 出现环'); break; }
        seen[cur] = 1;
        cur = has(cfg.switches, cur) ? cfg.switches[cur] : (has(cfg.bridges, cur) ? cfg.bridges[cur] : null);
      }
    });
    var gpuCount = 0;
    Object.keys(cfg.devices || {}).forEach(function (d) {
      var dev = cfg.devices[d];
      if (dev.type === 'gpu') gpuCount++;
      var p = dev.parent;
      if (p === null) return;
      if (!has(cfg.switches, p) && !has(cfg.bridges, p)) {
        errors.push(d + ' 挂在未知父节点 ' + p);
      }
      if (has(cfg.devices, p)) errors.push(d + ' 挂在另一个设备下，非法');
    });
    if (gpuCount !== cfg.meta.gpuCount) {
      errors.push('GPU 数量 ' + gpuCount + ' 与 meta ' + cfg.meta.gpuCount + ' 不符');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------------- 生成器 ---------------- */

  function baseConfig(seed, gpuCount, level) {
    var half = gpuCount / 2;
    var cores = gpuCount >= 8 ? 48 : 32;
    var cfg = {
      seed: seed,
      level: level,
      cpuPlacement: { CPU0: 0, CPU1: 1 },
      bridges: { B0: 'CPU0', B1: 'CPU1' },
      switches: { S0: 'B0', S1: 'B1' },
      devices: {},
      nvlink: { enabled: false, links: 0 },
      meta: { gpuCount: gpuCount, cpuCount: 2, cores: cores, nicMode: '', level: level }
    };
    for (var i = 0; i < gpuCount; i++) {
      /* PCIe 机型：H100 PCIe 是 350W，别写成 SXM 的 700W */
      cfg.devices['GPU' + i] = {
        type: 'gpu', parent: i < half ? 'S0' : 'S1',
        mem: 81920, power: 350
      };
    }
    cfg.devices.NIC0 = { type: 'nic', parent: 'S0', speed: 400 };
    cfg.devices.NIC1 = { type: 'nic', parent: 'S1', speed: 400 };
    return cfg;
  }

  /*
    四种机型变体，各自能逼出一种关系码：
      canonical  网卡贴本路交换芯片        → PIX + SYS
      nicOnBridge 网卡直挂桥（不过交换机） → PHB
      extraSwitch 多一颗交换机串起来        → PXB
      cornered    两张网卡挤在同一路        → SYS 更多
  */
  function generateMachine(seed, level) {
    level = level || 1;
    var hard = level >= 2;
    var r = root.TopoRng.stream(seed, 'M03.machine.' + level);
    var gpuCount = hard ? 8 : 4;
    var cfg = baseConfig(seed, gpuCount, level);
    var variant = ['canonical', 'nicOnBridge', 'extraSwitch', 'cornered'][r.int(4)];

    if (variant === 'nicOnBridge') {
      cfg.devices.NIC0.parent = 'B0';
      cfg.devices.NIC1.parent = 'B1';
    } else if (variant === 'extraSwitch') {
      cfg.switches.S2 = 'S0';
      cfg.devices.NIC0.parent = 'S2';
      if (hard && r.chance(0.5)) {
        cfg.switches.S3 = 'S1';
        cfg.devices.NIC1.parent = 'S3';
      }
    } else if (variant === 'cornered') {
      cfg.devices.NIC0.parent = 'S0';
      cfg.devices.NIC1.parent = 'S0';
    }

    /* 一半几率让某一路的 GPU 不足半，制造跨桥（NODE）与 PHB */
    if (r.chance(0.45)) {
      var moveCount = hard ? 1 : 1;
      for (var k = 0; k < moveCount; k++) {
        var gid = 'GPU' + r.int(gpuCount);
        var dev = cfg.devices[gid];
        if (dev.parent === 'S0' && r.chance(0.5)) dev.parent = 'B0';
        else if (dev.parent === 'S1' && r.chance(0.5)) dev.parent = 'B1';
      }
    }

    cfg.meta.nicMode = variant;
    cfg.meta.variant = variant;
    return cfg;
  }

  /* ---------------- 格式化输出 ---------------- */

  function pad(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }

  /* 真机用制表符对齐，列宽随内容浮动；这里固定 6 列宽，6 卡机型刚好不横向滚动 */
  var W = 6;

  /*
    真机输出末尾有 CPU Affinity 与 NUMA Affinity 两列，
    少了这两列，懂行的人一眼就知道是编的。

    表和图例分开返回：表要等宽不换行，图例要按栏宽折行，
    否则图例的长行会把横向滚动条撑开，把 Affinity 两列挤出可视区。
  */
  function formatTopoParts(cfg) {
    var mx = buildMatrix(cfg);
    var ids = mx.ids;
    var cores = (cfg.meta && cfg.meta.cores) || 48;
    var lines = [];
    var head = pad('', 9);
    ids.forEach(function (id) { head += pad(id, W); });
    head += pad('CPU Affinity', 16) + 'NUMA Affinity';
    lines.push(head.replace(/\s+$/, ''));
    ids.forEach(function (a) {
      var row = pad(a, 9);
      ids.forEach(function (b) { row += pad(mx.cells[a][b], W); });
      var p = derivePath(cfg, a);
      var aff = p.numa === null ? '?' : (p.numa * cores) + '-' + ((p.numa + 1) * cores - 1);
      row += pad(aff, 16) + (p.numa === null ? '?' : p.numa);
      lines.push(row.replace(/\s+$/, ''));
    });

    var legend = ['Legend:',
      '  X    = Self',
      '  SYS  = Connection traversing PCIe as well as the SMP interconnect between NUMA nodes (e.g., QPI/UPI)',
      '  NODE = Connection traversing PCIe as well as the interconnect between PCIe Host Bridges within a NUMA node',
      '  PHB  = Connection traversing PCIe as well as a PCIe Host Bridge (typically the CPU)',
      '  PXB  = Connection traversing multiple PCIe bridges (without traversing the PCIe Host Bridge)',
      '  PIX  = Connection traversing at most a single PCIe bridge',
      '  NV#  = Connection traversing a bonded set of # NVLinks'
    ].join('\n');

    return { table: lines.join('\n'), legend: legend };
  }

  function formatTopo(cfg) {
    var p = formatTopoParts(cfg);
    return p.table + '\n\n' + p.legend;
  }

  function formatLscpu(cfg) {
    var n = cfg.meta.cpuCount;
    var cores = cfg.meta.cores || 48;
    var lines = [];
    lines.push('Architecture:          x86_64');
    lines.push('CPU(s):                ' + (n * cores));
    lines.push('On-line CPU(s) list:   0-' + (n * cores - 1));
    lines.push('Thread(s) per core:    1');
    lines.push('Core(s) per socket:    ' + cores);
    lines.push('Socket(s):             ' + n);
    lines.push('NUMA node(s):          ' + n);
    for (var i = 0; i < n; i++) {
      lines.push('NUMA node' + i + ' CPU(s):      ' + (i * cores) + '-' + ((i + 1) * cores - 1));
    }
    lines.push('');
    lines.push('# 每个 Socket 就是一颗 CPU，对应一个 NUMA node。');
    lines.push('# 本题机型：' + (cfg.meta.gpuCount) + ' 卡 PCIe 机型，未配 NVLink。');
    return lines.join('\n');
  }

  /* 关系码 → 层级 + 人话解释，反馈质量靠这张表 */
  var CODE_INFO = {
    'X': { layer: '自身', short: '对角线', why: '自己和自己之间不需要通路。' },
    '?': { layer: '未定', short: '还没摆到位', why: '这条路径上有一方还没放进层级，反算不出来。' },
    'SYS': {
      layer: 'NUMA 层',
      short: '跨了 NUMA，要过 CPU 之间的 UPI',
      why: '两张卡分属不同 CPU，数据必须经过两颗 CPU 之间的互联，带宽掉到四分之一左右、延迟翻几倍。'
    },
    'NODE': {
      layer: 'NUMA 内的桥层',
      short: '同一个 NUMA 里，但分属不同的 PCIe 桥',
      why: '同一个 CPU 下有两个根端口，两条链路各自到 CPU 再折返，过了 Host Bridge 但没跨 NUMA。'
    },
    'PHB': {
      layer: 'Host Bridge 层',
      short: '有一方直接挂在 CPU 的根端口上',
      why: '设备没有经过任何交换芯片，链路直接进 CPU 的 Host Bridge，属于"最浅但要让 CPU 转发"的一种。'
    },
    'PXB': {
      layer: 'PCIe 桥层',
      short: '过了不止一颗 PCIe 桥 / 交换芯片',
      why: '两颗芯片串在同一颗桥下面但不在同一颗交换芯片里，要多穿一层 PCIe 桥。'
    },
    'PIX': {
      layer: '交换芯片层',
      short: '在同一颗 PCIe 交换芯片下',
      why: '两颗设备挂在同一颗交换芯片，一跳直达，这是 PCIe 域内最短的路径。'
    },
    'NV8': { layer: 'NVLink 层', short: '走了 8 条 NVLink', why: 'GPU 之间的专线，不经过 PCIe。' },
    'NV4': { layer: 'NVLink 层', short: '走了 4 条 NVLink', why: 'GPU 之间的专线，不经过 PCIe。' }
  };

  function codeInfo(code) {
    return CODE_INFO[code] || { layer: '未知', short: code, why: '' };
  }

  root.TopoModel = {
    CODE: CODE,
    num: num,
    has: has,
    deviceIds: deviceIds,
    partType: partType,
    allParts: allParts,
    derivePath: derivePath,
    relation: relation,
    buildMatrix: buildMatrix,
    compareMatrix: compareMatrix,
    blankConfig: blankConfig,
    validateConfig: validateConfig,
    generateMachine: generateMachine,
    formatTopo: formatTopo,
    formatTopoParts: formatTopoParts,
    formatLscpu: formatLscpu,
    codeInfo: codeInfo
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoModel;
})(typeof globalThis !== 'undefined' ? globalThis : this);
