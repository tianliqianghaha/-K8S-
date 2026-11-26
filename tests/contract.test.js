'use strict';

/*
  通用契约测试：不针对某个模块写死，遍历注册表里的每一个模块、每一关、多个 seed。
  这是 28 个模块能一起维护的唯一办法 —— 加模块不用改测试。
*/

var assert = require('node:assert/strict');

require('../src/core/rng.js');
require('../src/core/model.js');
require('../src/core/place.js');
require('../src/core/grade.js');
var F = require('../src/core/factory.js');
var REG = require('../src/core/registry.js');
require('../src/core/progress.js');
var G = require('../src/core/grade.js');
require('../src/renderers/matrix.js');
require('../src/domains/L0/m00_m01.js');
require('../src/domains/L1/m02_m04_m05.js');
require('../src/domains/L1/m03_pcie.js');
require('../src/domains/L2/m06_m09.js');
require('../src/domains/L3/m10_m14.js');
require('../src/domains/L4/m15_m19.js');
require('../src/domains/L5/m20_m24.js');
require('../src/domains/L6/m25_m27.js');

var cases = 0;
var passed = 0;
var failed = [];

function test(name, fn) {
  cases++;
  try {
    fn();
    passed++;
  } catch (e) {
    failed.push(name + ' :: ' + (e && e.message ? e.message : String(e)));
  }
}

var SEEDS = [0, 1, 2, 3, 7, 11, 23, 41, 97, 199];

var RENDERERS = { board: 1, calc: 1, choice: 1, sort: 1, match: 1 };

function allText(scen) {
  var buf = [];
  (function walk(v, d) {
    if (d > 4 || v === null || v === undefined) return;
    if (typeof v === 'string') { buf.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { buf.push(String(v)); return; }
    if (Object.prototype.toString.call(v) === '[object Array]') { v.forEach(function (x) { walk(x, d + 1); }); return; }
    if (typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k], d + 1); });
  })(scen, 0);
  return buf.join('\n');
}

/* ---------- 1. 目录完整 ---------- */

test('28 个模块全部注册且可进入', function () {
  var ids = REG.CATALOG.map(function (m) { return m.id; });
  assert.equal(ids.length, 28);
  ids.forEach(function (id) {
    assert.ok(REG.isOpen(id), id + ' 没有声明');
  });
});

test('每个模块的元信息完整、题型合法', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    assert.equal(m.plane, entry.plane, m.id + ' plane 与目录不一致');
    assert.ok(m.title && m.subtitle, m.id + ' 缺标题或副标题');
    assert.ok(m.atoms.length >= 2, m.id + ' 题型太少');
    m.atoms.forEach(function (a) {
      assert.ok('ABCD'.indexOf(a) >= 0, m.id + ' 非法题型 ' + a);
    });
    assert.ok(Array.isArray(m.requires), m.id + ' requires 必须是数组');
    assert.ok(m.stages.length >= 2 && m.stages.length <= 4, m.id + ' 关卡数应在 2~4');
  });
});

/* ---------- 2. 关卡契约 ---------- */

test('每个关卡都实现完整契约', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      ['generate', 'prompt', 'judge', 'hint', 'side', 'solve', 'renderSpec'].forEach(function (k) {
        assert.equal(typeof s[k], 'function', m.id + '/' + s.key + ' 缺 ' + k);
      });
      assert.ok(RENDERERS[s.renderer], m.id + '/' + s.key + ' 未知渲染器 ' + s.renderer);
      assert.ok('ABCD'.indexOf(s.atom) >= 0, m.id + '/' + s.key + ' 非法题型');
      assert.equal(m.atoms.indexOf(s.atom) >= 0, true, m.id + '/' + s.key + ' 题型不在 atoms 里');
    });
    assert.deepEqual(m.stageKeys, m.stages.map(function (s) { return s.key; }), m.id + ' stageKeys 与 stages 不一致');
  });
});

/* ---------- 3. 生成与判定 ---------- */

test('同一 seed 生成的场景完全一致', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      SEEDS.slice(0, 4).forEach(function (seed) {
        var a = JSON.stringify(s.generate(seed, { hard: false }));
        var b = JSON.stringify(s.generate(seed, { hard: false }));
        assert.equal(a, b, m.id + '/' + s.key + ' seed ' + seed + ' 不可复现');
      });
    });
  });
});

