/**
 * QMD Metadata Store - Schema, persistence, and batch loading for document
 * metadata.
 *
 * Metadata attaches to document identity (`documents.id`), not content
 * identity: two paths can share one content hash while carrying different
 * metadata. SQLite stays a derived index — metadata is rebuilt from source
 * documents on `qmd update`, never mutated in place.
 *
 * `document_metadata` records extraction state per document (including
 * successful-but-empty extraction), so filtered search can distinguish
 * "extracted with no metadata" from "not yet extracted" and "extraction
 * failed". `document_metadata_values` holds one indexed row per scalar value
 * for filtering.
 */

import picomatch from "picomatch";

import type { Database, SQLiteValue } from "./db.js";
import {
  extractDocumentMetadata,
  METADATA_EXTRACTION_VERSION,
  type DocumentMetadata,
  type MetadataExtractionResult,
  type MetadataScalar,
} from "./metadata.js";
import { compileMetadataFilter, type MetadataFilter } from "./metadata-filter.js";

// =============================================================================
// Schema
// =============================================================================

export function initializeMetadataSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_metadata (
      document_id INTEGER PRIMARY KEY,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      extraction_version INTEGER NOT NULL,
      extraction_error TEXT,
      extracted_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_metadata_values (
      document_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      value_type TEXT NOT NULL,
      text_value TEXT,
      number_value REAL,
      boolean_value INTEGER,
      PRIMARY KEY (document_id, key, ordinal),
      FOREIGN KEY (document_id)
        REFERENCES document_metadata(document_id)
        ON DELETE CASCADE,
      CHECK (value_type IN ('string', 'number', 'boolean')),
      CHECK (
        (value_type = 'string' AND text_value IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'number' AND number_value IS NOT NULL AND text_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'boolean' AND boolean_value IN (0, 1) AND text_value IS NULL AND number_value IS NULL)
      )
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metadata_text_lookup
    ON document_metadata_values(key, text_value, document_id)
    WHERE value_type = 'string'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metadata_number_lookup
    ON document_metadata_values(key, number_value, document_id)
    WHERE value_type = 'number'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metadata_boolean_lookup
    ON document_metadata_values(key, boolean_value, document_id)
    WHERE value_type = 'boolean'
  `);
}

// =============================================================================
// Persistence
// =============================================================================

/**
 * Extract and persist metadata for one document, replacing any prior rows.
 *
 * With `onlyIfStale`, extraction is skipped when the document already has a
 * current-version extraction row — the cheap path for unchanged documents
 * during re-index. Returns the extraction result, or null when skipped.
 */
export function syncDocumentMetadata(
  db: Database,
  documentId: number,
  content: string,
  path: string,
  options?: { onlyIfStale?: boolean },
): MetadataExtractionResult | null {
  if (options?.onlyIfStale && isDocumentMetadataCurrent(db, documentId)) return null;

  const extraction = extractDocumentMetadata(content, path);
  replaceDocumentMetadata(db, documentId, extraction);
  return extraction;
}

/**
 * Replace a document's metadata rows atomically. A failed extraction persists
 * empty metadata plus the error, so stale metadata never survives a bad edit.
 */
export function replaceDocumentMetadata(db: Database, documentId: number, extraction: MetadataExtractionResult): void {
  const replace = db.transaction(() => {
    db.prepare(`
      INSERT INTO document_metadata (document_id, metadata_json, extraction_version, extraction_error, extracted_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        extraction_version = excluded.extraction_version,
        extraction_error = excluded.extraction_error,
        extracted_at = excluded.extracted_at
    `).run(
      documentId,
      JSON.stringify(extraction.metadata),
      extraction.extractionVersion,
      extraction.error ?? null,
      new Date().toISOString(),
    );

    db.prepare(`DELETE FROM document_metadata_values WHERE document_id = ?`).run(documentId);

    const insertValue = db.prepare(`
      INSERT INTO document_metadata_values (document_id, key, ordinal, value_type, text_value, number_value, boolean_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, value] of Object.entries(extraction.metadata)) {
      const scalars = Array.isArray(value) ? value : [value];
      scalars.forEach((scalar, ordinal) => {
        insertValue.run(
          documentId,
          key,
          ordinal,
          typeof scalar,
          typeof scalar === "string" ? scalar : null,
          typeof scalar === "number" ? scalar : null,
          typeof scalar === "boolean" ? (scalar ? 1 : 0) : null,
        );
      });
    }
  });

  replace();
}

