'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var E = require('../engine.js');

var passed = 0;
var failed = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed.push(name + ': ' + (e && e.message ? e.message : String(e)));
  }
}

function minimalConfig(nvlink) {
  return {
    seed: 1,
    level: 1,
    cpuPlacement: { CPU0: 0, CPU1: 1 },
    bridges: { B0: 'CPU0', B1: 'CPU1' },
    switches: { S0: 'B0' },
    devices: {
      GPU0: { type: 'gpu', parent: 'S0' },
      GPU1: { type: 'gpu', parent: 'S0' },
      NIC0: { type: 'nic', parent: 'S0' },
      NIC1: { type: 'nic', parent: 'B1' }
    },
    nvlink: { enabled: !!nvlink, links: 8 },
    meta: { gpuCount: 2, cpuCount: 2, nicMode: 'pix', level: 1 }
  };
}

test('engine selfTest over 200 seeds and 3 levels', function () {
  var r = E.selfTest(200);
  assert.equal(r.ok, true, r.failures.join(' | '));
  assert.equal(r.count, 600);
});

test('generator obeys physical constraints for 600 machines', function () {
  for (var seed = 0; seed < 200; seed++) {
    [1, 2, 3].forEach(function (level) {
      var m = E.generateMachine(seed, level);
      var check = E.validateConfig(m);
      assert.equal(check.ok, true, 'seed=' + seed + ' level=' + level + ' ' + check.errors.join(';'));
      var gpus = E.deviceIds(m).filter(function (d) { return m.devices[d].type === 'gpu'; });
      assert.equal(gpus.length, m.meta.gpuCount);
      assert.equal(Object.keys(m.cpuPlacement).length, m.meta.cpuCount);
    });
  }
});

test('same seed reproduces identical machine', function () {
  var a = E.generateMachine(424242, 1);
  var b = E.generateMachine(424242, 1);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(E.generateMachine(424243, 1)));
});

test('matrix is symmetric and self relation is X', function () {
  for (var seed = 0; seed < 60; seed++) {
    var m = E.generateMachine(seed, 1);
    var mx = E.buildMatrix(m);
    mx.ids.forEach(function (a) {
      assert.equal(mx.cells[a][a], 'X');
      mx.ids.forEach(function (b) { assert.equal(mx.cells[a][b], mx.cells[b][a]); });
    });
  }
});

test('PIX NODE SYS relation rules', function () {
  var c = minimalConfig(false);
  assert.equal(E.relation(c, 'GPU0', 'NIC0'), 'PIX');
  assert.equal(E.relation(c, 'GPU0', 'GPU1'), 'PIX');
  assert.equal(E.relation(c, 'GPU0', 'NIC1'), 'SYS');
  c.bridges.B1 = 'CPU0';
  assert.equal(E.relation(c, 'GPU0', 'NIC1'), 'NODE');
});

test('PXB rule when two switches under one bridge', function () {
  var c = minimalConfig(false);
  c.switches.S0x = 'B0';
  c.devices.NIC0.parent = 'S0x';
  assert.equal(E.relation(c, 'GPU0', 'NIC0'), 'PXB');
});

test('PHB rule when device hangs directly on bridge', function () {
  var c = minimalConfig(false);
  c.devices.NIC0.parent = 'B0';
  assert.equal(E.relation(c, 'GPU0', 'NIC0'), 'PHB');
});

test('NVLink overrides CPU distance', function () {
  var c = minimalConfig(true);
  assert.equal(E.relation(c, 'GPU0', 'GPU1'), 'NV8');
  assert.equal(E.relation(c, 'GPU0', 'NIC1'), 'SYS');
});

test('blank config yields unknown relations but valid X diagonal', function () {
  var m = E.generateMachine(1234, 1);
  var blank = E.blankConfig(m);
  var mx = E.buildMatrix(blank);
    mx.ids.forEach(function (a) {
      assert.equal(mx.cells[a][a], 'X');
      mx.ids.forEach(function (b) {
        if (a === b) return;
        var bothGpu = m.devices[a].type === 'gpu' && m.devices[b].type === 'gpu';
        var expected = bothGpu && m.nvlink.enabled ? 'NV' + m.nvlink.links : '?';
        assert.equal(mx.cells[a][b], expected);
      });
    });
});

