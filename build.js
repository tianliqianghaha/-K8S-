'use strict';

/*
  把 index.html 引用的 css 与全部脚本内联成一个单文件，
  产物 dist/index.html 双击即可打开，不需要服务器、不需要装 Node。
  只用正则做字符串替换，不引任何依赖。
*/

var fs = require('node:fs');
var path = require('node:path');

var root = __dirname;
var src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
var inlined = { css: 0, js: 0 };

src = src.replace(/<link rel="stylesheet" href="([^"]+)">/g, function (_, rel) {
  inlined.css++;
  var css = fs.readFileSync(path.join(root, rel), 'utf8');
  return '<style>\n' + css + '\n</style>';
});

src = src.replace(/<script src="([^"]+)"><\/script>/g, function (_, rel) {
  inlined.js++;
  var code = fs.readFileSync(path.join(root, rel), 'utf8');
  if (code.indexOf('</script') >= 0) throw new Error('脚本里出现 </script，无法内联：' + rel);
  return '<script>\n' + code + '\n</script>';
});

if (src.indexOf('src="') >= 0 && /<script src=/.test(src)) {
  throw new Error('还有未内联的脚本引用');
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
var out = path.join(root, 'dist', 'index.html');
fs.writeFileSync(out, src, 'utf8');

console.log('dist/index.html  ' + (Buffer.byteLength(src, 'utf8') / 1024).toFixed(1) + ' KB  ' +
  'css=' + inlined.css + ' js=' + inlined.js);
