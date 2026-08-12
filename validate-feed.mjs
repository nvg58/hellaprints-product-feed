#!/usr/bin/env node
/**
 * Validate a generated feed against the OpenAI commerce file-upload product spec.
 *   node validate-feed.mjs hellaprints-openai-products.tsv [--sample-urls=25]
 *
 * Checks every row for required fields, enum values, length caps and format rules,
 * then (optionally) HEAD-checks a random sample of product + image URLs.
 */
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2] || new URL('./hellaprints-openai-products.tsv', import.meta.url).pathname;
const sampleN = Number((process.argv.find((a) => a.startsWith('--sample-urls=')) || '').split('=')[1] || 25);

const REQUIRED = [
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
  'return_policy',
];
const MAXLEN = { item_id: 100, title: 150, description: 5000, brand: 70, seller_name: 70, mpn: 70, size: 20 };
const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'backorder', 'unknown']);
const BOOL = new Set(['true', 'false']);
const BOOL_FIELDS = ['is_eligible_search', 'is_eligible_checkout', 'listing_has_variations', 'accepts_returns', 'is_digital'];

const errs = new Map();
const bump = (k) => errs.set(k, (errs.get(k) || 0) + 1);
const examples = new Map();
const note = (k, v) => {
  if (!examples.has(k)) examples.set(k, v);
};

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
let header = null;
let n = 0;
const ids = new Set();
let dupes = 0;
const urls = [];
const images = [];

for await (const line of rl) {
  if (!line) continue;
  const cells = line.split('\t');
  if (!header) {
    header = cells;
    for (const f of REQUIRED) if (!header.includes(f)) bump(`missing required column: ${f}`);
    continue;
  }
  n++;
  if (cells.length !== header.length) {
    bump('column count mismatch');
    continue;
  }
  const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));

  for (const f of REQUIRED) if (!row[f]) { bump(`empty required field: ${f}`); note(`empty required field: ${f}`, row.item_id); }
  for (const [f, max] of Object.entries(MAXLEN)) {
    if (row[f] && row[f].length > max) { bump(`too long: ${f} (>${max})`); note(`too long: ${f} (>${max})`, row.item_id); }
  }
  if (row.availability && !AVAILABILITY.has(row.availability)) bump('bad availability enum');
  for (const f of BOOL_FIELDS) if (row[f] && !BOOL.has(row[f])) bump(`bad boolean: ${f}`);
  if (row.price && !/^\d+\.\d{2} [A-Z]{3}$/.test(row.price)) { bump('bad price format'); note('bad price format', row.price); }
  if (row.url && !/^https:\/\//.test(row.url)) bump('url not https');
  if (row.image_url && !/^https:\/\//.test(row.image_url)) bump('image_url not https');
  if (row.title && row.title === row.title.toUpperCase() && /[A-Z]{4}/.test(row.title)) bump('title is all caps');
  if (row.is_eligible_checkout === 'true' && (!row.seller_privacy_policy || !row.seller_tos)) bump('checkout eligible without privacy/tos');
  if (!row.mpn && !row.gtin) bump('no gtin and no mpn');
  if (ids.has(row.item_id)) dupes++;
  ids.add(row.item_id);
  if (urls.length < 5000) { urls.push(row.url); images.push(row.image_url); }
}

console.log(`rows: ${n}`);
console.log(`unique item_id: ${ids.size}${dupes ? ` (DUPLICATES: ${dupes})` : ''}`);
if (!errs.size) console.log('field validation: PASS — no violations');
else {
  console.log('field validation issues:');
  for (const [k, c] of [...errs].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.toString().padStart(7)}  ${k}${examples.has(k) ? `  e.g. ${examples.get(k)}` : ''}`);
  }
}

if (sampleN > 0) {
  const pick = (arr) => {
    const step = Math.max(1, Math.floor(arr.length / sampleN));
    return arr.filter((_, i) => i % step === 0).slice(0, sampleN);
  };
  const check = async (u) => {
    try {
      const r = await fetch(u, { method: 'GET', headers: { 'user-agent': 'feed-validator' } });
      return r.status;
    } catch {
      return 0;
    }
  };
  const uStat = {};
  const iStat = {};
  await Promise.all(pick(urls).map(async (u) => { const s = await check(u); uStat[s] = (uStat[s] || 0) + 1; }));
  await Promise.all(pick(images).map(async (u) => { const s = await check(u); iStat[s] = (iStat[s] || 0) + 1; }));
  console.log(`sampled ${sampleN} product urls:`, uStat);
  console.log(`sampled ${sampleN} image urls:`, iStat);
}
