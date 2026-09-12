/**
 * metadata-discovery.test.ts - Store-level metadata discovery: key summaries,
 * per-type value windows, scope and gate agreement with filtered search, and
 * the picomatch/GLOB pruning contract.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import picomatch from "picomatch";
import {
  createStore,
  insertContent,
  insertDocument,
  hashContent,
  searchFTS,
  type Store,
} from "../src/store.js";
import {
  buildGlobPrefilter,
  countDocumentsPendingMetadata,
  countDocumentsWithMetadata,
  listMetadata,
  listMetadataKeys,
  replaceDocumentMetadata,
  type ListMetadataOptions,
  type MetadataKeySummary,
} from "../src/metadata-store.js";
import { METADATA_EXTRACTION_VERSION, type DocumentMetadata } from "../src/metadata.js";

let testDir: string;
let store: Store;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-metadata-discovery-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  const dbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  store = createStore(dbPath);
});

afterEach(() => {
  store.close();
});

let documentCounter = 0;

/** Insert an active document with extracted metadata. Every body contains "doc" so FTS can reach it. */
async function insertMetadataDoc(collection: string, metadata: DocumentMetadata): Promise<number> {
  documentCounter += 1;
  const path = `doc-${documentCounter}.md`;
  const content = `# doc ${documentCounter}\n\nbody of doc ${documentCounter}\n`;
  const now = new Date().toISOString();
  const hash = await hashContent(content);
  insertContent(store.db, hash, content, now);
  const documentId = insertDocument(store.db, collection, path, path, hash, now, now);
  replaceDocumentMetadata(store.db, documentId, { metadata, extractionVersion: METADATA_EXTRACTION_VERSION });
  return documentId;
}

function summaryOf(keys: MetadataKeySummary[], key: string): MetadataKeySummary {
  const summary = keys.find(candidate => candidate.key === key);
  if (!summary) throw new Error(`key ${key} missing from ${keys.map(candidate => candidate.key).join(", ")}`);
  return summary;
}

function valuesOf(keys: MetadataKeySummary[], key: string): [string | number | boolean, number][] {
  return summaryOf(keys, key).types[0]!.values.map(count => [count.value, count.documents]);
}

describe("listMetadata counting", () => {
  test("counts documents, not values, and reports coverage per key", async () => {
    await insertMetadataDoc("notes", { topics: ["a", "b"], status: "draft" });
    await insertMetadataDoc("notes", { topics: ["a"], status: "published" });
    await insertMetadataDoc("notes", { status: "published" });

    const result = listMetadata(store.db);

    expect(result.documents).toBe(3);
    expect(result.filteredDocuments).toBeUndefined();
    expect(result.keys.map(summary => summary.key)).toEqual(["status", "topics"]);

    const topics = summaryOf(result.keys, "topics");
    expect(topics.documents).toBe(2);
    expect(topics.types).toHaveLength(1);
    expect(topics.types[0]!.multiValued).toBe(true);
    expect(topics.types[0]!.distinctValues).toBe(2);
    expect(valuesOf(result.keys, "topics")).toEqual([["a", 2], ["b", 1]]);

    const status = summaryOf(result.keys, "status");
    expect(status.documents).toBe(3);
    expect(status.types[0]!.multiValued).toBe(false);
    expect(valuesOf(result.keys, "status")).toEqual([["published", 2], ["draft", 1]]);
  });

  test("returns an empty key list when nothing has metadata", async () => {
    await insertMetadataDoc("notes", {});

    const result = listMetadata(store.db);

    expect(result).toEqual({ documents: 1, keys: [] });
  });

  test("applies the extraction gate filtered search applies", async () => {
    await insertMetadataDoc("notes", { status: "visible" });
    const pendingId = await insertMetadataDoc("notes", { status: "pending" });
    const erroredId = await insertMetadataDoc("notes", { status: "errored" });
    const staleId = await insertMetadataDoc("notes", { status: "stale" });
    const inactiveId = await insertMetadataDoc("notes", { status: "inactive" });

    store.db.prepare(`DELETE FROM document_metadata WHERE document_id = ?`).run(pendingId);
    store.db.prepare(`UPDATE document_metadata SET extraction_error = 'boom' WHERE document_id = ?`).run(erroredId);
    store.db.prepare(`UPDATE document_metadata SET extraction_version = ? WHERE document_id = ?`).run(METADATA_EXTRACTION_VERSION - 1, staleId);
    store.db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(inactiveId);

    const result = listMetadata(store.db);

    // The denominator counts active documents whether or not they are extracted.
    expect(result.documents).toBe(4);
    expect(valuesOf(result.keys, "status")).toEqual([["visible", 1]]);
  });
});

