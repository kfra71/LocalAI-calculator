/**
 * Engine checks. Run with: node tests/engine.test.mjs
 * No framework — if a number moves without a reason, this tells you which one.
 */
import { readFileSync } from "node:fs";
import {
  compute, computeSensitivity, staffing, workload, sizeOption,
  packages, scoreProspect, validateState, domainCheck,
} from "../src/engine.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const models = read("../data/models.json");
const hardware = read("../data/hardware.json");
const defaults = read("../data/defaults.json");
const profiles = read("../data/profiles.json").profiles;

let pass = 0, fail = 0;
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= Math.abs(b) * tol + 1e-9;

function check(name, actual, expected, tol) {
  const ok = typeof expected === "number" ? near(actual, expected, tol) : actual === expected;
  if (ok) { pass++; console.log(`  ok   ${name}  =  ${typeof actual === "number" ? actual.toFixed(2) : actual}`); }
  else { fail++; console.log(`  FAIL ${name}  got ${actual}  want ${expected}`); }
}
function truthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const baseState = () => ({
  scenarioName: "test",
  org: { ...defaults.org }, staff: { ...defaults.staff }, mgmt: { ...defaults.mgmt },
  econ: { ...defaults.econ }, workload: { ...defaults.workload }, agents: { ...defaults.agents },
  rental: { ...defaults.rental }, subs: { ...defaults.subs }, resale: { ...defaults.resale },
  resilience: { ...defaults.resilience }, requirements: { ...defaults.requirements },
  media: { ...defaults.media }, costs: { ...defaults.costs },
  uncertainty: { ...defaults.uncertainty },
  model: { ...models.models[0] },
  hardware: hardware.hardware.map((h) => ({ ...h, enabled: true })),
  manualQty: {},
});

console.log("\n— staffing —");
{
  const s = staffing(defaults.staff);
  check("employer cost", s.employerCost, 85200);
  check("internal hourly", s.internalHourly, 49.53);
  check("blended hourly (30% freelance)", s.blendedHourly, 57.17);
}

console.log("\n— workload, people only —");
{
  const st = baseState();
  const w = workload(st);
  check("input tokens/year", w.totalIn, 54_230_000_000);
  check("output tokens/year", w.totalOut, 3_454_000_000);
  check("input:output ratio", w.ioRatio, 15.70, 0.01);
  // Peak averages over weighted active population: devs + 0.15×admin + 0.15×marketing.
  check("peak factor (weighted active population)", w.peakUsed, 3.384, 0.01);
  check("sustained decode, people", w.decodePeople, 545.14);
  check("sustained decode, agents (none)", w.decodeAgents, 0);
  check("combined peak decode", w.decodePeak, 1844.73, 0.01);
  check("concurrent sessions", w.sessionsTotal, 16.5);
  check("resident KV required", w.kvRequired, 1_650_000);
}

console.log("\n— workload, with 25 autonomous agents —");
{
  const st = baseState();
  st.agents.count = 25;
  const w = workload(st);
  truthy("agents add tokens", w.agents.totalIn > 0);
  check("agent tokens/year (in)", w.agents.totalIn, 25 * 365 * 24 * 400000);
  truthy("agent decode is flat, not peaked", w.decodeAgents * st.agents.peakFactor < w.decodePeople * w.peakUsed);
  check("KV now includes agent context", w.kvRequired, 16.5 * 100000 + 25 * 180000);
}

console.log("\n— model footprint —");
{
  const st = baseState();
  const wl = workload(st);
  const rtx4 = st.hardware.find((h) => h.id === "rtxpro-4x");
  const s = sizeOption(rtx4, st, wl);
  check("weights on FP4 silicon", s.weightsGb, 142);
  // overheadPerGpu × GPUs + hardware memReserveGb
  check("overhead 4 GPUs + reserve", s.overhead, 52);
  check("free for KV", s.freeGb, 190);
  check("KV tokens per unit", s.kvTokens, 6_841_916, 0.001);
  check("GB read per token", s.gbPerToken, 1.621, 0.01);
  truthy("fits", s.fits);

  const h200 = st.hardware.find((h) => h.id === "h200-4x");
  const sh = sizeOption(h200, st, wl);
  // NVFP4 checkpoint on non-FP4 silicon is incompatible — not silently re-quantised.
  truthy("NVFP4 model does not fit H200 without a compatible checkpoint", !sh.fits);
  truthy("incompatibility is flagged", sh.precision && sh.fits === false);
}

