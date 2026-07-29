// ponytail: template-based synthetic generator, not scraped from live ad servers —
// good enough to cover the real markup *shapes* seen in ad tech (GAM/GPT, safeframe,
// JS redirect tags, native, rich media). Swap in live-captured adm payloads later if
// you need byte-exact real traffic.
const fs = require('fs');

const SIZES = [
  [300, 250], [728, 90], [320, 50], [160, 600], [970, 250],
  [300, 600], [320, 100], [250, 250], [468, 60], [300, 50],
  [336, 280], [120, 600], [970, 90], [300, 100]
];

const VENDORS = [
  { name: 'gam', click: '%%CLICK_URL_ESC%%', cache: '%%CACHEBUSTER%%' },
  { name: 'appnexus', click: '${CLICK_URL_ENC}', cache: '${AUCTION_ID}' },
  { name: 'criteo', click: '{clickurl}', cache: '{cachebuster}' },
  { name: 'mediamath', click: '[click_url]', cache: '[timestamp]' },
  { name: 'ttd', click: '${WINNING_PRICE}', cache: '${CACHEBUSTER}' },
  { name: 'sizmek', click: '%c', cache: '%r' },
  { name: 'flashtalking', click: '[FT_CLICK]', cache: '[FT_CB]' },
  { name: 'celtra', click: '{{CLICK_URL}}', cache: '{{CACHEBUSTER}}' },
];

const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
let counter = 0;

function bannerHtml(w, h, v) {
  return `<html><head><style>body{margin:0;padding:0;}</style></head><body>` +
    `<a href="${v.click}https://track.${v.name}.example/click?cb=${v.cache}" target="_blank">` +
    `<img src="https://cdn.${v.name}.example/creative/${w}x${h}_${counter}.jpg" width="${w}" height="${h}" border="0" alt=""/>` +
    `</a></body></html>`;
}

function iframeSafeframe(w, h, v) {
  const inner = bannerHtml(w, h, v).replace(/"/g, '&quot;');
  return `<iframe id="google_ads_iframe_${counter}" name="google_ads_iframe_${counter}" ` +
    `src="https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html" ` +
    `width="${w}" height="${h}" scrolling="no" marginwidth="0" marginheight="0" frameborder="0" ` +
    `sandbox="allow-forms allow-popups allow-scripts allow-same-origin" data-google-container-id="1">` +
    `</iframe>`;
}

function jsRedirectTag(w, h, v) {
  return `<script type="text/javascript" src="https://ad.${v.name}.example/tag?size=${w}x${h}&cb=${v.cache}"></script>` +
    `<noscript><a href="${v.click}https://track.${v.name}.example/click"><img src="https://cdn.${v.name}.example/fallback/${w}x${h}.jpg" width="${w}" height="${h}"/></a></noscript>`;
}

function gptRenderTag(w, h, v) {
  return `<div id="div-gpt-ad-${counter}-0" style="width:${w}px;height:${h}px;">` +
    `<script>googletag.cmd.push(function(){googletag.display("div-gpt-ad-${counter}-0");});</script>` +
    `</div>`;
}

function nativeHtml(v) {
  return `<div class="native-ad">` +
    `<a href="${v.click}https://track.${v.name}.example/click">` +
    `<img class="native-icon" src="https://cdn.${v.name}.example/native/icon_${counter}.png"/>` +
    `<div class="native-title">Sponsored: Save on your next purchase</div>` +
    `<div class="native-body">Limited time offer, shop now and save big.</div>` +
    `<span class="native-cta">Learn More</span>` +
    `</a><img src="https://track.${v.name}.example/impression?cb=${v.cache}" width="1" height="1" style="display:none"/>` +
    `</div>`;
}

function richMediaExpandable(w, h, v) {
  return `<div id="rm-${counter}" style="width:${w}px;height:${h}px;overflow:hidden;">` +
    `<style>#rm-${counter} .expand{display:none;} #rm-${counter}:hover .expand{display:block;}</style>` +
    `<img src="https://cdn.${v.name}.example/rm/collapsed_${w}x${h}.jpg" width="${w}" height="${h}"/>` +
    `<div class="expand"><iframe src="https://rm.${v.name}.example/expand/${counter}" width="${w * 2}" height="${h * 2}" frameborder="0"></iframe></div>` +
    `<a href="${v.click}https://track.${v.name}.example/click" style="position:absolute;top:0;left:0;width:100%;height:100%;"></a>` +
    `</div>`;
}

function nestedRedirect(w, h, v) {
  const next = rnd(VENDORS);
  return `<iframe src="https://redirect.${v.name}.example/rtb?size=${w}x${h}&cb=${v.cache}" width="${w}" height="${h}" frameborder="0" scrolling="no">` +
    `<script>document.write('<iframe src="https://serve.${next.name}.example/creative?w=${w}&h=${h}" width="${w}" height="${h}" frameborder="0"></iframe>');</script>` +
    `</iframe>`;
}

const GENERATORS = {
  banner_html: bannerHtml,
  iframe_safeframe: iframeSafeframe,
  js_redirect_tag: jsRedirectTag,
  gpt_render_tag: gptRenderTag,
  native_html: (w, h, v) => nativeHtml(v),
  rich_media_expandable: richMediaExpandable,
  nested_redirect: nestedRedirect,
};

const results = [];
for (const [formatType, gen] of Object.entries(GENERATORS)) {
  for (const [w, h] of SIZES) {
    for (const v of VENDORS) {
      counter++;
      results.push({
        id: `synthetic_${counter}`,
        source: 'synthetic_template',
        format_type: formatType,
        vendor_style: v.name,
        width: w,
        height: h,
        adm: gen(w, h, v),
      });
    }
  }
}

// merge in real prebid fixtures, deduped
const real = JSON.parse(fs.readFileSync('ad_markup_dataset.json', 'utf8'));
const seenReal = new Set();
let realId = 0;
for (const r of real) {
  if (seenReal.has(r.adm)) continue;
  seenReal.add(r.adm);
  realId++;
  results.push({
    id: `prebid_real_${realId}`,
    source: 'prebid_fixture',
    format_type: 'unknown_banner',
    vendor_style: r.adapter,
    width: null,
    height: null,
    adm: r.adm,
  });
}

fs.writeFileSync('ad_markup_dataset_full.json', JSON.stringify(results, null, 2));
console.log('total samples:', results.length);
const byType = {};
for (const r of results) byType[r.format_type] = (byType[r.format_type] || 0) + 1;
console.log(byType);
