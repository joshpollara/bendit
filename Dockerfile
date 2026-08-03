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
COPY --from=serverdeps /srv/node_modules ./node_modules
COPY --from=client /app/dist ./public
EXPOSE 8080
CMD ["node", "index.mjs"]
