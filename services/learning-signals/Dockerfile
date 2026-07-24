# Self-contained image for the learning-signal service. Build context is this
# directory (services/learning-signals) — the service imports nothing from the
# rest of the repo. It runs via tsx (no build step), applies migrations on
# start, and binds 0.0.0.0:$PORT for the hosting platform.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. tsx is the runtime, so keep dev deps
# (do NOT omit them) — hence --include=dev before NODE_ENV is set to production.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production
ENV SERVICE_HOST=0.0.0.0

# Applies any pending migrations, then serves. The platform injects PORT.
CMD ["npm", "run", "start:hosted"]
