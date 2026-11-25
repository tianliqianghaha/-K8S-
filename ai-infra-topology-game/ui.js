(function () {
  'use strict';

  var E = window.TopoEngine;
  var STORE_KEY = 'aiInfraTopoPuzzle.progress';
  var $ = function (sel) { return document.querySelector(sel); };

  var state = {
    level: 1,
    seed: 0,
    machine: null,
    player: null,
    truthMatrix: null,
    scenario: null,
    players: null,
    playerBindings: null,
    cluster: null,
    allocation: null,
    quiz: [],
    history: [],
    future: [],
    dragging: null,
    progress: loadProgress()
  };

  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && Array.isArray(p['1']) && Array.isArray(p['2'])) {
          if (!Array.isArray(p['3'])) p['3'] = [];
          return p;
        }
      }
    } catch (e) { /* file:// may block storage */ }
    return { '1': [], '2': [], '3': [] };
  }

  function saveProgress() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.progress)); } catch (e) { /* ignore */ }
  }

  function prefixOf(scope) { return scope === null ? '' : (scope === 0 ? 'A-' : 'B-'); }
  function tprefixOf(scope) { return scope === null ? '' : (scope === 0 ? 'M0-' : 'M1-'); }

  function scopeOf(x) {
    if (!x) return null;
    if (x.indexOf('A-') === 0 || x.indexOf('M0-') === 0) return 0;
    if (x.indexOf('B-') === 0 || x.indexOf('M1-') === 0) return 1;
    return null;
  }

  function realId(x) {
    return String(x).replace(/^[AB]-/, '').replace(/^M\d+-/, '');
  }

  function configOf(scope) {
    return scope === null ? state.player : state.players[scope];
  }

  function typeOf(id) {
    if (/^CPU\d+$/.test(id)) return 'cpu';
    if (/^B[A-Za-z0-9]*$/.test(id)) return 'bridge';
    if (/^S[A-Za-z0-9]*$/.test(id)) return 'switch';
    if (/^GPU\d+$/.test(id)) return 'gpu';
    if (/^NIC\d+$/.test(id)) return 'nic';
    return 'unknown';
  }

  function parentOf(id) {
    var scope = scopeOf(id);
    var r = realId(id);
    var c = configOf(scope);
    if (!c) return null;
    var t = typeOf(r);
    var p;
    if (t === 'cpu') p = c.cpuPlacement[r];
    else if (t === 'bridge') p = c.bridges[r];
    else if (t === 'switch') p = c.switches[r];
    else p = c.devices[r] ? c.devices[r].parent : null;
    if (p === null || p === undefined) return null;
    if (typeof p === 'number') return p;
    return prefixOf(scope) + p;
  }

  function isDescendant(candidate, ancestor) {
    var cur = candidate;
    var seen = {};
    while (cur && !seen[cur]) {
      if (cur === ancestor) return true;
      seen[cur] = true;
      cur = parentOf(cur);
    }
    return false;
  }

  function canDrop(dragId, target) {
    if (!dragId || !target) return false;
    if (target === 'TRAY') return true;
    if (state.level === 3) {
      var f = state.cluster.flows.find(function (x) { return x.id === dragId; });
      var pm = /^P(\d)-([01])$/.exec(target);
      if (!f || !pm) return false;
      var mi = parseInt(pm[1], 10);
      var ni = parseInt(pm[2], 10);
      return mi === f.src && state.cluster.machines[mi].nics[ni].bw > 0;
    }
    if (state.level === 2 && scopeOf(dragId) !== scopeOf(target)) return false;
    var dt = typeOf(realId(dragId));
    var tr = realId(target);
    var tt = tr.indexOf('NUMA:') === 0 ? 'numa' : typeOf(tr);
    var ok = false;
    if (dt === 'cpu') ok = tt === 'numa';
    else if (dt === 'bridge') ok = tt === 'cpu';
    else if (dt === 'switch') ok = tt === 'bridge' || tt === 'switch';
    else ok = tt === 'switch' || tt === 'bridge';
    if (!ok) return false;
    if (dt === 'switch' && tt === 'switch' && isDescendant(target, dragId)) return false;
    if (target === dragId) return false;
    return true;
  }

  function captureState() {
    if (state.level === 1) return { player: state.player };
    if (state.level === 3) return { allocation: state.allocation };
    return { players: state.players, bindings: state.playerBindings };
  }

  function restoreState(snap) {
    if (state.level === 1) state.player = snap.player;
    else if (state.level === 3) state.allocation = snap.allocation;
    else {
      state.players = snap.players;
      state.playerBindings = snap.bindings;
    }
  }

  function snapshot() {
    state.history.push(JSON.stringify(captureState()));
    if (state.history.length > 60) state.history.shift();
    state.future.length = 0;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    var u = document.getElementById('btn-undo');
    var r = document.getElementById('btn-redo');
    if (u) u.disabled = state.history.length === 0;
    if (r) r.disabled = state.future.length === 0;
  }

  function undo() {
    if (!state.history.length) return false;
    state.future.push(JSON.stringify(captureState()));
    restoreState(JSON.parse(state.history.pop()));
    renderAll();
    updateHistoryButtons();
    return true;
  }

  function redo() {
    if (!state.future.length) return false;
    state.history.push(JSON.stringify(captureState()));
    restoreState(JSON.parse(state.future.pop()));
    renderAll();
    updateHistoryButtons();
    return true;
  }

  function setParent(id, target) {
    if (state.level === 3) {
      if (target === 'TRAY') {
        if (state.allocation[id] === undefined) return false;
        snapshot();
        delete state.allocation[id];
        return true;
      }
      var pm = /^P(\d)-([01])$/.exec(target);
      if (!pm) return false;
      var ni = parseInt(pm[2], 10);
      if (state.allocation[id] === ni) return false;
      snapshot();
      state.allocation[id] = ni;
      return true;
    }
    var scope = scopeOf(id);
    var r = realId(id);
    var c = configOf(scope);
    var t = typeOf(r);
    var tr = realId(target);
    var value = target === 'TRAY' ? null : tr;
    var next = t === 'cpu'
      ? (target === 'TRAY' ? null : parseInt(tr.split(':')[1], 10))
      : (target === 'TRAY' ? null : prefixOf(scope) + value);
    if (parentOf(id) === next) return false;
    snapshot();
    if (t === 'cpu') c.cpuPlacement[r] = next;
    else if (t === 'bridge') c.bridges[r] = value;
    else if (t === 'switch') c.switches[r] = value;
    else c.devices[r].parent = value;
    return true;
  }

  function nodeHtml(id) {
    var r = realId(id);
    var t = typeOf(r);
    var label = r;
    var title = '';
    if (t === 'gpu') title = '80GB 显存 · 700W 功耗上限';
    if (t === 'nic') title = '400G 网卡';
    if (t === 'bridge') label += ' 主桥';
    if (t === 'switch') label += ' PCIe交换';
    return '<div class="node ' + t + '" data-drag="' + id + '" data-drop="' + id +
      '" draggable="true" title="' + title + '">' + label + '</div>';
  }

  function bindingHtml(gpu, scope) {
    var cur = state.playerBindings[scope][gpu];
    var machine = state.scenario.machines[scope];
    var html = '<div class="bind-row">';
    ['NIC0', 'NIC1'].forEach(function (nic) {
      html += '<button class="bind-btn ' + (cur === nic ? 'sel' : '') +
        '" title="走 ' + nic + '" data-bind-m="' + scope + '" data-bind-g="' + gpu +
        '" data-bind-n="' + nic + '">N' + nic.charAt(3) + '</button>';
    });
    var rel = cur ? E.bindingRelation(machine, gpu, cur) : '未选';
    html += '<span class="bind-rel">' + rel + '</span></div>';
    return html;
  }

  function deviceCellHtml(id, scope) {
    if (scope === null || typeOf(realId(id)) !== 'gpu') return nodeHtml(id);
    return '<div class="gpu-cell">' + nodeHtml(id) + bindingHtml(realId(id), scope) + '</div>';
  }

  function cpuGroupHtml(cpu, scope) {
    var c = configOf(scope);
    var prefix = prefixOf(scope);
    var bridges = Object.keys(c.bridges).filter(function (b) { return c.bridges[b] === realId(cpu); });
    var html = '<div class="cpu-group">' + nodeHtml(cpu) + '<div class="columns" data-drop="' + cpu + '">';
    bridges.forEach(function (b) { html += columnHtml(prefix + b, scope); });
    if (bridges.length === 0) html += '<span class="drop-hint" data-drop="' + cpu + '">拖主桥到这里</span>';
    html += '</div></div>';
    return html;
  }

  function columnHtml(bridge, scope) {
    var c = configOf(scope);
    var prefix = prefixOf(scope);
    var r = realId(bridge);
    var switches = Object.keys(c.switches).filter(function (s) { return c.switches[s] === r; });
    var direct = Object.keys(c.devices).filter(function (d) { return c.devices[d].parent === r; });
    var html = '<div class="column">' + nodeHtml(bridge);
    switches.forEach(function (s) { html += switchBlockHtml(prefix + s, scope); });
    if (direct.length) {
      html += '<div class="dev-row" data-drop="' + bridge + '">';
      direct.forEach(function (d) { html += deviceCellHtml(prefix + d, scope); });
      html += '</div>';
    }
    if (switches.length === 0 && direct.length === 0) {
      html += '<span class="drop-hint" data-drop="' + bridge + '">拖交换芯片或卡到这里</span>';
    }
    html += '</div>';
    return html;
  }

  function switchBlockHtml(sw, scope) {
    var c = configOf(scope);
    var prefix = prefixOf(scope);
    var r = realId(sw);
    var children = Object.keys(c.switches).filter(function (s) { return c.switches[s] === r; });
    var devs = Object.keys(c.devices).filter(function (d) { return c.devices[d].parent === r; });
    var html = '<div class="switch-block">' + nodeHtml(sw);
    html += '<div class="dev-row" data-drop="' + sw + '">';
    devs.forEach(function (d) { html += deviceCellHtml(prefix + d, scope); });
    children.forEach(function (s) { html += switchBlockHtml(prefix + s, scope); });
    if (devs.length === 0 && children.length === 0) {
      html += '<span class="drop-hint" data-drop="' + sw + '">拖卡到这里</span>';
    }
    html += '</div></div>';
    return html;
  }

  function nvlinkBaseHtml(c) {
    var count = Math.min(4, E.deviceIds(c).filter(function (d) { return c.devices[d].type === 'gpu'; }).length);
    var html = '<div class="nvlink-base"><div class="nvlink-title">NVLink 底板 · ' +
      c.nvlink.links + ' 条链路 · 卡卡两两全连通（不过 CPU）</div><div class="nvswitch-row">';
    for (var i = 0; i < count; i++) html += '<span class="nvswitch">NVSwitch ' + i + '</span>';
    html += '</div></div>';
    return html;
  }

  function machineBoardHtml(c, scope) {
    var prefix = prefixOf(scope);
    var tprefix = tprefixOf(scope);
    var html = '';
    var n = c.meta.cpuCount;
    for (var numa = 0; numa < n; numa++) {
      html += '<div class="building" data-drop="' + tprefix + 'NUMA:' + numa + '">';
      html += '<div class="building-title">楼 ' + (numa === 0 ? 'A' : 'B') + ' · NUMA ' + numa +
        '（' + (numa === 0 ? '0-47' : '48-95') + '）</div>';
      var cpus = Object.keys(c.cpuPlacement).filter(function (x) { return c.cpuPlacement[x] === numa; });
      cpus.forEach(function (x) { html += cpuGroupHtml(prefix + x, scope); });
      if (cpus.length === 0) {
        html += '<span class="drop-hint" data-drop="' + tprefix + 'NUMA:' + numa + '">把 CPU 拖进这栋楼</span>';
      }
      html += '</div>';
    }
    if (c.nvlink.enabled) {
      html += '<div class="nvlink-stub">↓ 所有 GPU 走 NVLink 底板，两两全连通</div>' + nvlinkBaseHtml(c);
    }
    return html;
  }

  function trayHtml() {
    var html = '';
    if (state.level === 3) {
      state.cluster.flows.forEach(function (f) {
        if (state.allocation[f.id] === undefined) {
          html += '<span class="flow-chip" data-drag="' + f.id + '" draggable="true">' +
            f.id + ' · ' + f.from + '→' + f.to + ' · ' + f.size + 'G</span>';
        }
      });
      return html || '<span class="drop-hint">全部分配好了</span>';
    }
    if (state.level === 1) {
      var c = state.player;
      Object.keys(c.cpuPlacement).forEach(function (id) { if (c.cpuPlacement[id] === null) html += simpleNode(id); });
      Object.keys(c.bridges).forEach(function (id) { if (c.bridges[id] === null) html += simpleNode(id); });
      Object.keys(c.switches).forEach(function (id) { if (c.switches[id] === null) html += simpleNode(id); });
      Object.keys(c.devices).forEach(function (id) { if (c.devices[id].parent === null) html += simpleNode(id); });
    } else {
      state.players.forEach(function (c, scope) {
        var prefix = prefixOf(scope);
        Object.keys(c.cpuPlacement).forEach(function (id) { if (c.cpuPlacement[id] === null) html += simpleNode(prefix + id); });
        Object.keys(c.bridges).forEach(function (id) { if (c.bridges[id] === null) html += simpleNode(prefix + id); });
        Object.keys(c.switches).forEach(function (id) { if (c.switches[id] === null) html += simpleNode(prefix + id); });
        Object.keys(c.devices).forEach(function (id) { if (c.devices[id].parent === null) html += simpleNode(prefix + id); });
      });
    }
    return html || '<span class="drop-hint">全部归位了</span>';
  }

  function simpleNode(id) {
    return '<div class="node ' + typeOf(realId(id)) + '" data-drag="' + id + '" draggable="true">' + id + '</div>';
  }

  function renderBoard() {
    var html = '';
    if (state.level === 3) {
      var ev = E.evaluateCluster(state.cluster, state.allocation);
      html = '<div class="cluster-grid">';
      state.cluster.machines.forEach(function (m, mi) {
        html += '<div class="machine-card"><div class="machine-title">节点 ' + m.id +
          ' · NVLink ' + m.nvlink + ' 条</div>';
        m.nics.forEach(function (nic, ni) {
          var key = 'P' + mi + '-' + ni;
          var load = ev.loads[mi][ni];
          var time = ev.times[mi][ni];
          var bi = ev.bottleneck === (mi * 2 + ni) && ev.total > 0;
          var statusClass = nic.status === 'down' ? 'bad' : (nic.status === 'degraded' ? 'warn' : 'ok');
          html += '<div class="port-slot' + (bi ? ' is-bottleneck' : '') + '" data-drop="' + key + '">';
          html += '<div class="port-head"><span class="port-name">' + nic.id +
            '</span><span class="port-status ' + statusClass + '">' +
            E.clusterPortText(state.cluster, mi, ni) + '</span></div>';
          html += '<div class="port-flows">';
          state.cluster.flows.forEach(function (f) {
            if (state.allocation[f.id] === ni && f.src === mi) {
              html += '<span class="flow-chip" data-drag="' + f.id + '" draggable="true">' +
                f.id + ' ' + f.size + 'G</span>';
            }
          });
          html += '</div>';
          html += '<div class="load-bar"><div class="load-fill" style="width:' +
            Math.min(100, load / Math.max(nic.bw, 1) * 100) + '%"></div></div>';
          html += '<div class="port-meta">负载 ' + load + ' GB · ' +
            (isFinite(time) ? time.toFixed(2) : '∞') + ' s</div>';
          html += '</div>';
        });
        html += '</div>';
      });
      html += '</div><div class="cluster-note">每条流只能放到它源机器的网卡上；故障端口不可用。把流拖回下方托盘可取消分配。</div>';
      $('#board').innerHTML = html;
      $('#tray').innerHTML = trayHtml();
      return;
    }
    if (state.level === 1) {
      html = machineBoardHtml(state.player, null);
    } else {
      ['节点 A', '节点 B'].forEach(function (name, i) {
        html += '<div class="machine-wrap"><div class="machine-title">' + name + ' · 8 卡双路 · 修好内部拓扑后给每张卡选网卡</div>';
        html += machineBoardHtml(state.players[i], i);
        html += '</div>';
      });
      html += '<div class="tor-bar">TOR 交换机 · 节点 A 的 NIC0 / NIC1  ↔  节点 B 的 NIC0 / NIC1</div>';
      html += '<div class="bind-summary">绑定旁的记号是这张卡到所选网卡的远近：PIX 最近，SYS 最远。</div>';
    }
    $('#board').innerHTML = html;
    $('#tray').innerHTML = trayHtml();
  }

  function renderPlayerTopo() {
    if (state.level === 3) {
      var r = E.evaluateCluster(state.cluster, state.allocation);
      var lines = [];
      state.cluster.machines.forEach(function (m, mi) {
        m.nics.forEach(function (nic, ni) {
          var t = r.times[mi * 2 + ni];
          lines.push('节点' + m.id + ' ' + nic.id + '  ' + r.loads[mi][ni] + ' GB / ' +
            nic.bw + ' GB/s = ' + (isFinite(t) ? t.toFixed(2) : '∞') + ' s' +
            (r.bottleneck === mi * 2 + ni && r.total > 0 ? '  ← 瓶颈' : ''));
        });
      });
      lines.push('');
      lines.push('整轮耗时：' + (isFinite(r.total) ? r.total.toFixed(2) : '∞') + ' s');
      lines.push('最优耗时：' + state.cluster.bestTime.toFixed(2) + ' s');
      lines.push('目标：不超过最优的 1.05 倍');
      $('#player-topo').textContent = lines.join('\n');
      return;
    }
    if (state.level === 1) {
      $('#player-topo').textContent = E.formatTopo(state.player);
      return;
    }
    $('#player-topo').textContent = '=== 节点 A ===\n' + E.formatTopo(state.players[0]) +
      '\n\n=== 节点 B ===\n' + E.formatTopo(state.players[1]);
  }

  function renderCommand(tab) {
    var text = '';
    if (state.level === 3) {
      if (tab === 'topo') text = E.formatClusterCommand(state.cluster);
      else if (tab === 'lscpu') {
        text = '4 台机器 × 每台 8 卡双路 × 2 张 400G 网卡\n' +
          'NUMA 0：GPU0-3 + NIC0\nNUMA 1：GPU4-7 + NIC1\n' +
          '400 Gb/s 除以 8，约 50 GB/s。';
      } else text = E.formatClusterCommand(state.cluster);
    } else if (state.level === 1) {
      if (tab === 'topo') text = E.formatTopo(state.machine);
      else if (tab === 'lscpu') text = E.formatLscpu(state.machine);
      else text = E.formatNvidiaSmi(state.machine);
    } else {
      var a = state.scenario.machines[0], b = state.scenario.machines[1];
      if (tab === 'topo') text = E.formatScenarioCommand(state.scenario);
      else if (tab === 'lscpu') text = '=== 节点 A ===\n' + E.formatLscpu(a) + '\n\n=== 节点 B ===\n' + E.formatLscpu(b);
      else text = '=== 节点 A ===\n' + E.formatNvidiaSmi(a) + '\n\n=== 节点 B ===\n' + E.formatNvidiaSmi(b);
    }
    $('#cmd-output').textContent = text;
  }

  function renderProgress() {
    $('#progress').textContent = '已解 L1 ' + state.progress['1'].length +
      ' · L2 ' + state.progress['2'].length + ' · L3 ' + state.progress['3'].length + ' 题';
  }

  function renderQuiz() {
    var html = '';
    state.quiz.forEach(function (q, i) {
      html += '<div class="quiz-item"><div>' + (i + 1) + '. ' + q.q + '</div>';
      q.options.forEach(function (o, j) {
        html += '<label><input type="radio" name="q' + i + '" value="' + j + '"> ' + o + '</label>';
      });
      html += '</div>';
    });
    $('#quiz-items').innerHTML = html;
    $('#quiz-result').innerHTML = '';
    $('#quiz').hidden = false;
  }

  function explainDiff(d) {
    if (d.actual === '?') return d.a + ' 与 ' + d.b + ' 还有零件没放好，先把所有零件归位。';
    var tips = {
      SYS: '它们在两颗 CPU 下面，要分到两栋楼',
      NODE: '同一颗 CPU、不同主桥',
      PIX: '挂在同一颗交换芯片下面',
      PXB: '同一主桥下、走了不同交换芯片',
      PHB: '同一个主桥，其中一个直接挂在桥上'
    };
    return d.a + ' → ' + d.b + ' 应该是 ' + d.expected + '，你摆成了 ' + d.actual +
      (tips[d.expected] ? '：' + tips[d.expected] : '');
  }

  function submit() {
    if (state.level === 3) {
      var assigned = Object.keys(state.allocation).length;
      if (assigned !== state.cluster.flows.length) {
        $('#feedback').className = 'feedback bad';
        $('#feedback').textContent = '还有 ' + (state.cluster.flows.length - assigned) +
          ' 条流没分配，先把所有流放到端口上。';
        return false;
      }
      var r = E.evaluateCluster(state.cluster, state.allocation);
      if (!isFinite(r.total)) {
        $('#feedback').className = 'feedback bad';
        $('#feedback').textContent = '有流放到了故障端口，数据发不出去。把它拖回托盘再换一块网卡。';
        return false;
      }
      var target = state.cluster.bestTime * 1.05;
      if (r.total <= target) {
        return win('调度达标：整轮 ' + r.total.toFixed(2) + 's，最优 ' +
          state.cluster.bestTime.toFixed(2) + 's。最窄的一段已经压到最短。');
      }
      var bm = Math.floor(r.bottleneck / 2), bn = r.bottleneck % 2;
      $('#feedback').className = 'feedback bad';
      $('#feedback').innerHTML = '<strong>整轮 ' + r.total.toFixed(2) + 's，超出目标 ' +
        target.toFixed(2) + 's。</strong><div class="diff-item">瓶颈在节点' +
        state.cluster.machines[bm].id + ' 的 NIC' + bn +
        '：把大流挪到同机器另一块网卡，或避开降速端口。</div>';
      return false;
    }
    if (state.level === 1) {
      var diffs = E.compareMatrix(state.truthMatrix, E.buildMatrix(state.player));
      if (diffs.length === 0) return win('拓扑完全正确。你摆出的表和题目逐格一致。顺手核对下面几个数：');
      $('#feedback').className = 'feedback bad';
      var html = '<strong>还有 ' + diffs.length + ' 格对不上。</strong>按这几条改：';
      diffs.slice(0, 6).forEach(function (d) { html += '<div class="diff-item">' + explainDiff(d) + '</div>'; });
      if (diffs.length > 6) html += '<div class="diff-item">……其余 ' + (diffs.length - 6) + ' 格同类问题</div>';
      $('#feedback').innerHTML = html;
      return false;
    }

    var player = {
      matrices: [E.buildMatrix(state.players[0]), E.buildMatrix(state.players[1])],
      bindings: state.playerBindings
    };
    var result = E.compareScenario(state.scenario, player);
    if (result.ok) return win('两台机器的拓扑和 16 张卡的网卡绑定全部正确。跨机通信都走最近的路。');
    $('#feedback').className = 'feedback bad';
    var out = '<strong>还有 ' + result.topologyDiffs.length + ' 格拓扑、' + result.bindingDiffs.length + ' 张卡选错网卡。</strong>';
    result.topologyDiffs.slice(0, 4).forEach(function (d) {
      out += '<div class="diff-item">节点' + (d.machine === 0 ? 'A' : 'B') + '：' + explainDiff(d) + '</div>';
    });
    result.bindingDiffs.slice(0, 8).forEach(function (d) {
      out += '<div class="diff-item">节点' + (d.machine === 0 ? 'A' : 'B') + ' 的 ' + d.gpu +
        ' 应走 ' + d.expected + '，你选了 ' + d.actual + '：走反了每次跨机都要跨楼。</div>';
    });
    $('#feedback').innerHTML = out;
    return false;
  }

  function win(message) {
    $('#feedback').className = 'feedback ok';
    $('#feedback').innerHTML = '<strong>' + message + '</strong>';
    renderQuiz();
    var key = String(state.seed) + ':' + state.level;
    var list = state.progress[String(state.level)];
    if (list.indexOf(key) < 0) {
      list.push(key);
      saveProgress();
      renderProgress();
    }
    return true;
  }

  function checkQuiz() {
    var correct = 0;
    state.quiz.forEach(function (q, i) {
      var sel = document.querySelector('input[name="q' + i + '"]:checked');
      if (sel && parseInt(sel.value, 10) === q.answer) correct++;
    });
    var html = '答对 ' + correct + ' / ' + state.quiz.length + '。';
    state.quiz.forEach(function (q, i) {
      html += '<div class="why">' + (i + 1) + '. ' + q.why + '</div>';
    });
    if (correct === state.quiz.length) html = '<strong style="color:var(--green)">全对。</strong> ' + html;
    $('#quiz-result').innerHTML = html;
    return correct;
  }

  function hint() {
    var hints;
    if (state.level === 1) {
      var r = E.relation(state.machine, 'GPU0', 'NIC0');
      hints = [
        '先看 CPU Affinity 列：写 0-47 的在楼 A，48-95 的在楼 B。先把 CPU 放进对应的楼。',
        'GPU 到 GPU 那一大块写的是 NV 或 NVLink 条数，说明这些卡互走专线。',
        '找一张卡和 NIC0 的交叉格：写 PIX 就把它俩挂到同一颗交换芯片下。',
        '写 NODE 表示同一颗 CPU、不同主桥；写 SYS 表示两颗 CPU 各占一边。',
        '这张题里 GPU0 到 NIC0 是 ' + r + '，先照着这一格摆。'
      ];
    } else if (state.level === 2) {
      hints = [
        '每张机器的 GPU0-3 在 NUMA 0，走 NIC0；GPU4-7 在 NUMA 1，走 NIC1。',
        '绑定按钮右边的记号就是这张卡到该网卡的远近，SYS 说明跨楼了。',
        '先修两台机器内部被挪动的零件，右侧拓扑表会告诉你哪里不对。',
        '一块 400G 网卡每秒约 50 GB，跨楼的连廊比楼内走廊窄得多。'
      ];
    } else {
      hints = [
        '整轮耗时由最慢的端口决定，先盯住右侧标红的瓶颈。',
        '降速和故障端口尽量空着，把流放到同一台机器的另一块网卡。',
        '一条流只能放到源机器的网卡：A.GPU0 发出的流只能进 A 的 NIC0/NIC1。',
        '54G、64G 这种大流别和别的流挤在同一块网卡上。'
      ];
    }
    $('#feedback').className = 'feedback';
    $('#feedback').textContent = '提示：' + hints[Math.floor(Math.random() * hints.length)];
  }

  function newRound(seed, level) {
    state.level = level || state.level;
    state.seed = (seed === undefined ? (Date.now() ^ Math.floor(Math.random() * 100000)) : seed) >>> 0;
    state.history = [];
    state.future = [];
    state.dragging = null;
    $('#feedback').className = 'feedback';
    $('#feedback').textContent = '';
    $('#quiz').hidden = true;

    if (state.level === 1) {
      state.machine = E.generateMachine(state.seed, 1);
      state.player = E.blankConfig(state.machine);
      state.truthMatrix = E.buildMatrix(state.machine);
      state.quiz = E.generateQuiz(state.seed, 2);
      $('#seed-label').textContent = '本题随机种子：' + state.seed + ' · ' +
        state.machine.meta.gpuCount + ' 张卡 · ' + state.machine.meta.cpuCount + ' 个 NUMA 节点';
    } else if (state.level === 2) {
      state.scenario = E.generateScenario(state.seed, 2);
      state.players = state.scenario.puzzles.map(function (p) { return JSON.parse(JSON.stringify(p)); });
      state.playerBindings = [{}, {}];
      state.quiz = E.generateQuiz(state.seed, 3);
      $('#seed-label').textContent = '本题随机种子：' + state.seed +
        ' · 两台 8 卡服务器 · 每机内部有 3 处挪动 · 16 张卡要选网卡';
    } else {
      state.cluster = E.generateClusterScenario(state.seed);
      state.allocation = {};
      state.quiz = E.generateQuiz(state.seed, 3);
      $('#seed-label').textContent = '本题随机种子：' + state.seed +
        ' · 4 机 32 卡 · 8 条通信流 · 端口有降速或故障';
    }

    document.querySelectorAll('.levels button').forEach(function (b) {
      b.classList.toggle('active', parseInt(b.getAttribute('data-level'), 10) === state.level);
    });
    var goal = document.getElementById('goal-text');
    var legend = document.getElementById('legend-text');
    if (state.level === 1) {
      goal.innerHTML = '目标：把右侧零件拖到正确的层级里，让你摆出的拓扑表和题目给的<strong>一模一样</strong>。卡片上的 PIX / NODE / SYS 说的是远近，不是型号。';
      legend.textContent = '同屋 PIX · 同楼 NODE · 跨楼 SYS · 卡间专线 NVn。碰头的地方越高，路越长。';
    } else if (state.level === 2) {
      goal.innerHTML = '目标：先修好两台机器内部被挪动的零件，再给 16 张卡选最近网卡。卡片上的 N0 / N1 是这块 GPU 发送数据时走的网卡。';
      legend.textContent = 'PIX 同交换芯片 · NODE 同楼不同主桥 · SYS 跨楼。走反了每次跨机通信都要绕远。';
    } else {
      goal.innerHTML = '目标：把 8 条通信流拖到各自源机器的网卡上，避开降速和故障端口，让<strong>最慢的那个端口</strong>尽量快。';
      legend.textContent = '整轮耗时由最慢端口决定 —— 这和 54 GB 权重加载卡在最窄一段，是同一条道理。';
    }
    document.querySelector('.tabs button.active').click();
    renderAll();
  }

  function renderAll() {
    renderBoard();
    renderPlayerTopo();
    updateHistoryButtons();
  }

  function bind() {
    document.querySelector('.tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      renderCommand(btn.getAttribute('data-tab'));
    });

    document.querySelector('.levels').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-level]');
      if (!btn || btn.disabled) return;
      var lv = parseInt(btn.getAttribute('data-level'), 10);
      if (lv !== state.level) newRound(undefined, lv);
    });

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-bind-g]');
      if (!btn) return;
      var scope = parseInt(btn.getAttribute('data-bind-m'), 10);
      var gpu = btn.getAttribute('data-bind-g');
      var nic = btn.getAttribute('data-bind-n');
      if (state.playerBindings[scope][gpu] === nic) return;
      snapshot();
      state.playerBindings[scope][gpu] = nic;
      renderBoard();
    });

    document.addEventListener('dragstart', function (e) {
      var el = e.target.closest('[data-drag]');
      if (!el) return;
      state.dragging = el.getAttribute('data-drag');
      e.dataTransfer.setData('text/plain', state.dragging);
      e.dataTransfer.effectAllowed = 'move';
    });

    document.addEventListener('dragover', function (e) {
      var el = e.target.closest('[data-drop]');
      if (!el || !state.dragging) return;
      if (canDrop(state.dragging, el.getAttribute('data-drop'))) {
        e.preventDefault();
        el.classList.add('dropover');
      }
    });

    document.addEventListener('dragleave', function (e) {
      var el = e.target.closest('[data-drop]');
      if (el) el.classList.remove('dropover');
    });

    document.addEventListener('drop', function (e) {
      var el = e.target.closest('[data-drop]');
      if (!el) return;
      e.preventDefault();
      el.classList.remove('dropover');
      var id = e.dataTransfer.getData('text/plain') || state.dragging;
      var target = el.getAttribute('data-drop');
      if (canDrop(id, target)) {
        setParent(id, target);
        renderAll();
      }
      state.dragging = null;
    });

    document.addEventListener('dragend', function () {
      state.dragging = null;
      Array.prototype.forEach.call(document.querySelectorAll('.dropover'), function (el) {
        el.classList.remove('dropover');
      });
    });

    $('#tray').addEventListener('dragover', function (e) { e.preventDefault(); });
    $('#tray').addEventListener('drop', function (e) {
      e.preventDefault();
      var id = e.dataTransfer.getData('text/plain') || state.dragging;
      if (id && canDrop(id, 'TRAY')) { setParent(id, 'TRAY'); renderAll(); }
      state.dragging = null;
    });

    document.addEventListener('dblclick', function (e) {
      var el = e.target.closest('[data-drag]');
      if (!el) return;
      var id = el.getAttribute('data-drag');
      if (canDrop(id, 'TRAY')) { setParent(id, 'TRAY'); renderAll(); }
    });

    document.addEventListener('keydown', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      var k = (e.key || '').toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });

    $('#btn-submit').addEventListener('click', submit);
    $('#btn-new').addEventListener('click', function () { newRound(); });
    $('#btn-hint').addEventListener('click', hint);
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-quiz-check').addEventListener('click', checkQuiz);
    $('#btn-reset').addEventListener('click', function () {
      if (state.level === 1) {
        state.player = E.blankConfig(state.machine);
      } else if (state.level === 3) {
        state.allocation = {};
      } else {
        state.players = state.scenario.puzzles.map(function (p) { return JSON.parse(JSON.stringify(p)); });
        state.playerBindings = [{}, {}];
      }
      state.history = [];
      state.future = [];
      $('#feedback').className = 'feedback';
      $('#feedback').textContent = '';
      $('#quiz').hidden = true;
      renderAll();
    });
  }

  window.__gameTest = {
    state: state,
    setParent: setParent,
    canDrop: canDrop,
    submit: submit,
    checkQuiz: checkQuiz,
    undo: undo,
    redo: redo,
    newRound: newRound,
    renderAll: renderAll,
    solve: function () {
      if (state.level === 1) {
        var m = state.machine;
        Object.keys(m.cpuPlacement).forEach(function (c) { state.player.cpuPlacement[c] = m.cpuPlacement[c]; });
        Object.keys(m.bridges).forEach(function (b) { state.player.bridges[b] = m.bridges[b]; });
        Object.keys(m.switches).forEach(function (s) { state.player.switches[s] = m.switches[s]; });
        Object.keys(m.devices).forEach(function (d) { state.player.devices[d].parent = m.devices[d].parent; });
      } else if (state.level === 2) {
        state.players = state.scenario.machines.map(function (m) {
          var c = E.blankConfig(m);
          Object.keys(m.cpuPlacement).forEach(function (x) { c.cpuPlacement[x] = m.cpuPlacement[x]; });
          Object.keys(m.bridges).forEach(function (x) { c.bridges[x] = m.bridges[x]; });
          Object.keys(m.switches).forEach(function (x) { c.switches[x] = m.switches[x]; });
          Object.keys(m.devices).forEach(function (x) { c.devices[x].parent = m.devices[x].parent; });
          return c;
        });
        state.playerBindings = state.scenario.bindings.map(function (b) {
          var o = {}; Object.keys(b).forEach(function (k) { o[k] = b[k]; }); return o;
        });
      } else {
        state.allocation = {};
        Object.keys(state.cluster.bestAllocation).forEach(function (k) {
          state.allocation[k] = state.cluster.bestAllocation[k];
        });
      }
      renderAll();
    }
  };

  bind();
  newRound(20261125, 1);
  renderProgress();
})();
