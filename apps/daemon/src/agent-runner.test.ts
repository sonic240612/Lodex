import { describe, expect, it } from 'vitest';
import { ToolCallAssembler } from './agent-runner';
describe('tool call assembly', () => {
  it('preserves split JSON and orders parallel calls by their index', () => {
    const assembler = new ToolCallAssembler();
    assembler.add({ index: 1, id: 'b', name: 'list_files', arguments: '{}' });
    assembler.add({ index: 0, id: 'a', name: 'read_', arguments: '{"path":' });
    assembler.add({ index: 0, name: 'file', arguments: '"a.ts"}' });
    expect(assembler.finish()).toEqual([
      { id: 'a', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { id: 'b', name: 'list_files', arguments: '{}' },
    ]);
  });
  it('rejects unbounded, sparse, missing-ID and duplicate calls', () => {
    expect(() => new ToolCallAssembler().add({ index: 4 })).toThrow();
    const sparse = new ToolCallAssembler();
    sparse.add({ index: 1, id: 'a', name: 'read_file' });
    expect(() => sparse.finish()).toThrow();
    const missing = new ToolCallAssembler();
    missing.add({ index: 0, name: 'read_file' });
    expect(() => missing.finish()).toThrow();
    const duplicate = new ToolCallAssembler();
    duplicate.add({ index: 0, id: 'a', name: 'read_file' });
    duplicate.add({ index: 1, id: 'a', name: 'read_file' });
    expect(() => duplicate.finish()).toThrow();
    expect(() => new ToolCallAssembler().add({ index: 0, arguments: 'x'.repeat(17000) })).toThrow();
  });
});
