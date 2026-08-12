#!/usr/bin/env node
/**
 * HellaPrints -> OpenAI Commerce product feed (file upload spec)
 * https://developers.openai.com/commerce/specs/file-upload/products
 *
 * Stages (each resumable, run independently):
 *   node gen-openai-product-feed.mjs catalog   # page the storefront API -> data/products.jsonl
 *   node gen-openai-product-feed.mjs details   # fetch each PDP for description/variants -> data/details.jsonl
 *   node gen-openai-product-feed.mjs build     # emit hellaprints-openai-products.tsv
 *   node gen-openai-product-feed.mjs all
 *
 * Flags: --limit=N (cap products, for smoke tests) --concurrency=N --out=path
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const CATALOG_FILE = path.join(DATA, 'products.jsonl');
const DETAILS_FILE = path.join(DATA, 'details.jsonl');

const STORE = 'https://hellaprints.com';
const API = `${STORE}/api/product/products/advanced-search`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Verified store facts (see reference_hellaprints_store memory + live page check 2026-08-11)
const BRAND = 'HellaPrints';
const SELLER_NAME = 'HellaPrints';
const RETURN_POLICY_URL = `${STORE}/pages/returns`;
const PRIVACY_URL = `${STORE}/pages/privacy`;
const TOS_URL = `${STORE}/pages/terms`;
const RETURN_DEADLINE_DAYS = 60;

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) || 'all';
const flag = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const LIMIT = Number(flag('limit', 0)) || 0;
// Optional allow-list: one item_id per line (blank lines and #comments ignored). When set, the
// build emits only those products — e.g. the 'harvester' lifecycle cohort exported by
// fetch-lifecycle-ids.mjs. Omit the flag to publish the whole catalog.
const INCLUDE_IDS_FILE = flag('include-ids', '');
const CONCURRENCY = Number(flag('concurrency', 20));
const OUT = flag('out', path.join(ROOT, 'hellaprints-openai-products.tsv'));

fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, { tries = 4, timeout = 45000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ catalog */

async function stageCatalog() {
  const seen = new Set();
  const out = fs.createWriteStream(CATALOG_FILE, { flags: 'w' });
  const pageSize = 500;

  const first = await (await fetchRetry(`${API}?page=1&limit=${pageSize}&sort=created_desc`)).json();
  const pages = first.data.pages;
  const total = first.data.total;
  console.log(`catalog: ${total} products across ${pages} pages`);

  const writePage = (products) => {
    for (const p of products) {
      if (seen.has(p._id)) continue;
      seen.add(p._id);
      out.write(JSON.stringify(slimProduct(p)) + '\n');
    }
  };
  writePage(first.data.products);

  for (let page = 2; page <= pages; page++) {
    if (LIMIT && seen.size >= LIMIT) break;
    const j = await (await fetchRetry(`${API}?page=${page}&limit=${pageSize}&sort=created_desc`)).json();
    writePage(j.data?.products || []);
    if (page % 10 === 0 || page === pages) console.log(`  page ${page}/${pages} — ${seen.size} unique products`);
  }
  await new Promise((r) => out.end(r));
  console.log(`catalog: wrote ${seen.size} products -> ${CATALOG_FILE}`);
}

function slimProduct(p) {
  const v = (p.variants || [])[0] || {};
  return {
    id: p._id,
    slug: p.slug,
    title: p.title,
    price: p.retail_price,
    currency: p.currency || 'USD',
    image: p.image || p.thumbnail || '',
    thumbnail: p.thumbnail || '',
    sku: v.sku || '',
    variant_title: v.title || '',
    created: p.created,
  };
}

