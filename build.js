'use strict';
/*
 * Yayın derlemesi: public/ klasöründen dist/ üretir.
 *  - Ana uygulama betiği (okey çekirdeği dahil) javascript-obfuscator ile karartılır
 *  - CSS küçültülür, HTML boşlukları sadeleştirilir
 *  - API kalkanı anahtarı betiğe gömülür (API_SHIELD_KEY yoksa her derlemede yeni anahtar üretilir)
 *  - Metin dosyaları brotli ve gzip ile önceden sıkıştırılır
 * Render "npm install" komutundan sonra postinstall ile otomatik çalışır. Kaynak kod public/ altında okunur kalır.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const SRC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'dist');
const TMP = OUT + '.tmp';
const t0 = Date.now();
if (process.env.SKIP_BUILD === '1') { console.log('Derleme atlandı (SKIP_BUILD=1)'); process.exit(0); }

let JO, CleanCSS;
try { JO = require('javascript-obfuscator'); CleanCSS = require('clean-css'); }
catch (e) { console.error('Derleme araçları kurulamadı:', e.message); process.exit(1); }

function copyDir(a, b) { fs.mkdirSync(b, { recursive: true }); for (const n of fs.readdirSync(a)) { const s = path.join(a, n), d = path.join(b, n); if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d); } }
fs.rmSync(TMP, { recursive: true, force: true });
copyDir(SRC, TMP);

/* anahtar */
let keyB64 = process.env.API_SHIELD_KEY || '';
if (!keyB64 || Buffer.from(keyB64, 'base64').length < 16) keyB64 = crypto.randomBytes(32).toString('base64');
const key = Buffer.from(keyB64, 'base64');
const kid = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

const OBF = {
  compact: true, target: 'browser', seed: crypto.randomInt(1, 2 ** 31),
  identifierNamesGenerator: 'mangled-shuffled', renameGlobals: false,
  // base64 dizgi dizisi açık; sarmalayıcı ve indeks kaydırma kapalı (açıkken ekran çizimi 5-8 kat yavaşlıyordu)
  stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 0.8, stringArrayRotate: true, stringArrayShuffle: true,
  stringArrayIndexShift: false, stringArrayCallsTransform: false, stringArrayWrappersCount: 0,
  splitStrings: false, controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false, debugProtection: false,
  disableConsoleOutput: false, transformObjectKeys: false, numbersToExpressions: false, simplify: true, unicodeEscapeSequence: false,
};
if (process.env.OBF_JSON) Object.assign(OBF, JSON.parse(process.env.OBF_JSON));

/* index.html */
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(SRC, 'okey-core.js'), 'utf8');
const tag = '<script src="/okey-core.js"></script>';
if (!html.includes(tag)) throw new Error('okey-core etiketi bulunamadı');
html = html.replace(tag + '\n', '').replace(tag, '');
const m = html.match(/<script>([\s\S]*?)<\/script>(\s*<\/body>)/);
if (!m) throw new Error('ana betik bulunamadı');
let js = m[1];
if (!js.includes("'__US_SHIELD_KEY__'") || !js.includes("'__US_SHIELD_KID__'")) throw new Error('kalkan yer tutucuları bulunamadı');
js = js.replace("'__US_SHIELD_KEY__'", JSON.stringify(keyB64)).replace("'__US_SHIELD_KID__'", JSON.stringify(kid));
const t1 = Date.now();
const obf = JO.obfuscate(core + '\n;' + js, OBF).getObfuscatedCode();
const t2 = Date.now();
html = html.slice(0, m.index) + '<script>' + obf + '</script>' + m[2] + html.slice(m.index + m[0].length);
// CSS
const css = new CleanCSS({ level: 1 });
html = html.replace(/<style>([\s\S]*?)<\/style>/g, (all, c) => { const r = css.minify(c); if (r.errors.length) throw new Error('CSS: ' + r.errors[0]); return '<style>' + r.styles + '</style>'; });
// HTML: yorumları ve satır başı girintilerini kaldır (betik ve stil dışında)
html = html.split(/(<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>)/).map(part => (/^<(script|style)>/.test(part) ? part : part.replace(/<!--(?!\[)[\s\S]*?-->/g, '').replace(/\n\s+/g, '\n'))).join('');
fs.writeFileSync(path.join(TMP, 'index.html'), html);
// eski önbellekli sayfalar için /okey-core.js karartılmış olarak kalır; yeni sayfa gömülü sürümü kullanır
fs.writeFileSync(path.join(TMP, 'okey-core.js'), JO.obfuscate(core, OBF).getObfuscatedCode());

/* servis çalışanı: her derlemede önbellek adı değişsin */
const build = crypto.createHash('sha1').update(html).digest('hex').slice(0, 10);
let sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
sw = sw.replace(/const CACHE = '[^']+';/, `const CACHE = 'us-${build}';`).replace(", '/okey-core.js'", '');
sw = JO.obfuscate(sw, { ...OBF, stringArrayThreshold: 0.5 }).getObfuscatedCode();
fs.writeFileSync(path.join(TMP, 'sw.js'), sw);

/* önceden sıkıştır */
let raw = 0, br = 0;
const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) { walk(f); continue; }
  if (!/\.(html|js|css|svg|webmanifest|json|txt)$/i.test(n)) continue; const b = fs.readFileSync(f); if (b.length <= 1024) continue;
  const bz = zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } });
  fs.writeFileSync(f + '.br', bz); fs.writeFileSync(f + '.gz', zlib.gzipSync(b, { level: 9 })); raw += b.length; br += bz.length; } };
walk(TMP);
fs.writeFileSync(path.join(TMP, 'shield.json'), JSON.stringify({ key: keyB64, kid, build, at: new Date().toISOString() }));

fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(TMP, OUT);
console.log(`Derleme tamam: ${build} · karartma ${((t2 - t1) / 1000).toFixed(1)} sn · betik ${(js.length / 1024).toFixed(0)} KB → ${(obf.length / 1024).toFixed(0)} KB · metin ${(raw / 1024).toFixed(0)} KB → brotli ${(br / 1024).toFixed(0)} KB · toplam ${((Date.now() - t0) / 1000).toFixed(1)} sn${process.env.API_SHIELD_KEY ? '' : ' · anahtar bu derlemeye özel'}`);
