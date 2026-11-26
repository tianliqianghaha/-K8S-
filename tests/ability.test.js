'use strict';

/*
  X3 的纯计算层测试：不碰 DOM，只喂 progress 记录，看算出来的数对不对。
  掌握度 = 通关率 × 70 + 一次过率 × 30，公式写死在测试里，改实现必须同步改这里。
*/

var assert = require('node:assert/strict');

require('../src/core/rng.js');
require('../src/core/model.js');
require('../src/core/place.js');
require('../src/core/grade.js');
require('../src/core/factory.js');
var REG = require('../src/core/registry.js');
require('../src/core/progress.js');
require('../src/domains/L0/m00_m01.js');
require('../src/domains/L1/m02_m04_m05.js');
require('../src/domains/L1/m03_pcie.js');
require('../src/domains/L2/m06_m09.js');
require('../src/domains/L3/m10_m14.js');
require('../src/domains/L4/m15_m19.js');
require('../src/domains/L5/m20_m24.js');
require('../src/domains/L6/m25_m27.js');
var A = require('../src/core/ability.js');

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

function data(recs, wrong) {
  return { modules: recs || {}, wrong: wrong || [] };
}

test('空记录：七个平面都是 0，判定为"还没开始"', function () {
  var r = A.compute(data());
  assert.equal(r.empty, true);
  assert.equal(r.planes.length, 7);
  r.planes.forEach(function (p) {
    assert.equal(p.mastery, 0, p.key + ' 应该是 0');
    assert.equal(p.done, 0);
    assert.ok(p.total > 0, p.key + ' 关卡数不该是 0');
  });
  assert.equal(r.overall.total, 85);
  assert.equal(r.overall.done, 0);
});

test('关卡总数与注册表一致（28 模块 / 85 关）', function () {
  var total = 0;
  REG.CATALOG.forEach(function (e) {
    total += REG.get(e.id).stages.length;
  });
  assert.equal(total, 85);
  var r = A.compute(data());
  assert.equal(r.overall.total, total);
  var sum = r.planes.reduce(function (a, p) { return a + p.total; }, 0);
  assert.equal(sum, total);
});

test('掌握度公式：通关率 × 70 + 一次过率 × 30', function () {
  /* L0 共 3 关：通 1 关，且是一次过 */
  var recs = {};
  recs['M00:s1'] = { tries: 1, ok: 1 };
  recs['M00:s2'] = { tries: 2, ok: 0 };
  var r = A.compute(data(recs));
  var l0 = r.planes.filter(function (p) { return p.key === 'L0'; })[0];

  var coverage = 1 / l0.total;
  var quality = 1 / 1;
  var expect = Math.round(coverage * 70 + quality * 30);
  assert.equal(l0.done, 1);
  assert.equal(l0.firstTry, 1);
  assert.equal(l0.mastery, expect, '实际 ' + l0.mastery + '，期望 ' + expect);
  assert.equal(l0.untouched, l0.total - 1);
});

test('一次过与反复过要区分开', function () {
  var a = data({ 'M00:s1': { tries: 1, ok: 1 } });
  var b = data({ 'M00:s1': { tries: 4, ok: 1 } });
  var ma = A.compute(a).planes[0].mastery;
  var mb = A.compute(b).planes[0].mastery;
  assert.ok(ma > mb, '一次过的掌握度应该更高：' + ma + ' vs ' + mb);
  assert.equal(A.compute(b).planes[0].firstTry, 0);
});

test('只尝试没通过不计入通关', function () {
  var r = A.compute(data({ 'M00:s1': { tries: 5, ok: 0 } }));
  var l0 = r.planes[0];
  assert.equal(l0.done, 0);
  assert.equal(l0.mastery, 0);
  assert.equal(l0.tries, 5);
  assert.equal(r.empty, true);
});

test('总体数字是七个平面的汇总', function () {
  var recs = {
    'M00:s1': { tries: 1, ok: 1 },
    'M03:s1': { tries: 2, ok: 1 },
    'M09:s3': { tries: 1, ok: 1 }
  };
  var r = A.compute(data(recs));
  assert.equal(r.overall.done, 3);
  assert.equal(r.overall.firstTry, 2);
  assert.equal(r.overall.tries, 4);
  var sumTries = r.planes.reduce(function (a, p) { return a + p.tries; }, 0);
  assert.equal(sumTries, 4);
});

test('推荐下一步：优先补最弱的平面，且指向真正没通的关', function () {
  var recs = { 'M00:s1': { tries: 1, ok: 1 } };
  var r = A.compute(data(recs));
  assert.ok(r.next, '应该给出下一步');
  assert.ok(r.next.reason.length > 5);
  /* L0 掌握度 53，其余为 0；并列 0 时按平面顺序取 L1，其首模块 M02 */
  assert.equal(r.next.plane, 'L1');
  assert.equal(r.next.moduleId, 'M02');
  assert.equal(r.next.stage, 's1');
});

test('推荐下一步：全通关后转为建议复练一次过率最低的层', function () {
  var recs = {};
  REG.CATALOG.forEach(function (e) {
    REG.get(e.id).stages.forEach(function (s) {
      recs[e.id + ':' + s.key] = { tries: e.plane === 'L6' ? 4 : 1, ok: 1 };
    });
  });
  var r = A.compute(data(recs));
  assert.equal(r.overall.done, 85);
  assert.equal(r.empty, false);
  assert.ok(r.next);
  assert.equal(r.next.moduleId, null);
  assert.equal(r.next.plane, 'L6');
  assert.ok(r.next.reason.indexOf('一次过率') >= 0);
});

test('错题本按时间倒序、最多 12 条，且能解析出模块与关卡名', function () {
  var wrong = [];
  for (var i = 0; i < 20; i++) {
    wrong.push({ at: 1000 + i, moduleId: 'M09', stage: 's3', tag: 's3' });
  }
  wrong.push({ at: 9999, moduleId: 'M03', stage: 's1', tag: 's1' });
  var r = A.compute(data({}, wrong));
  assert.equal(r.wrong.length, 12);
  assert.equal(r.wrong[0].moduleId, 'M03', '最新的应该排第一');
  assert.equal(r.wrong[0].moduleTitle, REG.get('M03').title);
  assert.equal(r.wrong[0].stageTitle, '还原拓扑');
  assert.equal(r.wrong[0].plane, 'L1');
});

test('异常记录不会让计算崩', function () {
  var r = A.compute(data({ '不存在的模块:s1': { tries: 1, ok: 1 }, 'M00:zzz': { tries: 1, ok: 1 } }));
  assert.equal(r.overall.done, 0);
  assert.equal(r.empty, true);
  assert.equal(r.wrong.length, 0);
});

console.log('PASS ' + passed + ' / ' + cases);
if (failed.length) {
  failed.forEach(function (f) { console.error('FAIL ' + f); });
  process.exit(1);
}