test('每个关卡的正确答案都能判过', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      SEEDS.forEach(function (seed) {
        var scen = s.generate(seed, { hard: false });
        var ans = s.solve(scen);
        var res = s.judge(scen, ans);
        assert.equal(res.ok, true, m.id + '/' + s.key + ' seed ' + seed + ' | ' + res.head);
        assert.ok(res.score >= 1, m.id + '/' + s.key + ' 满分关卡的 score 应为 1');
        assert.ok(res.head && res.head.length > 0, m.id + '/' + s.key + ' 没有反馈头');
      });
    });
  });
});

test('空白/错误答案必须判不过（不会白送分）', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      SEEDS.slice(0, 4).forEach(function (seed) {
        var scen = s.generate(seed, { hard: false });
        var res = s.judge(scen, {});
        assert.equal(res.ok, false, m.id + '/' + s.key + ' 空答案也能过');
        assert.equal(res.score, 0, m.id + '/' + s.key + ' 空答案给了分');
      });
    });
  });
});

test('选择题的错项都会判错，且满分项只有一个', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      if (s.renderer !== 'choice') return;
      SEEDS.forEach(function (seed) {
        var scen = s.generate(seed, { hard: false });
        assert.equal(scen.options.length, 4, m.id + '/' + s.key + ' 选项数应为 4，实际 ' + scen.options.length);
        assert.ok(scen.answer >= 0 && scen.answer < 4, m.id + '/' + s.key + ' 答案下标越界');
        scen.options.forEach(function (o, i) {
          assert.ok(o && o.label && o.label.length >= 2, m.id + '/' + s.key + ' 第 ' + i + ' 项没有文案');
          /* D 型用惩罚值判分，选项可以没有 why，但必须带 penalty */
          if (o.why) {
            assert.ok(o.why.length >= 4, m.id + '/' + s.key + ' 第 ' + i + ' 项解析太短');
          } else {
            assert.equal(typeof o.penalty, 'number', m.id + '/' + s.key + ' 第 ' + i + ' 项既没有解析也没有惩罚值');
          }
        });
        var full = 0;
        var passedCount = 0;
        for (var i = 0; i < scen.options.length; i++) {
          var r = s.judge(scen, { pick: i });
          if (r.score === 1) full++;
          if (r.ok) passedCount++;
        }
        assert.equal(full, 1, m.id + '/' + s.key + ' 满分项数量应为 1，实际 ' + full);
        /* D 型允许一个"次优但合理"的答案也判过，其余题型只能有一个 */
        var limit = s.atom === 'D' ? 2 : 1;
        assert.ok(passedCount <= limit, m.id + '/' + s.key + ' 判过的选项过多：' + passedCount);
      });
    });
  });
});

test('计算题的答案与公式对得上，题面不给答案', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      if (s.renderer !== 'calc') return;
      SEEDS.forEach(function (seed) {
        var scen = s.generate(seed, { hard: false });
        assert.equal(typeof scen.expected, 'number', m.id + '/' + s.key + ' expected 不是数字');
        assert.ok(isFinite(scen.expected), m.id + '/' + s.key + ' expected 非有限值');
        assert.ok(scen.unit, m.id + '/' + s.key + ' 缺单位');
        assert.ok(scen.steps && scen.steps.length >= 2, m.id + '/' + s.key + ' 步骤太少');
        /* 题面不能把"答案 + 单位"直接写出来（题面参数里的裸数字不算泄露） */
        var shown = String(G.round(scen.expected, scen.digits === undefined ? 1 : scen.digits));
        assert.equal(scen.q.indexOf(shown + ' ' + scen.unit) < 0, true,
          m.id + '/' + s.key + ' 题面泄露了答案 ' + shown + ' ' + scen.unit);
      });
    });
  });
});

test('排序题初始顺序不等于正确答案', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      if (s.renderer !== 'sort') return;
      SEEDS.forEach(function (seed) {
        var scen = s.generate(seed, { hard: false });
        assert.notEqual(scen.start.join(''), scen.correct.join(''), m.id + '/' + s.key + ' 一上来就是答案');
        assert.equal(scen.start.length, scen.correct.length, m.id + '/' + s.key + ' 元素数量不一致');
      });
    });
  });
});

