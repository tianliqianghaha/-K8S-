(function (root) {
  'use strict';

  var PLANES = [
    { key: 'L0', name: '场地与物理', note: '插座、机柜、线' },
    { key: 'L1', name: '服务器与芯片', note: '整机、PCIe、GPU、NVLink' },
    { key: 'L2', name: '主机系统', note: '内核、驱动、可见性、观测' },
    { key: 'L3', name: '网络与集合通信', note: '网卡、无损、拓扑形态、NCCL' },
    { key: 'L4', name: '集群编排', note: 'K8s、调度、作业、弹性' },
    { key: 'L5', name: '平台与运营', note: '租户、计量、推理、成本' },
    { key: 'L6', name: '性能与故障', note: '归因、字典、压测' }
  ];

  var CATALOG = [
    { id: 'M00', plane: 'L0', title: '机房与机柜' },
    { id: 'M01', plane: 'L0', title: '布线、光模块与三网分离' },
    { id: 'M02', plane: 'L1', title: '整机解剖' },
    { id: 'M03', plane: 'L1', title: 'PCIe 拓扑' },
    { id: 'M04', plane: 'L1', title: 'GPU 架构' },
    { id: 'M05', plane: 'L1', title: 'NVLink 与 NVSwitch' },
    { id: 'M06', plane: 'L2', title: 'Linux 底座' },
    { id: 'M07', plane: 'L2', title: '驱动与运行时栈' },
    { id: 'M08', plane: 'L2', title: '设备可见性与隔离' },
    { id: 'M09', plane: 'L2', title: '单机观测与排障' },
    { id: 'M10', plane: 'L3', title: '网卡与 RDMA' },
    { id: 'M11', plane: 'L3', title: '无损与拥塞控制' },
    { id: 'M12', plane: 'L3', title: '拓扑形态' },
    { id: 'M13', plane: 'L3', title: 'NCCL' },
    { id: 'M14', plane: 'L3', title: '集合通信与并行策略' },
    { id: 'M15', plane: 'L4', title: 'K8s 底座' },
    { id: 'M16', plane: 'L4', title: 'GPU 调度' },
    { id: 'M17', plane: 'L4', title: '训练作业与弹性' },
    { id: 'M18', plane: 'L4', title: '网络与存储接入' },
    { id: 'M19', plane: 'L4', title: '镜像与离线交付' },
    { id: 'M20', plane: 'L5', title: '多租户、计量与成本' },
    { id: 'M21', plane: 'L5', title: '可观测性' },
    { id: 'M22', plane: 'L5', title: '推理服务' },
    { id: 'M23', plane: 'L5', title: '模型生命周期' },
    { id: 'M24', plane: 'L5', title: '容量规划' },
    { id: 'M25', plane: 'L6', title: '性能方法论' },
    { id: 'M26', plane: 'L6', title: '故障字典' },
    { id: 'M27', plane: 'L6', title: '压测验收与混沌' }
  ];

  var modules = {};

  function declare(mod) {
    if (!mod || !mod.id) throw new Error('模块必须有 id');
    modules[mod.id] = mod;
    return mod;
  }

  function get(id) {
    return modules[id] || null;
  }

  function isOpen(id) {
    return !!modules[id];
  }

  function planes() {
    return PLANES.map(function (p) {
      var mods = CATALOG.filter(function (m) { return m.plane === p.key; });
      return {
        key: p.key, name: p.name, note: p.note,
        modules: mods.map(function (m) {
          return { id: m.id, title: m.title, open: isOpen(m.id), live: modules[m.id] || null };
        })
      };
    });
  }

  function catalogEntry(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  root.TopoRegistry = {
    PLANES: PLANES,
    CATALOG: CATALOG,
    declare: declare,
    get: get,
    isOpen: isOpen,
    planes: planes,
    catalogEntry: catalogEntry
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRegistry;
})(typeof globalThis !== 'undefined' ? globalThis : this);
