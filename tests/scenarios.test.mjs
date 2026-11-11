/**
 * Preset di scenario per il setup guidato. Esegui con: node tests/scenarios.test.mjs
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

console.log("\n— forma del catalogo —");
{
  check("Quattordici preset", scenarios.length, 14);
  const ids = new Set(scenarios.map((s) => s.id));
  check("Id univoci", ids.size, scenarios.length);
  truthy("Preset solo presenti",
    ids.has("solo-power-user") && ids.has("solo-ai-company"));
  truthy("Scala di dimensioni per settore presente",
    ["sysint", "mfg", "finance"].every((prefix) =>
      [10, 40, 100, 200].every((n) => ids.has(`${prefix}-${n}`))));
}

console.log("\n— applica + valida ogni preset —");
{
  for (const preset of scenarios) {
    const st = applyScenarioPatch(baseState(), preset.patch);
    const validation = validateState(st);
    truthy(`${preset.id} è valido`, validation.valid);
    if (!validation.valid) console.log("       ", validation.errors.join(" "));
    check(`${preset.id} imposta scenarioName`, st.scenarioName, preset.patch.scenarioName);
    check(`${preset.id} developer input rate misurato`, st.workload.devIn, 45_000_000);
    check(`${preset.id} developer output rate misurato`, st.workload.devOut, 300_000);
    check(`${preset.id} agent input rate misurato`, st.agents.inPerHour, 3_000_000);
    check(`${preset.id} agent output rate misurato`, st.agents.outPerHour, 25_000);
    check(`${preset.id} ore/giorno degli agenti misurate`, st.agents.hoursDay, 16);
    truthy(`${preset.id} azzera le quote di gestione`,
      st.mgmt.platformQuota === 0 &&
      st.mgmt.applianceQuota === 0 &&
      st.mgmt.nodeQuota === 0 &&
      st.mgmt.perUnitQuota === 0);
  }
}

console.log("\n— solo power-user + DeepSeek è un solo Spark —");
{
  const preset = scenarios.find((s) => s.id === "solo-power-user");
  const st = applyScenarioPatch(baseState(), preset.patch);
  const spark = st.hardware.find((h) => h.id === "spark-2x");
  const sizing = sizeOption(spark, st, workload(st), profiles);
  check("Unità raccomandate", sizing.recommendedUnits, 1);
  check("Unità minime", sizing.minimumUnits, 1);
  truthy("Sta in piedi", sizing.fits);
  const r = compute(st, profiles);
  truthy("La migliore opzione owned è finita", Number.isFinite(r.bestOwn?.cost.total));
}

console.log("\n— la sola AI company con 3 agenti resta fattibile —");
{
  const preset = scenarios.find((s) => s.id === "solo-ai-company");
  const st = applyScenarioPatch(baseState(), preset.patch);
  check("Numero di agenti", st.agents.count, 3);
  const r = compute(st, profiles);
  truthy("Almeno un'opzione owned sta in piedi",
    r.options.some((o) => o.kind === "own" && o.sizing.fits && Number.isFinite(o.sizing.recommendedUnits)));
  truthy("L'opzione owned migliore esiste", !!r.bestOwn);
  const spark = r.options.find((o) => o.hw.id === "spark-2x");
  truthy("La raccomandazione Spark resta a una cifra",
    spark?.sizing.fits && spark.sizing.recommendedUnits <= 2);
}

console.log("\n— totali dell'organizzazione industry-100 e token non di default —");
{
  for (const id of ["sysint-100", "mfg-100", "finance-100"]) {
    const preset = scenarios.find((s) => s.id === id);
    const st = applyScenarioPatch(baseState(), preset.patch);
    const total = st.org.devs + st.org.admin + st.org.marketing;
    check(`${id} headcount`, total, 100);
    check(`${id} condivide il developer input rate misurato`, st.workload.devIn, defaults.workload.devIn);
    check(`${id} condivide il developer output misurato`, st.workload.devOut, defaults.workload.devOut);
    truthy(`${id} agenti disattivati`, st.agents.count === 0);
  }
  const finance = applyScenarioPatch(
    baseState(),
    scenarios.find((s) => s.id === "finance-100").patch
  );
  truthy("finance preferisce l'etichetta sovereign", finance.requirements.sovereignOnly === true);
  truthy("finance preferisce le regioni EU", finance.requirements.regions.includes("EU"));
  check("contesto finance", finance.workload.context, 180000);
  check("contesto mfg",
    applyScenarioPatch(baseState(), scenarios.find((s) => s.id === "mfg-100").patch).workload.context,
    128000);
  check("mix di ruoli sysint",
    applyScenarioPatch(baseState(), scenarios.find((s) => s.id === "sysint-100").patch).org.devs,
    70);
}

console.log("\n— applyScenarioPatch lascia intatti modello ed economia —");
{
  const before = baseState();
  before.econ.kwhPrice = 0.99;
  before.model = { ...models.models[1] };
  const after = applyScenarioPatch(
    before,
    scenarios.find((s) => s.id === "solo-power-user").patch
  );
  check("modello preservato", after.model.id, models.models[1].id);
  check("economia preservata", after.econ.kwhPrice, 0.99);
  check("organizzazione sostituita", after.org.devs, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
