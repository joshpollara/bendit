# Future meal-photo work

The current meal-photo feature is deliberately usable without either item
below. Its displayed bounds are an **estimated range**, not a calibrated 80%
interval, and its Dutch generic-food resolver is ready to prefer NEVO records
but no NEVO dataset is imported.

## Recommended order

- [ ] Obtain and import NEVO while weighed-meal data collection begins.
- [ ] Freeze a candidate model/prompt/database pipeline once enough evaluation
      meals exist.
- [ ] Fit and validate calibration only against that frozen pipeline.
- [ ] Rename the UI range to a calibrated 80% interval only after the untouched
      test set demonstrates the claimed coverage.

## 1. Import NEVO 2025/9.0

### External prerequisites

- [ ] Have the operating person or organization request the free dataset and
      accept RIVM's conditions:
      <https://www.rivm.nl/en/dutch-food-composition-database/use-of-nevo-online/request-dataset>
- [ ] Ask `nevo@rivm.nl` for written clarification before public redistribution
      or monetization. Confirm public consumer-app use, whether a paid product
      may use NEVO as one source, and whether normalized search indexes may be
      shipped separately from the unchanged source values.
- [ ] Account for the current terms requiring unchanged source data and
      source/version attribution, and prohibiting charges to end users for use
      of NEVO data. Get written clarification for the intended business model.
- [ ] Keep the raw archive out of Git, npm packages, and public container images
      unless RIVM explicitly permits redistribution.
- [ ] Record the accepted terms and dataset version with the private deployment
      artifact. Conditions last checked 2026-08-15:
      <https://www.rivm.nl/sites/default/files/2025-11/Conditions-of-use-NEVO-online-2025-dataset.pdf>

### Importer and schema

- [ ] Add `server/ingest/nevo.mjs` and parsing code under `server/ingest/lib/`.
      Accept an explicit local archive/CSV path; never download behind the
      operator's back.
- [ ] Preserve NEVO values unchanged. Store NEVO code as `sourceId`, source as
      `nevo`, edition as `2025/9.0`, Dutch and English names, food group,
      per-100 basis, nutrient values, and source references.
- [ ] Preserve missing values as `null`. Do not turn missing nutrients into zero.
- [ ] Preserve the uncommon per-100-ml basis instead of silently treating
      millilitres as grams.
- [ ] Keep derived search terms, spelling normalization, and synonyms in a
      clearly separate app-owned layer so they cannot be mistaken for modified
      NEVO data.
- [ ] Make the import idempotent and version-aware. Report inserted, updated,
      retired, skipped, and malformed rows.
- [ ] Add small synthetic fixtures that exercise the real column layout without
      committing RIVM data.

### Application integration

- [ ] Add `nevo` to the client `Food['source']` type, source labels, browse
      filters, counts, ordering, and delete/edit protection.
- [ ] Keep exact package nutrition in front of NEVO: label OCR, exact barcode,
      authorized manufacturer data, then NEVO generic food.
- [ ] Verify the existing resolver preference for `nevo` with Dutch names and
      raw/cooked/drained/prepared-state tests.
- [ ] Store and return source version/provenance with each NEVO-backed estimate.
- [ ] Show the required attribution anywhere a NEVO-backed calculation is
      presented or exported:

      > Based on data from NEVO online version 2025/9.0, RIVM, Bilthoven and other data sources.

- [ ] Add an operator update procedure and subscribe to RIVM release notices.

### NEVO release gate

- [ ] Import succeeds from a clean database and as an update over an older
      snapshot.
- [ ] Nutrient spot checks match the source archive exactly, including units and
      missing values.
- [ ] Dutch generic-food matching improves on the weighed-meal evaluation set
      without worsening package matches or raw/cooked state selection.
- [ ] Attribution and source/version provenance are visible and tested.

## 2. Calibrate the displayed interval

Calibration makes the interval honest; it does not reduce calorie MAE. Continue
improving identification, portions, and database matches independently.

### Collect representative ground truth

