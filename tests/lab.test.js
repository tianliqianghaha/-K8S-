'use strict';

/*
  X2 故障注入台：案卷内容 + 两段判定的契约测试。
  重点不是"答对给分"，而是"根因对但处置错只能给半分"这条规则。
*/

var assert = require('node:assert/strict');

require('../src/core/rng.js');
var M = require('../src/core/model.js');
require('../src/core/place.js');
require('../src/core/grade.js');
require('../src/core/factory.js');
var REG = require('../src/core/registry.js');
require('../src/core/progress.js');
var C = require('../src/core/console.js');
var LAB = require('../src/core/lab.js');

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

test('案卷数量与结构完整', function () {
  assert.ok(LAB.count >= 15, '案子太少：' + LAB.count);
  var ids = {};
  LAB.CASES.forEach(function (c) {
    assert.ok(!ids[c.id], '重复的案卷号 ' + c.id);
    ids[c.id] = 1;
    assert.ok(c.title && c.title.length > 5, c.id + ' 标题太短');
    assert.ok(c.plane, c.id + ' 缺平面');
    assert.ok(c.symptom.length >= 2, c.id + ' 现象页签少于 2 个');
    c.symptom.forEach(function (t) {
      assert.ok(t.name && t.text && t.text.length > 24, c.id + ' 现象内容太短：' + t.name);
    });
    /* 单条告警本来就短，真正该守的是"整个案卷的信息量" */
    var bulk = c.symptom.reduce(function (a, t) { return a + t.text.length; }, 0);
    assert.ok(bulk >= 120, c.id + ' 现象整体信息量不足：' + bulk);
    assert.equal(c.cause.options.length, 4, c.id + ' 根因应为 4 选 1');
    assert.equal(c.fix.options.length, 3, c.id + ' 处置应为 3 选 1');
    assert.ok(c.cause.answer >= 0 && c.cause.answer < 4, c.id + ' 根因下标越界');
    assert.ok(c.fix.answer >= 0 && c.fix.answer < 3, c.id + ' 处置下标越界');
    assert.ok(c.chain.length >= 2, c.id + ' 证据链太短');
    c.chain.forEach(function (x) {
      assert.ok(x.cmd && x.cmd.length > 3, c.id + ' 证据链缺命令');
      assert.ok(x.why && x.why.length > 6, c.id + ' 证据链缺说明');
    });
    assert.ok(c.knowledge.concept.length > 20, c.id + ' 缺概念');
    assert.ok(c.knowledge.pitfall.length > 10, c.id + ' 缺坑');
  });
});

test('每个案卷的选项都有解析，且只有一个是"正确。"开头', function () {
  LAB.CASES.forEach(function (c) {
    ['cause', 'fix'].forEach(function (k) {
      var right = 0;
      c[k].options.forEach(function (o, i) {
        assert.ok(o[0] && o[0].length >= 4, c.id + '/' + k + ' 第 ' + i + ' 项没有文案');
        assert.ok(o[1] && o[1].length >= 6, c.id + '/' + k + ' 第 ' + i + ' 项没有解析');
        if (o[1].indexOf('正确') === 0) right++;
      });
      assert.equal(right, 1, c.id + '/' + k + ' 标记为正确的项应为 1，实际 ' + right);
      assert.equal(c[k].options[c[k].answer][1].indexOf('正确'), 0,
        c.id + '/' + k + ' answer 指向的不是正确项');
    });
  });
});

test('两段判定：全对满分、根因错 0 分、处置错半分', function () {
  LAB.CASES.forEach(function (c) {
    var full = LAB.judge(c, { cause: c.cause.answer, fix: c.fix.answer });
    assert.equal(full.ok, true, c.id + ' 全对应该判过');
    assert.equal(full.score, 1);

    var wrongCause = (c.cause.answer + 1) % 4;
    var r1 = LAB.judge(c, { cause: wrongCause, fix: null });
    assert.equal(r1.ok, false, c.id + ' 根因错不该判过');
    assert.equal(r1.score, 0);
    assert.equal(r1.stage, 'cause');

    var pending = LAB.judge(c, { cause: c.cause.answer, fix: null });
    assert.equal(pending.stage, 'pending', c.id + ' 只答根因应为 pending');

    var wrongFix = (c.fix.answer + 1) % 3;
    var r2 = LAB.judge(c, { cause: c.cause.answer, fix: wrongFix });
    assert.equal(r2.ok, false, c.id + ' 处置错不该判过');
    assert.equal(r2.score, 0.5, c.id + ' 根因对处置错应给半分');
    assert.ok(r2.head.indexOf('处置') >= 0);
  });
});

