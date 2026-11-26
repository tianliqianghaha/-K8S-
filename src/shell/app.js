(function (root) {
  'use strict';

  var REG = root.TopoRegistry;
  var PROG = root.TopoProgress;
  var RENDERERS = {
    board: root.TopoRenderBoard,
    calc: root.TopoRenderCalc,
    choice: root.TopoRenderChoice,
    sort: root.TopoRenderSort,
    match: root.TopoRenderMatch,
    matrix: root.TopoRenderMatrix
  };

  var DEFAULT_SEED = 20261125;
  var state = {
    hard: false,
    seed: {},
    hintLv: {},
    quiz: null
  };
  var view = null;
  var history = [];
  var future = [];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* seed 与提示层级要按「模块:关卡」记，否则不同模块的 s1 会共用同一个 seed */
  function stageKeyOf(mod, stage) { return mod.id + ':' + stage.key; }

  function $(sel) { return document.querySelector(sel); }

  function toast(msg) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ---------------- 地图页 ---------------- */

  function viewMap() {
    var planes = REG.planes().slice().reverse();
    var total = REG.CATALOG.length;
    var open = REG.CATALOG.filter(function (m) { return REG.isOpen(m.id); }).length;
    var rows = planes.map(function (p) {
      var first = p.modules[0].id;
      var last = p.modules[p.modules.length - 1].id;
      var anyOpen = p.modules.some(function (m) { return m.open; });
      return '<div class="map-row' + (anyOpen ? ' live' : '') + '" data-plane="' + p.key + '">' +
        '<div class="map-l"><b>' + p.key + '</b><span>' + p.name + '</span></div>' +
        '<div class="map-r"><em>' + first + '–' + last + '</em><span>' + p.note + '</span></div>' +
        '<div class="map-n">' + p.modules.length + ' 个模块' + (anyOpen ? ' · 可进入' : '') + '</div>' +
        '</div>';
    }).join('');

    return '<div class="page">' +
      '<div class="hero">' +
      '<h1>AI Infra 认知训练场</h1>' +
      '<p>七个平面，' + total + ' 个模块。从墙上的插座一路练到线上的 SLA。<br>' +
      '每一层只出现这一层的术语——在机柜层不谈 NVLink，在 NCCL 层不谈 U 位。</p>' +
      '<div class="hero-kpi">已开放 <b>' + open + '</b> / ' + total + ' 个模块　' +
      '<a class="hero-link" href="#/lab">故障注入台 →</a>' +
      '<a class="hero-link" href="#/ability">查看能力雷达 →</a></div>' +
      '</div>' +
      '<div class="map-note">从下往上是物理到抽象的依赖顺序，不是课程顺序</div>' +
      '<div class="map">' + rows + '</div>' +
      '<div class="map-foot">七个平面全部开放，共 28 个模块、85 关。每关过了才解锁知识卡与小测；' +
      '进度存在本地，换台机器不会同步。</div>' +
      '</div>';
  }

  /* ---------------- 平面页 ---------------- */

  function viewPlane(planeKey) {
    var plane = REG.planes().filter(function (p) { return p.key === planeKey; })[0];
    if (!plane) return viewMap();
    var cards = plane.modules.map(function (m) {
      var prog = m.open ? PROG.moduleProgress(m.id) : null;
      var cls = 'card' + (m.open ? ' live' : ' soon');
      return '<div class="' + cls + '" data-mod="' + m.id + '">' +
        '<div class="card-id">' + m.id + '</div>' +
        '<div class="card-t">' + m.title + '</div>' +
        (m.live
          ? '<div class="card-atoms">' + m.live.atoms.map(function (a) { return '<span class="atom a-' + a + '">' + a + '</span>'; }).join('') + '</div>' +
          '<div class="card-f">' + m.live.subtitle + '</div>' +
          '<div class="card-go">' + (prog && prog.done ? '已通 ' + prog.done + ' 关 →' : '进入 →') + '</div>'
          : '<div class="card-f">待开工</div><div class="card-go dim">未开放</div>') +
        '</div>';
    }).join('');

    return '<div class="page">' +
      '<div class="crumb"><a href="#/">地图</a> / ' + plane.key + '</div>' +
      '<h1 class="ph">' + plane.key + ' · ' + plane.name + '</h1>' +
      '<p class="ps">' + plane.note + '</p>' +
      '<div class="cards">' + cards + '</div>' +
      '</div>';
  }

  /* ---------------- 能力雷达 ---------------- */

  function radarSvg(planes) {
    var cx = 200, cy = 186, R = 126, n = planes.length;
    function pt(i, r) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / n;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    }
    var out = ['<svg viewBox="0 0 400 380" class="radar" role="img">'];
    [0.25, 0.5, 0.75, 1].forEach(function (k) {
      var pts = planes.map(function (_, i) {
        var q = pt(i, R * k);
        return q[0].toFixed(1) + ',' + q[1].toFixed(1);
      }).join(' ');
      out.push('<polygon points="' + pts + '" fill="none" stroke="#222b36" stroke-width="1"/>');
    });
    planes.forEach(function (p, i) {
      var e = pt(i, R);
      out.push('<line x1="' + cx + '" y1="' + cy + '" x2="' + e[0].toFixed(1) + '" y2="' + e[1].toFixed(1) + '" stroke="#222b36" stroke-width="1"/>');
    });
    var vals = planes.map(function (p, i) {
      var q = pt(i, R * Math.max(0, Math.min(100, p.mastery)) / 100);
      return q[0].toFixed(1) + ',' + q[1].toFixed(1);
    }).join(' ');
    out.push('<polygon points="' + vals + '" fill="rgba(240,160,32,0.16)" stroke="#f0a020" stroke-width="1.5"/>');
    planes.forEach(function (p, i) {
      var q = pt(i, R * Math.max(0, Math.min(100, p.mastery)) / 100);
      out.push('<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="3" fill="#f0a020"/>');
      var l = pt(i, R + 20);
      var anchor = 'middle';
      if (l[0] > cx + 8) anchor = 'start';
      else if (l[0] < cx - 8) anchor = 'end';
      out.push('<text x="' + l[0].toFixed(1) + '" y="' + l[1].toFixed(1) + '" fill="#8b98a5" font-size="11" font-family="ui-monospace,monospace" text-anchor="' + anchor + '" dominant-baseline="central">' + p.key + ' ' + Math.round(p.mastery) + '</text>');
    });
    out.push('<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="#3a4654"/>');
    out.push('</svg>');
    return out.join('');
  }

  function viewAbility() {
    var a = root.TopoAbility.compute();
    var rows = a.planes.slice().reverse().map(function (p) {
      var w = Math.max(0, Math.min(100, p.mastery));
      return '<div class="ab-row">' +
        '<div class="ab-k">' + p.key + '</div>' +
        '<div class="ab-n">' + p.name + '</div>' +
        '<div class="ab-bar"><i style="width:' + w + '%"></i></div>' +
        '<div class="ab-v">' + p.done + '/' + p.total + '</div>' +
        '<div class="ab-m">' + p.mastery + '%</div>' +
        '</div>';
    }).join('');

    var nextHtml = '';
    if (a.next) {
      var href = a.next.moduleId ? ('#/' + a.next.plane + '/' + a.next.moduleId + '/' + a.next.stage) : ('#/' + a.next.plane);
      nextHtml = '<div class="ab-next"><div class="ab-next-t">下一步</div>' +
        '<a class="ab-next-link" href="' + href + '">' + (a.next.moduleId ? a.next.moduleId + ' · ' + a.next.title : a.next.title) + ' →</a>' +
        '<div class="ab-next-r">' + a.next.reason + '</div></div>';
    }

    var wrongHtml = '';
    if (a.wrong.length) {
      wrongHtml = '<div class="ab-wrong"><div class="kn-h">最近没过的关</div>' + a.wrong.map(function (w) {
        var href = '#/' + w.plane + '/' + w.moduleId + '/' + w.stage;
        return '<a class="ab-w" href="' + href + '"><span class="ab-w-p">' + w.plane + '</span>' +
          '<span class="ab-w-t">' + w.moduleId + ' ' + w.moduleTitle + '</span>' +
          '<span class="ab-w-s">' + w.stageTitle + '</span></a>';
      }).join('') + '</div>';
    }

    var empty = a.empty
      ? '<div class="ab-empty">还没有记录。先去 <a href="#/L0/M00/s1">M00 · 机房与机柜</a>' +
      ' 或 <a href="#/L1/M03/s1">M03 · PCIe 拓扑</a> 玩两关，这里就有数据了。<br>' +
      '这里只统计本机玩过的关卡，不做任何推测。</div>'
      : '';

    return '<div class="page">' +
      '<div class="crumb"><a href="#/">地图</a> / 能力雷达</div>' +
      '<div class="mod-head"><div><h1 class="ph">能力雷达</h1>' +
      '<p class="ps">按七个平面统计。掌握度 = 通关率 × 70 + 一次过率 × 30。<br>' +
      '一次过指的是"第一次提交就对"，它比"反复试出来"更能说明真的会。</p></div>' +
      '<div class="mod-side"><span class="ab-kpi">通关 <b>' + a.overall.done + '</b> / ' + a.overall.total + '</span>' +
      '<span class="ab-kpi">一次过 <b>' + a.overall.firstTry + '</b></span>' +
      '<span class="ab-kpi">提交 <b>' + a.overall.tries + '</b> 次</span>' +
      '<button class="btn ghost" id="btn-reset-progress">清空本机记录</button></div></div>' +
      empty +
      '<div class="abil">' +
      '<div class="panel ab-radar">' + radarSvg(a.planes) +
      '<div class="ab-legend">越靠外越熟。七个轴分别是七个平面，从 L0 场地到 L6 故障。</div></div>' +
      '<div class="panel ab-side">' + rows + nextHtml + '</div>' +
      '</div>' +
      wrongHtml +
      '</div>';
  }

  /* ---------------- X2 故障注入台 ---------------- */

  var labState = { c: null, cause: null, fix: null, seed: 0 };

  function labSolved() {
    var d = PROG.read();
    return Object.keys(d.modules || {}).filter(function (k) {
      return k.indexOf('X2:') === 0 && d.modules[k].ok > 0;
    }).length;
  }

  function labOpen(seed) {
    labState.seed = seed;
    labState.c = root.TopoLab.pick(seed);
    labState.cause = null;
    labState.fix = null;
  }

  /* 深链：#/lab/F19 直接打开某一卷，方便讲解和复核 */
  function labOpenById(id) {
    var c = root.TopoLab.byId(id);
    if (!c) { labOpen(DEFAULT_SEED); return; }
    labState.seed = DEFAULT_SEED;
    labState.c = c;
    labState.cause = null;
    labState.fix = null;
  }

  function labPhase() {
    if (labState.fix !== null) return 'result';
    if (labState.cause !== null) return 'fix';
    return 'cause';
  }

  function viewLab() {
    if (!labState.c) labOpen(DEFAULT_SEED);
    var c = labState.c;
    var tabs = c.symptom.map(function (t, i) {
      return '<button class="ttab' + (i === 0 ? ' on' : '') + '" data-tab="' + i + '">' + t.name + '</button>';
    }).join('');
    var panes = c.symptom.map(function (t, i) {
      return '<div class="term' + (i === 0 ? ' on' : '') + '" data-pane="' + i + '">' +
        '<pre class="tpre tpre-wrap">' + esc(t.text) + '</pre></div>';
    }).join('');

    /* 终端要认这一关：给它一个假的 view，现场来自案卷 */
    view = {
      lab: true,
      mod: { id: 'X2', title: '故障注入台' },
      stage: { key: c.id, title: c.title },
      scen: { world: c.world },
      mode: 'lab', world: null
    };

    var monNote = c.view === 'mon'
      ? '<div class="note">本卷的证据在<b>带外与监控</b>里：<code>ipmitool sdr</code>、' +
      '<code>ipmitool sel list</code>、<code>prom query</code>、<code>bill report</code>。主机 shell 看不到这些。</div>'
      : '<div class="note">现象只给到"用户看到的那一层"，剩下的要自己查。</div>';

    return '<div class="page lab-page">' +
      '<div class="crumb"><a href="#/">地图</a> / 故障注入台</div>' +
      '<div class="mod-head"><div>' +
      '<div class="mod-id">X2 · 案卷 ' + c.id + ' · ' + c.plane + '</div>' +
      '<h1 class="ph">' + c.title + '</h1>' +
      '<p class="ps">先看现象，再开终端取证，最后给根因和处置。<br>' +
      '根因错得 0 分；根因对但处置错，只能拿半分——查得出来和修得对，是两种能力。</p>' +
      '</div><div class="mod-side">' +
      '<span class="ab-kpi">已破 <b id="lab-solved">' + labSolved() + '</b> / ' + root.TopoLab.count + '</span>' +
      '<button class="btn" id="btn-lab-term">' + (c.view === 'mon' ? '取证终端（带外 + 监控）' : '取证终端') + '</button>' +
      '<button class="btn ghost" id="btn-lab-new">换一个案子</button>' +
      '</div></div>' +
      '<div class="work">' +
      '<section class="panel p-left"><div class="ttabs">' + tabs + '</div>' + panes +
      monNote + '</section>' +
      '<section class="panel p-mid"><div id="lab-q"></div></section>' +
      '<aside class="panel p-right" id="lab-side"></aside>' +
      '</div>' +
      '<div class="bar">' +
      '<button class="btn primary" id="btn-lab-submit">提交</button>' +
      '<span class="lab-step" id="lab-step"></span>' +
      '</div>' +
      '<div id="feedback"></div>' +
      '<div id="extra"></div>' +
      '</div>';
  }

  function paintLabSide(c) {
    var box = $('#lab-side');
    if (!box) return;
    var phase = labPhase();
    var stepTxt = phase === 'cause' ? '第 1 步 / 共 2 步 · 定根因'
      : phase === 'fix' ? '第 2 步 / 共 2 步 · 选处置'
        : '已结算';
    var el = $('#lab-step');
    if (el) el.textContent = stepTxt;

    if (phase !== 'result') {
      box.innerHTML = '<div class="side-h">这一关怎么过</div>' +
        '<div class="steps"><div>1 看现象，先判断是哪一层出事</div>' +
        '<div>2 开终端敲 1~2 条命令确认</div>' +
        '<div>3 选根因，再选处置</div></div>' +
        '<div class="mx-note">证据都在终端里。没查到就直接选，多半会中干扰项。</div>';
      return;
    }
    box.innerHTML = '<div class="side-h">证据链</div>' +
      c.chain.map(function (x) {
        return '<div class="lab-chain"><code>' + x.cmd + '</code><span>' + x.why + '</span></div>';
      }).join('') +
      '<div class="mx-note">这条链是从"现象"走到"根因"的最短路径，下次遇到同类问题照这个顺序查。</div>';
  }

  function mountLab() {
    var box = $('#lab-q');
    if (!box || !labState.c) return;
    var c = labState.c;
    var phase = labPhase();
    var submitBtn = $('#btn-lab-submit');
    if (submitBtn) submitBtn.style.display = phase === 'result' ? 'none' : '';
    if (phase === 'result') {
      box.innerHTML = '<div class="lab-result"><div class="lab-ok">本案已破</div>' +
        '<div class="lab-rt">' + c.title + '</div>' +
        '<div class="lab-rx">根因：' + c.cause.options[c.cause.answer][1].replace(/^正确。/, '') + '</div>' +
        '<div class="lab-rx">处置：' + c.fix.options[c.fix.answer][0] + '</div>' +
        '<button class="btn ghost" id="btn-lab-new2">再来一个</button></div>';
      paintLabSide(c);
      return;
    }
    var qs = phase === 'cause' ? c.cause : c.fix;
    box.innerHTML = (phase === 'fix' ? '<div class="lab-ok">根因已确认</div>' : '') +
      '<div class="lab-qt">' + qs.q + '</div><div id="lab-opts"></div>';
    labState.ctrl = root.TopoRenderChoice.mount($('#lab-opts'), {
      options: qs.options.map(function (o) { return { label: o[0], why: o[1] }; }),
      onPick: function () { }
    });
    paintLabSide(c);
  }

  function submitLab() {
    var c = labState.c;
    if (!c) return;
    if (labPhase() === 'result') { toast('本案已结算，换一个案子继续'); return; }
    if (!labState.ctrl) return;
    var pick = labState.ctrl.answer().pick;
    if (pick === null || pick === undefined) { toast('先选一个'); return; }
    var phase = labPhase();
    var res;
    if (phase === 'cause') {
      res = root.TopoLab.judge(c, { cause: pick, fix: null });
      if (res.ok || res.stage === 'pending') {
        labState.cause = pick;
        renderFeedback({ ok: false, head: '根因确认：' + c.cause.options[pick][0], items: [{ tone: 'info', title: '下一步', text: '现在选处置。注意：查得出来不等于修得对。' }] });
        mountLab();
        return;
      }
      renderFeedback(res);
      PROG.record('X2', c.id, false, { score: 0, tag: 'lab' });
      return;
    }
    res = root.TopoLab.judge(c, { cause: labState.cause, fix: pick });
    if (res.ok) {
      labState.fix = pick;
      renderFeedback(res);
      PROG.record('X2', c.id, true, { score: 1, tag: 'lab' });
      mountLab();
      unlockLab(c);
      var solved = $('#lab-solved');
      if (solved) solved.textContent = labSolved();
      return;
    }
    renderFeedback(res);
    PROG.record('X2', c.id, false, { score: res.score, tag: 'lab' });
  }

  function unlockLab(c) {
    var extra = $('#extra');
    if (!extra || extra.dataset.done) return;
    extra.dataset.done = '1';
    extra.innerHTML = '<div class="kn"><div class="kn-h">案卷笔记 · ' + c.id + '</div>' +
      '<div class="kn-sec"><h3>概念</h3><p>' + c.knowledge.concept + '</p></div>' +
      '<div class="kn-sec"><h3>最容易踩的坑</h3><p>' + c.knowledge.pitfall + '</p></div>' +
      '<div class="kn-sec"><h3>复查顺序</h3><ol>' + c.chain.map(function (x) {
        return '<li><code>' + x.cmd + '</code> —— ' + x.why + '</li>';
      }).join('') + '</ol></div></div>';
  }

  /* ---------------- 模块页 ---------------- */

  function currentStage(mod, key) {
    for (var i = 0; i < mod.stages.length; i++) {
      if (mod.stages[i].key === key) return mod.stages[i];
    }
    return mod.stages[0];
  }

  function viewModule(modId, stageKey) {
    var mod = REG.get(modId);
    if (!mod) {
      return '<div class="page"><div class="crumb"><a href="#/">地图</a></div>' +
        '<h1 class="ph">' + modId + ' 还没开工</h1>' +
        '<p class="ps">这个模块在设计表里，但代码还没写。按六步流程走，不铺空壳。</p></div>';
    }
    var stage = currentStage(mod, stageKey);
    var seed = state.seed[stageKeyOf(mod, stage)] || DEFAULT_SEED;
    var scen = stage.generate(seed, { hard: state.hard });
    state.hintLv[stageKeyOf(mod, stage)] = 0;

    var stageTabs = mod.stages.map(function (s) {
      return '<a class="stab' + (s.key === stage.key ? ' on' : '') + '" href="#/' + mod.plane + '/' + mod.id + '/' + s.key + '">' +
        '<span class="atom a-' + s.atom + '">' + s.atom + '</span>' + s.title + '</a>';
    }).join('');

    var pr = stage.prompt(scen);
    var tabs = pr.tabs.map(function (t, i) {
      return '<button class="ttab' + (i === 0 ? ' on' : '') + '" data-tab="' + i + '">' + t.name + '</button>';
    }).join('');
    var panes = pr.tabs.map(function (t, i) {
      /* 只有拓扑矩阵需要等宽不换行（Legend 是它的标志），日志类一律折行更好读 */
      var isMatrix = !t.html && String(t.text).indexOf('Legend:') >= 0;
      var body = t.html ? t.html
        : '<pre class="tpre' + (isMatrix ? '' : ' tpre-wrap') + '">' + esc(t.text) + '</pre>';
      return '<div class="term' + (i === 0 ? ' on' : '') + '" data-pane="' + i + '">' + body + '</div>';
    }).join('');

    view = { mod: mod, stage: stage, scen: scen, seed: seed, mode: null, world: null };
    history = [];
    future = [];

    var extra = '';
    /* 只有真支持两档难度的关卡才显示这个开关，别放一个按了没反应的控件 */
    if (stage.key === 's1' && mod.id === 'M03') {
      extra = '<label class="switch"><input type="checkbox" id="hard"' + (state.hard ? ' checked' : '') + '> 8 卡难版</label>';
    }

    return '<div class="page mod">' +
      '<div class="crumb"><a href="#/">地图</a> / <a href="#/' + mod.plane + '">' + mod.plane + '</a> / ' + mod.id + '</div>' +
      '<div class="mod-head">' +
      '<div><div class="mod-id">' + mod.id + '</div><h1 class="ph">' + mod.title + '</h1>' +
      '<p class="ps">' + mod.subtitle + '</p></div>' +
      '<div class="mod-side">' + extra + '<button class="btn ghost" id="btn-new">换一题</button></div>' +
      '</div>' +
      '<div class="stabs">' + stageTabs + '</div>' +
      '<div class="work">' +
      '<section class="panel p-left"><div class="ttabs">' + tabs + '</div>' + panes +
      '<div class="note">' + pr.note + '</div></section>' +
      '<section class="panel p-mid"><div id="mid"></div></section>' +
      '<aside class="panel p-right" id="side"></aside>' +
      '</div>' +
      '<div class="bar">' +
      '<button class="btn primary" id="btn-submit">提交比对</button>' +
      '<button class="btn" id="btn-hint">提示</button>' +
      '<button class="btn" id="btn-reset">重摆本题</button>' +
      '<button class="btn ghost" id="btn-undo"' + (stage.renderer === 'board' ? '' : ' disabled') + '>撤销</button>' +
      '<button class="btn ghost" id="btn-redo"' + (stage.renderer === 'board' ? '' : ' disabled') + '>重做</button>' +
      '<button class="btn ghost" id="btn-term" title="打开取证终端">终端</button>' +
      (stage.atom === 'B' ? '<span class="term-hint">拿不准就点终端，敲 help 用真机输出取证</span>' : '') +
      '<span class="seed">seed ' + seed + '</span>' +
      '</div>' +
      '<div id="feedback"></div>' +
      '<div id="extra"></div>' +
      '</div>';
  }

  function mountStage() {
    var mid = $('#mid');
    if (!mid || !view) return;
    var stage = view.stage;
    var spec = stage.renderSpec(view.scen);
    var ctx = {};
    Object.keys(spec.ctx).forEach(function (k) { ctx[k] = spec.ctx[k]; });

    if (spec.renderer === 'board') {
      ctx.beforeChange = pushHistory;
      /* 首次渲染发生在 mount 内部，此时 view.ctrl 还没拿到，必须挡一下 */
      ctx.onUpdate = function () { if (view.ctrl) paintSide(); };
      ctx.onChange = function () { };
    }
    if (spec.renderer === 'choice') {
      ctx.onPick = function () { paintSide(); };
    }

    view.mode = spec.renderer;
    view.ctrl = RENDERERS[spec.renderer].mount(mid, ctx);
    paintSide();
  }

  function paintSide() {
    var side = $('#side');
    if (!side || !view) return;
    var ans = view.ctrl && view.ctrl.answer ? view.ctrl.answer() : {};
    side.innerHTML = view.stage.side ? view.stage.side(view.scen, ans) : '';
  }

  function snap() {
    if (!view || view.mode !== 'board') return null;
    return JSON.stringify(view.scen.player);
  }

  function pushHistory() {
    if (view.mode !== 'board') return;
    var s = JSON.stringify(view.scen.player);
    if (history[history.length - 1] === s) return;
    history.push(s);
    if (history.length > 60) history.shift();
    future.length = 0;
  }

  function restore(str) {
    var next = JSON.parse(str);
    applyConfig(view.scen.player, next);
    view.ctrl.refresh(view.scen.player);
    paintSide();
  }

  /* 原地换内容，保证 renderer 手里的 cfg 引用与 scen.player 始终是同一个对象 */
  function applyConfig(target, next) {
    Object.keys(target).forEach(function (k) { delete target[k]; });
    Object.keys(next).forEach(function (k) { target[k] = next[k]; });
  }

  function doUndo() {
    if (view.mode !== 'board') return;
    if (!history.length) { toast('没有可撤销的步骤'); return; }
    future.push(JSON.stringify(view.scen.player));
    restore(history.pop());
  }

  function doRedo() {
    if (view.mode !== 'board') return;
    if (!future.length) { toast('没有可重做的步骤'); return; }
    var target = future.pop();
    history.push(JSON.stringify(view.scen.player));
    restore(target);
  }

  function renderFeedback(res) {
    var box = $('#feedback');
    if (!box) return;
    var items = (res.items || []).map(function (it) {
      return '<li class="fb-item ' + (it.tone || 'info') + '">' +
        '<div class="fb-t">' + it.title + '</div>' +
        (it.text ? '<div class="fb-x">' + it.text + '</div>' : '') + '</li>';
    }).join('');
    box.innerHTML = '<div class="fb ' + (res.ok ? 'ok' : 'bad') + '">' +
      '<div class="fb-head">' + esc(res.head) + '</div>' +
      (items ? '<ul class="fb-list">' + items + '</ul>' : '') + '</div>';
  }

  function unlock(stage) {
    var extra = $('#extra');
    if (!extra || extra.dataset.done) return;
    var mod = view.mod;
    var k = mod.knowledge;
    var quiz = mod.quiz(view.seed);
    state.quiz = { qs: quiz, picked: {} };

    var qHtml = quiz.map(function (q, i) {
      return '<div class="q" data-q="' + i + '"><div class="q-t">' + (i + 1) + '. ' + q.q + '</div>' +
        q.options.map(function (o, j) {
          return '<label class="q-o"><input type="radio" name="q' + i + '" value="' + j + '"><span>' +
            String.fromCharCode(65 + j) + '. ' + o + '</span></label>';
        }).join('') + '</div>';
    }).join('');

    extra.dataset.done = '1';
    extra.innerHTML = '<div class="kn">' +
      '<div class="kn-h">知识卡 · ' + mod.id + ' ' + mod.title + '</div>' +
      '<div class="kn-sec"><h3>是什么</h3><p>' + k.concept + '</p></div>' +
      '<div class="kn-sec"><h3>为什么长这样</h3><p>' + k.why + '</p></div>' +
      '<div class="kn-sec"><h3>三个常见的坑</h3><ol>' + k.pitfalls.map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ol></div>' +
      '<div class="kn-sec"><h3>自己验证一次</h3><p class="mono">' + k.verify + '</p></div>' +
      '</div>' +
      '<div class="quiz" id="quiz"><div class="kn-h">过关小测 · ' + quiz.length + ' 题</div>' + qHtml +
      '<button class="btn primary" id="btn-quiz">判卷</button><div id="quiz-res"></div></div>';
  }

  function checkQuiz() {
    var qs = state.quiz.qs;
    var right = 0;
    var detail = [];
    qs.forEach(function (q, i) {
      var picked = document.querySelector('input[name="q' + i + '"]:checked');
      var v = picked ? Number(picked.value) : -1;
      if (v === q.answer) right++;
      detail.push('<div class="qr ' + (v === q.answer ? 'ok' : 'bad') + '">' +
        '<b>' + (i + 1) + '. ' + (v === q.answer ? '对' : '错') + '</b> ' + q.why + '</div>');
    });
    var box = $('#quiz-res');
    box.innerHTML = '<div class="qr-head">答对 ' + right + ' / ' + qs.length + '</div>' + detail.join('');
  }

  function submit() {
    if (!view) return;
    var ans = view.ctrl.answer();
    var res = view.stage.judge(view.scen, ans);
    renderFeedback(res);
    PROG.record(view.mod.id, view.stage.key, res.ok, { score: res.score, tag: view.stage.key });
    if (res.ok) unlock(view.stage);
  }

  /* ---------------- 路由 ---------------- */

  function route() {
    var parts = String(location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    var app = $('#app');
    if (!parts.length) {
      view = null;
      app.innerHTML = viewMap();
      return;
    }
    if (parts[0] === 'lab' && parts.length === 2) {
      view = null;
      labOpenById(parts[1]);
      app.innerHTML = viewLab();
      mountLab();
      $('#feedback').innerHTML = '';
      $('#extra').innerHTML = '';
      delete $('#extra').dataset.done;
      return;
    }
    if (parts.length === 1) {
      view = null;
      if (parts[0] === 'ability') {
        app.innerHTML = viewAbility();
        return;
      }
      if (parts[0] === 'lab') {
        app.innerHTML = viewLab();
        mountLab();
        return;
      }
      app.innerHTML = viewPlane(parts[0]);
      return;
    }
    state.hintLv = {};
    app.innerHTML = viewModule(parts[1], parts[2]);
    if (!view) return;
    mountStage();
    var rec = PROG.stageRecord(view.mod.id, view.stage.key);
    if (rec && rec.ok > 0) unlock(view.stage);
  }

  /* ---------------- 事件 ---------------- */

  /* 终端 DOM 由脚本兜底注入：index.html 里有就不重复建，测试页里没有也能用 */
  function ensureConsoleDom() {
    if (document.getElementById('con')) return;
    var d = document.createElement('div');
    d.className = 'con';
    d.id = 'con';
    d.innerHTML = '<div class="con-head">' +
      '<span class="con-t">取证终端 <em id="con-host">-</em></span>' +
      '<span class="con-hint">help 看命令 · Esc 收起</span>' +
      '<button class="con-x" id="con-close">收起</button>' +
      '</div>' +
      '<div class="con-out" id="con-out"></div>' +
      '<form class="con-in" id="con-form">' +
      '<span class="con-p">$</span>' +
      '<input id="con-cmd" autocomplete="off" spellcheck="false" placeholder="nvidia-smi topo -m">' +
      '<button class="btn ghost" type="submit">执行</button>' +
      '</form>';
    document.body.appendChild(d);
  }

  function bind() {
    ensureConsoleDom();
    document.addEventListener('click', function (e) {
      var mapRow = e.target.closest('.map-row');
      if (mapRow) {
        var key = mapRow.getAttribute('data-plane');
        var plane = REG.planes().filter(function (p) { return p.key === key; })[0];
        var anyOpen = plane.modules.some(function (m) { return m.open; });
        if (!anyOpen) { toast(plane.name + ' 这一层还在排队，没写完不放出来。'); return; }
        location.hash = '#/' + key;
        return;
      }
      var card = e.target.closest('.card');
      if (card) {
        if (card.classList.contains('soon')) { toast('这个模块还没开工。'); return; }
        var cid = card.getAttribute('data-mod');
        var entry = REG.catalogEntry(cid);
        location.hash = '#/' + (entry ? entry.plane : 'L1') + '/' + cid;
        return;
      }
      var tab = e.target.closest('.ttab');
      if (tab) {
        var i = tab.getAttribute('data-tab');
        document.querySelectorAll('.ttab').forEach(function (t) { t.classList.remove('on'); });
        document.querySelectorAll('.term').forEach(function (p) { p.classList.remove('on'); });
        tab.classList.add('on');
        var pane = document.querySelector('.term[data-pane="' + i + '"]');
        if (pane) pane.classList.add('on');
        return;
      }
      if (e.target.id === 'btn-submit') { submit(); return; }
      if (e.target.id === 'btn-hint') {
        var lv = state.hintLv[stageKeyOf(view.mod, view.stage)] || 0;
        var text = view.stage.hint(view.scen, view.ctrl.answer(), lv);
        state.hintLv[stageKeyOf(view.mod, view.stage)] = Math.min(lv + 1, 2);
        renderFeedback({ ok: false, head: '提示', items: [{ tone: 'warn', title: '第 ' + (lv + 1) + ' 层提示', text: text }] });
        return;
      }
      if (e.target.id === 'btn-reset') {
        if (view.stage.key === 's1') {
          pushHistory();
          applyConfig(view.scen.player, root.TopoModel.blankConfig(view.scen.machine));
          view.ctrl.refresh(view.scen.player);
          paintSide();
          $('#feedback').innerHTML = '';
          toast('已清空拼装区');
        } else {
          toast('这一关没有可重置的状态，直接改答案即可');
        }
        return;
      }
      if (e.target.id === 'btn-undo') { doUndo(); return; }
      if (e.target.id === 'btn-redo') { doRedo(); return; }
      if (e.target.id === 'btn-new') {
        var s = Math.floor(Math.random() * 900000) + 1000;
        state.seed[stageKeyOf(view.mod, view.stage)] = s;
        state.hintLv[stageKeyOf(view.mod, view.stage)] = 0;
        route();
        return;
      }
      if (e.target.id === 'btn-quiz') { checkQuiz(); return; }
      if (e.target.id === 'btn-term') { openConsole(); return; }
      if (e.target.id === 'btn-lab-submit') { submitLab(); return; }
      if (e.target.id === 'btn-lab-term') { openConsole(); return; }
      if (e.target.id === 'btn-lab-new' || e.target.id === 'btn-lab-new2') {
        labOpen(Math.floor(Math.random() * 900000) + 1000);
        $('#feedback').innerHTML = '';
        $('#extra').innerHTML = '';
        delete $('#extra').dataset.done;
        /* 深链进来看的案子，换一个时要先把 hash 退回 #/lab，否则路由又拉回原来那卷 */
        if (location.hash.indexOf('#/lab/') === 0) location.hash = '#/lab';
        else route();
        return;
      }
      if (e.target.id === 'btn-reset-progress') {
        if (e.target.dataset.armed) { PROG.reset(); toast('已清空本机记录'); route(); }
        else { e.target.dataset.armed = '1'; e.target.textContent = '再点一次确认清空'; }
        return;
      }
      if (e.target.id === 'con-close') { closeConsole(); return; }
    });

    document.addEventListener('change', function (e) {
      if (e.target.id === 'hard') {
        state.hard = e.target.checked;
        state.seed[stageKeyOf(view.mod, view.stage)] = DEFAULT_SEED;
        route();
      }
    });

    var conForm = $('#con-form');
    if (conForm) {
      conForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = $('#con-cmd');
        var cmd = input.value;
        input.value = '';
        runConsole(cmd);
      });
    }

    var conInput = $('#con-cmd');
    if (conInput) {
      conInput.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!conHistory.length) return;
          conHistoryAt = Math.max(0, conHistoryAt - 1);
          conInput.value = conHistory[conHistoryAt] || '';
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          conHistoryAt = Math.min(conHistory.length, conHistoryAt + 1);
          conInput.value = conHistory[conHistoryAt] || '';
        }
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeConsole();
      if (!view) return;
      var meta = e.ctrlKey || e.metaKey;
      if (meta && e.key === 'z') { e.preventDefault(); doUndo(); }
      if (meta && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); doRedo(); }
      if (e.key === 'Enter' && (e.target.tagName === 'INPUT' && e.target.classList.contains('calc-i'))) {
        e.preventDefault();
        submit();
      }
    });

    window.addEventListener('hashchange', route);
  }

  /* ---------------- X1 取证终端 ---------------- */

  var conHistory = [];
  var conHistoryAt = -1;

  function conEl(id) { return document.getElementById(id); }

  function openConsole() {
    var con = conEl('con');
    if (!con) return;
    con.classList.add('on');
    syncConsole();
    var input = conEl('con-cmd');
    if (input) input.focus();
  }

  function closeConsole() {
    var con = conEl('con');
    if (con) con.classList.remove('on');
  }

  /* 换关就换现场：同一关反复打开保持历史 */
  function syncConsole() {
    if (!view) return;
    var key = view.mod.id + ':' + view.stage.key;
    var con = conEl('con');
    if (!con) return;
    if (con.dataset.key === key) return;
    con.dataset.key = key;
    if (!view.world) view.world = root.TopoConsole.worldFor(view.scen);
    var host = conEl('con-host');
    if (host) host.textContent = (view.mod.id + ' · ' + view.stage.title);
    var out = conEl('con-out');
    if (out) {
      out.innerHTML = '';
      conPrint(root.TopoConsole.banner(view.world), 'con-note');
    }
    conHistory = [];
    conHistoryAt = -1;
  }

  function conPrint(text, cls) {
    var out = conEl('con-out');
    if (!out) return;
    var div = document.createElement('div');
    div.className = 'con-block ' + (cls || '');
    div.textContent = text;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }

  function runConsole(cmd) {
    if (!view) return;
    syncConsole();
    var raw = String(cmd || '').trim();
    if (!raw) return;
    conHistory.push(raw);
    conHistoryAt = conHistory.length;
    conPrint('$ ' + raw, 'con-echo');
    if (!view.world) view.world = root.TopoConsole.worldFor(view.scen);
    var res = root.TopoConsole.exec(raw, view.world);
    if (res.clear) {
      var out = conEl('con-out');
      if (out) out.innerHTML = '';
      return;
    }
    if (res.text) conPrint(res.text);
  }

  function boot() {
    bind();
    if (!location.hash) location.hash = '#/';
    route();
    window.__campus = { state: state, view: function () { return view; }, route: route, lab: function () { return labState; } };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
