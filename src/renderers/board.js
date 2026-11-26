(function (root) {
  'use strict';

  var M = root.TopoModel;
  var PL = root.TopoPlace;

  function devMeta(cfg, id) {
    var d = cfg.devices[id];
    if (!d) return '';
    if (d.type === 'gpu') return d.mem ? Math.round(d.mem / 1024) + 'GB' : '';
    if (d.type === 'nic') return d.speed ? d.speed + 'G' : '';
    return '';
  }

  var TYPE_LABEL = { cpu: 'CPU', bridge: 'PCIe 桥', switch: '交换芯片', gpu: 'GPU', nic: '网卡' };

  function mount(el, ctx) {
    var cfg = ctx.config;
    var sel = null;
    var msg = '';
    var msgTone = '';

    function reachable() {
      var set = {};
      function walk(host) {
        Object.keys(cfg.switches).forEach(function (s) {
          if (cfg.switches[s] === host && !set[s]) { set[s] = 1; walk(s); }
        });
        Object.keys(cfg.devices).forEach(function (d) {
          if (cfg.devices[d].parent === host) set[d] = 1;
        });
      }
      Object.keys(cfg.cpuPlacement).forEach(function (c) {
        if (cfg.cpuPlacement[c] === null) return;
        set[c] = 1;
        Object.keys(cfg.bridges).forEach(function (b) {
          if (cfg.bridges[b] === c && !set[b]) { set[b] = 1; walk(b); }
        });
      });
      return set;
    }

    function zoneCls(kind, params) {
      if (!sel) return 'bd-zone';
      var ok = PL.check(cfg, sel, {
        kind: kind, numa: params.numa, cpu: params.cpu, host: params.host
      }).ok;
      return ok ? 'bd-zone ok' : 'bd-zone';
    }

    function zone(kind, params, label) {
      var ds = ['data-zone="' + kind + '"'];
      Object.keys(params).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null) ds.push('data-' + k + '="' + params[k] + '"');
      });
      return '<div class="' + zoneCls(kind, params) + '" ' + ds.join(' ') + '>' + label + '</div>';
    }

    function card(id, type, extra) {
      var cls = 'bd-part bd-t-' + type + (sel === id ? ' sel' : '');
      return '<div class="' + cls + '" draggable="true" data-part="' + id + '">' +
        '<span class="bd-id">' + id + '</span>' +
        (extra ? '<span class="bd-meta">' + extra + '</span>' : '') +
        '</div>';
    }

    function kidsHtml(host) {
      var sws = Object.keys(cfg.switches).filter(function (s) { return cfg.switches[s] === host; });
      var devs = Object.keys(cfg.devices).filter(function (d) { return cfg.devices[d].parent === host; });
      if (!sws.length && !devs.length) return '';
      var out = ['<div class="bd-kids">'];
      devs.forEach(function (d) { out.push(card(d, cfg.devices[d].type, devMeta(cfg, d))); });
      sws.forEach(function (s) {
        out.push('<div class="bd-sw">' + card(s, 'switch') +
          zone('under', { host: s }, '拖交换芯片 / 设备到这里') +
          kidsHtml(s) + '</div>');
      });
      out.push('</div>');
      return out.join('');
    }

    function bridgesHtml(cpu) {
      var list = Object.keys(cfg.bridges).filter(function (b) { return cfg.bridges[b] === cpu; });
      if (!list.length) return '';
      return '<div class="bd-cols">' + list.map(function (b) {
        return '<div class="bd-col">' + card(b, 'bridge') +
          zone('under', { host: b }, '拖交换芯片 / 设备到这里') +
          kidsHtml(b) + '</div>';
      }).join('') + '</div>';
    }

    function cpuAt(n) {
      var found = null;
      Object.keys(cfg.cpuPlacement).forEach(function (c) {
        if (cfg.cpuPlacement[c] === n) found = c;
      });
      return found;
    }

    function boardHtml() {
      var n = cfg.meta.cpuCount;
      var out = ['<div class="bd">'];
      for (var i = 0; i < n; i++) {
        var cpu = cpuAt(i);
        out.push('<div class="bd-numa"><div class="bd-numa-h">NUMA ' + i +
          '<span class="bd-numa-n">' + (cpu ? 'CPU 已就位' : '空') + '</span></div>');
        if (!cpu) {
          out.push(zone('cpu', { numa: i }, '拖 CPU 到这里'));
        } else {
          out.push(card(cpu, 'cpu'));
          out.push(zone('bridges', { cpu: cpu }, '拖 PCIe 桥到这里'));
          out.push(bridgesHtml(cpu));
        }
        out.push('</div>');
      }
      out.push('</div>');
      return out.join('');
    }

    function trayHtml() {
      var reach = reachable();
      var items = M.allParts(cfg).filter(function (p) { return !reach[p.id]; });
      var body = items.map(function (p) {
        return '<div class="bd-trayitem bd-t-' + p.type + '" draggable="true" data-part="' + p.id + '">' +
          '<span class="bd-id">' + p.id + '</span>' +
          (p.type === 'gpu' || p.type === 'nic' ? '<span class="bd-meta">' + devMeta(cfg, p.id) + '</span>' : '') +
          '</div>';
      }).join('');
      return '<div class="bd-traybox" data-zone="tray">' +
        '<div class="bd-tray-h">未放置的零件（' + items.length + '）—— 拖回这里可以取下</div>' +
        '<div class="bd-tray">' + (body || '<span class="bd-empty">全部就位</span>') + '</div>' +
        '</div>';
    }

    function render() {
      el.innerHTML =
        (msg ? '<div class="bd-msg ' + msgTone + '">' + msg + '</div>' : '') +
        boardHtml() + trayHtml();
      if (ctx.onUpdate) ctx.onUpdate();
    }

    function setMsg(t, tone) {
      msg = t || '';
      msgTone = tone || '';
    }

    function targetFromEl(z) {
      var d = z.dataset;
      return {
        kind: d.zone,
        numa: d.numa === undefined ? undefined : Number(d.numa),
        cpu: d.cpu || undefined,
        host: d.host || undefined
      };
    }

    function place(id, target) {
      var chk = PL.check(cfg, id, target);
      if (!chk.ok) { setMsg(chk.reason, 'bad'); render(); return false; }
      if (ctx.beforeChange) ctx.beforeChange();
      var changed = PL.applyPlace(cfg, id, target);
      sel = null;
      setMsg(changed ? '' : '位置没有变化。', '');
      render();
      if (ctx.onChange) ctx.onChange();
      return changed;
    }

    el.addEventListener('dragstart', function (e) {
      var p = e.target.closest('.bd-part, .bd-trayitem');
      if (!p) return;
      sel = p.getAttribute('data-part');
      try {
        e.dataTransfer.setData('text/plain', sel);
        e.dataTransfer.effectAllowed = 'move';
      } catch (err) { /* 老浏览器忽略 */ }
    });

    el.addEventListener('dragend', function () { sel = null; render(); });

    el.addEventListener('dragover', function (e) {
      var z = e.target.closest('[data-zone]');
      if (!z || !sel) return;
      if (PL.check(cfg, sel, targetFromEl(z)).ok) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        z.classList.add('over');
      }
    });

    el.addEventListener('dragleave', function (e) {
      var z = e.target.closest('[data-zone]');
      if (z) z.classList.remove('over');
    });

    el.addEventListener('drop', function (e) {
      var z = e.target.closest('[data-zone]');
      if (!z) return;
      e.preventDefault();
      var id = sel;
      try { id = e.dataTransfer.getData('text/plain') || sel; } catch (err) { /* ignore */ }
      if (!id) return;
      place(id, targetFromEl(z));
    });

    el.addEventListener('click', function (e) {
      var z = e.target.closest('[data-zone]');
      var p = e.target.closest('.bd-part, .bd-trayitem');
      if (z && sel) { place(sel, targetFromEl(z)); return; }
      if (p) {
        var id = p.getAttribute('data-part');
        sel = (sel === id) ? null : id;
        setMsg(sel ? '已选中 ' + id + '，绿色框是它可以去的位置。' : '');
        render();
      }
    });

    el.addEventListener('dblclick', function (e) {
      var p = e.target.closest('.bd-part');
      if (!p) return;
      place(p.getAttribute('data-part'), { kind: 'tray' });
    });

    render();

    return {
      refresh: function (next) {
        if (next && next !== cfg) {
          Object.keys(cfg).forEach(function (k) { delete cfg[k]; });
          Object.keys(next).forEach(function (k) { cfg[k] = next[k]; });
        }
        sel = null;
        render();
      },
      answer: function () { return { config: cfg }; },
      clearMsg: function () { setMsg(''); render(); }
    };
  }

  root.TopoRenderBoard = { mount: mount, TYPE_LABEL: TYPE_LABEL };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRenderBoard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
