import { Ajv, type Options } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { formatNames } from 'ajv-formats/dist/formats.js';
import { RE2JS } from 're2js';
import { AppError } from '@lodex/contracts';
import type { JsonSchemaType, jsonSchemaValidator } from '@modelcontextprotocol/client';

const formats = new Set<string>(formatNames);
const budgetKeyword = 'lodexValidationBudget';
const maxExpandedSchemaNodes = 8192;
const maxReferenceDepth = 64;
const maxValidationSteps = 16384;
type SchemaNode = Record<string, unknown>;
const isSchemaNode = (value: unknown): value is SchemaNode =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Only schema positions are traversed; const/default/example values remain ordinary data. */
function children(node: SchemaNode): unknown[] {
  const result: unknown[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (
      [
        'properties',
        '$defs',
        'definitions',
        'dependentSchemas',
        'patternProperties',
        'dependencies',
      ].includes(key) &&
      isSchemaNode(child)
    )
      result.push(...Object.values(child).filter((value) => !Array.isArray(value)));
    else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(child))
      result.push(...child);
    else if (key === 'items' && Array.isArray(child)) result.push(...child);
    else if (
      [
        'items',
        'additionalItems',
        'additionalProperties',
        'contains',
        'not',
        'if',
        'then',
        'else',
        'propertyNames',
        'unevaluatedProperties',
        'unevaluatedItems',
      ].includes(key)
    )
      result.push(child);
  }
  return result;
}
const regexp = Object.assign(
  (pattern: string, flags: string) => {
    if (pattern.length > 2048 || (flags !== '' && flags !== 'u'))
      throw new AppError('MCP_SCHEMA', 'MCP 정규식 크기 또는 플래그를 지원하지 않습니다.');
    const compiled = RE2JS.compile(RE2JS.translateRegExp(pattern));
    return {
      test: (value: string) => compiled.test(value),
      toString: () => JSON.stringify([pattern, flags]),
    };
  },
  { code: 'lodexLinearRegExp' },
);

function bounded(value: unknown, bytes: number) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > bytes)
    throw new AppError('MCP_SIZE', 'MCP 검증 데이터가 너무 큽니다.');
  let count = 0;
  const visit = (item: unknown, depth: number) => {
    if (++count > 4096 || depth > 24)
      throw new AppError('MCP_COMPLEXITY', 'MCP 검증 데이터 구조가 너무 복잡합니다.');
    if (item && typeof item === 'object')
      Object.values(item).forEach((next) => visit(next, depth + 1));
  };
  visit(value, 0);
}

function inspect(schema: JsonSchemaType): SchemaNode[] {
  bounded(schema, 32768);
  const resources = new Map<SchemaNode, SchemaNode>();
  const anchors = new Map<SchemaNode, Map<string, SchemaNode>>();
  const edges = new Map<SchemaNode, SchemaNode[]>();
  const visit = (value: unknown, inheritedResource: SchemaNode) => {
    if (!isSchemaNode(value) || resources.has(value)) return;
    const node = value;
    const resource =
      typeof node.$id === 'string' && !node.$id.startsWith('#') ? node : inheritedResource;
    resources.set(node, resource);
    const names = anchors.get(resource) ?? new Map<string, SchemaNode>();
    anchors.set(resource, names);
    for (const key of ['$anchor', '$dynamicAnchor'])
      if (typeof node[key] === 'string') names.set(node[key], node);
    if (typeof node.$id === 'string' && node.$id.startsWith('#'))
      names.set(node.$id.slice(1), node);
    if (budgetKeyword in node)
      throw new AppError('MCP_SCHEMA', 'MCP 스키마에 예약된 검증 키워드를 사용할 수 없습니다.');
    for (const key of ['$ref', '$dynamicRef', '$recursiveRef']) {
      if (key in node && (typeof node[key] !== 'string' || !node[key].startsWith('#')))
        throw new AppError(
          'MCP_SCHEMA',
          'MCP 스키마 참조는 같은 문서 안에서만 사용할 수 있습니다.',
        );
    }
    if ('$async' in node)
      throw new AppError('MCP_SCHEMA', '비동기 스키마 검증은 지원하지 않습니다.');
    if ('format' in node && (typeof node.format !== 'string' || !formats.has(node.format)))
      throw new AppError('MCP_SCHEMA', '지원하지 않는 MCP 문자열 형식입니다.');
    if ('pattern' in node) {
      if (typeof node.pattern !== 'string')
        throw new AppError('MCP_SCHEMA', '잘못된 정규식입니다.');
      regexp(node.pattern, 'u');
    }
    if (isSchemaNode(node.patternProperties))
      Object.keys(node.patternProperties).forEach((pattern) => regexp(pattern, 'u'));
    const nested = children(node).filter(isSchemaNode);
    edges.set(node, nested);
    for (const child of nested) visit(child, resource);
  };
  visit(schema, schema);
  // Resolve local pointers within their $id resource. Do not inject a guard into
  // const/default/example data merely because a server references it as a schema.
  for (const [node, resource] of resources) {
    for (const key of ['$ref', '$dynamicRef', '$recursiveRef']) {
      if (typeof node[key] !== 'string') continue;
      const fragment = decodeURIComponent(node[key].slice(1));
      let target: unknown = resource;
      if (fragment.startsWith('/')) {
        for (const part of fragment.slice(1).split('/')) {
          const name = part.replace(/~1/g, '/').replace(/~0/g, '~');
          target =
            target && typeof target === 'object' && Object.hasOwn(target, name)
              ? (target as Record<string, unknown>)[name]
              : undefined;
        }
      } else if (fragment) target = anchors.get(resource)?.get(fragment);
      if (isSchemaNode(target)) {
        if (!resources.has(target))
          throw new AppError(
            'MCP_SCHEMA',
            'MCP 스키마 참조는 표준 스키마 위치만 가리킬 수 있습니다.',
          );
        edges.get(node)!.push(target);
      }
    }
  }
  const memo = new Map<SchemaNode, { count: number; height: number }>();
  const active = new Set<SchemaNode>();
  const expanded = (node: SchemaNode, depth: number): { count: number; height: number } => {
    if (depth > maxReferenceDepth)
      throw new AppError('MCP_COMPLEXITY', 'MCP 스키마 참조가 너무 깊습니다.');
    // Recursive object schemas are supported; their data-dependent expansion is
    // separately charged during validation instead of being expanded infinitely.
    if (active.has(node)) return { count: 1, height: 0 };
    const previous = memo.get(node);
    if (previous) {
      if (depth + previous.height > maxReferenceDepth)
        throw new AppError('MCP_COMPLEXITY', 'MCP 스키마 참조가 너무 깊습니다.');
      return previous;
    }
    active.add(node);
    let count = 1;
    let height = 0;
    for (const child of edges.get(node) ?? []) {
      const next = expanded(child, depth + 1);
      count += next.count;
      height = Math.max(height, next.height + 1);
      if (count > maxExpandedSchemaNodes)
        throw new AppError('MCP_COMPLEXITY', 'MCP 스키마 참조의 확장량이 너무 큽니다.');
    }
    active.delete(node);
    const result = { count, height };
    memo.set(node, result);
    return result;
  };
  for (const node of resources.keys()) expanded(node, 0);
  return [...resources.keys()];
}

