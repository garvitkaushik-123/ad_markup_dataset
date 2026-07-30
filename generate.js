// ponytail: template-based synthetic generator, not scraped from live ad servers —
// good enough to cover the real markup *shapes* seen in ad tech (GAM/GPT, safeframe,
// JS redirect tags, native, rich media). Swap in live-captured adm payloads later if
// you need byte-exact real traffic.
//
// URL convention: every URL's domain embeds the record's own id (e.g. synthetic_1.com)
// with a purpose subdomain (click./imp./cdn./tag./safeframe./redirect./expand.), and
// every URL carries ?type=<click|imp|creative|tag|safeframe|redirect|expand> so the
// caller can tell what a given call is for without guessing from the path.
const fs = require('fs');

const SIZES = [
  [300, 250], [728, 90], [320, 50], [160, 600], [970, 250],
  [300, 600], [320, 100], [250, 250], [468, 60], [300, 50],
  [336, 280], [120, 600], [970, 90], [300, 100]
];

const VENDOR_NAMES = ['gam', 'appnexus', 'criteo', 'mediamath', 'ttd', 'sizmek', 'flashtalking', 'celtra'];

let counter = 0;

function url(id, sub, type, path, extraQuery) {
  const q = extraQuery ? `&${extraQuery}` : '';
  return `https://${sub}.${id}.com${path}?type=${type}${q}`;
}

function bannerHtml(id, w, h) {
  const click = url(id, 'click', 'click', '/track', `cb=${1700000000 + counter}`);
  const img = url(id, 'cdn', 'creative', `/creative/${w}x${h}.jpg`);
  return `<html><head><style>body{margin:0;padding:0;}</style></head><body>` +
    `<a href="${click}" target="_blank">` +
    `<img src="${img}" width="${w}" height="${h}" border="0" alt=""/>` +
    `</a></body></html>`;
}

function iframeSafeframe(id, w, h) {
  const src = url(id, 'safeframe', 'safeframe', '/container.html');
  return `<iframe id="google_ads_iframe_${counter}" name="google_ads_iframe_${counter}" ` +
    `src="${src}" ` +
    `width="${w}" height="${h}" scrolling="no" marginwidth="0" marginheight="0" frameborder="0" ` +
    `sandbox="allow-forms allow-popups allow-scripts allow-same-origin" data-google-container-id="1">` +
    `</iframe>`;
}

function jsRedirectTag(id, w, h) {
  const tagSrc = url(id, 'tag', 'tag', '/serve', `size=${w}x${h}`);
  const click = url(id, 'click', 'click', '/track');
  const fallbackImg = url(id, 'cdn', 'creative', `/fallback/${w}x${h}.jpg`);
  return `<script type="text/javascript" src="${tagSrc}"></script>` +
    `<noscript><a href="${click}"><img src="${fallbackImg}" width="${w}" height="${h}"/></a></noscript>`;
}

function gptRenderTag(id, w, h) {
  return `<div id="div-gpt-ad-${counter}-0" style="width:${w}px;height:${h}px;">` +
    `<script>googletag.cmd.push(function(){googletag.display("div-gpt-ad-${counter}-0");});</script>` +
    `</div>`;
}

function nativeHtml(id) {
  const click = url(id, 'click', 'click', '/track');
  const icon = url(id, 'cdn', 'creative', '/native/icon.png');
  const imp = url(id, 'imp', 'imp', '/track');
  return `<div class="native-ad">` +
    `<a href="${click}">` +
    `<img class="native-icon" src="${icon}"/>` +
    `<div class="native-title">Sponsored: Save on your next purchase</div>` +
    `<div class="native-body">Limited time offer, shop now and save big.</div>` +
    `<span class="native-cta">Learn More</span>` +
    `</a><img src="${imp}" width="1" height="1" style="display:none"/>` +
    `</div>`;
}

function richMediaExpandable(id, w, h) {
  const collapsedImg = url(id, 'cdn', 'creative', `/rm/collapsed_${w}x${h}.jpg`);
  const expandSrc = url(id, 'expand', 'expand', '/expand');
  const click = url(id, 'click', 'click', '/track');
  return `<div id="rm-${counter}" style="width:${w}px;height:${h}px;overflow:hidden;">` +
    `<style>#rm-${counter} .expand{display:none;} #rm-${counter}:hover .expand{display:block;}</style>` +
    `<img src="${collapsedImg}" width="${w}" height="${h}"/>` +
    `<div class="expand"><iframe src="${expandSrc}" width="${w * 2}" height="${h * 2}" frameborder="0"></iframe></div>` +
    `<a href="${click}" style="position:absolute;top:0;left:0;width:100%;height:100%;"></a>` +
    `</div>`;
}

function nestedRedirect(id, w, h) {
  const outer = url(id, 'redirect', 'redirect', '/rtb', `size=${w}x${h}`);
  const inner = url(id, 'serve', 'tag', '/creative', `w=${w}&h=${h}`);
  return `<iframe src="${outer}" width="${w}" height="${h}" frameborder="0" scrolling="no">` +
    `<script>document.write('<iframe src="${inner}" width="${w}" height="${h}" frameborder="0"></iframe>');</script>` +
    `</iframe>`;
}

const GENERATORS = {
  banner_html: bannerHtml,
  iframe_safeframe: iframeSafeframe,
  js_redirect_tag: jsRedirectTag,
  gpt_render_tag: gptRenderTag,
  native_html: (id, w, h) => nativeHtml(id),
  rich_media_expandable: richMediaExpandable,
  nested_redirect: nestedRedirect,
};

const results = [];
for (const [formatType, gen] of Object.entries(GENERATORS)) {
  for (const [w, h] of SIZES) {
    for (const vendorName of VENDOR_NAMES) {
      counter++;
      const id = `synthetic_${counter}`;
      results.push({
        id,
        source: 'synthetic_template',
        format_type: formatType,
        vendor_style: vendorName,
        width: w,
        height: h,
        adm: gen(id, w, h),
      });
    }
  }
}

// carry over real prebid fixtures unchanged (already realistic real-world domains)
const prev = JSON.parse(fs.readFileSync('ad_markup_dataset_prev.json', 'utf8'));
for (const r of prev) {
  if (r.source !== 'prebid_fixture') continue;
  results.push(r);
}

fs.writeFileSync('ad_markup_dataset.json', JSON.stringify(results, null, 2));
console.log('total samples:', results.length);
const byType = {};
for (const r of results) byType[r.format_type] = (byType[r.format_type] || 0) + 1;
console.log(byType);