describe("listMetadata scope and filter", () => {
  beforeEach(async () => {
    await insertMetadataDoc("notes", { status: "published", priority: 3 });
    await insertMetadataDoc("notes", { status: "draft", priority: 1 });
    await insertMetadataDoc("work", { status: "published", priority: 5 });
    await insertMetadataDoc("work", { status: "archived" });
  });

  test("undefined collection means every collection", () => {
    const result = listMetadata(store.db);

    expect(result.documents).toBe(4);
    expect(summaryOf(result.keys, "status").documents).toBe(4);
    expect(summaryOf(result.keys, "status").types[0]!.collections).toEqual(["notes", "work"]);
  });

  test("a single collection scopes counts and the denominator", () => {
    const result = listMetadata(store.db, { collection: "notes" });

    expect(result.documents).toBe(2);
    expect(valuesOf(result.keys, "status")).toEqual([["draft", 1], ["published", 1]]);
    expect(summaryOf(result.keys, "status").types[0]!.collections).toEqual(["notes"]);
  });

  test("a collection list scopes to exactly those collections", async () => {
    await insertMetadataDoc("other", { status: "elsewhere" });

    const result = listMetadata(store.db, { collection: ["notes", "work"] });

    expect(result.documents).toBe(4);
    expect(valuesOf(result.keys, "status").map(([value]) => value)).not.toContain("elsewhere");
  });

  test("an unknown collection yields an empty scope", () => {
    const result = listMetadata(store.db, { collection: "missing" });

    expect(result).toEqual({ documents: 0, keys: [] });
  });

  test("filter narrows which documents are counted and reports how many pass", () => {
    const result = listMetadata(store.db, {
      filter: { key: "status", operator: "eq", value: "published" },
    });

    expect(result.documents).toBe(4);
    expect(result.filteredDocuments).toBe(2);
    expect(summaryOf(result.keys, "priority").documents).toBe(2);
    expect(valuesOf(result.keys, "priority")).toEqual([[3, 1], [5, 1]]);
    expect(valuesOf(result.keys, "status")).toEqual([["published", 2]]);
  });

  test("filter composes with the same AST search accepts", () => {
    const result = listMetadata(store.db, {
      filter: {
        operator: "and",
        operands: [
          { key: "status", operator: "eq", value: "published" },
          { key: "priority", operator: "gte", value: 4 },
        ],
      },
    });

    expect(result.filteredDocuments).toBe(1);
    expect(summaryOf(result.keys, "status").types[0]!.collections).toEqual(["work"]);
  });
});

