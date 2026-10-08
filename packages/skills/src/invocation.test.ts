import { describe, expect, it } from 'vitest';
import { expandSkillBody, resolveSkillInvocation, skillArguments } from './invocation';
import type { RegisteredSkill } from './types';

const skill = (name: string, id = 'selected-id') => ({ name, id }) as RegisteredSkill;

describe('literal skill invocation', () => {
  it('separates quoted arguments without evaluating shell or environment syntax', () => {
    expect(skillArguments('one "two words" \'three words\' "" $HOME $(touch-file)')).toEqual([
      'one',
      'two words',
      'three words',
      '',
      '$HOME',
      '$(touch-file)',
    ]);
    expect(skillArguments('"a\\\"b" "C:\\source\\path"')).toEqual(['a"b', 'C:\\source\\path']);
    expect(() => skillArguments('"unfinished')).toThrow('따옴표');
  });

  it('expands zero-based arguments and both directory names in one literal pass', () => {
    expect(
      expandSkillBody(
        '$0|$ARGUMENTS[1]|$ARGUMENTS|${CLAUDE_SKILL_DIR}|{baseDir}',
        'first "$ARGUMENTS"',
        'C:\\skills\\sample',
      ),
    ).toBe('first|$ARGUMENTS|first "$ARGUMENTS"|C:\\skills\\sample|C:\\skills\\sample');
    expect(expandSkillBody('$9 ${CLAUDE_SESSION_ID}', 'hello', '/skills')).toBe(
      '$9 ${CLAUDE_SESSION_ID}\n\nARGUMENTS: hello',
    );
    expect(expandSkillBody('Instructions', '', '/skills')).toBe('Instructions');
  });

  it('resolves selected names or explicit IDs, retaining complete argument text', () => {
    const selected = skill('review');
    expect(resolveSkillInvocation('/REVIEW "a b"\nmore', [selected])).toEqual({
      skill: selected,
      argumentsText: '"a b"\nmore',
    });
    expect(resolveSkillInvocation('/skill selected-id foo', [selected])?.argumentsText).toBe('foo');
    expect(resolveSkillInvocation('/skill review foo', [selected])?.skill).toBe(selected);
    expect(resolveSkillInvocation('/tmp/source', [selected])).toBeNull();
    expect(resolveSkillInvocation('/unselected', [selected])).toBeNull();
    expect(() => resolveSkillInvocation('/skill missing', [selected])).toThrow('선택한 스킬');
    expect(() => resolveSkillInvocation('/skill', [selected])).toThrow('사용법');
  });

  it('rejects ambiguous names while allowing an explicit unique ID', () => {
    const skills = [skill('review', 'one'), skill('review', 'two')];
    expect(() => resolveSkillInvocation('/review', skills)).toThrow('같은 이름');
    expect(resolveSkillInvocation('/skill two', skills)?.skill.id).toBe('two');
  });
});
