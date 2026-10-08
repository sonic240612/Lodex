import { describe, expect, it } from 'vitest';
import type { JsonSchemaType } from '@modelcontextprotocol/client';
import { createMcpValidator } from './schema';

function referenceTree(depth: number, branches = 2): JsonSchemaType {
  const $defs: Record<string, JsonSchemaType> = { level0: { type: 'string' } };
  for (let index = 1; index <= depth; index++)
    $defs[`level${index}`] = {
      allOf: Array.from({ length: branches }, () => ({ $ref: `#/$defs/level${index - 1}` })),
    };
  return { $defs, type: 'array', items: { $ref: `#/$defs/level${depth}` } };
}

describe('MCP JSON Schema compatibility', () => {
  it('validates local references, formats, patterns and pattern properties', () => {
    const validate = createMcpValidator().getValidator({
      type: 'object',
      $defs: { code: { type: 'string', pattern: '^[A-Z]{2}-[0-9]+$' } },
      properties: { code: { $ref: '#/$defs/code' }, email: { type: 'string', format: 'email' } },
      patternProperties: { '^meta_': { type: 'integer' } },
      additionalProperties: false,
      required: ['code', 'email'],
    });
    expect(validate({ code: 'AB-12', email: 'a@example.com', meta_count: 2 }).valid).toBe(true);
    expect(validate({ code: 'wrong', email: 'a@example.com' }).valid).toBe(false);
    expect(validate({ code: 'AB-12', email: 'invalid' }).valid).toBe(false);
    expect(validate({ code: 'AB-12', email: 'a@example.com', meta_count: '2' }).valid).toBe(false);
  });
  it('keeps schema IDs isolated and supports draft-07 and recursive objects', () => {
    const validator = createMcpValidator();
    expect(validator.getValidator({ $id: 'urn:test:same', type: 'string' })('a').valid).toBe(true);
    expect(validator.getValidator({ $id: 'urn:test:same', type: 'number' })('a').valid).toBe(false);
    const recursive = validator.getValidator({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { child: { $ref: '#' }, value: { type: 'number' } },
    });
    expect(recursive({ child: { value: 1 } }).valid).toBe(true);
    expect(recursive({ child: { value: '1' } }).valid).toBe(false);
  });
  it('does not fetch external references or silently ignore unknown formats', () => {
    for (const schema of [
      { $ref: 'https://example.com/schema.json' },
      { $ref: 'file:///secret' },
      { type: 'string', format: 'unknown-format' },
      { type: 'string', pattern: '(a)\\1' },
      { type: 'object', $async: true },
    ])
      expect(() => createMcpValidator().getValidator(schema)).toThrow();
  });
  it('handles nested repetition without catastrophic backtracking and bounds data depth', () => {
    const validate = createMcpValidator().getValidator({ type: 'string', pattern: '^(a+)+$' });
    expect(validate('a'.repeat(50000) + '!').valid).toBe(false);
    let data: unknown = 1;
    for (let i = 0; i < 30; i++) data = { child: data };
    expect(() => validate(data)).toThrow();
  });
  it('rejects small documents with exponential reference expansion before compilation', () => {
    const schema = referenceTree(32);
    expect(JSON.stringify(schema).length).toBeLessThan(4000);
    expect(() => createMcpValidator().getValidator(schema)).toThrow(
      expect.objectContaining({ code: 'MCP_COMPLEXITY' }),
    );
  });
  it('bounds reference depth even when earlier definitions have already been memoized', () => {
    expect(() => createMcpValidator().getValidator(referenceTree(80, 1))).toThrow(
      expect.objectContaining({ code: 'MCP_COMPLEXITY' }),
    );
  });
  it('bounds repeated validation work and resets the budget for each cached validator call', () => {
    const validator = createMcpValidator();
    const schema = referenceTree(9);
    const validate = validator.getValidator(schema);
    expect(validate(['fixture']).valid).toBe(true);
    const limited = validate(Array.from({ length: 32 }, () => 'fixture'));
    expect(limited.valid).toBe(false);
    expect(limited.errorMessage).toContain('안전하게 검증');
    expect(validator.getValidator(schema)(['fixture']).valid).toBe(true);
    expect(validate(['fixture']).valid).toBe(true);
    // Guard injection must not mutate the server's original schema or cache identity.
    expect(JSON.stringify(schema)).not.toContain('lodexValidationBudget');
  });
  it('does not allow a schema to replace or disable internal validation guards', () => {
    for (const schema of [
      { lodexValidationBudget: false },
      { type: 'object', properties: { value: { lodexValidationBudget: false } } },
      { $ref: '#/custom', custom: { lodexValidationBudget: false } },
    ])
      expect(() => createMcpValidator().getValidator(schema as JsonSchemaType)).toThrow(
        expect.objectContaining({ code: 'MCP_SCHEMA' }),
      );
  });
  it('inspects draft-07 tuple and dependency schemas without interpreting literal data as schemas', () => {
    const validator = createMcpValidator();
    for (const extra of [
      { type: 'array', items: [{ type: 'string' }], additionalItems: { $async: true } },
      { type: 'object', dependencies: { value: { $async: true } } },
    ])
      expect(() =>
        validator.getValidator({
          $schema: 'http://json-schema.org/draft-07/schema#',
          ...extra,
        } as JsonSchemaType),
      ).toThrow();
    const literal = { lodexValidationBudget: false, $ref: 'literal text', $async: true };
    expect(validator.getValidator({ const: literal })(literal).valid).toBe(true);
  });
  it('rejects references into literal data without modifying its validation meaning', () => {
    const literal = { type: 'number' };
    for (const key of ['const', 'default', 'examples']) {
      const schema = { [key]: { value: literal }, $ref: `#/${key}/value` };
      expect(() => createMcpValidator().getValidator(schema)).toThrow(
        expect.objectContaining({ code: 'MCP_SCHEMA' }),
      );
      expect(literal).toEqual({ type: 'number' });
    }
  });
  it('resolves references in nested resources and escaped JSON pointer names', () => {
    const validate = createMcpValidator().getValidator({
      type: 'object',
      $defs: {
        'code/value': { type: 'number' },
        nested: {
          $id: 'urn:lodex:fixture:nested',
          type: 'object',
          $defs: { value: { type: 'string' } },
          properties: { value: { $ref: '#/$defs/value' } },
        },
      },
      properties: {
        code: { $ref: '#/$defs/code~1value' },
        nested: { $ref: '#/$defs/nested' },
      },
    });
    expect(validate({ code: 1, nested: { value: 'valid' } }).valid).toBe(true);
    expect(validate({ code: 'wrong' }).valid).toBe(false);
    expect(validate({ nested: { value: 1 } }).valid).toBe(false);
  });
  it.each([
    {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $recursiveAnchor: true,
      childRef: { $recursiveRef: '#' },
    },
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $dynamicAnchor: 'node',
      childRef: { $dynamicRef: '#node' },
    },
  ])('preserves recursive object validation for $schema', ({ childRef, ...dialect }) => {
    const schema = {
      ...dialect,
      type: 'object',
      properties: { value: { type: 'number' }, child: childRef },
    };
    const validate = createMcpValidator().getValidator(schema);
    expect(validate({ value: 1, child: { value: 2, child: { value: 3 } } }).valid).toBe(true);
    expect(validate({ child: { value: 'wrong' } }).valid).toBe(false);
  });
});
