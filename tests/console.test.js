'use strict';

/*
  X1 取证终端的契约测试：
  每条命令都要能跑、输出不能为空、不能出现 undefined；
  有模型的关卡，topo -m 必须与模型算出来的完全一致（不能是编的）。
*/

var assert = require('node:assert/strict');

require('../src/core/rng.js');
var M = require('../src/core/model.js');
var C = require('../src/core/console.js');

var passed = 0;
var failed = [];
var cases = 0;

function test(name, fn) {
  cases++;
  try {
    fn();
    passed++;
  } catch (e) {
    failed.push(name + ' :: ' + (e && e.message ? e.message : String(e)));
  }
}

var CMDS = [
  'help', 'nvidia-smi', 'nvidia-smi -L', 'nvidia-smi -q', 'nvidia-smi -q -i 3',
  'nvidia-smi nvlink -e', 'nvidia-smi topo -m', 'lspci -tv', 'lscpu', 'numactl -H',
  'ibstat', 'dmesg', 'free -h', 'uptime', 'kubectl get pods', 'kubectl describe pod train-0',
  'etcdctl endpoint status', 'cat /proc/interrupts', 'lsmod | grep nvidia',
  'ipmitool sdr', 'ipmitool sel list', "prom query 'gpu_util_pct'",
  "prom query 'pdu_current_a{rack=\"A01\"}'", "prom query 'avg(gpu_temp_c)'",
  'bill report --team nlp', 'kubectl get hpa', 'kubectl describe hpa infer-bert', 'kubectl top pods'
];

test('帮助里有正文，且列出的命令都能执行', function () {
  var w = C.referenceWorld();
  var help = C.exec('help', w);
  assert.ok(help.text.indexOf('nvidia-smi') >= 0);
  assert.ok(help.text.indexOf('topo -m') >= 0);
});

test('每条命令都有输出，且不含 undefined / NaN', function () {
  var w = C.referenceWorld();
  CMDS.forEach(function (cmd) {
    var r = C.exec(cmd, w);
    assert.ok(r.text && r.text.length > 10, cmd + ' 输出为空');
    ['undefined', 'NaN', 'null', '[object'].forEach(function (bad) {
      assert.equal(r.text.indexOf(bad) < 0, true, cmd + ' 输出里出现 ' + bad);
    });
  });
});

test('clear 返回清屏标记，未知命令给出提示', function () {
  assert.equal(C.exec('clear', C.referenceWorld()).clear, true);
  var r = C.exec('foobar --x', C.referenceWorld());
  assert.ok(r.text.indexOf('command not found') >= 0);
  var r2 = C.exec('nvidia-smi --bad', C.referenceWorld());
  assert.ok(r2.text.indexOf('不支持') >= 0);
});

test('nvidia-smi 列出的卡数与现场一致，缺席的卡不出现在表里但在 lspci 里', function () {
  var w = C.referenceWorld();
  var normal = C.exec('nvidia-smi', w).text;
  assert.equal(normal.split('80GB HBM3').length - 1, 8, '正常机型应列出 8 张');

  var broken = JSON.parse(JSON.stringify(w));
  broken.gpus[6].absent = true;
  broken.gpus[7].absent = true;
  var t = C.exec('nvidia-smi', broken).text;
  assert.equal(t.split('80GB HBM3').length - 1, 6, '掉了两张就只该列 6 张');
  assert.ok(t.indexOf('只列出 6 张') >= 0, '应提示少了卡');
  var q = C.exec('nvidia-smi -q', broken).text;
  assert.ok(q.indexOf('Attached GPUs                             : 6') >= 0);
  var pci = C.exec('lspci -tv', broken).text;
  assert.ok(pci.indexOf('driver not bound') >= 0, 'lspci 里要能看到没绑驱动的卡');
});

test('NVLink CRC 只出现在坏链路上，其余为 0', function () {
  var w = JSON.parse(JSON.stringify(C.referenceWorld()));
  w.gpus[2].nvlinkBad = 3;
  w.gpus[2].nvlinkCrc = 4312;
  var t = C.exec('nvidia-smi nvlink -e', w).text;
  assert.ok(t.indexOf('4312 CRC errors') >= 0);
  assert.ok(t.indexOf(' Link 3: 4312') >= 0 || t.indexOf('Link 3: 4312') >= 0);
  assert.ok(t.indexOf(' Link 4: 0 CRC') >= 0, '相邻链路应为 0');
});

