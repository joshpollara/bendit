# Bend It!

A simple calorie tracker. Set a daily calorie budget, log what you eat and the
exercise you do, and see how much of the budget is left.

## Develop

```sh
npm install
cd server && npm install && cd ..
BASIC_AUTH_PASSWORD=dev node server/index.mjs   # API + database on :8080
npm run dev                                     # UI on :5173 (proxies /api)
npm test
```

## Deploy

Merging to `main` deploys automatically (GitHub Actions → Fly.io). The workflow
can also be run manually from the Actions tab. The site is password-protected;
set the password with `fly secrets set BASIC_AUTH_PASSWORD=... --app bendit`.
