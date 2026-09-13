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

export interface FormatMetadataOverviewOptions {
  /** Active, extracted documents declaring at least one key. */
  documentsWithMetadata: number;
  /** Active documents awaiting extraction, mentioned so the coverage reads honestly. */
  pendingMetadata: number;
  /** Keys detailed before the "more keys" pointer. */
  keyLimit: number;
  /** Command that shows the rest, e.g. `qmd collection metadata notes`. */
  drillDownHint: string;
  colors?: MetadataFormatColors;
}

/**
 * The `Metadata:` section of `collection show`: a coverage line, then the
 * top keys by coverage as aligned rows with a short value preview, then a
 * pointer at the drill-down when keys were left out. Indented to sit under
 * the other `show` fields.
 */
export function formatMetadataOverview(result: ListMetadataResult, options: FormatMetadataOverviewOptions): string {
  const colors = options.colors ?? NO_COLORS;
  const pendingNote = options.pendingMetadata > 0 ? ` (${formatCount(options.pendingMetadata)} pending extraction)` : "";

  if (result.keys.length === 0) return `  Metadata: none${pendingNote}`;

  const keyLabel = result.keys.length === 1 ? "key" : "keys";
  const lines = [`  Metadata: ${formatCount(result.keys.length)} ${keyLabel}, ${formatCount(options.documentsWithMetadata)} of ${formatCount(result.documents)} documents${pendingNote}`];

  const shownKeys = result.keys.slice(0, options.keyLimit);
  const keyWidth = Math.max(...shownKeys.map(summary => summary.key.length));
  const typeWidth = Math.max(...shownKeys.map(summary => summary.types.map(typeLabelOf).join(" | ").length));
  const documentsWidth = Math.max(...shownKeys.map(summary => formatCount(summary.documents).length));
  const distinctWidth = Math.max(...shownKeys.map(summary => formatCount(distinctValuesOf(summary)).length));

  for (const summary of shownKeys) {
    const typeLabel = summary.types.map(typeLabelOf).join(" | ");
    const columns = [
      `${colors.cyan}${summary.key.padEnd(keyWidth)}${colors.reset}`,
      `${colors.dim}${typeLabel.padEnd(typeWidth)}${colors.reset}`,
      `${formatCount(summary.documents).padStart(documentsWidth)} ${documentsLabelOf(summary.documents)}`,
      `${formatCount(distinctValuesOf(summary)).padStart(distinctWidth)} distinct`,
    ];
    const preview = formatValuePreview(summary, options.drillDownHint);
    if (preview) columns.push(preview);
    lines.push(`    ${columns.join("  ")}`);
  }

  const hiddenKeys = result.keys.length - shownKeys.length;
  if (hiddenKeys > 0) {
    lines.push(`    ${colors.dim}${formatCount(hiddenKeys)} more ${hiddenKeys === 1 ? "key" : "keys"}, see '${options.drillDownHint}'${colors.reset}`);
  }

  return lines.join("\n");
}

/**
 * One-line value preview for the overview row. Strings list the window with
 * a trailing ellipsis when truncated, and nothing at all when every value is
 * unique (a value list would be noise). Numbers give the range, booleans the
 * two counts, and a type conflict points at the drill-down.
 */
function formatValuePreview(summary: MetadataKeySummary, drillDownHint: string): string {
  if (summary.types.length > 1) return `types disagree, see '${drillDownHint} --key ${summary.key}'`;

  const typeSummary = summary.types[0]!;
  if (typeSummary.type === "boolean") return formatBooleanCounts(typeSummary.values).replace("  ", ", ");
  if (typeSummary.type === "number") {
    const range = typeSummary.range!;
    return `${formatValue(range.min)} to ${formatValue(range.max)}, median ${formatValue(range.median)}`;
  }
  if (typeSummary.distinctValues === typeSummary.documents) return "";

  const preview = typeSummary.values.map(count => `${formatValue(count.value)} (${formatCount(count.documents)})`);
  if (typeSummary.remaining > 0) preview.push("...");
  return preview.join(", ");
}

function distinctValuesOf(summary: MetadataKeySummary): number {
  return summary.types.reduce((sum, typeSummary) => sum + typeSummary.distinctValues, 0);
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
    const row = `  ${typeSummary.type.padEnd(typeWidth)}  ${formatCount(typeSummary.documents).padStart(documentsWidth)} ${documentsLabelOf(typeSummary.documents)}  ${valuesSummary}`;
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

/** Padded so `doc` and `docs` rows stay column-aligned. */
function documentsLabelOf(documents: number): string {
  return documents === 1 ? "doc " : "docs";
}

function formatValue(value: string | number | boolean): string {
  if (value === "") return '""';
  return String(value);
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}