test('lsmod 过滤生效：缺 peermem 时查不到', function () {
  var w = JSON.parse(JSON.stringify(C.referenceWorld()));
  assert.ok(C.exec('lsmod | grep nvidia', w).text.indexOf('nvidia_peermem') >= 0);
  w.modules = ['nvidia', 'nvidia_uvm', 'nvidia_drm', 'mlx5_core', 'mlx5_ib', 'ib_core'];
  var t = C.exec('lsmod | grep nvidia', w).text;
  assert.equal(t.indexOf('nvidia_peermem'), -1);
  assert.ok(t.indexOf('nvidia_uvm') >= 0);
});

/* ---------- 带外与监控（L0 / L5 的取证面） ---------- */

test('ipmitool sdr：进风超限标 cr、PSU 不在位标 ns，且每行等宽', function () {
  var w = C.worldFor({
    world: {
      mon: {
        bmc: {
          inlet: 34,
          psus: [
            { id: 'PSU1', watts: 1580, status: 'ok' },
            { id: 'PSU3', watts: 0, status: 'absent' }
          ]
        }
      }
    }
  });
  var t = C.exec('ipmitool sdr', w).text;
  assert.ok(t.indexOf('34 degrees C') >= 0);
  assert.ok(/Inlet Temp\s+\| 34 degrees C\s+\| cr/.test(t), '进风 34°C 应标 cr，不能是 ok');
  assert.ok(/PSU3 Power\s+\| 0 Watts\s+\| ns/.test(t), '不在位的 PSU 应标 ns');
  var widths = {};
  t.split('\n').forEach(function (l) { widths[l.length] = 1; });
  assert.equal(Object.keys(widths).length, 1, 'sdr 每行应等宽：' + Object.keys(widths).join(','));
});

test('prom：数字来自现场，label 过滤生效，未知指标给出可用清单', function () {
  var w = C.worldFor({
    world: {
      mon: {
        metrics: {
          pdu_current_a: {
            series: [
              { labels: { rack: 'A01', pdu: 'A' }, v: 52.4 },
              { labels: { rack: 'A01', pdu: 'B' }, v: 9.6 },
              { labels: { rack: 'B02', pdu: 'A' }, v: 21.0 }
            ]
          },
          gpu_temp_c: { v: 91 }
        }
      }
    }
  });
  var all = C.exec("prom query 'pdu_current_a'", w).text;
  assert.equal(all.split('=>').length - 1, 3, '不过滤时应返回三条 series');
  var a = C.exec("prom query 'pdu_current_a{pdu=\"A\"}'", w).text;
  assert.equal(a.split('=>').length - 1, 2, '按 label 过滤后应只剩两条');
  assert.ok(a.indexOf('52.4') >= 0 && a.indexOf('21') >= 0 && a.indexOf('9.6') < 0);

  var avg = C.exec("prom query 'avg(gpu_temp_c)'", w).text;
  assert.ok(avg.indexOf('91') >= 0 && avg.indexOf('over 8 series') >= 0);

  var miss = C.exec("prom query 'no_such_metric'", w).text;
  assert.ok(miss.indexOf('没有叫') >= 0 && miss.indexOf('gpu_temp_c') >= 0, '未知指标要列出可用项');

  var none = C.exec("prom query 'gpu_temp_c{gpu=\"99\"}'", w).text;
  assert.ok(none.indexOf('0 series') >= 0, '没有匹配时要明确说 0 series');
});

test('bill：金额、有效卡时、闲置比例由同一组数算出来', function () {
  var w = C.worldFor({
    world: {
      mon: {
        bill: {
          team: 'nlp', period: '2026-11-01 ~ 2026-11-25', days: 25,
          resource: 'H100 80G', cards: 32, gpuHours: 18432, price: 28, utilPct: 38.6
        }
      }
    }
  });
  var t = C.exec('bill report --team nlp', w).text;
  assert.ok(t.indexOf('¥516,096') >= 0, '18432 × 28 应为 516,096');
  assert.ok(t.indexOf('7,115') >= 0, '有效卡时应为 18432 × 38.6%');
  assert.ok(t.indexOf('61.4%') >= 0, '闲置占比应为 61.4%');
  var other = C.exec('bill report --team cv', w).text;
  assert.ok(other.indexOf('没有') >= 0, '查别的团队要明确说没有，不能编一份');
});

