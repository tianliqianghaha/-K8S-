(function (root) {
  'use strict';

  var KEY = 'aiInfraCampus.progress.v1';
  var memory = null;

  function blank() {
    return { modules: {}, wrong: [], updated: 0 };
  }

  function read() {
    if (memory) return memory;
    try {
      var raw = root.localStorage && root.localStorage.getItem(KEY);
      memory = raw ? JSON.parse(raw) : blank();
    } catch (e) {
      memory = blank();
    }
    if (!memory || !memory.modules) memory = blank();
    return memory;
  }

  function write(data) {
    memory = data;
    data.updated = Date.now();
    try {
      if (root.localStorage) root.localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      /* file:// 或隐私模式下静默降级，内存里还留着 */
    }
  }

  function stageKey(moduleId, stageKey) {
    return moduleId + ':' + stageKey;
  }

  function record(moduleId, stage, ok, meta) {
    var d = read();
    var k = stageKey(moduleId, stage);
    var rec = d.modules[k] || { tries: 0, ok: 0, best: 0, last: 0 };
    rec.tries += 1;
    if (ok) rec.ok += 1;
    if (meta && meta.score !== undefined) rec.best = Math.max(rec.best, meta.score);
    rec.last = Date.now();
    d.modules[k] = rec;
    if (!ok && meta && meta.tag) {
      d.wrong.push({ at: rec.last, moduleId: moduleId, stage: stage, tag: meta.tag });
      if (d.wrong.length > 200) d.wrong = d.wrong.slice(-200);
    }
    write(d);
  }

  function stageRecord(moduleId, stage) {
    return read().modules[stageKey(moduleId, stage)] || null;
  }

  function moduleProgress(moduleId) {
    var d = read();
    var keys = Object.keys(d.modules).filter(function (k) {
      return k.indexOf(moduleId + ':') === 0;
    });
    var done = keys.filter(function (k) { return d.modules[k].ok > 0; }).length;
    return { done: done, total: keys.length };
  }

  function reset() {
    write(blank());
  }

  /* 测试与"导入进度"用：直接注入一份记录，同时落到内存与本地存储 */
  function load(data) {
    var d = blank();
    if (data && data.modules) d.modules = data.modules;
    if (data && data.wrong) d.wrong = data.wrong;
    write(d);
  }

  root.TopoProgress = {
    read: read,
    record: record,
    stageRecord: stageRecord,
    moduleProgress: moduleProgress,
    reset: reset,
    load: load
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoProgress;
})(typeof globalThis !== 'undefined' ? globalThis : this);
