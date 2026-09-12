/**
 * Metadata discovery rendering: the plain-text shape the CLI and the MCP
 * `metadata` tool share, exercised directly where the CLI fixture cannot
 * reach (string identity, control characters, empty states under a filter).
 */

import { describe, test, expect } from "vitest";
import { formatMetadataKeySummaries, type FormatMetadataOptions } from "../src/metadata-format.js";
import type { ListMetadataResult, MetadataKeyTypeSummary, MetadataScalar } from "../src/metadata-store.js";

const OPTIONS: FormatMetadataOptions = {
  valueWindowHint: "--value-limit <n>",
  keyWindowHint: "--key-limit <n>",
  keyOffset: 0,
  keyOffsetLabel: "--key-offset",
  emptyMessage: "No metadata matches.",
};

function stringResult(values: string[]): ListMetadataResult {
  const typeSummary: MetadataKeyTypeSummary = {
    type: "string",
    multiValued: false,
    documents: values.length,
    distinctValues: values.length,
    values: values.map(value => ({ value, documents: 1 })),
    remainingValues: 0,
    collections: ["notes"],
  };
  return { documents: values.length, totalKeys: 1, keys: [{ key: "label", documents: values.length, types: [typeSummary] }], remainingKeys: 0 };
}

/** The printed value column of each row: everything before the two-space gap and the count. */
function printedValues(output: string): string[] {
  return output.split("\n").slice(1).filter(line => line !== "").map(line => line.slice(2).replace(/ {2,}\d+$/, ""));
}

describe("formatMetadataKeySummaries values", () => {
  test("prints a plain string bare", () => {
    expect(printedValues(formatMetadataKeySummaries(stringResult(["published", "docs team", "v1.2-rc", "é"]), OPTIONS)))
      .toEqual(["published", "docs team", "v1.2-rc", "é"]);
  });

  test("quotes every string whose bare form could be read as another value or as layout", () => {
    const ambiguous = ["", '""', " padded", "padded ", "two  spaces", "tab\tin", "line\nbreak", "42", "-1.5", "true", "null", "[1]", "back\\slash"];

    const printed = printedValues(formatMetadataKeySummaries(stringResult(ambiguous), OPTIONS));

    expect(printed.every(value => value.startsWith('"') && value.endsWith('"'))).toBe(true);
    expect(printed.map(value => JSON.parse(value) as MetadataScalar)).toEqual(ambiguous);
  });

  test("escapes every control character, including the ones JSON.stringify leaves literal", () => {
    const controls = ["bell\u0007", "del\u007f", "csi\u009b", "line\u2028sep", "para\u2029sep", "nul\u0000"];

    const output = formatMetadataKeySummaries(stringResult(controls), OPTIONS);

    expect(output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(printedValues(output).map(value => JSON.parse(value) as MetadataScalar)).toEqual(controls);
  });

  test("prints numbers and booleans bare", () => {
    const typeSummary: MetadataKeyTypeSummary = {
      type: "number", multiValued: false, documents: 2, distinctValues: 2,
      values: [{ value: 1.5, documents: 1 }, { value: -2, documents: 1 }],
      remainingValues: 0, range: { min: -2, median: -0.25, max: 1.5 }, collections: ["notes"],
    };
    const result: ListMetadataResult = { documents: 2, totalKeys: 1, keys: [{ key: "n", documents: 2, types: [typeSummary] }], remainingKeys: 0 };

    expect(formatMetadataKeySummaries(result, OPTIONS)).toBe("n  number  2 of 2 documents  2 distinct\n  min -2  median -0.25  max 1.5\n  -2 (1)  1.5 (1)");
  });
});

describe("formatMetadataKeySummaries empty states", () => {
  test("keeps the filter line when no entry matched", () => {
    const result: ListMetadataResult = { documents: 3, filteredDocuments: 1, totalKeys: 0, keys: [], remainingKeys: 0 };

    expect(formatMetadataKeySummaries(result, OPTIONS)).toBe("filter: 1 of 3 documents\n\nNo metadata matches.");
  });

  test("keeps the filter line when the key window falls past the end", () => {
    const result: ListMetadataResult = { documents: 3, filteredDocuments: 2, totalKeys: 4, keys: [], remainingKeys: 0 };

    expect(formatMetadataKeySummaries(result, { ...OPTIONS, keyOffset: 10 })).toBe("filter: 2 of 3 documents\n\nNo keys at --key-offset 10, 4 keys in total.");
  });
});
