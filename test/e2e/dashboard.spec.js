/**
 * test/e2e/dashboard.spec.js
 * Playwright browser tests for the StateKeep dashboard SPA.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;

test.beforeEach(async ({ page }) => {
  await page.goto(`${BASE}/dashboard/`);
});

test('dashboard loads without errors', async ({ page }) => {
  await expect(page).not.toHaveURL(/error/i);
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
});

test('dashboard shows no JS errors on load', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForLoadState('networkidle');
  expect(errors).toHaveLength(0);
});

test('dashboard /health endpoint returns ok', async ({ page, request }) => {
  const res = await request.get(`${BASE}/v1/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});

test('dashboard SPA renders root element', async ({ page }) => {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 8_000 });
});

// ── SPA-specific tests ────────────────────────────────────────────────────────

test('Machines page renders state diagram when State diagram tab is clicked', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/#machines`);
  await page.waitForLoadState('networkidle');

  // Click the "State diagram" tab in the tab-bar
  const diagramTab = page.locator('.tab', { hasText: /state diagram/i });
  await expect(diagramTab).toBeVisible({ timeout: 8_000 });
  await diagramTab.click();

  // StateDiagram renders an SVG inside the card
  await expect(page.locator('.card svg').first()).toBeVisible({ timeout: 8_000 });
});

test('Actor Explorer shows actor rows and opens drawer on click', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/#actors`);
  await page.waitForLoadState('networkidle');

  // Track navigations that happen AFTER initial load
  let navigated = false;
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigated = true;
  });

  // Mock data provides actor rows
  const firstRow = page.locator('tr.tbl-row').first();
  await expect(firstRow).toBeVisible({ timeout: 8_000 });

  // Click the first row — drawer should slide open
  await firstRow.click();
  await expect(page.locator('.drawer.open')).toBeVisible({ timeout: 4_000 });

  // No full page reload occurred
  expect(navigated).toBe(false);
});

test('Scheduled page loads and shows content without errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(`${BASE}/dashboard/#scheduled`);
  await page.waitForLoadState('networkidle');

  expect(errors).toHaveLength(0);

  // The main content area should be visible (mock data provides scheduled events)
  await expect(page.locator('.main')).toBeVisible({ timeout: 8_000 });
});
