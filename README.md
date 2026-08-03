# Bend It!

A focused calorie tracker. One loop, nothing else:

> Set a daily calorie **budget** → **log** what you eat and the exercise you do →
> see how much of the budget is **left**.

## Stack

React + Vite + TypeScript · Tailwind CSS · React Router · Zustand · Dexie.js
(IndexedDB, offline-first) · Recharts · `@zxing/browser` barcode scanning ·
Open Food Facts for packaged foods · ~180 bundled seed foods.

All data is local to the browser (IndexedDB) — there is no account and no server
database.

## Develop

```sh
npm install
npm run dev      # local dev server
npm test         # budget-engine unit tests (Vitest)
npm run build    # typecheck + production build
```

## Deploy

Merges to `main` deploy to Fly.io via GitHub Actions (`.github/workflows/deploy.yml`);
the workflow can also be run manually from the Actions tab. The app is a single
small always-on machine (shared-cpu-1x, 256MB) serving the static bundle via
nginx, with a 1GB volume mounted at `/data` for future persistence needs.
