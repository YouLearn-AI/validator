FROM node:20-slim

WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json ./

# Install Node.js dependencies (skip postinstall — we install Playwright manually below)
RUN npm ci --ignore-scripts

# Install Playwright Chromium binary AND its required system libraries (libnss3, libatk, etc.)
RUN npx playwright install --with-deps chromium

# Copy application code
COPY . .

# Cloud Run injects PORT; server.mjs already reads process.env.PORT
EXPOSE 3002

CMD ["node", "server.mjs"]
