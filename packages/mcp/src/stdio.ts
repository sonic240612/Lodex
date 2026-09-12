import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  deserializeMessage,
  serializeMessage,
  type Transport,
  type JSONRPCMessage,
} from '@modelcontextprotocol/client';
import { AppError } from '@lodex/contracts';
import { processEnvironment, type McpConfig } from './config';

export class OwnedStdioTransport implements Transport {
  onclose: Transport['onclose'];
  onerror: Transport['onerror'];
  onmessage: Transport['onmessage'];
  private child?: ChildProcess;
  private stopped = false;
  private closed = false;
  private started = false;
  private buffer = Buffer.alloc(0);
  constructor(
    private config: Extract<McpConfig, { transport: 'stdio' }>,
    private env: Record<string, string>,
    private supervisor: string,
  ) {}
  async start(): Promise<void> {
    if (this.started) throw new AppError('MCP_STARTED', '이미 시작한 MCP 연결입니다.');
    this.started = true;
    const child = (this.child = spawn(process.execPath, [this.supervisor], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      shell: false,
      env: processEnvironment(),
    }));
    child.stderr!.resume(); // Third-party stderr may include credentials; never forward it to the UI/log.
    child.stdout!.on('data', (chunk: Buffer) => {
      if (this.buffer.length + chunk.length > 1048576) {
        this.onerror?.(new AppError('MCP_OUTPUT_LIMIT', 'MCP 응답 크기 제한을 초과했습니다.'));
        void this.close().catch(() => undefined);
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        const bytes = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        try {
          this.onmessage?.(
            deserializeMessage(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          );
        } catch {
          this.onerror?.(new AppError('MCP_FORMAT', 'MCP 서버가 잘못된 JSON-RPC를 반환했습니다.'));
          void this.close().catch(() => undefined);
          return;
        }
      }
    });
    child.stdin!.on('error', () =>
      this.onerror?.(new AppError('MCP_CONNECTION', 'MCP 프로세스 연결이 종료되었습니다.')),
    );
    child.on('close', () => {
      this.closed = true;
      this.onclose?.();
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          error ? reject(error) : resolve();
        }
      };
      const timer = setTimeout(() => {
        finish(new AppError('MCP_TIMEOUT', 'MCP 프로세스 시작 시간이 초과됐습니다.'));
        void this.close().catch(() => undefined);
      }, 10000);
      child.on('error', () => {
        if (child.pid === undefined) this.stopped = true;
        finish(new AppError('MCP_START', 'MCP 감독 프로세스를 시작하지 못했습니다.'));
      });
      child.on('message', (value) => {
        const type = (value as { type?: string }).type;
        if (type === 'server_started') finish();
        if (type === 'server_stopped') this.stopped = true;
      });
      child.on('close', () =>
        finish(new AppError('MCP_START', 'MCP 서버가 시작 중 종료되었습니다.')),
      );
      child.send(
        {
          type: 'bootstrap',
          executable: this.config.executable,
          args: this.config.args,
          cwd: this.config.cwd,
          env: { ...processEnvironment(), ...this.env },
        },
        (error) => {
          if (error) finish(new AppError('MCP_START', 'MCP 시작 정보를 전달하지 못했습니다.'));
        },
      );
    });
  }
  async send(message: JSONRPCMessage) {
    if (!this.child || this.closed || !this.child.stdin?.writable)
      throw new AppError('MCP_CLOSED', 'MCP 연결이 닫혔습니다.');
    const text = serializeMessage(message);
    if (Buffer.byteLength(text) > 262144)
      throw new AppError('MCP_INPUT_LIMIT', 'MCP 요청 크기 제한을 초과했습니다.');
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin!.write(text, (error) =>
        error ? reject(new AppError('MCP_CONNECTION', 'MCP 요청 전달에 실패했습니다.')) : resolve(),
      ),
    );
  }
  async close() {
    if (!this.child) return;
    if (!this.closed) {
      if (this.child.connected) this.child.send({ type: 'stop' }, () => undefined);
      this.child.stdin?.end();
      await Promise.race([
        new Promise<void>((resolve) => this.child!.once('close', () => resolve())),
        delay(3000),
      ]);
    }
    if (!this.closed || !this.stopped)
      throw new AppError(
        'MCP_CLOSE_UNKNOWN',
        'MCP 서버 종료를 확인하지 못했습니다. 같은 작업을 자동으로 다시 실행하지 마세요.',
      );
  }
}