describe("listMetadata key and value patterns", () => {
  beforeEach(async () => {
    await insertMetadataDoc("notes", { topics: ["typescript", "sqlite"], owner: "docs-team", "mem-kind": "fact", priority: 3, reviewed: true });
    await insertMetadataDoc("notes", { topics: ["typescript"], owner: "search-team", reviewers: ["docs-team", "security-team"], "mem-scope": "user", priority: 10, reviewed: false });
  });

  test("an exact key pattern matches only that key", () => {
    const result = listMetadata(store.db, { key: "topics" });

    expect(result.keys.map(summary => summary.key)).toEqual(["topics"]);
    expect(valuesOf(result.keys, "topics")).toEqual([["typescript", 2], ["sqlite", 1]]);
  });

  test("a key glob selects a family of keys", () => {
    const result = listMetadata(store.db, { key: "mem-*" });

    expect(result.keys.map(summary => summary.key)).toEqual(["mem-kind", "mem-scope"]);
  });

  test("a key pattern matching nothing yields an empty key list", () => {
    const result = listMetadata(store.db, { key: "missing-*" });

    expect(result.keys).toEqual([]);
    expect(result.documents).toBe(2);
  });

  test("an exact value pattern is a reverse lookup across keys", () => {
    const result = listMetadata(store.db, { value: "docs-team" });

    expect(result.keys.map(summary => summary.key)).toEqual(["owner", "reviewers"]);
    expect(summaryOf(result.keys, "owner").documents).toBe(1);
    expect(summaryOf(result.keys, "owner").types[0]!.distinctValues).toBe(1);
    expect(valuesOf(result.keys, "reviewers")).toEqual([["docs-team", 1]]);
  });

  test("a value glob keeps only matching values and their document counts", () => {
    const result = listMetadata(store.db, { key: "topics", value: "type*" });

    expect(valuesOf(result.keys, "topics")).toEqual([["typescript", 2]]);
    expect(summaryOf(result.keys, "topics").types[0]!.remaining).toBe(0);
    // Array-ness describes the key, not the matched rows.
    expect(summaryOf(result.keys, "topics").types[0]!.multiValued).toBe(true);
  });

  test("numbers and booleans match by their text form", () => {
    expect(listMetadata(store.db, { value: "10" }).keys.map(summary => summary.key)).toEqual(["priority"]);
    expect(valuesOf(listMetadata(store.db, { value: "1*" }).keys, "priority")).toEqual([[10, 1]]);
    expect(listMetadata(store.db, { value: "true" }).keys.map(summary => summary.key)).toEqual(["reviewed"]);
    expect(valuesOf(listMetadata(store.db, { value: "true" }).keys, "reviewed")).toEqual([[true, 1]]);
  });

  test("a numeric range reflects only the matched values", () => {
    const result = listMetadata(store.db, { key: "priority", value: "1*" });

    expect(summaryOf(result.keys, "priority").types[0]!.range).toEqual({ min: 10, median: 10, max: 10 });
  });

  test("a value pattern matching nothing yields an empty key list", () => {
    const result = listMetadata(store.db, { value: "missing" });

    expect(result.keys).toEqual([]);
  });

  test("patterns needing the picomatch fallback still match", () => {
    expect(listMetadata(store.db, { value: "{docs-team,search-team}" }).keys.map(summary => summary.key)).toEqual(["owner", "reviewers"]);
    expect(valuesOf(listMetadata(store.db, { key: "topics", value: "!(typescript)" }).keys, "topics")).toEqual([["sqlite", 1]]);
  });
});

describe("listMetadata value window", () => {
  beforeEach(async () => {
    const tags = ["a", "a", "a", "b", "b", "c", "d", "d", "d", "d"];
    for (const tag of tags) await insertMetadataDoc("notes", { tag });
  });

  test("defaults to count order with a stable tiebreak", () => {
    expect(valuesOf(listMetadata(store.db).keys, "tag")).toEqual([["d", 4], ["a", 3], ["b", 2], ["c", 1]]);
  });

  test("sort by value orders ascending", () => {
    expect(valuesOf(listMetadata(store.db, { sort: "value" }).keys, "tag")).toEqual([["a", 3], ["b", 2], ["c", 1], ["d", 4]]);
  });

  test("limit windows values and reports the exact remainder", () => {
    const tag = summaryOf(listMetadata(store.db, { limit: 2 }).keys, "tag").types[0]!;

    expect(tag.values.map(count => count.value)).toEqual(["d", "a"]);
    expect(tag.distinctValues).toBe(4);
    expect(tag.remaining).toBe(2);
  });

  test("an infinite limit removes the window", () => {
    const tag = summaryOf(listMetadata(store.db, { limit: Infinity }).keys, "tag").types[0]!;

    expect(tag.values).toHaveLength(4);
    expect(tag.remaining).toBe(0);
  });

  test("minCount drops the tail from the values, distinct count, and remainder", () => {
    const tag = summaryOf(listMetadata(store.db, { minCount: 3, limit: 1 }).keys, "tag").types[0]!;

    expect(tag.values).toEqual([{ value: "d", documents: 4 }]);
    expect(tag.distinctValues).toBe(2);
    expect(tag.remaining).toBe(1);
    // Coverage still counts every document holding the key.
    expect(tag.documents).toBe(10);
  });

  test("a minCount nothing meets leaves the key with an empty window", () => {
    const tag = summaryOf(listMetadata(store.db, { minCount: 99 }).keys, "tag").types[0]!;

    expect(tag.values).toEqual([]);
    expect(tag.distinctValues).toBe(0);
    expect(tag.remaining).toBe(0);
  });
});