/** Compile each document in isolation: equal $id values from different servers cannot collide. */
export function createMcpValidator(): jsonSchemaValidator {
  const cache = new Map<string, { check: ReturnType<Ajv['compile']>; reset: () => void }>();
  return {
    getValidator<T>(schema: JsonSchemaType) {
      bounded(schema, 32768);
      const key = JSON.stringify(schema);
      let validate = cache.get(key);
      if (!validate) {
        const guarded = structuredClone(schema);
        for (const node of inspect(guarded)) node[budgetKeyword] = true;
        const options: Options = {
          strict: false,
          validateSchema: false,
          validateFormats: true,
          allErrors: false,
          ownProperties: true,
          inlineRefs: false,
          loopRequired: 32,
          loopEnum: 32,
          code: { regExp: regexp },
        };
        const dialect = schema.$schema;
        const engine =
          !dialect || /\/draft\/2020-12\/schema#?$/.test(String(dialect))
            ? new Ajv2020(options)
            : /\/draft\/2019-09\/schema#?$/.test(String(dialect))
              ? new Ajv2019(options)
              : /\/draft-0[67]\/schema#?$/.test(String(dialect))
                ? new Ajv(options)
                : null;
        if (!engine) throw new AppError('MCP_SCHEMA', '지원하지 않는 JSON Schema 버전입니다.');
        addFormats(engine, { mode: 'fast' });
        let steps = 0;
        engine.addKeyword({
          keyword: budgetKeyword,
          schemaType: 'boolean',
          // Dynamic/recursive references precede ordinary $ref in modern dialects.
          before: engine.getKeyword('$dynamicRef') ? '$dynamicRef' : '$ref',
          errors: false,
          validate: () => {
            if (++steps > maxValidationSteps)
              throw new AppError('MCP_COMPLEXITY', 'MCP 스키마 검증 작업량이 너무 큽니다.');
            return true;
          },
        });
        validate = {
          check: engine.compile(guarded),
          reset: () => {
            steps = 0;
          },
        };
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, validate);
      }
      const { check, reset } = validate;
      return (input: unknown) => {
        bounded(input, 131072);
        try {
          reset();
          return check(input)
            ? { valid: true, data: input as T, errorMessage: undefined }
            : {
                valid: false,
                data: undefined,
                errorMessage: 'MCP 데이터가 JSON Schema와 일치하지 않습니다.',
              };
        } catch {
          return {
            valid: false,
            data: undefined,
            errorMessage: 'MCP 스키마를 안전하게 검증하지 못했습니다.',
          };
        }
      };
    },
  };
}