test('rebuilding truth from blank matches original matrix exactly', function () {
  for (var seed = 0; seed < 120; seed++) {
    var m = E.generateMachine(seed, 1);
    var truth = E.buildMatrix(m);
    var blank = E.blankConfig(m);
    Object.keys(m.cpuPlacement).forEach(function (c) { blank.cpuPlacement[c] = m.cpuPlacement[c]; });
    Object.keys(m.bridges).forEach(function (b) { blank.bridges[b] = m.bridges[b]; });
    Object.keys(m.switches).forEach(function (s) { blank.switches[s] = m.switches[s]; });
    Object.keys(m.devices).forEach(function (d) { blank.devices[d].parent = m.devices[d].parent; });
    var rebuilt = E.buildMatrix(blank);
    assert.equal(E.compareMatrix(truth, rebuilt).length, 0, 'seed=' + seed);
  }
});

test('misplacing one device is detected', function () {
  var m = E.generateMachine(77, 1);
  var truth = E.buildMatrix(m);
  var wrong = E.blankConfig(m);
  Object.keys(m.cpuPlacement).forEach(function (c) { wrong.cpuPlacement[c] = m.cpuPlacement[c]; });
  Object.keys(m.bridges).forEach(function (b) { wrong.bridges[b] = m.bridges[b]; });
  Object.keys(m.switches).forEach(function (s) { wrong.switches[s] = m.switches[s]; });
  Object.keys(m.devices).forEach(function (d) { wrong.devices[d].parent = m.devices[d].parent; });
  var gpu0 = wrong.devices.GPU0.parent;
  wrong.devices.GPU0.parent = wrong.devices.NIC1.parent;
  var diffs = E.compareMatrix(truth, E.buildMatrix(wrong));
  assert.ok(diffs.length > 0);
  assert.ok(diffs.every(function (d) { return d.expected !== d.actual; }));
  wrong.devices.GPU0.parent = gpu0;
  assert.equal(E.compareMatrix(truth, E.buildMatrix(wrong)).length, 0);
});

test('command output contains required fields', function () {
  var m = E.generateMachine(9, 1);
  var topo = E.formatTopo(m);
  assert.ok(topo.indexOf('GPU0') >= 0 && topo.indexOf('NIC0') >= 0);
  assert.ok(topo.indexOf('CPU Affinity') >= 0 && topo.split('\n').length >= 4);
  var lscpu = E.formatLscpu(m);
  assert.ok(lscpu.indexOf('NUMA node(s)') >= 0 && lscpu.indexOf('Socket(s)') >= 0);
  var smi = E.formatNvidiaSmi(m);
  assert.ok(smi.indexOf('H800') >= 0 && smi.indexOf('700W') >= 0 && smi.indexOf('81920MiB') >= 0);
});

test('quiz answers are valid and rationales present', function () {
  for (var seed = 0; seed < 50; seed++) {
    var quiz = E.generateQuiz(seed, 2);
    assert.equal(quiz.length, 2);
    quiz.forEach(function (q) {
      assert.equal(q.options.length, 4);
      assert.ok(q.answer >= 0 && q.answer <= 3);
      assert.ok(q.why && q.why.length > 0);
    });
  }
});

test('game HTML and UI wiring exist', function () {
  var dir = path.join(__dirname, '..');
  var html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  ['cmd-output', 'board', 'tray', 'player-topo', 'btn-submit', 'btn-new', 'btn-hint', 'quiz'].forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') >= 0, 'missing element ' + id);
  });
  assert.ok(html.indexOf('src="engine.js"') >= 0 && html.indexOf('src="ui.js"') >= 0);
  var ui = fs.readFileSync(path.join(dir, 'ui.js'), 'utf8');
  assert.ok(ui.indexOf('__gameTest') >= 0 && ui.indexOf('solve:') >= 0);
  assert.ok(ui.indexOf('canDrop') >= 0 && ui.indexOf('compareMatrix') >= 0);
});

test('all L1 seeds offer at least one solvable path', function () {
  for (var seed = 0; seed < 200; seed++) {
    var m = E.generateMachine(seed, 1);
    var blank = E.blankConfig(m);
    var ids = E.deviceIds(m);
    ids.forEach(function (d) {
      var path = E.derivePath(m, d);
      assert.ok(path.numa !== null, 'truth path missing for ' + d);
    });
    assert.ok(Object.keys(blank.devices).length === ids.length);
  }
});