test('空答案不崩、不白送分', function () {
  LAB.CASES.forEach(function (c) {
    var r = LAB.judge(c, {});
    assert.equal(r.ok, false);
    assert.equal(r.score, 0);
  });
});

test('根因错了要给正确答案，处置错了也要给', function () {
  var c = LAB.CASES[0];
  var r = LAB.judge(c, { cause: (c.cause.answer + 1) % 4, fix: null });
  assert.ok(r.items.length >= 2);
  assert.ok(r.items[1].title.indexOf('证据指向') >= 0);
  var r2 = LAB.judge(c, { cause: c.cause.answer, fix: (c.fix.answer + 1) % 3 });
  assert.ok(r2.items.length >= 2);
  assert.ok(r2.items[1].title.indexOf('更合适') >= 0);
});

test('抽题可复现，且多个 seed 能覆盖全部案卷', function () {
  var a = LAB.pick(123).id;
  var b = LAB.pick(123).id;
  assert.equal(a, b, '同 seed 应抽出同一案卷');
  var seen = {};
  for (var s = 0; s < 200; s++) seen[LAB.pick(s).id] = (seen[LAB.pick(s).id] || 0) + 1;
  assert.equal(Object.keys(seen).length, LAB.count, '有案卷从未被抽到');
  assert.equal(LAB.byId(a).id, a);
  assert.equal(LAB.byId('NOPE'), null);
});

test('每个案卷都能在终端里取证（现场可解析、命令有输出）', function () {
  LAB.CASES.forEach(function (c) {
    var w = C.worldFor({ world: c.world });
    assert.ok(w && w.gpus && w.gpus.length, c.id + ' 拿不到现场');
    ['nvidia-smi', 'dmesg', 'ibstat', 'etcdctl endpoint status'].forEach(function (cmd) {
      var r = C.exec(cmd, w);
      assert.ok(typeof r.text === 'string' && r.text.length > 5, c.id + ' ' + cmd + ' 无输出');
      assert.equal(r.text.indexOf('undefined') < 0, true, c.id + ' ' + cmd + ' 输出有 undefined');
    });
  });
});

test('证据链里提到的命令，终端都真的支持', function () {
  var known = ['nvidia-smi', 'nvidia-smi -q', 'nvidia-smi -L', 'nvidia-smi topo -m',
    'nvidia-smi nvlink -e', 'lspci -tv', 'lscpu', 'numactl -H', 'ibstat', 'dmesg',
    'free -h', 'uptime', 'cat /proc/interrupts', 'lsmod | grep nvidia',
    'kubectl get pods', 'etcdctl endpoint status',
    'ipmitool sdr', 'ipmitool sel list', 'bill report --team nlp',
    'kubectl get hpa', 'kubectl top pods'];
  LAB.CASES.forEach(function (c) {
    c.chain.forEach(function (x) {
      var cmd = x.cmd.trim();
      var allowed = known.indexOf(cmd) >= 0 ||
        /^prom query '.+'$/.test(cmd) ||
        /^nvidia-smi -q -i \d+$/.test(cmd) ||
        /^kubectl describe pod [a-z0-9-]+$/.test(cmd) ||
        /^kubectl describe hpa [a-z0-9-]+$/.test(cmd);
      assert.ok(allowed, c.id + ' 证据链里的命令不在支持列表：' + cmd);
      var r = C.exec(cmd, C.worldFor({ world: c.world }));
      assert.ok(r.text && r.text.length > 5, c.id + ' 证据链命令无输出：' + cmd);
      assert.equal(r.text.indexOf('command not found'), -1, c.id + ' 证据链命令不被支持：' + cmd);
    });
  });
});

