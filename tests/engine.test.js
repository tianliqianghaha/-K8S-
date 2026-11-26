'use strict';

var assert = require('node:assert/strict');

require('../src/core/rng.js');
var M = require('../src/core/model.js');
var PL = require('../src/core/place.js');
var G = require('../src/core/grade.js');
require('../src/core/registry.js');
var MOD = require('../src/domains/L1/m03_pcie.js');

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

function stage(key) {
  for (var i = 0; i < MOD.stages.length; i++) if (MOD.stages[i].key === key) return MOD.stages[i];
  throw new Error('missing stage ' + key);
}

/* ---------------- 模型 ---------------- */

test('同 seed 复现，不同 seed 不同', function () {
  var a = M.generateMachine(4242, 1);
  var b = M.generateMachine(4242, 1);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  var c = M.generateMachine(4243, 1);
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

test('200 seed x 2 难度，机器全部通过 validateConfig', function () {
  for (var s = 0; s < 200; s++) {
    [1, 2].forEach(function (lv) {
      var m = M.generateMachine(s, lv);
      var v = M.validateConfig(m);
      assert.equal(v.ok, true, 'seed=' + s + ' lv=' + lv + ' ' + v.errors.join('; '));
      var gpus = M.deviceIds(m).filter(function (d) { return m.devices[d].type === 'gpu'; });
      assert.equal(gpus.length, m.meta.gpuCount);
    });
  }
});

test('矩阵对称、对角为 X、无未定项', function () {
  for (var s = 0; s < 120; s++) {
    var m = M.generateMachine(s, s % 2 ? 2 : 1);
    var mx = M.buildMatrix(m);
    mx.ids.forEach(function (a) {
      assert.equal(mx.cells[a][a], 'X');
      mx.ids.forEach(function (b) {
        assert.equal(mx.cells[a][b], mx.cells[b][a], 'asym at ' + a + '/' + b);
        assert.notEqual(mx.cells[a][b], '?', 'unresolved at ' + a + '/' + b);
      });
    });
  }
});

test('清空后只剩对角线 X，其余全是 ?', function () {
  for (var s = 0; s < 60; s++) {
    var m = M.generateMachine(s, 1);
    var blank = M.blankConfig(m);
    var mx = M.buildMatrix(blank);
    mx.ids.forEach(function (a) {
      assert.equal(mx.cells[a][a], 'X');
      mx.ids.forEach(function (b) {
        if (a === b) return;
        assert.equal(mx.cells[a][b], '?', 'blank 应为 ? at ' + a + '/' + b);
      });
    });
  }
});

test('把真相填回 blank，矩阵逐格一致', function () {
  for (var s = 0; s < 120; s++) {
    var m = M.generateMachine(s, s % 2 ? 2 : 1);
    var truth = M.buildMatrix(m);
    var p = M.blankConfig(m);
    Object.keys(m.cpuPlacement).forEach(function (c) { p.cpuPlacement[c] = m.cpuPlacement[c]; });
    Object.keys(m.bridges).forEach(function (b) { p.bridges[b] = m.bridges[b]; });
    Object.keys(m.switches).forEach(function (k) { p.switches[k] = m.switches[k]; });
    Object.keys(m.devices).forEach(function (d) { p.devices[d].parent = m.devices[d].parent; });
    assert.equal(M.compareMatrix(truth, M.buildMatrix(p)).length, 0, 'seed=' + s);
  }
});

test('错放一张卡，差异必须被抓到', function () {
  var m = M.generateMachine(77, 1);
  var truth = M.buildMatrix(m);
  var p = JSON.parse(JSON.stringify(m));
  p.devices.GPU0.parent = p.devices.NIC1.parent;
  var diffs = M.compareMatrix(truth, M.buildMatrix(p));
  assert.ok(diffs.length > 0);
  diffs.forEach(function (d) { assert.notEqual(d.expected, d.actual); });
});

test('七个关系码的判定规则各自成立', function () {
  function cfg(over) {
    var c = {
      cpuPlacement: { CPU0: 0, CPU1: 1 },
      bridges: { B0: 'CPU0', B1: 'CPU1' },
      switches: { S0: 'B0', S1: 'S0' },
      devices: {
        GPU0: { type: 'gpu', parent: 'S1' },
        GPU1: { type: 'gpu', parent: 'S1' },
        NIC0: { type: 'nic', parent: 'S1' },
        NIC1: { type: 'nic', parent: 'S0' },
        NIC2: { type: 'nic', parent: 'B0' },
        NIC3: { type: 'nic', parent: 'B1' }
      },
      nvlink: { enabled: false, links: 0 },
      meta: { gpuCount: 2, cpuCount: 2 }
    };
    if (over) Object.keys(over).forEach(function (k) { c[k] = over[k]; });
    return c;
  }
  var c = cfg();
  assert.equal(M.relation(c, 'GPU0', 'GPU0'), 'X');
  assert.equal(M.relation(c, 'GPU0', 'GPU1'), 'PIX');
  assert.equal(M.relation(c, 'GPU0', 'NIC0'), 'PIX');
  assert.equal(M.relation(c, 'GPU0', 'NIC1'), 'PXB');
  assert.equal(M.relation(c, 'GPU0', 'NIC2'), 'PHB');
  assert.equal(M.relation(c, 'GPU0', 'NIC3'), 'SYS');
  var c2 = cfg({ bridges: { B0: 'CPU0', B1: 'CPU0' } });
  assert.equal(M.relation(c2, 'GPU0', 'NIC3'), 'NODE');

  var c3 = JSON.parse(JSON.stringify(c));
  c3.nvlink.enabled = true;
  c3.nvlink.links = 8;
  assert.equal(M.relation(c3, 'GPU0', 'GPU1'), 'NV8', 'NVLink 优先于 NUMA');
  assert.equal(M.relation(c3, 'GPU0', 'NIC0'), 'PIX', 'NVLink 不影响 GPU 与网卡');
});

/* ---------------- 放置规则 ---------------- */

test('放置规则：类型与层级都要对', function () {
  var c = {
    cpuPlacement: { CPU0: 0, CPU1: 1 },
    bridges: { B0: 'CPU0', B1: 'CPU1' },
    switches: { S0: 'B0', S1: 'S0' },
    devices: {
      GPU0: { type: 'gpu', parent: 'S1' },
      NIC0: { type: 'nic', parent: 'S1' }
    },
    nvlink: { enabled: false, links: 0 },
    meta: { gpuCount: 1, cpuCount: 2 }
  };
  assert.equal(PL.canPlace(c, 'CPU0', { kind: 'cpu', numa: 0 }), true);
  assert.equal(PL.canPlace(c, 'CPU0', { kind: 'under', host: 'B0' }), false, 'CPU 不能进交换区');
  assert.equal(PL.canPlace(c, 'B0', { kind: 'bridges', cpu: 'CPU0' }), true);
  assert.equal(PL.canPlace(c, 'B0', { kind: 'cpu', numa: 0 }), false, '桥不能进 NUMA 槽');
  assert.equal(PL.canPlace(c, 'S0', { kind: 'under', host: 'S1' }), false, '不能挂到自己后代下');
  assert.equal(PL.canPlace(c, 'S0', { kind: 'under', host: 'S0' }), false, '不能挂到自己下');
  assert.equal(PL.canPlace(c, 'GPU0', { kind: 'under', host: 'B1' }), true, '设备可直接挂桥');
  assert.equal(PL.canPlace(c, 'GPU0', { kind: 'cpu', numa: 1 }), false);
  assert.equal(PL.canPlace(c, 'S0', { kind: 'tray' }), false, '有子的交换芯片不能直接回托盘');
});

test('applyPlace 真的改动配置，且返回是否变化', function () {
  var m = M.generateMachine(9, 1);
  var p = M.blankConfig(m);
  assert.equal(PL.applyPlace(p, 'CPU0', { kind: 'cpu', numa: 0 }), true);
  assert.equal(p.cpuPlacement.CPU0, 0);
  assert.equal(PL.applyPlace(p, 'CPU0', { kind: 'cpu', numa: 0 }), false, '原位放置不算变化');
  assert.equal(PL.applyPlace(p, 'B0', { kind: 'bridges', cpu: 'CPU0' }), true);
  assert.equal(p.bridges.B0, 'CPU0');
  assert.equal(PL.applyPlace(p, 'CPU0', { kind: 'tray' }), true);
  assert.equal(p.cpuPlacement.CPU0, null);
});

test('子节点跟着父节点搬，且能清空', function () {
  var c = {
    cpuPlacement: { CPU0: 0, CPU1: 1 },
    bridges: { B0: 'CPU0' },
    switches: { S0: 'B0' },
    devices: { GPU0: { type: 'gpu', parent: 'S0' } },
    nvlink: { enabled: false, links: 0 },
    meta: { gpuCount: 1, cpuCount: 2 }
  };
  assert.equal(PL.applyPlace(c, 'B0', { kind: 'bridges', cpu: 'CPU1' }), true);
  assert.equal(c.bridges.B0, 'CPU1');
  assert.equal(M.derivePath(c, 'GPU0').numa, 1, '桥换路，子设备跟着换 NUMA');
});

/* ---------------- s1 还原 ---------------- */

test('s1：每题都可解，且解完差异为 0', function () {
  var st = stage('s1');
  for (var s = 0; s < 40; s++) {
    [false, true].forEach(function (hard) {
      var scen = st.generate(s, { hard: hard });
      var ans = st.solve(scen);
      var res = st.judge(scen, ans);
      assert.equal(res.ok, true, 'seed=' + s + ' hard=' + hard + ' ' + res.head);
      assert.equal(res.diffs.length, 0);
    });
  }
});

test('s1：空盘提交必须不过，且给出中文归因', function () {
  var st = stage('s1');
  var scen = st.generate(5, { hard: false });
  var res = st.judge(scen, { config: scen.player });
  assert.equal(res.ok, false);
  assert.ok(res.head.indexOf('对不上') >= 0);
  assert.ok(res.items.length > 0);
  assert.ok(res.items[0].text.indexOf('差在') >= 0, '必须说清差在哪一层');
});

test('s1：题面含图例与全部设备 id', function () {
  var st = stage('s1');
  var scen = st.generate(11, { hard: true });
  assert.ok(scen.topo.indexOf('Legend:') >= 0);
  assert.ok(scen.topo.indexOf('SYS  = Connection traversing') >= 0);
  Object.keys(scen.machine.devices).forEach(function (d) {
    assert.ok(scen.topo.indexOf(d) >= 0, '题面缺 ' + d);
  });
  assert.ok(scen.lscpu.indexOf('NUMA node(s)') >= 0);
  assert.ok(scen.lscpu.indexOf('Socket(s)') >= 0);
});

test('题面真实度：topo 带 CPU / NUMA Affinity 两列，核数随机型', function () {
  var st = stage('s1');
  [[false, 32, 64], [true, 48, 96]].forEach(function (row) {
    var scen = st.generate(21, { hard: row[0] });
    assert.ok(scen.topo.indexOf('CPU Affinity') >= 0, '缺 CPU Affinity 列');
    assert.ok(scen.topo.indexOf('NUMA Affinity') >= 0, '缺 NUMA Affinity 列');
    assert.ok(scen.topo.indexOf('0-' + (row[1] - 1)) >= 0, 'CPU Affinity 与每路核数不符');
    assert.ok(scen.lscpu.indexOf('CPU(s):                ' + row[2]) >= 0, 'lscpu 总核数不对');
    assert.ok(scen.lscpu.indexOf('Core(s) per socket:    ' + row[1]) >= 0);
    /* 每张卡都要有一行 Affinity，不能出现 '?' */
    var body = scen.topo.split('Legend:')[0].trim().split('\n').slice(1);
    body.forEach(function (line) {
      assert.ok(line.indexOf('?') < 0, 'Affinity 出现未定值：' + line);
    });
  });
});

test('口径一致：跨 NUMA 的 P2P 带宽在计算题与诊断题里是同一个量级', function () {
  var st2 = stage('s2');
  var st3 = stage('s3');
  var calcSeen = false;
  for (var s = 0; s < 60; s++) {
    var c = st2.generate(s);
    if (c.kind === 2) {
      calcSeen = true;
      assert.ok(c.question.indexOf('12 GB/s') >= 0, '计算题的跨 NUMA 带宽口径变了');
    }
  }
  assert.ok(calcSeen, '没抽到跨 NUMA 计算题');
  var case1 = null;
  for (var t = 0; t < 60 && !case1; t++) {
    var d = st3.generate(t);
    if (d.key === 'sys') case1 = d;
  }
  assert.ok(case1, '没抽到跨 NUMA 诊断题');
  var nums = (case1.p2p.match(/\d+\.\d+/g) || []).map(Number).filter(function (n) { return n > 8 && n < 16; });
  assert.ok(nums.length > 0, '诊断题里没有跨 NUMA 量级的实测值');
  nums.forEach(function (n) {
    assert.ok(Math.abs(n - 12) < 1, '诊断题跨 NUMA 值与 12 GB/s 口径不一致：' + n);
  });
});

test('s1：零件数量与题面一致，且托盘初始全满', function () {
  var st = stage('s1');
  var scen = st.generate(3, { hard: false });
  var parts = M.allParts(scen.machine);
  assert.equal(parts.length, 2 + 2 + 2 + 4 + 2, '4 卡机型应有 12 个零件');
  assert.equal(PL.countPlaced(scen.player), 0);
});

test('s1：提示三层逐级更具体', function () {
  var st = stage('s1');
  var scen = st.generate(8, { hard: false });
  var ans = { config: scen.player };
  var h0 = st.hint(scen, ans, 0);
  var h1 = st.hint(scen, ans, 1);
  var h2 = st.hint(scen, ans, 2);
  assert.ok(h0.indexOf('lscpu') >= 0);
  assert.ok(h1.indexOf('这一对') >= 0);
  assert.ok(h2.indexOf('直说') >= 0 && h2.indexOf('桥') >= 0, '第三层要直接指到具体层级');
  assert.ok(h1.indexOf('直说') < 0, '第二层不能直接给答案');
});

/* ---------------- s2 计算 ---------------- */

test('s2：三种模板各 60 个 seed，标准答案与公式一致', function () {
  var st = stage('s2');
  var seen = {};
  for (var s = 0; s < 60; s++) {
    var scen = st.generate(s);
    seen[scen.kind] = 1;
    var expect = scen.kind === 0 ? scen.size / 32 * 1000
      : scen.kind === 1 ? scen.size / 16 * 1000
        : (scen.size / 12 - scen.size / 32) * 1000;
    assert.ok(Math.abs(scen.expected - expect) < 1e-9, 'seed=' + s);
    assert.equal(st.judge(scen, { t: G.round(scen.expected, 1) }).ok, true, 'seed=' + s);
  }
  assert.deepEqual(Object.keys(seen).sort(), ['0', '1', '2'], '三种模板都要出现');
});

test('s2：双向口径错误会被指出来', function () {
  var st = stage('s2');
  for (var s = 0; s < 40; s++) {
    var scen = st.generate(s);
    var res = st.judge(scen, { t: G.round(scen.expected / 2, 1) });
    if (scen.kind === 1) continue;
    assert.equal(res.ok, false);
    var text = res.items.map(function (i) { return i.title + i.text; }).join('');
    assert.ok(text.indexOf('一半') >= 0 || text.indexOf('两倍') >= 0, 'seed=' + s + ' 缺少口径提示');
  }
});

test('s2：空输入不崩，判不过', function () {
  var st = stage('s2');
  var scen = st.generate(1);
  var res = st.judge(scen, { t: NaN });
  assert.equal(res.ok, false);
  assert.ok(res.head.length > 0);
});

/* ---------------- s3 诊断 ---------------- */

test('s3：四种案情都会被抽到，且正确答案可判过', function () {
  var st = stage('s3');
  var seen = {};
  for (var s = 0; s < 60; s++) {
    var scen = st.generate(s);
    seen[scen.key] = 1;
    assert.equal(scen.options.length, 4);
    assert.equal(st.judge(scen, { pick: scen.answer }).ok, true, 'seed=' + s);
    for (var i = 0; i < 4; i++) {
      if (i === scen.answer) continue;
      var r = st.judge(scen, { pick: i });
      assert.equal(r.ok, false);
      assert.ok(r.items.length >= 2, '选错必须同时给出正确答案');
    }
  }
  assert.equal(Object.keys(seen).length, 4, '四种案情都要覆盖');
});

test('s3：每个选项都带解析，不许有空解释', function () {
  var st = stage('s3');
  for (var s = 0; s < 20; s++) {
    var scen = st.generate(s);
    scen.options.forEach(function (o) {
      assert.ok(o.why && o.why.length > 10, '选项缺解析');
      assert.ok(o.label.length > 4);
    });
  }
});

/* ---------------- s4 决策 ---------------- */

test('s4：最优代价恒为 0，方案梯度符合预期', function () {
  var st = stage('s4');
  for (var s = 0; s < 50; s++) {
    var scen = st.generate(s);
    assert.equal(scen.best, 0, 'seed=' + s);
    var pens = scen.options.map(function (o) { return o.penalty; }).sort(function (a, b) { return a - b; });
    assert.deepEqual(pens, [0, 4, 16, 24], 'seed=' + s + ' 方案梯度不对：' + pens.join(','));
  }
});

test('s4：最优满分，次优半分，最差零分', function () {
  var st = stage('s4');
  var scen = st.generate(3);
  assert.equal(st.judge(scen, { pick: scen.answer }).score, 1);

  var sub = -1, worst = -1;
  scen.options.forEach(function (o, i) {
    if (o.penalty === 4) sub = i;
    if (o.penalty === 24) worst = i;
  });
  var rSub = st.judge(scen, { pick: sub });
  assert.equal(rSub.score, 0.5);
  assert.equal(rSub.ok, true, '次优算通过');
  assert.ok(rSub.head.indexOf('次优') >= 0);

  var rWorst = st.judge(scen, { pick: worst });
  assert.equal(rWorst.score, 0);
  assert.equal(rWorst.ok, false);
  assert.ok(rWorst.items.some(function (i) { return i.title.indexOf('最优方案') >= 0; }));
});

test('s4：换 seed 会打乱选项顺序', function () {
  var st = stage('s4');
  var orders = {};
  for (var s = 0; s < 40; s++) orders[st.generate(s).order.join('')] = 1;
  assert.ok(Object.keys(orders).length > 2, '选项顺序不应固定');
});

/* ---------------- 模块契约 ---------------- */

test('模块契约完整：4 个 stage、四种题型、知识卡与小测齐全', function () {
  assert.equal(MOD.id, 'M03');
  assert.equal(MOD.plane, 'L1');
  assert.deepEqual(MOD.atoms, ['A', 'C', 'B', 'D']);
  assert.equal(MOD.stages.length, 4);
  var atoms = MOD.stages.map(function (s) { return s.atom; }).sort().join('');
  assert.equal(atoms, 'ABCD');
  MOD.stages.forEach(function (s) {
    assert.ok(s.generate && s.judge && s.hint && s.side && s.solve && s.renderSpec, s.key + ' 契约不全');
    assert.ok(s.renderer === s.renderSpec(s.generate(1)).renderer);
  });
  assert.ok(MOD.knowledge.concept.length > 20);
  assert.equal(MOD.knowledge.pitfalls.length, 3);
  var quiz = MOD.quiz(7);
  assert.equal(quiz.length, 3);
  quiz.forEach(function (q) {
    assert.equal(q.options.length, 4);
    assert.ok(q.answer >= 0 && q.answer < 4);
    assert.ok(q.why.length > 5);
  });
});

test('注册表能查到 M03，其余模块保持未开放', function () {
  var REG = require('../src/core/registry.js');
  assert.ok(REG.get('M03'));
  assert.equal(REG.isOpen('M04'), false);
  assert.equal(REG.CATALOG.length, 28);
});

console.log('PASS ' + passed + ' / ' + cases);
if (failed.length) {
  failed.forEach(function (f) { console.error('FAIL ' + f); });
  process.exit(1);
}
