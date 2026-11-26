(function (root) {
  'use strict';

  var M = root.TopoModel;

  /* ============================================================
     X1 命令行台
     设计原则：命令的输出只能来自"当前关卡的现场"。
     没有现场时，退化成一台参考机型，并且明确告诉玩家这不是本关的机器。
     ============================================================ */

  var DRIVER = '550.54.15';
  var CUDA = '12.4';

  function pad(s, n) {
    s = String(s);
    while (s.length < n) s = ' ' + s;
    return s;
  }
  function padR(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }
  function line(ch, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += ch;
    return out;
  }

  /* ---------------- 现场 ---------------- */

  function refGpu(i) {
    return {
      idx: i,
      name: 'NVIDIA H100 80GB HBM3',
      bus: '00000000:' + (0x3b + i * 2).toString(16).toUpperCase() + ':00.0',
      uuid: 'GPU-' + (0x4a1f2b3c + i * 7919).toString(16),
      temp: 62 + (i % 3) * 4,
      power: 640 + (i % 4) * 15,
      cap: 700,
      memTotal: 81920,
      memUsed: 71200 + (i % 5) * 1800,
      util: 88 + (i % 6) * 2,
      eccDbe: 0, eccSbe: 0, retired: 0,
      pcieGen: 5, pcieWidth: 16,
      nvlinkCrc: 0, nvlinkLinks: 18,
      smClock: 1410, memClock: 2619, throttle: null,
      absent: false
    };
  }

  /*
    监控世界：带外（BMC）与 Prometheus / 计费。
    L0 的电力与散热、L5 的成本与推理，证据都不在主机 shell 里，
    所以这一层是独立的数据源，不是把 nvidia-smi 换个说法。
  */
  function refMon() {
    var gTemps = [], gUtil = [];
    for (var i = 0; i < 8; i++) {
      gTemps.push({ labels: { host: 'gpu-node-07', gpu: String(i) }, v: 68 + (i % 3) * 3 });
      gUtil.push({ labels: { host: 'gpu-node-07', gpu: String(i) }, v: 91 + (i % 4) });
    }
    return {
      rack: {
        id: 'A01', row: 'R03',
        pdu: [
          { name: 'PDU-A', branch: 'L1', loadA: 38.4, capA: 60 },
          { name: 'PDU-B', branch: 'L2', loadA: 37.6, capA: 60 }
        ]
      },
      bmc: {
        inlet: 24, exhaust: 38, fanPct: 46,
        nodeWatts: 6120, nodeCap: 10200,
        psus: [
          { id: 'PSU1', watts: 1510, status: 'ok' },
          { id: 'PSU2', watts: 1490, status: 'ok' },
          { id: 'PSU3', watts: 1500, status: 'ok' },
          { id: 'PSU4', watts: 1470, status: 'ok' }
        ],
        sel: [
          '   1 | 11/12/2026 | 04:02:18 | Power Supply PSU3 | Power Supply AC lost | Asserted',
          '   2 | 11/12/2026 | 04:02:19 | Power Supply PSU3 | Power Supply AC lost | Deasserted'
        ]
      },
      metrics: {
        rack_power_kw: {
          unit: 'kW', help: '机柜总功耗（PDU 合计）',
          series: [{ labels: { rack: 'A01' }, v: 12.2 }]
        },
        pdu_current_a: {
          unit: 'A', help: 'PDU 支路电流',
          series: [
            { labels: { rack: 'A01', pdu: 'A' }, v: 38.4 },
            { labels: { rack: 'A01', pdu: 'B' }, v: 37.6 }
          ]
        },
        gpu_temp_c: { unit: 'C', help: 'GPU 温度', series: gTemps },
        gpu_util_pct: { unit: '%', help: 'GPU SM 利用率', series: gUtil },
        ttft_p99_ms: { unit: 'ms', help: '首 token 延迟 P99', series: [{ labels: { svc: 'infer-bert' }, v: 212 }] },
        request_queue_depth: { unit: 'req', help: '排队等待的请求数', series: [{ labels: { svc: 'infer-bert' }, v: 0 }] },
        container_cpu_throttled_ratio: { unit: 'ratio', help: '容器 CPU 被限流的比例', series: [{ labels: { pod: 'infer-bert-0' }, v: 0.02 }] }
      },
      bill: {
        team: 'nlp', period: '2026-11-01 ~ 2026-11-25', days: 25,
        resource: 'H100 80G', cards: 32, gpuHours: 18432, price: 28, utilPct: 71.4
      }
    };
  }

  function referenceWorld() {
    var gpus = [];
    for (var i = 0; i < 8; i++) gpus.push(refGpu(i));
    return {
      kind: 'reference',
      host: 'gpu-node-07',
      mon: refMon(),
      driver: DRIVER, cuda: CUDA,
      gpus: gpus,
      nics: [
        { dev: 'mlx5_0', state: 'Active', rate: 400, numa: 0 },
        { dev: 'mlx5_1', state: 'Active', rate: 400, numa: 0 },
        { dev: 'mlx5_2', state: 'Active', rate: 400, numa: 1 },
        { dev: 'mlx5_3', state: 'Active', rate: 400, numa: 1 }
      ],
      numa: [
        { id: 0, cpus: '0-47', memMB: 515000 },
        { id: 1, cpus: '48-95', memMB: 515000 }
      ],
      kernel: ['[    0.000000] Linux version 5.15.0-105-generic (gcc 11.4.0)'],
      pods: [
        { name: 'train-0', ns: 'ai', status: 'Running', node: 'gpu-node-07', restarts: 0, cpu: '9200m', mem: '48.2Gi' },
        { name: 'train-1', ns: 'ai', status: 'Running', node: 'gpu-node-08', restarts: 0, cpu: '9180m', mem: '47.9Gi' }
      ],
      hpa: [
        { name: 'infer-bert', ns: 'ai', ref: 'Deployment/infer-bert', targets: '24%/70%', min: 2, max: 20, replicas: 3 }
      ],
      etcd: { fsyncMs: 0.84, dbSize: '418 MB', leader: true },
      mem: { avail: '186Gi', swapUsed: '1.2Gi', swapFree: '6.8Gi' }
    };
  }

  /* 从 M03 的拓扑模型生成现场：矩阵、lspci、网卡 NUMA 全都来自真配置 */
  function fromConfig(cfg) {
    var w = referenceWorld();
    w.kind = 'model';
    w.config = cfg;
    var gpus = [], nics = [], ni = 0;
    var ids = M.deviceIds(cfg);
    var gi = 0;
    ids.forEach(function (id) {
      var d = cfg.devices[id];
      var p = M.derivePath(cfg, id);
      if (d.type === 'gpu') {
        var g = refGpu(gi);
        g.idx = gi;
        g.bus = '00000000:' + (0x3b + gi * 2).toString(16).toUpperCase() + ':00.0';
        g.numa = p.numa === null ? 0 : p.numa;
        gpus.push(g);
        gi++;
      } else {
        nics.push({
          dev: 'mlx5_' + ni,
          state: 'Active',
          rate: d.speed || 400,
          numa: p.numa === null ? 0 : p.numa,
          gpuIdx: gi
        });
        ni++;
      }
    });
    w.gpus = gpus;
    w.nics = nics;
    return w;
  }

  function mergeMon(base, ov) {
    var m = JSON.parse(JSON.stringify(base));
    if (ov.rack) {
      Object.keys(ov.rack).forEach(function (k) {
        if (k === 'pdu' && ov.rack.pdu) m.rack.pdu = JSON.parse(JSON.stringify(ov.rack.pdu));
        else m.rack[k] = ov.rack[k];
      });
    }
    if (ov.bmc) {
      Object.keys(ov.bmc).forEach(function (k) { m.bmc[k] = JSON.parse(JSON.stringify(ov.bmc[k])); });
    }
    if (ov.bill) {
      Object.keys(ov.bill).forEach(function (k) { m.bill[k] = ov.bill[k]; });
    }
    if (ov.metrics) {
      Object.keys(ov.metrics).forEach(function (name) {
        var patch = ov.metrics[name];
        var cur = m.metrics[name];
        if (!cur) { m.metrics[name] = JSON.parse(JSON.stringify(patch)); return; }
        /* 只改一个数时用 {v: x}，整组换掉时用 {series: [...]} */
        if (patch.series) cur.series = JSON.parse(JSON.stringify(patch.series));
        else if (patch.v !== undefined) cur.series.forEach(function (s) { s.v = patch.v; });
        if (patch.unit) cur.unit = patch.unit;
        if (patch.help) cur.help = patch.help;
      });
    }
    return m;
  }

  /*
    world 覆盖：关卡可以只声明"哪张卡坏了"，其余走默认。
    这样每个案例只写三五行，不用复制一整台机器。
  */
  function applyOverrides(base, ov) {
    if (!ov) return base;
    var w = JSON.parse(JSON.stringify(base));
    w.kind = 'scene';
    if (ov.host) w.host = ov.host;
    if (ov.mon) {
      w.mon = mergeMon(refMon(), ov.mon);
      w.mon.custom = true;
    }
    if (ov.gpuCount) {
      w.gpus = [];
      for (var i = 0; i < ov.gpuCount; i++) w.gpus.push(refGpu(i));
    }
    /* 整机同一种病（比如全部卡都被高温降频）用 gpuAll，别抄八遍 */
    if (ov.gpuAll) {
      w.gpus.forEach(function (g) {
        Object.keys(ov.gpuAll).forEach(function (k) { g[k] = ov.gpuAll[k]; });
      });
    }
    (ov.gpus || []).forEach(function (patch) {
      var g = w.gpus[patch.idx];
      if (!g) { g = refGpu(patch.idx); w.gpus[patch.idx] = g; }
      Object.keys(patch).forEach(function (k) { g[k] = patch[k]; });
    });
    if (ov.absent) {
      ov.absent.forEach(function (i) { if (w.gpus[i]) w.gpus[i].absent = true; });
    }
    if (ov.nics) w.nics = ov.nics;
    if (ov.numa) w.numa = ov.numa;
    if (ov.kernel) w.kernel = ov.kernel;
    if (ov.pods) w.pods = ov.pods;
    if (ov.etcd) w.etcd = ov.etcd;
    if (ov.mem) w.mem = ov.mem;
    if (ov.hpa) w.hpa = ov.hpa;
    if (ov.irqHot) w.irqHot = true;
    if (ov.config) w.config = ov.config;
    return w;
  }

  /* ---------------- 格式化 ---------------- */

  function nowStr() {
    var d = new Date();
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function two(n) { return n < 10 ? '0' + n : '' + n; }
    return days[d.getDay()] + ' ' + mon[d.getMonth()] + ' ' + two(d.getDate()) + ' ' +
      two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + ' ' + d.getFullYear();
  }

  var S1 = 41, S2 = 26, S3 = 22;

  /* 表格一律按列宽截断再补齐，保证边框永远对齐（手写宽度一定会算错） */
  function row3(a, b, c) {
    return '|' + padR(String(a).slice(0, S1), S1) +
      '|' + padR(String(b).slice(0, S2), S2) +
      '|' + padR(String(c).slice(0, S3), S3) + '|';
  }
  function sep(ch) {
    return '+' + line(ch, S1) + '+' + line(ch, S2) + '+' + line(ch, S3) + '+';
  }

  function smiTable(w) {
    var out = [nowStr()];
    out.push(sep('-'));
    out.push(row3(' NVIDIA-SMI ' + w.driver, 'Driver Version: ' + w.driver, 'CUDA Version: ' + w.cuda));
    out.push(sep('-'));
    out.push(row3(' GPU  Name                 Persistence-M', 'Bus-Id        Disp.A', 'Volatile Uncorr. ECC'));
    out.push(row3(' Fan  Temp   Perf          Pwr:Usage/Cap', 'Memory-Usage', 'GPU-Util  Compute M.'));
    out.push(sep('='));
    var shown = 0;
    w.gpus.forEach(function (g) {
      if (g.absent) return;
      shown++;
      out.push(row3(
        ' ' + pad(g.idx, 3) + '  ' + padR(g.name.replace('NVIDIA ', ''), 24) + ' On',
        padR(g.bus + ' Off', S2),
        pad(g.eccDbe, S3 - 2) + '  '
      ));
      out.push(row3(
        ' N/A ' + padR(g.temp + 'C', 5) + ' P0 ' + padR(g.power + 'W / ' + g.cap + 'W', 17),
        padR(g.memUsed + 'MiB / ' + g.memTotal + 'MiB', S2 - 1),
        padR(g.util + '%', 9) + '  Default'
      ));
      out.push(sep('-'));
    });
    out.push('');
    out.push(sep('-'));
    out.push(row3(' Processes:', '', ''));
    out.push(row3('  GPU  GI  CI     PID  Type  Process name    ', 'Usage', ''));
    out.push(sep('='));
    if (shown) {
      out.push(row3('    0  N/A N/A  20481    C  python          ', pad(71200 + 'MiB', S2), ''));
    }
    out.push(sep('-'));
    if (shown < w.gpus.length) {
      out.push('');
      out.push('# 只列出 ' + shown + ' 张卡，另外 ' + (w.gpus.length - shown) + ' 张没有出现在 nvidia-smi 里。');
    }
    return out.join(String.fromCharCode(10));
  }

  function smiList(w) {
    var out = [];
    w.gpus.forEach(function (g) {
      if (g.absent) return;
      out.push('GPU ' + g.idx + ': ' + g.name + ' (UUID: ' + g.uuid + ')');
    });
    return out.join('\n');
  }

  function smiQuery(w) {
    var out = ['==============NVSMI LOG==============', ''];
    out.push('Timestamp                                 : ' + nowStr());
    out.push('Driver Version                            : ' + w.driver);
    out.push('CUDA Version                              : ' + w.cuda);
    out.push('');
    out.push('Attached GPUs                             : ' + w.gpus.filter(function (g) { return !g.absent; }).length);
    w.gpus.forEach(function (g) {
      if (g.absent) return;
      out.push('');
      out.push('GPU ' + g.bus);
      out.push('    Product Name                          : ' + g.name);
      out.push('    Minor Number                          : ' + g.idx);
      out.push('    ECC Mode');
      out.push('        Current                           : Enabled');
      out.push('        Pending                           : Enabled');
      out.push('    Volatile Uncorr. ECC');
      out.push('        Device Memory                     : ' + g.eccDbe);
      out.push('    Retired Pages');
      out.push('        Double Bit Error Page Retirement  : ' + g.retired);
      out.push('    PCI');
      out.push('        Link Width                        : ' + g.pcieWidth + 'x');
      out.push('        Max Link Width                    : 16x');
      out.push('        Link Gen                          : ' + g.pcieGen);
      out.push('    Temperature');
      out.push('        GPU Current Temp                  : ' + g.temp + ' C');
      out.push('    Clocks');
      out.push('        SM                                : ' + g.smClock + ' MHz');
      out.push('        Memory                            : ' + g.memClock + ' MHz');
      out.push('    Clocks Throttle Reasons');
      ['Idle', 'SW Power Cap', 'HW Slowdown', 'HW Thermal Slowdown'].forEach(function (rs) {
        out.push('        ' + padR(rs, 34) + ': ' + (g.throttle === rs ? 'Active' : 'Not Active'));
      });
    });
    return out.join('\n');
  }

  function nvlinkErr(w) {
    var out = [];
    w.gpus.forEach(function (g) {
      if (g.absent) return;
      out.push('GPU ' + g.idx + ': ' + g.name + ' (UUID: ' + g.uuid + ')');
      var links = g.nvlinkLinks || 18;
      for (var i = 0; i < links; i++) {
        var crc = (i === (g.nvlinkBad || -1)) ? (g.nvlinkCrc || 4200) : 0;
        out.push('\t Link ' + i + ': ' + crc + ' CRC errors');
      }
      out.push('');
    });
    return out.join('\n');
  }

  function topoText(w) {
    if (w.config) return M.formatTopo(w.config);
    return ['        GPU0    GPU1    GPU2    GPU3    NIC0    CPU Affinity   NUMA Affinity',
      'GPU0     X      NV8     NV8     NV8     PIX     0-47           0',
      'GPU1    NV8      X      NV8     NV8     PIX     0-47           0',
      'GPU2    NV8     NV8      X      NV8     SYS     48-95          1',
      'GPU3    NV8     NV8     NV8      X      SYS     48-95          1',
      'NIC0    PIX     PIX     SYS     SYS      X      -              -',
      '',
      'Legend:',
      '  X    = Self',
      '  SYS  = Connection traversing PCIe as well as the SMP interconnect between NUMA nodes',
      '  NV#  = Connection traversing a bonded set of # NVLinks'].join('\n') +
      '\n\n# 参考机型（4 卡示意）。本关没有专属拓扑，完整矩阵见 M03。';
  }

  function lspciText(w) {
    var out = ['-[0000:00]-+-00.0  Intel Corporation Device 1a20'];
    w.gpus.forEach(function (g) {
      var mark = g.absent ? '  [driver not bound]' : '';
      out.push('           +-' + g.bus.slice(9, 12).toLowerCase() + '.0  NVIDIA Corporation ' +
        g.name.replace('NVIDIA ', '') + ' [LnkCap: ' + g.pcieGen + ' x16, LnkSta: ' +
        g.pcieGen + ' x' + g.pcieWidth + ']' + mark);
    });
    w.nics.forEach(function (n, i) {
      out.push('           +-' + (0x5e + i).toString(16) + '.0  Mellanox Technologies MT2910 [' + n.dev + ']');
    });
    return out.join('\n');
  }

  function lscpuText(w) {
    var total = 0;
    w.numa.forEach(function (n) {
      var m = String(n.cpus).split('-');
      total += (m.length > 1 ? Number(m[1]) - Number(m[0]) + 1 : 1);
    });
    var out = ['Architecture:          x86_64',
      'CPU(s):                ' + total,
      'Thread(s) per core:    1',
      'Core(s) per socket:    ' + (total / w.numa.length | 0),
      'Socket(s):             ' + w.numa.length,
      'NUMA node(s):          ' + w.numa.length];
    w.numa.forEach(function (n) { out.push('NUMA node' + n.id + ' CPU(s):      ' + n.cpus); });
    return out.join('\n');
  }

  function numactlText(w) {
    var out = ['available: ' + w.numa.length + ' nodes (0-' + (w.numa.length - 1) + ')'];
    w.numa.forEach(function (n) {
      out.push('node ' + n.id + ' cpus: ' + n.cpus);
      out.push('node ' + n.id + ' size: ' + n.memMB + ' MB');
    });
    out.push('');
    out.push('node distances:');
    out.push('node  ' + w.numa.map(function (n) { return padR(n.id, 6); }).join(''));
    w.numa.forEach(function (a) {
      out.push(padR(a.id, 6) + w.numa.map(function (b) { return padR(a.id === b.id ? 10 : 21, 6); }).join(''));
    });
    return out.join('\n');
  }

  function ibstatText(w) {
    var out = [];
    w.nics.forEach(function (n) {
      out.push('CA \'' + n.dev + '\'');
      out.push('\tCA type: MT2910');
      out.push('\tNumber of ports: 1');
      out.push('\tFirmware version: 28.39.1002');
      out.push('\tPort 1:');
      out.push('\t\tState: ' + (n.state || 'Active'));
      out.push('\t\tPhysical state: LinkUp');
      out.push('\t\tRate: ' + n.rate);
      out.push('\t\tLink layer: InfiniBand');
      out.push('');
    });
    return out.join('\n') || 'ibstat: no IB devices found';
  }

  function dmesgText(w) {
    if (!w.kernel || !w.kernel.length) return '# kernel ring buffer is empty in this scene';
    return w.kernel.join('\n');
  }

  function freeText(w) {
    var m = (w && w.mem) || {};
    var used = m.used || '812Gi';
    var free = m.free || '18Gi';
    var buff = m.buff || '190Gi';
    var avail = m.avail || '186Gi';
    var swapUsed = m.swapUsed || '1.2Gi';
    var swapFree = m.swapFree || '6.8Gi';
    return ['               total        used        free      shared  buff/cache   available',
      'Mem:           1.0Ti' + pad(used, 12) + pad(free, 12) + pad('2.1Gi', 12) + pad(buff, 12) + pad(avail, 11),
      'Swap:          8.0Gi' + pad(swapUsed, 12) + pad(swapFree, 11)].join('\n');
  }

  function kubectlText(w, sub) {
    if (/^(get|describe)\s+hpa/.test(sub)) return hpaText(w, sub);
    if (/^top\s+pods?$/.test(sub)) return topText(w);
    if (!sub || sub === 'get pods' || sub === 'get pod') {
      var out = ['NAMESPACE   NAME            READY   STATUS              RESTARTS   AGE   NODE'];
      w.pods.forEach(function (p) {
        var ready = (p.status === 'Running') ? '1/1' : '0/1';
        out.push(padR(p.ns, 12) + padR(p.name, 16) + padR(ready, 8) + padR(p.status, 20) +
          padR(p.restarts, 11) + padR('3h', 6) + p.node);
      });
      return out.join('\n');
    }
    var m = sub.match(/describe\s+pod\s+(\S+)/);
    if (m) {
      var pod = null;
      w.pods.forEach(function (p) { if (p.name === m[1]) pod = p; });
      if (!pod) return 'Error from server (NotFound): pods "' + m[1] + '" not found';
      var nodeLine = (pod.node && pod.node !== '<none>') ? (pod.node + '/10.0.3.21') : '<none>';
      var out2 = ['Name:         ' + pod.name,
        'Namespace:    ' + pod.ns,
        'Node:         ' + nodeLine,
        'Status:       ' + pod.status,
        'Restart Count: ' + pod.restarts,
        '',
        'Events:',
        '  Type     Reason     Age   From      Message',
        '  ----     ------     ----  ----      -------'];
      (pod.events || ['  Normal   Started    3h    kubelet   Started container trainer']).forEach(function (e) {
        out2.push(e);
      });
      return out2.join('\n');
    }
    return 'kubectl: 支持 get pods / describe pod <name> / get hpa / describe hpa <name> / top pods';
  }

  function etcdText(w) {
    var e = w.etcd || {};
    return ['+----------------+---------+---------+------------+------------+-----------+------------+--------------------+',
      '|    ENDPOINT    |    ID   | VERSION | DB SIZE    | IS LEADER  | IS LEARNER| RAFT TERM  | RAFT APPLIED INDEX |',
      '+----------------+---------+---------+------------+------------+-----------+------------+--------------------+',
      '| 127.0.0.1:2379 | 8e9e05c5|  3.5.12 |  ' + padR(e.dbSize || '418 MB', 8) + ' |  ' + padR(e.leader ? 'true' : 'false', 8) + ' |   false   |     41     |      918273        |',
      '+----------------+---------+---------+------------+------------+-----------+------------+--------------------+',
      '',
      'wal_fsync_duration_seconds{quantile="0.99"}  ' + (e.fsyncMs || 0.84)].join('\n');
  }

  function lsmodText(w, filt) {
    var mods = w.modules || ['nvidia', 'nvidia_uvm', 'nvidia_drm', 'mlx5_core', 'mlx5_ib', 'ib_core', 'nvidia_peermem'];
    if (filt) mods = mods.filter(function (m) { return m.indexOf(filt) >= 0; });
    if (!mods.length) return '';
    var out = ['Module                  Size  Used by'];
    mods.forEach(function (m) { out.push(padR(m, 22) + pad(16384000, 10) + '  12'); });
    return out.join(String.fromCharCode(10));
  }

  function interruptsText(w) {
    if (w && w.irqHot) {
      return ['           CPU0       CPU1       ...      CPU47',
        '  0:         12          0       ...         0   IO-APIC   2-edge      timer',
        ' 94:          0          0       ...    918273   PCI-MSI 524288-edge   mlx5_comp0',
        ' 95:          0          0       ...    812739   PCI-MSI 524289-edge   mlx5_comp1',
        ' 96:          0          0       ...    701223   PCI-MSI 524290-edge   mlx5_comp2',
        ' 97:          0          0       ...    688901   PCI-MSI 524291-edge   mlx5_comp3',
        '',
        '# 四条队列的中断全部落在 CPU47。'].join('\n');
    }
    return ['           CPU0       CPU1       ...      CPU47',
      '  0:         12          0       ...         0   IO-APIC   2-edge      timer',
      ' 94:      231882      188211       ...    204117   PCI-MSI 524288-edge   mlx5_comp0',
      ' 95:      229104      191002       ...    198776   PCI-MSI 524289-edge   mlx5_comp1',
      '',
      '# 中断分散在多颗核上。'].join('\n');
  }

  /* ---------------- 带外 / 监控 ---------------- */

  function defSensors(b) {
    var rows = [
      { n: 'Inlet Temp', v: b.inlet + ' degrees C', s: b.inlet >= 32 ? 'cr' : (b.inlet > 27 ? 'nc' : 'ok') },
      { n: 'Exhaust Temp', v: b.exhaust + ' degrees C', s: 'ok' },
      { n: 'Fan1', v: Math.round(b.fanPct * 182) + ' RPM', s: 'ok' },
      { n: 'Fan2', v: Math.round(b.fanPct * 178) + ' RPM', s: 'ok' },
      { n: 'Pwr Consumption', v: b.nodeWatts + ' Watts', s: 'ok' }
    ];
    (b.psus || []).forEach(function (p) {
      var bad = p.status !== 'ok';
      rows.push({ n: p.id + ' Power', v: (bad ? 0 : p.watts) + ' Watts', s: bad ? 'ns' : 'ok' });
      rows.push({ n: p.id + ' Status', v: bad ? '0x00' : '0x01', s: bad ? 'ns' : 'ok' });
    });
    return rows;
  }

  function ipmiSdrText(w) {
    var b = w.mon.bmc;
    var rows = b.sensors || defSensors(b);
    return rows.map(function (s) {
      return padR(s.n, 16) + '| ' + padR(s.v, 18) + '| ' + s.s;
    }).join('\n');
  }

  function ipmiSelText(w) {
    var rows = w.mon.bmc.sel || [];
    if (!rows.length) return 'SEL has no entries.';
    return ['   ID | Date        | Time     | Sensor             | Event                    | State',
      '------+-------------+----------+--------------------+--------------------------+--------']
      .concat(rows).join('\n');
  }

  var SEL_LABEL = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?$/;

  function parseSel(s) {
    var m = String(s || '').trim().match(SEL_LABEL);
    if (!m) return null;
    var labels = {};
    if (m[2]) {
      m[2].split(',').forEach(function (kv) {
        var p = kv.split('=');
        if (p.length !== 2) return;
        labels[p[0].trim()] = p[1].trim().replace(/^["']/, '').replace(/["']$/, '');
      });
    }
    return { name: m[1], labels: labels };
  }

  function labelStr(labels) {
    var keys = Object.keys(labels);
    if (!keys.length) return '{}';
    return '{' + keys.map(function (k) { return k + '="' + labels[k] + '"'; }).join(', ') + '}';
  }

  function promText(w, raw) {
    var expr = String(raw || '').trim().replace(/^["']/, '').replace(/["']$/, '');
    if (!expr) return "prom: 用法 prom query '<表达式>'，例 prom query 'gpu_util_pct'";
    var ts = Math.floor(Date.now() / 1000);
    var agg = null;
    var inner = expr;
    var am = expr.match(/^(avg|max|min|sum)\((.*)\)$/);
    if (am) { agg = am[1]; inner = am[2]; }

    var sel = parseSel(inner);
    if (!sel) return 'prom: 解析不了「' + expr + '」。本机 prom 只支持即时查询（指标名 + label 过滤 + avg/max/min/sum）。';
    var metric = w.mon.metrics[sel.name];
    if (!metric) {
      return 'prom: 没有叫「' + sel.name + '」的指标。可用的有：\n  ' +
        Object.keys(w.mon.metrics).join('\n  ');
    }
    var head = '# prom query: ' + expr + '   （' + (metric.help || '无说明') + '，单位 ' + (metric.unit || '-') + '）';
    if (!metric.series || !metric.series.length) {
      return head + '\n# 0 series：这个指标没有采集到样本。';
    }

    var picked = metric.series.filter(function (s) {
      return Object.keys(sel.labels).every(function (k) { return s.labels[k] === sel.labels[k]; });
    });
    if (!picked.length) {
      return head + '\n# 0 series：这个 label 组合没有数据。';
    }
    if (agg) {
      var vals = picked.map(function (s) { return s.v; });
      var v = agg === 'avg' ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length
        : agg === 'max' ? Math.max.apply(null, vals)
          : agg === 'min' ? Math.min.apply(null, vals)
            : vals.reduce(function (a, b) { return a + b; }, 0);
      v = Math.round(v * 100) / 100;
      return head + '\n{} => ' + v + ' @[' + ts + ']   # ' + agg + ' over ' + picked.length + ' series';
    }
    return head + '\n' + picked.map(function (s) {
      return labelStr(s.labels) + ' => ' + s.v + ' @[' + ts + ']';
    }).join('\n');
  }

  function num(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function billText(w, cmd) {
    var b = w.mon.bill;
    var m = String(cmd).match(/--team\s+(\S+)/);
    if (m && m[1] !== b.team) {
      return 'bill: 没有「' + m[1] + '」这个团队的账单。本机只挂了 ' + b.team + ' 的账。';
    }
    var amount = b.gpuHours * b.price;
    var eff = Math.round(b.gpuHours * b.utilPct / 100);
    var idle = b.gpuHours - eff;
    var idleCost = idle * b.price;
    var pct = b.gpuHours > 0 ? Math.round(idle / b.gpuHours * 1000) / 10 : 0;
    var rows = [
      '计费周期   ' + b.period + '（' + b.days + ' 天）        团队  ' + b.team,
      '资源       卡数   卡时        单价            金额',
      padR(b.resource, 11) + padR(b.cards, 7) + padR(num(b.gpuHours), 12) +
      padR('¥' + b.price + '.00/卡时', 16) + '¥' + num(amount),
      '',
      b.gpuHours > 0
        ? '有效算力   平均 SM 利用率 ' + b.utilPct + '%  →  ' + num(eff) + ' 有效卡时'
        : '有效算力   本周期没有卡时记录',
      '闲置成本   ' + num(idle) + ' 卡时 × ¥' + b.price + ' = ¥' + num(idleCost) + '（占 ' + pct + '%）',
      '账单口径   按卡时计费：卡空转也照收，利用率不影响账单。'
    ];
    return rows.join('\n');
  }

  function hpaText(w, sub) {
    var list = w.hpa || [];
    if (sub.indexOf('describe') === 0) {
      var nm = sub.replace(/.*hpa\s*/, '').trim();
      var h = null;
      list.forEach(function (x) { if (x.name === nm) h = x; });
      if (!h) return 'Error from server (NotFound): horizontalpodautoscalers.autoscaling "' + nm + '" not found';
      var parts = String(h.targets || '<unknown>/70%').split('/');
      var out = ['Name:                                                  ' + h.name,
        'Namespace:                                             ' + (h.ns || 'ai'),
        'Reference:                                             ' + h.ref,
        'Metrics:                                               ( current / target )',
        '  resource cpu on pods  (as a percentage of request):  ' + parts[0] + ' / ' + (parts[1] || ''),
        'Min replicas:                                          ' + h.min,
        'Max replicas:                                          ' + h.max,
        'Deployment pods:                                       ' + h.replicas + ' current / ' + h.replicas + ' desired',
        'Events:',
        '  Type     Reason             Age   From                       Message',
        '  ----     ------             ----  ----                       -------'];
      (h.events || ['  Normal   SuccessfulRescale  4m    horizontal-pod-autoscaler  New size: ' + h.replicas + '; reason: cpu resource utilization above target']).forEach(function (e) {
        out.push(e);
      });
      return out.join('\n');
    }
    if (!list.length) return 'No resources found in ai namespace.';
    var head = 'NAME          REFERENCE                   TARGETS           MINPODS   MAXPODS   REPLICAS   AGE';
    return [head].concat(list.map(function (h) {
      return padR(h.name, 14) + padR(h.ref, 28) + padR(h.targets || '<unknown>/70%', 18) +
        padR(h.min, 10) + padR(h.max, 10) + padR(h.replicas, 11) + '6d';
    })).join('\n');
  }

  function topText(w) {
    var head = 'NAME            CPU(cores)   MEMORY(bytes)';
    return [head].concat(w.pods.map(function (p) {
      return padR(p.name, 16) + padR(p.cpu || '120m', 13) + (p.mem || '1.2Gi');
    })).join('\n');
  }

  var HELP = [
    '可用命令（输入 help 随时回来看）：',
    '',
    '  nvidia-smi                 卡、显存、利用率、温度、功耗',
    '  nvidia-smi -L              列出 GPU 与 UUID',
    '  nvidia-smi -q              详细查询：ECC、retired pages、PCIe 链路',
    '  nvidia-smi nvlink -e       NVLink 每条链路的 CRC 计数',
    '  nvidia-smi topo -m         卡与卡、卡与网卡的关系码',
    '  lspci -tv                  PCIe 树的形状与链路宽度',
    '  lscpu / numactl -H         NUMA 节点与 CPU 分布',
    '  ibstat                     IB 设备与端口状态',
    '  dmesg                      内核日志（XID 都在这里）',
    '  free -h / uptime           内存与负载',
    '  kubectl get pods           Pod 状态',
    '  kubectl describe pod X     Pod 事件',
    '  etcdctl endpoint status    控制面落盘延迟',
    '  cat /proc/interrupts       中断落在哪些核',
    '  lsmod | grep nvidia        内核模块加载情况（peermem 在不在这）',
    '',
    '  —— 带外与监控：L0 的电力散热、L5 的成本与推理看这里 ——',
    '  ipmitool sdr               带外传感器：进风温度、风扇、每颗 PSU 的实际功率',
    '  ipmitool sel list          带外事件日志：掉电、过温、风扇、冗余丢失',
    "  prom query '<表达式>'      Prometheus 即时查询（封装了 HTTP API 的小工具）",
    "                             例：prom query 'pdu_current_a{rack=\"A01\"}' / prom query 'avg(gpu_util_pct)'",
    '  bill report --team nlp     账单：卡时、有效算力、闲置成本',
    '  kubectl get hpa            HPA 的当前目标值（TARGETS 是 unknown 就要查）',
    '  kubectl top pods           容器 CPU / 内存实际用量',
    '  clear                      清屏',
    '',
    '先用命令取证，再回左边选项。凡是题面已经给了结论的，命令行里都能找到对应的一行。'
  ].join('\n');

  function exec(raw, world) {
    world = ensureWorld(world);
    var cmd = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!cmd) return { text: '', clear: false };
    var low = cmd.toLowerCase();

    if (low === 'help' || low === '?') return { text: HELP };
    if (low === 'clear') return { text: '', clear: true };

    if (low === 'nvidia-smi') return { text: smiTable(world) };
    if (low === 'nvidia-smi -l') return { text: smiList(world) };
    if (low === 'nvidia-smi -q') return { text: smiQuery(world) };
    if (/^nvidia-smi -q -i \d+$/.test(low)) {
      var idx = Number(low.split(' ').pop());
      var one = JSON.parse(JSON.stringify(world));
      one.gpus = world.gpus.filter(function (g) { return g.idx === idx; });
      return { text: smiQuery(one) };
    }
    if (low === 'nvidia-smi nvlink -e') return { text: nvlinkErr(world) };
    if (low === 'nvidia-smi topo -m' || low === 'topo') return { text: topoText(world) };
    if (low === 'lspci -tv' || low === 'lspci') return { text: lspciText(world) };
    if (low === 'lscpu') return { text: lscpuText(world) };
    if (low === 'numactl -h' || low === 'numactl --hardware') return { text: numactlText(world) };
    if (low === 'ibstat' || low === 'ibv_devinfo') return { text: ibstatText(world) };
    if (low === 'dmesg' || low === 'dmesg | grep -i xid' || low === 'dmesg | grep xid') return { text: dmesgText(world) };
    if (low === 'free -h' || low === 'free') return { text: freeText(world) };
    if (low === 'uptime') return { text: ' 14:10:03 up 41 days,  3:12,  2 users,  load average: 63.21, 61.88, 60.42' };
    if (low.indexOf('kubectl') === 0) return { text: kubectlText(world, low.replace(/^kubectl\s*/, '')) };
    if (low.indexOf('etcdctl') === 0) return { text: etcdText(world) };
    if (low === 'cat /proc/interrupts') return { text: interruptsText(world) };

    /* 带外 / 监控：不经过操作系统，走 BMC 与 Prometheus */
    if (low.indexOf('ipmitool') === 0) {
      if (/sdr/.test(low)) return { text: ipmiSdrText(world) };
      if (/sel/.test(low)) return { text: ipmiSelText(world) };
      return { text: 'ipmitool: 本机只接了 sdr 与 sel。例：ipmitool sdr / ipmitool sel list' };
    }
    if (low.indexOf('prom ') === 0) {
      var expr = cmd.replace(/^prom\s+/i, '').replace(/^query\b\s*/i, '').trim();
      if (!expr) return { text: "prom: 用法 prom query '<表达式>'，例 prom query 'gpu_util_pct'" };
      return { text: promText(world, expr) };
    }
    if (low === 'prom') return { text: "prom: 用法 prom query '<表达式>'，例 prom query 'gpu_util_pct'" };
    if (low.indexOf('bill') === 0) return { text: billText(world, cmd) };
    if (low.indexOf('lsmod') === 0) {
      var filt = null;
      var gm = low.match(/grep\s+(\S+)/);
      if (gm) filt = gm[1];
      var txt = lsmodText(world, filt);
      return { text: txt || '# 没有匹配的模块' };
    }

    if (/^nvidia-smi/.test(low)) {
      return { text: 'nvidia-smi: 不支持的参数「' + cmd + '」。试 help。' };
    }
    return { text: 'bash: ' + cmd.split(' ')[0] + ': command not found' };
  }

  /* 给某一关解析现场：优先用关卡自带，其次用 M03 的模型，最后退到参考机型 */
  function worldFor(scen) {
    if (!scen) return referenceWorld();
    if (scen.world) return applyOverrides(referenceWorld(), scen.world);
    if (scen.machine) return fromConfig(scen.machine);
    return referenceWorld();
  }

  /*
    入口兜底：任何一条命令都不该因为"现场缺一块"而抛异常。
    缺的字段从参考机型补，补的是结构不是数值——不改变案卷声明的任何数据。
  */
  function ensureWorld(w) {
    if (!w || typeof w !== 'object') return referenceWorld();
    var base = referenceWorld();
    ['gpus', 'nics', 'numa', 'pods', 'hpa', 'kernel'].forEach(function (k) {
      if (!Array.isArray(w[k])) w[k] = base[k];
    });
    ['etcd', 'mem', 'driver', 'cuda', 'host', 'kind'].forEach(function (k) {
      if (w[k] === undefined || w[k] === null) w[k] = base[k];
    });
    if (!w.mon || typeof w.mon !== 'object') {
      w.mon = base.mon;
    } else {
      if (!w.mon.bmc) w.mon.bmc = base.mon.bmc;
      if (!w.mon.rack) w.mon.rack = base.mon.rack;
      if (!w.mon.bill) w.mon.bill = base.mon.bill;
      if (!w.mon.metrics || typeof w.mon.metrics !== 'object') w.mon.metrics = base.mon.metrics;
    }
    return w;
  }

  function banner(world) {
    if (world.kind === 'model') {
      return '已连接到 ' + world.host + '（本关的真实现场，矩阵与 lspci 由题目配置生成）\n输入 help 看命令，回车执行。';
    }
    if (world.kind === 'scene') {
      return '已连接到 ' + world.host + '（本关的现场）\n' +
        (world.mon && world.mon.custom
          ? '本卷有一部分证据在带外与监控里：ipmitool sdr / ipmitool sel list / prom query / bill report。\n'
          : '') +
        '输入 help 看命令，回车执行。';
    }
    return '已连接到 ' + world.host + '\n' +
      '注意：本关没有专属机器现场，下面是参考机型（8 卡 H100）的输出，只能用来对照格式，不是题里的那台。\n' +
      '输入 help 看命令。';
  }

  root.TopoConsole = {
    exec: exec,
    worldFor: worldFor,
    banner: banner,
    referenceWorld: referenceWorld,
    HELP: HELP
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoConsole;
})(typeof globalThis !== 'undefined' ? globalThis : this);
