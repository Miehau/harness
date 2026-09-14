#!/usr/bin/env node
// A disposable browser per scenario. Use the target repo's Playwright installation.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, safePath } from './io.js';

export async function scenario(page, steps, capture, evidence = []) {
  assert(Array.isArray(steps) && steps.length > 0 && steps.length <= 100, 'Provide 1–100 steps');
  for (const step of steps) {
    if (step.action === 'goto') { const url = new URL(step.url); assert(['http:', 'https:'].includes(url.protocol), 'Use HTTP(S) URLs'); await page.goto(url.href); }
    else if (step.action === 'fill') await page.getByLabel(step.label, { exact: true }).fill(step.value);
    else if (step.action === 'click') await page.getByRole(step.role ?? 'button', { name: step.name, exact: true }).click();
    else if (step.action === 'visible') await page.getByText(step.text, { exact: true }).waitFor({ state: 'visible' });
    else if (step.action === 'screenshot') { const file = `${evidence.length + 1}.png`; await capture(file); evidence.push({ criterion: step.criterion ?? null, file }); }
    else throw Error(`Unknown browser action: ${step.action}`);
  }
  return evidence;
}
export async function main(file) {
  const root = await realpath(process.cwd());
  const steps = JSON.parse(await readFile(await safePath(root, file), 'utf8'));
  let chromium;
  try { ({ chromium } = createRequire(join(root, 'package.json'))('playwright')); }
  catch { throw Error('Install playwright and its Chromium browser in this repository before using the UI helper.'); }
  const output = await mkdtemp(join(root, '.runner-ui-'));
  let browser; const result = { passed: false, output, evidence: [] };
  try {
    browser = await chromium.launch(); const page = await browser.newPage(); page.setDefaultTimeout(15000);
    await scenario(page, steps, name => page.screenshot({ path: join(output, name), fullPage: true }), result.evidence);
    result.passed = true;
  } catch (error) { result.error = error.message; }
  finally { try { await browser?.close(); } finally { await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); } }
  console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
