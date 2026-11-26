(function (root) {
  'use strict';

  var G = root.TopoGrade;
  var R = root.TopoRng;

  function normOptions(list) {
    return (list || []).map(function (o) {
      if (Object.prototype.toString.call(o) === '[object Array]') {
        return { label: o[0], why: o[1] };
      }
      return o;
    });
  }

  function letter(i) { return String.fromCharCode(65 + i); }

  /* ---------- B / D：四个根因里选一个 ---------- */

  function pickStage(spec) {
    return {
      key: spec.key,
      atom: spec.atom || 'B',
      title: spec.title,
      renderer: 'choice',
      generate: function (seed) {
        var r = R.stream(seed, spec.id + '.' + spec.key);
        var i = r.int(spec.cases.length);
        var c = spec.cases[i];
        return {
          seed: seed,
          caseIndex: i,
          caseKey: c.k || ('c' + i),
          tabs: c.tabs || [{ name: '题面', text: c.p }],
          note: c.note || spec.note || '',
          options: normOptions(c.o),
          answer: c.a,
          question: c.t,
          world: c.world || null
        };
      },
      prompt: function (scen) { return { tabs: scen.tabs, note: scen.note }; },
      renderSpec: function (scen) { return { renderer: 'choice', ctx: { options: scen.options } }; },
      judge: function (scen, ans) {
        var pick = ans.pick;
        if (pick === null || pick === undefined) {
          return { ok: false, score: 0, head: '还没选。', items: [] };
        }
        var ok = pick === scen.answer;
        var chosen = scen.options[pick];
        var right = scen.options[scen.answer];
        var items = [{
          tone: ok ? 'ok' : 'bad',
          title: (ok ? '选对了：' : '选错了：') + chosen.label,
          text: chosen.why
        }];
        if (!ok) {
          items.push({
            tone: 'info',
            title: '正确答案是 ' + letter(scen.answer) + '：' + right.label,
            text: right.why
          });
        }
        return {
          ok: ok, score: ok ? 1 : 0,
          head: ok ? '判断正确。' : '判断错了，看看到底哪一步接不上。',
          items: items
        };
      },
      hint: function (scen, ans, lv) {
        if (lv <= 0) return spec.hint || '先用题面里的数字把四个选项过一遍，量级对不上的先划掉。';
        if (lv === 1) return '排除法：通常有两个选项和现象的量级不符，还有一个解释不了"影响范围"。';
        return '正确答案往往最省事：一个原因同时解释现象和数字，不用叠加假设。';
      },
      side: spec.side || function () {
        return '<div class="side-h">怎么读这道题</div>' +
          '<div class="mx-note">' + (spec.sideNote || '先把题面里的数字和单位对齐，再排除量级不符的选项。') + '</div>';
      },
      solve: function (scen) { return { pick: scen.answer }; }
    };
  }

  /* ---------- C：算一个数 ---------- */

  function calcStage(spec) {
    return {
      key: spec.key,
      atom: 'C',
      title: spec.title,
      renderer: 'calc',
      generate: function (seed) {
        var scen = spec.make(R.stream(seed, spec.id + '.' + spec.key));
        scen.seed = seed;
        return scen;
      },
      prompt: function (scen) {
        return { tabs: [{ name: '题目', text: scen.q }], note: spec.note || '只填数字，单位已经给好。所有参数都在题面里。' };
      },
      renderSpec: function (scen) {
        return { renderer: 'calc', ctx: { fields: [{ key: 'v', label: scen.label || '答案', unit: scen.unit, ph: '填数字' }] } };
      },
      judge: function (scen, ans) {
        var v = ans.v;
        var tol = scen.tol === undefined ? 0.005 : scen.tol;
        var digits = scen.digits === undefined ? 1 : scen.digits;
        if (typeof v !== 'number' || !isFinite(v)) {
          return { ok: false, score: 0, head: '还没填数字。', items: [] };
        }
        /* 容差要同时容纳"相对误差"和"显示时的四舍五入"，否则 4.44 与 4.4 会被判错 */
        var halfStep = Math.pow(10, -digits) / 2 * 1.01;
        var ok = Math.abs(v - scen.expected) <= Math.max(scen.expected * tol, halfStep);
        var items = [];
        if (!ok) {
          (scen.misread || []).forEach(function (m) {
            if (G.near(v, scen.expected * m.f, Math.max(tol * 4, 0.02))) {
              items.push({ tone: 'warn', title: m.title, text: m.text });
            }
          });
        }
        items.push({
          tone: ok ? 'ok' : 'info',
          title: '标准答案 ' + G.round(scen.expected, scen.digits === undefined ? 1 : scen.digits) + ' ' + scen.unit,
          text: scen.steps.map(function (s, i) { return (i + 1) + '. ' + s; }).join('<br>')
        });
        return {
          ok: ok, score: ok ? 1 : 0,
          head: ok ? '算对了。' : ('你填的是 ' + v + ' ' + scen.unit + '，标准答案 ' +
            G.round(scen.expected, scen.digits === undefined ? 1 : scen.digits) + ' ' + scen.unit + '。'),
          items: items
        };
      },
      hint: function (scen, ans, lv) {
        if (lv <= 0) return spec.hint || '先把题面给的量列成一行，看清单位再动笔。';
        if (lv === 1) return '第二步：' + (scen.steps[scen.steps.length - 2] || scen.steps[0]);
        return '代进去：' + scen.steps[scen.steps.length - 1];
      },
      side: spec.side || function (scen) {
        return '<div class="side-h">量纲</div>' +
          '<div class="kv"><span>答案单位</span><b>' + scen.unit + '</b></div>' +
          '<div class="mx-note">' + (spec.sideNote || '算完回头检查一次量级：AI Infra 里的数常常差三个数量级。') + '</div>';
      },
      solve: function (scen) { return { v: G.round(scen.expected, scen.digits === undefined ? 1 : scen.digits) }; }
    };
  }

  /* ---------- A：排序 ---------- */

  function sortStage(spec) {
    return {
      key: spec.key,
      atom: 'A',
      title: spec.title,
      renderer: 'sort',
      generate: function (seed) {
        var r = R.stream(seed, spec.id + '.' + spec.key);
        var s = spec.make(r);
        s.seed = seed;
        var ids = s.items.map(function (x) { return x.id; });
        var start = ids.slice();
        var guard = 0;
        do {
          start = r.shuffle(ids);
          guard++;
        } while (guard < 20 && start.join('') === s.correct.join(''));
        s.start = start;
        return s;
      },
      prompt: function (scen) {
        return { tabs: [{ name: '题目', text: scen.q }], note: spec.note || '点两行可以交换位置，也可以用上下的箭头逐格挪。排对顺序才算过。' };
      },
      renderSpec: function (scen) {
        return { renderer: 'sort', ctx: { items: scen.items, start: scen.start } };
      },
      judge: function (scen, ans) {
        var order = ans.order || [];
        var n = scen.correct.length;
        var hit = 0;
        for (var i = 0; i < n; i++) if (order[i] === scen.correct[i]) hit++;
        var ok = hit === n;
        var items = [];
        if (!ok) {
          for (var j = 0; j < n; j++) {
            if (order[j] !== scen.correct[j]) {
              var exp = scen.items.filter(function (x) { return x.id === scen.correct[j]; })[0];
              var act = scen.items.filter(function (x) { return x.id === order[j]; })[0];
              items.push({
                tone: 'bad',
                title: '第 ' + (j + 1) + ' 位应该是「' + (exp ? exp.label : scen.correct[j]) + '」',
                text: '你放的是「' + (act ? act.label : order[j]) + '」。' + (scen.why ? scen.why[j] || '' : '')
              });
              if (items.length >= 4) break;
            }
          }
        }
        items.push({ tone: 'info', title: '正确顺序', text: scen.correct.map(function (id, i) {
          var it = scen.items.filter(function (x) { return x.id === id; })[0];
          return (i + 1) + '. ' + (it ? it.label : id);
        }).join('<br>') });
        return {
          ok: ok, score: ok ? 1 : 0,
          head: ok ? '顺序全对。' : ('对了 ' + hit + ' / ' + n + ' 位。'),
          items: items
        };
      },
      hint: function (scen, ans, lv) {
        if (lv <= 0) return spec.hint || '先找"一定在最前面"和"一定在最后面"的那两个，剩下的自然收窄。';
        if (lv === 1) {
          var first = scen.items.filter(function (x) { return x.id === scen.correct[0]; })[0];
          return '第一位是「' + (first ? first.label : scen.correct[0]) + '」。为什么它不能排后面？' +
            (scen.why && scen.why[0] ? scen.why[0] : '');
        }
        return '最后一位是「' + (function () {
          var last = scen.items.filter(function (x) { return x.id === scen.correct[scen.correct.length - 1]; })[0];
          return last ? last.label : '';
        })() + '」，中间两两之间的依赖关系决定了剩下的顺序。';
      },
      side: spec.side || function (scen) {
        return '<div class="side-h">排序靠什么</div>' +
          '<div class="mx-note">' + (spec.sideNote || '不要凭印象排，找"谁依赖谁"。依赖关系一旦定下来，顺序就只有一种。') + '</div>';
      },
      solve: function (scen) { return { order: scen.correct.slice() }; }
    };
  }

  /* ---------- A：配对 ---------- */

  function matchStage(spec) {
    return {
      key: spec.key,
      atom: 'A',
      title: spec.title,
      renderer: 'match',
      generate: function (seed) {
        var r = R.stream(seed, spec.id + '.' + spec.key);
        var s = spec.make(r);
        s.seed = seed;
        s.rightOrder = r.shuffle(s.right.map(function (x) { return x.id; }));
        return s;
      },
      prompt: function (scen) {
        return { tabs: [{ name: '题目', text: scen.q }], note: spec.note || '先点左边一项，再点右边它对应的那一项。全部连对才算过。' };
      },
      renderSpec: function (scen) {
        return { renderer: 'match', ctx: { left: scen.left, right: scen.right, rightOrder: scen.rightOrder } };
      },
      judge: function (scen, ans) {
        var pairs = ans.pairs || {};
        var n = scen.left.length;
        var hit = 0;
        var items = [];
        scen.left.forEach(function (l) {
          var got = pairs[l.id];
          if (got === scen.pairs[l.id]) { hit++; return; }
          var exp = scen.right.filter(function (x) { return x.id === scen.pairs[l.id]; })[0];
          var act = scen.right.filter(function (x) { return x.id === got; })[0];
          items.push({
            tone: 'bad',
            title: l.label + ' → ' + (act ? act.label : '（没连）'),
            text: '应该连「' + (exp ? exp.label : scen.pairs[l.id]) + '」。' + (scen.why && scen.why[l.id] ? scen.why[l.id] : '')
          });
        });
        var ok = hit === n;
        return {
          ok: ok, score: ok ? 1 : 0,
          head: ok ? '全部连对。' : ('连对 ' + hit + ' / ' + n + ' 项。'),
          items: items.slice(0, 5)
        };
      },
      hint: function (scen, ans, lv) {
        if (lv <= 0) return spec.hint || '先把你最确定的那一对连上，剩下的用排除法收。';
        if (lv === 1) {
          var l = scen.left[0];
          var exp = scen.right.filter(function (x) { return x.id === scen.pairs[l.id]; })[0];
          return '「' + l.label + '」对应的是「' + (exp ? exp.label : '') + '」。';
        }
        return '按"它解决什么问题"去对，不要按名字像不像去对。';
      },
      side: spec.side || function () {
        return '<div class="side-h">配对靠什么</div>' +
          '<div class="mx-note">' + (spec.sideNote || '每个术语都在回答一个具体问题。抓住"它解决什么"，名字再像也不会连错。') + '</div>';
      },
      solve: function (scen) {
        var p = {};
        Object.keys(scen.pairs).forEach(function (k) { p[k] = scen.pairs[k]; });
        return { pairs: p };
      }
    };
  }

  root.TopoFactory = {
    pick: pickStage,
    calc: calcStage,
    sort: sortStage,
    match: matchStage,
    normOptions: normOptions
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoFactory;
})(typeof globalThis !== 'undefined' ? globalThis : this);