test('现象里出现的数字，在终端里查得到（不编造）', function () {
  /* F02：现象说 DBE +3，终端里就该是 3 */
  var f02 = LAB.byId('F02');
  var w = C.worldFor({ world: f02.world });
  assert.equal(w.gpus[3].eccDbe, 3);
  assert.ok(C.exec('nvidia-smi -q', w).text.indexOf('Device Memory                     : 3') >= 0);

  /* F01：现象说卡少了一张，终端里就该少一张 */
  var f01 = LAB.byId('F01');
  var w1 = C.worldFor({ world: f01.world });
  var smi = C.exec('nvidia-smi', w1).text;
  assert.equal(smi.split('80GB HBM3').length - 1, 7);
  assert.ok(smi.indexOf('只列出 7 张') >= 0);

  /* F05：现象说一半的卡跨 NUMA，topo 表里就该是 SYS */
  var f05 = LAB.byId('F05');
  var w5 = C.worldFor({ world: f05.world });
  var topo = C.exec('nvidia-smi topo -m', w5).text;
  assert.equal(topo, M.formatTopo(f05.world.config));
  assert.ok(topo.indexOf('SYS') >= 0);
});

test('扩到 18 卷后：每个新案卷的关键证据都能在终端里查到', function () {
  var w10 = C.worldFor({ world: LAB.byId('F10').world });
  assert.ok(C.exec('nvidia-smi -q -i 0', w10).text.indexOf('SW Power Cap                      : Active') >= 0,
    'F10 应能查到 SW Power Cap 生效');
  assert.ok(C.exec('nvidia-smi -q -i 0', w10).text.indexOf('SM                                : 1080 MHz') >= 0);

  var w11 = C.worldFor({ world: LAB.byId('F11').world });
  var irq = C.exec('cat /proc/interrupts', w11).text;
  assert.ok(irq.indexOf('全部落在 CPU47') >= 0, 'F11 的中断应全部落在 CPU47');

  var w12 = C.worldFor({ world: LAB.byId('F12').world });
  assert.ok(C.exec('free -h', w12).text.indexOf('7.4Gi') >= 0, 'F12 应能查到 swap 已用 7.4Gi');

  var w13 = C.worldFor({ world: LAB.byId('F13').world });
  var topo13 = C.exec('nvidia-smi topo -m', w13).text;
  assert.equal(topo13.indexOf('NV8'), -1, 'F13 的拓扑里不该出现 NV8');
  assert.ok(C.exec('dmesg', w13).text.indexOf('version mismatch') >= 0);

  var w14 = C.worldFor({ world: LAB.byId('F14').world });
  assert.ok(C.exec('ibstat', w14).text.indexOf('State: Down') >= 0, 'F14 端口应为 Down');

  var w15 = C.worldFor({ world: LAB.byId('F15').world });
  assert.ok(C.exec('ibstat', w15).text.indexOf('Rate: 200') >= 0, 'F15 速率应为 200');

  var w16 = C.worldFor({ world: LAB.byId('F16').world });
  assert.ok(C.exec('kubectl describe pod train-8card', w16).text.indexOf('Insufficient nvidia.com/gpu') >= 0,
    'F16 的 Pending Pod 必须能 describe 出调度失败');
  assert.ok(C.exec('kubectl get pods', w16).text.indexOf('Pending') >= 0);

  var w18 = C.worldFor({ world: LAB.byId('F18').world });
  assert.ok(C.exec('kubectl describe pod train-0', w18).text.indexOf('Evicted') >= 0);
  var free18 = C.exec('free -h', w18).text;
  assert.ok(free18.indexOf('32Mi') >= 0 && free18.indexOf('986Gi') >= 0,
    'F18 的 free 数字应自洽：used 大、available 小');
});

