// Benchmark: unfiltered search hot path (baseline vs feature) plus filtered
// selectivity sweep on the feature tree. Usage:
//   bun benchmarks/bench.ts <path-to-qmd-checkout> <label>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const treePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const label = process.argv[3] ?? treePath;
if (!treePath) throw new Error("usage: bench.ts <treePath> <label>");

interface MetadataStoreModule {
  replaceDocumentMetadata: (
    db: unknown,
    documentId: number,
    extraction: { metadata: Record<string, unknown>; extractionVersion: number },
  ) => void;
}

const store = await import(join(treePath, "src/store.ts"));
let metadataStore: MetadataStoreModule | null = null;
try {
  metadataStore = (await import(join(treePath, "src/metadata-store.ts"))) as MetadataStoreModule;
} catch {
  metadataStore = null;
}

const DOC_COUNT = 10_000;
const DIMENSIONS = 8;
const MODEL = "hf:bench/model.gguf";
const FTS_ITERATIONS = 300;
const VEC_ITERATIONS = 60;
const WARMUP = 30;

function docEmbedding(index: number): number[] {
  const angle = (index / DOC_COUNT) * Math.PI;
  const vector = new Array(DIMENSIONS).fill(0.1);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  return vector;
}

const queryEmbedding = docEmbedding(0);

function docMetadata(index: number): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    status: index % 10 === 0 ? "draft" : "published", // draft 10%, published 90%
    priority: index % 100, // eq -> 1%
    topics: ["alpha", index % 2 === 0 ? "even" : "odd"],
  };
  if (index % 1000 === 0) metadata.rare = "gold"; // 0.1%
  return metadata;
}

async function seed(withMetadata: boolean): Promise<{ db: unknown; close: () => void; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "qmd-bench-"));
  const s = store.createStore(join(dir, "bench.sqlite"));
  const now = new Date().toISOString();
  s.ensureVecTable(DIMENSIONS);
  s.db.exec("BEGIN");
  for (let i = 0; i < DOC_COUNT; i++) {
    const body = `# Document ${i}\n\ncommon keyword shared by all files\nunique token u${i}\nfiller line ${i % 7}`;
    const hash = await store.hashContent(body);
    store.insertContent(s.db, hash, body, now);
    const documentId = store.insertDocument(s.db, "bench", `doc-${i}.md`, `Document ${i}`, hash, now, now);
    store.insertEmbedding(s.db, hash, 0, 0, new Float32Array(docEmbedding(i)), MODEL, now, 1);
    if (withMetadata && metadataStore) {
      metadataStore.replaceDocumentMetadata(s.db, documentId, {
        metadata: docMetadata(i),
        extractionVersion: 1,
      });
    }
  }
  s.db.exec("COMMIT");
  return { db: s.db, close: () => s.close(), dir };
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return `p50=${at(0.5).toFixed(3)}ms p95=${at(0.95).toFixed(3)}ms min=${sorted[0]!.toFixed(3)}ms`;
}

async function time(name: string, iterations: number, run: () => unknown | Promise<unknown>): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  console.log(`${label} | ${name} | ${stats(samples)}`);
}

async function benchCommon(db: unknown, scenario: string): Promise<void> {
  const anyDb = db as never;
  const check = store.searchFTS(anyDb, "common keyword", 20);
  if (check.length !== 20) throw new Error(`FTS sanity failed: ${check.length}`);
  await time(`${scenario} unfiltered FTS (hit-all query, limit 20)`, FTS_ITERATIONS, () =>
    store.searchFTS(anyDb, "common keyword", 20));
  await time(`${scenario} unfiltered FTS (rare query)`, FTS_ITERATIONS, () =>
    store.searchFTS(anyDb, "u4242", 20));
  const vecCheck = await store.searchVec(anyDb, "q", MODEL, 20, undefined, undefined, queryEmbedding);
  if (vecCheck.length !== 20) throw new Error(`vec sanity failed: ${vecCheck.length}`);
  await time(`${scenario} unfiltered vec (KNN, limit 20)`, VEC_ITERATIONS, () =>
    store.searchVec(anyDb, "q", MODEL, 20, undefined, undefined, queryEmbedding));
}

// Scenario A: no metadata rows at all (existing-user upgrade case).
{
  const { db, close, dir } = await seed(false);
  await benchCommon(db, "no-metadata");
  close();
  rmSync(dir, { recursive: true, force: true });
}

// Scenario B: every document carries metadata (worst case for the LEFT JOIN).
{
  const { db, close, dir } = await seed(Boolean(metadataStore));
  await benchCommon(db, metadataStore ? "full-metadata" : "full-metadata(seed-skipped)");

  if (metadataStore) {
    const anyDb = db as never;
    const filters: Array<[string, unknown]> = [
      ["filtered FTS 90% (status eq published)", { key: "status", operator: "eq", value: "published" }],
      ["filtered FTS 10% (status eq draft)", { key: "status", operator: "eq", value: "draft" }],
      ["filtered FTS 1% (priority eq 50)", { key: "priority", operator: "eq", value: 50 }],
      ["filtered FTS 0.1% (rare eq gold)", { key: "rare", operator: "eq", value: "gold" }],
      ["filtered FTS 0% (status eq archived)", { key: "status", operator: "eq", value: "archived" }],
      ["filtered FTS nested (and/or/all)", {
        operator: "and",
        operands: [
          { key: "topics", operator: "all", value: ["alpha", "even"] },
          {
            operator: "or",
            operands: [
              { key: "status", operator: "eq", value: "published" },
              { key: "priority", operator: "gte", value: 90 },
            ],
          },
        ],
      }],
    ];
    for (const [name, filter] of filters) {
      await time(name, FTS_ITERATIONS, () => store.searchFTS(anyDb, "common keyword", 20, undefined, filter));
    }
    await time("filtered vec 90% (exact scan)", VEC_ITERATIONS, () =>
      store.searchVec(anyDb, "q", MODEL, 20, undefined, undefined, queryEmbedding, undefined,
        { key: "status", operator: "eq", value: "published" }));
    await time("filtered vec 0.1% (exact scan)", VEC_ITERATIONS, () =>
      store.searchVec(anyDb, "q", MODEL, 20, undefined, undefined, queryEmbedding, undefined,
        { key: "rare", operator: "eq", value: "gold" }));
  }

  close();
  rmSync(dir, { recursive: true, force: true });
}
