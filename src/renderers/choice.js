(function (root) {
  'use strict';

  function mount(el, ctx) {
    var options = ctx.options || [];
    var pick = null;

    function render() {
      el.innerHTML = '<div class="ch">' + options.map(function (o, i) {
        return '<div class="ch-item' + (pick === i ? ' sel' : '') + '" data-i="' + i + '" role="button" tabindex="0">' +
          '<span class="ch-key">' + String.fromCharCode(65 + i) + '</span>' +
          '<span class="ch-body"><span class="ch-t">' + o.label + '</span>' +
          (o.detail ? '<span class="ch-d">' + o.detail + '</span>' : '') +
          '</span></div>';
      }).join('') + '</div>';
    }

    el.addEventListener('click', function (e) {
      var it = e.target.closest('.ch-item');
      if (!it) return;
      pick = Number(it.getAttribute('data-i'));
      render();
      if (ctx.onPick) ctx.onPick(pick);
    });

    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var it = e.target.closest('.ch-item');
      if (!it) return;
      e.preventDefault();
      pick = Number(it.getAttribute('data-i'));
      render();
      if (ctx.onPick) ctx.onPick(pick);
    });

    render();

    return {
      refresh: render,
      answer: function () { return { pick: pick }; }
    };
  }

  root.TopoRenderChoice = { mount: mount };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRenderChoice;
})(typeof globalThis !== 'undefined' ? globalThis : this);
