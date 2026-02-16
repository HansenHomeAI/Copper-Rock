#!/usr/bin/env node
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('Error') || t.includes('Uncaught')) errors.push(t);
  });

  console.log('Loading...');
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
  console.log('DOM loaded');

  await page.waitForTimeout(2000);

  const hasHole = await page.locator('#holeLabelText').count() > 0;
  console.log('holeLabelText exists:', hasHole);

  const html = await page.content();
  console.log('holeLabelText in HTML:', html.includes('holeLabelText'));

  const body = await page.locator('body').innerHTML();
  console.log('holeLabelText in body:', body.includes('holeLabelText'));

  if (errors.length) {
    console.log('Errors:', errors);
  }

  await browser.close();
}

main().catch(console.error);
