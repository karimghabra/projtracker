import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Each spec gets its own vault namespace, so tests are independent and can run
 * in parallel against one dev server. The whole application — command layer
 * included — runs in the page, so these drive the real domain logic; there is
 * nothing mocked below the DOM.
 */

let counter = 0;

export interface Harness {
  page: Page;
  goto(view?: string): Promise<void>;
  /** Today's date as the app sees it, 'YYYY-MM-DD'. */
  today(): Promise<string>;
  addDays(days: number): Promise<string>;
}

export const test = base.extend<{ h: Harness }>({
  h: async ({ page }, use, testInfo) => {
    const namespace = `t${Date.now()}-${counter++}-${testInfo.workerIndex}`;

    const harness: Harness = {
      page,
      async goto(view = 'home') {
        await page.goto(`/?vault=${namespace}#/${view}`);
        await page.waitForSelector('.shell');
      },
      async today() {
        return page.evaluate(() => {
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        });
      },
      async addDays(days: number) {
        return page.evaluate((n) => {
          const d = new Date();
          d.setDate(d.getDate() + n);
          const pad = (x: number) => String(x).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }, days);
      },
    };

    await harness.goto();
    await use(harness);
  },
});

export { expect };

/** Create a project through the wizard, with milestones, goals and tasks. */
export async function createProject(
  page: Page,
  spec: {
    name: string;
    milestones: { name: string; goals?: { name: string; tasks?: string[] }[] }[];
  },
): Promise<void> {
  await page.getByTestId('add-project').first().click();
  await page.getByTestId('project-name').fill(spec.name);
  await page.getByTestId('wizard-next').click();

  // Milestones.
  for (const [index, milestone] of spec.milestones.entries()) {
    if (index > 0) await page.getByTestId('add-milestone').click();
    await page.getByTestId(`milestone-name-${index}`).fill(milestone.name);
  }
  await page.getByTestId('wizard-next').click();

  // Goals, one group per milestone.
  for (const [mIndex, milestone] of spec.milestones.entries()) {
    for (const [gIndex, goal] of (milestone.goals ?? []).entries()) {
      await page.getByTestId(`add-goal-${mIndex + 1}`).click();
      await page.getByTestId(`goal-name-${mIndex + 1}-${gIndex}`).fill(goal.name);
    }
  }
  await page.getByTestId('wizard-next').click();

  // Tasks, addressed by the goal group they sit in.
  const groups = page.locator('.wizard-group');
  let groupIndex = 0;
  for (const milestone of spec.milestones) {
    for (const goal of milestone.goals ?? []) {
      const group = groups.nth(groupIndex++);
      for (const [tIndex, task] of (goal.tasks ?? []).entries()) {
        await group.getByRole('button', { name: 'Add task' }).click();
        // Exact, because "Sequence number for task 1 of CAD" also contains
        // "Task 1 of CAD" and getByLabel matches substrings.
        await group.getByLabel(`Task ${tIndex + 1} of ${goal.name}`, { exact: true }).fill(task);
      }
    }
  }

  await page.getByTestId('wizard-create').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}
