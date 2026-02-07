import { chromium } from 'playwright';

let browser = null;
let launching = null; // serializes concurrent launch attempts

/**
 * Get or create a singleton browser instance.
 * Uses a launch promise to prevent concurrent requests from spawning
 * duplicate browser processes.
 * @returns {Promise<import('playwright').Browser>}
 */
async function getBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }

  // If another request is already launching, wait for it
  if (launching) {
    return launching;
  }

  launching = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    browser = await launching;
  } finally {
    launching = null;
  }

  return browser;
}

/**
 * Render a URL or HTML content and capture a screenshot
 * @param {Object} options - Render options
 * @param {string} [options.url] - URL to capture
 * @param {string} [options.html] - HTML content to render
 * @param {number} [options.width=1280] - Viewport width
 * @param {number} [options.height=720] - Viewport height
 * @param {'png'|'jpeg'} [options.format='jpeg'] - Image format
 * @param {number} [options.quality=80] - JPEG quality (1-100, ignored for PNG)
 * @param {number} [options.scale=1] - Device scale factor (1 = 1x, 2 = Retina)
 * @returns {Promise<string>} Base64-encoded screenshot
 */
export async function renderScreenshot({ url, html, width = 1280, height = 720, format = 'jpeg', quality = 80, scale = 1 }) {
  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });

  const page = await context.newPage();

  try {
    if (typeof url === 'string' && url.trim().length > 0) {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    } else {
      await page.setContent(html, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    }

    // Wait a bit for any JavaScript animations/rendering
    await page.waitForTimeout(500);

    // Capture screenshot
    const screenshotOpts = { type: format, fullPage: false };
    if (format === 'jpeg') {
      screenshotOpts.quality = quality;
    }
    const screenshot = await page.screenshot(screenshotOpts);

    // Convert to base64
    return screenshot.toString('base64');
  } finally {
    await context.close();
  }
}

/**
 * Close the browser instance (for graceful shutdown)
 */
export async function closeBrowser() {
  if (browser && browser.isConnected()) {
    await browser.close();
    browser = null;
  }
}