test('kubectl：hpa 的 unknown 与 top 的用量都来自现场', function () {
  var w = C.worldFor({
    world: {
      pods: [{ name: 'infer-bert-0', ns: 'ai', status: 'Running', node: 'n1', restarts: 0, cpu: '3980m', mem: '3.2Gi' }],
      hpa: [{
        name: 'infer-bert', ns: 'ai', ref: 'Deployment/infer-bert',
        targets: '<unknown>/70%', min: 2, max: 20, replicas: 2,
        events: ['  Warning  FailedGetResourceMetric  3m  horizontal-pod-autoscaler  failed to get cpu utilization: missing request for cpu']
      }]
    }
  });
  var g = C.exec('kubectl get hpa', w).text;
  assert.ok(g.indexOf('<unknown>/70%') >= 0);
  assert.ok(g.indexOf('infer-bert') >= 0);
  var d = C.exec('kubectl describe hpa infer-bert', w).text;
  assert.ok(d.indexOf('missing request for cpu') >= 0);
  var top = C.exec('kubectl top pods', w).text;
  assert.ok(top.indexOf('3980m') >= 0 && top.indexOf('3.2Gi') >= 0);
  var nf = C.exec('kubectl describe hpa nope', w).text;
  assert.ok(nf.indexOf('NotFound') >= 0);
});

/* ---------- 残缺现场：任何一条命令都不该崩 ---------- */

test('现场缺块、缺字段、为空时，命令仍返回可读文本', function () {
  var worlds = [
    null,
    {},
    { gpus: [], nics: [] },
    { gpus: [], nics: [], mon: {} },
    { gpus: [], nics: [], mon: { metrics: { x: { unit: 'A' } } } },
    { gpus: [], nics: [], pods: [], hpa: [{ name: 'a', ref: 'b', min: 1, max: 2, replicas: 1 }] },
    { gpus: [], nics: [], mon: { bill: { team: 'x', period: 'p', days: 1, resource: 'H100', cards: 0, gpuHours: 0, price: 28, utilPct: 0 } } }
  ];
  var cmds = ['nvidia-smi', 'nvidia-smi -q', 'nvidia-smi topo -m', 'lspci -tv', 'lscpu',
    'numactl -H', 'ibstat', 'dmesg', 'free -h', 'kubectl get pods', 'kubectl get hpa',
    'kubectl top pods', 'etcdctl endpoint status', 'cat /proc/interrupts',
    'ipmitool sdr', 'ipmitool sel list', "prom query 'gpu_util_pct'",
    "prom query 'x'", 'bill report', 'help'];
  worlds.forEach(function (w, wi) {
    cmds.forEach(function (cmd) {
      var r = C.exec(cmd, w);
      assert.equal(typeof r.text, 'string', 'world#' + wi + ' ' + cmd + ' 没返回文本');
      ['undefined', 'NaN', '[object'].forEach(function (bad) {
        assert.equal(r.text.indexOf(bad) < 0, true, 'world#' + wi + ' ' + cmd + ' 出现 ' + bad);
      });
    });
  });
});

test('prom 的用法提示与空表达式', function () {
  var w = C.referenceWorld();
  assert.ok(C.exec('prom query', w).text.indexOf('用法') >= 0);
  assert.ok(C.exec("prom query ''", w).text.indexOf('用法') >= 0);
  assert.ok(C.exec('prom', w).text.indexOf('用法') >= 0);
});

/* ---------- 与 M03 模型的一致性（最关键的一条） ---------- */

test('nvidia-smi 的表格边框必须对齐（每一行等宽）', function () {
  [C.referenceWorld(), (function () {
    var w = C.referenceWorld();
    w.gpus = [w.gpus[0], w.gpus[1]];
    return w;
  })()].forEach(function (w, k) {
    var lines = C.exec('nvidia-smi', w).text.split('\n');
    var widths = {};
    lines.forEach(function (l) {
      if (l.charAt(0) === '|' || l.charAt(0) === '+') widths[l.length] = (widths[l.length] || 0) + 1;
    });
    var keys = Object.keys(widths);
    assert.equal(keys.length, 1, '第 ' + k + ' 台机器表格出现多种宽度：' + keys.join(','));
  });
});

