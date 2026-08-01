# Contributing

The point of this project is that the data is separable from the code. Adding a model,
a machine or a benchmark means editing one JSON file — you do not need to read the
application to contribute usefully.

## Ground rule

**A number without its configuration cannot be reproduced.** Every entry carries a
`confidence` field, and it is not a formality: it appears in the exported report, and
six months from now knowing which figures were measured and which were derived will
matter more than the figures themselves.

| Level | Use it when |
|---|---|
| `measured` | You ran it, on a pinned build, and can show the counters |
| `published` | There is a public recipe someone else can follow |
| `community` | Someone reported it and it has not been verified |
| `list-price` | Straight from the vendor's price page |
| `aggregator` | From a price tracker, not the vendor |
| `estimated` | Derived from bandwidth and memory arithmetic |
| `derived` / `kv-derived` | Back-derived from another measurement; include the derivation and uncertainty |
| `template` | A starting point, expected to be replaced |

Never promote a level without evidence. Downgrading is always allowed.

## Adding a model — `data/models.json`

Six numbers drive everything. Getting them right matters more than getting them precise.

```jsonc
{
  "id": "vendor-model-release",
  "name": "Vendor Model, release tag",
  "arch": "MoE 284A13B",              // or "Dense 70B"
  "quantLabel": "NVFP4 weights + FP8 KV",  // label only, see bytesPerParam
  "maxContext": 1048576,

  "totalB": 284,           // billions. Sets the memory footprint.
  "activeB": 13,           // billions read per token. On a dense model, same as totalB.
  "bytesPerParam": 0.5,    // legacy/base field; also provide bytesPerParamByPrecision
  "kvKbPerToken": 27.77,   // depends on the attention architecture, not on size
  "specTokens": 4.01,      // accepted tokens per step. 1.00 without a drafter.
  "prefillRatio": 12.6,    // how many times faster prefill is than decode
  "maxSeqs": 64,           // conservative fallback; exact profiles should provide the runtime limit
  "overheadPerGpu": 10,    // GB for CUDA graphs, activations, workspace, drafter

  "confidence": "measured",
  "sources": ["https://..."],
  "notes": "How you arrived at kvKbPerToken and specTokens. Be specific."
}
```

**How to derive `kvKbPerToken` honestly.** Do not read it off a spec sheet. Take a real
run: `(usable memory − weights − overhead) ÷ measured KV pool`. State the run in
`notes`. If two runs disagree, say so rather than picking one — the current DeepSeek
entries carry exactly that unresolved contradiction, and that is the correct way to
record it.

**`bytesPerParam` must be consistent with the measured weight size.** If a checkpoint
labelled FP8 measures 167 GB across 284B parameters, that is 0.588 bytes per parameter,
not 1.00. Write the number that reconciles, and explain the discrepancy in `notes`.

## Adding hardware — `data/hardware.json`

```jsonc
{
  "id": "vendor-config",
  "kind": "own",              // "own" = purchased, "rent" = hourly
  "label": "4x RTX PRO 6000 Blackwell",
  "class": "node",            // "appliance" needs far less management than "node"
  "gpus": 4,
  "memGb": 384,               // usable at your gpu_memory_utilization, not nameplate
  "bandwidth": 7160,          // GB/s aggregate
  "supportedPrecisions": ["nvfp4", "fp8", "bf16"],
  "priceUsd": 73000,          // for kind: "own"
  "hourly": 23.12,            // for kind: "rent"
  "currency": "EUR",          // for rentals
  "prefill": 20000,           // tok/s
  "efficiency": 0.06,         // measured decode ÷ theoretical. Be conservative.
  "batching": 6.0,            // aggregate ÷ single stream
  "peakKw": 2.9, "idleKw": 0.8, "pue": 1.35,
  "infraPerUnit": 12000, "setupHours": 340, "supportPerUnit": 4000,
  "sovereign": true,
  "confidence": "estimated",
  "topology": "TP=4 over PCIe Gen5",
  "notes": "Why these numbers, and what you are unsure about."
}
```

**`efficiency` and `batching` are where estimates go wrong.** If you have measured
them, say `measured` and put the run in `data/benchmarks.json` too. If you are
deriving them, stay conservative and say so — an optimistic efficiency makes a
configuration look good and costs someone real money.

**Non-sovereign options are welcome** with `"sovereign": false`. They are useful for
sizing the compliance premium, and the interface labels them clearly.

## Adding a serving profile — `data/profiles.json`

Throughput, batching, prefill capacity and runtime session limits belong to the exact
model + hardware + runtime tuple, not to hardware in isolation. Add low/base/high
observations, the pinned runtime, tested context, confidence and a benchmark archive ID.
If no exact profile matches, the calculator uses a visibly labelled bandwidth estimate.
Do not widen a measured profile to other models or runtime versions without evidence.

## Adding a benchmark — `data/benchmarks.json`

This file is a historical record. **Nothing in it feeds the calculation directly.**
Reviewed values move into `models.json`, `hardware.json`, or an explicitly matched
`profiles.json` entry. Selected catalogue/profile entries do feed calculations.

Include:

- the exact engine build (a commit hash, not "latest")
- the full flag set
- the concurrency, and whether traffic was synthetic or realistic
- **the failure modes.** A run that documents what broke is more useful than one that
  reports only the happy path.
- caveats in the `caveats` array, one per line, plainly

Open inconsistencies belong here too. If your numbers contradict an existing entry,
record the contradiction rather than resolving it silently.

## Code changes

`src/engine.js` has no imports and no DOM access, by design. Keep it that way — it
makes the maths reviewable and testable on its own.

If you change the engine, add a check to `tests/engine.test.mjs` that would have
failed before your change:

```bash
node tests/engine.test.mjs
```

For the interface: no build step, no framework beyond React via CDN, no CSS
framework. If a change needs a bundler, it probably belongs in a fork.

## What gets rejected

- Numbers without a source or a derivation
- `measured` on something you did not measure
- Vendor marketing figures presented as benchmarks
- Adding a dependency that requires a build step
- Removing a caveat because it makes an option look bad

## Reporting a modelling error

If the arithmetic is wrong, open an issue with the inputs, what the tool produced, and
what you believe it should produce. Errors in the model matter more than errors in the
data, because they are invisible: a formula pointing at the wrong cell still returns a
number, and it looks fine until someone checks.