console.log("\n— three constraints, and which one binds —");
{
  const st = baseState();
  const wl = workload(st);
  const rtx4 = st.hardware.find((h) => h.id === "rtxpro-4x");
  const s = sizeOption(rtx4, st, wl);
  check("units by KV", s.unitsKv, 1);
  check("combined serving units", s.unitsServing, 2);
  check("units by concurrency (maxSeqs 64)", s.unitsSeqs, 1);
  check("units bought", s.units, 2);
  truthy("combined serving is among the binding constraints", (s.bindings || [s.binding]).includes("serving"));
}

console.log("\n— measured profiles beat bandwidth estimates when matched —");
{
  const st = baseState();
  const wl = workload(st);
  const spark = st.hardware.find((h) => h.id === "spark-2x");
  const estimated = sizeOption(spark, st, wl, []);
  const matched = sizeOption(spark, st, wl, profiles);
  check("matched profile id", matched.profileId, "deepseek-spark-published");
  truthy("matched profile changes aggregate vs estimate", matched.aggregate !== estimated.aggregate);
  check("profile confidence", matched.profileConfidence, "published");

  const laguna = baseState();
  laguna.model = { ...models.models.find((m) => m.id === "laguna-s-2-1") };
  laguna.workload.context = 300_000;
  const station = laguna.hardware.find((h) => h.id === "station-gb300");
  const outsideProfile = sizeOption(station, laguna, workload(laguna), profiles);
  check("profile outside tested context falls back", outsideProfile.profileId, null);
  truthy("tested-context fallback is explained",
    outsideProfile.warnings.some((w) => w.includes("tested only")));
}

console.log("\n— concurrency ceiling can become the binding constraint —");
{
  const st = baseState();
  st.model.maxSeqs = 4;                    // the community-reported ceiling
  const wl = workload(st);
  const rtx4 = st.hardware.find((h) => h.id === "rtxpro-4x");
  const s = sizeOption(rtx4, st, wl);
  check("units by concurrency at maxSeqs=4", s.unitsSeqs, 5);
  check("binding switches to concurrency", s.binding, "concurrency");
  check("units bought", s.units, 5);
}

console.log("\n— a model that does not fit is reported, not silently sized —");
{
  const st = baseState();
  st.model.totalB = 2000;                  // absurd on purpose
  const wl = workload(st);
  const spark = st.hardware.find((h) => h.id === "spark-2x");
  const s = sizeOption(spark, st, wl);
  truthy("does not fit", !s.fits);
  check("kv tokens zero", s.kvTokens, 0);
}

console.log("\n— prefill caching and shared-prefix semantics —");
{
  const uncached = baseState(); uncached.workload.caching = 0;
  const cached = baseState(); cached.workload.caching = 0.9;
  const a = workload(uncached), b = workload(cached);
  truthy("cache hits reduce prefill compute", b.prefillPeak < a.prefillPeak * 0.2);
  check("cache hits alone do not reduce KV", b.kvRequired, a.kvRequired);
  cached.workload.prefixSharing = true;
  cached.workload.sharedPrefixTokens = 50_000;
  truthy("explicit shared prefix reduces KV", workload(cached).kvRequired < b.kvRequired);
}

console.log("\n— combined serving load shares accelerator time —");
{
  const st = baseState();
  st.resilience.targetUtilization = 1;
  st.model = {
    id: "test", totalB: 1, activeB: 1, bytesPerParam: 1,
    bytesPerParamByPrecision: { fp8: 1 }, supportedPrecisions: ["fp8"],
    defaultPrecision: "fp8", specTokens: 1, kvKbPerToken: 1,
    overheadPerGpu: 0, maxSeqs: 100, maxContext: 1000,
  };
  const hw = {
    id: "test-hw", gpus: 1, memGb: 100, memReserveGb: 0,
    bandwidth: 100, efficiency: 1, batching: 1, prefill: 100,
    supportedPrecisions: ["fp8"],
  };
  const wl = {
    decodePeak: 60, prefillPeak: 60, kvRequired: 0, sessionsTotal: 0,
  };
  const s = sizeOption(hw, st, wl);
  check("decode alone needs one", s.unitsDecode, 1);
  check("prefill alone needs one", s.unitsPrefill, 1);
  check("combined load needs two", s.unitsServing, 2);
  truthy("serving binds", s.bindings.includes("serving"));
}

