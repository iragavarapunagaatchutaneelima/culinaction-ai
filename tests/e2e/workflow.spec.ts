// END-TO-END TESTS — run against a fresh throwaway database (data/e2e-test.db).
// All records created here are synthetic test data, not restaurant data.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const OWNER = { username: 'e2e_owner', name: 'E2E Owner', password: 'e2e-test-password' }; // local test credentials only

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(1);
}

async function login(page: Page) {
  await page.goto('/app');
  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(`Namaste, ${OWNER.name}`)).toBeVisible();
}

test.describe.serial('CulinAction core workflow', () => {
  let outletPath = '';

  test('onboarding: owner setup with validation, then outlet creation', async ({ page }) => {
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Please fix the highlighted fields.')).toBeVisible();

    await page.getByLabel('Username').fill(OWNER.username);
    await page.getByLabel('Your name').fill(OWNER.name);
    await page.getByLabel('Password', { exact: false }).first().fill(OWNER.password);
    await page.getByLabel('Confirm password').fill('mismatch-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Passwords do not match')).toBeVisible();
    await page.getByLabel('Confirm password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('heading', { name: 'Set up your outlet' })).toBeVisible();
    await page.getByRole('button', { name: 'Create outlet' }).click();
    await expect(page.getByText('Outlet name is required')).toBeVisible();
    await page.getByLabel('Outlet name').fill('E2E Test Kitchen');
    await page.getByLabel('Outlet type').selectOption('biryani');
    await page.getByLabel('Locality').fill('Test locality');
    await page.getByLabel('Service periods').fill('Lunch, Dinner');
    await page.getByRole('button', { name: 'Create outlet' }).click();

    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.getByText('Getting started')).toBeVisible();
    outletPath = new URL(page.url()).pathname.replace(/\/today$/, '');
    await page.screenshot({ path: `${SHOTS}/01-today-empty-desktop.png`, fullPage: true });
  });

  test('empty states on a new outlet', async ({ page }) => {
    await login(page);
    await page.goto(`${outletPath}/tasks`);
    await expect(page.getByText('No open tasks')).toBeVisible();
    await page.goto(`${outletPath}/recommendations`);
    await expect(page.getByText('No recommendations yet')).toBeVisible();
    await page.goto(`${outletPath}/inventory`);
    await expect(page.getByText('No ingredients yet')).toBeVisible();
    await page.goto(`${outletPath}/analytics`);
    await expect(page.getByText('Not enough data').first()).toBeVisible();
  });

  test('inventory: add with opening stock, validate, edit, record use', async ({ page }) => {
    await login(page);
    await page.goto(`${outletPath}/inventory/new`);
    await page.getByLabel('Name').fill('Basmati rice');
    await page.getByLabel('Category').fill('Grains');
    await page.getByLabel('Quantity on hand').fill('-2');
    await page.getByRole('button', { name: 'Add ingredient' }).click();
    await expect(page.getByText('Enter a quantity greater than zero')).toBeVisible();
    await page.getByLabel('Quantity on hand').fill('4');
    await page.getByLabel('Total bill cost (₹, optional)').fill('360');
    await page.getByRole('button', { name: 'Add ingredient' }).click();

    await expect(page.getByRole('heading', { name: 'Basmati rice' })).toBeVisible();
    await expect(page.getByText('₹90.00 / kg')).toBeVisible();
    await expect(page.locator('.stat .value').first()).toHaveText('4 kg');

    await page.getByRole('link', { name: 'Edit details' }).click();
    await page.getByLabel('Supplier (optional)').fill('Test wholesaler');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Grains · Test wholesaler')).toBeVisible();

    await page.getByRole('button', { name: 'Record use' }).click();
    await page.getByLabel('Quantity', { exact: false }).first().fill('0.5');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('A reason is required')).toBeVisible();
    await page.getByLabel('Reason').fill('Staff meal');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.stat .value').first()).toHaveText('3.5 kg');
    await expect(page.getByText('Staff meal')).toBeVisible();

    // keyboard: Escape closes a dialog
    await page.getByRole('button', { name: 'Record use' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('menu: create item and a verified recipe with costing', async ({ page }) => {
    await login(page);
    await page.goto(`${outletPath}/menu`);
    await page.getByRole('button', { name: 'Add menu item' }).click();
    await page.getByLabel('Name').fill('Veg Biryani');
    await page.getByLabel('Category').fill('Biryani');
    await page.getByLabel('Selling price (₹)').fill('180');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Veg Biryani' })).toBeVisible();

    await page.getByRole('button', { name: 'Enter recipe' }).click();
    await page.getByRole('button', { name: 'Add ingredient line' }).click();
    await page.getByLabel('Ingredient', { exact: true }).selectOption({ label: 'Basmati rice' });
    await page.getByLabel('Quantity per serving').fill('200');
    await page.getByLabel('Unit').selectOption('g');
    await page.getByLabel(/These quantities are verified/).check();
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByText('Recipe verified').first()).toBeVisible();
    await expect(page.getByText('₹18.00').first()).toBeVisible(); // 200 g × ₹90/kg
  });

  test('sales: CSV import reports invalid rows and saves valid rows after confirmation', async ({ page }) => {
    await login(page);
    const today = todayIST();
    const lines = ['date,menu_item,quantity,service_period'];
    for (let i = 1; i <= 21; i++) lines.push(`${addDays(today, -i)},Veg Biryani,30,Lunch`);
    lines.push(`${addDays(today, -1)},Chicken 65,10,Lunch`); // unknown item
    lines.push(`${addDays(today, -2)},Veg Biryani,abc,Dinner`); // invalid qty
    await page.goto(`${outletPath}/sales/import`);
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'sales.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) });
    await expect(page.getByText(/Unknown menu item "Chicken 65"/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import 21 valid row(s)' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-import-review-desktop.png`, fullPage: true });
    await page.getByRole('button', { name: 'Import 21 valid row(s)' }).click();
    await expect(page.getByText(/Imported 21 row\(s\)\. 2 row\(s\) were not imported/)).toBeVisible();

    await page.goto(`${outletPath}/sales`);
    await expect(page.getByText('Same-weekday average', { exact: true })).toBeVisible();
  });

  test('decisions: run engine, inspect evidence, plan, approve, complete, record outcome', async ({
    page,
  }) => {
    await login(page);
    await page.goto(`${outletPath}/recommendations`);
    await page.getByRole('button', { name: 'Run decision engine' }).click();
    const rec = page.getByRole('link', { name: /Basmati rice may run short/ });
    await expect(rec).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/03-recommendations-desktop.png`, fullPage: true });
    await rec.click();

    await expect(page.getByText('Why this recommendation? — the calculation')).toBeVisible();
    await expect(page.getByText(/Veg Biryani: forecast 30 portions × 200 g/).first()).toBeVisible();
    await expect(page.getByText('What information is missing?')).toBeVisible();
    await expect(page.getByText(/AI explanation is not configured on this server/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/04-evidence-desktop.png`, fullPage: true });

    await page.getByRole('radio', { name: /Cap preparation to usable stock/ }).click();
    await page.getByRole('button', { name: 'Create draft plan with option B' }).click();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
    const qty = page.getByLabel('Quantity for Veg Biryani');
    await expect(qty).toHaveValue('17'); // 3.5 kg ÷ 200 g
    await qty.fill('16');
    await qty.blur();
    await expect(page.getByText('proposed 17 portions')).toBeVisible();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByText('Awaiting approval', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /^Approve/ }).click();
    await expect(page.getByText(/Approved by E2E Owner/)).toBeVisible();
    await expect(page.getByText('Prepare 16 × Veg Biryani')).toBeVisible();

    await page.goto(`${outletPath}/tasks`);
    await page.getByRole('button', { name: /^Mark done: Prepare/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark done' }).click();
    await expect(page.getByText('Enter the actual quantity.')).toBeVisible();
    await page.getByLabel(/Portions actually prepared/).fill('16');
    await page.getByRole('dialog').getByRole('button', { name: 'Mark done' }).click();
    await page.getByRole('link', { name: 'Record outcome now' }).click();

    await expect(page.getByText(/Linked to plan task/)).toBeVisible();
    await page.getByRole('textbox', { name: 'Sold' }).fill('15');
    await page.getByRole('textbox', { name: 'Discarded' }).fill('1');
    await page.getByRole('button', { name: 'Save outcome' }).click();
    await expect(page.getByText(/Recorded 15 sold in sales history/)).toBeVisible();
    await expect(page.getByText(/Deducted ingredients for 16 portions/)).toBeVisible();

    await page.goto(`${outletPath}/analytics`);
    await expect(page.getByText('Outcomes of completed preparation tasks')).toBeVisible();
    await expect(page.getByText(/Needs at least 3 earlier recorded outcomes/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/05-analytics-desktop.png`, fullPage: true });
  });

  test('approval: rejection requires and records a reason', async ({ page }) => {
    await login(page);
    await page.goto(`${outletPath}/recommendations`);
    await page.getByRole('button', { name: 'Recalculate' }).click();
    await page.getByRole('link', { name: /Basmati rice may run short/ }).click();
    await page.getByRole('radio', { name: /Buy .* of Basmati rice/ }).click();
    await page.getByRole('button', { name: 'Create draft plan with option A' }).click();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Reject plan' })).toBeDisabled();
    await page.getByLabel(/Reason/).fill('Supplier closed today');
    await page.getByRole('dialog').getByRole('button', { name: 'Reject plan' }).click();
    await expect(page.getByText(/Rejected by E2E Owner .*Supplier closed today/)).toBeVisible();
  });

  test('error handling: unknown outlet and unknown page', async ({ page }) => {
    await login(page);
    await page.goto('/o/99999/today');
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await page.goto(`${outletPath}/no-such-page`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });

  for (const width of [360, 390]) {
    test(`mobile ${width}px: bottom navigation, More sheet, no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await login(page);
      await page.goto(`${outletPath}/today`);
      const nav = page.getByRole('navigation', { name: 'Main' }).last();
      await expect(nav.getByRole('link', { name: 'Orders' })).toBeVisible();
      await nav.getByRole('link', { name: 'Orders' }).click();
      await expect(page.getByRole('heading', { name: 'Orders & delivery risk' })).toBeVisible();
      await nav.getByRole('button', { name: 'More' }).click();
      await expect(page.getByRole('dialog', { name: 'All sections' })).toBeVisible();
      await page
        .getByRole('dialog', { name: 'All sections' })
        .getByRole('link', { name: 'Analytics & reports' })
        .click();
      await expect(page.getByRole('heading', { name: 'Analytics & outcomes' })).toBeVisible();

      const pages = [
        'today',
        'inventory',
        'menu',
        'sales',
        'sales/import',
        'waste',
        'outcomes',
        'recommendations',
        'plans',
        'tasks',
        'analytics',
        'settings',
        'movements',
        'orders',
        'orders/import',
        'whatif',
        'approvals',
        'verify',
      ];
      for (const p of pages) {
        await page.goto(`${outletPath}/${p}`);
        await page.waitForLoadState('networkidle');
        await noHorizontalOverflow(page);
        if (['today', 'recommendations', 'inventory', 'outcomes'].includes(p))
          await page.screenshot({ path: `${SHOTS}/m${width}-${p}.png`, fullPage: true });
      }
      // touch targets in the bottom bar are at least 44px tall
      const box = await nav.getByRole('link', { name: 'Today' }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  }
});
