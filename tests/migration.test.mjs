import { readFileSync } from "node:fs";
import { SCHEMA_VERSION, buildExportPayload, migratePayload } from "../src/io.js";
import { compute } from "../src/engine.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const defaults = read("../data/defaults.json");
const models = read("../data/models.json");
const hardware = read("../data/hardware.json");
const profiles = read("../data/profiles.json").profiles;

let pass = 0, fail = 0;
const check = (name, condition) => {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

const v1State = {
  scenarioName: "legacy",
  org: { ...defaults.org }, staff: { ...defaults.staff }, mgmt: { ...defaults.mgmt },
  econ: { ...defaults.econ }, workload: { ...defaults.workload }, agents: { ...defaults.agents },
  rental: { ...defaults.rental }, subs: { ...defaults.subs }, resale: { ...defaults.resale },
  model: {
    ...models.models[0],
    supportedPrecisions: undefined,
    bytesPerParamByPrecision: undefined,
  },
  hardware: hardware.hardware.map(({ supportedPrecisions, memReserveGb, profileIds, ...h }) => ({ ...h })),
  manualQty: {},
};

const migrated = migratePayload({ schemaVersion: 1, state: v1State });
check("lo schema avanza a v2", migrated.schemaVersion === SCHEMA_VERSION);
check("la migration è registrata", migrated.migrationsApplied.includes("v1-to-v2"));
check("i default di resilience sono forniti", migrated.state.resilience.targetUtilization === 0.85);
check("i default di requirements sono forniti", migrated.state.requirements.sovereignOnly === true);
check("le capacità di precisione sono dedotte", migrated.state.hardware.every((h) => h.supportedPrecisions.length));
check("lo scenario legacy viene calcolato dopo la migration",
  Number.isFinite(compute(migrated.state, profiles).options[0].cost.total));

const result = compute(migrated.state, profiles);
const payload = buildExportPayload(migrated.state, result);
check("il nuovo export usa lo schema corrente", payload.schemaVersion === SCHEMA_VERSION);
check("il nuovo export preserva lo stato", payload.state.scenarioName === "legacy");
check("il nuovo export registra le prove delle opzioni risolte",
  payload.summary.options.every((o) =>
    Object.hasOwn(o, "eligible") &&
    Object.hasOwn(o, "recommendedUnits") &&
    Object.hasOwn(o, "warnings") &&
    Object.hasOwn(o, "uncertaintyBands")));

const v2WithoutAdditiveDefaults = migratePayload({ schemaVersion: 2, state: v1State });
check("gli import v2 ricevono i default additivi mancanti",
  v2WithoutAdditiveDefaults.state.resilience.targetUtilization === 0.85 &&
  v2WithoutAdditiveDefaults.state.profileOverrides);

let malformedRejected = false;
try {
  migratePayload({ schemaVersion: 2, state: {} });
} catch {
  malformedRejected = true;
}
check("uno stato v2 malformato viene rifiutato prima del calcolo", malformedRejected);

let futureRejected = false;
try {
  migratePayload({ schemaVersion: SCHEMA_VERSION + 1, state: {} });
} catch {
  futureRejected = true;
}
check("uno schema futuro viene rifiutato", futureRejected);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
