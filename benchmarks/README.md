# Metadata filtering benchmarks

Reproduction scripts and results for the performance section of the "Add metadata support" PR. This branch is `feature/metadata-support` plus this `benchmarks/` directory. Nothing here is intended to land.

## Setup

- Machine for the reported numbers: Apple M3 Pro, macOS 26, bun 1.3.6
- Corpus: 10,000 documents, one 8-dim vector per document, fresh SQLite database per scenario
- Method: 30 warmup iterations, then 300 timed iterations (FTS) or 60 (vec) per cell, `performance.now()` around each call, p50/p95/min reported
- Baseline: `v2.8.3` (`facd35e`), feature: `feature/metadata-support`

## Running

Each script takes a path to a QMD checkout and imports that tree's `src/store.ts`, so one script measures both trees:

```sh
# From a checkout of this branch, with dependencies installed (bun install)
git worktree add ../qmd-baseline v2.8.3
ln -s "$PWD/node_modules" ../qmd-baseline/node_modules

# Hot path + filtered selectivity sweep (scenario A: no metadata rows,
# scenario B: metadata on every document)
bun benchmarks/bench.ts ../qmd-baseline baseline
bun benchmarks/bench.ts . feature

# Attribution: collection-scoped vector search (the pre-existing exact-scan
# path that metadata filtering generalizes)
bun benchmarks/bench-vec-collection.ts ../qmd-baseline baseline
bun benchmarks/bench-vec-collection.ts . feature

# EXPLAIN QUERY PLAN for the unfiltered and filtered FTS shapes
bun benchmarks/explain.ts .

# Cleanup
rm ../qmd-baseline/node_modules
git worktree remove ../qmd-baseline
```

## Results

### Unfiltered hot path (regression check)

p50 per query. The hit-all FTS query matches all 10k documents. "No metadata" is an index with zero `document_metadata` rows (the existing-user upgrade case). "Full metadata" gives every document four metadata keys (worst case for the LEFT JOIN that returns result metadata).

| Scenario | Baseline | Feature, no metadata | Feature, full metadata |
|---|---|---|---|
| FTS hit-all query, limit 20 | 8.072ms | 8.084ms | 8.147ms |
| FTS rare query (1 match) | 0.114ms | 0.117ms | 0.119ms |
| Vec KNN, limit 20 | 14.724ms | 14.711ms | 13.738ms |

No measurable regression. The deltas are within run-to-run noise (baseline's own repeated runs varied by more than the baseline-to-feature delta).

### Filtered FTS selectivity sweep (feature, full metadata)

| Filter | Selectivity | p50 | p95 |
|---|---|---|---|
| none (reference) | 100% | 8.147ms | 8.507ms |
| status eq published | 90% | 8.204ms | 8.543ms |
| status eq draft | 10% | 8.356ms | 8.635ms |
| priority eq 50 | 1% | 7.976ms | 8.194ms |
| rare eq gold | 0.1% | 7.965ms | 8.133ms |
| status eq archived | 0% | 7.922ms | 8.202ms |
| nested and(all, or(eq, gte)) | ~90% | 8.614ms | 8.852ms |

Metadata filtering adds at most ~0.5ms to an 8ms query, even for a nested filter.

### Filtered vec vs collection scoping (exact-scan attribution)

The filtered vector path generalizes the existing collection exact-scan machinery (#791, #803). Cost tracks the eligible-set size and matches the pre-existing collection-scoped behavior:

| Scenario | Eligible set | Baseline | Feature |
|---|---|---|---|
| Collection-scoped vec | 90% (9k docs) | 306.042ms | 311.428ms |
| Collection-scoped vec | 10% (1k docs) | 41.653ms | 42.484ms |
| Metadata-filtered vec | 90% (9k docs) | n/a | 323.357ms |
| Metadata-filtered vec | 0.1% (10 docs) | n/a | 33.384ms |

Metadata-filtered vector search inherits the existing exact-scan cost profile (~5% over collection scoping at equal eligible-set size, for the metadata EXISTS predicates). The collection path itself does not regress. Above `FILTERED_VEC_EXACT_SCAN_MAX` (20,000 vectors) both fall back to global ANN with a capped over-fetch.

### Query plans

Unfiltered `searchFTS` keeps the FTS-first CTE shape. The LEFT JOIN that returns result metadata is a rowid primary-key lookup on only the emitted rows:

```text
CO-ROUTINE fts_matches
SCAN documents_fts VIRTUAL TABLE INDEX 0:M3
USE TEMP B-TREE FOR ORDER BY
SCAN fm
SEARCH d USING INTEGER PRIMARY KEY (rowid=?)
SEARCH content USING INDEX sqlite_autoindex_content_1 (hash=?)
SEARCH dm USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
```

Filtered `searchFTS` (and: status eq published, priority gte 3) keeps the same shape and resolves every EXISTS through the covering partial indexes:

```text
CO-ROUTINE fts_matches
SCAN documents_fts VIRTUAL TABLE INDEX 0:M3
USE TEMP B-TREE FOR ORDER BY
SCAN fm
SEARCH dm USING INTEGER PRIMARY KEY (rowid=?)
SEARCH d USING INTEGER PRIMARY KEY (rowid=?)
SEARCH content USING INDEX sqlite_autoindex_content_1 (hash=?)
SEARCH mv EXISTS USING COVERING INDEX idx_metadata_text_lookup (key=? AND text_value=? AND document_id=?)
SEARCH mv EXISTS USING COVERING INDEX idx_metadata_number_lookup (key=? AND number_value>?)
```