test('扩到 L0 / L5 后：监控侧证据也查得到，且数字自洽', function () {
  /* F19：A 路 52.4A、B 路 9.6A，与 sdr 里 PSU 的带载情况一致 */
  var w19 = C.worldFor({ world: LAB.byId('F19').world });
  var prom19 = C.exec("prom query 'pdu_current_a'", w19).text;
  assert.ok(prom19.indexOf('52.4') >= 0 && prom19.indexOf('9.6') >= 0, 'F19 的 PDU 电流应在监控里查得到');
  var sdr19 = C.exec('ipmitool sdr', w19).text;
  assert.ok(sdr19.indexOf('1580 Watts') >= 0 && sdr19.indexOf('60 Watts') >= 0,
    'F19 的两颗空载 PSU 应能在 sdr 里看出来');
  assert.ok(C.exec('ipmitool sel list', w19).text.indexOf('redundancy lost') >= 0);

  /* F20：进风 34°C，全部卡 91°C 且 Thermal Slowdown */
  var w20 = C.worldFor({ world: LAB.byId('F20').world });
  assert.ok(C.exec('ipmitool sdr', w20).text.indexOf('34 degrees C') >= 0, 'F20 进风应为 34°C');
  assert.ok(C.exec('ipmitool sdr', w20).text.indexOf('cr') >= 0, '进风超限应标为 critical，不能是 ok');
  assert.ok(C.exec("prom query 'avg(gpu_temp_c)'", w20).text.indexOf('91') >= 0);
  assert.equal(w20.gpus.filter(function (g) { return g.throttle === 'HW Thermal Slowdown'; }).length, 8,
    'F20 应该是 8 张卡一起降频');

  /* F21：两颗 PSU 同秒 AC lost，另外两颗不在位 */
  var w21 = C.worldFor({ world: LAB.byId('F21').world });
  var sel21 = C.exec('ipmitool sel list', w21).text;
  assert.equal(sel21.split('Power Supply AC lost | Asserted').length - 1, 2, 'F21 应有两颗 PSU 同时失电');
  var psus21 = w21.mon.bmc.psus.filter(function (p) { return p.status === 'absent'; });
  assert.equal(psus21.length, 2, 'F21 应有两颗 PSU 不在位');

  /* F22：GPU 12%、CPU 限流 0.62、排队 0 —— 三个数必须能同时查到 */
  var w22 = C.worldFor({ world: LAB.byId('F22').world });
  assert.ok(C.exec("prom query 'avg(gpu_util_pct)'", w22).text.indexOf('12') >= 0);
  assert.ok(C.exec("prom query 'container_cpu_throttled_ratio'", w22).text.indexOf('0.62') >= 0);
  assert.ok(C.exec("prom query 'request_queue_depth'", w22).text.indexOf('0') >= 0);
  assert.ok(C.exec('kubectl top pods', w22).text.indexOf('3980m') >= 0);

  /* F23：账单里的卡时与闲置比例，必须能从 bill 与分母算出来 */
  var w23 = C.worldFor({ world: LAB.byId('F23').world });
  var bill23 = C.exec('bill report --team nlp', w23).text;
  assert.ok(bill23.indexOf('¥516,096') >= 0, 'F23 的账单金额应等于 18432 × 28');
  assert.ok(bill23.indexOf('闲置成本') >= 0 && bill23.indexOf('61.4%') >= 0, 'F23 的闲置比例应为 61.4%');
  assert.ok(C.exec("prom query 'train_replicas'", w23).text.indexOf('32') >= 0);

  /* F24：HPA 的 TARGETS 必须是 unknown，事件必须能解释为什么 */
  var w24 = C.worldFor({ world: LAB.byId('F24').world });
  assert.ok(C.exec('kubectl get hpa', w24).text.indexOf('<unknown>/70%') >= 0);
  assert.ok(C.exec('kubectl describe hpa infer-bert', w24).text.indexOf('missing request for cpu') >= 0);
  assert.ok(C.exec("prom query 'request_queue_depth'", w24).text.indexOf('240') >= 0);
});

test('24 卷覆盖 L0-L5，且每层不少于 3 卷', function () {
  var planes = {};
  LAB.CASES.forEach(function (c) {
    planes[c.plane] = (planes[c.plane] || 0) + 1;
    assert.ok(c.chain.length >= 2, c.id + ' 证据链太短');
  });
  ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].forEach(function (k) {
    assert.ok(planes[k] && planes[k] >= 3, k + ' 的案卷太少：' + (planes[k] || 0));
  });
});

console.log('PASS ' + passed + ' / ' + cases);
if (failed.length) {
  failed.forEach(function (f) { console.error('FAIL ' + f); });
  process.exit(1);
}
