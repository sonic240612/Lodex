import { Ajv, type Options } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { formatNames } from 'ajv-formats/dist/formats.js';
import { RE2JS } from 're2js';
import { AppError } from '@lodex/contracts';
import type { JsonSchemaType, jsonSchemaValidator } from '@modelcontextprotocol/client';

const formats = new Set<string>(formatNames);
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

function inspect(schema: JsonSchemaType) {
  bounded(schema, 32768);
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
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
    for (const [key, child] of Object.entries(node)) {
      if (
        ['properties', '$defs', 'definitions', 'dependentSchemas', 'patternProperties'].includes(
          key,
        ) &&
        child &&
        typeof child === 'object'
      ) {
        if (key === 'patternProperties')
          Object.keys(child).forEach((pattern) => regexp(pattern, 'u'));
        Object.values(child).forEach(visit);
      } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(child)) {
        child.forEach(visit);
      } else if (
        [
          'items',
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
        visit(child);
    }
  };
  visit(schema);
}

/** Compile each document in isolation: equal $id values from different servers cannot collide. */
export function createMcpValidator(): jsonSchemaValidator {
  const cache = new Map<string, ReturnType<Ajv['compile']>>();
  return {
    getValidator<T>(schema: JsonSchemaType) {
      inspect(schema);
      const key = JSON.stringify(schema);
      let validate = cache.get(key);
      if (!validate) {
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
        validate = engine.compile(schema);
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, validate);
      }
      const check = validate;
      return (input: unknown) => {
        bounded(input, 131072);
        try {
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
