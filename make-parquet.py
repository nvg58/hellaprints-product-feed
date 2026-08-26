#!/usr/bin/env python3
"""
Convert the generated feed TSV into zstd-compressed Parquet shards for the
OpenAI hosted-URL delivery (file_type=full-parquet + prefix).

    python3 make-parquet.py [--in hellaprints-openai-products.tsv] [--outdir dist]
                            [--rows-per-shard 50000] [--name products]

Every column is written as UTF-8 string, mirroring the delimited feed schema
exactly (price stays "32.95 USD", booleans stay "true"/"false") so the reader
sees the same values it would get from a CSV/TSV upload.

Shards are named <name>-0000.parquet, <name>-0001.parquet, ... and the set stays
stable across runs so each update overwrites the same file names. A manifest.json
and an index.html listing are written alongside for the hosting prefix.
"""
import argparse
import hashlib
import json
import os
import pathlib

import pyarrow as pa
import pyarrow.csv as pv
import pyarrow.parquet as pq

ap = argparse.ArgumentParser()
ap.add_argument('--in', dest='src', default='hellaprints-openai-products.tsv')
ap.add_argument('--outdir', default='dist')
ap.add_argument('--rows-per-shard', type=int, default=50000)
ap.add_argument('--name', default='products')
ap.add_argument('--manifest', default=None, help='manifest filename (default: <name>-manifest.json, or manifest.json for "products")')
args = ap.parse_args()

src = pathlib.Path(args.src)
outdir = pathlib.Path(args.outdir)
outdir.mkdir(parents=True, exist_ok=True)

delimiter = ',' if src.suffix.lower() == '.csv' else '\t'

with open(src, encoding='utf-8') as f:
    header = f.readline().rstrip('\n').split(delimiter)

table = pv.read_csv(
    src,
    parse_options=pv.ParseOptions(delimiter=delimiter, quote_char='"' if delimiter == ',' else False),
    convert_options=pv.ConvertOptions(
        column_types={c: pa.string() for c in header},
        strings_can_be_null=True,  # blank cell = field not provided, not an empty value
    ),
    read_options=pv.ReadOptions(block_size=64 << 20),
)
# Empty cells arrive as null; the feed treats them as "field not provided", so keep
# them null rather than inventing empty strings.
print(f'read {table.num_rows} rows x {table.num_columns} cols from {src}')

# Drop any stale shards from a previous, larger run so the published set is exact.
for old in outdir.glob(f'{args.name}-*.parquet'):
    old.unlink()

old_single = outdir / f'{args.name}.parquet'
if old_single.exists():
    old_single.unlink()

# One shard → publish it under a plain, stable file name (`products.parquet`) so the whole
# catalog is reachable as a single file URL; multiple shards get -0000, -0001, ... suffixes.
n_shards = -(-table.num_rows // args.rows_per_shard)

shards = []
for i, start in enumerate(range(0, table.num_rows, args.rows_per_shard)):
    chunk = table.slice(start, args.rows_per_shard)
    path = outdir / (f'{args.name}.parquet' if n_shards == 1 else f'{args.name}-{i:04d}.parquet')
    pq.write_table(chunk, path, compression='zstd', compression_level=9, version='2.6')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    shards.append({'file': path.name, 'rows': chunk.num_rows, 'bytes': path.stat().st_size, 'sha256': digest})
    print(f'  {path.name}: {chunk.num_rows} rows, {path.stat().st_size / 1e6:.1f} MB')

manifest = {
    'feed': f'hellaprints-{args.name}',
    'file_type': 'full-parquet',
    'compression': 'zstd',
    'rows': table.num_rows,
    'columns': header,
    'shards': shards,
}
manifest_name = args.manifest or ('manifest.json' if args.name == 'products' else f'{args.name}-manifest.json')
(outdir / manifest_name).write_text(json.dumps(manifest, indent=2) + '\n')

all_parquet = sorted(outdir.glob('*.parquet'))
all_manifests = sorted(outdir.glob('*manifest*.json'))
links = '\n'.join(
    f'    <li><a href="{f.name}">{f.name}</a> — {f.stat().st_size / 1e6:.1f} MB</li>' for f in all_parquet
) + '\n' + '\n'.join(
    f'    <li><a href="{f.name}">{f.name}</a></li>' for f in all_manifests
)
(outdir / 'index.html').write_text(
    '<!doctype html>\n<html><head><meta charset="utf-8">\n'
    '<title>HellaPrints product feeds (full-parquet)</title></head>\n<body>\n'
    '  <h1>HellaPrints product feeds</h1>\n'
    '  <p>file_type=full-parquet, zstd. Each parquet is a full snapshot of one cohort.</p>\n  <ul>\n'
    f'{links}\n'
    '  </ul>\n</body></html>\n'
)

total = sum(s['bytes'] for s in shards)
print(f'wrote {len(shards)} shard(s), {total / 1e6:.1f} MB total -> {outdir}/{manifest_name}')
