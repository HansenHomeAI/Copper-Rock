#!/usr/bin/env node
/**
 * Thorough test of Copper Rock app - runs in headless Chromium
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTests() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  const page = await context.newPage();
  const errors = [];
  const logs = [];

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('Error') || text.includes('Uncaught') || text.includes('ReferenceError')) {
      errors.push(text);
    }
    logs.push(text);
  });

  page.on('pageerror', (err) => {
    errors.push(`PageError: ${err.message}`);
  });

  try {
    console.log('1. Loading page...');
    const response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response || response.status() !== 200) {
      throw new Error(`Failed to load: ${response?.status()}`);
    }
    console.log('   OK - Page loaded');

    console.log('2. Waiting for DOM and key elements...');
    await page.waitForLoadState('domcontentloaded');
    await sleep(3000);
    const holeCount = await page.locator('#holeLabelText').count();
    if (holeCount === 0) {
      throw new Error('#holeLabelText not found in DOM');
    }

    console.log('3. Checking for JS errors...');
    if (errors.length > 0) {
      console.error('   ERRORS:', errors);
      throw new Error(`Found ${errors.length} console/JS errors`);
    }
    console.log('   OK - No JS errors');

    console.log('4. Testing hole carousel...');
    const holeLabelEl = page.locator('#holeLabelText');
    await holeLabelEl.waitFor({ state: 'attached', timeout: 15000 });
    const holeLabel = await holeLabelEl.textContent();
    if (!holeLabel || !holeLabel.includes('Hole')) {
      throw new Error(`Hole label unexpected: ${holeLabel}`);
    }
    const nextBtn = page.locator('#holeNextButton');
    await nextBtn.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await nextBtn.click({ force: true, timeout: 8000 });
    await sleep(600);
    const holeLabel2 = await page.locator('#holeLabelText').textContent();
    if (holeLabel === holeLabel2) {
      throw new Error(`Hole carousel did not change: ${holeLabel} -> ${holeLabel2}`);
    }
    await page.locator('#holePrevButton').click({ force: true, timeout: 5000 });
    await sleep(400);
    console.log('   OK - Hole carousel works');

    console.log('5. Testing animation editor toggle...');
    const animToggle = page.locator('#animationEditorToggle');
    await animToggle.scrollIntoViewIfNeeded();
    await animToggle.click({ force: true, timeout: 5000 });
    await sleep(400);
    const animPanel = page.locator('#animationEditorPanel');
    const hasActive = await animPanel.evaluate((el) => el.classList.contains('active'));
    if (!hasActive) {
      throw new Error('Animation editor panel did not open');
    }
    await animToggle.click();
    await sleep(300);
    console.log('   OK - Animation editor toggle works');

    console.log('6. Testing splat editor toggle...');
    const splatToggle = page.locator('#splatEditorToggle');
    await splatToggle.scrollIntoViewIfNeeded();
    await splatToggle.click({ force: true, timeout: 5000 });
    await sleep(400);
    const splatPanel = page.locator('#splatEditorPanel');
    const splatActive = await splatPanel.evaluate((el) => el.classList.contains('active'));
    if (!splatActive) {
      throw new Error('Splat editor panel did not open');
    }
    const posX = page.locator('#splatPosX');
    await posX.fill('0.1');
    await sleep(200);
    const val = await posX.inputValue();
    if (val !== '0.1') {
      throw new Error(`Splat Pos X input failed: got "${val}"`);
    }
    await posX.fill('0');
    await sleep(100);
    const exportBtn = page.locator('#splatExportButton');
    await exportBtn.click({ force: true });
    await sleep(300);
    await splatToggle.click();
    await sleep(300);
    console.log('   OK - Splat editor toggle works');

    console.log('7. Testing details button...');
    const detailsBtn = page.locator('#detailsButton');
    await detailsBtn.scrollIntoViewIfNeeded();
    await detailsBtn.click({ force: true, timeout: 5000 });
    await sleep(500);
    const detailsBox = page.locator('#detailsBox');
    const detailsVisible = await detailsBox.isVisible();
    if (!detailsVisible) {
      throw new Error('Details box did not open');
    }
    await detailsBtn.click();
    await sleep(300);
    console.log('   OK - Details works');

    console.log('8. Testing compass button...');
    const compassBtn = page.locator('#compassButton');
    await compassBtn.scrollIntoViewIfNeeded();
    await compassBtn.click({ force: true, timeout: 5000 });
    await sleep(1500);
    console.log('   OK - Compass triggered');

    console.log('9. Final error check...');
    if (errors.length > 0) {
      console.error('   ERRORS during test:', errors);
      throw new Error(`Errors occurred: ${errors.length}`);
    }

    console.log('\n=== All tests passed ===');
  } catch (err) {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    if (errors.length) {
      console.error('Console errors:', errors.slice(0, 5));
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runTests();
