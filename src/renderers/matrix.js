(function (root) {
  'use strict';

  var TONE = {
    'X': 'mx-self',
    '?': 'mx-unk',
    'PIX': 'mx-near',
    'PXB': 'mx-mid',
    'PHB': 'mx-mid',
    'NODE': 'mx-far',
    'SYS': 'mx-far',
    'NV8': 'mx-nv',
    'NV4': 'mx-nv'
  };

  function html(mx, opts) {
    opts = opts || {};
    var ids = mx.ids;
    var out = ['<table class="mx' + (opts.compact ? ' mx-compact' : '') + '">'];
    out.push('<thead><tr><th class="mx-corner"></th>');
    ids.forEach(function (id) { out.push('<th>' + id.replace(/^(GPU|NIC)/, '$1') + '</th>'); });
    out.push('</tr></thead><tbody>');
    ids.forEach(function (a) {
      out.push('<tr><th class="mx-row">' + a + '</th>');
      ids.forEach(function (b) {
        var code = mx.cells[a][b];
        out.push('<td class="' + (TONE[code] || '') + '">' + code + '</td>');
      });
      out.push('</tr>');
    });
    out.push('</tbody></table>');
    return out.join('');
  }

  function mount(el, ctx) {
    function refresh() {
      el.innerHTML = html(ctx.getMatrix());
    }
    refresh();
    return { refresh: refresh };
  }

  root.TopoRenderMatrix = { html: html, mount: mount };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRenderMatrix;
})(typeof globalThis !== 'undefined' ? globalThis : this);