- [ ] Define a versioned manifest for original image(s), meal ID, household,
      recipe/product/venue, capture session, meal type, device metadata, served
      component weights, leftovers, hidden fats/sauces, exact nutrition records,
      and true consumed calories/macros.
- [ ] For recipes, weigh every ingredient and the cooked batch, then allocate
      nutrients by the consumed cooked-mass fraction. For packages, retain the
      exact label and weigh consumed or remaining product.
- [ ] Collect an initial 300-500 representative Dutch meals. Cover bread meals,
      dairy and spreads, stamppot, soups/stews, salads and dressing, takeaway,
      restaurant food, packaged products, drinks, plant substitutes, different
      phones, lighting, bowls, plates, households, and portion sizes.
- [ ] Use explicit consent and a deliberate storage policy for calibration
      images. Production currently stores only an image hash; do not silently
      turn ordinary user scans into a retained photo dataset.
- [ ] Keep weighed-meal images, ground-truth manifests, and fitted private-data
      outputs outside Git and add their chosen local paths to `.gitignore`.
- [ ] Split by household, recipe, product, venue, and capture session. Never put
      two views of one meal or near-identical recipes in different splits.
- [ ] Keep separate development/model-selection, calibration, and untouched test
      sets. A useful first strong target is at least 200 calibration meals and
      250 untouched test meals, plus a separate development set.

### Capture reproducible predictions

- [ ] Extend `server/tools/photocheck.mjs --out` to retain the full reconciled
      response and calibration features, not only reduced scores.
- [ ] Record image preprocessing, parser and holistic model IDs, prompt versions,
      nutrition database versions, router version, latency, token usage, and cost.
- [ ] Add stable split keys and reject manifests that leak a household, recipe,
      product, venue, or capture session across splits.
- [ ] Run paired model bakeoffs on the development set. Freeze the winning
      pipeline before fitting calibration; any material model, prompt, resolver,
      preprocessing, or database change requires revalidation.

### Fit and apply calibration

- [ ] Start with a simple split-conformal correction of the existing low/high
      envelope. Avoid a feature-heavy quantile model until substantially more
      local data exists.
- [ ] Create a fit tool that writes a small versioned JSON artifact containing
      target coverage, correction values, calibration-set fingerprint, pipeline
      compatibility versions, sample count, and creation date.
- [ ] Load and validate the artifact at server startup. Fail closed to the
      existing `Estimated range` when it is absent, malformed, or incompatible.
- [ ] Apply calibration after `reconcileMealEstimates`, never inside a VLM.
- [ ] Calibrate the exact workflow being labeled, including the optional user
      question. Manual client edits must not retain an 80% label unless that
      post-edit path has also been evaluated and calibrated.
- [ ] Return `intervalMethod`, target coverage, artifact version, and pipeline
      version in the estimate provenance.
- [ ] Keep calibration artifacts out of model-selection loops and never fit on
      the final test set.

### Calibration release gate

- [ ] Report calorie MAE, median and P90 absolute error, signed bias, interval
      coverage, mean interval width, macro MAE, portion MAE, item recall, latency,
      cost, question rate, and retake rate.
- [ ] Bootstrap paired error differences and report a binomial confidence
      interval for coverage on the untouched test set.
- [ ] Confirm approximately 80% marginal coverage with useful interval width and
      inspect meal-type strata for serious failures. Do not promise 80% coverage
      for each stratum without enough held-out examples in each one.
- [ ] Only then change product copy from `Estimated range` to `Calibrated 80% interval`.
- [ ] Monitor coverage on newly weighed meals and invalidate/re-fit calibration
      after pipeline changes or meaningful domain drift.

## Later, after both tracks

- [ ] Benchmark conditional second-angle capture for bowls, stacked foods, and
      severe occlusion.
- [ ] Collect known plate/bowl dimensions and optional phone depth metadata.
- [ ] Train or adopt a Dutch-domain geometry/portion model only if it improves
      the untouched weighed-meal test set.
