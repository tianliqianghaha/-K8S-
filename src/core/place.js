(function (root) {
  'use strict';

  var M = root.TopoModel;

  /*
    target 形态：
      { kind:'tray' }
      { kind:'cpu',    numa:0 }
      { kind:'bridges', cpu:'CPU0' }
      { kind:'under',  host:'B0' }   // host 可以是桥，也可以是交换芯片
  */

  function isDescendant(cfg, ancestor, node) {
    var p = node, guard = 0;
    while (p && guard++ < 12) {
      if (p === ancestor) return true;
      if (M.has(cfg.switches, p)) { p = cfg.switches[p]; continue; }
      if (cfg.devices && cfg.devices[p]) { p = cfg.devices[p].parent; continue; }
      p = null;
    }
    return false;
  }

  function childCount(cfg, id) {
    var n = 0;
    Object.keys(cfg.switches || {}).forEach(function (s) { if (cfg.switches[s] === id) n++; });
    Object.keys(cfg.devices || {}).forEach(function (d) { if (cfg.devices[d].parent === id) n++; });
    return n;
  }

  function check(cfg, partId, target) {
    var type = M.partType(cfg, partId);
    if (type === 'unknown') return { ok: false, reason: '这不是一个零件。' };
    if (!target || target.kind === 'tray') {
      if (type === 'switch' && childCount(cfg, partId) > 0) {
        return { ok: false, reason: '这个交换芯片里还挂着设备，先把里面的零件取出来再送回托盘。' };
      }
      return { ok: true, reason: '' };
    }
    if (type === 'cpu') {
      if (target.kind !== 'cpu') return { ok: false, reason: 'CPU 只能放进 NUMA 楼的 CPU 槽位，不能放到桥或交换芯片下。' };
      return { ok: true, reason: '' };
    }
    if (type === 'bridge') {
      if (target.kind !== 'bridges') return { ok: false, reason: 'PCIe 桥只能挂在 CPU 下面。' };
      if (!target.cpu) return { ok: false, reason: '这个桥位还没有归属的 CPU。' };
      return { ok: true, reason: '' };
    }
    if (type === 'switch') {
      if (target.kind !== 'under') return { ok: false, reason: '交换芯片要挂在桥或另一颗交换芯片下面。' };
      if (!target.host) return { ok: false, reason: '这里还没有可挂靠的上级。' };
      if (target.host === partId) return { ok: false, reason: '不能把交换芯片挂到自己下面。' };
      if (isDescendant(cfg, partId, target.host)) {
        return { ok: false, reason: '目标位置在这颗交换芯片自己的下游，会形成环。' };
      }
      return { ok: true, reason: '' };
    }
    /* gpu / nic */
    if (target.kind !== 'under') {
      return { ok: false, reason: '设备只能挂在交换芯片或 PCIe 桥下面。' };
    }
    if (!target.host) return { ok: false, reason: '这里还没有可挂靠的上级。' };
    if (M.has(cfg.devices, target.host)) return { ok: false, reason: '设备不能挂在另一个设备下面。' };
    return { ok: true, reason: '' };
  }

  function canPlace(cfg, partId, target) {
    return check(cfg, partId, target).ok;
  }

  /* 原地修改并返回是否发生变化 */
  function applyPlace(cfg, partId, target) {
    var type = M.partType(cfg, partId);
    if (!check(cfg, partId, target).ok) return false;
    var before = JSON.stringify(ownerState(cfg, partId));
    if (target.kind === 'tray' || !target) {
      if (type === 'cpu') cfg.cpuPlacement[partId] = null;
      else if (type === 'bridge') cfg.bridges[partId] = null;
      else if (type === 'switch') cfg.switches[partId] = null;
      else if (cfg.devices[partId]) cfg.devices[partId].parent = null;
    } else if (type === 'cpu') {
      cfg.cpuPlacement[partId] = target.numa;
    } else if (type === 'bridge') {
      cfg.bridges[partId] = target.cpu;
    } else if (type === 'switch') {
      cfg.switches[partId] = target.host;
    } else if (cfg.devices[partId]) {
      cfg.devices[partId].parent = target.host;
    }
    return before !== JSON.stringify(ownerState(cfg, partId));
  }

  function ownerState(cfg, partId) {
    if (M.has(cfg.cpuPlacement, partId)) return ['cpu', cfg.cpuPlacement[partId]];
    if (M.has(cfg.bridges, partId)) return ['bridge', cfg.bridges[partId]];
    if (M.has(cfg.switches, partId)) return ['switch', cfg.switches[partId]];
    if (cfg.devices && cfg.devices[partId]) return ['device', cfg.devices[partId].parent];
    return ['none', null];
  }

  function where(cfg, partId) {
    var st = ownerState(cfg, partId);
    if (st[1] === null) return '还在托盘里';
    if (st[0] === 'cpu') return 'NUMA ' + st[1];
    if (st[0] === 'bridge') return st[1] + ' 下';
    if (st[0] === 'switch') return st[1] + ' 下';
    return st[1] + ' 下';
  }

  function countPlaced(cfg) {
    var n = 0;
    M.allParts(cfg).forEach(function (p) {
      if (ownerState(cfg, p.id)[1] !== null) n++;
    });
    return n;
  }

  root.TopoPlace = {
    check: check,
    canPlace: canPlace,
    applyPlace: applyPlace,
    isDescendant: isDescendant,
    childCount: childCount,
    ownerState: ownerState,
    where: where,
    countPlaced: countPlaced
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoPlace;
})(typeof globalThis !== 'undefined' ? globalThis : this);
