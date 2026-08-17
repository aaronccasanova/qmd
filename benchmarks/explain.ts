// Print EXPLAIN QUERY PLAN for the unfiltered and filtered searchFTS SQL
// shapes on the feature tree.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tree = resolve(process.argv[2]!);
const store = await import(join(tree, "src/store.ts"));
const { compileMetadataFilter } = await import(join(tree, "src/metadata-filter.ts"));
const { replaceDocumentMetadata } = await import(join(tree, "src/metadata-store.ts"));

const dir = mkdtempSync(join(tmpdir(), "qmd-explain-"));
const s = store.createStore(join(dir, "explain.sqlite"));
const now = new Date().toISOString();
const body = "# Doc\n\ncommon keyword";
const hash = await store.hashContent(body);
store.insertContent(s.db, hash, body, now);
const id = store.insertDocument(s.db, "bench", "doc.md", "Doc", hash, now, now);
replaceDocumentMetadata(s.db, id, { metadata: { status: "published", priority: 3 }, extractionVersion: 1 });

function plan(name: string, sql: string, params: unknown[]): void {
  console.log(`== ${name}`);
  const rows = s.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { id: number; parent: number; detail: string }[];
  for (const row of rows) console.log(`  ${row.detail}`);
}

const base = (extra: string, ftsLimit: number) => `
  WITH fts_matches AS (
    SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) as bm25_score
    FROM documents_fts
    WHERE documents_fts MATCH ?
    ORDER BY bm25_score ASC
    LIMIT ${ftsLimit}
  )
  SELECT d.collection, d.path, content.doc, fm.bm25_score, dm.metadata_json
  FROM fts_matches fm
  JOIN documents d ON d.id = fm.rowid
  JOIN content ON content.hash = d.hash
  LEFT JOIN document_metadata dm ON dm.document_id = d.id
  WHERE d.active = 1${extra}
  ORDER BY fm.bm25_score ASC LIMIT ?`;

plan("unfiltered", base("", 20), ["common", 20]);

const compiled = compileMetadataFilter({
  operator: "and",
  operands: [
    { key: "status", operator: "eq", value: "published" },
    { key: "priority", operator: "gte", value: 3 },
  ],
}, "d");
plan(
  "filtered (and: status eq + priority gte)",
  base(` AND dm.extraction_version = 1 AND dm.extraction_error IS NULL AND ${compiled.sql}`, 200),
  ["common", ...compiled.params, 20],
);

s.close();
rmSync(dir, { recursive: true, force: true });