test('配对题左右数量一致、配对完整', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      if (s.renderer !== 'match') return;
      SEEDS.slice(0, 4).forEach(function (seed) {
        var scen = s.generate(seed, { hard: false });
        assert.equal(scen.left.length, scen.right.length, m.id + '/' + s.key + ' 左右数量不一致');
        scen.left.forEach(function (l) {
          assert.ok(scen.pairs[l.id], m.id + '/' + s.key + ' 缺配对 ' + l.id);
          assert.ok(scen.right.some(function (r) { return r.id === scen.pairs[l.id]; }),
            m.id + '/' + s.key + ' 配对指向不存在的右项');
        });
      });
    });
  });
});

/* ---------- 4. 交互件 ---------- */

test('题面、提示、侧栏都能产出内容', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      var scen = s.generate(3, { hard: false });
      var pr = s.prompt(scen);
      assert.ok(pr.tabs && pr.tabs.length >= 1, m.id + '/' + s.key + ' 没有题面页签');
      pr.tabs.forEach(function (t) {
        assert.ok(t.name, m.id + '/' + s.key + ' 页签缺名字');
        assert.ok((t.text || t.html || '').length > 12, m.id + '/' + s.key + ' 页签「' + t.name + '」内容太短');
      });
      for (var lv = 0; lv <= 2; lv++) {
        var h = s.hint(scen, s.solve(scen), lv);
        assert.ok(typeof h === 'string' && h.length > 6, m.id + '/' + s.key + ' 第 ' + lv + ' 层提示为空');
      }
      var side = s.side(scen, s.solve(scen), null);
      assert.ok(typeof side === 'string' && side.length > 10, m.id + '/' + s.key + ' 侧栏为空');
      var spec = s.renderSpec(scen);
      assert.equal(spec.renderer, s.renderer, m.id + '/' + s.key + ' renderSpec 与实际渲染器不符');
    });
  });
});

test('提示不会泄露"直接答案"以外的乱码', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    m.stages.forEach(function (s) {
      var scen = s.generate(5, { hard: false });
      var ans = s.solve(scen);
      var txt = s.prompt(scen).tabs.map(function (t) { return (t.text || '') + (t.html || ''); }).join('\n') +
        s.prompt(scen).note + s.hint(scen, ans, 1) + s.hint(scen, ans, 2) + s.side(scen, ans, null) +
        JSON.stringify(s.judge(scen, ans).items);
      ['undefined', 'null', '[object Object]', '**'].forEach(function (bad) {
        assert.equal(txt.indexOf(bad) < 0, true, m.id + '/' + s.key + ' 文本里出现 ' + bad);
      });
    });
  });
});

/* ---------- 5. 知识卡与小测 ---------- */

test('每个模块都有知识卡与两道以上小测', function () {
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    var k = m.knowledge;
    assert.ok(k, m.id + ' 没有知识卡');
    assert.ok(k.concept && k.concept.length > 20, m.id + ' concept 太短');
    assert.ok(k.why && k.why.length > 20, m.id + ' why 太短');
    assert.equal(k.pitfalls.length, 3, m.id + ' 坑的数量应为 3');
    k.pitfalls.forEach(function (p) { assert.ok(p.length > 10, m.id + ' 坑写得太短'); });
    assert.ok(k.verify && k.verify.length > 10, m.id + ' 缺 verify');

    var qs = m.quiz(9);
    assert.ok(qs.length >= 2, m.id + ' 小测不足 2 题');
    qs.forEach(function (q) {
      assert.ok(q.q && q.q.length > 5, m.id + ' 小测题干太短');
      assert.ok(q.options.length === 4, m.id + ' 小测选项应为 4 个');
      assert.ok(q.answer >= 0 && q.answer < 4, m.id + ' 小测答案下标越界');
      assert.ok(q.why && q.why.length > 5, m.id + ' 小测缺解析');
    });
  });
});

/* ---------- 6. 体量统计 ---------- */

test('模块体量合理：关卡总数与题量', function () {
  var stages = 0;
  var casesCount = 0;
  REG.CATALOG.forEach(function (entry) {
    var m = REG.get(entry.id);
    stages += m.stages.length;
    m.stages.forEach(function (s) {
      if (s.renderer === 'choice') casesCount += 4;
      else casesCount += 1;
    });
  });
  assert.ok(stages >= 70, '关卡总数偏少：' + stages);
  console.log('    关卡 ' + stages + ' 个，模块 28 个，平均 ' + (stages / 28).toFixed(1) + ' 关/模块');
});

console.log('PASS ' + passed + ' / ' + cases);
if (failed.length) {
  failed.forEach(function (f) { console.error('FAIL ' + f); });
  process.exit(1);
}
