import { expect, test } from './fixtures.ts';

/**
 * The controls for keeping one vault on two machines.
 *
 * They only exist in the desktop build, because they need a bridge into the
 * shell — so a browser tab renders an explanation instead and this panel has
 * never been exercised. Stubbing the bridge is enough: everything worth
 * testing here is what the panel does with what the shell tells it.
 */

/** A shell that reports a configured repository and remembers the interval. */
async function withGitBridge(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const state = {
      configured: true,
      repo: 'someone/vault',
      branch: 'main',
      lastSyncAt: new Date().toISOString(),
      lastCommit: 'abc1234',
      auto: true,
      everySeconds: 30,
      encrypted: true,
    };
    const win = window as unknown as { protracker?: Record<string, unknown> };
    win.protracker = {
      ...(win.protracker ?? {}),
      git: {
        status: async () => ({ ...state }),
        connect: async () => ({ ...state }),
        forget: async () => ({ ...state, configured: false }),
        setAuto: async (auto: boolean, everySeconds?: number) => {
          state.auto = auto;
          if (everySeconds) state.everySeconds = everySeconds;
          return { ...state };
        },
        sync: async () => ({
          message: 'Already up to date.',
          pushed: 0,
          pulled: 0,
          collisions: [],
          changed: false,
          repo: state.repo,
        }),
      },
    };
  });
}

test.describe('the vault sync controls', () => {
  test('counts the interval in seconds, because that is what seamless means', async ({ h }) => {
    const { page } = h;
    await withGitBridge(page);
    /*
      A real reload, not another goto: the harness has already opened this
      exact URL, so navigating to it again only moves the fragment and the
      init script would never run.
    */
    await page.reload();
    await page.waitForSelector('.shell');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('open-backup').click();

    const interval = page.getByLabel('Seconds between syncs');
    await expect(interval).toBeVisible();
    // Half a minute by default: frequent enough that the other machine's work
    // turns up while you are still looking at the screen.
    await expect(interval).toHaveValue('30');

    const options = await interval.locator('option').allTextContents();
    expect(options).toEqual(['15 sec', '30 sec', '1 minute', '5 minutes']);
  });

  test('remembers a shorter interval when you pick one', async ({ h }) => {
    const { page } = h;
    await withGitBridge(page);
    /*
      A real reload, not another goto: the harness has already opened this
      exact URL, so navigating to it again only moves the fragment and the
      init script would never run.
    */
    await page.reload();
    await page.waitForSelector('.shell');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('open-backup').click();

    const interval = page.getByLabel('Seconds between syncs');
    await interval.selectOption('15');
    await expect(interval).toHaveValue('15');
  });
});
