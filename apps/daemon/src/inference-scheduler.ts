import type { InferenceProvider, Session } from '@lodex/contracts';
import type { RuntimeManager, RuntimeLease } from '@lodex/local-runtime';
import { ChatCompletionProvider, DemoProvider } from '@lodex/providers';

/** Slots cover generation, including model loading. Waiting never holds a VRAM lease. */
class Slots {
  private used = 0;
  private queue: { signal: AbortSignal; enter: () => void; cancel: () => void }[] = [];
  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        enter: () => {
          signal.removeEventListener('abort', waiter.cancel);
          this.used++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.used--;
            this.drain();
          });
        },
        cancel: () => {
          this.queue = this.queue.filter((item) => item !== waiter);
          signal.removeEventListener('abort', waiter.cancel);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.cancel, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  private drain() {
    while (this.used < this.limit && this.queue.length) {
      const waiter = this.queue.shift()!;
      if (waiter.signal.aborted) waiter.cancel();
      else waiter.enter();
    }
  }
}

export class InferenceScheduler {
  private readonly local = new Slots(1);
  private readonly cloud = new Slots(4);

  constructor(
    private readonly runtime: Pick<RuntimeManager, 'acquire'>,
    private readonly key: () => string | null,
    private readonly factory?: (session: Session, key: string | null) => InferenceProvider,
  ) {}

  provider(session: Session): InferenceProvider {
    const scheduler = this;
    const make = (target: Session, key: string | null): InferenceProvider =>
      scheduler.factory?.(target, key) ??
      (target.config.provider === 'demo'
        ? new DemoProvider()
        : new ChatCompletionProvider(target.config.provider, target.config.baseUrl, key));
    const metadata = () =>
      make(session, session.config.provider === 'openrouter' ? this.key() : null);
    return {
      listModels: (signal) => metadata().listModels(signal),
      capabilities: (model) => metadata().capabilities(model),
      async *generate(request, signal) {
        signal.throwIfAborted();
        const config = request.config;
        const release = await (
          config.provider === 'openrouter' ? scheduler.cloud : scheduler.local
        ).acquire(signal);
        let lease: RuntimeLease | undefined;
        try {
          signal.throwIfAborted();
          if (config.managedModelId)
            lease = await scheduler.runtime.acquire(
              config.managedModelId,
              signal,
              config.managedModelVersion,
            );
          signal.throwIfAborted();
          const effective = lease
            ? { ...config, model: lease.model, baseUrl: lease.baseUrl }
            : config;
          const provider = make(
            { ...session, config: effective },
            config.provider === 'openrouter' ? scheduler.key() : (lease?.key ?? null),
          );
          for await (const event of provider.generate({ ...request, config: effective }, signal)) {
            signal.throwIfAborted();
            yield lease &&
            event.type === 'provider_state_delta' &&
            event.model === effective.model &&
            event.provider === effective.provider
              ? { ...event, model: config.model }
              : event;
          }
        } finally {
          try {
            await lease?.release();
          } finally {
            release();
          }
        }
      },
    };
  }
}