test('L2 scenario builds two valid machines with affinity bindings', function () {
  for (var seed = 0; seed < 80; seed++) {
    var sc = E.generateScenario(seed, 2);
    assert.equal(sc.level, 2);
    assert.equal(sc.machines.length, 2);
    assert.equal(sc.bindings.length, 2);
    assert.equal(sc.puzzles.length, 2);
    sc.machines.forEach(function (m) {
      assert.equal(E.validateConfig(m).ok, true);
      assert.equal(m.meta.gpuCount, 8);
      assert.equal(m.meta.cpuCount, 2);
    });
    sc.bindings.forEach(function (b) {
      assert.equal(b.GPU0, 'NIC0');
      assert.equal(b.GPU3, 'NIC0');
      assert.equal(b.GPU4, 'NIC1');
      assert.equal(b.GPU7, 'NIC1');
    });
  }
});

test('L2 puzzles contain fixable mistakes', function () {
  for (var seed = 0; seed < 80; seed++) {
    var sc = E.generateScenario(seed, 2);
    sc.puzzles.forEach(function (p, i) {
      assert.equal(E.validateConfig(p).ok, true);
      assert.ok(E.compareMatrix(sc.truths[i], E.buildMatrix(p)).length > 0);
    });
  }
});

test('L2 scenario comparison detects wrong bindings', function () {
  var sc = E.generateScenario(9, 2);
  var player = {
    matrices: [E.buildMatrix(sc.machines[0]), E.buildMatrix(sc.machines[1])],
    bindings: [Object.assign({}, sc.bindings[0]), Object.assign({}, sc.bindings[1])]
  };
  assert.equal(E.compareScenario(sc, player).ok, true);
  player.bindings[0].GPU0 = 'NIC1';
  var r = E.compareScenario(sc, player);
  assert.equal(r.ok, false);
  assert.equal(r.bindingDiffs.length, 1);
  assert.equal(r.bindingDiffs[0].expected, 'NIC0');
});

test('binding penalty grows with distance', function () {
  assert.ok(E.bindingPenalty('PIX') < E.bindingPenalty('NODE'));
  assert.ok(E.bindingPenalty('NODE') < E.bindingPenalty('SYS'));
});

test('L2 scenario command includes both nodes and TOR', function () {
  var txt = E.formatScenarioCommand(E.generateScenario(5, 2));
  assert.ok(txt.indexOf('节点 A') >= 0 && txt.indexOf('节点 B') >= 0 && txt.indexOf('TOR') >= 0);
});

test('L3 cluster scenario is solvable for 300 seeds', function () {
  for (var seed = 0; seed < 300; seed++) {
    var c = E.generateClusterScenario(seed);
    assert.equal(c.level, 3);
    assert.equal(c.machines.length, 4);
    assert.equal(c.flows.length, 8);
    assert.ok(isFinite(c.bestTime) && c.bestTime >= 0);
    assert.ok(c.bestAllocation && Object.keys(c.bestAllocation).length === 8);
    c.machines.forEach(function (m) {
      assert.ok(m.nics.some(function (n) { return n.bw > 0; }), 'seed ' + seed + ': machine fully down');
    });
    var r = E.evaluateCluster(c, c.bestAllocation);
    assert.ok(Math.abs(r.total - c.bestTime) < 1e-9);
  }
});

test('L3 load and time calculation is correct', function () {
  var c = E.generateClusterScenario(11);
  var alloc = {};
  c.flows.forEach(function (f) { alloc[f.id] = 0; });
  var r = E.evaluateCluster(c, alloc);
  var totalSize = 0;
  c.flows.forEach(function (f) { totalSize += f.size; });
  var sumLoads = 0;
  r.loads.forEach(function (m) { sumLoads += m[0] + m[1]; });
  assert.equal(sumLoads, totalSize);
  assert.ok(r.total >= 0);
  assert.ok(r.bottleneck >= 0 && r.bottleneck < 8);
});

test('L3 down ports are never in the best allocation', function () {
  for (var seed = 0; seed < 100; seed++) {
    var c = E.generateClusterScenario(seed);
    c.flows.forEach(function (f) {
      var ni = c.bestAllocation[f.id];
      assert.ok(c.machines[f.src].nics[ni].bw > 0, 'seed ' + seed + ' flow ' + f.id);
    });
  }
});

test('L3 cluster command includes flows and bottleneck hint', function () {
  var txt = E.formatClusterCommand(E.generateClusterScenario(4));
  assert.ok(txt.indexOf('F0') >= 0);
  assert.ok(txt.indexOf('最窄') >= 0);
  assert.ok(txt.indexOf('最慢') >= 0);
});

console.log('PASS ' + passed + ' / ' + (passed + failed.length));
if (failed.length) {
  failed.forEach(function (f) { console.error('FAIL ' + f); });
  process.exit(1);
}
