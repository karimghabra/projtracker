import { expect, test } from './fixtures.ts';

/** Folding a column so the other one has the screen. */

test.describe('folding a dashboard column', () => {
  test('hides one side and keeps a handle to bring it back', async ({ h }) => {
    const { page } = h;
    const right = page.getByTestId('dash-right');
    await expect(right.getByRole('heading', { name: 'Calendar' })).toBeVisible();

    await page.getByTestId('fold-right').click();
    await expect(right.getByRole('heading', { name: 'Calendar' })).toBeHidden();
    // Folded, not gone: the handle is the only way back, so it stays.
    await expect(page.getByTestId('fold-right')).toBeVisible();

    await page.getByTestId('fold-right').click();
    await expect(right.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });

  test('folding one side unfolds the other', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('fold-left').click();
    await expect(page.getByTestId('dash-left').getByText('Today', { exact: true })).toBeHidden();

    // Only one column can be folded — folding both would leave nothing.
    await page.getByTestId('fold-right').click();
    await expect(page.getByTestId('dash-left').getByText('Today', { exact: true })).toBeVisible();
    await expect(page.getByTestId('dash-right').getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });

  test('remembers the fold across a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('fold-right').click();
    await expect(page.getByTestId('dash-right').getByRole('heading', { name: 'Calendar' })).toBeHidden();

    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.getByTestId('dash-right').getByRole('heading', { name: 'Calendar' })).toBeHidden();
  });

  test('the surviving column goes two-up rather than becoming a wider scroll', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('fold-right').click();

    const columns = await page
      .getByTestId('dash-left')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(2);
  });
});
