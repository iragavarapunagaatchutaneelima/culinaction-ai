// END-TO-END TESTS for v2: landing page, Demo Mode journeys, themes and responsive layouts.
// Demo data is generated fictional sample data; nothing here is a real restaurant result.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(1);
}

async function openDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Explore interactive demo' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a demo outlet' })).toBeVisible({ timeout: 20000 });
}

async function openOutlet(
  page: Page,
  name: RegExp,
  target: 'Guided scenarios' | 'Open dashboard' = 'Guided scenarios',
) {
  const card = page.locator('.card', { has: page.getByRole('heading', { name }) });
  await card.getByRole('button', { name: target }).click();
}

test.describe('landing page', () => {
  test('opens without login, explains both modes and has working calls to action', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Smarter kitchen decisions. Less avoidable waste.',
    );
    await expect(page.getByRole('link', { name: 'Explore interactive demo' })).toHaveAttribute(
      'href',
      '/demo',
    );
    await expect(page.getByRole('link', { name: 'Use real application' })).toHaveAttribute('href', '/app');
    await expect(page.getByRole('heading', { name: 'Two separate modes' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Privacy and data integrity' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/v2-landing-light.png`, fullPage: true });
    // theme toggle
    await page.getByRole('radio', { name: 'Dark' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(20, 22, 19)');
    await page.screenshot({ path: `${SHOTS}/v2-landing-dark.png`, fullPage: true });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // persisted, applied before paint
    await page.getByRole('radio', { name: 'System' }).first().click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    // real mode entry is protected
    await page.getByRole('link', { name: 'Use real application' }).click();
    await expect(page.getByRole('heading', { name: /Create the owner account|Sign in/ })).toBeVisible();
  });

  for (const width of [360, 390, 768]) {
    test(`landing has no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 860 });
      await page.goto('/');
      await noHorizontalOverflow(page);
      if (width === 360) await page.screenshot({ path: `${SHOTS}/v2-landing-360.png`, fullPage: true });
    });
  }
});

test.describe('demo mode', () => {
  test('food-waste journey: surplus → evidence → approve → task → outcome → verification', async ({
    page,
  }) => {
    await openDemo(page);
    await expect(page.getByText('DEMO MODE').first()).toBeVisible();
    await openOutlet(page, /Charminar Biryani House/);
    await expect(page.getByRole('heading', { name: 'Guided demo scenarios' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/v2-demo-scenarios.png`, fullPage: true });
    await page.getByRole('button', { name: 'Start scenario 1' }).click();
    await expect(page.getByRole('heading', { name: /Prepare fewer Chicken Dum Biryani/ })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText('Why this recommendation? — the calculation')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Rule-based summary/ })).toBeVisible();
    await expect(page.getByText(/AI explanation is not configured on this server/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/v2-demo-surplus-evidence.png`, fullPage: true });

    await page.getByRole('radio', { name: /Prepare \d+ \(average forecast\)/ }).click();
    await page.getByRole('button', { name: /Create draft plan with option A/ }).click();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: /^Approve/ }).click();
    await expect(page.getByText(/Approved by Demo visitor/)).toBeVisible();

    await page.getByRole('link', { name: 'Open checklist' }).click();
    await page.getByRole('button', { name: /^Mark done: Prepare \d+ × Chicken Dum Biryani/ }).click();
    const planned = await page.getByLabel(/Portions actually prepared/).getAttribute('aria-label');
    void planned;
    await page.getByLabel(/Portions actually prepared/).fill('80');
    await page.getByRole('dialog').getByRole('button', { name: 'Mark done' }).click();
    await page.getByRole('link', { name: 'Record outcome now' }).click();
    await expect(page.getByText(/Linked to plan task/)).toBeVisible();
    await page.getByRole('textbox', { name: 'Sold' }).fill('72');
    await page.getByRole('textbox', { name: /Transferred/ }).fill('3');
    await page.getByRole('textbox', { name: 'Discarded' }).fill('5');
    await page.getByRole('checkbox', { name: /Deduct recipe ingredients/ }).uncheck();
    await page.getByRole('button', { name: 'Save outcome' }).click();
    await expect(page.getByText(/Logged 5 discarded portions as waste/)).toBeVisible();

    await page.goto(page.url().replace(/\/outcomes.*$/, '/verify'));
    await expect(page.getByRole('heading', { name: 'Outcome verification' })).toBeVisible();
    await expect(page.locator('.verify-row', { hasText: 'Chicken Dum Biryani' })).toContainText('Approved');
    await page.screenshot({ path: `${SHOTS}/v2-demo-verify.png`, fullPage: true });
  });

  test('delivery journey: pickup delay → timeline & risk → approve action → record pickup', async ({
    page,
  }) => {
    await openDemo(page);
    await openOutlet(page, /Charminar Biryani House/);
    await page.getByRole('button', { name: 'Start scenario 4' }).click();
    await expect(page.getByRole('heading', { name: /^Order DEMO-P/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('High risk').first()).toBeVisible();
    await expect(page.getByText('Waiting for pickup (still waiting)')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/v2-demo-order-risk.png`, fullPage: true });

    await page.getByRole('button', { name: 'Review recommended actions' }).click();
    await expect(page.getByRole('heading', { name: /waiting 2\d min for pickup/ })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('radio', { name: /Alert staff and chase the pickup/ }).click();
    await page.getByRole('button', { name: /Create draft plan with option A/ }).click();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: /^Approve/ }).click();
    await page.getByRole('link', { name: 'Open checklist' }).click();
    await page.getByRole('button', { name: /^Mark done: Order DEMO-P/ }).click();
    await page.getByLabel(/Delay reason to record/).fill('Rider was assigned late (demo)');
    await page.getByRole('dialog').getByRole('button', { name: 'Mark done' }).click();
    await expect(page.getByText(/Delay reason recorded on order/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

    // record the pickup on the order timeline
    await page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Orders & delivery' })
      .click();
    await page
      .getByRole('link', { name: /^DEMO-P/ })
      .first()
      .click();
    await page.getByLabel('Event').selectOption({ label: 'Picked up' });
    await page.getByRole('button', { name: 'Record event' }).click();
    await expect(page.getByText('Rider was assigned late (demo)').first()).toBeVisible();
    await expect(page.locator('.events')).toContainText('Picked up');
  });

  test('uncollected order scenario never offers resale, and what-if compares quantities', async ({
    page,
  }) => {
    await openDemo(page);
    await openOutlet(page, /Charminar Biryani House/);
    await page.getByRole('button', { name: 'Start scenario 3' }).click();
    await expect(
      page.getByRole('heading', { name: /packed but not collected — record what happens to the food/ }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/never assumes cancelled or uncollected food can be resold/)).toBeVisible();
    await expect(page.getByRole('radio', { name: /Hold for re-collection until/ })).toBeVisible();

    await page.getByRole('link', { name: 'Demo scenarios' }).first().click();
    await page.getByRole('button', { name: 'Start scenario 5' }).click();
    await expect(page.getByRole('heading', { name: 'What-if simulator' })).toBeVisible();
    await page.getByRole('button', { name: 'Compare quantities' }).click();
    await expect(page.getByRole('heading', { name: /^Demand for/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('columnheader', { name: 'Comparable days short' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/v2-demo-whatif.png`, fullPage: true });
  });

  test('reset regenerates the demo and real mode never shows demo outlets', async ({ page }) => {
    await openDemo(page);
    await openOutlet(page, /Udupi Tiffin Corner/, 'Open dashboard');
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    const before = page.url();
    await page.getByRole('button', { name: 'Reset demo' }).click();
    await page.getByRole('button', { name: 'Reset demo data' }).click();
    await expect(page.getByRole('heading', { name: 'Guided demo scenarios' })).toBeVisible({
      timeout: 20000,
    });
    expect(page.url()).not.toBe(before);
    // the same browser in Real Mode cannot open the demo outlet
    const demoOutletId = /\/demo\/o\/(\d+)/.exec(page.url())![1];
    await page.goto(`/app/o/${demoOutletId}/today`);
    await expect(
      page.getByRole('heading', { name: /Create the owner account|Sign in|Not found/ }),
    ).toBeVisible();
  });

  test('dark theme renders the demo screens with dark surfaces', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'Dark' }).first().click();
    await openDemo(page);
    await openOutlet(page, /Banjara Brew Café/, 'Open dashboard');
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    for (const p of ['today', 'orders', 'recommendations', 'inventory', 'analytics']) {
      await page.goto(page.url().replace(/\/[a-z]+(\?.*)?$/, `/${p}`));
      await page.waitForLoadState('networkidle');
      const card = await page.evaluate(() => {
        const el = document.querySelector('.card') ?? document.body;
        return getComputedStyle(el).backgroundColor;
      });
      expect(card, p).not.toBe('rgb(255, 253, 248)');
      await page.screenshot({ path: `${SHOTS}/v2-dark-${p}.png`, fullPage: true });
    }
  });

  for (const width of [360, 390]) {
    test(`demo screens fit ${width}px without horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 820 });
      await openDemo(page);
      await openOutlet(page, /Charminar Biryani House/);
      const base = /^(.*\/demo\/o\/\d+)/.exec(page.url())![1];
      for (const p of [
        'scenarios',
        'today',
        'orders',
        'whatif',
        'approvals',
        'verify',
        'waste',
        'analytics',
        'recommendations',
      ]) {
        await page.goto(`${base}/${p}`);
        await page.waitForLoadState('networkidle');
        await noHorizontalOverflow(page);
        if (['today', 'orders', 'scenarios'].includes(p))
          await page.screenshot({ path: `${SHOTS}/v2-m${width}-${p}.png`, fullPage: true });
      }
      const orderLink = page.getByRole('link', { name: /^CBH-L1/ });
      await page.goto(`${base}/orders`);
      await orderLink.first().click();
      await noHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/v2-m${width}-order.png`, fullPage: true });
    });
  }
});
