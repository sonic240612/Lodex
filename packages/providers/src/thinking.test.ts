import { describe, expect, it } from 'vitest';
import { ThinkingSplitter } from './thinking';
describe('leading thinking block parser', () => {
  it('handles every split boundary without displaying tags in the answer', () => {
    const value = '<think>계획을 확인합니다.</think>답변입니다.';
    for (let split = 0; split <= value.length; split++) {
      const parser = new ThinkingSplitter();
      const output = [
        ...parser.push(value.slice(0, split)),
        ...parser.push(value.slice(split)),
        ...parser.finish(),
      ];
      expect(
        output
          .filter((p) => p.thinking)
          .map((p) => p.text)
          .join(''),
      ).toBe('계획을 확인합니다.');
      expect(
        output
          .filter((p) => !p.thinking)
          .map((p) => p.text)
          .join(''),
      ).toBe('답변입니다.');
    }
  });
  it('preserves literal tags inside an ordinary explanation or code', () => {
    const parser = new ThinkingSplitter();
    expect(parser.push('Example: `<think>x</think>`')).toEqual([
      { thinking: false, text: 'Example: `<think>x</think>`' },
    ]);
  });
  it('bounds whitespace prefix buffering and retains unclosed thoughts as thinking', () => {
    const plain = new ThinkingSplitter();
    expect(plain.push(' '.repeat(200))[0]?.text).toHaveLength(200);
    const thinking = new ThinkingSplitter();
    expect(
      [...thinking.push('<think>partial'), ...thinking.finish()].every((p) => p.thinking),
    ).toBe(true);
  });
});