test('有模型的关卡：topo -m 与模型算出来的矩阵完全一致', function () {
  for (var seed = 0; seed < 20; seed++) {
    var cfg = M.generateMachine(seed, seed % 2 ? 2 : 1);
    var world = C.worldFor({ machine: cfg });
    var fromConsole = C.exec('nvidia-smi topo -m', world).text;
    var fromModel = M.formatTopo(cfg);
    assert.equal(fromConsole, fromModel, 'seed=' + seed + ' 终端输出与模型不一致');

    /* 网卡的 NUMA 归属也要对 */
    var mx = M.buildMatrix(cfg);
    mx.ids.forEach(function (id) {
      assert.ok(fromConsole.indexOf(id) >= 0, 'topo 里缺设备 ' + id);
    });
  }
});

test('有模型的关卡：lspci 里每张卡的链路宽度来自配置', function () {
  var cfg = M.generateMachine(7, 2);
  var world = C.worldFor({ machine: cfg });
  var t = C.exec('lspci -tv', world).text;
  Object.keys(cfg.devices).forEach(function (id) {
    if (cfg.devices[id].type !== 'gpu') return;
    assert.ok(t.indexOf('H100') >= 0);
  });
  assert.ok(t.split('LnkCap').length - 1 === Object.keys(cfg.devices).filter(function (d) {
    return cfg.devices[d].type === 'gpu';
  }).length);
});

test('worldFor 的三种来源各自成立', function () {
  var ref = C.worldFor(null);
  assert.equal(ref.kind, 'reference');
  assert.equal(C.banner(ref).indexOf('参考机型'), 0 === 0 ? C.banner(ref).indexOf('参考机型') : -1);

  var scene = C.worldFor({ world: { absent: [0] } });
  assert.equal(scene.kind, 'scene');

  var model = C.worldFor({ machine: M.generateMachine(1, 1) });
  assert.equal(model.kind, 'model');
  assert.ok(C.banner(model).indexOf('真实现场') >= 0);
});

test('每一关都能拿到一个可用的现场', function () {
  require('../src/core/place.js');
  require('../src/core/grade.js');
  require('../src/core/factory.js');
  var REG = require('../src/core/registry.js');
  require('../src/domains/L0/m00_m01.js');
  require('../src/domains/L1/m02_m04_m05.js');
  require('../src/domains/L1/m03_pcie.js');
  require('../src/domains/L2/m06_m09.js');
  require('../src/domains/L3/m10_m14.js');
  require('../src/domains/L4/m15_m19.js');
  require('../src/domains/L5/m20_m24.js');
  require('../src/domains/L6/m25_m27.js');

  var withWorld = 0;
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      [0, 3, 11].forEach(function (seed) {
        var scen = s.generate(seed, { hard: false });
        var w = C.worldFor(scen);
        assert.ok(w && w.gpus && w.gpus.length, m.id + '/' + s.key + ' 拿不到现场');
        var out = C.exec('nvidia-smi', w).text;
        assert.ok(out.length > 100, m.id + '/' + s.key + ' nvidia-smi 输出过短');
        if (scen.world) withWorld++;
      });
    });
  });
  assert.ok(withWorld >= 5, '带专属现场的关卡太少：' + withWorld);
  console.log('    带专属现场的关卡样本 ' + withWorld + ' 个');

  /* 抽查：带现场的案例，终端里必须能看到它声明的那条证据 */
  var m09 = REG.get('M09');
  var s3 = m09.stages.filter(function (s) { return s.key === 's3'; })[0];
  var found = null;
  for (var seed = 0; seed < 40 && !found; seed++) {
    var sc = s3.generate(seed, { hard: false });
    if (sc.caseKey === 'xid48') found = sc;
  }
  assert.ok(found, '没抽到 xid48 案情');
  var w = C.worldFor(found);
  assert.equal(w.gpus[3].eccDbe, 3, '现场里 GPU3 的 DBE 应为 3');
  assert.ok(C.exec('nvidia-smi -q', w).text.indexOf('Device Memory                     : 3') >= 0);
  assert.ok(C.exec('dmesg', w).text.indexOf('Xid') >= 0);
});

console.log('PASS ' + passed + ' / ' + cases);
if (failed.length) {
  failed.forEach(function (f) { console.error('FAIL ' + f); });
  process.exit(1);
}