function isDocumentMetadataCurrent(db: Database, documentId: number): boolean {
  const row = db.prepare(`SELECT extraction_version FROM document_metadata WHERE document_id = ?`)
    .get(documentId) as { extraction_version: number } | undefined;
  return row?.extraction_version === METADATA_EXTRACTION_VERSION;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Count active documents without a current, error-free metadata extraction.
 * These documents are excluded from filtered search until `qmd update` runs.
 */
export function countDocumentsPendingMetadata(db: Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM documents d
    WHERE d.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM document_metadata dm
        WHERE dm.document_id = d.id
          AND dm.extraction_version = ?
          AND dm.extraction_error IS NULL
      )
  `).get(METADATA_EXTRACTION_VERSION) as { c: number };
  return row.c;
}

/**
 * Batch-load canonical metadata for a set of result filepaths
 * (`qmd://collection/path`). One query — never per-result lookups.
 */
export function getMetadataByFilepath(db: Database, filepaths: readonly string[]): Map<string, DocumentMetadata> {
  const metadataByFilepath = new Map<string, DocumentMetadata>();
  if (filepaths.length === 0) return metadataByFilepath;

  const placeholders = filepaths.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT 'qmd://' || d.collection || '/' || d.path AS filepath, dm.metadata_json
    FROM documents d
    JOIN document_metadata dm ON dm.document_id = d.id
    WHERE d.active = 1
      AND 'qmd://' || d.collection || '/' || d.path IN (${placeholders})
  `).all(...filepaths) as { filepath: string; metadata_json: string }[];

  for (const row of rows) {
    metadataByFilepath.set(row.filepath, parseMetadataJson(row.metadata_json));
  }
  return metadataByFilepath;
}

/** Parse a stored `metadata_json` column value, tolerating absent rows. */
export function parseMetadataJson(metadataJson: string | null | undefined): DocumentMetadata {
  if (!metadataJson) return {};
  try {
    return JSON.parse(metadataJson) as DocumentMetadata;
  } catch {
    return {};
  }
}

// =============================================================================
// Discovery
// =============================================================================

export interface ListMetadataOptions {
  /** Restrict to these collections. Undefined means every collection in the index. */
  collection?: string | string[];
  /** picomatch pattern over key names. Undefined matches every key. */
  key?: string;
  /**
   * picomatch pattern over values in their text form (`String(number)`,
   * `"true"`/`"false"`). Undefined matches every value.
   */
  value?: string;
  /** Count only documents matching this filter. Same AST as search. */
  filter?: MetadataFilter;
  /** Per-key value window (default 10). `Infinity` removes the window. */
  limit?: number;
  /** Order of values within a key (default "count"). */
  sort?: "count" | "value";
  /** Drop values held by fewer documents than this (default 1). */
  minCount?: number;
}

export interface ListMetadataResult {
  /** Active documents in scope — the denominator for every coverage count. */
  documents: number;
  /** Documents in scope that pass `filter`. Present only when a filter was given. */
  filteredDocuments?: number;
  /** One entry per matching key, by documents descending then key ascending. */
  keys: MetadataKeySummary[];
}

export interface MetadataKeySummary {
  key: string;
  /** Distinct documents declaring the key with any type. */
  documents: number;
  /** One entry per value_type present. Length > 1 is a type conflict. */
  types: MetadataKeyTypeSummary[];
}

export interface MetadataKeyTypeSummary {
  type: MetadataValueType;
  /** True when any document holds this key as an array. */
  multiValued: boolean;
  /** Distinct documents holding a matching value of this type. */
  documents: number;
  /** Distinct matching values that meet `minCount`. */
  distinctValues: number;
  /** Windowed by `limit`, filtered by `value` and `minCount`, ordered by `sort`. */
  values: MetadataValueCount[];
  /** Distinct values not shown: `distinctValues - values.length`. */
  remaining: number;
  /** Numbers only. Computed over every matching value row, so array elements each count. */
  range?: { min: number; median: number; max: number };
  /** Collections contributing a matching value of this type, ascending. */
  collections: string[];
}

export interface MetadataValueCount {
  value: MetadataScalar;
  documents: number;
}

export type MetadataValueType = "string" | "number" | "boolean";

const DEFAULT_METADATA_VALUE_LIMIT = 10;

/** Same glob dialect as `multi-get`; `dot` because values are not file paths. */
const PATTERN_OPTIONS = { dot: true };

/**
 * The value rows discovery aggregates over. `withSql` defines the `eligible`
 * CTE (and `selected_values` when a value pattern is set); `fromSql` joins
 * `document_metadata_values mv` to them. Each query supplies its own SELECT
 * list, WHERE, and GROUP BY around these two parts.
 */
interface Region {
  withSql: string;
  withParams: SQLiteValue[];
  fromSql: string;
  fromParams: SQLiteValue[];
}

type SelectedValue = { key: string; type: MetadataValueType; value: string | number };

type ValueRow = {
  key: string;
  value_type: MetadataValueType;
  text_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
};

/**
 * Summarize metadata keys, types, and value counts for the documents in
 * scope. Discovery sees exactly what filtering sees: the same extraction gate,
 * active-document rule, and collection scope, so every value reported here is
 * a value an `eq` filter can match.
 *
 * `key` and `value` are picomatch patterns selecting a region of the key/value
 * space; `filter` selects which documents are counted. Counts are documents,
 * not values — a document with `topics: [a, b]` contributes one to each.
 */
export function listMetadata(db: Database, options: ListMetadataOptions = {}): ListMetadataResult {
  const collectionNames = options.collection === undefined ? undefined : [options.collection].flat();
  const eligible = buildEligibleCte(collectionNames, options.filter);

  const result: ListMetadataResult = { documents: countActiveDocuments(db, collectionNames), keys: [] };
  if (options.filter) result.filteredDocuments = countEligibleDocuments(db, eligible);

  const keyNames = options.key ? selectKeyNames(db, eligible, options.key) : undefined;
  if (keyNames?.length === 0) return result;

  const keyRegion = buildRegion(eligible, keyNames);
  const selectedValues = options.value ? selectValues(db, keyRegion, options.value) : undefined;
  if (selectedValues?.length === 0) return result;

  const region = selectedValues ? buildRegion(eligible, keyNames, selectedValues) : keyRegion;
  const medianByKey = new Map(queryNumberMedians(db, region).map(row => [row.key, row.median]));

  const typeSummaryByKeyType = new Map<string, MetadataKeyTypeSummary>();
  const typeSummariesByKey = new Map<string, MetadataKeyTypeSummary[]>();

  for (const row of queryTypeStats(db, region)) {
    const typeSummary: MetadataKeyTypeSummary = {
      type: row.value_type,
      multiValued: false,
      documents: row.documents,
      distinctValues: 0,
      values: [],
      remaining: 0,
      collections: [],
    };
    if (row.value_type === "number") {
      typeSummary.range = { min: row.min_value!, median: medianByKey.get(row.key)!, max: row.max_value! };
    }
    typeSummaryByKeyType.set(`${row.key}\0${row.value_type}`, typeSummary);

    const typeSummaries = typeSummariesByKey.get(row.key) ?? [];
    typeSummaries.push(typeSummary);
    typeSummariesByKey.set(row.key, typeSummaries);
  }

  for (const row of queryTypeArrayness(db, keyRegion)) {
    const typeSummary = typeSummaryByKeyType.get(`${row.key}\0${row.value_type}`);
    if (typeSummary) typeSummary.multiValued = row.multi_valued === 1;
  }

  for (const row of queryTypeCollections(db, region)) {
    typeSummaryByKeyType.get(`${row.key}\0${row.value_type}`)?.collections.push(row.collection);
  }

  const window: ValueWindow = {
    limit: options.limit ?? DEFAULT_METADATA_VALUE_LIMIT,
    minCount: options.minCount ?? 1,
    sort: options.sort ?? "count",
  };
  for (const row of queryValueCounts(db, region, window)) {
    const typeSummary = typeSummaryByKeyType.get(`${row.key}\0${row.value_type}`);
    if (!typeSummary) continue;
    typeSummary.distinctValues = row.distinct_values;
    typeSummary.values.push({ value: scalarOf(row), documents: row.documents });
  }

  for (const typeSummary of typeSummaryByKeyType.values()) {
    typeSummary.remaining = typeSummary.distinctValues - typeSummary.values.length;
  }

  // A document holds a key under exactly one type (arrays are homogeneous),
  // so per-type document counts partition the key's documents.
  for (const [key, typeSummaries] of typeSummariesByKey) {
    typeSummaries.sort((a, b) => b.documents - a.documents || a.type.localeCompare(b.type));
    result.keys.push({
      key,
      documents: typeSummaries.reduce((sum, typeSummary) => sum + typeSummary.documents, 0),
      types: typeSummaries,
    });
  }
  result.keys.sort((a, b) => b.documents - a.documents || a.key.localeCompare(b.key));

  return result;
}

/**
 * Documents that filtered search can see: active, with a current, error-free
 * extraction, in scope, and passing the filter. Lists bind as one JSON
 * parameter so the SQLite variable limit never applies.
 */
function buildEligibleCte(collectionNames: string[] | undefined, filter: MetadataFilter | undefined): Region {
  const withParams: SQLiteValue[] = [];
  let withSql = `
    WITH eligible AS (
      SELECT d.id AS document_id, d.collection
      FROM documents d
      JOIN document_metadata dm ON dm.document_id = d.id
      WHERE d.active = 1
        AND dm.extraction_version = ${METADATA_EXTRACTION_VERSION}
        AND dm.extraction_error IS NULL`;

  if (collectionNames) {
    withSql += `
        AND d.collection IN (SELECT value FROM json_each(?))`;
    withParams.push(JSON.stringify(collectionNames));
  }

  if (filter) {
    const compiledFilter = compileMetadataFilter(filter, "d");
    withSql += `
        AND ${compiledFilter.sql}`;
    withParams.push(...compiledFilter.params);
  }

  withSql += `
    )`;

  return { withSql, withParams, fromSql: "", fromParams: [] };
}

/**
 * Join eligible documents' values, narrowed to the selected keys and, when a
 * value pattern is set, to the values picomatch confirmed. The restrictions
 * live in the JOIN so queries can add their own WHERE.
 */
function buildRegion(eligible: Region, keyNames?: string[], selectedValues?: SelectedValue[]): Region {
  const region: Region = {
    withSql: eligible.withSql,
    withParams: [...eligible.withParams],
    fromSql: `
    FROM document_metadata_values mv
    JOIN eligible e ON e.document_id = mv.document_id`,
    fromParams: [],
  };

  if (keyNames) {
    region.fromSql += ` AND mv.key IN (SELECT value FROM json_each(?))`;
    region.fromParams.push(JSON.stringify(keyNames));
  }

  if (selectedValues) {
    region.withSql += `,
    selected_values AS MATERIALIZED (
      SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.type') AS value_type, json_extract(value, '$.value') AS scalar
      FROM json_each(?)
    )`;
    region.withParams.push(JSON.stringify(selectedValues));
    region.fromSql += `
    JOIN selected_values sv
      ON sv.key = mv.key AND sv.value_type = mv.value_type
      AND sv.scalar = COALESCE(mv.text_value, mv.number_value, mv.boolean_value)`;
  }

  return region;
}

function countActiveDocuments(db: Database, collectionNames: string[] | undefined): number {
  let sql = `SELECT COUNT(*) AS c FROM documents d WHERE d.active = 1`;
  const params: SQLiteValue[] = [];
  if (collectionNames) {
    sql += ` AND d.collection IN (SELECT value FROM json_each(?))`;
    params.push(JSON.stringify(collectionNames));
  }
  const row = db.prepare(sql).get(...params) as { c: number };
  return row.c;
}

function countEligibleDocuments(db: Database, eligible: Region): number {
  const row = db.prepare(`${eligible.withSql} SELECT COUNT(*) AS c FROM eligible`).get(...eligible.withParams) as { c: number };
  return row.c;
}

/** The distinct key set is small, so the pattern is matched in JS. */
function selectKeyNames(db: Database, eligible: Region, keyPattern: string): string[] {
  const isMatch = picomatch(keyPattern, PATTERN_OPTIONS);
  const rows = db.prepare(`
    ${eligible.withSql}
    SELECT DISTINCT mv.key
    FROM document_metadata_values mv
    JOIN eligible e ON e.document_id = mv.document_id
  `).all(...eligible.withParams) as { key: string }[];
  // Not `.filter(isMatch)`: picomatch reads a second argument as `returnObject`.
  return rows.map(row => row.key).filter(key => isMatch(key));
}

/**
 * Resolve a value pattern to the distinct (key, type, value) triples it
 * matches. Values can be high-cardinality, so string candidates are pruned in
 * SQL with a GLOB superset of the pattern before picomatch makes the final
 * call. Numbers and booleans skip the pruning: SQLite's text rendering of a
 * REAL does not agree with `String(number)`, so they are matched in JS only.
 */
function selectValues(db: Database, keyRegion: Region, valuePattern: string): SelectedValue[] {
  const isMatch = picomatch(valuePattern, PATTERN_OPTIONS);
  const globPrefilter = buildGlobPrefilter(valuePattern);
  const params = [...keyRegion.withParams, ...keyRegion.fromParams];
  let sql = `
    ${keyRegion.withSql}
    SELECT mv.key, mv.value_type, mv.text_value, mv.number_value, mv.boolean_value
    ${keyRegion.fromSql}`;

  if (globPrefilter !== null) {
    sql += `
    WHERE mv.value_type <> 'string' OR mv.text_value GLOB ?`;
    params.push(globPrefilter);
  }

  const rows = db.prepare(`${sql}
    GROUP BY mv.key, mv.value_type, mv.text_value, mv.number_value, mv.boolean_value
  `).all(...params) as ValueRow[];

  const selectedValues: SelectedValue[] = [];
  for (const row of rows) {
    const scalar = scalarOf(row);
    if (!isMatch(String(scalar))) continue;
    selectedValues.push({ key: row.key, type: row.value_type, value: bindScalar(scalar) });
  }
  return selectedValues;
}

/**
 * Translate a picomatch pattern to a SQLite GLOB pattern matching a superset
 * of what picomatch matches, or null when the pattern uses features (escapes,
 * groups, brackets, braces, extglobs, negation, globstars, `./` segments)
 * where the superset cannot be guaranteed. Only literals, `*`, and `?`
 * survive, and GLOB's wildcards match `/` where picomatch's do not — the
 * superset direction. A pattern without wildcards degenerates to equality.
 * Exported for the equivalence tests.
 */
export function buildGlobPrefilter(pattern: string): string | null {
  if (/[\\()[\]{}|!+@]/.test(pattern) || pattern.includes("**") || pattern.includes("./")) return null;
  return pattern;
}

type TypeStatsRow = { key: string; value_type: MetadataValueType; documents: number; min_value: number | null; max_value: number | null };

function queryTypeStats(db: Database, region: Region): TypeStatsRow[] {
  return db.prepare(`
    ${region.withSql}
    SELECT mv.key, mv.value_type,
      COUNT(DISTINCT mv.document_id) AS documents,
      MIN(mv.number_value) AS min_value,
      MAX(mv.number_value) AS max_value
    ${region.fromSql}
    GROUP BY mv.key, mv.value_type
  `).all(...region.withParams, ...region.fromParams) as TypeStatsRow[];
}

type TypeArraynessRow = { key: string; value_type: MetadataValueType; multi_valued: number };

/** Array-ness is a property of the key, so it is read before the value pattern narrows the rows. */
function queryTypeArrayness(db: Database, keyRegion: Region): TypeArraynessRow[] {
  return db.prepare(`
    ${keyRegion.withSql}
    SELECT mv.key, mv.value_type, MAX(mv.ordinal) > 0 AS multi_valued
    ${keyRegion.fromSql}
    GROUP BY mv.key, mv.value_type
  `).all(...keyRegion.withParams, ...keyRegion.fromParams) as TypeArraynessRow[];
}

type NumberMedianRow = { key: string; median: number };

/** Median over value rows: the middle row for odd counts, the mean of the two middle rows for even. */
function queryNumberMedians(db: Database, region: Region): NumberMedianRow[] {
  return db.prepare(`
    ${region.withSql}
    SELECT key, AVG(number_value) AS median
    FROM (
      SELECT mv.key, mv.number_value,
        ROW_NUMBER() OVER (PARTITION BY mv.key ORDER BY mv.number_value) AS position,
        COUNT(*) OVER (PARTITION BY mv.key) AS total
      ${region.fromSql}
      WHERE mv.value_type = 'number'
    )
    WHERE position IN ((total + 1) / 2, (total + 2) / 2)
    GROUP BY key
  `).all(...region.withParams, ...region.fromParams) as NumberMedianRow[];
}

type TypeCollectionRow = { key: string; value_type: MetadataValueType; collection: string };

function queryTypeCollections(db: Database, region: Region): TypeCollectionRow[] {
  return db.prepare(`
    ${region.withSql}
    SELECT mv.key, mv.value_type, e.collection
    ${region.fromSql}
    GROUP BY mv.key, mv.value_type, e.collection
    ORDER BY e.collection
  `).all(...region.withParams, ...region.fromParams) as TypeCollectionRow[];
}

type ValueCountRow = ValueRow & { documents: number; distinct_values: number };

interface ValueWindow {
  limit: number;
  minCount: number;
  sort: "count" | "value";
}

/**
 * Distinct values per key and type, ranked within each partition. Only one
 * typed column is non-null per partition, so ordering by all three is stable.
 * `distinct_values` counts the partition after `minCount`, so the caller's
 * remainder is exact.
 */
function queryValueCounts(db: Database, region: Region, window: ValueWindow): ValueCountRow[] {
  const valueOrder = "mv.text_value, mv.number_value, mv.boolean_value";
  const rankOrder = window.sort === "count" ? `COUNT(DISTINCT mv.document_id) DESC, ${valueOrder}` : valueOrder;
  const params = [...region.withParams, ...region.fromParams, window.minCount];
  let sql = `
    ${region.withSql}
    SELECT key, value_type, text_value, number_value, boolean_value, documents, distinct_values
    FROM (
      SELECT mv.key, mv.value_type, mv.text_value, mv.number_value, mv.boolean_value,
        COUNT(DISTINCT mv.document_id) AS documents,
        ROW_NUMBER() OVER (PARTITION BY mv.key, mv.value_type ORDER BY ${rankOrder}) AS rank,
        COUNT(*) OVER (PARTITION BY mv.key, mv.value_type) AS distinct_values
      ${region.fromSql}
      GROUP BY mv.key, mv.value_type, mv.text_value, mv.number_value, mv.boolean_value
      HAVING COUNT(DISTINCT mv.document_id) >= ?
    )`;

  if (Number.isFinite(window.limit)) {
    sql += `
    WHERE rank <= ?`;
    params.push(Math.max(1, Math.floor(window.limit)));
  }

  return db.prepare(`${sql}
    ORDER BY key, value_type, rank
  `).all(...params) as ValueCountRow[];
}

function scalarOf(row: ValueRow): MetadataScalar {
  if (row.value_type === "string") return row.text_value!;
  if (row.value_type === "number") return row.number_value!;
  return row.boolean_value === 1;
}

/** Booleans are stored as 0/1, and JSON round-trips them the same way. */
function bindScalar(scalar: MetadataScalar): string | number {
  if (typeof scalar === "boolean") return scalar ? 1 : 0;
  return scalar;
}