console.log("\n— precision, validation, and production recommendation —");
{
  const st = baseState();
  st.model = { ...models.models[1] };
  const h200 = st.hardware.find((h) => h.id === "h200-4x");
  const fp8 = sizeOption(h200, st, workload(st));
  check("FP8 checkpoint is not doubled on H200", fp8.weightsGb, 284 * 0.588);

  st.workload.context = st.model.maxContext + 1;
  truthy("context above model maximum is invalid", !validateState(st).valid);

  const resilient = baseState();
  resilient.resilience.nPlusOne = true;
  const rtx = resilient.hardware.find((h) => h.id === "rtxpro-2x");
  resilient.model = { ...models.models.find((m) => (m.supportedPrecisions || []).includes("fp8")) || models.models[0] };
  const sr = sizeOption(rtx, resilient, workload(resilient), profiles);
  check("N+1 adds one unit above the conservative minimum",
    sr.recommendedUnits, sr.conservativeMinimumUnits + 1);
  truthy("N+1 recommendation can exceed the base minimum by more than one",
    sr.recommendedUnits > sr.minimumUnits + 1 || sr.conservativeMinimumUnits === sr.minimumUnits);
}

console.log("\n— eligibility and manual under-provisioning —");
{
  const st = baseState();
  st.agents.count = 100;
  st.manualQty["rtxpro-4x"] = 1;
  const r = compute(st, profiles);
  const manual = r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("manual quantity below minimum is flagged", manual.cost.underProvisioned);
  truthy("under-provisioned option is ineligible", !manual.eligibility.eligible);
  truthy("sovereign-only best alternative is sovereign", r.bestAlt?.hw.sovereign === true);
  truthy("non-sovereign options stay visible as references",
    r.options.some((o) => o.hw.sovereign === false && !o.eligibility.eligible));

  const manualConservative = baseState();
  const spark = manualConservative.hardware.find((h) => h.id === "spark-2x");
  const sparkSizing = sizeOption(spark, manualConservative, workload(manualConservative), profiles);
  manualConservative.manualQty["spark-2x"] = sparkSizing.minimumUnits;
  const sparkOption = compute(manualConservative, profiles).options.find((o) => o.hw.id === "spark-2x");
  truthy("manual quantity below conservative recommendation is ineligible",
    sparkSizing.conservativeMinimumUnits > sparkSizing.minimumUnits &&
    sparkOption.cost.underProvisioned && !sparkOption.eligibility.eligible);
}

console.log("\n— cost semantics —");
{
  const st = baseState();
  const r = compute(st, profiles);
  const rent = r.options.find((o) => o.hw.id === "scaleway-b300-8x");
  check("rental timing reconciles", rent.cost.serviceUpfront + rent.cost.serviceRecurring, rent.cost.service4);

  const media = baseState(); media.workload.images *= 10; media.workload.videoSeconds *= 10;
  const rm = compute(media, profiles);
  check("excluded media does not change owned TCO", rm.bestOwn.cost.total, r.bestOwn.cost.total);
  check("excluded media does not change subscription TCO",
    rm.options.find((o) => o.kind === "subscription").cost.total,
    r.options.find((o) => o.kind === "subscription").cost.total);

  const wear = baseState(); wear.mgmt.wearMultiplier = 99;
  check("legacy wear multiplier no longer changes support",
    compute(wear, profiles).options.find((o) => o.hw.id === "rtxpro-4x").cost.support4,
    r.options.find((o) => o.hw.id === "rtxpro-4x").cost.support4);
}

console.log("\n— region match, peakManual sensitivity, recommendation binding —");
{
  const st = baseState();
  st.requirements.regions = ["EU (France)"];
  st.requirements.sovereignOnly = false;
  const r = compute(st, profiles);
  const scaleway = r.options.find((o) => o.hw.id === "scaleway-b300-8x");
  truthy("Scaleway France/Netherlands matches EU (France) region filter",
    !scaleway.eligibility.reasons.includes("Provider region is outside the allowed regions."));
  const usOnly = baseState();
  usOnly.requirements.regions = ["US"];
  usOnly.requirements.sovereignOnly = false;
  const usScaleway = compute(usOnly, profiles).options.find((o) => o.hw.id === "scaleway-b300-8x");
  truthy("Scaleway does not match a US-only region filter",
    usScaleway.eligibility.reasons.includes("Provider region is outside the allowed regions."));

  const peak = baseState();
  peak.workload.peakManual = 5;
  peak.uncertainty.peakPct = 0.25;
  const band = computeSensitivity(peak, profiles);
  truthy("peakManual uncertainty spreads decode peak",
    band.conservative.workload.decodePeak >
    band.optimistic.workload.decodePeak);

  const spark = baseState().hardware.find((h) => h.id === "spark-2x");
  const sizing = sizeOption(spark, baseState(), workload(baseState()), profiles);
  truthy("recommendation binding is reported when conservative exceeds base",
    sizing.recommendationBinding &&
    (sizing.recommendedUnits > sizing.minimumUnits
      ? sizing.conservativeMinimumUnits >= sizing.minimumUnits
      : true));

  const badActive = baseState();
  badActive.model.activeB = badActive.model.totalB + 1;
  truthy("activeB above totalB is invalid", !validateState(badActive).valid);
}

