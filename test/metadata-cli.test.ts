/**
 * metadata-cli.test.ts - CLI --filter integration: parsing, propagation,
 * JSON output metadata, and error behavior. Spawns real qmd processes.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

let testDir: string;
let fixturesDir: string;
let dbPath: string;
let configDir: string;

async function runQmd(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(qmdCommand.command, [...qmdCommand.args, ...args], {
    cwd: fixturesDir,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      QMD_CONFIG_DIR: configDir,
      PWD: fixturesDir,
    },
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", chunk => { stdout += chunk; });
  proc.stderr.on("data", chunk => { stderr += chunk; });

  const exitCode = await new Promise<number>(resolve => {
    proc.on("close", code => resolve(code ?? -1));
  });
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-metadata-cli-"));
  fixturesDir = join(testDir, "fixtures");
  configDir = join(testDir, "config");
  dbPath = join(testDir, "index.sqlite");
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(configDir, { recursive: true });

  await writeFile(join(fixturesDir, "published.md"), [
    "---",
    "qmd:",
    "  metadata:",
    "    status: published",
    "    topics: [typescript, programming]",
    "---",
    "",
    "# Published doc",
    "",
    "cli filter keyword body",
    "",
  ].join("\n"));
  await writeFile(join(fixturesDir, "draft.md"), [
    "---",
    "qmd:",
    "  metadata:",
    "    status: draft",
    "---",
    "",
    "# Draft doc",
    "",
    "cli filter keyword body",
    "",
  ].join("\n"));

  const addResult = await runQmd(["collection", "add", ".", "--name", "notes"]);
  expect(addResult.exitCode).toBe(0);
}, 60000);

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("qmd search --filter", () => {
  test("returns only matching documents and includes metadata in JSON output", async () => {
    const { stdout, exitCode } = await runQmd([
      "search", "cli filter keyword",
      "--format", "json",
      "--filter", '{"key":"status","operator":"eq","value":"published"}',
    ]);
    expect(exitCode).toBe(0);

    const results = JSON.parse(stdout);
    expect(results.length).toBe(1);
    expect(results[0].file).toBe("qmd://notes/published.md");
    expect(results[0].metadata).toEqual({ status: "published", topics: ["typescript", "programming"] });
  }, 30000);

  test("supports nested filters", async () => {
    const filter = JSON.stringify({
      operator: "and",
      operands: [
        { key: "topics", operator: "all", value: ["typescript", "programming"] },
        { operator: "not", operand: { key: "status", operator: "eq", value: "draft" } },
      ],
    });
    const { stdout, exitCode } = await runQmd([
      "search", "cli filter keyword", "--format", "json", "--filter", filter,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).map((r: { file: string }) => r.file)).toEqual(["qmd://notes/published.md"]);
  }, 30000);

  test("returns format-safe empty output when nothing matches", async () => {
    const { stdout, exitCode } = await runQmd([
      "search", "cli filter keyword",
      "--format", "json",
      "--filter", '{"key":"status","operator":"eq","value":"missing"}',
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  }, 30000);

  test("omits metadata from JSON output when a document has none", async () => {
    await writeFile(join(fixturesDir, "plain.md"), "# Plain doc\n\ncli filter keyword body\n");
    const updateResult = await runQmd(["update"]);
    expect(updateResult.exitCode).toBe(0);

    const { stdout, exitCode } = await runQmd(["search", "cli filter keyword", "--format", "json"]);
    expect(exitCode).toBe(0);

    const results = JSON.parse(stdout);
    const plainResult = results.find((r: { file: string }) => r.file === "qmd://notes/plain.md");
    expect(plainResult).toBeDefined();
    expect(plainResult.metadata).toBeUndefined();
  }, 60000);

  test("rejects malformed --filter JSON with a non-zero exit", async () => {
    const { stderr, exitCode } = await runQmd([
      "search", "cli filter keyword", "--filter", "{not json",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Invalid --filter JSON/);
  }, 30000);

  test("rejects valid JSON with an invalid filter AST", async () => {
    const { stderr, exitCode } = await runQmd([
      "search", "cli filter keyword", "--filter", '{"key":"status","operator":"equal","value":"x"}',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Invalid metadata filter at \$/);
    expect(stderr).toMatch(/unknown operator 'equal'/);
  }, 30000);
});

describe("qmd collection metadata", () => {
  beforeAll(async () => {
    await writeFile(join(fixturesDir, "discovery.md"), [
      "---",
      "qmd:",
      "  metadata:",
      "    status: published",
      "    topics: [typescript, sqlite, search, architecture, embeddings, mcp, cli, testing, agents, indexing, chunking, reranking]",
      "    priority: 5",
      "    owner: docs-team",
      "---",
      "",
      "# Discovery doc",
      "",
      "cli filter keyword body",
      "",
    ].join("\n"));
    await writeFile(join(fixturesDir, "priority.md"), [
      "---",
      "qmd:",
      "  metadata:",
      "    status: draft",
      "    priority: 1",
      "    reviewed: false",
      "    reviewers: [docs-team, security-team]",
      "---",
      "",
      "# Priority doc",
      "",
      "cli filter keyword body",
      "",
    ].join("\n"));
    // Nothing enforces a type across documents, so one file in the same
    // collection may spell priority as a label where the others use numbers.
    await writeFile(join(fixturesDir, "conflict.md"), [
      "---",
      "qmd:",
      "  metadata:",
      "    status: archived",
      "    priority: high",
      "---",
      "",
      "# Conflict doc",
      "",
      "cli filter keyword body",
      "",
    ].join("\n"));
    const updateResult = await runQmd(["update"]);
    expect(updateResult.exitCode).toBe(0);
  }, 60000);

  test("lists every key with coverage, type, and a value window", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "metadata", "notes"]);
    expect(exitCode).toBe(0);

    // Keys arrive in coverage order; the denominator is every active document.
    expect(stdout).toMatch(/^status {2}string {2}5 of 6 documents {2}3 distinct\n {2}draft {6}2\n {2}published {2}2\n {2}archived {3}1\n/);
    expect(stdout).toContain("topics  string[]  2 of 6 documents  13 distinct");
    expect(stdout).toContain("reviewed  boolean  1 of 6 documents\n  false 1");
    expect(stdout).toContain("reviewers  string[]  1 of 6 documents  2 distinct\n  docs-team      1\n  security-team  1");
  }, 30000);

  test("splits a key whose documents disagree on type, even within one collection", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "metadata", "notes", "--key", "priority"]);
    expect(exitCode).toBe(0);

    // One row per type with its own document count. The collection column
    // is omitted since the view covers a single collection.
    expect(stdout).toBe([
      "priority  number | string  3 of 6 documents",
      "  number  2 docs  min 1  median 3  max 5",
      "  string  1 doc   high (1)",
      "",
    ].join("\n"));
  }, 30000);

  test("truncates value lists with an explicit remainder and escape hatch", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "metadata", "notes", "--key", "topics"]);
    expect(exitCode).toBe(0);

    const valueLines = stdout.split("\n").filter(line => /^ {2}\S/.test(line));
    expect(valueLines).toHaveLength(10);
    expect(valueLines[0]).toBe("  typescript    2");
    expect(stdout).toContain("3 more values, use -n <num> or --all");
    expect(stdout).not.toContain("status");
  }, 30000);

  test("-n and --all raise or remove the window", async () => {
    const limited = await runQmd(["collection", "metadata", "notes", "--key", "topics", "-n", "2"]);
    expect(limited.stdout).toContain("11 more values, use -n <num> or --all");

    const all = await runQmd(["collection", "metadata", "notes", "--key", "topics", "--all"]);
    expect(all.stdout).not.toContain("more values");
    expect(all.stdout.split("\n").filter(line => /^ {2}\S/.test(line))).toHaveLength(13);
  }, 30000);

  test("--value is a reverse lookup across keys", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "metadata", "notes", "--value", "docs-team"]);
    expect(exitCode).toBe(0);

    expect(stdout).toBe([
      "owner  string  1 of 6 documents  1 distinct",
      "  docs-team  1",
      "",
      "reviewers  string[]  1 of 6 documents  1 distinct",
      "  docs-team  1",
      "",
    ].join("\n"));
  }, 30000);

  test("--filter counts only matching documents and says so in the header", async () => {
    const { stdout, exitCode } = await runQmd([
      "collection", "metadata", "notes", "--key", "priority",
      "--filter", '{"key":"status","operator":"eq","value":"published"}',
    ]);
    expect(exitCode).toBe(0);
    // Only the published document remains, so the type split above
    // collapses to a flat number view.
    expect(stdout).toContain("priority  number  1 of 6 documents match filter  1 distinct\n  min 5  median 5  max 5\n  5 (1)");
  }, 30000);

  test("--sort value and --min-count reshape the window", async () => {
    const sorted = await runQmd(["collection", "metadata", "notes", "--key", "topics", "--sort", "value", "-n", "2"]);
    expect(sorted.stdout).toContain("  agents        1\n  architecture  1\n");

    const common = await runQmd(["collection", "metadata", "notes", "--key", "topics", "--min-count", "2"]);
    expect(common.stdout).toContain("topics  string[]  2 of 6 documents  1 distinct\n  typescript  2\n");
    expect(common.stdout).not.toContain("more values");
  }, 30000);

  test("omitting the collection covers the default collections", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "metadata"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("status  string  5 of 6 documents  3 distinct");
  }, 30000);

  test("reports when nothing matches the patterns", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "metadata", "notes", "--key", "missing-*"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No metadata matches");
  }, 30000);

  test("exits on an unknown collection", async () => {
    const { stderr, exitCode } = await runQmd(["collection", "metadata", "missing"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found: missing");
  }, 30000);

  test("exits on an invalid filter", async () => {
    const { stderr, exitCode } = await runQmd([
      "collection", "metadata", "notes", "--filter", '{"key":"status","operator":"equal","value":"x"}',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Invalid metadata filter at \$/);
  }, 30000);

  test("exits on invalid -n, --min-count, and --sort values", async () => {
    const badLimit = await runQmd(["collection", "metadata", "notes", "-n", "0"]);
    expect(badLimit.exitCode).toBe(1);
    expect(badLimit.stderr).toContain("Invalid -n value: 0");

    const badMinCount = await runQmd(["collection", "metadata", "notes", "--min-count", "x"]);
    expect(badMinCount.exitCode).toBe(1);
    expect(badMinCount.stderr).toContain("Invalid --min-count value: x");

    const badSort = await runQmd(["collection", "metadata", "notes", "--sort", "size"]);
    expect(badSort.exitCode).toBe(1);
    expect(badSort.stderr).toContain("Invalid --sort value: size");
  }, 30000);
});

describe("metadata in collection list, show, and status", () => {
  test("collection list names the top keys and counts the rest", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "list"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("  Metadata: status, priority, topics, owner, reviewed, +1 more\n");
  }, 30000);

  test("collection show details the top keys and points at the drill-down", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "show", "notes"]);
    expect(exitCode).toBe(0);

    const metadataSection = stdout.slice(stdout.indexOf("  Metadata:"));
    expect(metadataSection).toBe([
      "  Metadata: 6 keys, 5 of 6 documents",
      "    status    string           5 docs   3 distinct  draft (2), published (2), archived (1)",
      "    priority  number | string  3 docs   3 distinct  types disagree, see 'qmd collection metadata notes --key priority'",
      "    topics    string[]         2 docs  13 distinct  typescript (2), agents (1), architecture (1), ...",
      "    owner     string           1 doc    1 distinct",
      "    reviewed  boolean          1 doc    1 distinct  false 1",
      "    1 more key, see 'qmd collection metadata notes'",
      "",
    ].join("\n"));
  }, 30000);

  test("status summarizes metadata and points at the drill-down", async () => {
    const { stdout, exitCode } = await runQmd(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("  Metadata: 6 keys across 5 files (explore with 'qmd collection metadata')\n");
  }, 30000);
});
