const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  await page.goto('http://127.0.0.1:3010/login', { waitUntil: 'networkidle' });
  await page.fill('input[name="password"]', 'testpass');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/drop');
  await page.screenshot({ path: 'tmp/drop-gallery.png', fullPage: true });
  await browser.close();
})();