console.log("\n— sensitivity and monotonic invariants —");
{
  const st = baseState();
  const band = computeSensitivity(st, profiles);
  truthy("conservative owned TCO is not below optimistic",
    band.summaries.conservative.ownTotal >= band.summaries.optimistic.ownTotal);

  const demands = [0.5, 1, 2, 4].map((factor) => {
    const x = baseState();
    x.workload.devIn *= factor;
    x.workload.devOut *= factor;
    const hw = x.hardware.find((h) => h.id === "rtxpro-4x");
    return sizeOption(hw, x, workload(x)).minimumUnits;
  });
  truthy("increasing demand never reduces units",
    demands.every((value, index) => index === 0 || value >= demands[index - 1]));

  const lowCapacity = baseState();
  const normalHw = lowCapacity.hardware.find((h) => h.id === "rtxpro-4x");
  const slowerHw = { ...normalHw, bandwidth: normalHw.bandwidth / 2 };
  truthy("lowering capacity cannot reduce minimum units",
    sizeOption(slowerHw, lowCapacity, workload(lowCapacity)).minimumUnits >=
    sizeOption(normalHw, lowCapacity, workload(lowCapacity)).minimumUnits);
}

console.log("\n— energy, TCO, recommendation, and domain invariants —");
{
  const low = baseState();
  low.manualQty["rtxpro-4x"] = 20;
  const high = baseState();
  high.manualQty["rtxpro-4x"] = 20;
  high.workload.devIn *= 3;
  high.workload.devOut *= 3;
  const option = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("derived energy rises with serving demand",
    option(compute(high, profiles)).cost.energy4 > option(compute(low, profiles)).cost.energy4);

  const r = compute(baseState(), profiles);
  truthy("recommended units never fall below technical minimum",
    r.options.filter((o) => o.kind !== "subscription" && o.sizing.fits)
      .every((o) =>
        o.sizing.recommendedUnits >= o.sizing.minimumUnits &&
        o.sizing.recommendedUnits >= o.sizing.conservativeMinimumUnits));
  const own = r.options.find((o) => o.kind === "own" && o.sizing.fits);
  const c = own.cost;
  check("TCO components reconcile", c.total,
    c.capex + c.financing - c.residual + c.energy4 + c.mgmt4 + c.support4 +
    c.service4 + c.media4 + c.recurringExtras - c.resaleNet);
  check("domain flags nine units out of scope", domainCheck(own.hw, 9).verdict, "out-of-domain");
}

console.log("\n— full run —");
{
  const r = compute(baseState());
  truthy("has an owned winner", !!r.bestOwn);
  truthy("has an alternative", !!r.bestAlt);
  truthy("every option has a total", r.options.every((o) => Number.isFinite(o.cost.total)));
  truthy("subscriptions option present", r.options.some((o) => o.kind === "subscription"));
  truthy("rented options cost the same management hours as owned nodes",
    Math.abs(
      r.options.find((o) => o.hw.id === "ovh-h200-4x").cost.mgmtQuota -
      r.options.find((o) => o.hw.id === "h200-4x").cost.mgmtQuota
    ) < 1e-9);
  truthy("appliances need less management than assembled nodes",
    r.options.find((o) => o.hw.id === "station-gb300").cost.mgmtQuota <
    r.options.find((o) => o.hw.id === "rtxpro-4x").cost.mgmtQuota);
  console.log(`       cheapest owned:       ${r.bestOwn.hw.label} — €${Math.round(r.bestOwn.cost.total).toLocaleString()}`);
  console.log(`       cheapest alternative: ${r.bestAlt.hw.label} — €${Math.round(r.bestAlt.cost.total).toLocaleString()}`);
  console.log(`       ownership premium:    €${Math.round(r.delta).toLocaleString()} (${(r.premiumActual * 100).toFixed(1)}%)`);
}

