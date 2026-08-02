/**
 * Guided-setup scenario presets. Run with: node tests/scenarios.test.mjs
 */
import { readFileSync } from "node:fs";
import { compute, sizeOption, validateState, workload } from "../src/engine.js";
import { applyScenarioPatch } from "../src/io.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const models = read("../data/models.json");
const hardware = read("../data/hardware.json");
const defaults = read("../data/defaults.json");
const profiles = read("../data/profiles.json").profiles;
const scenariosDoc = read("../data/scenarios.json");
const scenarios = scenariosDoc.scenarios;

let pass = 0, fail = 0;

function truthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function check(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`  ok   ${name}  =  ${actual}`); }
  else { fail++; console.log(`  FAIL ${name}  got ${actual}  want ${expected}`); }
}

const baseState = () => ({
  scenarioName: "test",
  org: { ...defaults.org }, staff: { ...defaults.staff }, mgmt: { ...defaults.mgmt },
  econ: { ...defaults.econ }, workload: { ...defaults.workload }, agents: { ...defaults.agents },
  rental: { ...defaults.rental }, subs: { ...defaults.subs }, resale: { ...defaults.resale },
  resilience: { ...defaults.resilience }, requirements: { ...defaults.requirements },
  media: { ...defaults.media }, costs: { ...defaults.costs },
  uncertainty: { ...defaults.uncertainty },
  model: { ...models.models.find((m) => m.id === "deepseek-v4-flash-0731") },
  hardware: hardware.hardware.map((h) => ({ ...h, enabled: true })),
  manualQty: {},
});

console.log("\n— catalogue shape —");
{
  check("fourteen presets", scenarios.length, 14);
  const ids = new Set(scenarios.map((s) => s.id));
  check("unique ids", ids.size, scenarios.length);
  truthy("solo presets present",
    ids.has("solo-power-user") && ids.has("solo-ai-company"));
  truthy("industry size ladder present",
    ["sysint", "mfg", "finance"].every((prefix) =>
      [10, 40, 100, 200].every((n) => ids.has(`${prefix}-${n}`))));
}

console.log("\n— apply + validate every preset —");
{
  for (const preset of scenarios) {
    const st = applyScenarioPatch(baseState(), preset.patch);
    const validation = validateState(st);
    truthy(`${preset.id} validates`, validation.valid);
    if (!validation.valid) console.log("       ", validation.errors.join(" "));
    check(`${preset.id} sets scenarioName`, st.scenarioName, preset.patch.scenarioName);
    check(`${preset.id} measured developer input rate`, st.workload.devIn, 45_000_000);
    check(`${preset.id} measured developer output rate`, st.workload.devOut, 300_000);
    check(`${preset.id} measured agent input rate`, st.agents.inPerHour, 3_000_000);
    check(`${preset.id} measured agent output rate`, st.agents.outPerHour, 25_000);
    check(`${preset.id} measured agent hours/day`, st.agents.hoursDay, 16);
    truthy(`${preset.id} resets management quotas to zero`,
      st.mgmt.platformQuota === 0 &&
      st.mgmt.applianceQuota === 0 &&
      st.mgmt.nodeQuota === 0 &&
      st.mgmt.perUnitQuota === 0);
  }
}

console.log("\n— solo power-user + DeepSeek is one Spark —");
{
  const preset = scenarios.find((s) => s.id === "solo-power-user");
  const st = applyScenarioPatch(baseState(), preset.patch);
  const spark = st.hardware.find((h) => h.id === "spark-2x");
  const sizing = sizeOption(spark, st, workload(st), profiles);
  check("recommended units", sizing.recommendedUnits, 1);
  check("minimum units", sizing.minimumUnits, 1);
  truthy("fits", sizing.fits);
  const r = compute(st, profiles);
  truthy("best owned is finite", Number.isFinite(r.bestOwn?.cost.total));
}

console.log("\n— solo AI company with 3 agents remains feasible —");
{
  const preset = scenarios.find((s) => s.id === "solo-ai-company");
  const st = applyScenarioPatch(baseState(), preset.patch);
  check("agent count", st.agents.count, 3);
  const r = compute(st, profiles);
  truthy("at least one owned option fits",
    r.options.some((o) => o.kind === "own" && o.sizing.fits && Number.isFinite(o.sizing.recommendedUnits)));
  truthy("best owned exists", !!r.bestOwn);
  const spark = r.options.find((o) => o.hw.id === "spark-2x");
  truthy("Spark recommendation stays single-digit",
    spark?.sizing.fits && spark.sizing.recommendedUnits <= 2);
}

console.log("\n— industry-100 org totals and non-default tokens —");
{
  for (const id of ["sysint-100", "mfg-100", "finance-100"]) {
    const preset = scenarios.find((s) => s.id === id);
    const st = applyScenarioPatch(baseState(), preset.patch);
    const total = st.org.devs + st.org.admin + st.org.marketing;
    check(`${id} headcount`, total, 100);
    check(`${id} shares measured developer rates`, st.workload.devIn, defaults.workload.devIn);
    check(`${id} shares measured developer output`, st.workload.devOut, defaults.workload.devOut);
    truthy(`${id} agents off`, st.agents.count === 0);
  }
  const finance = applyScenarioPatch(
    baseState(),
    scenarios.find((s) => s.id === "finance-100").patch
  );
  truthy("finance prefers sovereign labelling", finance.requirements.sovereignOnly === true);
  truthy("finance prefers EU regions", finance.requirements.regions.includes("EU"));
  check("finance context", finance.workload.context, 180000);
  check("mfg context",
    applyScenarioPatch(baseState(), scenarios.find((s) => s.id === "mfg-100").patch).workload.context,
    128000);
  check("sysint role mix",
    applyScenarioPatch(baseState(), scenarios.find((s) => s.id === "sysint-100").patch).org.devs,
    70);
}

console.log("\n— applyScenarioPatch leaves model and economics alone —");
{
  const before = baseState();
  before.econ.kwhPrice = 0.99;
  before.model = { ...models.models[1] };
  const after = applyScenarioPatch(
    before,
    scenarios.find((s) => s.id === "solo-power-user").patch
  );
  check("model preserved", after.model.id, models.models[1].id);
  check("economics preserved", after.econ.kwhPrice, 0.99);
  check("org replaced", after.org.devs, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
