(function (root) {
  'use strict';

  function round(n, digits) {
    var p = Math.pow(10, digits === undefined ? 3 : digits);
    return Math.round(n * p) / p;
  }

  /* 相对误差判定，避免浮点直接比较 */
  function near(actual, expected, tolRatio) {
    if (typeof actual !== 'number' || !isFinite(actual)) return false;
    var tol = Math.abs(expected) * (tolRatio === undefined ? 0.005 : tolRatio);
    if (Math.abs(expected) < 1e-9) return Math.abs(actual) < 1e-9;
    return Math.abs(actual - expected) <= tol;
  }

  /* 惩罚值：越远越贵。D 型题的判分入口 */
  var PENALTY = { PIX: 0, PXB: 1, PHB: 2, NODE: 3, SYS: 6, '?': 9, X: 0, NV8: 0, NV4: 0 };

  function penalty(code) {
    return PENALTY[code] === undefined ? 9 : PENALTY[code];
  }

  /*
    gap 是"比最优贵多少"。halfAt 是给半分的上限：
    默认 3，D 型题按方案规模传更大的值（8 卡机传 8）。
  */
  function byPenalty(actual, best, halfAt) {
    var gap = actual - best;
    var limit = halfAt === undefined ? 3 : halfAt;
    if (gap <= 0) return { score: 1, grade: 'best', gap: gap };
    if (gap <= limit) return { score: 0.5, grade: 'suboptimal', gap: gap };
    return { score: 0, grade: 'wrong', gap: gap };
  }

  function pct(part, whole) {
    if (!whole) return 0;
    return round((part / whole) * 100, 1);
  }

  root.TopoGrade = {
    PENALTY: PENALTY,
    round: round,
    near: near,
    penalty: penalty,
    byPenalty: byPenalty,
    pct: pct
  };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoGrade;
})(typeof globalThis !== 'undefined' ? globalThis : this);
