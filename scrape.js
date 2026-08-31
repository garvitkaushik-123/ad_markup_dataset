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

async function extractIframeContent(iframe) {
  let adm;
  try {
    const frame = await iframe.contentFrame();
    if (frame) adm = await frame.content();
  } catch {}
  // cross-origin: capture the iframe tag itself (src, attrs = what the network sent)
  if (!adm) adm = await iframe.evaluate(e => e.outerHTML);
  return adm;
}

async function extractAdsFromPage(page, url) {
  const ads = [];
  const capturedSrcs = new Set();

  async function addIframe(iframe) {
    const src = await iframe.evaluate(e => e.src || '');
    if (src && capturedSrcs.has(src)) return;

    const width = await iframe.evaluate(e => e.offsetWidth);
    const height = await iframe.evaluate(e => e.offsetHeight);
    if (width < 10 || height < 10) return;

    const adm = await extractIframeContent(iframe);
    if (!adm || adm.trim().length <= 20) return;

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
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // wait for ad auctions to settle
      await new Promise(r => setTimeout(r, 10000));
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
