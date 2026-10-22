FROM node:24.22.1-slim

WORKDIR /app

# Browsers in a shared path that the non-root user below can read
# (the default, /root/.cache/ms-playwright, is root's own).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy dependency files
COPY package.json package-lock.json ./

# Install Node.js dependencies (skip postinstall — we install Playwright manually below)
RUN npm ci --ignore-scripts

# Install Playwright Chromium binary AND its required system libraries (libnss3, libatk, etc.)
RUN npx playwright install --with-deps chromium

# Copy application code
COPY . .

# Chromium's sandbox is on (guarded-browser.mjs) and refuses to run as root, so
# the service runs as the image's unprivileged `node` user (ops I-602). On Linux
# the sandbox needs user namespaces: Cloud Run's second-generation environment.
USER node

# Cloud Run injects PORT; server.mjs already reads process.env.PORT
EXPOSE 3002

CMD ["node", "server.mjs"]
