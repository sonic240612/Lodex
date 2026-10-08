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
  it('rejects invalid indices, sparse, missing-ID and duplicate calls', () => {
    expect(() => new ToolCallAssembler().add({ index: 128 })).toThrow();
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
    expect(() => new ToolCallAssembler().add({ index: 0, name: 'x'.repeat(101) })).toThrow();
  });
  it('assembles large UTF-8 edit arguments without the old 16 KiB ceiling', () => {
    const assembler = new ToolCallAssembler();
    const args = JSON.stringify({ oldText: '한글'.repeat(10000), newText: '수정'.repeat(20000) });
    assembler.add({ index: 0, id: 'large', name: 'propose_edit', arguments: args.slice(0, 17000) });
    assembler.add({ index: 0, arguments: args.slice(17000) });
    expect(assembler.finish()[0]?.arguments).toBe(args);
  });
  it('accepts more than four parallel calls within the agent tool budget', () => {
    const assembler = new ToolCallAssembler();
    for (let index = 0; index < 12; index++)
      assembler.add({ index, id: `call-${index}`, name: 'read_file', arguments: '{}' });
    expect(assembler.finish()).toHaveLength(12);
  });
});
