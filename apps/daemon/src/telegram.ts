import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AppError,
  commandSchema,
  makeCommand,
  autopilotLimitsSchema,
  planSchema,
  telegramConfigSchema,
  type Command,
  type CommandResult,
  type ApprovalAction,
  type ElicitationAction,
  type Activity,
  type Session,
  type TelegramConfig,
  type TelegramPeer,
  type TelegramStatus,
  type SecretSource,
} from '@lodex/contracts';
import type { Store } from '@lodex/storage';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const peerSchema = z.object({
  id: z.number().int().positive().safe(),
  is_bot: z.literal(false),
  first_name: z.string().max(256).optional(),
});
const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z
    .object({
      date: z.number().int().nonnegative(),
      text: z.string().max(16000),
      from: peerSchema,
      chat: z.object({ id: z.number().int().positive().safe(), type: z.literal('private') }),
    })
    .optional(),
});
type Inbox = {
  id: number;
  epoch: number;
  date: number;
  text: string;
  sessionId?: string | null;
  status: 'queued' | 'prepared' | 'waiting' | 'done';
  command?: Command;
  run?: { id: string; messageId: string; sessionId: string };
};
type Outbox = {
  id: string;
  epoch: number;
  chatId: number;
  text: string;
  sessionId?: string | null;
  status: 'queued' | 'sending' | 'sent' | 'unknown' | 'failed';
  retryAt: number;
};
interface Journal {
  config: TelegramConfig;
  epoch: number;
  offset: number;
  enabledAt: number;
  bot?: { id: number; username: string };
  owner?: TelegramPeer;
  candidate?: TelegramPeer;
  pairing?: { hash: string; expiresAt: number };
  inbox: Inbox[];
  outbox: Outbox[];
  unknownDeliveries: number;
  notifiedApprovalId?: string;
  notifiedElicitationId?: string;
}
type Options = {
  store: Store;
  loadToken: () => Promise<string | null>;
  tokenSource?: () => SecretSource;
  dispatch: (command: Command) => Promise<CommandResult>;
  decideApproval: (action: ApprovalAction) => Promise<Session>;
  decideElicitation: (action: ElicitationAction) => Promise<Session>;
  fetch?: typeof fetch;
};
class BotError extends AppError {
  constructor(
    message: string,
    readonly definite = false,
    readonly retryAfter = 0,
  ) {
    super('TELEGRAM_API', message, 502);
  }
}
export class Telegram {
  private state: Journal = {
    config: { enabled: false, sessionId: null, allowBuild: false, transmissionConsent: false },
    epoch: 0,
    offset: 0,
    enabledAt: 0,
    inbox: [],
    outbox: [],
    unknownDeliveries: 0,
  };
  private version = 0;
  private closed = false;
  private token: string | null = null;
  private error: string | undefined;
  private abort: AbortController | undefined;
  private pollAbort: AbortController | undefined;
  private wakePending = false;
  private task: Promise<void> | undefined;
  private operations: Promise<unknown> = Promise.resolve();
  private constructor(private options: Options) {}
  static async open(options: Options) {
    const channel = new Telegram(options),
      saved = await options.store.integration('telegram');
    if (saved) {
      channel.version = saved.version;
      channel.state = saved.document as Journal;
      telegramConfigSchema.parse(channel.state.config);
    }
    let changed = false;
    for (const item of channel.state.outbox)
      if (item.status === 'sending') {
        item.status = 'unknown';
        channel.state.unknownDeliveries++;
        changed = true;
      }
    delete channel.state.pairing;
    delete channel.state.candidate;
    if (changed || saved) await channel.save();
    try {
      channel.token = await options.loadToken();
    } catch {
      channel.error = 'TELEGRAM_BOT_TOKEN 설정을 확인하세요.';
    }
    if (channel.state.config.enabled && channel.token) channel.start();
    return channel;
  }
  status(): TelegramStatus {
    return {
      configured: !!this.token,
      tokenSource: this.options.tokenSource?.() ?? (this.token ? 'os_keychain' : 'none'),
      config: structuredClone(this.state.config),
      ...(this.state.bot ? { bot: this.state.bot } : {}),
      ...(this.state.owner ? { owner: this.state.owner } : {}),
      ...(this.state.candidate ? { candidate: this.state.candidate } : {}),
      ...(this.state.pairing ? { pairingExpiresAt: this.state.pairing.expiresAt } : {}),
      running: !!this.abort && !this.abort.signal.aborted,
      ...(this.error ? { error: this.error } : {}),
      pending: this.state.inbox.filter((item) => item.status !== 'done').length,
      unknownDeliveries: this.state.unknownDeliveries,
    };
  }
  private async save() {
    const active = this.state.inbox.filter((item) => item.status !== 'done'),
      done = this.state.inbox.filter((item) => item.status === 'done').slice(-64);
    this.state.inbox = [...done, ...active].sort((a, b) => a.id - b.id);
    this.state.outbox = [
      ...this.state.outbox
        .filter((item) => !['queued', 'sending'].includes(item.status))
        .slice(-64),
      ...this.state.outbox.filter((item) => ['queued', 'sending'].includes(item.status)),
    ];
    this.version = await this.options.store.saveIntegration('telegram', this.version, this.state);
  }
  private operate<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new AppError('TELEGRAM_CLOSED', 'Telegram 연결을 종료하는 중입니다.'));
    const task = this.operations.then(async () => {
      await this.stop();
      const before = structuredClone(this.state);
      try {
        return await work();
      } catch (error) {
        await this.stop();
        try {
          const saved = await this.options.store.integration('telegram');
          this.state = saved ? (saved.document as Journal) : before;
          this.version = saved?.version ?? 0;
          if (this.state.config.enabled && this.token) this.start();
        } catch {
          this.error = '저장된 Telegram 상태를 불러오지 못해 연결을 멈췄습니다.';
        }
        throw error;
      }
    });
    this.operations = task.catch(() => undefined);
    return task;
  }
  async configure(config: TelegramConfig) {
    return this.operate(async () => {
      config = telegramConfigSchema.parse(config);
      if (config.enabled) {
        await this.options.store.session(config.sessionId!);
        this.token = await this.options.loadToken();
        if (!this.token)
          throw new AppError('TELEGRAM_TOKEN', '먼저 Telegram 봇 토큰을 저장하세요.');
        const bot = await this.identity(AbortSignal.timeout(15000));
        if (this.state.bot && this.state.bot.id !== bot.id && this.state.owner)
          throw new AppError(
            'TELEGRAM_BOT',
            '봇이 변경되었습니다. 먼저 연결 해제 후 새 봇을 등록하세요.',
          );
        if (this.state.bot?.id !== bot.id) {
          this.state.offset = 0;
          this.state.inbox = [];
          this.state.outbox = [];
        }
        this.state.bot = bot;
      }
      this.state.config = config;
      this.state.epoch++;
      this.state.enabledAt = Math.floor(Date.now() / 1000);
      delete this.state.pairing;
      delete this.state.candidate;
      for (const item of this.state.inbox) if (item.status !== 'waiting') item.status = 'done';
      for (const item of this.state.outbox) if (item.status === 'queued') item.status = 'failed';
      await this.save();
      this.error = undefined;
      if (config.enabled) this.start();
      return this.status();
    });
  }
  async setToken(token: string | null) {
    return this.operate(async () => {
      const previous = this.token;
      this.token = token;
      try {
        if (!token) {
          this.state.config.enabled = false;
          this.state.epoch++;
          delete this.state.pairing;
          delete this.state.candidate;
          await this.save();
        } else if (this.state.config.enabled) {
          const bot = await this.identity(AbortSignal.timeout(15000));
          if (this.state.bot && this.state.bot.id !== bot.id && this.state.owner)
            throw new AppError('TELEGRAM_BOT', '봇이 변경되었습니다. 먼저 계정 연결을 해제하세요.');
          this.state.bot = bot;
          this.start();
        }
        this.error = undefined;
        return this.status();
      } catch (error) {
        this.token = previous;
        throw error;
      }
    });
  }
  async pair() {
    return this.operate(async () => {
      if (!this.state.config.enabled || this.state.owner)
        throw new AppError('TELEGRAM_PAIR', '연결을 켜고 기존 계정 연결을 해제하세요.');
      const code = randomBytes(8).toString('hex').toUpperCase(),
        expiresAt = Date.now() + 300000;
      this.state.pairing = { hash: hash(code), expiresAt };
      delete this.state.candidate;
      await this.save();
      this.start();
      return { code, expiresAt };
    });
  }
  async approve(userId: number, chatId: number) {
    return this.operate(async () => {
      const candidate = this.state.candidate;
      if (
        !candidate ||
        candidate.userId !== userId ||
        candidate.chatId !== chatId ||
        !this.state.pairing ||
        this.state.pairing.expiresAt < Date.now()
      )
        throw new AppError('TELEGRAM_PAIR', '연결 요청이 만료되었거나 변경되었습니다.');
      this.state.owner = candidate;
      delete this.state.candidate;
      delete this.state.pairing;
      this.state.epoch++;
      this.state.enabledAt = Math.floor(Date.now() / 1000);
      this.enqueue('연결되었습니다. /help 로 명령을 확인하세요.');
      await this.save();
      this.start();
      return this.status();
    });
  }
  async unpair() {
    return this.operate(async () => {
      this.state.config.enabled = false;
      this.state.epoch++;
      delete this.state.owner;
      delete this.state.candidate;
      delete this.state.pairing;
      for (const item of this.state.inbox) item.status = 'done';
      for (const item of this.state.outbox) if (item.status === 'queued') item.status = 'failed';
      await this.save();
      return this.status();
    });
  }
  private enqueue(text: string) {
    if (!this.state.owner) return;
    if (this.state.outbox.filter((item) => item.status === 'queued').length >= 64)
      throw new AppError('TELEGRAM_QUEUE', 'Telegram 발신 대기 한도에 도달했습니다.');
    // Plain text only: model text cannot create Telegram markup or trigger URL previews.
    const full = this.token ? text.replaceAll(this.token, '[redacted]') : text;
    let clean = full;
    if (full.length > 3500) {
      clean =
        full.slice(0, 3400).replace(/[\uD800-\uDBFF]$/, '') +
        '\n[일부 생략 · 전체 내용은 Lodex에서 확인]';
    }
    this.state.outbox.push({
      id: crypto.randomUUID(),
      epoch: this.state.epoch,
      chatId: this.state.owner.chatId,
      sessionId: this.state.config.sessionId,
      text: clean,
      status: 'queued',
      retryAt: 0,
    });
  }
  private async api(
    method: 'getMe' | 'getUpdates' | 'sendMessage',
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.token) throw new BotError('봇 토큰이 없습니다.', true);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        'https://api.telegram.org/bot' + this.token + '/' + method,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        },
      );
    } catch {
      throw new BotError('Telegram 연결 결과를 확인하지 못했습니다.');
    }
    let data: any;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > 524288) throw new Error();
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new BotError('Telegram 응답을 확인하지 못했습니다.');
    }
    if (!response.ok || data?.ok !== true) {
      const retry = Number(data?.parameters?.retry_after);
      if (response.status === 429 && data?.ok === false && Number.isFinite(retry) && retry > 0)
        throw new BotError('Telegram 요청 제한입니다.', true, Math.min(retry, 86400));
      throw new BotError(
        'Telegram 요청 실패 (HTTP ' + response.status + ').',
        data?.ok === false && response.status >= 400 && response.status < 500,
      );
    }
    return data.result;
  }
  private async identity(signal: AbortSignal) {
    const data = z
      .object({
        id: z.number().int().positive().safe(),
        is_bot: z.literal(true),
        username: z.string().min(1).max(100),
      })
      .safeParse(await this.api('getMe', {}, signal));
    if (!data.success) throw new BotError('봇 계정 응답이 올바르지 않습니다.', true);
    return { id: data.data.id, username: data.data.username };
  }
  private start() {
    if (this.closed) return;
    const abort = new AbortController();
    this.abort = abort;
    this.task = this.loop(abort.signal).catch((error) => {
      if (!abort.signal.aborted)
        this.error = error instanceof AppError ? error.message : 'Telegram 처리가 중단되었습니다.';
      abort.abort();
    });
  }
  /** Interrupt only the current long poll so completed model output is processed immediately. */
  wake() {
    this.wakePending = true;
    this.pollAbort?.abort();
  }
  private async stop() {
    this.abort?.abort();
    await this.task;
    this.abort = undefined;
    this.task = undefined;
  }
  async close() {
    this.closed = true;
    await this.operations;
    await this.stop();
  }
  async withPaused<T>(work: () => Promise<T>): Promise<T> {
    return this.operate(async () => {
      try {
        return await work();
      } finally {
        const saved = await this.options.store.integration('telegram');
        if (saved) {
          this.version = saved.version;
          this.state = saved.document as Journal;
        }
        if (this.state.config.enabled && this.token) this.start();
      }
    });
  }
  private async loop(signal: AbortSignal) {
    const bot = await this.identity(signal);
    if (bot.id !== this.state.bot?.id)
      throw new AppError('TELEGRAM_BOT', '저장된 봇과 현재 토큰의 계정이 다릅니다.');
    let failures = 0;
    while (!signal.aborted) {
      const cycleStarted = Date.now();
      await this.process(signal);
      await this.deliver(signal);
      signal.throwIfAborted();
      if (this.wakePending) {
        this.wakePending = false;
        continue;
      }
      let updates: unknown;
      const pollAbort = new AbortController();
      this.pollAbort = pollAbort;
      try {
        updates = await this.api(
          'getUpdates',
          { offset: this.state.offset, limit: 50, timeout: 10, allowed_updates: ['message'] },
          AbortSignal.any([signal, pollAbort.signal]),
        );
        failures = 0;
        this.error = undefined;
      } catch (error) {
        if (signal.aborted) return;
        if (pollAbort.signal.aborted) {
          this.wakePending = false;
          continue;
        }
        this.error = error instanceof AppError ? error.message : 'Telegram 수신 실패';
        if (error instanceof BotError && error.definite && !error.retryAfter) throw error;
        await delay(
          error instanceof BotError && error.retryAfter
            ? error.retryAfter * 1000
            : Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)),
          undefined,
          { signal },
        ).catch(() => undefined);
        continue;
      } finally {
        if (this.pollAbort === pollAbort) this.pollAbort = undefined;
      }
      signal.throwIfAborted();
      if (!Array.isArray(updates) || updates.length > 100)
        throw new AppError('TELEGRAM_FORMAT', 'Telegram 업데이트 형식이 올바르지 않습니다.');
      for (const raw of updates) {
        const id = z.object({ update_id: z.number().int().nonnegative().safe() }).safeParse(raw);
        if (!id.success)
          throw new AppError('TELEGRAM_FORMAT', 'Telegram 업데이트 ID가 올바르지 않습니다.');
        if (id.data.update_id < this.state.offset) continue;
        this.state.offset = id.data.update_id + 1;
        const parsed = updateSchema.safeParse(raw);
        if (!parsed.success || !parsed.data.message) continue;
        const message = parsed.data.message;
        if (
          message.chat.id !== message.from.id ||
          message.date < this.state.enabledAt ||
          message.date < Math.floor(Date.now() / 1000) - 300 ||
          message.date > Math.floor(Date.now() / 1000) + 30
        )
          continue;
        if (!this.state.owner) {
          const code = message.text.match(/^\/pair\s+([A-Fa-f0-9]{16})$/)?.[1]?.toUpperCase();
          if (
            code &&
            !this.state.candidate &&
            this.state.pairing &&
            this.state.pairing.expiresAt > Date.now() &&
            hash(code) === this.state.pairing.hash
          )
            this.state.candidate = {
              userId: message.from.id,
              chatId: message.chat.id,
              name: message.from.first_name ?? '',
            };
          continue;
        }
        if (
          message.from.id !== this.state.owner.userId ||
          message.chat.id !== this.state.owner.chatId
        )
          continue;
        if (this.state.inbox.some((item) => item.id === id.data.update_id)) continue;
        if (message.text.length > 4000) {
          this.enqueue('요청은 4,000자 이하로 보내세요. 일부만 실행하지 않았습니다.');
          continue;
        }
        if (this.state.inbox.filter((item) => item.status !== 'done').length >= 64) {
          this.enqueue('대기 중인 요청이 많습니다. 잠시 후 다시 요청하세요.');
          continue;
        }
        this.state.inbox.push({
          id: id.data.update_id,
          epoch: this.state.epoch,
          sessionId: this.state.config.sessionId,
          date: message.date,
          text: message.text,
          status: 'queued',
        });
      }
      await this.save(); // Advance offset only after accepted updates and cursor are durable.
      if (Date.now() - cycleStarted < 250)
        await delay(250 - (Date.now() - cycleStarted), undefined, { signal }).catch(
          () => undefined,
        );
    }
  }
  private async process(signal: AbortSignal) {
    await this.notifyPendingApproval();
    await this.notifyPendingElicitation();
    for (const item of this.state.inbox) {
      signal.throwIfAborted();
      if (item.status === 'done') continue;
      if (item.epoch !== this.state.epoch || !this.state.owner) {
        item.status = 'done';
        await this.save();
        continue;
      }
      if (item.status === 'waiting' && item.run) {
        let session;
        try {
          session = await this.options.store.session(item.run.sessionId);
        } catch {
          item.status = 'done';
          await this.save();
          continue;
        }
        const message = session.messages.find((message) => message.id === item.run!.messageId);
        if (message?.status === 'streaming') continue;
        this.enqueue(
          message
            ? '[' +
                message.status +
                ']\n' +
                (message.content || '') +
                (message.error ? '\n' + message.error : '')
            : '대화가 변경되어 결과를 찾지 못했습니다.',
        );
        item.status = 'done';
        await this.save();
        continue;
      }
      try {
        if (!this.state.config.sessionId)
          throw new AppError('TELEGRAM_SCOPE', '연결한 대화가 없습니다.');
        const session = await this.options.store.session(this.state.config.sessionId);
        if (!item.command) {
          if (item.date < Math.floor(Date.now() / 1000) - 300)
            throw new AppError('TELEGRAM_EXPIRED', '요청이 만료되었습니다. 다시 보내세요.');
          const text = item.text.trim();
          if (text === '/approve' || text === '/deny') {
            if (!this.state.config.allowBuild)
              throw new AppError(
                'TELEGRAM_BUILD',
                'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
              );
            const approval = this.pendingApproval(session);
            if (!approval)
              throw new AppError('TELEGRAM_APPROVAL', '대기 중인 승인 요청이 없습니다.');
            await this.options.decideApproval({
              sessionId: session.id,
              expectedVersion: session.version,
              activityId: approval.id,
              action: text === '/approve' ? 'approve' : 'reject',
            });
            item.status = 'done';
            this.enqueue(text === '/approve' ? '승인했습니다.' : '거절했습니다.');
            await this.save();
            continue;
          }
          if (text === '/decline' || text === '/cancel-input' || text.startsWith('/answer ')) {
            if (!this.state.config.allowBuild)
              throw new AppError(
                'TELEGRAM_BUILD',
                'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
              );
            const elicitation = this.pendingElicitation(session);
            if (!elicitation)
              throw new AppError('TELEGRAM_ELICITATION', '대기 중인 MCP 입력 요청이 없습니다.');
            let action: ElicitationAction['action'] =
              text === '/decline' ? 'decline' : text === '/cancel-input' ? 'cancel' : 'accept';
            let content: Record<string, string | number | boolean | string[]> | undefined;
            if (action === 'accept') {
              try {
                const parsed: unknown = JSON.parse(text.slice('/answer '.length));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                  throw new Error();
                content = parsed as Record<string, string | number | boolean | string[]>;
              } catch {
                throw new AppError('TELEGRAM_ELICITATION', '사용법: /answer {"필드":"값"}');
              }
            }
            await this.options.decideElicitation({
              sessionId: session.id,
              expectedVersion: session.version,
              activityId: elicitation.id,
              action,
              ...(content ? { content } : {}),
            });
            if (action === 'accept') item.text = '/answer [redacted]';
            item.status = 'done';
            this.enqueue(
              action === 'accept'
                ? 'MCP 입력을 제출했습니다.'
                : action === 'decline'
                  ? 'MCP 입력을 거절했습니다.'
                  : 'MCP 입력을 취소했습니다.',
            );
            await this.save();
            continue;
          }
          if (text === '/status') {
            const approval = this.pendingApproval(session);
            const elicitation = this.pendingElicitation(session);
            this.enqueue(
              session.title +
                '\n' +
                (session.run?.status ?? 'idle') +
                (approval ? '\n승인 대기: ' + this.approvalSummary(approval) : '') +
                (elicitation ? '\nMCP 입력 대기: ' + elicitation.elicitation!.message : '') +
                '\n' +
                (session.messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? ''),
            );
            item.status = 'done';
            await this.save();
            continue;
          }
          if (text === '/plan') {
            this.enqueue(
              (session.plan.goal || '저장된 목표 없음') +
                '\n' +
                (session.plan.tasks.length
                  ? session.plan.tasks
                      .map(
                        (task, index) => `${index + 1}. ${task.done ? '[x]' : '[ ]'} ${task.title}`,
                      )
                      .join('\n')
                  : '저장된 할 일 없음'),
            );
            item.status = 'done';
            await this.save();
            continue;
          }
          if (text === '/todo') {
            this.enqueue(
              session.plan.tasks.length
                ? session.plan.tasks
                    .map(
                      (task, index) => `${index + 1}. ${task.done ? '[x]' : '[ ]'} ${task.title}`,
                    )
                    .join('\n')
                : '저장된 할 일이 없습니다.',
            );
            item.status = 'done';
            await this.save();
            continue;
          }
          if (text === '/help' || text === '/start') {
            this.enqueue(
              '/ask 메시지 — 연결한 대화에 요청\n/goal 목표 — 독립 목표 실행\n/resume — 중단된 /goal 계속\n/run — 저장 계획 자동 실행\n/plan · /todo — 목표와 할 일 조회\n/todo goal 목표 | 완료 기준\n/todo add 할 일 | 완료 기준\n/todo done 번호 · /todo undo 번호 · /todo remove 번호\n/autopilot ask|auto|full — 승인 단계 변경\n/approve · /deny — 대기 작업 결정\n/answer JSON · /decline · /cancel-input — MCP 입력 결정\n/stop — 현재 실행 중지\n일반 텍스트도 요청으로 전달됩니다. 원격 Build와 권한 변경은 Telegram 설정에서 허용해야 합니다.',
            );
            item.status = 'done';
            await this.save();
            continue;
          }
          let command: Command;
          if (text === '/stop') {
            if (session.run?.status !== 'running')
              throw new AppError('TELEGRAM_IDLE', '진행 중인 실행이 없습니다.');
            command = makeCommand({
              type: 'cancel_run',
              sessionId: session.id,
              runId: session.run.id,
            });
          } else if (text.startsWith('/goal ')) {
            if (!this.state.config.allowBuild && session.permissionMode !== 'full')
              throw new AppError(
                'TELEGRAM_BUILD',
                'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
              );
            command = makeCommand({
              type: 'start_goal',
              sessionId: session.id,
              expectedVersion: session.version,
              goal: text.slice(6).trim(),
              limits: autopilotLimitsSchema.parse({}),
            });
          } else if (text === '/resume') {
            if (!this.state.config.allowBuild && session.permissionMode !== 'full')
              throw new AppError(
                'TELEGRAM_BUILD',
                'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
              );
            command = makeCommand({
              type: 'resume_goal',
              sessionId: session.id,
              expectedVersion: session.version,
            });
          } else if (text === '/run') {
            if (!this.state.config.allowBuild && session.permissionMode !== 'full')
              throw new AppError(
                'TELEGRAM_BUILD',
                'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
              );
            command = makeCommand({
              type: 'start_autopilot',
              sessionId: session.id,
              expectedVersion: session.version,
              taskIds: [],
              limits: autopilotLimitsSchema.parse({}),
            });
          } else if (/^\/autopilot\s+/.test(text)) {
            if (!this.state.config.allowBuild)
              throw new AppError(
                'TELEGRAM_BUILD',
                'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
              );
            const mode = text.slice('/autopilot '.length).trim();
            if (!['ask', 'auto', 'full'].includes(mode))
              throw new AppError('TELEGRAM_COMMAND', '사용법: /autopilot ask|auto|full');
            command = makeCommand({
              type: 'set_permission_mode',
              sessionId: session.id,
              expectedVersion: session.version,
              mode: mode as 'ask' | 'auto' | 'full',
            });
          } else if (/^\/todo\s+/.test(text)) {
            const [operation, ...argumentParts] = text.slice('/todo '.length).trim().split(/\s+/);
            const argument = argumentParts.join(' ').trim();
            let plan = structuredClone(session.plan);
            if (operation === 'goal') {
              const [goal, criteria = ''] = argument.split(/\s+\|\s+/, 2);
              if (!goal?.trim())
                throw new AppError('TELEGRAM_COMMAND', '사용법: /todo goal 목표 | 완료 기준');
              plan = {
                ...plan,
                goal: goal.trim(),
                criteria: criteria.trim(),
                includeInContext: true,
              };
            } else if (operation === 'add') {
              const [title, criteria = ''] = argument.split(/\s+\|\s+/, 2);
              if (!title?.trim())
                throw new AppError('TELEGRAM_COMMAND', '사용법: /todo add 할 일 | 완료 기준');
              plan.tasks.push({
                id: crypto.randomUUID(),
                title: title.trim(),
                done: false,
                ...(criteria.trim() ? { criteria: criteria.trim() } : {}),
              });
            } else if (['done', 'undo', 'remove'].includes(operation ?? '')) {
              if (!/^\d+$/.test(argument))
                throw new AppError('TELEGRAM_COMMAND', `사용법: /todo ${operation} 번호`);
              const index = Number(argument) - 1;
              const target = plan.tasks[index];
              if (!target) throw new AppError('TASK_NOT_FOUND', '해당 번호의 할 일이 없습니다.');
              if (operation === 'remove') {
                plan.tasks.splice(index, 1);
                plan.tasks = plan.tasks.map((task) => ({
                  ...task,
                  ...(task.dependsOn
                    ? { dependsOn: task.dependsOn.filter((id) => id !== target.id) }
                    : {}),
                }));
              } else target.done = operation === 'done';
            } else {
              throw new AppError('TELEGRAM_COMMAND', '사용법: /todo goal|add|done|undo|remove');
            }
            command = makeCommand({
              type: 'save_plan',
              sessionId: session.id,
              expectedVersion: session.version,
              plan: planSchema.parse(plan),
            });
          } else {
            if (text.startsWith('/') && !text.startsWith('/ask '))
              throw new AppError(
                'TELEGRAM_COMMAND',
                '지원하지 않는 명령입니다. /help 를 확인하세요.',
              );
            if (
              session.mode !== 'plan' &&
              !this.state.config.allowBuild &&
              session.permissionMode !== 'full'
            )
              throw new AppError(
                'TELEGRAM_BUILD',
                'Build 원격 요청은 데스크톱에서 허용해야 합니다.',
              );
            command = makeCommand({
              type: 'send_message',
              sessionId: session.id,
              expectedVersion: session.version,
              content: text.startsWith('/ask ') ? text.slice(5).trim() : text,
            });
          }
          item.command = commandSchema.parse({ ...command, actor: 'telegram' });
          item.status = 'prepared';
          await this.save();
        }
        signal.throwIfAborted();
        if (
          item.date < Math.floor(Date.now() / 1000) - 300 &&
          !(await this.options.store.receipt(item.command))
        )
          throw new AppError('TELEGRAM_EXPIRED', '실행 전 요청이 만료되었습니다. 다시 보내세요.');
        const result = await this.options.dispatch(item.command);
        if (
          ['send_message', 'start_goal', 'resume_goal', 'start_autopilot'].includes(
            item.command.type,
          ) &&
          result.session.run
        ) {
          item.run = {
            id: result.session.run.id,
            messageId: result.session.run.messageId,
            sessionId: result.session.id,
          };
          item.status = 'waiting';
          this.enqueue(
            item.command.type === 'start_goal' || item.command.type === 'resume_goal'
              ? '목표 실행을 시작했습니다. /status · /stop'
              : item.command.type === 'start_autopilot'
                ? '저장 계획 실행을 시작했습니다. /status · /stop'
                : '요청을 접수했습니다. /status · /stop',
          );
        } else {
          item.status = 'done';
          this.enqueue(
            item.command.type === 'save_plan'
              ? '목표와 할 일을 저장했습니다.'
              : item.command.type === 'set_permission_mode'
                ? 'Autopilot 권한을 변경했습니다: ' + item.command.mode
                : '중지 요청을 처리했습니다.',
          );
        }
        await this.save();
      } catch (error) {
        if (signal.aborted) throw error;
        if (
          error instanceof AppError &&
          ['STORAGE_EXIT', 'STORAGE_ERROR', 'INTEGRATION_STATE'].includes(error.code)
        )
          throw error;
        this.enqueue(error instanceof AppError ? error.message : '요청 처리에 실패했습니다.');
        item.status = 'done';
        await this.save();
      }
    }
  }
  private pendingApproval(session: Session): Activity | undefined {
    return session.messages
      .flatMap((message) => message.activities ?? [])
      .findLast((activity) => activity.approval?.status === 'pending');
  }
  private pendingElicitation(session: Session): Activity | undefined {
    return session.messages
      .flatMap((message) => message.activities ?? [])
      .findLast((activity) => activity.elicitation?.status === 'pending');
  }
  private approvalSummary(activity: Activity) {
    const approval = activity.approval!;
    return approval.kind + ' · ' + approval.target + '\n사유: ' + approval.reason;
  }
  private async notifyPendingApproval() {
    if (
      !this.state.owner ||
      !this.state.config.transmissionConsent ||
      !this.state.config.allowBuild ||
      !this.state.config.sessionId
    )
      return;
    let session: Session;
    try {
      session = await this.options.store.session(this.state.config.sessionId);
    } catch {
      return;
    }
    const approval = this.pendingApproval(session);
    if (!approval || approval.id === this.state.notifiedApprovalId) return;
    this.enqueue(
      '승인이 필요합니다.\n' +
        this.approvalSummary(approval) +
        '\n/approve 또는 /deny 로 결정하세요.',
    );
    this.state.notifiedApprovalId = approval.id;
    await this.save();
  }
  private async notifyPendingElicitation() {
    if (
      !this.state.owner ||
      !this.state.config.transmissionConsent ||
      !this.state.config.allowBuild ||
      !this.state.config.sessionId
    )
      return;
    let session: Session;
    try {
      session = await this.options.store.session(this.state.config.sessionId);
    } catch {
      return;
    }
    const activity = this.pendingElicitation(session);
    if (!activity || activity.id === this.state.notifiedElicitationId) return;
    const elicitation = activity.elicitation!;
    const details =
      elicitation.mode === 'url'
        ? `\n링크: ${elicitation.url}\n완료 후 /answer {}`
        : `\n필드: ${(elicitation.fields ?? [])
            .map((field) => `${field.name}${field.required ? '*' : ''}(${field.type})`)
            .join(', ')}\n/answer {"필드":"값"}`;
    this.enqueue(
      `MCP 사용자 입력이 필요합니다.\n${elicitation.message}${details}\n/decline 또는 /cancel-input`,
    );
    this.state.notifiedElicitationId = activity.id;
    await this.save();
  }
  private async deliver(signal: AbortSignal) {
    for (const item of this.state.outbox) {
      signal.throwIfAborted();
      if (item.status !== 'queued' || item.retryAt > Date.now()) continue;
      if (item.epoch !== this.state.epoch || item.chatId !== this.state.owner?.chatId) {
        item.status = 'failed';
        await this.save();
        continue;
      }
      item.status = 'sending';
      await this.save();
      try {
        const response = await this.api(
          'sendMessage',
          {
            chat_id: item.chatId,
            text: item.text || '내용 없음',
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
        const sent = z
          .object({
            message_id: z.number().int().positive().safe(),
            chat: z.object({ id: z.literal(item.chatId) }),
          })
          .safeParse(response);
        if (!sent.success) throw new BotError('Telegram 전달 확인 형식이 올바르지 않습니다.');
        item.status = 'sent';
      } catch (error) {
        if (error instanceof BotError && error.retryAfter) {
          item.status = 'queued';
          item.retryAt = Date.now() + error.retryAfter * 1000;
        } else if (error instanceof BotError && error.definite) item.status = 'failed';
        else {
          item.status = 'unknown';
          this.state.unknownDeliveries++;
        }
        this.error =
          'Telegram 전달 결과를 확인하세요. 결과 미확인 메시지는 자동 재전송하지 않습니다.';
      }
      await this.save();
      // One outgoing message per loop prevents a burst of generated replies.
      break;
    }
  }
}
