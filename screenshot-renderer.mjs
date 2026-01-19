import { chromium } from 'playwright';

let browser = null;

/**
 * Get or create a singleton browser instance
 * @returns {Promise<import('playwright').Browser>}
 */
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

/**
 * Render HTML content and capture a screenshot
 * @param {string} html - The HTML content to render
 * @param {number} width - Viewport width (default: 1280)
 * @param {number} height - Viewport height (default: 720)
 * @returns {Promise<string>} Base64-encoded PNG screenshot
 */
export async function renderScreenshot(html, width = 1280, height = 720) {
  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2, // Retina quality
  });

  const page = await context.newPage();

  try {
    // Set the HTML content
    await page.setContent(html, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

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