/* ------------------------------------------------------------------ details */

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractNextData(html) {
  const i = html.indexOf('__NEXT_DATA__ = {');
  if (i === -1) return null;
  const start = html.indexOf('{', i);
  let depth = 0;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, k + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function slimDetail(product, slug) {
  const variants = product.variants || [];
  const prices = variants.map((v) => Number(v.retail_price)).filter((n) => Number.isFinite(n) && n > 0);
  const gallery = (product.gallery_uris || []).slice(0, 10);
  return {
    id: product._id,
    slug,
    description: htmlToText(product.description).slice(0, 5000),
    variant_count: variants.length,
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    option_names: [
      ...new Set(
        variants.flatMap((v) => (v.options || []).map((o) => o.name)).filter(Boolean),
      ),
    ].slice(0, 12),
    tags: product.tags || [],
    images: (product.images || []).slice(0, 10),
    gallery,
  };
}

async function stageDetails() {
  let catalog = readJsonl(CATALOG_FILE);
  if (LIMIT) catalog = catalog.slice(0, LIMIT);
  const done = new Set(readJsonl(DETAILS_FILE).map((d) => d.id));
  const todo = catalog.filter((p) => !done.has(p.id));
  console.log(`details: ${catalog.length} products, ${done.size} cached, ${todo.length} to fetch (concurrency ${CONCURRENCY})`);
  if (!todo.length) return;

  const out = fs.createWriteStream(DETAILS_FILE, { flags: 'a' });
  let idx = 0;
  let ok = 0;
  let fail = 0;
  const t0 = Date.now();

  async function worker() {
    while (idx < todo.length) {
      const p = todo[idx++];
      const n = idx;
      try {
        const res = await fetchRetry(`${STORE}/${encodeURIComponent(p.slug)}`);
        const html = await res.text();
        const nd = extractNextData(html);
        const product = nd?.props?.pageProps?.product;
        if (!product) throw new Error('no product in __NEXT_DATA__');
        out.write(JSON.stringify(slimDetail(product, p.slug)) + '\n');
        ok++;
      } catch (err) {
        fail++;
        out.write(JSON.stringify({ id: p.id, slug: p.slug, error: String(err.message || err) }) + '\n');
      }
      if (n % 500 === 0) {
        const rate = n / ((Date.now() - t0) / 1000);
        const eta = Math.round((todo.length - n) / rate / 60);
        console.log(`  ${n}/${todo.length} ok=${ok} fail=${fail} ${rate.toFixed(1)}/s eta ${eta}m`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await new Promise((r) => out.end(r));
  console.log(`details: done ok=${ok} fail=${fail}`);
}

/* -------------------------------------------------------------------- build */

// Title keyword -> Google product taxonomy path. Only mapped types get a category;
// anything unmatched is left blank rather than guessed.
const CATEGORY_RULES = [
  [/suncatcher/i, 'Home & Garden > Decor > Home Decor Accents > Suncatchers'],
  [/garden flag|house flag|\bflag\b/i, 'Home & Garden > Lawn & Garden > Outdoor Living > Garden Flags'],
  [/tote bag/i, 'Apparel & Accessories > Handbags, Wallets & Cases > Handbags'],
  [/tire cover/i, 'Vehicles & Parts > Vehicle Parts & Accessories > Vehicle Covers > Spare Tire Covers'],
  [/sun ?shade|windshield/i, 'Vehicles & Parts > Vehicle Parts & Accessories > Vehicle Sunshades'],
  [/doormat|door mat/i, 'Home & Garden > Decor > Door Mats'],
  [/blanket|quilt\b|throw\b/i, 'Home & Garden > Linens & Bedding > Bedding > Blankets'],
  [/\bmug\b|tumbler|drinkware/i, 'Home & Garden > Kitchen & Dining > Tableware > Drinkware > Mugs'],
  [/ornament/i, 'Home & Garden > Decor > Seasonal & Holiday Decorations > Christmas Tree Ornaments'],
  [/night ?light|led (sign|lamp|light)|lamp\b/i, 'Home & Garden > Lighting > Night Lights & Ambient Lighting'],
  [/plaque|keepsake|photo frame|picture frame/i, 'Home & Garden > Decor > Picture Frames'],
  [/canvas|poster|wall art|wall decor/i, 'Home & Garden > Decor > Artwork > Posters, Prints, & Visual Artwork'],
  [/necklace|bracelet|jewelry|keychain|key chain/i, 'Apparel & Accessories > Jewelry'],
  [/hoodie|sweatshirt/i, 'Apparel & Accessories > Clothing > Outerwear > Coats & Jackets'],
  [/t-?shirt|\bshirt\b|\btee\b/i, 'Apparel & Accessories > Clothing > Shirts & Tops'],
  [/\bcap\b|\bhat\b|beanie/i, 'Apparel & Accessories > Clothing Accessories > Hats'],
  [/socks/i, 'Apparel & Accessories > Clothing > Underwear & Socks > Socks'],
  [/pillow|cushion/i, 'Home & Garden > Decor > Throw Pillows'],
  [/shower curtain/i, 'Home & Garden > Bathroom Accessories > Shower Curtains'],
  [/apron/i, 'Home & Garden > Kitchen & Dining > Kitchen Tools & Utensils > Aprons'],
  [/wind chime/i, 'Home & Garden > Decor > Wind Chimes'],
  [/car (mat|coaster|charm|accessor)/i, 'Vehicles & Parts > Vehicle Parts & Accessories'],
  [/candle holder|candle/i, 'Home & Garden > Decor > Home Fragrances > Candles'],
  [/wallet|purse/i, 'Apparel & Accessories > Handbags, Wallets & Cases > Wallets & Money Clips'],
  [/backpack/i, 'Luggage & Bags > Backpacks'],
  [/puzzle/i, 'Toys & Games > Games > Puzzles'],
];

function categoryFor(title) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(title)) return cat;
  return '';
}

// Fallback description built only from verified attributes — no invented claims.
function fallbackDescription(p, d) {
  const bits = [`${p.title}.`];
  const opts = d?.option_names?.length ? d.option_names.join(', ') : p.variant_title;
  if (opts) bits.push(`Available options: ${opts}.`);
  if (/personalized|custom/i.test(p.title)) {
    bits.push('Personalized print made to order — customize it on the product page before checkout.');
  }
  bits.push(
    `Printed and shipped by ${BRAND}. Free US shipping on orders $35+ and 60-day free returns.`,
  );
  return bits.join(' ');
}

const TSV_FIELDS = [
  'item_id',
  'title',
  'description',
  'url',
  'image_url',
  'availability',
  'price',
  'brand',
  'is_eligible_search',
  'is_eligible_checkout',
  'is_ads_eligible',
  'return_policy',
  'seller_name',
  'seller_url',
  'seller_privacy_policy',
  'seller_tos',
  'mpn',
  'condition',
  'product_category',
  'group_id',
  'listing_has_variations',
  'item_group_title',
  'size',
  'additional_image_urls',
  'accepts_returns',
  'return_deadline_in_days',
  'target_countries',
  'store_country',
  'is_digital',
];

const clean = (v, max) => {
  let s = v === undefined || v === null ? '' : String(v);
  s = s.replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max).trim();
  return s;
};

const CDN = 'https://d2dytk4tvgwhb4.cloudfront.net';
const galleryUrls = (d) =>
  (d?.gallery || [])
    .map((u) => (String(u).startsWith('http') ? u : `${CDN}/${u}/regular.jpg`))
    .slice(0, 8);

function buildRow(p, d) {
  const desc = d?.description && d.description.length > 40 ? d.description : fallbackDescription(p, d);
  // The list-API price is the lowest variant price and is refreshed on every run, so it is
  // preferred over the cached PDP price (verified equal on 96,704/96,704 products).
  const price = Number(p.price ?? d?.min_price);
  const multi = (d?.variant_count ?? 1) > 1;
  const size = !multi ? clean(p.variant_title, 20) : '';
  return {
    item_id: p.id,
    title: clean(p.title, 150),
    description: clean(desc, 5000),
    url: `${STORE}/${p.slug}`,
    image_url: p.image || p.thumbnail,
    availability: 'in_stock',
    price: `${price.toFixed(2)} ${p.currency || 'USD'}`,
    brand: BRAND,
    is_eligible_search: 'true',
    // Direct purchase inside ChatGPT — only legitimate once the store implements the
    // Agentic Checkout Spec. Until then the item is search + ads eligible, not buyable.
    is_eligible_checkout: 'false',
    is_ads_eligible: 'true', // required for Ads processing

    return_policy: RETURN_POLICY_URL,
    seller_name: SELLER_NAME,
    seller_url: STORE,
    seller_privacy_policy: PRIVACY_URL,
    seller_tos: TOS_URL,
    // POD items have no manufacturer part number; the Merchize variant SKU is the
    // stable merchant part identifier. Falls back to the product id so the
    // "gtin or mpn" requirement is never left unsatisfied.
    mpn: clean(p.sku || p.id, 70),
    condition: 'new',
    product_category: categoryFor(p.title),
    group_id: p.id,
    listing_has_variations: multi ? 'true' : 'false',
    item_group_title: multi ? clean(p.title, 150) : '',
    size,
    additional_image_urls: galleryUrls(d).join(','),
    accepts_returns: 'true',
    return_deadline_in_days: String(RETURN_DEADLINE_DAYS),
    target_countries: 'US',
    store_country: 'US',
    is_digital: 'false',
  };
}

function stageBuild() {
  let catalog = readJsonl(CATALOG_FILE);
  if (LIMIT) catalog = catalog.slice(0, LIMIT);

  let include = null;
  if (INCLUDE_IDS_FILE) {
    include = new Set(
      fs
        .readFileSync(INCLUDE_IDS_FILE, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    );
    const present = catalog.filter((p) => include.has(p.id)).length;
    console.log(`build: allow-list ${INCLUDE_IDS_FILE} — ${include.size} ids, ${present} found in catalog`);
    if (present < include.size) {
      console.log(`  ${include.size - present} listed id(s) are no longer in the storefront catalog`);
    }
  }
  const details = new Map();
  for (const d of readJsonl(DETAILS_FILE)) if (!d.error) details.set(d.id, d);

  // Delimiter follows the output extension: .csv → comma-delimited (RFC 4180 quoting),
  // .tsv/.txt → tab-delimited. OpenAI's upload dialog offers "CSV or TXT", so a
  // tab-delimited file must carry the .txt extension there; hosted URL/SFTP take either.
  const isCsv = OUT.toLowerCase().endsWith('.csv');
  const sep = isCsv ? ',' : '\t';
  const enc = isCsv
    ? (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    : (v) => v;

  const out = fs.createWriteStream(OUT, { flags: 'w' });
  out.write(TSV_FIELDS.join(sep) + '\n');

  let rows = 0;
  let withDesc = 0;
  let skipped = 0;
  const skipReasons = {};
  for (const p of catalog) {
    if (include && !include.has(p.id)) continue;
    if (!p.id || !p.slug || !p.title) {
      skipped++;
      skipReasons.missing_core = (skipReasons.missing_core || 0) + 1;
      continue;
    }
    if (!(Number(p.price) > 0)) {
      skipped++;
      skipReasons.no_price = (skipReasons.no_price || 0) + 1;
      continue;
    }
    if (!p.image && !p.thumbnail) {
      skipped++;
      skipReasons.no_image = (skipReasons.no_image || 0) + 1;
      continue;
    }
    const d = details.get(p.id);
    if (d?.description?.length > 40) withDesc++;
    const row = buildRow(p, d);
    out.write(TSV_FIELDS.map((f) => enc(row[f] ?? '')).join(sep) + '\n');
    rows++;
  }
  out.end();
  console.log(`build: ${rows} rows -> ${OUT}`);
  console.log(`  real PDP descriptions: ${withDesc} (${((withDesc / Math.max(rows, 1)) * 100).toFixed(1)}%), fallback: ${rows - withDesc}`);
  if (skipped) console.log(`  skipped ${skipped}:`, skipReasons);
}

/* --------------------------------------------------------------------- main */

if (cmd === 'catalog') await stageCatalog();
else if (cmd === 'details') await stageDetails();
else if (cmd === 'build') stageBuild();
else if (cmd === 'all') {
  await stageCatalog();
  await stageDetails();
  stageBuild();
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
