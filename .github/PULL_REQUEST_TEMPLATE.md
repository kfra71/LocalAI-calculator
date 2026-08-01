## Summary
<!-- What did you add or change, and why? -->

## Kind of change
- [ ] Catalogue data (`data/models.json`, `data/hardware.json`, `data/profiles.json`, `data/scenarios.json`)
- [ ] Benchmark record (`data/benchmarks.json`)
- [ ] Engine / tests (`src/engine.js`, `tests/`)
- [ ] UI / docs
- [ ] Other

## Evidence
<!-- Required for numbers. Link sources, recipes, or describe the derivation. -->

- Confidence level proposed: `<!-- measured | published | community | list-price | aggregator | estimated | derived | template -->`
- Sources:
-
- Configuration / runtime pin (for measured or published runs):

## Tests
```bash
node tests/engine.test.mjs
node tests/migration.test.mjs
node tests/claims.test.mjs
node tests/scenarios.test.mjs
```

- [ ] I ran the relevant tests above (or this PR only adds docs / issue templates)
- [ ] If I changed the engine, I added a check that would have failed before the change

## Checklist
- [ ] I did not mark anything `measured` that I did not measure
- [ ] Caveats and open contradictions are recorded, not silenced
- [ ] No new build step or npm dependency
