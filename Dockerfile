# Build the client, install server deps (better-sqlite3 needs a native build
# on musl), then run one small Node container that serves both.
FROM node:20-alpine AS client
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS serverdeps
WORKDIR /srv
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /srv
ENV NODE_ENV=production PORT=8080 SQLITE_PATH=/data/bendit.db
COPY server/index.mjs server/seedFoods.json ./
# The food schema, search, and barcode helpers the server imports at startup,
# plus the importers — they run inside this container against the volume, so
# the data never has to travel.
COPY server/lib ./lib
COPY server/ingest ./ingest
COPY server/tools ./tools
# `bendit-user add josh` on the machine, rather than a path to remember:
#   fly ssh console -a bendit -C "bendit-user add josh"
RUN chmod +x ./tools/*.mjs && ln -sf /srv/tools/users.mjs /usr/local/bin/bendit-user
COPY --from=serverdeps /srv/node_modules ./node_modules
COPY --from=client /app/dist ./public
EXPOSE 8080
CMD ["node", "index.mjs"]
