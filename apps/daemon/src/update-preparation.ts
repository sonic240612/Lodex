import { randomUUID } from 'node:crypto';
import { AppError } from '@lodex/contracts';

/** A short installation lease prevents Telegram or another window starting work
 * between the final backup and the native updater exiting the application. */
export class UpdatePreparation {
  private lease: { token: string; expiresAt: number } | undefined;
  constructor(private now: () => number = Date.now) {}
  get blocked() {
    if (this.lease && this.lease.expiresAt <= this.now()) this.lease = undefined;
    return !!this.lease;
  }
  assertAvailable() {
    if (this.blocked)
      throw new AppError('APP_UPDATING', '업데이트를 설치하고 있습니다. 잠시 기다려 주세요.', 409);
  }
  async prepare<T>(backupWhenIdle: () => Promise<T>) {
    this.assertAvailable();
    // A long backup must not silently unlock the application halfway through.
    // The finite installation lease begins only after the snapshot is durable.
    const lease = { token: randomUUID(), expiresAt: Infinity };
    this.lease = lease;
    try {
      const backup = await backupWhenIdle();
      lease.expiresAt = this.now() + 120_000;
      return { ...lease, backup };
    } catch (error) {
      if (this.lease === lease) this.lease = undefined;
      throw error;
    }
  }
  release(token: string) {
    if (this.lease?.token === token) this.lease = undefined;
  }
}
