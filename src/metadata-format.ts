/**
 * QMD Metadata Format - Plain-text rendering of metadata discovery results.
 *
 * Shared by the CLI and the MCP `metadata` tool so both print one shape: a
 * header per key, a body per type, and a footer naming the remainder and the
 * option that removes the cap whenever a value list is truncated.
 */

import type {
  ListMetadataResult,
  MetadataKeySummary,
  MetadataKeyTypeSummary,
  MetadataValueCount,
} from "./metadata-store.js";

export interface MetadataFormatColors {
  reset: string;
  dim: string;
  bold: string;
  cyan: string;
}

export interface FormatMetadataOptions {
  /** Show which collections contribute each type on type-split keys. */
  showCollections?: boolean;
  /** How the caller raises the value window, e.g. `-n <num> or --all`. */
  limitHint: string;
  /** ANSI sequences; omit for plain text. */
  colors?: MetadataFormatColors;
}

const NO_COLORS: MetadataFormatColors = { reset: "", dim: "", bold: "", cyan: "" };

/** Render every key summary as a block, separated by blank lines. */
export function formatMetadataKeySummaries(result: ListMetadataResult, options: FormatMetadataOptions): string {
  return result.keys.map(summary => formatMetadataKeySummary(summary, result, options)).join("\n\n");
}

export function formatMetadataKeySummary(summary: MetadataKeySummary, result: ListMetadataResult, options: FormatMetadataOptions): string {
  const colors = options.colors ?? NO_COLORS;
  const typeLabel = summary.types.map(typeLabelOf).join(" | ");
  const coverage = `${formatCount(summary.documents)} of ${formatCount(result.documents)} documents${result.filteredDocuments === undefined ? "" : " match filter"}`;
  const header = [`${colors.cyan}${colors.bold}${summary.key}${colors.reset}`, `${colors.dim}${typeLabel}${colors.reset}`, coverage];
  const lines: string[] = [];

  if (summary.types.length === 1) {
    const typeSummary = summary.types[0]!;
    if (typeSummary.type !== "boolean") header.push(`${formatCount(typeSummary.distinctValues)} distinct`);
    lines.push(header.join("  "), ...formatTypeBody(typeSummary));
  } else {
    lines.push(header.join("  "), ...formatTypeSplit(summary.types, options));
  }

  const remaining = summary.types.reduce((sum, typeSummary) => sum + typeSummary.remaining, 0);
  if (remaining > 0) {
    lines.push(`${colors.dim}${formatCount(remaining)} more values, use ${options.limitHint}${colors.reset}`);
  }

  return lines.join("\n");
}

/** Body for a key with one type: vertical values for strings, a range for numbers, one line for booleans. */
function formatTypeBody(typeSummary: MetadataKeyTypeSummary): string[] {
  if (typeSummary.type === "boolean") return [`  ${formatBooleanCounts(typeSummary.values)}`];

  if (typeSummary.type === "number") {
    const lines = [`  ${formatRange(typeSummary)}`];
    if (typeSummary.values.length > 0) lines.push(`  ${formatInlineValues(typeSummary).join("  ")}`);
    return lines;
  }

  const valueWidth = Math.max(...typeSummary.values.map(count => formatValue(count.value).length));
  const countWidth = Math.max(...typeSummary.values.map(count => formatCount(count.documents).length));
  return typeSummary.values.map(count => `  ${formatValue(count.value).padEnd(valueWidth)}  ${formatCount(count.documents).padStart(countWidth)}`);
}

/**
 * Body for a key whose documents disagree on type: one line per type with
 * its own document count and a compact value summary, plus the contributing
 * collections when the view spans more than one.
 */
function formatTypeSplit(typeSummaries: MetadataKeyTypeSummary[], options: FormatMetadataOptions): string[] {
  const typeWidth = Math.max(...typeSummaries.map(typeSummary => typeSummary.type.length));
  const documentsWidth = Math.max(...typeSummaries.map(typeSummary => formatCount(typeSummary.documents).length));

  const rows = typeSummaries.map(typeSummary => {
    let valuesSummary: string;
    if (typeSummary.type === "boolean") valuesSummary = formatBooleanCounts(typeSummary.values);
    else if (typeSummary.type === "number") valuesSummary = formatRange(typeSummary);
    else {
      const inlineValues = typeSummary.values.map(count => `${formatValue(count.value)} (${formatCount(count.documents)})`);
      if (typeSummary.remaining > 0) inlineValues.push(`${formatCount(typeSummary.remaining)} more`);
      valuesSummary = inlineValues.join(", ");
    }
    const documentsLabel = typeSummary.documents === 1 ? "doc " : "docs";
    const row = `  ${typeSummary.type.padEnd(typeWidth)}  ${formatCount(typeSummary.documents).padStart(documentsWidth)} ${documentsLabel}  ${valuesSummary}`;
    return { row, collections: typeSummary.collections.join(", ") };
  });

  if (!options.showCollections) return rows.map(({ row }) => row);

  const rowWidth = Math.max(...rows.map(({ row }) => row.length));
  return rows.map(({ row, collections }) => `${row.padEnd(rowWidth)}  ${collections}`);
}

function typeLabelOf(typeSummary: MetadataKeyTypeSummary): string {
  return typeSummary.multiValued ? `${typeSummary.type}[]` : typeSummary.type;
}

function formatRange(typeSummary: MetadataKeyTypeSummary): string {
  const range = typeSummary.range!;
  return `min ${formatValue(range.min)}  median ${formatValue(range.median)}  max ${formatValue(range.max)}`;
}

/**
 * Numbers enumerate inline as `value (documents)`. When the whole
 * distribution fits it reads in value order; a truncated window keeps the
 * requested order so the most common values stay visible.
 */
function formatInlineValues(typeSummary: MetadataKeyTypeSummary): string[] {
  const values = typeSummary.remaining === 0
    ? [...typeSummary.values].sort((a, b) => Number(a.value) - Number(b.value))
    : typeSummary.values;
  return values.map(count => `${formatValue(count.value)} (${formatCount(count.documents)})`);
}

function formatBooleanCounts(values: MetadataValueCount[]): string {
  const trueCount = values.find(count => count.value === true);
  const falseCount = values.find(count => count.value === false);
  const parts: string[] = [];
  if (trueCount) parts.push(`true ${formatCount(trueCount.documents)}`);
  if (falseCount) parts.push(`false ${formatCount(falseCount.documents)}`);
  return parts.join("  ");
}

function formatValue(value: string | number | boolean): string {
  if (value === "") return '""';
  return String(value);
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}