describe("listMetadata numbers", () => {
  test("reports min, median, and max for an odd count", async () => {
    for (const priority of [5, 1, 3]) await insertMetadataDoc("notes", { priority });

    const priority = summaryOf(listMetadata(store.db).keys, "priority").types[0]!;

    expect(priority.range).toEqual({ min: 1, median: 3, max: 5 });
    expect(priority.values.map(count => count.value)).toEqual([1, 3, 5]);
  });

  test("averages the middle values for an even count", async () => {
    for (const priority of [1, 2, 3, 10]) await insertMetadataDoc("notes", { priority });

    expect(summaryOf(listMetadata(store.db).keys, "priority").types[0]!.range).toEqual({ min: 1, median: 2.5, max: 10 });
  });

  test("median counts every value row, including array elements", async () => {
    await insertMetadataDoc("notes", { scores: [1, 1, 1] });
    await insertMetadataDoc("notes", { scores: [9] });

    const scores = summaryOf(listMetadata(store.db).keys, "scores").types[0]!;

    expect(scores.range).toEqual({ min: 1, median: 1, max: 9 });
    expect(scores.values).toEqual([{ value: 1, documents: 1 }, { value: 9, documents: 1 }]);
  });

  test("strings and booleans carry no range", async () => {
    await insertMetadataDoc("notes", { status: "x", reviewed: true });

    const result = listMetadata(store.db);

    expect(summaryOf(result.keys, "status").types[0]!.range).toBeUndefined();
    expect(summaryOf(result.keys, "reviewed").types[0]!.range).toBeUndefined();
  });
});

describe("listMetadata type conflicts and attribution", () => {
  test("splits a key by type and partitions its documents", async () => {
    await insertMetadataDoc("notes", { priority: 3 });
    await insertMetadataDoc("notes", { priority: 1 });
    await insertMetadataDoc("work", { priority: "high" });

    const priority = summaryOf(listMetadata(store.db).keys, "priority");

    expect(priority.documents).toBe(3);
    expect(priority.types.map(typeSummary => [typeSummary.type, typeSummary.documents])).toEqual([["number", 2], ["string", 1]]);
    expect(priority.types[0]!.range).toEqual({ min: 1, median: 2, max: 3 });
    expect(priority.types[0]!.collections).toEqual(["notes"]);
    expect(priority.types[1]!.collections).toEqual(["work"]);
    expect(priority.types[1]!.values).toEqual([{ value: "high", documents: 1 }]);
  });

  test("orders equally covered types by name", async () => {
    await insertMetadataDoc("notes", { flag: true });
    await insertMetadataDoc("notes", { flag: "yes" });

    expect(summaryOf(listMetadata(store.db).keys, "flag").types.map(typeSummary => typeSummary.type)).toEqual(["boolean", "string"]);
  });

  test("orders keys by coverage descending, then name", async () => {
    await insertMetadataDoc("notes", { zeta: 1, alpha: 1, mid: 1 });
    await insertMetadataDoc("notes", { zeta: 1, alpha: 1 });
    await insertMetadataDoc("notes", { zeta: 1 });

    expect(listMetadata(store.db).keys.map(summary => summary.key)).toEqual(["zeta", "alpha", "mid"]);
  });
});

describe("listMetadata agrees with filtered search", () => {
  test("every reported value is reachable through an eq filter under the same scope", async () => {
    await insertMetadataDoc("notes", { topics: ["a", "b"], priority: 3, reviewed: true, owner: "docs-team" });
    await insertMetadataDoc("notes", { topics: ["b"], priority: 1.5, reviewed: false });
    await insertMetadataDoc("work", { topics: ["c"], priority: 3 });
    const pendingId = await insertMetadataDoc("notes", { topics: ["ghost"] });
    store.db.prepare(`DELETE FROM document_metadata WHERE document_id = ?`).run(pendingId);

    const scopes: ListMetadataOptions[] = [{}, { collection: "notes" }, { collection: ["notes", "work"] }];
    for (const scope of scopes) {
      const result = listMetadata(store.db, { ...scope, limit: Infinity });
      expect(result.keys.length).toBeGreaterThan(0);

      for (const summary of result.keys) {
        for (const typeSummary of summary.types) {
          for (const count of typeSummary.values) {
            const hits = searchFTS(store.db, "doc", 100, scope.collection, { key: summary.key, operator: "eq", value: count.value });
            expect(hits, `${summary.key} = ${String(count.value)}`).toHaveLength(count.documents);
          }
        }
      }
    }
  });
});

