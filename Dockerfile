FROM node:24.22.1-slim

WORKDIR /app

# Debian's packages over HTTPS, with the fixed apt, before the first apt-get (ops I-1152)
COPY apt-https.sh /tmp/apt-https.sh
RUN sh /tmp/apt-https.sh && rm /tmp/apt-https.sh

# Copy dependency files
COPY package.json package-lock.json ./

# Install Node.js dependencies (skip postinstall: no Playwright browser download)
RUN npm ci --ignore-scripts

# The system libraries and fonts Playwright's Chromium needs (libnss3, libatk, emoji and CJK fonts, etc.)
RUN npx playwright install-deps chromium

# The browser: Chrome for Testing's headless shell at a pinned build (ops I-1114), the kind Playwright runs for
# headless Chromium; guarded-browser.mjs launches the file CHROMIUM_EXECUTABLE_PATH names
COPY install-chrome-headless-shell.sh /tmp/install-chrome-headless-shell.sh
RUN sh /tmp/install-chrome-headless-shell.sh && rm /tmp/install-chrome-headless-shell.sh
ENV CHROMIUM_EXECUTABLE_PATH=/opt/chrome-headless-shell-linux64/chrome-headless-shell

# Copy application code
COPY . .

# Chromium's sandbox is on (guarded-browser.mjs) and refuses to run as root, so
# the service runs as the image's unprivileged `node` user (ops I-602). On Linux
# the sandbox needs user namespaces: Cloud Run's second-generation environment.
USER node

# Cloud Run injects PORT; server.mjs already reads process.env.PORT
EXPOSE 3002

CMD ["node", "server.mjs"]
