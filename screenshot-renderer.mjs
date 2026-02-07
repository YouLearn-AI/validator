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
 * @param {number} width - Viewport width (default: 1280)
 * @param {number} height - Viewport height (default: 720)
 * @returns {Promise<string>} Base64-encoded PNG screenshot
 */
export async function renderScreenshot({ url, html, width = 1280, height = 720 }) {
  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2, // Retina quality
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
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
    });

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