describe("status view helpers", () => {
  beforeEach(async () => {
    await insertMetadataDoc("notes", { status: "published", priority: 3 });
    await insertMetadataDoc("notes", { status: "draft" });
    await insertMetadataDoc("notes", {});
    await insertMetadataDoc("work", { priority: "high", source: "jira" });
    const pendingId = await insertMetadataDoc("work", { status: "ghost" });
    store.db.prepare(`DELETE FROM document_metadata WHERE document_id = ?`).run(pendingId);
  });

  test("listMetadataKeys reports names, coverage, and types in coverage order", () => {
    expect(listMetadataKeys(store.db)).toEqual([
      { key: "priority", documents: 2, types: ["number", "string"] },
      { key: "status", documents: 2, types: ["string"] },
      { key: "source", documents: 1, types: ["string"] },
    ]);
    expect(listMetadataKeys(store.db, ["work"])).toEqual([
      { key: "priority", documents: 1, types: ["string"] },
      { key: "source", documents: 1, types: ["string"] },
    ]);
    expect(listMetadataKeys(store.db, ["missing"])).toEqual([]);
  });

  test("countDocumentsWithMetadata counts extracted documents declaring a key", () => {
    expect(countDocumentsWithMetadata(store.db)).toBe(3);
    expect(countDocumentsWithMetadata(store.db, ["notes"])).toBe(2);
  });

  test("countDocumentsPendingMetadata accepts a collection scope", () => {
    expect(countDocumentsPendingMetadata(store.db)).toBe(1);
    expect(countDocumentsPendingMetadata(store.db, ["notes"])).toBe(0);
    expect(countDocumentsPendingMetadata(store.db, ["work"])).toBe(1);
  });
});

describe("buildGlobPrefilter", () => {
  const values = [
    "typescript", "type", "sqlite", "a/b", "a/b/c", ".env", "x.env", "2025-01-02", "https://a.b/c",
    "a b", "a*b", "a?b", "a[1]", "a{b}", "a(b)", "a|b", "a\\b", "TypeScript", "", "./a", "a",
  ];

  const prunable = ["*", "type*", "*script", "t?pe", "2025-*", "https://*", "a*b", "a", "a b", ".env", "*.env", "?", "a/*"];
  const fallback = ["{a,b}", "a[1]", "!(a)", "!a", "+(a)", "@(a)", "(a|b)", "a|b", "a\\*", "./a", "a/./b", "\\a", "**", "a/**"];

  function globMatches(value: string, pattern: string): boolean {
    const row = store.db.prepare(`SELECT ? GLOB ? AS matched`).get(value, pattern) as { matched: number };
    return row.matched === 1;
  }

  test("prunable patterns pass through unchanged", () => {
    for (const pattern of prunable) expect(buildGlobPrefilter(pattern), pattern).toBe(pattern);
  });

  test("patterns with features GLOB cannot mirror fall back to picomatch only", () => {
    for (const pattern of fallback) expect(buildGlobPrefilter(pattern), pattern).toBeNull();
  });

  test("GLOB never excludes a value picomatch would keep", () => {
    for (const pattern of prunable) {
      const isMatch = picomatch(pattern, { dot: true });
      for (const value of values) {
        if (!isMatch(value)) continue;
        expect(globMatches(value, pattern), `${JSON.stringify(pattern)} vs ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });

  test("picomatch remains the final word where GLOB is looser", () => {
    // GLOB's `*` crosses `/`, picomatch's does not.
    expect(globMatches("a/b", "*")).toBe(true);
    expect(picomatch("*", { dot: true })("a/b")).toBe(false);
    expect(picomatch("**", { dot: true })("a/b")).toBe(true);
  });
});
