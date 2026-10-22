import { GuardedBrowser } from './guarded-browser.mjs';
import { checkUrl } from './egress-guard.mjs';

// The shared, guarded browser (sandbox on, all traffic through the egress
// guard). Tests make their own with createScreenshotRenderer.
const defaultBrowser = new GuardedBrowser();

/**
 * A renderScreenshot bound to one GuardedBrowser.
 * @param {GuardedBrowser} guardedBrowser
 * @param {{ checkOptions?: object }} [options] options for checkUrl (tests only)
 */
export function createScreenshotRenderer(guardedBrowser, { checkOptions = {} } = {}) {
  /**
   * Render a URL or HTML content and capture a screenshot
   * @param {Object} options - Render options
   * @param {string} [options.url] - URL to capture (http or https, public addresses only)
   * @param {string} [options.html] - HTML content to render
   * @param {number} [options.width=1280] - Viewport width
   * @param {number} [options.height=720] - Viewport height
   * @param {'png'|'jpeg'} [options.format='jpeg'] - Image format
   * @param {number} [options.quality=80] - JPEG quality (1-100, ignored for PNG)
   * @param {number} [options.scale=1] - Device scale factor (1 = 1x, 2 = Retina)
   * @returns {Promise<string>} Base64-encoded screenshot
   * @throws {UrlRefused} when the URL is not a public http(s) address
   */
  return async function renderScreenshot({ url, html, width = 1280, height = 720, format = 'jpeg', quality = 80, scale = 1 }) {
    const hasUrl = typeof url === 'string' && url.trim().length > 0;
    // Refused before a browser is touched; the egress proxy checks again, and
    // checks every subresource and redirect, when Chromium connects.
    if (hasUrl) await checkUrl(url.trim(), checkOptions);

    const context = await guardedBrowser.newContext({
      viewport: { width, height },
      deviceScaleFactor: scale,
    });

    try {
      const page = await context.newPage();
      if (hasUrl) {
        await page.goto(url.trim(), {
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
  };
}

export const renderScreenshot = createScreenshotRenderer(defaultBrowser);

/**
 * Close the browser instance (for graceful shutdown)
 */
export async function closeBrowser() {
  await defaultBrowser.close();
}
