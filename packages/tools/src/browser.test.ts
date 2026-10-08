import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Browser, Page } from 'playwright-core';
import { BrowserSession, browserActionSchema, browserUrl } from './browser';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
describe('isolated browser tools', () => {
  it('validates destinations and exposes no arbitrary JavaScript, uploads or personal profile', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@example.com',
      'data:text/html,test',
    ])
      expect(() => browserUrl(url)).toThrow();
    expect(browserUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/');
    expect(browserActionSchema.safeParse({ action: 'evaluate', code: 'secret()' }).success).toBe(
      false,
    );
    expect(
      browserActionSchema.safeParse({
        action: 'open',
        url: 'https://example.com',
        userDataDir: '/secret',
      }).success,
    ).toBe(false);
  });
  it('cancels an in-flight browser and cleans up a launch finishing after cancellation', async () => {
    let finish: (value: Browser) => void = () => undefined;
    const closed = vi.fn(async () => undefined);
    const browser = new BrowserSession(
      { enabled: true, channel: 'chrome' },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const running = browser.execute(
      { action: 'open', url: 'http://example.com' },
      controller.signal,
    );
    controller.abort();
    finish({ close: closed } as unknown as Browser);
    await expect(running).rejects.toThrow();
    expect(closed).toHaveBeenCalledOnce();
  });
  it('does not launch when disabled and requires open before any interaction', async () => {
    const launch = vi.fn();
    const browser = new BrowserSession({ enabled: false, channel: 'chrome' }, launch);
    await expect(
      browser.execute({ action: 'open', url: 'https://example.com' }, signal()),
    ).rejects.toThrow('꺼져');
    await expect(
      browser.execute({ action: 'click', target: { role: 'button', name: 'Submit' } }, signal()),
    ).rejects.toThrow('먼저');
    expect(launch).not.toHaveBeenCalled();
  });
  it('never retries an ambiguous state-changing action', async () => {
    const click = vi.fn(async () => {
      throw new Error('Navigation disconnected after click');
    });
    const locator = { count: async () => 1, click, ariaSnapshot: async () => '- button "Save"' };
    const page = {
      goto: async () => undefined,
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      on() {},
      locator: () => locator,
      getByRole: () => locator,
      title: async () => 'Fixture',
      url: () => 'http://example.com',
    } as unknown as Page;
    const close = vi.fn(async () => undefined);
    const browser = new BrowserSession(
      { enabled: true, channel: 'chrome' },
      async () =>
        ({
          newContext: async () => ({
            route: async () => undefined,
            newPage: async () => page,
            on() {},
          }),
          close,
        }) as unknown as Browser,
    );
    await browser.execute({ action: 'open', url: 'http://example.com' }, signal());
    await expect(
      browser.execute({ action: 'click', target: { role: 'button', name: 'Save' } }, signal()),
    ).rejects.toThrow('반복하기 전에');
    expect(click).toHaveBeenCalledOnce();
    await browser.close();
    expect(close).toHaveBeenCalledOnce();
  });
  it.each(['password', 'PASSWORD', 'PassWord'])(
    'blocks password fields with the HTML type %s',
    async (type) => {
      const fill = vi.fn();
      const locator = {
        count: async () => 1,
        getAttribute: async () => type,
        fill,
        ariaSnapshot: async () => '- textbox',
      };
      const page = {
        goto: async () => undefined,
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        on() {},
        locator: () => locator,
        getByTestId: () => locator,
        title: async () => 'Fixture',
        url: () => 'http://example.com',
      } as unknown as Page;
      const browser = new BrowserSession(
        { enabled: true, channel: 'chrome' },
        async () =>
          ({
            newContext: async () => ({
              route: async () => undefined,
              newPage: async () => page,
              on() {},
            }),
            close: async () => undefined,
          }) as unknown as Browser,
      );
      cleanup.push(() => browser.close());
      await browser.execute({ action: 'open', url: 'http://example.com' }, signal());
      await expect(
        browser.execute(
          { action: 'fill', target: { testId: 'password' }, text: 'fixture' },
          signal(),
        ),
      ).rejects.toThrow('비밀번호');
      expect(fill).not.toHaveBeenCalled();
    },
  );
  it.runIf(!!process.env.LODEX_TEST_BROWSER)(
    'runs real DOM interaction, screenshot and close on a local fixture',
    async () => {
      const server = createServer((_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<title>Browser fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector(\'p\').textContent=document.querySelector(\'input\').value">Save</button><p>Ready</p>',
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('port');
      const browser = new BrowserSession({
        enabled: true,
        channel: process.env.LODEX_TEST_BROWSER === 'msedge' ? 'msedge' : 'chrome',
      });
      cleanup.push(() => browser.close());
      expect(
        (
          await browser.execute(
            { action: 'open', url: `http://127.0.0.1:${address.port}` },
            signal(),
          )
        ).text,
      ).toContain('Browser fixture');
      await browser.execute(
        { action: 'fill', target: { role: 'textbox', name: 'Name' }, text: 'Lodex fixture' },
        signal(),
      );
      expect(
        (
          await browser.execute(
            { action: 'click', target: { role: 'button', name: 'Save' } },
            signal(),
          )
        ).text,
      ).toContain('Lodex fixture');
      expect(
        (await browser.execute({ action: 'screenshot' }, signal())).image?.base64.startsWith(
          'iVBOR',
        ),
      ).toBe(true);
      expect((await browser.execute({ action: 'close' }, signal())).text).toContain('true');
    },
    40000,
  );
});
