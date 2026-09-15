/**
 * metadata-filter.test.ts - Filter AST validation and parameterized SQL
 * compilation, including end-to-end predicate semantics against SQLite.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import {
  parseMetadataFilter,
  compileMetadataFilter,
  MetadataFilterError,
  METADATA_FILTER_LIMITS,
  type MetadataFilter,
} from "../src/metadata-filter.js";
import { initializeMetadataSchema, replaceDocumentMetadata } from "../src/metadata-store.js";
import { METADATA_EXTRACTION_VERSION, type DocumentMetadata } from "../src/metadata.js";

// =============================================================================
// Validation
// =============================================================================

describe("parseMetadataFilter", () => {
  test("accepts every condition operator shape", () => {
    const conditions: unknown[] = [
      { field: "status", operator: "eq", value: "published" },
      { field: "status", operator: "ne", value: "draft" },
      { field: "priority", operator: "gt", value: 3 },
      { field: "priority", operator: "gte", value: 3 },
      { field: "priority", operator: "lt", value: 10 },
      { field: "name", operator: "lte", value: "m" },
      { field: "topics", operator: "in", value: ["a", "b"] },
      { field: "topics", operator: "nin", value: [1, 2] },
      { field: "flags", operator: "all", value: [true, false] },
      { field: "status", operator: "exists", value: false },
    ];
    for (const condition of conditions) {
      expect(parseMetadataFilter(condition)).toEqual(condition);
    }
  });

  test("accepts nested groups and negation", () => {
    const filter = {
      operator: "and",
      operands: [
        { field: "topics", operator: "all", value: ["typescript", "programming"] },
        {
          operator: "or",
          operands: [
            { field: "status", operator: "eq", value: "published" },
            { operator: "not", operand: { field: "audience", operator: "eq", value: "internal" } },
          ],
        },
      ],
    };
    expect(parseMetadataFilter(filter)).toEqual(filter);
  });

  test("canonicalizes membership arrays by de-duplicating", () => {
    const parsed = parseMetadataFilter({ field: "topics", operator: "in", value: ["a", "b", "a"] });
    expect(parsed).toEqual({ field: "topics", operator: "in", value: ["a", "b"] });
  });

  test("rejects invalid node shapes with the failing JSON path", () => {
    const cases: [unknown, RegExp][] = [
      ["not-an-object", /at \$:.*must be an object/],
      [{ field: "a", value: 1 }, /at \$:.*missing 'operator'/],
      [{ operator: "equal", field: "a", value: 1 }, /unknown operator 'equal'/],
      [{ operator: "and", operands: [] }, /non-empty 'operands'/],
      [{ operator: "and", operands: "nope" }, /'operands' array/],
      [{ operator: "not", operands: [{ field: "a", operator: "eq", value: 1 }] }, /unknown property 'operands'/],
      [{ operator: "not" }, /exactly one 'operand'/],
      [{ operator: "and", operands: [{ operator: "eq" }] }, /at \$\.operands\[0\]/],
      [{ operator: "eq", value: 1 }, /non-empty string 'field'/],
      [{ operator: "eq", field: "a" }, /requires a 'value'/],
      [{ operator: "eq", field: "a", value: 1, extra: true }, /unknown property 'extra'/],
      [{ operator: "and", operands: [{ field: "a", operator: "eq", value: 1 }], field: "a" }, /unknown property 'field'/],
      [{ operator: "eq", key: "a", value: 1 }, /unknown property 'key'/],
      [{ operator: "gt", field: "a", value: true }, /string or number value/],
      [{ operator: "eq", field: "a", value: NaN }, /finite/],
      [{ operator: "eq", field: "a", value: { nested: 1 } }, /string, number, or boolean/],
      [{ operator: "in", field: "a", value: "x" }, /array value/],
      [{ operator: "in", field: "a", value: [] }, /non-empty array/],
      [{ operator: "in", field: "a", value: [1, "two"] }, /homogeneous array/],
      [{ operator: "exists", field: "a", value: "yes" }, /boolean value/],
    ];

    for (const [input, expected] of cases) {
      expect(() => parseMetadataFilter(input)).toThrow(expected);
      expect(() => parseMetadataFilter(input)).toThrow(MetadataFilterError);
    }
  });

  test("rejects excessive depth, node count, and operand count", () => {
    let deepFilter: unknown = { field: "a", operator: "eq", value: 1 };
    for (let i = 0; i <= METADATA_FILTER_LIMITS.maxDepth; i++) {
      deepFilter = { operator: "not", operand: deepFilter };
    }
    expect(() => parseMetadataFilter(deepFilter)).toThrow(/nesting depth/);

    const condition = { field: "a", operator: "eq", value: 1 };
    const wideGroup = {
      operator: "or",
      operands: Array.from({ length: METADATA_FILTER_LIMITS.maxGroupOperands + 1 }, () => condition),
    };
    expect(() => parseMetadataFilter(wideGroup)).toThrow(/operands/);

    const manyNodes = {
      operator: "and",
      operands: Array.from({ length: METADATA_FILTER_LIMITS.maxGroupOperands }, () => ({
        operator: "and",
        operands: Array.from({ length: METADATA_FILTER_LIMITS.maxGroupOperands }, () => condition),
      })),
    };
    expect(() => parseMetadataFilter(manyNodes)).toThrow(/nodes/);

    const manyValues = {
      field: "a",
      operator: "in",
      value: Array.from({ length: METADATA_FILTER_LIMITS.maxMembershipValues + 1 }, (_, i) => i),
    };
    expect(() => parseMetadataFilter(manyValues)).toThrow(/values/);
  });
});

// =============================================================================
// SQL compilation and semantics
// =============================================================================

describe("compileMetadataFilter semantics", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )
    `);
    initializeMetadataSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertDoc(path: string, metadata: DocumentMetadata): number {
    const result = db.prepare(`INSERT INTO documents (path) VALUES (?)`).run(path);
    const documentId = Number(result.lastInsertRowid);
    replaceDocumentMetadata(db, documentId, { metadata, extractionVersion: METADATA_EXTRACTION_VERSION });
    return documentId;
  }

  function matchPaths(filter: MetadataFilter): string[] {
    const compiled = compileMetadataFilter(parseMetadataFilter(filter), "d");
    const rows = db.prepare(`
      SELECT d.path FROM documents d
      JOIN document_metadata dm ON dm.document_id = d.id
        AND dm.extraction_version = ${METADATA_EXTRACTION_VERSION}
        AND dm.extraction_error IS NULL
      WHERE d.active = 1 AND ${compiled.sql}
      ORDER BY d.path
    `).all(...compiled.params) as { path: string }[];
    return rows.map(row => row.path);
  }

  test("eq matches each scalar type exactly, without coercion", () => {
    insertDoc("str.md", { status: "published" });
    insertDoc("num.md", { status: 1 });
    insertDoc("bool.md", { status: true });

    expect(matchPaths({ field: "status", operator: "eq", value: "published" })).toEqual(["str.md"]);
    expect(matchPaths({ field: "status", operator: "eq", value: 1 })).toEqual(["num.md"]);
    expect(matchPaths({ field: "status", operator: "eq", value: true })).toEqual(["bool.md"]);
    expect(matchPaths({ field: "status", operator: "eq", value: "1" })).toEqual([]);
  });

  test("ne requires key presence and matching type", () => {
    insertDoc("draft.md", { status: "draft" });
    insertDoc("published.md", { status: "published" });
    insertDoc("missing.md", { other: "x" });
    insertDoc("typed.md", { status: 1 });

    expect(matchPaths({ field: "status", operator: "ne", value: "draft" })).toEqual(["published.md"]);
  });

  test("ordered comparisons match numbers and binary-ordered strings", () => {
    insertDoc("low.md", { priority: 1 });
    insertDoc("mid.md", { priority: 3 });
    insertDoc("high.md", { priority: 7 });
    insertDoc("alpha.md", { name: "alpha" });
    insertDoc("zulu.md", { name: "zulu" });

    expect(matchPaths({ field: "priority", operator: "gte", value: 3 })).toEqual(["high.md", "mid.md"]);
    expect(matchPaths({ field: "priority", operator: "lt", value: 3 })).toEqual(["low.md"]);
    expect(matchPaths({ field: "name", operator: "gt", value: "alpha" })).toEqual(["zulu.md"]);
    // Type mismatch: no string 'priority' values exist.
    expect(matchPaths({ field: "priority", operator: "gte", value: "3" })).toEqual([]);
  });

  test("in, nin, and all evaluate membership over value sets", () => {
    insertDoc("ts.md", { topics: ["typescript", "programming"] });
    insertDoc("go.md", { topics: ["go"] });
    insertDoc("none.md", { other: "x" });

    expect(matchPaths({ field: "topics", operator: "in", value: ["typescript", "rust"] })).toEqual(["ts.md"]);
    expect(matchPaths({ field: "topics", operator: "nin", value: ["typescript", "rust"] })).toEqual(["go.md"]);
    expect(matchPaths({ field: "topics", operator: "all", value: ["typescript", "programming"] })).toEqual(["ts.md"]);
    expect(matchPaths({ field: "topics", operator: "all", value: ["typescript", "rust"] })).toEqual([]);
  });

  test("exists matches presence and absence", () => {
    insertDoc("has.md", { status: "ok" });
    insertDoc("hasnt.md", { other: "x" });

    expect(matchPaths({ field: "status", operator: "exists", value: true })).toEqual(["has.md"]);
    expect(matchPaths({ field: "status", operator: "exists", value: false })).toEqual(["hasnt.md"]);
  });

  test("and, or, and not compose recursively", () => {
    insertDoc("a.md", { status: "published", priority: 5 });
    insertDoc("b.md", { status: "published", priority: 1 });
    insertDoc("c.md", { status: "draft", priority: 9 });

    expect(matchPaths({
      operator: "and",
      operands: [
        { field: "status", operator: "eq", value: "published" },
        { field: "priority", operator: "gte", value: 3 },
      ],
    })).toEqual(["a.md"]);

    expect(matchPaths({
      operator: "or",
      operands: [
        { field: "priority", operator: "gte", value: 9 },
        { field: "priority", operator: "lte", value: 1 },
      ],
    })).toEqual(["b.md", "c.md"]);

    expect(matchPaths({
      operator: "not",
      operand: { field: "status", operator: "eq", value: "draft" },
    })).toEqual(["a.md", "b.md"]);
  });

  test("independent conditions on one array key match different elements", () => {
    insertDoc("wide.md", { priority: [1, 20] });
    insertDoc("narrow.md", { priority: [5] });

    const rangeFilter: MetadataFilter = {
      operator: "and",
      operands: [
        { field: "priority", operator: "gte", value: 3 },
        { field: "priority", operator: "lt", value: 10 },
      ],
    };
    // Document-level semantics: [1, 20] satisfies both conditions via
    // different elements — no implicit same-element fusion.
    expect(matchPaths(rangeFilter)).toEqual(["narrow.md", "wide.md"]);
  });

  test("boolean values round-trip through membership operators", () => {
    insertDoc("flagged.md", { reviewed: true });
    insertDoc("unflagged.md", { reviewed: false });

    expect(matchPaths({ field: "reviewed", operator: "in", value: [true] })).toEqual(["flagged.md"]);
    expect(matchPaths({ field: "reviewed", operator: "nin", value: [true] })).toEqual(["unflagged.md"]);
  });

  test("SQL injection payloads in keys and values stay data", () => {
    insertDoc("safe.md", { "key'; DROP TABLE documents; --": "v'; DROP TABLE documents; --" });

    expect(matchPaths({
      field: "key'; DROP TABLE documents; --",
      operator: "eq",
      value: "v'; DROP TABLE documents; --",
    })).toEqual(["safe.md"]);

    // Table survived.
    expect((db.prepare(`SELECT COUNT(*) as c FROM documents`).get() as { c: number }).c).toBe(1);
  });

  test("compiled SQL never interpolates user keys or values", () => {
    const filter = parseMetadataFilter({
      operator: "and",
      operands: [
        { field: "key'; --", operator: "eq", value: "value'; --" },
        { field: "topics", operator: "in", value: ["a'; --"] },
      ],
    });
    const compiled = compileMetadataFilter(filter, "d");
    expect(compiled.sql).not.toContain("'; --");
    expect(compiled.params).toContain("key'; --");
    expect(compiled.params).toContain("value'; --");
    expect(compiled.params).toContain("a'; --");
  });
});
