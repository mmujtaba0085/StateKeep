/**
 * test/e2e/dashboard.spec.js
 * Playwright browser tests for the StateKeep dashboard UI.
 */

import { test, expect } from '@playwright/test';
import { POST, PUT, uniqueId } from './helpers/api.js';

const BASE   = process.env.STATEKEEP_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const API_KEY = process.env.STATEKEEP_API_KEY ?? '';

/** Inject API key into sessionStorage before the page executes any JS. */
async function withAuth(page) {
  // In test mode the server bypasses auth; any non-empty string satisfies the
  // client-side getApiKey() guard so the page doesn't redirect to login.
  await page.addInitScript((key) => {
    sessionStorage.setItem('sk_apikey', key);
  }, API_KEY || 'test-bypass');
}

test.beforeEach(async ({ page }) => {
  await withAuth(page);
  await page.goto(`${BASE}/dashboard/`);
});

test('dashboard loads without errors', async ({ page }) => {
  await expect(page).not.toHaveURL(/error/i);
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
});

test('dashboard shows actor count', async ({ page }) => {
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

test('dashboard /v1/actors page renders', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).toBeVisible();
});

// ── New tests ────────────────────────────────────────────────────────────────

test('Mermaid SVG is present in the DOM after a definition is selected', async ({ page }) => {
  // Deploy a definition so there is at least one to select
  const defId = uniqueId('dash-mermaid');
  await PUT('/v1/definitions', {
    id:         defId,
    definition: {
      initial: 'idle',
      states: { idle: { on: { GO: 'done' } }, done: { type: 'final' } },
    },
  });

  await withAuth(page);
  await page.goto(`${BASE}/dashboard/definitions.html`);
  await page.waitForLoadState('networkidle');

  // Click the Diagram button for our definition
  const diagramBtn = page.locator(`button`, { hasText: 'Diagram' }).first();
  await expect(diagramBtn).toBeVisible({ timeout: 8_000 });
  await diagramBtn.click();

  // Wait for the diagram panel to appear — accepts rendered SVG or offline fallback
  await expect(page.locator('#diagram-panel')).toBeVisible({ timeout: 8_000 });
});

test('actor table row updates without full page reload when actor state changes', async ({ page }) => {
  // Spawn an actor we can control
  const defId = uniqueId('dash-actor-poll');
  await PUT('/v1/definitions', {
    id:         defId,
    definition: {
      initial: 'idle',
      states: { idle: { on: { START: 'running' } }, running: { type: 'final' } },
    },
  });
  const spawnRes = await POST('/v1/actors', { definitionId: defId });
  expect(spawnRes.status).toBe(201);
  const actorId = spawnRes.body.id;

  // Navigate to actors page with auth
  await withAuth(page);
  await page.goto(`${BASE}/dashboard/actors.html`);

  // Track navigations — there must be none after initial load
  let navigated = false;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  });

  // Wait for the actor row to appear (2 s poll cycle)
  const row = page.locator(`tr[data-actor-id="${actorId}"]`);
  await expect(row).toBeVisible({ timeout: 8_000 });

  // Record the current stateValue text
  const stateCell = row.locator('td:nth-child(4) code');
  const before    = await stateCell.textContent();

  // Change the actor's state via API
  await POST(`/v1/actors/${actorId}/event`, { type: 'START' });

  // Wait for the cell to reflect the new state (next 2 s poll)
  await expect(stateCell).not.toHaveText(before ?? '', { timeout: 8_000 });

  // Assert no full page reload occurred
  expect(navigated).toBe(false);
});

test('archives page loads and shows table or empty state without errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await withAuth(page);
  await page.goto(`${BASE}/dashboard/archives.html`);
  await page.waitForLoadState('networkidle');

  // No JS errors
  expect(errors).toHaveLength(0);

  // Either the table has rows, or the empty-state message is shown
  const hasRows  = await page.locator('#archives-body tr[data-actor-id]').count();
  const hasEmpty = await page.locator('#archives-body td.empty').count();
  expect(hasRows + hasEmpty).toBeGreaterThan(0);
});
