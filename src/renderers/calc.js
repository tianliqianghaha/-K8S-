(function (root) {
  'use strict';

  function mount(el, ctx) {
    var fields = ctx.fields || [];
    var vals = {};

    function render() {
      el.innerHTML = '<div class="calc">' + fields.map(function (f) {
        return '<label class="calc-row">' +
          '<span class="calc-l">' + f.label + '</span>' +
          '<span class="calc-in">' +
          '<input class="calc-i" data-k="' + f.key + '" inputmode="decimal" autocomplete="off" placeholder="' + (f.ph || '') + '">' +
          '<span class="calc-u">' + (f.unit || '') + '</span>' +
          '</span></label>';
      }).join('') + '</div>';
    }

    el.addEventListener('input', function (e) {
      var i = e.target.closest('.calc-i');
      if (!i) return;
      vals[i.getAttribute('data-k')] = i.value;
    });

    render();

    return {
      refresh: render,
      answer: function () {
        var out = {};
        fields.forEach(function (f) {
          var raw = String(vals[f.key] === undefined ? '' : vals[f.key]).replace(/,/g, '').trim();
          out[f.key] = raw === '' ? NaN : Number(raw);
        });
        return out;
      },
      focus: function () {
        var i = el.querySelector('.calc-i');
        if (i) i.focus();
      }
    };
  }

  root.TopoRenderCalc = { mount: mount };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRenderCalc;
})(typeof globalThis !== 'undefined' ? globalThis : this);
