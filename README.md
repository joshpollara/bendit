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

Meal photos require `GEMINI_API_KEY`. The visual parser and independent
whole-meal check are pinned separately and can be overridden for paired model
evaluation:

```sh
MEAL_PARSER_MODEL=gemini-3.5-flash-lite
MEAL_HOLISTIC_MODEL=gemini-3.7-flash
MEAL_PARSER_THINKING_LEVEL=MINIMAL
MEAL_HOLISTIC_THINKING_LEVEL=LOW
```

Run weighed photos through the actual API path with an `expected.json` manifest:

```sh
BENDIT_PASSWORD=dev node server/tools/photocheck.mjs \
  --expected server/photos/expected.json server/photos/*.jpg
```

The report includes calorie MAE, bias, P90 error, item recall, optional portion
MAE, displayed-interval coverage, latency, and cost by model role.

## Deploy

Merging to `main` deploys automatically (GitHub Actions → Fly.io). The workflow
can also be run manually from the Actions tab. The site is password-protected;
set the password with `fly secrets set BASIC_AUTH_PASSWORD=... --app bendit`.
