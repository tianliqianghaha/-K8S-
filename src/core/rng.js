(function (root) {
  'use strict';

  function hash(str) {
    var h = 2166136261 >>> 0;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function Rng(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  Rng.prototype.next = function () {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    var t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  Rng.prototype.int = function (n) {
    return Math.floor(this.next() * n);
  };

  Rng.prototype.pick = function (arr) {
    return arr[this.int(arr.length)];
  };

  Rng.prototype.chance = function (p) {
    return this.next() < p;
  };

  Rng.prototype.shuffle = function (arr) {
    var b = arr.slice();
    for (var i = b.length - 1; i > 0; i--) {
      var j = this.int(i + 1);
      var t = b[i]; b[i] = b[j]; b[j] = t;
    }
    return b;
  };

  function stream(seed, name) {
    return new Rng(((seed >>> 0) ^ hash(name)) >>> 0);
  }

  root.TopoRng = { Rng: Rng, stream: stream, hash: hash };

  if (typeof module === 'object' && module.exports) module.exports = root.TopoRng;
})(typeof globalThis !== 'undefined' ? globalThis : this);
