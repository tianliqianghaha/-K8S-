(function (root) {
  'use strict';

  function mount(el, ctx) {
    var left = ctx.left || [];
    var right = ctx.right || [];
    var rightOrder = (ctx.rightOrder || right.map(function (x) { return x.id; })).slice();
    var pairs = {};
    var sel = null;

    function labelOf(list, id) {
      var it = list.filter(function (x) { return x.id === id; })[0];
      return it ? it.label : id;
    }

    function render() {
      var rightHtml = rightOrder.map(function (rid) {
        var bound = null;
        Object.keys(pairs).forEach(function (lid) { if (pairs[lid] === rid) bound = lid; });
        return '<div class="mt-item mt-right' + (bound ? ' bound' : '') + '" data-side="r" data-id="' + rid + '">' +
          '<span class="mt-t">' + labelOf(right, rid) + '</span>' +
          (bound ? '<span class="mt-badge">' + labelOf(left, bound) + '</span>' : '') +
          '</div>';
      }).join('');

      var leftHtml = left.map(function (l) {
        return '<div class="mt-item mt-left' + (sel === l.id ? ' sel' : '') + (pairs[l.id] ? ' bound' : '') +
          '" data-side="l" data-id="' + l.id + '">' +
          '<span class="mt-t">' + l.label + '</span>' +
          (pairs[l.id] ? '<span class="mt-badge">' + labelOf(right, pairs[l.id]) + '</span>' : '') +
          '</div>';
      }).join('');

      el.innerHTML = '<div class="mt"><div class="mt-col">' + leftHtml + '</div>' +
        '<div class="mt-col">' + rightHtml + '</div></div>' +
        '<div class="mt-tip">' + (sel ? '已选中左边一项，去右边点它对应的那一项。' : '先点左边，再点右边。再点一次左边可以取消。') + '</div>';
    }

    el.addEventListener('click', function (e) {
      var it = e.target.closest('.mt-item');
      if (!it) return;
      var id = it.getAttribute('data-id');
      if (it.getAttribute('data-side') === 'l') {
        if (sel === id) { sel = null; delete pairs[id]; }
        else sel = id;
        render();
        if (ctx.onChange) ctx.onChange();
        return;
      }
      if (!sel) return;
      /* 右边被别的左项占了，先解绑 */
      Object.keys(pairs).forEach(function (lid) { if (pairs[lid] === id) delete pairs[lid]; });
      pairs[sel] = id;
      sel = null;
      render();
      if (ctx.onChange) ctx.onChange();
    });

    render();

    return {
      refresh: function () { sel = null; render(); },
      answer: function () {
        var p = {};
        Object.keys(pairs).forEach(function (k) { p[k] = pairs[k]; });
        return { pairs: p };
      }
    };
  }

  root.TopoRenderMatch = { mount: mount };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRenderMatch;
})(typeof globalThis !== 'undefined' ? globalThis : this);
