// Compare collection-scoped vec search (upstream exact-scan path) across
// trees, to attribute filtered-vec cost. Usage:
//   bun benchmarks/bench-vec-collection.ts <path-to-qmd-checkout> <label>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const treePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const label = process.argv[3] ?? treePath;
if (!treePath) throw new Error("usage: bench-vec-collection.ts <treePath> <label>");

const store = await import(join(treePath, "src/store.ts"));

const DOC_COUNT = 10_000;
const DIMENSIONS = 8;
const MODEL = "hf:bench/model.gguf";
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
const dir = mkdtempSync(join(tmpdir(), "qmd-bench-vc-"));
const s = store.createStore(join(dir, "bench.sqlite"));
const now = new Date().toISOString();
s.ensureVecTable(DIMENSIONS);
s.db.exec("BEGIN");
for (let i = 0; i < DOC_COUNT; i++) {
  const body = `# Document ${i}\n\ncommon keyword shared by all files\nunique token u${i}`;
  const hash = await store.hashContent(body);
  store.insertContent(s.db, hash, body, now);
  // Split docs across two collections so a scoped search exact-scans 90%.
  const collection = i % 10 === 0 ? "small" : "big";
  store.insertDocument(s.db, collection, `doc-${i}.md`, `Document ${i}`, hash, now, now);
  store.insertEmbedding(s.db, hash, 0, 0, new Float32Array(docEmbedding(i)), MODEL, now, 1);
}
s.db.exec("COMMIT");

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return `p50=${at(0.5).toFixed(3)}ms p95=${at(0.95).toFixed(3)}ms min=${sorted[0]!.toFixed(3)}ms`;
}

async function time(name: string, run: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < VEC_ITERATIONS; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  console.log(`${label} | ${name} | ${stats(samples)}`);
}

await time("collection-scoped vec 90% (exact scan)", () =>
  store.searchVec(s.db, "q", MODEL, 20, "big", undefined, queryEmbedding));
await time("collection-scoped vec 10% (exact scan)", () =>
  store.searchVec(s.db, "q", MODEL, 20, "small", undefined, queryEmbedding));

s.close();
rmSync(dir, { recursive: true, force: true });
