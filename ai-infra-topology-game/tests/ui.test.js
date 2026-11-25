'use strict';

var fs = require('node:fs');
var path = require('node:path');
var assert = require('node:assert/strict');

var GAME_URL_PART = 'ai-infra-topology-game/index.html';

function findTarget() {
  return fetch('http://127.0.0.1:9222/json/list')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var t = list.find(function (x) { return x.type === 'page' && x.url.indexOf(GAME_URL_PART) >= 0; });
      if (!t) throw new Error('game page target not found');
      return t;
    });
}

function connect(wsUrl) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(wsUrl);
    ws.onopen = function () { resolve(ws); };
    ws.onerror = function (e) { reject(new Error('websocket error: ' + String(e))); };
  });
}

function makeRpc(ws) {
  var seq = 0;
  var pending = {};
  ws.onmessage = function (e) {
    var msg = JSON.parse(e.data);
    if (msg.id && pending[msg.id]) {
      pending[msg.id](msg);
      delete pending[msg.id];
    }
  };
  return function (method, params) {
    return new Promise(function (resolve) {
      var id = ++seq;
      pending[id] = resolve;
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  };
}

(async function () {
  var target = await findTarget();
  var ws = await connect(target.webSocketDebuggerUrl);
  var rpc = makeRpc(ws);
  await rpc('Page.reload', { ignoreCache: true });
  await new Promise(function (r) { setTimeout(r, 700); });

  async function evalJS(expression) {
    var res = await rpc('Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.result && res.result.exceptionDetails) {
      throw new Error('page exception: ' + JSON.stringify(res.result.exceptionDetails));
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  }

  var results = [];
  function check(name, fn) {
    return Promise.resolve().then(fn).then(function () { results.push('PASS ' + name); }, function (e) {
      results.push('FAIL ' + name + ': ' + (e && e.message ? e.message : String(e)));
    });
  }

  await check('page loaded with game API and rendered parts', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      var parts = Object.keys(g.state.player.cpuPlacement).length +
        Object.keys(g.state.player.bridges).length +
        Object.keys(g.state.player.switches).length +
        Object.keys(g.state.player.devices).length;
      return {
        title: document.title,
        hasGame: !!g,
        gpuCount: g.state.machine.meta.gpuCount,
        parts: parts,
        rendered: document.querySelectorAll('#board [data-drag], #tray [data-drag]').length,
        cmdLength: document.querySelector('#cmd-output').textContent.length,
        playerTopoLength: document.querySelector('#player-topo').textContent.length
      };
    })()`);
    assert.equal(r.hasGame, true);
    assert.ok(r.title.indexOf('拓扑拼图') >= 0);
    assert.equal(r.parts, r.rendered);
    assert.ok(r.cmdLength > 100);
    assert.ok(r.playerTopoLength > 50);
  });

  await check('drop rules reject wrong parent types', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      return {
        cpuToNuma: g.canDrop('CPU0','NUMA:0'),
        cpuToBridge: g.canDrop('CPU0','B0'),
        bridgeToCpu: g.canDrop('B0','CPU0'),
        bridgeToSwitch: g.canDrop('B0','S0'),
        switchToBridge: g.canDrop('S0','B0'),
        deviceToSwitch: g.canDrop('GPU0','S0'),
        deviceToCpu: g.canDrop('GPU0','CPU0')
      };
    })()`);
    assert.equal(r.cpuToNuma, true);
    assert.equal(r.cpuToBridge, false);
    assert.equal(r.bridgeToCpu, true);
    assert.equal(r.bridgeToSwitch, false);
    assert.equal(r.switchToBridge, true);
    assert.equal(r.deviceToSwitch, true);
    assert.equal(r.deviceToCpu, false);
  });

  await check('real drop event moves a CPU into a NUMA building', async function () {
    var r = await evalJS(`(() => {
      var zone = document.querySelector('[data-drop="NUMA:0"]');
      var dt = new DataTransfer();
      dt.setData('text/plain','CPU0');
      zone.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
      zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
      return {
        placed: window.__gameTest.state.player.cpuPlacement.CPU0,
        boardHasCpu: !!document.querySelector('#board [data-drag="CPU0"]')
      };
    })()`);
    assert.equal(r.placed, 0);
    assert.equal(r.boardHasCpu, true);
  });

  await check('undo and redo restore placement step by step', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      var before = g.state.player.cpuPlacement.CPU0;
      var undone = g.undo();
      var afterUndo = g.state.player.cpuPlacement.CPU0;
      var redone = g.redo();
      var afterRedo = g.state.player.cpuPlacement.CPU0;
      return { before: before, undone: undone, afterUndo: afterUndo,
        redone: redone, afterRedo: afterRedo,
        redoDisabled: document.querySelector('#btn-redo').disabled };
    })()`);
    assert.equal(r.before, 0);
    assert.equal(r.undone, true);
    assert.equal(r.afterUndo, null);
    assert.equal(r.redone, true);
    assert.equal(r.afterRedo, 0);
    assert.equal(r.redoDisabled, true);
  });

  await check('double click sends a node back to tray', async function () {
    var r = await evalJS(`(() => {
      var el = document.querySelector('#board [data-drag="CPU0"]');
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return {
        placed: window.__gameTest.state.player.cpuPlacement.CPU0,
        inTray: !!document.querySelector('#tray [data-drag="CPU0"]')
      };
    })()`);
    assert.equal(r.placed, null);
    assert.equal(r.inTray, true);
  });

  await check('wrong layout is rejected with human-readable feedback', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.newRound(777);
      var ok = g.submit();
      return { ok: ok, cls: document.querySelector('#feedback').className,
        text: document.querySelector('#feedback').textContent.slice(0,40) };
    })()`);
    assert.equal(r.ok, false);
    assert.ok(r.cls.indexOf('bad') >= 0);
    assert.ok(r.text.indexOf('对不上') >= 0);
  });

  await check('solved layout passes and unlocks quiz', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.solve();
      var ok = g.submit();
      return { ok: ok, cls: document.querySelector('#feedback').className,
        quizHidden: document.querySelector('#quiz').hidden,
        quizCount: g.state.quiz.length };
    })()`);
    assert.equal(r.ok, true);
    assert.ok(r.cls.indexOf('ok') >= 0);
    assert.equal(r.quizHidden, false);
    assert.equal(r.quizCount, 2);
  });

  await check('quiz answers evaluate correctly', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.state.quiz.forEach(function(q,i){
        var el = document.querySelector('input[name="q'+i+'"][value="'+q.answer+'"]');
        el.checked = true;
      });
      var score = g.checkQuiz();
      return { score: score, text: document.querySelector('#quiz-result').textContent.slice(0,40) };
    })()`);
    assert.equal(r.score, 2);
    assert.ok(r.text.indexOf('全对') >= 0);
  });

  await check('new round changes machine and keeps board renderable', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      var before = JSON.stringify(g.state.machine);
      g.newRound(314159);
      return {
        changed: before !== JSON.stringify(g.state.machine),
        seed: g.state.seed,
        rendered: document.querySelectorAll('#board [data-drag], #tray [data-drag]').length,
        parts: Object.keys(g.state.player.cpuPlacement).length +
          Object.keys(g.state.player.bridges).length +
          Object.keys(g.state.player.switches).length +
          Object.keys(g.state.player.devices).length
      };
    })()`);
    assert.equal(r.changed, true);
    assert.equal(r.seed, 314159);
    assert.equal(r.rendered, r.parts);
  });

  await check('hint button produces text', async function () {
    var r = await evalJS(`(() => {
      document.querySelector('#btn-hint').click();
      return document.querySelector('#feedback').textContent;
    })()`);
    assert.ok(r.indexOf('提示') >= 0 && r.length > 12);
  });

  await check('reset button clears placement', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.solve();
      document.querySelector('#btn-reset').click();
      var placed = Object.keys(g.state.player.cpuPlacement).filter(function(c){
        return g.state.player.cpuPlacement[c] !== null;
      }).length;
      return { placed: placed, tray: document.querySelectorAll('#tray [data-drag]').length };
    })()`);
    assert.equal(r.placed, 0);
    assert.ok(r.tray > 0);
  });

  await check('L2 loads two machines with 32 binding selectors', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.newRound(42, 2);
      return {
        level: g.state.level,
        machines: document.querySelectorAll('.machine-wrap').length,
        binds: document.querySelectorAll('[data-bind-g]').length,
        tor: !!document.querySelector('.tor-bar'),
        active: document.querySelector('.levels button.active').getAttribute('data-level'),
        bindings: Object.keys(g.state.playerBindings[0]).length
      };
    })()`);
    assert.equal(r.level, 2);
    assert.equal(r.machines, 2);
    assert.equal(r.binds, 32);
    assert.equal(r.tor, true);
    assert.equal(r.active, '2');
    assert.equal(r.bindings, 0);
  });

  await check('L2 scoped drag rules prevent cross-machine drops', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      return {
        sameMachine: g.canDrop('A-B0','M0-CPU1'),
        crossMachine: g.canDrop('A-B0','M1-CPU0'),
        wrongType: g.canDrop('A-GPU0','M0-CPU0')
      };
    })()`);
    assert.equal(r.sameMachine, true);
    assert.equal(r.crossMachine, false);
    assert.equal(r.wrongType, false);
  });

  await check('L2 moving a scoped part is undoable', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      var c = g.state.players[0];
      var before = c.devices.GPU0.parent;
      var target = Object.keys(c.switches).find(function(s){ return s !== before; });
      var moved = g.setParent('A-GPU0','A-'+target);
      var after = g.state.players[0].devices.GPU0.parent;
      g.undo();
      var restored = g.state.players[0].devices.GPU0.parent;
      return { before: before, moved: moved, after: after, restored: restored };
    })()`);
    assert.equal(r.moved, true);
    assert.ok(r.after !== r.before);
    assert.equal(r.restored, r.before);
  });

  await check('L2 binding click updates state', async function () {
    var r = await evalJS(`(() => {
      var btn = document.querySelector('[data-bind-g="GPU0"][data-bind-m="0"][data-bind-n="NIC1"]');
      btn.click();
      return { bound: window.__gameTest.state.playerBindings[0].GPU0 };
    })()`);
    assert.equal(r.bound, 'NIC1');
  });

  await check('L2 wrong topology and bindings are reported', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.newRound(43, 2);
      var ok = g.submit();
      return { ok: ok, text: document.querySelector('#feedback').textContent.slice(0,60) };
    })()`);
    assert.equal(r.ok, false);
    assert.ok(r.text.indexOf('选错网卡') >= 0 || r.text.indexOf('拓扑') >= 0);
  });

  await check('L2 solved layout passes with 3 quiz questions', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.solve();
      var ok = g.submit();
      return { ok: ok, hidden: document.querySelector('#quiz').hidden,
        count: g.state.quiz.length, cls: document.querySelector('#feedback').className };
    })()`);
    assert.equal(r.ok, true);
    assert.equal(r.hidden, false);
    assert.equal(r.count, 3);
    assert.ok(r.cls.indexOf('ok') >= 0);
  });

  await evalJS('window.__gameTest.newRound(0,2); window.__gameTest.solve(); true');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false });
  var shot2 = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot2.result && shot2.result.data) {
    var out2 = path.join(__dirname, '..', 'screenshot-l2.png');
    fs.writeFileSync(out2, Buffer.from(shot2.result.data, 'base64'));
    results.push('PASS screenshot saved: ' + out2);
  }

  await check('L3 loads 4 machines, 8 flows and 8 ports', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.newRound(3, 3);
      return {
        level: g.state.level,
        cards: document.querySelectorAll('.machine-card').length,
        ports: document.querySelectorAll('.port-slot').length,
        flows: document.querySelectorAll('#tray [data-drag]').length,
        active: document.querySelector('.levels button.active').getAttribute('data-level'),
        best: g.state.cluster.bestTime
      };
    })()`);
    assert.equal(r.level, 3);
    assert.equal(r.cards, 4);
    assert.equal(r.ports, 8);
    assert.equal(r.flows, 8);
    assert.equal(r.active, '3');
    assert.ok(isFinite(r.best));
  });

  await check('L3 rejects cross-source and down-port drops', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      var c = g.state.cluster;
      var f = c.flows[0];
      var ni = c.machines[f.src].nics.findIndex(function(n){ return n.bw > 0; });
      var downMi = -1, downNi = -1;
      c.machines.forEach(function(m,mi){ m.nics.forEach(function(n,nj){
        if (n.bw === 0 && downMi < 0) { downMi = mi; downNi = nj; }
      }); });
      return {
        valid: g.canDrop(f.id, 'P'+f.src+'-'+ni),
        cross: g.canDrop(f.id, 'P'+((f.src+1)%4)+'-0'),
        downPort: downMi < 0 ? 'none' : g.canDrop(f.id, 'P'+downMi+'-'+downNi)
      };
    })()`);
    assert.equal(r.valid, true);
    assert.equal(r.cross, false);
    assert.ok(r.downPort === false || r.downPort === 'none');
  });

  await check('L3 real drop allocates flow and undo removes it', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      var c = g.state.cluster;
      var f = c.flows[0];
      var ni = c.machines[f.src].nics.findIndex(function(n){ return n.bw > 0; });
      var zone = document.querySelector('[data-drop="P'+f.src+'-'+ni+'"]');
      var dt = new DataTransfer();
      dt.setData('text/plain', f.id);
      zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
      var after = g.state.allocation[f.id];
      g.undo();
      var undone = g.state.allocation[f.id];
      g.redo();
      return { after: after, expected: ni, undone: undone, redone: g.state.allocation[f.id] };
    })()`);
    assert.equal(r.after, r.expected);
    assert.equal(r.undone, undefined);
    assert.equal(r.redone, r.expected);
  });

  await check('L3 incomplete allocation is rejected', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.newRound(4, 3);
      var ok = g.submit();
      return { ok: ok, text: document.querySelector('#feedback').textContent };
    })()`);
    assert.equal(r.ok, false);
    assert.ok(r.text.indexOf('没分配') >= 0);
  });

  await check('L3 optimal allocation passes with quiz', async function () {
    var r = await evalJS(`(() => {
      var g = window.__gameTest;
      g.solve();
      var ok = g.submit();
      return { ok: ok, hidden: document.querySelector('#quiz').hidden,
        count: g.state.quiz.length, cls: document.querySelector('#feedback').className,
        budget: document.querySelector('#player-topo').textContent.indexOf('最优耗时') >= 0 };
    })()`);
    assert.equal(r.ok, true);
    assert.equal(r.hidden, false);
    assert.equal(r.count, 3);
    assert.ok(r.cls.indexOf('ok') >= 0);
    assert.equal(r.budget, true);
  });

  await evalJS('window.__gameTest.newRound(3,3); window.__gameTest.solve(); true');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  var shot3 = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot3.result && shot3.result.data) {
    var out3 = path.join(__dirname, '..', 'screenshot-l3.png');
    fs.writeFileSync(out3, Buffer.from(shot3.result.data, 'base64'));
    results.push('PASS screenshot saved: ' + out3);
  }

  await evalJS('window.__gameTest.newRound(0,1); window.__gameTest.solve(); true');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  var shot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot.result && shot.result.data) {
    var out = path.join(__dirname, '..', 'screenshot-l1.png');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    results.push('PASS screenshot saved: ' + out);
  }

  ws.close();
  results.forEach(function (r) { console.log(r); });
  var fail = results.filter(function (r) { return r.indexOf('FAIL') === 0; });
  if (fail.length) process.exit(1);
})().catch(function (e) {
  console.error('FATAL ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