console.log("\n— autonomous agents fill the metal instead of adding peaks —");
{
  const a = compute(baseState());
  const stB = baseState(); stB.agents.count = 25;
  const b = compute(stB);
  const own = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("token volume rises sharply", b.workload.totalTokens > a.workload.totalTokens * 1.5);
  truthy("subscription cost rises with volume",
    b.options.find((o) => o.kind === "subscription").cost.total >
    a.options.find((o) => o.kind === "subscription").cost.total * 1.4);
  console.log(`       tokens/yr  ${(a.workload.totalTokens / 1e9).toFixed(0)} B → ${(b.workload.totalTokens / 1e9).toFixed(0)} B`);
  console.log(`       owned node €${Math.round(own(a).cost.total).toLocaleString()} → €${Math.round(own(b).cost.total).toLocaleString()}`);
  console.log(`       subscript. €${Math.round(a.options.find((o) => o.kind === "subscription").cost.total).toLocaleString()} → €${Math.round(b.options.find((o) => o.kind === "subscription").cost.total).toLocaleString()}`);
}

console.log("\n— human subscription overage follows measured token volume —");
{
  const a = compute(baseState(), profiles);
  const stB = baseState();
  stB.workload.devIn *= 3;
  stB.workload.devOut *= 3;
  const b = compute(stB, profiles);
  const sub = (r) => r.options.find((o) => o.kind === "subscription").cost;
  truthy("developer usage overage rises with token volume",
    sub(b).devUsageOverage > sub(a).devUsageOverage);
  truthy("subscription total rises with human token volume",
    sub(b).total > sub(a).total);
}

console.log("\n— resale is off by default and limited to feasible headroom —");
{
  const a = compute(baseState());
  const stB = baseState(); stB.resale.enabled = true;
  const b = compute(stB);
  const pick = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  check("no resale margin by default", pick(a).cost.resaleNet, 0);
  check("resale margin reconciles after energy and operations",
    pick(b).cost.resaleNet,
    (pick(b).cost.resaleGross - pick(b).cost.resaleEnergy - pick(b).cost.resaleOps) * stB.econ.years);
  check("resale changes TCO by its net result",
    pick(b).cost.total - pick(a).cost.total,
    -pick(b).cost.resaleNet);
  truthy("resale does not apply to rented nodes",
    b.options.find((o) => o.hw.id === "ovh-h200-4x").cost.resaleNet === 0);
}

console.log("\n— electricity price moves energy, not much else —");
{
  const a = compute(baseState());
  const stB = baseState(); stB.econ.kwhPrice = 0.50;
  const b = compute(stB);
  const pick = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("energy scales with tariff", near(pick(b).cost.energy4 / pick(a).cost.energy4, 0.5 / 0.33, 0.001));
  truthy("energy is a minority of the total", pick(a).cost.energy4 < pick(a).cost.total * 0.3);
}

console.log("\n— packages —");
{
  const rows = packages(baseState(), [
    { name: "S", employees: 150, aiUsers: 40, tokensOutPerDay: 180000 },
    { name: "M", employees: 300, aiUsers: 80, tokensOutPerDay: 250000 },
  ]);
  truthy("every package resolves", rows.every((p) => p.feasible));
  truthy("cost per user falls with scale", rows[1].perUserMonth < rows[0].perUserMonth);
  rows.forEach((p) => console.log(`       ${p.name}: ${p.units}× ${p.option} — €${Math.round(p.perUserMonth)}/user/mo, break-even seat $${Math.round(p.breakEvenSeat)}`));
}

console.log("\n— prospect scoring —");
{
  const s1 = scoreProspect({ sectorId: 1, aiUsers: 80, pilotBlocked: false, hasServerRoom: false, filesPatents: false, hyperscalerLock: false }, defaults.sectors, null, 3689);
  const s2 = scoreProspect({ sectorId: 1, aiUsers: 80, pilotBlocked: true, hasServerRoom: true, filesPatents: true, hyperscalerLock: false }, defaults.sectors, null, 2800);
  truthy("sector alone is not enough", s1.total < 70);
  truthy("triggers push it to high priority", s2.total >= 70);
  console.log(`       sector only: ${s1.total} (${s1.verdict})   ·   with triggers: ${s2.total} (${s2.verdict})`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
