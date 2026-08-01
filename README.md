# Bindwidth

**Size your way to private local AI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-GitHub%20Pages-2ea44f)](https://juxhinr.github.io/bindwidth/)
[![GitHub stars](https://img.shields.io/github/stars/juxhinr/bindwidth?style=social)](https://github.com/juxhinr/bindwidth/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/juxhinr/bindwidth)](https://github.com/juxhinr/bindwidth/issues)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Made with JavaScript](https://img.shields.io/badge/made%20with-JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://github.com/juxhinr/bindwidth)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-blue.svg)](CONTRIBUTING.md)

> Find the constraint that actually binds — then size the private local stack that fits.

Three limits decide the technical minimum for one resident text model:
memory for the KV cache, combined prefill/decode serving capacity, and the runtime session ceiling. They are
evaluated explicitly and one or more can bind — usually not the limit people size
for. Bindwidth finds them, prices them, and compares eligible alternatives
you can actually use on the path to private local AI.

Frontend only. No build step, no server, no database, no account, no telemetry.
Everything runs in your browser tab and nothing you type is transmitted anywhere.

**[Open the calculator →](https://juxhinr.github.io/bindwidth/)**

## Request a quote

Sized a configuration you want to buy, rent, or stand up? In the
[calculator](https://juxhinr.github.io/bindwidth/), use **Request quote** — it copies your scenario
summary and opens a Google Form so we can reply with pricing and next steps.

→ **[Request a quote](https://forms.gle/Dm3w5JAhwHGrCSBo8)**

## Features

- **Guided setup** for first visits — team shape and model, then a live binding-constraint
  result in a few seconds. Re-open anytime from **Guided setup** in the masthead.
- **Sizes the machines** from your actual workload, treating interactive users and
  autonomous agents as the structurally different loads they are.
- **Shows which constraint binds** for every configuration, so you can see when you
  are about to buy against the wrong limit.
- **Compares transparently**: owned hardware, eligible sovereign rental, and enterprise
  subscriptions with per-token API for agents, while flagging capability and service differences.
- **Flags its own domain**, and tells you when your deployment has outgrown the model.
- **Separates measured from estimated.** Every hardware and model profile carries a
  confidence level, and it appears in the exported report. Exact model/hardware runs
  in `data/profiles.json` override bandwidth estimates when they match.
- **Exports a decision record** as Markdown, and the full scenario as JSON you can
  reload later.

## Why this exists

The honest answer to *"should we run this locally?"* is usually a sizing question
wearing a budget question's coat. Most comparisons on the internet get it wrong in
the same three ways:

1. **They size on the wrong constraint.** Buying against a limit that is not binding is
   how organisations end up with capacity they never use — and how they miss the one
   that will actually stop them at load.
2. **They compare against the wrong thing.** If your reason for going local is data
   governance, a provider you cannot audit is not a comparable at any price. What
   remains is renting metal from a sovereign provider, or subscribing to a vendor
   you already trust with your CRM.
3. **They forget that the metal is the cheap part.** Personnel is usually the largest
   line, and it does not disappear when you rent instead of buy — you manage the same
   software on someone else's iron.

This tool makes the assumptions explicit. It is a directional sensitivity estimator,
not a procurement quote; validate the exact model, runtime and hardware before purchase.

## Why the name

*Bandwidth* is what physically decides how fast a model decodes: bytes read per token,
divided into memory bandwidth, gives you the ceiling. And of the three constraints that
set your machine count, one *binds*. Both readings are the tool — and sizing against the
right bind is how you find your way to private local AI.

## Quick start

```bash
git clone https://github.com/juxhinr/bindwidth.git
cd bindwidth
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` directly from the filesystem will not work: browsers block
`fetch` on `file://`, and the catalogues are loaded that way so contributors can edit
them without touching code.

## Tests

```bash
node tests/engine.test.mjs
node tests/migration.test.mjs
node tests/claims.test.mjs
node tests/scenarios.test.mjs
```

The engine is pure functions with no DOM and no dependencies. The tests pin the
arithmetic against known values — if a number moves without a reason, they say which.

## Project structure

```
index.html            entry point
assets/styles.css     hand-written, no framework
src/engine.js         the whole calculation — pure functions, no imports
src/io.js             JSON and Markdown export, JSON import
src/app.js            UI (React + htm via CDN, no build step)
data/models.json      model architecture profiles
data/hardware.json    hardware and rental catalogue
data/profiles.json    exact model×hardware×runtime observations
data/defaults.json    starting values, subscription references, sector table
data/scenarios.json   guided-setup presets (org + workload + agents)
data/benchmarks.json  historical record of measured runs
data/schema/          catalogue and saved-scenario schemas
tests/                engine and scenario checks
```

The split is deliberate. **Adding a model, a machine or a benchmark means editing
one JSON file**, not reading the application.

## How it works

**Cost of an hour.** Gross salary × employer coefficient ÷ working hours, blended with
a freelance rate by whatever share of hours you outsource.

**Workload.** Two populations. People work office hours and produce violent peaks —
the peak factor falls as `1 + k/√activePopulation`, where the active population weights
developers fully and casual roles by their concurrency share, because bursts average
out with the people who are actually generating load. Autonomous agents run around the
clock with a flat profile and a much higher cache hit rate, because they replay the
same prompts every cycle. Each carries its own peak factor, and the KV requirement
sums two different context lengths.

**Model.** Six architecture parameters, and they pull in different directions:

| Parameter | What it decides |
|---|---|
| Total parameters | How many GPUs hold the weights |
| Active parameters | How fast it decodes — a 284B MoE with 13B active occupies like a 284B and generates like a 13B |
| Bytes per parameter | The selected checkpoint precision. Unsupported hardware combinations are excluded rather than silently converted |
| KV cache per token | How many concurrent sessions fit. Depends on the attention architecture, not on size |
| Accepted tokens per step | Speculative decoding: weights are read once per step, not per token |
| Prefill / decode ratio | Why input is priced at a fraction of output while costing far less than that fraction |

**Sizing.** KV and runtime are independent limits. Prefill and decode share accelerator
time, so the serving constraint adds their normalized loads. The recommendation then adds
any configured maintenance reserve or N+1:

```
units = max(
  ceil(KV required ÷ KV per unit),             // memory
  ceil(combined serving load ÷ util target),   // decode+prefill share the silicon
  ceil(sessions ÷ max concurrent per node)     // runtime ceiling
)
```

The limit(s) that produced the maximum are the ones that bind. Everything else has
slack, and spending money on slack is the most common mistake in this whole exercise.

**Cost.** CapEx, demand-derived energy at your tariff and PUE, management hours at your
blended rate, support, explicit replacement reserve, and optionally the margin from
genuinely available spare capacity. Media is excluded unless a separate measured local
media cost/profile is supplied.

## Contributing

Measured runs are worth more than opinions. See [CONTRIBUTING.md](CONTRIBUTING.md)
and the in-app [contribute page](https://juxhinr.github.io/bindwidth/contribute.html).

**Easy ways in:**
- Open a [catalogue](https://github.com/juxhinr/bindwidth/issues/new?template=catalogue.yml) or [benchmark](https://github.com/juxhinr/bindwidth/issues/new?template=benchmark.yml) issue
- Pick something labelled [`good first issue`](https://github.com/juxhinr/bindwidth/labels/good%20first%20issue)
- Edit one JSON file under `data/` and open a pull request

The short version: **a number without its configuration cannot be reproduced.** If you
submit a benchmark, include the pinned engine build, the exact flags, the concurrency,
whether the traffic was synthetic or realistic, and the failure modes you hit.

Confidence levels are part of the data, not a disclaimer:

| Level | Means |
|---|---|
| `measured` | First-party run, pinned build, verifiable |
| `published` | Public reproducible recipe |
| `community` | Unverified report; used only when its explicitly selected profile is active |
| `list-price` | Vendor's published price |
| `aggregator` | Third-party price tracker, not the vendor |
| `estimated` | Derived from bandwidth and memory arithmetic |
| `derived` / `kv-derived` | Calculated from another measurement; inspect the stated derivation and range |
| `template` | A starting point you are expected to replace |

Open contradictions belong in the data too. When two runs disagree, record why — or
resolve them when the configurations are not actually comparable. The DeepSeek NVFP4-KV
Spark figure (~27.8 KB/token) and the FP8-KV community figure (~10.6 KB/token) are kept
on separate catalogue entries after that resolution. Do the same with yours.

## What this tool will not tell you

Whether the premium is worth paying. It estimates it over the selected evidence range.
It does not establish that subscription and local models are equivalent in quality,
latency, context, tools or availability. Whether data governance is
worth that much to your organisation is a question about your contracts, your
regulator and your risk appetite — and no spreadsheet answers it.

## License

MIT. See [LICENSE](LICENSE).

## Author

**Juxhin Radhima**

**Project sponsor:** [Get Sh!t Done](https://get.shitdone.ai/) — *Repetitive work done
for you. Not another tool to learn.* A done-for-you managed workforce of AI agents:
sales, social, credit recovery and ads. We configure, launch and run them so your team
focuses on what matters. Cloud and on-premise.
