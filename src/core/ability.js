(function (root) {
  'use strict';

  /*
    X3 能力雷达的计算层。
    只做一件事：把 progress 里的原始记录，算成"每个平面一行"的数字。
    不碰 DOM，方便单测。
  */

  function recKey(modId, stage) { return modId + ':' + stage; }

  function compute(data) {
    var REG = root.TopoRegistry;
    var d = data || root.TopoProgress.read();
    var mods = d.modules || {};
    var planes = REG.planes();

    var out = planes.map(function (p) {
      var total = 0, done = 0, firstTry = 0, tries = 0, passes = 0;
      p.modules.forEach(function (m) {
        if (!m.live) return;
        m.live.stageKeys.forEach(function (sk) {
          total++;
          var rec = mods[recKey(m.id, sk)];
          if (!rec) return;
          tries += rec.tries || 0;
          passes += rec.ok || 0;
          if ((rec.ok || 0) > 0) {
            done++;
            if (rec.tries === 1 && rec.ok === 1) firstTry++;
          }
        });
      });
      var coverage = total ? done / total : 0;
      var quality = done ? firstTry / done : 0;
      return {
        key: p.key,
        name: p.name,
        note: p.note,
        total: total,
        done: done,
        firstTry: firstTry,
        tries: tries,
        passes: passes,
        coverage: coverage,
        quality: quality,
        /* 掌握度：通关占七成，一次过占三成。没通关就是 0，避免"乱点也算会" */
        mastery: Math.round(coverage * 70 + quality * 30 * (done ? 1 : 0)),
        untouched: total - done
      };
    });

    var totalStages = out.reduce(function (a, b) { return a + b.total; }, 0);
    var doneStages = out.reduce(function (a, b) { return a + b.done; }, 0);
    var firstTryAll = out.reduce(function (a, b) { return a + b.firstTry; }, 0);
    var triesAll = out.reduce(function (a, b) { return a + b.tries; }, 0);

    /* 推荐下一步：先补最弱的平面里有"没通关"的模块；全通关后转为"复练正确率最低" */
    var next = null;
    var candidates = out.filter(function (p) { return p.untouched > 0; });
    if (candidates.length) {
      candidates.sort(function (a, b) { return a.mastery - b.mastery; });
      var weak = candidates[0];
      var plane = planes.filter(function (p) { return p.key === weak.key; })[0];
      for (var i = 0; i < plane.modules.length; i++) {
        var m = plane.modules[i];
        if (!m.live) continue;
        var pending = m.live.stageKeys.filter(function (sk) {
          var rec = mods[recKey(m.id, sk)];
          return !rec || !rec.ok;
        });
        if (pending.length) {
          next = {
            moduleId: m.id,
            stage: pending[0],
            plane: weak.key,
            title: m.title,
            reason: weak.key + ' 这一层还有 ' + weak.untouched + ' 关没通，掌握度 ' + weak.mastery + '%'
          };
          break;
        }
      }
    } else if (doneStages) {
      var low = out.slice().sort(function (a, b) { return a.quality - b.quality; })[0];
      next = {
        moduleId: null,
        stage: null,
        plane: low.key,
        title: low.name,
        reason: '全部通关，但 ' + low.key + ' 的"一次过率"只有 ' + Math.round(low.quality * 100) + '%，值得重刷'
      };
    }

    /*
      X2 的失败记录不进错题本：它是实验室会话，没有"模块/关卡"这层结构，
      硬塞进来会出现 plane 为空、链接拼成 #//X2/... 的坏行。
    */
    var wrong = (d.wrong || []).filter(function (w) {
      return !!REG.get(w.moduleId);
    }).slice(-12).reverse().map(function (w) {
      var m = REG.get(w.moduleId);
      var stage = null;
      m.stages.forEach(function (s) { if (s.key === w.stage) stage = s; });
      return {
        at: w.at,
        moduleId: w.moduleId,
        stage: w.stage,
        moduleTitle: m.title,
        stageTitle: stage ? stage.title : w.stage,
        plane: m.plane
      };
    });

    return {
      planes: out,
      overall: {
        total: totalStages,
        done: doneStages,
        firstTry: firstTryAll,
        tries: triesAll,
        coverage: totalStages ? doneStages / totalStages : 0,
        mastery: totalStages
          ? Math.round(doneStages / totalStages * 70 + (doneStages ? firstTryAll / doneStages : 0) * 30)
          : 0
      },
      wrong: wrong,
      next: next,
      empty: doneStages === 0
    };
  }

  root.TopoAbility = { compute: compute, recKey: recKey };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoAbility;
})(typeof globalThis !== 'undefined' ? globalThis : this);
