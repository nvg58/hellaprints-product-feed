#!/usr/bin/env node
/**
 * Pinterest catalog CSV, built from the feed TSV that gen-openai-product-feed.mjs already
 * produces. Same rows (the `harvester` lifecycle cohort from include-ids.txt), re-shaped into
 * the column set of Pinterest's own sample data source
 * (id, item_group_id, title, description, link, image_link, price, availability, condition,
 *  google_product_category, product_type, additional_image_link, sale_price, brand, gender,
 *  age_group, size, size_type, shipping, custom_label_0, adwords_redirect).
 *
 *   node make-pinterest-csv.mjs                                  # -> dist/pinterest-products.csv
 *   node make-pinterest-csv.mjs --in feed.tsv --out out.csv --custom-label-0=harvester
 *
 * Runs AFTER make-parquet.py so it can add itself to the dist/index.html listing.
 *
 * No attribute is invented: every value is either copied from the TSV (which is itself sourced
 * from the live storefront API + PDP) or is a verified site-wide fact. Columns the store has no
 * trustworthy value for stay EMPTY rather than guessed — gender, age_group and size_type (never
 * stated per product), sale_price (the buy-2/4/6+ discount is a cart rule, not a per-item price)
 * and shipping (free US shipping is conditional on $35+, which the single-line field can't express).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const flag = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const SRC = path.resolve(ROOT, flag('in', 'hellaprints-openai-products.tsv'));
const OUT = path.resolve(ROOT, flag('out', 'dist/pinterest-products.csv'));
const INDEX = path.resolve(ROOT, flag('index', 'dist/index.html'));
const LABEL = flag('custom-label-0', 'harvester'); // the lifecycle cohort this feed carries
const UTM = !process.argv.includes('--no-utm');

// Pinterest's sample data source header, in its order.
const COLUMNS = [
  'id', 'item_group_id', 'title', 'description', 'link', 'image_link', 'price', 'availability',
  'condition', 'google_product_category', 'product_type', 'additional_image_link', 'sale_price',
  'brand', 'gender', 'age_group', 'size', 'size_type', 'shipping', 'custom_label_0',
  'adwords_redirect',
];
// Pinterest rejects a row missing any of these.
const REQUIRED = ['id', 'title', 'description', 'link', 'image_link', 'price', 'availability'];
const MAX = { id: 127, item_group_id: 127, title: 500, description: 10000, link: 511, image_link: 2000 };
const AVAILABILITY = { in_stock: 'in stock', out_of_stock: 'out of stock', preorder: 'preorder' };
const MAX_ADDITIONAL_IMAGES = 10; // Pinterest's cap on the comma-separated list

// Merchant-facing product type: the leaf of the mapped Google taxonomy path
// ("… > Vehicle Covers > Spare Tire Covers" -> "Spare Tire Covers"). Blank when the title
// matched no category rule, so nothing is fabricated. Used for Pinterest product groups.
const productType = (category) => (category ? category.split('>').pop().trim() : '');

// Click URL with campaign tagging, so Pinterest traffic is attributable in the store's own
// analytics (which keys off utm_campaign) the same way Google traffic is.
const tagged = (link) =>
  !UTM || !link ? '' : `${link}${link.includes('?') ? '&' : '?'}utm_source=pinterest&utm_medium=cpc&utm_campaign=pinterest_shopping`;

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const cap = (v, n) => (n && v.length > n ? v.slice(0, n).trim() : v);

const lines = fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => l.length);
const header = lines[0].split('\t');
const rows = lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [header[i], v ?? ''])));

const out = [COLUMNS.join(',')];
const skipped = [];
for (const p of rows) {
  const link = p.url || '';
  const row = {
    id: p.item_id,
    // Only meaningful for multi-variant products; the feed collapses variants to one row, so
    // group_id === item_id and the column just marks the grouping.
    item_group_id: p.group_id || p.item_id,
    title: p.title,
    description: p.description,
    link,
    image_link: p.image_url,
    price: p.price, // already "31.95 USD" (ISO-4217), the lowest variant price
    availability: AVAILABILITY[p.availability] ?? '',
    condition: p.condition, // "new" — print-on-demand, made to order
    google_product_category: p.product_category,
    product_type: productType(p.product_category),
    additional_image_link: (p.additional_image_urls || '')
      .split(',').filter(Boolean).slice(0, MAX_ADDITIONAL_IMAGES).join(','),
    sale_price: '',
    brand: p.brand,
    gender: '',
    age_group: '',
    size: p.size || '',
    size_type: '',
    shipping: '',
    custom_label_0: LABEL,
    adwords_redirect: tagged(link),
  };
  for (const [k, n] of Object.entries(MAX)) row[k] = cap(row[k] ?? '', n);

  const missing = REQUIRED.filter((k) => !row[k]);
  if (missing.length) { skipped.push(`${row.id || '(no id)'}: missing ${missing.join(', ')}`); continue; }
  out.push(COLUMNS.map((c) => csvCell(row[c])).join(','));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${out.join('\n')}\n`);
const kept = out.length - 1;
console.log(`pinterest: ${kept} rows (custom_label_0=${LABEL}) -> ${OUT}`);
if (skipped.length) {
  console.log(`pinterest: skipped ${skipped.length} row(s) missing a required field`);
  for (const s of skipped.slice(0, 10)) console.log(`  ${s}`);
}

// Add the CSV to the human-facing listing make-parquet.py writes (idempotent).
if (fs.existsSync(INDEX)) {
  const name = path.basename(OUT);
  let html = fs.readFileSync(INDEX, 'utf8');
  html = html.replace(new RegExp(`\\s*<li><a href="${name}">[^\n]*\n`), '\n');
  const li = `    <li><a href="${name}">${name}</a> — Pinterest catalog CSV, ${kept} rows</li>\n`;
  html = html.replace('    <li><a href="manifest.json">', `${li}    <li><a href="manifest.json">`);
  fs.writeFileSync(INDEX, html);
  console.log(`pinterest: listed in ${INDEX}`);
}
