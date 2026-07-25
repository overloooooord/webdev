#!/usr/bin/env node
/**
 * Scout v2 - Navigate Ubisoft account recovery WIZARD and find the form
 * The page is a React SPA - needs interaction to reach the contact form
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

process.env.DISPLAY = process.env.DISPLAY || ':0';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled', '--window-size=1280,900'
  ],
  defaultViewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ['--enable-automation'],
});

const page = await browser.newPage();
await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
await page.setUserAgent(
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
);

// Capture any API calls to account-recovery-cases
page.on('response', async resp => {
  if (resp.url().includes('account-recovery-cases') || resp.url().includes('cshelp')) {
    console.log('\n🎯 API CALL:', resp.request().method(), resp.url(), '→', resp.status());
    try { console.log('Body:', (await resp.text()).slice(0, 300)); } catch {}
  }
});

async function logPage(label) {
  const url = page.url();
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role="button"], a')]
      .map(b => b.textContent?.trim())
      .filter(t => t && t.length > 1 && t.length < 60)
      .slice(0, 15)
  ).catch(() => []);
  const inputs = await page.$$('input:not([type=hidden]), textarea, select').catch(() => []);
  
  console.log(`\n── ${label} ──`);
  console.log(`URL: ${url}`);
  console.log(`Text preview: ${text.slice(0, 200)}`);
  console.log(`Buttons: ${buttons.join(' | ')}`);
  console.log(`Inputs: ${inputs.length}`);
}

async function clickByText(keywords, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate((kws) => {
      const els = [...document.querySelectorAll('button, [role="button"], a, li, div[class*="card"], div[class*="Card"]')];
      const target = els.find(el => {
        const t = el.textContent?.trim().toLowerCase() || '';
        return kws.some(k => t.includes(k.toLowerCase()));
      });
      if (target) { target.click(); return target.textContent?.trim(); }
      return null;
    }, keywords).catch(() => null);
    
    if (clicked) {
      console.log(`  ✅ Clicked: "${clicked}"`);
      return true;
    }
    await sleep(300);
  }
  console.log(`  ❌ Not found: ${keywords.join('/')}`);
  return false;
}

// ── NAVIGATE THROUGH WIZARD ──────────────────────────────────────────────────

console.log('\n[SCOUT] Step 1: Loading account-recovery page...');
await page.goto('https://www.ubisoft.com/en-us/help/account-recovery', {
  waitUntil: 'networkidle2', timeout: 30000
}).catch(e => console.warn(e.message));
await sleep(3000);

// Accept cookies
await page.evaluate(() => {
  const btn = document.querySelector('#onetrust-accept-btn-handler') ||
    [...document.querySelectorAll('button')].find(b => /accept/i.test(b.textContent));
  if (btn) btn.click();
}).catch(() => {});
await sleep(1000);

await logPage('Initial page');

// Step 2: Click "Someone has compromised my account" or similar
console.log('\n[SCOUT] Step 2: Clicking hacked/compromised option...');
let found = await clickByText(['compromised', 'hacked', 'taken over', 'stolen', 'stolen account', 'think someone']);
await sleep(2000);
await logPage('After hacked click');

// Step 3: "Can you access your account?" → No
console.log('\n[SCOUT] Step 3: Clicking No (cannot access account)...');
found = await clickByText(['no', 'cannot', "can't access", 'lost access', 'not able']);
await sleep(2000);
await logPage('After access click');

// Step 4: Look for "Contact us" or submit case button  
console.log('\n[SCOUT] Step 4: Looking for Contact Us...');
found = await clickByText(['contact us', 'contact', 'submit a case', 'submit case', 'get help', 'open a case']);
await sleep(2000);
await logPage('After contact click');

// Step 5: Log full URL (might be a new page)
console.log('\n[SCOUT] Final URL:', page.url());

// Log all links on current page
const allLinks = await page.evaluate(() =>
  [...document.querySelectorAll('a[href]')]
    .map(a => ({ text: a.textContent.trim().slice(0, 40), href: a.href }))
    .filter(l => l.href.includes('ubisoft.com'))
).catch(() => []);
console.log('\nAll Ubisoft links:', JSON.stringify(allLinks.slice(0, 20), null, 2));

// Final inputs
const finalInputs = await page.$$('input:not([type=hidden]), textarea').catch(() => []);
console.log(`\nFinal form inputs: ${finalInputs.length}`);

await sleep(3000);
await browser.close();
