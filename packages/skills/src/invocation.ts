import { AppError } from '@lodex/contracts';
import type { RegisteredSkill } from './types';

// This parser only separates text. It never expands environment variables or executes a shell.
export function skillArguments(text: string): string[] {
  const result: string[] = [];
  let value = '',
    quote = '',
    active = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && ['"', '\\'].includes(text[index + 1] ?? ''))
        value += text[++index];
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) result.push(value);
      value = '';
      active = false;
    } else {
      value += char;
      active = true;
    }
  }
  if (quote) throw new AppError('SKILL_ARGUMENTS', '스킬 인자의 따옴표를 닫아 주세요.');
  if (active) result.push(value);
  return result;
}

export function expandSkillBody(body: string, argumentsText: string, directory: string) {
  const args = skillArguments(argumentsText);
  let received = false;
  const expanded = body.replace(
    /\$ARGUMENTS(?:\[(\d+)\])?|\$(\d+)\b|\$\{CLAUDE_SKILL_DIR\}|\{baseDir\}/g,
    (placeholder, bracket: string | undefined, short: string | undefined) => {
      if (placeholder === '${CLAUDE_SKILL_DIR}' || placeholder === '{baseDir}') return directory;
      if (bracket === undefined && short === undefined) {
        received = true;
        return argumentsText;
      }
      const value = args[Number(bracket ?? short)];
      if (value === undefined) return placeholder;
      received = true;
      return value;
    },
  );
  return expanded + (!received && argumentsText ? `\n\nARGUMENTS: ${argumentsText}` : '');
}

export function resolveSkillInvocation(text: string, skills: readonly RegisteredSkill[]) {
  const input = text.trim();
  const explicit = /^\/skill(?:\s|$)/i.test(input);
  const match = (
    explicit ? /^\/skill\s+(\S+)(?:\s+([\s\S]*))?$/i : /^\/([^\s/]+)(?:\s+([\s\S]*))?$/
  ).exec(input);
  if (!match) {
    if (explicit) throw new AppError('SKILL_ARGUMENTS', '사용법: /skill 스킬이름 인자');
    return null;
  }
  const name = match[1]!;
  const matches = skills.filter(
    (skill) => skill.name.toLowerCase() === name.toLowerCase() || (explicit && skill.id === name),
  );
  if (!matches.length) {
    if (explicit)
      throw new AppError(
        'SKILL_NOT_SELECTED',
        '선택한 스킬을 찾을 수 없습니다. 설정에서 이 대화에 스킬을 선택하세요.',
      );
    return null;
  }
  if (matches.length !== 1)
    throw new AppError(
      'SKILL_AMBIGUOUS',
      '같은 이름의 스킬이 여러 개입니다. /skill 뒤에 스킬 ID를 입력하세요.',
    );
  return { skill: matches[0]!, argumentsText: match[2] ?? '' };
}
