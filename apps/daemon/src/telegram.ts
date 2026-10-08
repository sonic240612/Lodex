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
import { telegramChunks, telegramReplyChunks } from './telegram-output';
import type { TelegramFormattedChunk } from './telegram-markdown';
import { resolveSkillInvocation } from '@lodex/skills';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isAnswerInput = (text: string) => /^\/answer(?:\s|$)/.test(text.trim());
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
  callback_query: z
    .object({
      id: z.string().min(1).max(256),
      from: peerSchema,
      data: z.string().max(64).optional(),
      message: z
        .object({
          message_id: z.number().int().positive().safe(),
          from: z
            .object({ id: z.number().int().positive().safe(), is_bot: z.boolean() })
            .optional(),
          chat: z.object({ id: z.number().int().safe(), type: z.string().max(32) }),
        })
        .optional(),
    })
    .optional(),
});
type ApprovalKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
type Inbox = {
  id: number;
  epoch: number;
  date: number;
  text: string;
  answerInput?: true;
  sessionId?: string | null;
  status: 'queued' | 'prepared' | 'waiting' | 'done';
  command?: Command;
  run?: { id: string; messageId: string; sessionId: string };
  callback?: {
    id: string;
    outboxId: string;
    messageId: number;
    action: ApprovalAction['action'];
  };
};
type Outbox = TelegramFormattedChunk & {
  id: string;
  groupId?: string;
  epoch: number;
  chatId: number;
  sessionId?: string | null;
  status: 'queued' | 'sending' | 'sent' | 'unknown' | 'failed';
  retryAt: number;
  messageId?: number;
  replyMarkup?: ApprovalKeyboard;
  approval?: { activityId: string; fingerprint: string; resolved?: boolean };
  keyboardCleared?: boolean;
  clearKeyboardAt?: number;
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
  nextSendAt?: number;
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
  reconcileCosts?: (
    sessionId: string,
  ) => Promise<{ reconciled: number; remaining: number; withoutId: number }>;
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
  // Form values must never enter the durable Telegram journal, even before validation.
  private answerInputs = new Map<number, string>();
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
    // Also scrub legacy records on startup/reload. Lost transient inputs require resubmission.
    for (const item of this.state.inbox)
      if (item.answerInput || isAnswerInput(item.text)) {
        item.answerInput = true;
        item.text = '/answer [redacted]';
      }
    const active = this.state.inbox.filter((item) => item.status !== 'done'),
      done = this.state.inbox.filter((item) => item.status === 'done').slice(-64);
    this.state.inbox = [...done, ...active].sort((a, b) => a.id - b.id);
    const retainedInputs = new Set(active.map((item) => item.id));
    for (const id of this.answerInputs.keys())
      if (!retainedInputs.has(id)) this.answerInputs.delete(id);
    const keep = (item: Outbox) =>
      ['queued', 'sending'].includes(item.status) || !!(item.approval && !item.approval.resolved);
    this.state.outbox = [
      ...this.state.outbox.filter((item) => !keep(item)).slice(-64),
      ...this.state.outbox.filter(keep),
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
  private enqueue(output: string | TelegramFormattedChunk[], approval?: Activity) {
    if (!this.state.owner) return;
    const pendingGroups = new Set(
      this.state.outbox
        .filter((item) => item.status === 'queued' || item.status === 'sending')
        .map((item) => item.groupId ?? item.id),
    );
    if (pendingGroups.size >= 64)
      throw new AppError('TELEGRAM_QUEUE', 'Telegram 발신 대기 한도에 도달했습니다.');
    // Persist each complete payload so retries and restarts retain its text/entity offsets.
    const groupId = crypto.randomUUID();
    const parts =
      typeof output === 'string'
        ? telegramChunks(output, this.token).map((text) => ({ text }))
        : output;
    for (const [index, part] of parts.entries()) {
      const id = crypto.randomUUID();
      const buttons = approval && index === parts.length - 1;
      this.state.outbox.push({
        id,
        groupId,
        epoch: this.state.epoch,
        chatId: this.state.owner.chatId,
        sessionId: this.state.config.sessionId,
        ...part,
        status: 'queued',
        retryAt: 0,
        ...(buttons
          ? {
              approval: {
                activityId: approval.id,
                fingerprint: this.approvalFingerprint(approval),
              },
              replyMarkup: {
                inline_keyboard: [
                  [
                    { text: '승인', callback_data: `approval:a:${id}` },
                    { text: '거절', callback_data: `approval:d:${id}` },
                  ],
                ],
              },
            }
          : {}),
      });
    }
  }
  private async api(
    method:
      'getMe' | 'getUpdates' | 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup',
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
      this.answerInputs.clear();
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
    this.answerInputs.clear();
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
      const next = this.state.outbox.find((item) => item.status === 'queued');
      const timeout = next
        ? Math.min(
            10,
            Math.max(
              0,
              Math.floor((Math.max(next.retryAt, this.state.nextSendAt ?? 0) - Date.now()) / 1000),
            ),
          )
        : 10;
      try {
        updates = await this.api(
          'getUpdates',
          {
            offset: this.state.offset,
            limit: 50,
            timeout,
            allowed_updates: ['message', 'callback_query'],
          },
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
        if (!parsed.success) continue;
        if (parsed.data.callback_query) {
          await this.receiveApprovalCallback(id.data.update_id, parsed.data.callback_query, signal);
          continue;
        }
        if (!parsed.data.message) continue;
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
        const answerInput = isAnswerInput(message.text);
        if (answerInput) this.answerInputs.set(id.data.update_id, message.text);
        this.state.inbox.push({
          id: id.data.update_id,
          epoch: this.state.epoch,
          sessionId: this.state.config.sessionId,
          date: message.date,
          text: answerInput ? '/answer [redacted]' : message.text,
          ...(answerInput ? { answerInput: true as const } : {}),
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
    await this.refreshApprovalButtons(signal);
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
      if (item.callback) {
        await this.processApprovalCallback(item, signal);
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
            ? telegramReplyChunks(message, this.token)
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
          const inputText = item.answerInput ? this.answerInputs.get(item.id) : item.text;
          this.answerInputs.delete(item.id);
          if (inputText === undefined)
            throw new AppError(
              'TELEGRAM_INPUT_REENTER',
              'MCP 입력값은 저장하지 않습니다. 연결이 다시 시작되어 이전 입력을 복원할 수 없습니다. 대기 중인 요청을 확인하고 /answer 명령으로 다시 입력하세요.',
            );
          if (item.date < Math.floor(Date.now() / 1000) - 300)
            throw new AppError('TELEGRAM_EXPIRED', '요청이 만료되었습니다. 다시 보내세요.');
          const text = inputText.trim();
          if (text === '/approve' || text === '/deny') {
            const approval = this.pendingApproval(session);
            if (!this.state.config.allowBuild && approval?.approval?.kind !== 'verification')
              throw new AppError(
                'TELEGRAM_BUILD',
                'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
              );
            if (!approval)
              throw new AppError('TELEGRAM_APPROVAL', '대기 중인 승인 요청이 없습니다.');
            await this.options.decideApproval({
              sessionId: session.id,
              expectedVersion: session.version,
              activityId: approval.id,
              action: text === '/approve' ? 'approve' : 'reject',
            });
            await this.refreshApprovalButtons(signal);
            item.status = 'done';
            this.enqueue(text === '/approve' ? '승인했습니다.' : '거절했습니다.');
            await this.save();
            continue;
          }
          if (text === '/decline' || text === '/cancel-input' || isAnswerInput(text)) {
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
                const parsed: unknown = JSON.parse(text.slice('/answer'.length).trim());
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
          if (text === '/costs') {
            if (!this.options.reconcileCosts)
              throw new AppError('COST_UNAVAILABLE', '비용 조회가 연결되지 않았습니다.');
            const result = await this.options.reconcileCosts(session.id);
            this.enqueue(
              `${result.reconciled}개 정산 · ${result.remaining}개 미확정` +
                (result.withoutId
                  ? ` · 요청 ID 없는 ${result.withoutId}개 예약은 자동 정산할 수 없습니다.`
                  : ''),
            );
            item.status = 'done';
            await this.save();
            continue;
          }
          if (text === '/status') {
            const approval = this.pendingApproval(session);
            const elicitation = this.pendingElicitation(session);
            const prefix =
              session.title +
              '\n' +
              (session.run?.status ?? 'idle') +
              (approval ? '\n승인 대기: ' + this.approvalSummary(approval) : '') +
              (elicitation ? '\nMCP 입력 대기: ' + elicitation.elicitation!.message : '') +
              '\n';
            const message = session.messages.filter((m) => m.role === 'assistant').at(-1);
            this.enqueue(message ? telegramReplyChunks(message, this.token, prefix) : prefix);
            item.status = 'done';
            await this.save();
            continue;
          }
          if (text === '/plan') {
            this.enqueue(
              '/plan 뒤에 조사하거나 계획할 내용을 입력하세요. 저장된 계획은 /todo로 확인할 수 있습니다.',
            );
            item.status = 'done';
            await this.save();
            continue;
          }
          if (text === '/todo') {
            this.enqueue(
              (session.plan.goal || '저장된 목표 없음') +
                '\n' +
                (session.plan.tasks.length
                  ? session.plan.tasks
                      .map(
                        (task, index) => `${index + 1}. ${task.done ? '[x]' : '[ ]'} ${task.title}`,
                      )
                      .join('\n')
                  : '저장된 할 일이 없습니다.'),
            );
            item.status = 'done';
            await this.save();
            continue;
          }
          if (text === '/help' || text === '/start') {
            this.enqueue(
              '/skill 스킬이름 인자 · /스킬이름 인자 — 이 대화에 선택한 스킬 실행\n/plan /skill 스킬이름 인자 — 읽기 전용 스킬 요청\n' +
                '/ask 메시지 — Build 요청\n/plan 내용 — 이번 요청만 조사·계획\n/goal 목표 — 독립 목표 실행\n/resume — 중단된 /goal 계속\n/costs — OpenRouter 미확정 비용 조회·정산\n/run — 저장 계획 자동 실행\n/todo — 목표와 할 일 조회\n/todo goal 목표 | 완료 기준\n/todo add 할 일 | 완료 기준\n/todo done 번호 · /todo undo 번호 · /todo remove 번호\n/autopilot ask|auto|full — 승인 단계 변경\n/approve · /deny — 대기 작업 결정\n/answer JSON · /decline · /cancel-input — MCP 입력 결정\n/stop — 현재 실행 중지\n일반 텍스트도 Build 요청으로 전달됩니다. 원격 Build와 권한 변경은 Telegram 설정에서 허용해야 합니다.',
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
            const planRequest = /^\/plan\s/.test(text);
            const selectedSkills =
              text.startsWith('/') && !planRequest && !/^\/ask\s/.test(text)
                ? (await this.options.store.registeredSkills()).filter((skill) =>
                    session.skills?.some(
                      (selection) =>
                        selection.id === skill.id && selection.revision === skill.revision,
                    ),
                  )
                : [];
            const skillRequest = !!resolveSkillInvocation(text, selectedSkills);
            if (text.startsWith('/') && !/^\/ask\s/.test(text) && !planRequest && !skillRequest)
              throw new AppError(
                'TELEGRAM_COMMAND',
                '지원하지 않는 명령입니다. /help 를 확인하세요.',
              );
            if ((planRequest || skillRequest) && session.run?.status === 'running')
              throw new AppError('TELEGRAM_BUSY', '현재 실행이 끝난 뒤 계획·스킬 요청을 보내세요.');
            const requestMode =
              session.run?.status === 'running'
                ? (session.mode ?? 'build')
                : planRequest
                  ? 'plan'
                  : 'build';
            if (
              requestMode !== 'plan' &&
              !this.state.config.allowBuild &&
              session.permissionMode !== 'full'
            )
              throw new AppError(
                'TELEGRAM_BUILD',
                'Build 원격 요청은 데스크톱에서 허용해야 합니다.',
              );
            command =
              session.run?.status === 'running'
                ? makeCommand({
                    type: 'steer_run',
                    sessionId: session.id,
                    runId: session.run.id,
                    content: /^\/ask\s/.test(text) ? text.slice(5).trim() : text,
                  })
                : makeCommand({
                    type: 'send_message',
                    sessionId: session.id,
                    expectedVersion: session.version,
                    content: planRequest
                      ? text.slice(6).trim()
                      : /^\/ask\s/.test(text)
                        ? text.slice(5).trim()
                        : text,
                    mode: requestMode,
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
            item.command.type === 'steer_run'
              ? '추가 지시를 접수했습니다. 현재 작업 뒤 다음 모델 요청에 반영합니다.'
              : item.command.type === 'save_plan'
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
        this.enqueue(
          item.answerInput &&
            !(error instanceof AppError && error.code === 'TELEGRAM_INPUT_REENTER')
            ? 'MCP 입력을 처리하지 못했습니다. 대기 중인 요청, 원격 Build 허용 설정과 입력 형식을 확인하고 /answer 명령으로 다시 입력하세요.'
            : error instanceof AppError
              ? error.message
              : '요청 처리에 실패했습니다.',
        );
        item.status = 'done';
        await this.save();
      }
    }
  }
  private approvalFingerprint(activity: Activity) {
    return hash(
      JSON.stringify([
        activity.label,
        activity.arguments,
        activity.approval,
        activity.edit,
        activity.changes,
      ]),
    );
  }
  private approvalButton(outboxId: string, messageId: number) {
    return this.state.outbox.find(
      (item) =>
        item.id === outboxId &&
        item.approval &&
        item.epoch === this.state.epoch &&
        item.sessionId === this.state.config.sessionId &&
        item.chatId === this.state.owner?.chatId &&
        (item.status === 'sent' || item.status === 'unknown') &&
        (item.messageId === messageId || (item.status === 'unknown' && !item.messageId)),
    );
  }
  private async answerCallback(id: string, text: string, signal: AbortSignal, alert = false) {
    try {
      await this.api(
        'answerCallbackQuery',
        {
          callback_query_id: id,
          text,
          show_alert: alert,
          cache_time: 0,
        },
        AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      );
    } catch {
      // This only dismisses Telegram's spinner; failure must not repeat an approval.
    }
  }
  private async receiveApprovalCallback(
    updateId: number,
    query: NonNullable<z.infer<typeof updateSchema>['callback_query']>,
    signal: AbortSignal,
  ) {
    const message = query.message;
    const owner = this.state.owner;
    if (
      !owner ||
      !this.state.config.transmissionConsent ||
      query.from.id !== owner.userId ||
      message?.chat.id !== owner.chatId ||
      message.chat.type !== 'private' ||
      message.from?.id !== this.state.bot?.id ||
      !message.from?.is_bot
    ) {
      await this.answerCallback(
        query.id,
        '연결된 계정의 개인 채팅에서만 사용할 수 있습니다.',
        signal,
        true,
      );
      return;
    }
    const data = query.data?.match(/^approval:([ad]):([0-9a-f-]{36})$/);
    const button = data && this.approvalButton(data[2]!, message.message_id);
    if (!button) {
      await this.answerCallback(
        query.id,
        '이 승인 버튼은 만료되었거나 현재 대화의 요청이 아닙니다.',
        signal,
        true,
      );
      return;
    }
    if (this.state.inbox.some((item) => item.callback?.id === query.id)) {
      await this.answerCallback(query.id, '이미 접수한 요청입니다.', signal);
      return;
    }
    if (this.state.inbox.filter((item) => item.status !== 'done').length >= 64) {
      await this.answerCallback(
        query.id,
        '대기 중인 요청이 많습니다. 잠시 후 다시 누르세요.',
        signal,
        true,
      );
      return;
    }
    // Receiving the bound button proves delivery even if sendMessage's response was lost.
    button.messageId = message.message_id;
    this.state.inbox.push({
      id: updateId,
      epoch: this.state.epoch,
      sessionId: this.state.config.sessionId,
      date: Math.floor(Date.now() / 1000),
      text: '',
      status: 'queued',
      callback: {
        id: query.id,
        outboxId: button.id,
        messageId: message.message_id,
        action: data![1] === 'a' ? 'approve' : 'reject',
      },
    });
  }
  private async processApprovalCallback(item: Inbox, signal: AbortSignal) {
    const callback = item.callback!;
    const button = this.approvalButton(callback.outboxId, callback.messageId);
    let result: string;
    try {
      if (
        !button ||
        button.approval!.resolved ||
        item.sessionId !== this.state.config.sessionId ||
        !this.state.config.transmissionConsent ||
        item.date < Math.floor(Date.now() / 1000) - 300
      )
        throw new AppError('TELEGRAM_APPROVAL_STALE', '이미 처리되었거나 만료된 승인 요청입니다.');
      // Dismiss the spinner before reading the current version: a slow Telegram ack must
      // not turn an otherwise valid click into a conflict with ongoing run updates.
      await this.answerCallback(callback.id, '요청을 처리하고 있습니다.', signal);
      signal.throwIfAborted();
      const session = await this.options.store.session(button.sessionId!);
      const activity = session.messages
        .flatMap((message) => message.activities ?? [])
        .find((entry) => entry.id === button.approval!.activityId);
      if (
        !activity?.approval ||
        activity.approval.status !== 'pending' ||
        this.approvalFingerprint(activity) !== button.approval!.fingerprint
      ) {
        button.approval!.resolved = true;
        throw new AppError(
          'TELEGRAM_APPROVAL_STALE',
          '이미 처리되었거나 내용이 변경된 승인 요청입니다.',
        );
      }
      if (!this.state.config.allowBuild && activity.approval.kind !== 'verification')
        throw new AppError(
          'TELEGRAM_BUILD',
          'Telegram 설정에서 Build 원격 요청을 먼저 허용하세요.',
        );
      signal.throwIfAborted();
      await this.options.decideApproval({
        sessionId: session.id,
        expectedVersion: session.version,
        activityId: activity.id,
        action: callback.action,
      });
      button.approval!.resolved = true;
      result = callback.action === 'approve' ? '승인했습니다.' : '거절했습니다.';
      this.enqueue(result);
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof AppError &&
          ['STORAGE_EXIT', 'STORAGE_ERROR', 'INTEGRATION_STATE'].includes(error.code))
      )
        throw error;
      if (
        button &&
        error instanceof AppError &&
        ['APPROVAL_EXPIRED', 'APPROVAL_NOT_FOUND'].includes(error.code)
      )
        button.approval!.resolved = true;
      result =
        error instanceof AppError
          ? error.message
          : '처리 결과를 확인하지 못했습니다. 대화에서 승인 상태를 확인하세요.';
      await this.answerCallback(callback.id, result.slice(0, 180), signal, true);
    }
    item.status = 'done';
    await this.save();
    if (button?.approval?.resolved) await this.clearApprovalKeyboard(button, signal);
  }
  private async clearApprovalKeyboard(item: Outbox, signal: AbortSignal) {
    if (
      !item.messageId ||
      item.keyboardCleared ||
      (item.clearKeyboardAt ?? 0) > Date.now() ||
      item.chatId !== this.state.owner?.chatId
    )
      return;
    try {
      await this.api(
        'editMessageReplyMarkup',
        {
          chat_id: item.chatId,
          message_id: item.messageId,
          reply_markup: { inline_keyboard: [] },
        },
        AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      );
      item.keyboardCleared = true;
    } catch (error) {
      // Removing UI is idempotent. Unlike the approval, an uncertain edit may be retried.
      if (error instanceof BotError && error.definite && !error.retryAfter)
        item.keyboardCleared = true;
      else
        item.clearKeyboardAt =
          Date.now() +
          (error instanceof BotError && error.retryAfter ? error.retryAfter * 1000 : 30000);
    }
    await this.save();
  }
  private async refreshApprovalButtons(signal: AbortSignal) {
    const buttons = this.state.outbox.filter((item) => item.approval);
    if (!buttons.length) return;
    let session: Session | undefined;
    if (this.state.config.sessionId) {
      try {
        session = await this.options.store.session(this.state.config.sessionId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
      }
    }
    const pending = new Map(
      session?.messages
        .flatMap((message) => message.activities ?? [])
        .filter((activity) => activity.approval?.status === 'pending')
        .map((activity) => [activity.id, activity]) ?? [],
    );
    let changed = false;
    for (const item of buttons) {
      const activity = pending.get(item.approval!.activityId);
      if (
        !item.approval!.resolved &&
        (item.epoch !== this.state.epoch ||
          item.sessionId !== session?.id ||
          !activity ||
          this.approvalFingerprint(activity) !== item.approval!.fingerprint)
      ) {
        item.approval!.resolved = true;
        if (item.status === 'queued') item.status = 'failed';
        changed = true;
      }
      if (item.approval!.resolved) await this.clearApprovalKeyboard(item, signal);
    }
    if (changed) await this.save();
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
    return (
      (approval.kind === 'verification' ? '완료 결과 확인' : approval.kind) +
      ' · ' +
      approval.target +
      '\n사유: ' +
      approval.reason +
      (activity.arguments ? '\n인자: ' + activity.arguments : '')
    );
  }
  private async notifyPendingApproval() {
    if (!this.state.owner || !this.state.config.transmissionConsent || !this.state.config.sessionId)
      return;
    let session: Session;
    try {
      session = await this.options.store.session(this.state.config.sessionId);
    } catch {
      return;
    }
    const approval = this.pendingApproval(session);
    if (!approval) return;
    if (
      this.state.outbox.some(
        (item) =>
          item.epoch === this.state.epoch &&
          item.sessionId === session.id &&
          item.approval?.activityId === approval.id &&
          item.approval.fingerprint === this.approvalFingerprint(approval),
      )
    )
      return;
    if (!this.state.config.allowBuild && approval.approval?.kind !== 'verification') return;
    this.enqueue(
      '승인이 필요합니다.\n' +
        this.approvalSummary(approval) +
        '\n아래 버튼으로 결정하세요. /approve 또는 /deny 명령도 사용할 수 있습니다.',
      approval,
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
      if (item.status !== 'queued') continue;
      // Preserve order across multipart replies, including Telegram's retry_after window.
      if (Math.max(item.retryAt, this.state.nextSendAt ?? 0) > Date.now()) break;
      if (item.epoch !== this.state.epoch || item.chatId !== this.state.owner?.chatId) {
        item.status = 'failed';
        await this.save();
        continue;
      }
      item.status = 'sending';
      this.state.nextSendAt = Date.now() + 1000;
      await this.save();
      try {
        const response = await this.api(
          'sendMessage',
          {
            chat_id: item.chatId,
            text: item.text || '내용 없음',
            ...(item.entities?.length ? { entities: item.entities } : {}),
            ...(item.replyMarkup ? { reply_markup: item.replyMarkup } : {}),
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
        item.messageId = sent.data.message_id;
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
      // Long polling is shortened while queued output remains; incoming commands keep working.
      break;
    }
  }
}
