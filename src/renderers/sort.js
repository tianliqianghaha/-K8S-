(function (root) {
  'use strict';

  function mount(el, ctx) {
    var items = ctx.items || [];
    var order = (ctx.start || items.map(function (x) { return x.id; })).slice();
    var sel = null;

    function labelOf(id) {
      var it = items.filter(function (x) { return x.id === id; })[0];
      return it ? it.label : id;
    }

    function render() {
      el.innerHTML = '<div class="st">' + order.map(function (id, i) {
        return '<div class="st-row' + (sel === id ? ' sel' : '') + '" data-id="' + id + '">' +
          '<span class="st-n">' + (i + 1) + '</span>' +
          '<span class="st-t">' + labelOf(id) + '</span>' +
          '<span class="st-btns">' +
          '<button class="st-b" data-act="up" data-id="' + id + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="st-b" data-act="down" data-id="' + id + '"' + (i === order.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '</span></div>';
      }).join('') + '</div>' +
        '<div class="st-tip">点两行可以直接交换；也可以按 ↑ ↓ 一格格挪。</div>';
    }

    function move(id, dir) {
      var i = order.indexOf(id);
      var j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }

    el.addEventListener('click', function (e) {
      var btn = e.target.closest('.st-b');
      if (btn) {
        move(btn.getAttribute('data-id'), btn.getAttribute('data-act') === 'up' ? -1 : 1);
        sel = null;
        render();
        if (ctx.onChange) ctx.onChange();
        return;
      }
      var row = e.target.closest('.st-row');
      if (!row) return;
      var id = row.getAttribute('data-id');
      if (sel === null) { sel = id; render(); return; }
      if (sel === id) { sel = null; render(); return; }
      var a = order.indexOf(sel), b = order.indexOf(id);
      var t = order[a]; order[a] = order[b]; order[b] = t;
      sel = null;
      render();
      if (ctx.onChange) ctx.onChange();
    });

    render();

    return {
      refresh: function (next) {
        if (next) order = next.slice();
        sel = null;
        render();
      },
      answer: function () { return { order: order.slice() }; }
    };
  }

  root.TopoRenderSort = { mount: mount };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRenderSort;
})(typeof globalThis !== 'undefined' ? globalThis : this);
