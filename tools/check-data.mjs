#!/usr/bin/env node
/* Checks contracts.json and abx-owners.json against schema/*.schema.json.

   Usage: node tools/check-data.mjs contracts|owners <file or https URL> ...
   Exit 0 when every input passes, 1 when any fails, 2 on a usage or schema error.

   No dependencies: this implements the JSON Schema 2020-12 keywords the two schemas use and
   refuses any other keyword, so a schema edit can never be silently ignored here. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMAS = {
  contracts: path.join(ROOT, 'schema', 'contracts.schema.json'),
  owners: path.join(ROOT, 'schema', 'abx-owners.schema.json'),
};

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', '$defs']);
const KEYWORDS = new Set(['type', 'enum', 'const', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'required',
  'properties', 'additionalProperties', 'propertyNames', 'items', 'prefixItems', 'anyOf', '$ref']);

export class SchemaError extends Error {}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function hasType(v, t) {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'array': return Array.isArray(v);
    case 'object': return typeOf(v) === 'object';
    default: throw new SchemaError(`unknown type ${t}`);
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolve(root, ref) {
  const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m || !root.$defs || !root.$defs[m[1]]) throw new SchemaError(`unresolvable $ref ${ref}`);
  return root.$defs[m[1]];
}

/** Every reason `value` fails `schema`, each as "<json path>: <reason>". Empty when it passes. */
export function validate(schema, value, root = schema, at = '$') {
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new SchemaError(`unsupported keyword ${k} at ${at}`);
  }
  if (schema.$ref) return validate(resolve(root, schema.$ref), value, root, at);
  const errs = [];
  const fail = (msg) => errs.push(`${at}: ${msg}`);

  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => hasType(value, t))) {
      fail(`is ${typeOf(value)}, expected ${types.join(' or ')}`);
      return errs;
    }
  }
  if (schema.enum && !schema.enum.some((e) => same(e, value))) fail(`${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if ('const' in schema && !same(schema.const, value)) fail(`${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => validate(s, value, root, at));
    if (!branches.some((b) => b.length === 0)) fail(`matches none of anyOf (${branches.map((b) => b[0]).join('; ')})`);
  }

  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
    fail(`${JSON.stringify(value.slice(0, 80))} does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${value} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${value} is above ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`has ${value.length} items, fewer than ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`has ${value.length} items, more than ${schema.maxItems}`);
    const prefix = schema.prefixItems || [];
    value.forEach((v, i) => {
      const s = i < prefix.length ? prefix[i] : schema.items;
      if (s) errs.push(...validate(s, v, root, `${at}[${i}]`));
    });
  }

  if (typeOf(value) === 'object') {
    for (const r of schema.required || []) if (!(r in value)) fail(`missing ${r}`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (schema.propertyNames) errs.push(...validate(schema.propertyNames, k, root, `${at} key ${JSON.stringify(k)}`));
      if (k in props) errs.push(...validate(props[k], v, root, `${at}.${k}`));
      else if (schema.additionalProperties === false) fail(`unexpected ${k}`);
      else if (typeOf(schema.additionalProperties) === 'object') errs.push(...validate(schema.additionalProperties, v, root, `${at}.${k}`));
    }
  }
  return errs;
}

/** The owner index's cross-reference rule: every holding names a collection that exists. */
function ownerIndexErrors(ix) {
  if (typeOf(ix) !== 'object' || !Array.isArray(ix.collections) || typeOf(ix.owners) !== 'object') return [];
  const n = ix.collections.length, errs = [];
  for (const [w, holdings] of Object.entries(ix.owners)) {
    for (const h of Array.isArray(holdings) ? holdings : []) {
      if (Array.isArray(h) && Number.isInteger(h[0]) && h[0] >= n) errs.push(`$.owners.${w}: collection index ${h[0]} is past the ${n} collections`);
    }
  }
  return errs;
}

const loaded = {};
export function checkData(kind, value) {
  if (!SCHEMAS[kind]) throw new SchemaError(`unknown kind ${kind}; use ${Object.keys(SCHEMAS).join(' or ')}`);
  loaded[kind] ||= JSON.parse(readFileSync(SCHEMAS[kind], 'utf8'));
  const errs = validate(loaded[kind], value);
  return kind === 'owners' ? errs.concat(ownerIndexErrors(value)) : errs;
}

async function readInput(src) {
  if (/^https:\/\//.test(src)) {
    const r = await fetch(src, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(src, 'utf8'));
}

async function main([kind, ...inputs]) {
  if (!kind || !inputs.length) {
    console.error('usage: node tools/check-data.mjs contracts|owners <file or https URL> ...');
    return 2;
  }
  let failed = 0;
  for (const src of inputs) {
    let errs;
    try {
      errs = checkData(kind, await readInput(src));
    } catch (e) {
      if (e instanceof SchemaError) { console.error(`schema error: ${e.message}`); return 2; }
      errs = [`could not read: ${e.message}`];
    }
    if (errs.length) {
      failed++;
      console.log(`FAIL ${src}: ${errs.length} problem(s)`);
      for (const e of errs.slice(0, 20)) console.log(`  ${e}`);
      if (errs.length > 20) console.log(`  ... ${errs.length - 20} more`);
    } else {
      console.log(`ok ${src}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
