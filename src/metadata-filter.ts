/**
 * QMD Metadata Filter - Recursive predicate AST, strict runtime validation,
 * and parameterized SQL compilation.
 *
 * The predicate has one canonical, `operator`-discriminated recursive shape
 * shared by every public search surface (CLI, SDK, MCP, HTTP):
 *
 *   { "operator": "and", "operands": [ ... ] }
 *   { "operator": "not", "operand": { ... } }
 *   { "field": "status", "operator": "eq", "value": "published" }
 *   { "field": "topics", "operator": "prefix", "value": "sql", "caseInsensitive": true }
 *
 * A condition tests one field of the record under evaluation, named by `field`,
 * against `value` using `operator`. For a document the fields are its metadata
 * keys. Comparison, membership, and text operators are typed by their operand:
 * a string operand only ever compares against string values, a number against
 * numbers, a boolean against booleans, and a mismatch never matches.
 *
 * Compilation emits correlated EXISTS/NOT EXISTS subqueries over
 * `document_metadata_values` with every user value bound as a parameter.
 * Metadata keys and values are data, never SQL.
 */

import type { MetadataScalar, MetadataScalarArray, MetadataValueType } from "./metadata.js";
import { METADATA_LIMITS } from "./metadata.js";

// =============================================================================
// Public types
// =============================================================================

/**
 * The recursive grammar: a condition, or `and`/`or`/`not` over predicates.
 * `Condition` is the set of conditions the record under evaluation admits.
 */
export type MetadataPredicate<Condition> =
  | Condition
  | MetadataPredicateGroup<Condition>
  | MetadataPredicateNegation<Condition>;

export interface MetadataPredicateGroup<Condition> {
  operator: "and" | "or";
  operands: readonly MetadataPredicate<Condition>[];
}

export interface MetadataPredicateNegation<Condition> {
  operator: "not";
  operand: MetadataPredicate<Condition>;
}

/** A predicate over a document, whose fields are its metadata keys. */
export type MetadataFilter = MetadataPredicate<MetadataCondition>;
export type MetadataFilterGroup = MetadataPredicateGroup<MetadataCondition>;
export type MetadataFilterNegation = MetadataPredicateNegation<MetadataCondition>;

/**
 * One condition. `caseInsensitive` folds ASCII letters on both sides and is
 * accepted only where the operand is a string or an array of strings.
 */
export type MetadataCondition =
  | { field: string; operator: "eq" | "ne"; value: MetadataScalar; caseInsensitive?: boolean }
  | { field: string; operator: "gt" | "gte" | "lt" | "lte"; value: string | number; caseInsensitive?: boolean }
  | { field: string; operator: "in" | "nin" | "all"; value: MetadataScalarArray; caseInsensitive?: boolean }
  | { field: string; operator: "contains" | "prefix" | "suffix"; value: string; caseInsensitive?: boolean }
  | { field: string; operator: "type"; value: MetadataValueType }
  | { field: string; operator: "exists"; value: boolean };

export interface CompiledMetadataFilter {
  sql: string;
  params: (string | number)[];
}

