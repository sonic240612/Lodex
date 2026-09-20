import type { PermissionDecision, PermissionMode } from '@lodex/contracts';

export type PermissionRequest =
  | { kind: 'file'; paths: string[] }
  | { kind: 'command'; command: string; network: 'none' | 'bridge'; environment: 'docker' | 'host' }
  | {
      kind: 'mcp';
      target: string;
      readOnly: boolean;
      destructive: boolean;
      openWorld: boolean;
    };

const secretPath = (path: string) =>
  path
    .replaceAll('\\', '/')
    .split('/')
    .some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        /^(?:\.ssh|\.aws|\.gnupg|secrets?|credentials?)$/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );

const dangerousCommand = (command: string) =>
  /(?:^|[;&|]\s*|\s)(?:rm|rmdir|del|erase|remove-item|format|diskpart|shutdown|reboot|kill|taskkill|chmod|chown|sudo|su)(?:\s|$)/i.test(
    command,
  ) ||
  /\bgit\s+(?:reset\s+--hard|clean\b)/i.test(command) ||
  /\bgit\s+(?:-c\b|checkout\b|restore\b)/i.test(command) ||
  /(?:&&|\|\||[`<>]|\$\(|%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/.test(command) ||
  /(?:^|\s)(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?\s+\/c|(?:ba|z|k)?sh\s+-c|python\d*(?:\.exe)?\s+-c|node(?:\.exe)?\s+-e|perl\s+-e|ruby\s+-e|wscript|cscript|mshta)(?:\s|$)/i.test(
    command,
  ) ||
  /(?:^|\s)(?:\.\.\/|\.\.\\|\/[A-Za-z0-9_.-]|[A-Za-z]:\\)/.test(command) ||
  /(?:\.env(?:\.|\b)|\.ssh\b|\.aws\b|\.gnupg\b|\.(?:pem|key|p12|pfx)\b)/i.test(command);

export function permissionDecision(
  mode: PermissionMode,
  request: PermissionRequest,
  actor: 'desktop' | 'telegram' = 'desktop',
): Omit<PermissionDecision, 'status' | 'requestedAt' | 'decidedAt' | 'decidedBy'> & {
  action: 'allow' | 'prompt';
} {
  if (mode === 'full')
    return {
      kind: request.kind,
      target:
        request.kind === 'file'
          ? request.paths.join(', ')
          : request.kind === 'command'
            ? request.command
            : request.target,
      actor,
      mode,
      risk: 'high',
      reason: '전체 접근에서 사용자가 이 대화의 호스트 작업을 승인했습니다.',
      action: 'allow',
    };

  if (request.kind === 'file') {
    const secret = request.paths.some(secretPath);
    if (mode === 'auto' && !secret)
      return {
        kind: 'file',
        target: request.paths.join(', '),
        actor,
        mode,
        risk: 'low',
        reason: '선택한 프로젝트 안의 일반 텍스트 파일 변경입니다.',
        action: 'allow',
      };
    return {
      kind: 'file',
      target: request.paths.join(', '),
      actor,
      mode,
      risk: secret ? 'high' : 'low',
      reason: secret
        ? '비밀 또는 인증 설정으로 사용될 수 있는 파일을 변경합니다.'
        : '프로젝트 파일을 변경합니다.',
      action: 'prompt',
    };
  }

  if (request.kind === 'command') {
    const high =
      request.environment === 'host' ||
      request.network === 'bridge' ||
      dangerousCommand(request.command);
    if (mode === 'auto' && !high)
      return {
        kind: 'command',
        target: request.command,
        actor,
        mode,
        risk: 'low',
        reason: '외부 네트워크가 없는 Docker 안의 비파괴 명령입니다.',
        action: 'allow',
      };
    return {
      kind: 'command',
      target: request.command,
      actor,
      mode,
      risk: high ? 'high' : 'low',
      reason:
        request.environment === 'host'
          ? '사용자 계정 권한으로 호스트 명령을 실행합니다.'
          : request.network === 'bridge'
            ? 'Docker 명령이 외부 네트워크에 접근할 수 있습니다.'
            : dangerousCommand(request.command)
              ? '삭제·권한 변경·프로젝트 밖 접근 가능성이 있는 명령입니다.'
              : 'Docker 명령을 실행합니다.',
      action: 'prompt',
    };
  }

  const safeRead = request.readOnly && !request.destructive && !request.openWorld;
  if (safeRead)
    return {
      kind: 'mcp',
      target: request.target,
      actor,
      mode,
      risk: 'low',
      reason: 'MCP 서버가 읽기 전용이며 외부 상태를 바꾸지 않는다고 선언했습니다.',
      action: 'allow',
    };
  return {
    kind: 'mcp',
    target: request.target,
    actor,
    mode,
    risk: 'high',
    reason: 'MCP 호출이 외부 상태를 바꾸거나 외부 서비스와 통신할 수 있습니다.',
    action: 'prompt',
  };
}

export function pendingDecision(
  decision: ReturnType<typeof permissionDecision>,
): PermissionDecision {
  const { action: _, ...record } = decision;
  return { ...record, status: 'pending', requestedAt: new Date().toISOString() };
}

export function approvedDecision(
  decision: ReturnType<typeof permissionDecision>,
): PermissionDecision {
  const { action: _, ...record } = decision;
  const now = new Date().toISOString();
  return {
    ...record,
    status: 'approved',
    decidedBy: decision.mode === 'full' ? 'full_access' : 'policy',
    requestedAt: now,
    decidedAt: now,
  };
}
