# HellaPrints → OpenAI Commerce product feed

Generates a product feed for the [OpenAI commerce file-upload spec](https://developers.openai.com/commerce/specs/file-upload/products)
from the live hellaprints.com storefront API.

## Hosted URL (what OpenAI actually reads)

The feed connector is configured as **Hosted URL** with `file_type=full-parquet`, prefix:

```
https://nvg58.github.io/hellaprints-product-feed/
```

Files under that prefix: `products-0000.parquet`, `products-0001.parquet` (zstd, ~27 MB total),
plus `manifest.json` and an `index.html` listing. Published from
[nvg58/hellaprints-product-feed](https://github.com/nvg58/hellaprints-product-feed) — `main` holds
these scripts, `gh-pages` holds the snapshot and is force-pushed as a single commit each run so the
27 MB payload never accumulates in git history. `.github/workflows/refresh-feed.yml` (from
`refresh-feed.yml` here) re-publishes daily at 09:20 UTC.

```bash
node gen-openai-product-feed.mjs catalog          # fresh prices/titles/images
node gen-openai-product-feed.mjs details          # only products missing from the PDP cache
node gen-openai-product-feed.mjs build --out=hellaprints-openai-products.tsv
python3 make-parquet.py --in hellaprints-openai-products.tsv --outdir dist
./publish-feed.sh
```

## Output

| File | What |
|---|---|
| `dist/products-*.parquet` | What the hosted URL serves — zstd parquet, 50k rows/shard, every column UTF-8 string |
| `hellaprints-openai-products.tsv` | The feed — UTF-8, tab-delimited, header row, 1 row per product (~96.7k) |
| `hellaprints-openai-products.csv` | Same rows, RFC 4180 CSV — for the "Upload CSV or TXT" dialog (rename to `.txt` to upload the tab-delimited one) |
| `hellaprints-openai-products.tsv.gz` | Same file gzipped (~29 MB) — the spec accepts `.tsv.gz` |
| `description-mismatch-report.tsv` | Products whose store description talks about a different product type (merchant data issue, not a feed bug) |
| `data/products.jsonl` | Raw catalog cache from the list API |
| `data/details.jsonl` | Per-product PDP cache (description, variants, gallery) |

## Usage

```bash
node gen-openai-product-feed.mjs all --concurrency=20
```

Stages run independently and are resumable (`details` skips anything already in `data/details.jsonl`):

```bash
node gen-openai-product-feed.mjs catalog     # list API → data/products.jsonl (~7 min)
node gen-openai-product-feed.mjs details     # PDP crawl → data/details.jsonl (~2 h @ 20 conc.)
node gen-openai-product-feed.mjs build       # → hellaprints-openai-products.tsv (~1 min)
node validate-feed.mjs hellaprints-openai-products.tsv --sample-urls=30
```

Flags: `--limit=N` (smoke test), `--concurrency=N`, `--out=path`.

## Where each field comes from

Source A = `GET /api/product/products/advanced-search` (list, 500/page, 194 pages).
Source B = `__NEXT_DATA__` embedded in the PDP at `https://hellaprints.com/<slug>` — the list API
does **not** return `description` and there is no public product feed on the domain.

| Field | Source |
|---|---|
| `item_id`, `group_id` | A — product `_id` (stable) |
| `title` | A — `title`, capped at 150 chars |
| `description` | B — `product.description`, HTML stripped to plain text, capped 5,000 chars |
| `url` | `https://hellaprints.com/<slug>` (note: `/products/<slug>` 404s) |
| `image_url` | A — `image` (CloudFront JPEG), `thumbnail` fallback |
| `additional_image_urls` | B — `gallery_uris` → `<cdn>/<uri>/regular.jpg` (up to 8) |
| `price` | B — lowest variant `retail_price` (the "from" price the PDP shows); A `retail_price` fallback |
| `availability` | `in_stock` — print-on-demand, made to order |
| `mpn` | A — default variant Merchize SKU; product `_id` when the SKU is missing (no GTINs exist) |
| `product_category` | Keyword map over the title (26 types → Google taxonomy path). Unmatched → blank, never guessed |
| `listing_has_variations` | B — `variants.length > 1` |
| `size` | A — variant title, only for single-variant products (≤20 chars) |
| `return_policy` / `seller_privacy_policy` / `seller_tos` | `/pages/returns`, `/pages/privacy`, `/pages/terms` — verified to render real content (many other `/pages/*` slugs return HTTP 200 with an empty page) |
| `accepts_returns`, `return_deadline_in_days` | `true`, `60` — the site-wide 60-day free-returns offer |
| `is_eligible_search` | `true` |
| `is_eligible_checkout` | `false` — the store is not wired to OpenAI Instant Checkout. Flip to `true` only after the checkout integration exists |
| `target_countries`, `store_country` | `US` |

## Deliberate choices

- **One row per product, not per variant.** The list API returns only the default variant; the PDP
  returns all of them (a single shirt has 126). Variant-level rows would blow the feed up into the
  millions, so variants are collapsed: `group_id` = `item_id`, `listing_has_variations` flags them,
  and `price` is the lowest variant price.
- **No invented attributes.** Fallback descriptions (used when the store description is missing or
  under 40 chars) are built only from title + variant options + the verified free-US-shipping-$35+
  and 60-day-returns offers. No fabricated material, review, or compatibility claims.
- **`sale_price` is omitted.** The site-wide quantity discount (buy 2 / 4 / 6+) is a cart-level rule,
  not a per-item sale price.
- **`shipping` is omitted.** Free US shipping is conditional on a $35+ order, which the single-line
  `shipping` field cannot express faithfully.

## Known data issues (merchant side, not feed bugs)

- **81 products** (0.1% of the typed catalog) carry a store description about a different product type
  — e.g. an acrylic plaque described as a "Custom Shape Photo Night Light". Listed in
  `description-mismatch-report.tsv`; fix them in the store and re-run `details` + `build` for those items.
- **175 products** have no usable store description and fall back to the generated one.
- **2 products** failed the PDP fetch across retries and also use the fallback.
