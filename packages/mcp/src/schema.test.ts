import { describe, expect, it } from 'vitest';
import { createMcpValidator } from './schema';

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
});
