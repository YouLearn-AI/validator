FROM node:24.22.1-slim

WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json ./

# Install Node.js dependencies (skip postinstall)
RUN npm ci --ignore-scripts

# The system libraries and fonts Playwright's Chromium needs (libnss3, libatk, emoji and CJK fonts, etc.),
# without Playwright's own browser download
RUN npx playwright install-deps chromium

# The browser: Google Chrome stable at a pinned build (ops I-1114); guarded-browser.mjs launches it
COPY install-chrome.sh /tmp/install-chrome.sh
RUN sh /tmp/install-chrome.sh && rm /tmp/install-chrome.sh

# Copy application code
COPY . .

# Chrome's sandbox is on (guarded-browser.mjs) and refuses to run as root, so
# the service runs as the image's unprivileged `node` user (ops I-602). On Linux
# the sandbox needs user namespaces: Cloud Run's second-generation environment.
USER node

# Cloud Run injects PORT; server.mjs already reads process.env.PORT
EXPOSE 3002

CMD ["node", "server.mjs"]
