// ponytail: overlay via srcdoc iframe wrapper — sidesteps parsing/injecting into
// arbitrary original markup shapes (full <html> docs, <script> tags, bare <div>s).
// Ceiling: two nested iframes for already-iframe formats (safeframe/redirect) —
// fine for visual ID review, switch to DOM injection if you need single-frame depth.
const fs = require('fs');

const DEFAULT_W = 300;
const DEFAULT_H = 250;

function escapeForAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const data = JSON.parse(fs.readFileSync('ad_markup_dataset.json', 'utf8'));

for (const r of data) {
  const w = r.width || DEFAULT_W;
  const h = r.height || DEFAULT_H;
  const srcdoc = escapeForAttr(r.adm);
  r.adm_with_overlay =
    `<div style="position:relative;display:inline-block;width:${w}px;height:${h}px;">` +
    `<div style="position:absolute;top:0;left:0;background:rgba(0,0,0,.75);color:#0f0;` +
    `font:10px monospace;padding:2px 4px;pointer-events:none;z-index:9999;">${r.id}</div>` +
    `<iframe srcdoc="${srcdoc}" width="${w}" height="${h}" style="border:0;display:block;position:relative;z-index:0;" scrolling="no"></iframe>` +
    `</div>`;
}

fs.writeFileSync('ad_markup_dataset_overlay.json', JSON.stringify(data, null, 2));
console.log('wrote', data.length, 'records with adm_with_overlay');
