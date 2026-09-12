/**
 * metadata-surfaces.test.ts - Metadata filter support across the public
 * surfaces: SDK, MCP tool, and HTTP REST endpoints. Uses lex-only searches
 * with reranking disabled so no models are needed.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createStore, type QMDStore } from "../src/index.js";
import {
  createStore as createInternalStore,
  insertContent,
  insertDocument,
  hashContent,
  syncConfigToDb,
  _resetProductionModeForTesting,
} from "../src/store.js";
import { replaceDocumentMetadata } from "../src/metadata-store.js";
import { METADATA_EXTRACTION_VERSION, type DocumentMetadata } from "../src/metadata.js";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
import type { CollectionConfig } from "../src/collections.js";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-metadata-surfaces-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function buildDoc(status: string, body: string): string {
  return `---\nqmd:\n  metadata:\n    status: ${status}\n    topics: [typescript]\n---\n\n${body}`;
}

// =============================================================================
// SDK
// =============================================================================

describe("SDK metadata filter", () => {
  let store: QMDStore;
  let collectionDir: string;

  beforeAll(async () => {
    collectionDir = join(testDir, "sdk-collection");
    await mkdir(collectionDir, { recursive: true });
    await writeFile(join(collectionDir, "published.md"), buildDoc("published", "# Pub\n\nsdk keyword body"));
    await writeFile(join(collectionDir, "draft.md"), buildDoc("draft", "# Draft\n\nsdk keyword body"));

    store = await createStore({
      dbPath: join(testDir, "sdk.sqlite"),
      config: { collections: { docs: { path: collectionDir, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
  });

  test("searchLex applies the filter and returns metadata", async () => {
    const unfiltered = await store.searchLex("sdk keyword");
    expect(unfiltered.length).toBe(2);

    const filtered = await store.searchLex("sdk keyword", {
      filter: { key: "status", operator: "eq", value: "published" },
    });
    expect(filtered.map(r => r.displayPath)).toEqual(["docs/published.md"]);
    expect(filtered[0]!.metadata).toEqual({ status: "published", topics: ["typescript"] });
  });

  test("search with pre-expanded queries applies the filter", async () => {
    const results = await store.search({
      queries: [{ type: "lex", query: "sdk keyword" }],
      filter: { key: "status", operator: "ne", value: "draft" },
      rerank: false,
    });
    expect(results.map(r => r.displayPath)).toEqual(["docs/published.md"]);
    expect(results[0]!.metadata).toEqual({ status: "published", topics: ["typescript"] });
  });

  test("getStatus exposes the pending metadata count", async () => {
    const status = await store.getStatus();
    expect(status.pendingMetadata).toBe(0);
  });

  test("validates filters at the SDK runtime boundary", async () => {
    await expect(store.searchLex("sdk keyword", {
      filter: { operator: "and", operands: [] },
    })).rejects.toThrow(/non-empty 'operands'/);
  });

  test("listMetadata summarizes keys, types, and value counts", async () => {
    const result = await store.listMetadata();
    expect(result.documents).toBe(2);
    expect(result.filteredDocuments).toBeUndefined();
    expect(result.keys.map(summary => summary.key)).toEqual(["status", "topics"]);

    const topics = result.keys[1]!.types[0]!;
    expect(topics).toMatchObject({ type: "string", documents: 2, distinctValues: 1, remaining: 0, collections: ["docs"] });
    expect(topics.values).toEqual([{ value: "typescript", documents: 2 }]);
  });

  test("listMetadata scopes, narrows by filter, and matches patterns", async () => {
    const filtered = await store.listMetadata({
      collection: "docs",
      key: "status",
      filter: { key: "status", operator: "eq", value: "published" },
    });
    expect(filtered.filteredDocuments).toBe(1);
    expect(filtered.keys[0]!.types[0]!.values).toEqual([{ value: "published", documents: 1 }]);

    const reverse = await store.listMetadata({ value: "dra*" });
    expect(reverse.keys.map(summary => summary.key)).toEqual(["status"]);

    const scoped = await store.listMetadata({ collection: "missing" });
    expect(scoped).toEqual({ documents: 0, keys: [] });
  });

  test("listMetadata validates filters at the SDK runtime boundary", async () => {
    // Plain-JS callers bypass the declarations, so the SDK must reject a bad AST at runtime.
    const untrustedOptions: import("../src/index.js").ListMetadataOptions = JSON.parse('{"filter":{"key":"status","operator":"equal","value":"x"}}');
    await expect(store.listMetadata(untrustedOptions)).rejects.toThrow(/unknown operator 'equal'/);
  });

  test("getStatus lists metadata keys per collection", async () => {
    const status = await store.getStatus();
    expect(status.collections[0]!.metadataKeys).toEqual([
      { key: "status", documents: 2, types: ["string"] },
      { key: "topics", documents: 2, types: ["string"] },
    ]);
  });
});

// =============================================================================
// MCP tool + HTTP REST
// =============================================================================

describe("MCP and HTTP metadata filter", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let dbPath: string;
  let configDir: string;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;

  async function seedDoc(db: import("../src/db.js").Database, path: string, body: string, metadata: DocumentMetadata): Promise<void> {
    const now = new Date().toISOString();
    const hash = await hashContent(body);
    insertContent(db, hash, body, now);
    const documentId = insertDocument(db, "docs", path, path, hash, now, now);
    replaceDocumentMetadata(db, documentId, { metadata, extractionVersion: METADATA_EXTRACTION_VERSION });
  }

  beforeAll(async () => {
    dbPath = join(testDir, `mcp-${Date.now()}.sqlite`);
    const internal = createInternalStore(dbPath);
    await seedDoc(internal.db, "published.md", "# Pub\n\nhttp keyword body", { status: "published" });
    await seedDoc(internal.db, "draft.md", "# Draft\n\nhttp keyword body", { status: "draft" });
    await seedDoc(internal.db, "tagged.md", "# Tagged\n\nhttp keyword body", { status: "archived", topics: ["sqlite", "search"], priority: 3 });

    const testConfig: CollectionConfig = {
      collections: { docs: { path: "/test/docs", pattern: "**/*.md" } },
    };
    syncConfigToDb(internal.db, testConfig);
    internal.close();

    configDir = await mkdtemp(join(tmpdir(), "qmd-metadata-surfaces-config-"));
    await writeFile(join(configDir, "index.yml"), YAML.stringify(testConfig));

    process.env.INDEX_PATH = dbPath;
    process.env.QMD_CONFIG_DIR = configDir;
    handle = await startMcpHttpServer(0, { quiet: true, dbPath });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.stop();
    _resetProductionModeForTesting();
    if (origIndexPath !== undefined) process.env.INDEX_PATH = origIndexPath;
    else delete process.env.INDEX_PATH;
    if (origConfigDir !== undefined) process.env.QMD_CONFIG_DIR = origConfigDir;
    else delete process.env.QMD_CONFIG_DIR;
    try { unlinkSync(dbPath); } catch {}
    await rm(configDir, { recursive: true, force: true });
  });

  type HttpRequestBody = Record<string, unknown>;

  async function postJson(path: string, body: HttpRequestBody): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function callQueryTool(args: Record<string, unknown>): Promise<{ status: number; json: any }> {
    return callTool("query", args);
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "metadata-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    return { status: res.status, json: await res.json() };
  }

  test("POST /query applies the filter and includes metadata", async () => {
    const { status, json } = await postJson("/query", {
      searches: [{ type: "lex", query: "http keyword" }],
      filter: { key: "status", operator: "eq", value: "published" },
      rerank: false,
    });
    expect(status).toBe(200);
    expect(json.results.length).toBe(1);
    expect(json.results[0].file).toBe("qmd://docs/published.md");
    expect(json.results[0].metadata).toEqual({ status: "published" });
  });

  test("POST /search alias accepts the same filter", async () => {
    const { status, json } = await postJson("/search", {
      searches: [{ type: "lex", query: "http keyword" }],
      filter: { key: "status", operator: "eq", value: "draft" },
      rerank: false,
    });
    expect(status).toBe(200);
    expect(json.results.length).toBe(1);
    expect(json.results[0].file).toBe("qmd://docs/draft.md");
  });

  test("POST /query rejects non-object and invalid filters with 400", async () => {
    const stringFilter = await postJson("/query", {
      searches: [{ type: "lex", query: "http keyword" }],
      filter: "status = published",
    });
    expect(stringFilter.status).toBe(400);
    expect(stringFilter.json.error).toMatch(/must be an object/);

    const invalidAst = await postJson("/query", {
      searches: [{ type: "lex", query: "http keyword" }],
      filter: { key: "status", operator: "equal", value: "published" },
    });
    expect(invalidAst.status).toBe(400);
    expect(invalidAst.json.error).toMatch(/unknown operator 'equal'/);
  });

  test("MCP query tool applies a nested filter and includes metadata", async () => {
    const { status, json } = await callQueryTool({
      searches: [{ type: "lex", query: "http keyword" }],
      filter: {
        operator: "and",
        operands: [
          { key: "status", operator: "eq", value: "published" },
          { operator: "not", operand: { key: "status", operator: "eq", value: "draft" } },
        ],
      },
      rerank: false,
    });
    expect(status).toBe(200);
    expect(json.result.isError).toBeFalsy();
    const items = json.result.structuredContent.results;
    expect(items.length).toBe(1);
    expect(items[0].file).toBe("docs/published.md");
    expect(items[0].metadata).toEqual({ status: "published" });
  });

  test("MCP query tool rejects invalid filters", async () => {
    const { status, json } = await callQueryTool({
      searches: [{ type: "lex", query: "http keyword" }],
      filter: { operator: "and", operands: [] },
      rerank: false,
    });
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/non-empty 'operands'/);
  });

  test("MCP metadata tool returns key summaries as structured content and CLI-shaped text", async () => {
    const { status, json } = await callTool("metadata", { key: "status" });
    expect(status).toBe(200);
    expect(json.result.isError).toBeFalsy();

    const result = json.result.structuredContent;
    expect(result.documents).toBe(3);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].types[0]).toMatchObject({ type: "string", documents: 3, distinctValues: 3, remaining: 0 });
    expect(result.keys[0].types[0].values).toEqual([
      { value: "archived", documents: 1 },
      { value: "draft", documents: 1 },
      { value: "published", documents: 1 },
    ]);
    expect(json.result.content[0].text).toBe("status  string  3 of 3 documents  3 distinct\n  archived   1\n  draft      1\n  published  1");
  });

  test("MCP metadata tool narrows by filter, windows values, and reports the remainder", async () => {
    const { json } = await callTool("metadata", {
      key: "topics",
      limit: 1,
      filter: { key: "status", operator: "eq", value: "archived" },
    });
    const result = json.result.structuredContent;
    expect(result.filteredDocuments).toBe(1);
    const topics = result.keys[0].types[0];
    expect(topics.multiValued).toBe(true);
    expect(topics.values).toHaveLength(1);
    expect(topics.remaining).toBe(1);
    expect(json.result.content[0].text).toContain("1 more values, use a higher 'limit'");
  });

  test("MCP metadata tool rejects invalid filters", async () => {
    const { json } = await callTool("metadata", { filter: { key: "status", operator: "equal", value: "x" } });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/unknown operator 'equal'/);
  });

  test("MCP status tool lists metadata keys per collection", async () => {
    const { json } = await callTool("status", {});
    expect(json.result.isError).toBeFalsy();
    expect(json.result.structuredContent.collections[0].metadataKeys).toEqual([
      { key: "status", documents: 3, types: ["string"] },
      { key: "priority", documents: 1, types: ["number"] },
      { key: "topics", documents: 1, types: ["string"] },
    ]);
    expect(json.result.content[0].text).toContain("metadata keys: status (string), priority (number), topics (string)");
    expect(json.result.content[0].text).toContain("call the 'metadata' tool");
  });

  test("POST /metadata returns the same result as the tool", async () => {
    const { status, json } = await postJson("/metadata", { key: "priority" });
    expect(status).toBe(200);
    expect(json.documents).toBe(3);
    expect(json.keys[0].types[0]).toMatchObject({ type: "number", range: { min: 3, median: 3, max: 3 } });

    const reverse = await postJson("/metadata", { value: "search", limit: 5 });
    expect(reverse.json.keys.map((summary: { key: string }) => summary.key)).toEqual(["topics"]);
  });

  test("POST /metadata rejects invalid bodies, filters, and sort with 400", async () => {
    const stringFilter = await postJson("/metadata", { filter: "status = published" });
    expect(stringFilter.status).toBe(400);
    expect(stringFilter.json.error).toMatch(/must be an object/);

    const invalidAst = await postJson("/metadata", { filter: { key: "status", operator: "equal", value: "x" } });
    expect(invalidAst.status).toBe(400);
    expect(invalidAst.json.error).toMatch(/unknown operator 'equal'/);

    const badSort = await postJson("/metadata", { sort: "size" });
    expect(badSort.status).toBe(400);
    expect(badSort.json.error).toMatch(/sort/);

    const arrayBody = await fetch(`${baseUrl}/metadata`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" });
    expect(arrayBody.status).toBe(400);
  });
});