/** Raised by parseMetadataFilter with the JSON path of the failing node. */
export class MetadataFilterError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid metadata filter at ${path}: ${message}`);
    this.name = "MetadataFilterError";
    this.path = path;
  }
}

// =============================================================================
// Limits
// =============================================================================

/** Defensive limits for recursive filters from untrusted callers. */
export const METADATA_FILTER_LIMITS = {
  maxDepth: 16,
  maxNodes: 256,
  maxGroupOperands: 32,
  maxMembershipValues: 64,
  maxKeyBytes: METADATA_LIMITS.maxKeyBytes,
  maxStringLength: METADATA_LIMITS.maxStringLength,
} as const;

const GROUP_OPERATORS = new Set(["and", "or"]);
const COMPARISON_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
const ORDERED_OPERATORS = new Set(["gt", "gte", "lt", "lte"]);
const MEMBERSHIP_OPERATORS = new Set(["in", "nin", "all"]);
const TEXT_OPERATORS = new Set(["contains", "prefix", "suffix"]);
const CONDITION_OPERATORS = new Set([...COMPARISON_OPERATORS, ...MEMBERSHIP_OPERATORS, ...TEXT_OPERATORS, "type", "exists"]);
const ALL_OPERATORS = [...GROUP_OPERATORS, "not", ...CONDITION_OPERATORS];
const VALUE_TYPES: readonly MetadataValueType[] = ["string", "number", "boolean"];

// =============================================================================
// Validation
// =============================================================================

type FilterParseState = { nodes: number };

/** Conditions whose operand can be a string, and so can fold case. */
type CaseFoldableCondition = Exclude<MetadataCondition, { operator: "type" | "exists" }>;

/**
 * Strictly validate an untrusted value as a MetadataFilter.
 * Rejects unknown operators, unknown properties, operator-incompatible values,
 * and inputs exceeding METADATA_FILTER_LIMITS. Canonicalizes membership value
 * arrays by de-duplicating while preserving order.
 */
export function parseMetadataFilter(input: unknown): MetadataFilter {
  const state: FilterParseState = { nodes: 0 };
  return parseFilterNode(input, "$", 1, state);
}

function parseFilterNode(input: unknown, path: string, depth: number, state: FilterParseState): MetadataFilter {
  if (depth > METADATA_FILTER_LIMITS.maxDepth) {
    throw new MetadataFilterError(path, `exceeds maximum nesting depth of ${METADATA_FILTER_LIMITS.maxDepth}`);
  }

  state.nodes += 1;
  if (state.nodes > METADATA_FILTER_LIMITS.maxNodes) {
    throw new MetadataFilterError(path, `exceeds maximum of ${METADATA_FILTER_LIMITS.maxNodes} nodes`);
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MetadataFilterError(path, "each filter node must be an object");
  }

  const node = input as Record<string, unknown>;
  const operator = node["operator"];
  if (typeof operator !== "string") {
    throw new MetadataFilterError(path, "missing 'operator' property");
  }

  if (GROUP_OPERATORS.has(operator)) {
    return parseFilterGroup(node, operator as "and" | "or", path, depth, state);
  }
  if (operator === "not") {
    return parseFilterNegation(node, path, depth, state);
  }
  if (CONDITION_OPERATORS.has(operator)) {
    return parseFilterCondition(node, operator, path);
  }

  throw new MetadataFilterError(path, `unknown operator '${operator}' — expected one of: ${ALL_OPERATORS.join(", ")}`);
}

function parseFilterGroup(
  node: Record<string, unknown>,
  operator: "and" | "or",
  path: string,
  depth: number,
  state: FilterParseState,
): MetadataFilterGroup {
  rejectUnknownProperties(node, ["operator", "operands"], path);

  const operands = node["operands"];
  if (!Array.isArray(operands)) {
    throw new MetadataFilterError(path, `'${operator}' requires an 'operands' array`);
  }
  if (operands.length === 0) {
    throw new MetadataFilterError(path, `'${operator}' requires a non-empty 'operands' array`);
  }
  if (operands.length > METADATA_FILTER_LIMITS.maxGroupOperands) {
    throw new MetadataFilterError(path, `'${operator}' exceeds maximum of ${METADATA_FILTER_LIMITS.maxGroupOperands} operands`);
  }

  return {
    operator,
    operands: operands.map((operand, index) =>
      parseFilterNode(operand, `${path}.operands[${index}]`, depth + 1, state)),
  };
}

function parseFilterNegation(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  state: FilterParseState,
): MetadataFilterNegation {
  rejectUnknownProperties(node, ["operator", "operand"], path);

  if (!("operand" in node)) {
    throw new MetadataFilterError(path, "'not' requires exactly one 'operand'");
  }

  return {
    operator: "not",
    operand: parseFilterNode(node["operand"], `${path}.operand`, depth + 1, state),
  };
}

function parseFilterCondition(node: Record<string, unknown>, operator: string, path: string): MetadataCondition {
  rejectUnknownProperties(node, ["field", "operator", "value", "caseInsensitive"], path);

  const field = node["field"];
  if (typeof field !== "string" || field.length === 0) {
    throw new MetadataFilterError(path, `'${operator}' requires a non-empty string 'field'`);
  }
  if (Buffer.byteLength(field, "utf-8") > METADATA_FILTER_LIMITS.maxKeyBytes) {
    throw new MetadataFilterError(path, `'field' exceeds ${METADATA_FILTER_LIMITS.maxKeyBytes} bytes`);
  }

  if (!("value" in node)) {
    throw new MetadataFilterError(path, `'${operator}' requires a 'value'`);
  }
  const value = node["value"];

  const caseInsensitive = node["caseInsensitive"];
  if (caseInsensitive !== undefined && typeof caseInsensitive !== "boolean") {
    throw new MetadataFilterError(`${path}.caseInsensitive`, "'caseInsensitive' must be a boolean");
  }

  if (operator === "exists") {
    if (typeof value !== "boolean") {
      throw new MetadataFilterError(`${path}.value`, "'exists' requires a boolean value");
    }
    rejectCaseInsensitive(caseInsensitive, operator, path);
    return { field, operator, value };
  }

  if (operator === "type") {
    const valueType = VALUE_TYPES.find(candidate => candidate === value);
    if (!valueType) {
      throw new MetadataFilterError(`${path}.value`, `'type' requires one of: ${VALUE_TYPES.join(", ")}`);
    }
    rejectCaseInsensitive(caseInsensitive, operator, path);
    return { field, operator, value: valueType };
  }

  if (TEXT_OPERATORS.has(operator)) {
    const text = parseScalarValue(value, `${path}.value`);
    if (typeof text !== "string" || text.length === 0) {
      throw new MetadataFilterError(`${path}.value`, `'${operator}' requires a non-empty string value`);
    }
    return withCaseFolding({ field, operator: operator as "contains" | "prefix" | "suffix", value: text }, caseInsensitive, path);
  }

  if (MEMBERSHIP_OPERATORS.has(operator)) {
    const values = parseMembershipValues(value, operator, path);
    return withCaseFolding({ field, operator: operator as "in" | "nin" | "all", value: values }, caseInsensitive, path);
  }

  // Comparison operators: eq, ne, gt, gte, lt, lte.
  const scalar = parseScalarValue(value, `${path}.value`);
  if (ORDERED_OPERATORS.has(operator) && typeof scalar === "boolean") {
    throw new MetadataFilterError(`${path}.value`, `'${operator}' requires a string or number value`);
  }
  return withCaseFolding({ field, operator, value: scalar } as CaseFoldableCondition, caseInsensitive, path);
}

/** Attach `caseInsensitive` when given, which only string operands accept. */
function withCaseFolding(condition: CaseFoldableCondition, caseInsensitive: unknown, path: string): MetadataCondition {
  if (caseInsensitive === undefined) return condition;

  const operand: unknown = condition.value;
  const isText = typeof operand === "string";
  const isTextArray = Array.isArray(operand) && operand.every(element => typeof element === "string");
  if (!isText && !isTextArray) {
    throw new MetadataFilterError(`${path}.caseInsensitive`, "'caseInsensitive' applies to string values only");
  }

  return { ...condition, caseInsensitive: caseInsensitive === true };
}

function rejectCaseInsensitive(caseInsensitive: unknown, operator: string, path: string): void {
  if (caseInsensitive === undefined) return;
  throw new MetadataFilterError(`${path}.caseInsensitive`, `'caseInsensitive' does not apply to '${operator}'`);
}

function parseMembershipValues(value: unknown, operator: string, path: string): MetadataScalarArray {
  if (!Array.isArray(value)) {
    throw new MetadataFilterError(`${path}.value`, `'${operator}' requires an array value`);
  }
  if (value.length === 0) {
    throw new MetadataFilterError(`${path}.value`, `'${operator}' requires a non-empty array value`);
  }
  if (value.length > METADATA_FILTER_LIMITS.maxMembershipValues) {
    throw new MetadataFilterError(`${path}.value`, `'${operator}' exceeds maximum of ${METADATA_FILTER_LIMITS.maxMembershipValues} values`);
  }

  const scalars = value.map((element, index) => parseScalarValue(element, `${path}.value[${index}]`));

  // Narrow each homogeneous case explicitly so the public array union remains
  // precise without discarding type evidence through chained assertions.
  if (scalars.every((scalar): scalar is string => typeof scalar === "string")) {
    return Array.from(new Set(scalars));
  }
  if (scalars.every((scalar): scalar is number => typeof scalar === "number")) {
    return Array.from(new Set(scalars));
  }
  if (scalars.every((scalar): scalar is boolean => typeof scalar === "boolean")) {
    return Array.from(new Set(scalars));
  }
  throw new MetadataFilterError(`${path}.value`, `'${operator}' requires a homogeneous array of one scalar type`);
}

function parseScalarValue(value: unknown, path: string): MetadataScalar {
  if (typeof value === "string") {
    if (value.length > METADATA_FILTER_LIMITS.maxStringLength) {
      throw new MetadataFilterError(path, `string exceeds ${METADATA_FILTER_LIMITS.maxStringLength} characters`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MetadataFilterError(path, "numbers must be finite");
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  throw new MetadataFilterError(path, "expected a string, number, or boolean");
}

function rejectUnknownProperties(node: Record<string, unknown>, allowed: string[], path: string): void {
  for (const property of Object.keys(node)) {
    if (!allowed.includes(property)) {
      throw new MetadataFilterError(path, `unknown property '${property}' — allowed: ${allowed.join(", ")}`);
    }
  }
}

// =============================================================================
// SQL compilation
// =============================================================================

/**
 * Compile a validated filter into one parameterized SQL predicate correlated
 * against a documents-table alias (e.g. `d`). All keys and values are bound
 * parameters. The caller is responsible for restricting the surrounding query
 * to active documents with current, error-free metadata extraction.
 */
export function compileMetadataFilter(filter: MetadataFilter, documentsAlias: string): CompiledMetadataFilter {
  const params: (string | number)[] = [];
  const sql = compileFilterNode(filter, documentsAlias, params);
  return { sql, params };
}

function compileFilterNode(filter: MetadataFilter, alias: string, params: (string | number)[]): string {
  switch (filter.operator) {
    case "and":
    case "or": {
      const joiner = filter.operator === "and" ? " AND " : " OR ";
      return `(${filter.operands.map(operand => compileFilterNode(operand, alias, params)).join(joiner)})`;
    }

    case "not":
      return `NOT ${compileFilterNode(filter.operand, alias, params)}`;

    case "exists":
      params.push(filter.field);
      return filter.value
        ? buildValueExistsSql(alias, "mv.key = ?")
        : `NOT ${buildValueExistsSql(alias, "mv.key = ?")}`;

    case "type":
      params.push(filter.field, filter.value);
      return buildValueExistsSql(alias, "mv.key = ? AND mv.value_type = ?");

    case "eq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const sqlOperator = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.operator];
      const columnSql = buildValueColumnSql(filter.value, filter.caseInsensitive);
      params.push(filter.field, bindOperand(filter.value, filter.caseInsensitive));
      return buildValueExistsSql(
        alias,
        `mv.key = ? AND mv.value_type = '${valueTypeOf(filter.value)}' AND ${columnSql} ${sqlOperator} ?`,
      );
    }

    case "ne": {
      // Key must have at least one same-type value, and no same-type value
      // may equal the operand. Missing keys and type mismatches do not match.
      const valueType = valueTypeOf(filter.value);
      const columnSql = buildValueColumnSql(filter.value, filter.caseInsensitive);
      params.push(filter.field);
      const presentSql = buildValueExistsSql(alias, `mv.key = ? AND mv.value_type = '${valueType}'`);
      params.push(filter.field, bindOperand(filter.value, filter.caseInsensitive));
      const equalSql = buildValueExistsSql(alias, `mv.key = ? AND mv.value_type = '${valueType}' AND ${columnSql} = ?`);
      return `(${presentSql} AND NOT ${equalSql})`;
    }

    case "in":
    case "nin": {
      const valueType = valueTypeOf(filter.value[0]!);
      const columnSql = buildValueColumnSql(filter.value[0]!, filter.caseInsensitive);
      const placeholders = filter.value.map(() => "?").join(", ");
      const operands = filter.value.map(element => bindOperand(element, filter.caseInsensitive));

      if (filter.operator === "in") {
        params.push(filter.field, ...operands);
        return buildValueExistsSql(alias, `mv.key = ? AND mv.value_type = '${valueType}' AND ${columnSql} IN (${placeholders})`);
      }

      params.push(filter.field);
      const presentSql = buildValueExistsSql(alias, `mv.key = ? AND mv.value_type = '${valueType}'`);
      params.push(filter.field, ...operands);
      const memberSql = buildValueExistsSql(alias, `mv.key = ? AND mv.value_type = '${valueType}' AND ${columnSql} IN (${placeholders})`);
      return `(${presentSql} AND NOT ${memberSql})`;
    }

    case "all": {
      const valueType = valueTypeOf(filter.value[0]!);
      const columnSql = buildValueColumnSql(filter.value[0]!, filter.caseInsensitive);
      const memberSqls = filter.value.map(element => {
        params.push(filter.field, bindOperand(element, filter.caseInsensitive));
        return buildValueExistsSql(alias, `mv.key = ? AND mv.value_type = '${valueType}' AND ${columnSql} = ?`);
      });
      return `(${memberSqls.join(" AND ")})`;
    }

    case "contains":
    case "prefix":
    case "suffix": {
      params.push(filter.field);
      const textSql = compileTextTestSql(filter.operator, filter.value, filter.caseInsensitive, params);
      return buildValueExistsSql(alias, `mv.key = ? AND mv.value_type = 'string' AND ${textSql}`);
    }
  }
}

function buildValueExistsSql(alias: string, conditionSql: string): string {
  return `EXISTS (SELECT 1 FROM document_metadata_values mv WHERE mv.document_id = ${alias}.id AND ${conditionSql})`;
}

/**
 * Substring tests over the string column. Prefix and suffix compare UTF-8
 * bytes, with the operand's byte length bound from JavaScript: SQLite's text
 * `length()` and `substr()` stop at an embedded NUL, and blobs do not. UTF-8
 * is self-synchronizing, so a byte-prefix (or byte-suffix) of a whole operand
 * is exactly a character-prefix (or -suffix).
 */
function compileTextTestSql(
  operator: "contains" | "prefix" | "suffix",
  text: string,
  caseInsensitive: boolean | undefined,
  params: (string | number)[],
): string {
  const columnSql = buildValueColumnSql(text, caseInsensitive);
  const operand = caseInsensitive ? foldAsciiCase(text) : text;

  if (operator === "contains") {
    params.push(operand);
    return `instr(${columnSql}, ?) > 0`;
  }

  params.push(utf8ByteLengthOf(operand), operand);
  return operator === "prefix"
    ? `substr(CAST(${columnSql} AS BLOB), 1, ?) = CAST(? AS BLOB)`
    : `substr(CAST(${columnSql} AS BLOB), -?) = CAST(? AS BLOB)`;
}

const utf8Encoder = new TextEncoder();

function utf8ByteLengthOf(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function valueTypeOf(scalar: MetadataScalar): MetadataValueType {
  return typeof scalar as MetadataValueType;
}

/** The typed column an operand compares against, folded when the condition ignores case. */
function buildValueColumnSql(scalar: MetadataScalar, caseInsensitive: boolean | undefined): string {
  if (typeof scalar === "number") return "mv.number_value";
  if (typeof scalar === "boolean") return "mv.boolean_value";
  return caseInsensitive ? "lower(mv.text_value)" : "mv.text_value";
}

/** Booleans bind as 0/1. Case-insensitive strings bind folded the same way SQLite's `lower()` folds the column. */
function bindOperand(scalar: MetadataScalar, caseInsensitive: boolean | undefined): string | number {
  if (typeof scalar === "boolean") return scalar ? 1 : 0;
  if (typeof scalar === "string" && caseInsensitive) return foldAsciiCase(scalar);
  return scalar;
}

/** SQLite's built-in `lower()` folds ASCII letters only, so the operand is folded over the same range. */
function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]/g, letter => letter.toLowerCase());
}
