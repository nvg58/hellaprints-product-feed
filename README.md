# HellaPrints → OpenAI Commerce product feed

Generates a product feed for the [OpenAI commerce file-upload spec](https://developers.openai.com/commerce/specs/file-upload/products)
from the live hellaprints.com storefront API.

## Hosted URL (what OpenAI actually reads)

The connector's "Connect your feed via URL" dialog wants the **URL of the file**, not a directory —
a directory URL fails (`https://…/hellaprints-product-feed` 301-redirects and serves `text/html`).
So the whole catalog is published as one file:

```
https://nvg58.github.io/hellaprints-product-feed/products.parquet
```

Currently **244 rows** (the `harvester` lifecycle cohort — see "Which products go in" below),
zstd, `file_type=full-parquet`, no auth. `manifest.json` and `index.html` sit
next to it for humans, and the same rows are published as a **Pinterest catalog CSV**:

```
https://nvg58.github.io/hellaprints-product-feed/pinterest-products.csv
```

(see "Pinterest catalog CSV" below). Range requests work (206), so a reader can fetch the footer without pulling
the whole file. Keep it one shard: `make-parquet.py --rows-per-shard 200000` writes the plain
`products.parquet` name; anything above the shard size switches to `products-0000.parquet`, … and
the file URL would have to change. Published from
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

## Which products go in

`build --include-ids=include-ids.txt` restricts the feed to an allow-list of `item_id`s; without the
flag the whole ~96.7k catalog is published. `include-ids.txt` currently holds the **harvester**
cohort from the dashboard's `product_lifecycle` table (245 ids, 244 still in the storefront catalog).
Regenerate it whenever the cohort moves, then rebuild and publish:

```bash
node fetch-lifecycle-ids.mjs --state=harvester      # → include-ids.txt (reads ../dashboard/.env.local)
node gen-openai-product-feed.mjs build --include-ids=include-ids.txt --out=hellaprints-openai-products.tsv
python3 make-parquet.py --in hellaprints-openai-products.tsv --outdir dist --rows-per-shard 200000
./publish-feed.sh
```

`product_lifecycle.item_id` is the same 24-hex storefront product `_id` the feed uses as `item_id`,
so the join is direct.

The daily job doesn't need any of that: it pulls the cohort from the dashboard at
`/api/feed/lifecycle-ids?state=$FEED_STATE&token=$FEED_FETCH_TOKEN`
(dashboard PR #45), writes it to `include-ids.txt` and commits the refreshed copy. Config lives in
the feed repo — secret `FEED_FETCH_TOKEN`, optional variables `FEED_STATE` (default `harvester`)
and `DASHBOARD_URL`. With no secret set, or if the endpoint returns nothing, the run falls back to
the committed `include-ids.txt` rather than publishing an empty feed. Delete that file *and* unset
the secret to publish the whole catalog again.

## Output

| File | What |
|---|---|
| `dist/products-*.parquet` | What the hosted URL serves — zstd parquet, 50k rows/shard, every column UTF-8 string |
| `dist/pinterest-products.csv` | Pinterest catalog data source — same rows, Pinterest's column set (`make-pinterest-csv.mjs`) |
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

## Pinterest catalog CSV

`make-pinterest-csv.mjs` re-shapes the built TSV into the column set of Pinterest's own sample data
source, and drops the file into `dist/` so `publish-feed.sh` ships it to the same host:

```bash
node make-pinterest-csv.mjs                        # dist/pinterest-products.csv (+ index.html entry)
node make-pinterest-csv.mjs --custom-label-0=scout_plus --no-utm
```

Point Pinterest at
`https://nvg58.github.io/hellaprints-product-feed/pinterest-products.csv` (Catalogs → Data sources →
add a data source from URL, no auth, comma-delimited, daily fetch). The daily `refresh-feed`
workflow rebuilds it, so the cohort and prices track the parquet feed.

| Pinterest column | Source |
|---|---|
| `id`, `item_group_id` | `item_id` / `group_id` (equal — variants are collapsed to one row) |
| `title`, `description`, `link`, `image_link`, `price`, `brand` | as in the TSV; `price` keeps the `31.95 USD` ISO-4217 form and is the lowest variant price |
| `availability` | `in_stock` → `in stock` (Pinterest's wording) |
| `condition` | `new` |
| `google_product_category` | the mapped taxonomy path; blank when the title matched no rule |
| `product_type` | leaf of that path (`… > Spare Tire Covers` → `Spare Tire Covers`) — the grouping key for Pinterest product groups |
| `additional_image_link` | `additional_image_urls`, comma-separated, capped at Pinterest's 10 |
| `size` | only set for single-variant products |
| `custom_label_0` | the lifecycle cohort (`harvester`) — `--custom-label-0=` overrides |
| `adwords_redirect` | `link` + `utm_source=pinterest&utm_medium=cpc&utm_campaign=pinterest_shopping`, so Pinterest clicks are attributable in the store's own analytics; `--no-utm` emits the bare link |
| `sale_price`, `gender`, `age_group`, `size_type`, `shipping` | deliberately **empty** — see below |

Rows missing any Pinterest-required field (`id`, `title`, `description`, `link`, `image_link`,
`price`, `availability`) are skipped and listed in the run output rather than published broken.

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
- **`gender`, `age_group` and `size_type` stay empty** in the Pinterest CSV. The store states none of
  them per product, and a guessed value is worse than an absent one.

## Known data issues (merchant side, not feed bugs)

- **81 products** (0.1% of the typed catalog) carry a store description about a different product type
  — e.g. an acrylic plaque described as a "Custom Shape Photo Night Light". Listed in
  `description-mismatch-report.tsv`; fix them in the store and re-run `details` + `build` for those items.
- **175 products** have no usable store description and fall back to the generated one.
- **2 products** failed the PDP fetch across retries and also use the fallback.
