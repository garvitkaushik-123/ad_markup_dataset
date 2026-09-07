const puppeteer = require('puppeteer');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DATASET_PATH = 'ad_markup_dataset.json';
const SITES_PATH = 'scrape_sites.json';

// Selectors for iframes injected by ad networks (the actual ad creative)
const AD_IFRAME_SELECTORS = [
  'iframe[id*="google_ads_iframe"]',
  'iframe[id*="aswift"]',
];

// Selectors for publisher-side containers that hold ad-network iframes inside
const AD_CONTAINER_SELECTORS = [
  'div[id*="div-gpt-ad"]',
  'ins.adsbygoogle',
  'div[data-google-query-id]',
];

const AD_DOMAIN_PATTERNS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleads.g.doubleclick.net',
  'adnxs.com',
  'criteo.com',
  'criteo.net',
  'casalemedia.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'amazon-adsystem.com',
];

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function normalizeForHash(adm) {
  return adm
    .replace(/\b(cb|cachebuster|correlator|rd|rnd|rand|timestamp|ts|t|ust|bust|nc|_)=[^&"'\s<>]*/gi, '')
    .replace(/[?&]+([&"'\s<>])/g, '$1')
    .replace(/[?&]+$/g, '')
    .replace(/\d{10,}/g, '0')
    .replace(/data-google-query-id="[^"]*"/g, '')
    .replace(/data-adsbygoogle-status="[^"]*"/g, '')
    .replace(/data-ad-status="[^"]*"/g, '')
    .replace(/data-load-complete="[^"]*"/g, '')
    .replace(/style="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function siteNameFromUrl(url) {
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  const parts = hostname.split('.');
  // drop TLD (last part), join rest with hyphens
  parts.pop();
  return parts.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function classifyFormatType(adm) {
  const lower = adm.toLowerCase();
  if (lower.includes('safeframe') || (lower.includes('<iframe') && lower.includes('sandbox='))) {
    return 'iframe_safeframe';
  }
  if (lower.includes('googletag.display') || lower.includes('googletag.cmd.push')) {
    return 'gpt_render_tag';
  }
  if (/<script[^>]+src\s*=/.test(lower) && AD_DOMAIN_PATTERNS.some(d => lower.includes(d))) {
    return 'js_redirect_tag';
  }
  if (lower.includes('native-ad') || lower.includes('native_ad') || lower.includes('class="ad-native')) {
    return 'native_html';
  }
  return 'banner_html';
}

function classifyVendorStyle(adm) {
  const lower = adm.toLowerCase();
  if (lower.includes('googlesyndication') || lower.includes('doubleclick') || lower.includes('googleads')) {
    return 'gam';
  }
  if (lower.includes('adnxs')) return 'appnexus';
  if (lower.includes('criteo')) return 'criteo';
  if (lower.includes('amazon-adsystem')) return 'amazon';
  if (lower.includes('rubiconproject')) return 'rubicon';
  if (lower.includes('pubmatic')) return 'pubmatic';
  if (lower.includes('openx')) return 'openx';
  return 'unknown';
}

function buildExistingHashes(dataset) {
  const hashes = new Set();
  for (const record of dataset) {
    hashes.add(sha256(normalizeForHash(record.adm)));
  }
  return hashes;
}

function getNextSerial(dataset, siteName) {
  let max = 0;
  const prefix = `webscraped-${siteName}-`;
  for (const record of dataset) {
    if (record.id.startsWith(prefix)) {
      const num = parseInt(record.id.slice(prefix.length), 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

function isRenderableAd(adm) {
  // Google's native/responsive ad framework marks an uncomposed (empty) slot
  // with data-nc="1" on its wrapper — the creative never got filled in.
  if (/data-nc="1"/.test(adm)) return false;

  const stripped = adm
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // the "why this ad" / AdChoices link is boilerplate present on every
    // Google ad wrapper regardless of whether a creative actually rendered
    .replace(/<a\b[^>]*adssettings\.google\.com\/whythisad[^>]*>[\s\S]*?<\/a>/gi, '');

  const visibleText = stripped.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const hasMedia = /<(img|video|picture)\b[^>]*\bsrc=/i.test(stripped);
  return visibleText.length >= 3 || hasMedia;
}

function cleanAdMarkup(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<div[^>]*class="GoogleActiveView[^"]*"[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*style="[^"]*visibility:\s*hidden[^"]*"[\s\S]*?<\/div>/gi, '')
    .replace(/<meta[^>]*data-(?:ifc-map|asoch-meta|google-av)[^>]*>/gi, '')
    .replace(/<div[^>]*id="mys-meta"[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*id="mys-overlay"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<div[^>]*id="(?:abgac|mute_panel)"[\s\S]*?<\/div>\s*<\/div>/gi, '')
    .replace(/\s+data-google-av-[a-z-]+="[^"]*"/gi, '')
    .replace(/\s+data-creative-load-listener="[^"]*"/gi, '')
    .replace(/src=&quot;([^&]*)&quot;/g, 'src="$1"')
    .replace(/href=&quot;([^&]*)&quot;/g, 'href="$1"')
    .replace(/&lt;\/script&gt;/gi, '')
    .replace(/&lt;script[^&]*&gt;/gi, '')
    .replace(/(src|href)="\/\//g, '$1="https://')
    .trim();
}

async function extractIframeContent(iframe) {
  try {
    const frame = await iframe.contentFrame();
    if (frame) {
      const result = await frame.evaluate(() => {
        if (!document.body) return null;

        // cloneNode(true) does not traverse open shadow roots — custom
        // elements like <lima-video> (Google IMA's video player) keep the
        // actual <video src="..."> creative inside their shadow DOM, so it
        // gets silently dropped unless we flatten it into light DOM first.
        const shadowHosts = [...document.body.querySelectorAll('*')].filter(el => el.shadowRoot);
        shadowHosts.forEach((el, i) => el.setAttribute('data-shadow-flatten', String(i)));
        const shadowHTMLs = shadowHosts.map(el => el.shadowRoot.innerHTML);

        const clone = document.body.cloneNode(true);

        shadowHosts.forEach(el => el.removeAttribute('data-shadow-flatten'));
        clone.querySelectorAll('[data-shadow-flatten]').forEach(el => {
          const idx = Number(el.getAttribute('data-shadow-flatten'));
          el.removeAttribute('data-shadow-flatten');
          if (shadowHTMLs[idx] != null) el.innerHTML = shadowHTMLs[idx];
        });

        const kill = [
          'script', 'noscript', 'link',
          'iframe[width="0"]', 'iframe[height="0"]',
          '[class*="GoogleActiveView"]',
          '#mys-meta', '#mys-overlay',
          '#abgac', '#mute_panel',
          'meta[data-ifc-map]', 'meta[data-asoch-meta]',
          'meta[data-google-av-override]',
          'img[style*="display:none"]', 'img[style*="display: none"]',
          'div[style*="visibility: hidden"]', 'div[style*="visibility:hidden"]',
        ];
        for (const sel of kill) {
          clone.querySelectorAll(sel).forEach(el => el.remove());
        }
        const styles = [];
        for (const s of document.querySelectorAll('style')) {
          styles.push(s.outerHTML);
        }
        const html = clone.innerHTML.trim();
        return html.length > 30 ? styles.join('') + html : null;
      });
      if (result) return cleanAdMarkup(result);
    }
  } catch {}
  return await iframe.evaluate(e => e.outerHTML);
}

async function extractAdsFromPage(page, url) {
  const ads = [];
  const capturedSrcs = new Set();

  async function addIframe(iframe) {
    const src = await iframe.evaluate(e => e.src || '');
    if (src && capturedSrcs.has(src)) return;

    // GAM's native/responsive ad format composes creative content lazily,
    // triggered by an IntersectionObserver — an off-screen slot never fills.
    // Video ad players (lima-video) also need this time to fetch their VAST
    // creative and populate the <video src> inside their shadow DOM.
    try {
      await iframe.evaluate(e => e.scrollIntoView({ block: 'center' }));
      await new Promise(r => setTimeout(r, 3000));
    } catch {}

    let width = await iframe.evaluate(e => e.offsetWidth);
    let height = await iframe.evaluate(e => e.offsetHeight);

    if (width < 10 || height < 10) {
      try {
        const frame = await iframe.contentFrame();
        if (frame) {
          const dims = await frame.evaluate(() => ({
            w: document.body ? document.body.scrollWidth : 0,
            h: document.body ? document.body.scrollHeight : 0
          }));
          if (dims.w >= 10 && dims.h >= 10) { width = dims.w; height = dims.h; }
        }
      } catch {}
    }
    if (width < 10 || height < 10) return;

    const adm = await extractIframeContent(iframe);
    if (!adm || adm.trim().length <= 20) return;
    if (!isRenderableAd(adm)) return;

    if (src) capturedSrcs.add(src);
    ads.push({ adm, width, height });
  }

  // Pass 1: known ad-network iframes (directly injected by ad platforms)
  for (const selector of AD_IFRAME_SELECTORS) {
    const iframes = await page.$$(selector);
    for (const iframe of iframes) await addIframe(iframe);
  }

  // Pass 2: dig into publisher containers, extract ad-network iframes inside
  for (const selector of AD_CONTAINER_SELECTORS) {
    const containers = await page.$$(selector);
    for (const container of containers) {
      const innerIframes = await container.$$('iframe');
      for (const iframe of innerIframes) await addIframe(iframe);
    }
  }

  // Pass 3: any iframe whose src matches a known ad domain, not already caught
  const allIframes = await page.$$('iframe[src]');
  for (const iframe of allIframes) {
    const src = await iframe.evaluate(e => e.src);
    if (!AD_DOMAIN_PATTERNS.some(d => src.includes(d))) continue;
    await addIframe(iframe);
  }

  return ads;
}

function gitCommitAndPush(newCount, siteNames) {
  const sites = [...new Set(siteNames)].join(', ');
  const msg = `scrape: add ${newCount} ads from [${sites}]`;
  try {
    execSync('git add ad_markup_dataset.json', { stdio: 'pipe' });
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe' });
    execSync('git push origin main', { stdio: 'pipe' });
    console.log(`Committed and pushed: ${msg}`);
  } catch (err) {
    console.error('Git commit/push failed:', err.message);
  }
}

async function main() {
  const sitesConfig = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  const existingHashes = buildExistingHashes(dataset);

  const newEntries = [];
  const siteNames = [];

  const browser = await puppeteer.launch({ headless: true });

  for (const url of sitesConfig.sites) {
    const siteName = siteNameFromUrl(url);
    console.log(`Scraping ${url} (site: ${siteName})...`);

    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 15000));
    } catch (err) {
      console.warn(`Failed to load ${url}: ${err.message}`);
      if (page) await page.close();
      continue;
    }

    let ads;
    try {
      ads = await extractAdsFromPage(page, url);
    } catch (err) {
      console.warn(`Failed to extract ads from ${url}: ${err.message}`);
      await page.close();
      continue;
    }

    if (ads.length === 0) {
      console.log(`  No ads found on ${url}`);
      await page.close();
      continue;
    }

    let serial = getNextSerial(dataset, siteName);
    let addedFromSite = 0;

    for (const { adm, width, height } of ads) {
      const hash = sha256(normalizeForHash(adm));
      if (existingHashes.has(hash)) continue;

      existingHashes.add(hash);
      const id = `webscraped-${siteName}-${serial}`;
      serial++;

      const record = {
        id,
        source: 'webscraped',
        format_type: classifyFormatType(adm),
        vendor_style: classifyVendorStyle(adm),
        width,
        height,
        adm,
        sourced_at: new Date().toISOString(),
      };

      newEntries.push(record);
      siteNames.push(siteName);
      addedFromSite++;
    }

    console.log(`  Found ${ads.length} ads, ${addedFromSite} new`);
    await page.close();
  }

  await browser.close();

  if (newEntries.length === 0) {
    console.log('No new ads found. Nothing to commit.');
    return;
  }

  // also update the serial tracking in the in-memory dataset
  for (const entry of newEntries) {
    dataset.push(entry);
  }

  fs.writeFileSync(DATASET_PATH, JSON.stringify(dataset, null, 2));
  console.log(`Appended ${newEntries.length} new records to ${DATASET_PATH}`);

  gitCommitAndPush(newEntries.length, siteNames);
}

main().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
