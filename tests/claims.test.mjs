import { readFileSync } from "node:fs";
import { buildMarkdown } from "../src/io.js";
import { compute } from "../src/engine.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const defaults = read("../data/defaults.json");
const models = read("../data/models.json");
const hardware = read("../data/hardware.json");
const profiles = read("../data/profiles.json").profiles;
const state = {
  scenarioName: "claims",
  org: { ...defaults.org }, staff: { ...defaults.staff }, mgmt: { ...defaults.mgmt },
  econ: { ...defaults.econ }, workload: { ...defaults.workload }, agents: { ...defaults.agents },
  rental: { ...defaults.rental }, subs: { ...defaults.subs }, resale: { ...defaults.resale },
  resilience: { ...defaults.resilience }, requirements: { ...defaults.requirements },
  media: { ...defaults.media }, costs: { ...defaults.costs },
  uncertainty: { ...defaults.uncertainty },
  model: { ...models.models[0] },
  hardware: hardware.hardware.map((h) => ({ ...h, enabled: true })),
  manualQty: {},
};

const markdown = buildMarkdown(state, compute(state, profiles));
const readText = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const projectCopy = [
  readText("../README.md"),
  readText("../src/app.js"),
  readText("../index.html"),
].join("\n");
const required = [
  "Directional estimate, not a procurement quote",
  "Comparability and eligibility",
  "not guaranteed model quality",
  "Cheapest eligible alternative",
  "Rental cash-flow timing",
  "changes payment timing, not undiscounted total commitment",
  "Peak prefill",
  "technical minimum",
  "advisory and is not included in TCO",
  "localai-tco.dinova.one",
  "Author: Juxhin Radhima",
];
// The retired brand and sponsor strings are assembled at runtime so that a repo-wide
// grep for them stays clean; the guard itself is unchanged.
const staleBrand = ["Bind" + "width", "get.shit" + "done.ai"];
const forbidden = [
  "community | Unverified report — recorded, not used in calculations",
  "runs the same model under the same workload",
  "support with a wear multiplier",
  "Four-year total",
  "four-year horizon",
  ...staleBrand,
];

let pass = 0, fail = 0;
for (const text of required) {
  if (markdown.includes(text)) { pass++; console.log(`  ok   contiene: ${text}`); }
  else { fail++; console.log(`  FAIL mancante: ${text}`); }
}
for (const text of forbidden) {
  if (!markdown.includes(text) && !projectCopy.includes(text)) { pass++; console.log(`  ok   escluso: ${text}`); }
  else { fail++; console.log(`  FAIL affermazione obsoleta: ${text}`); }
}
checkProject("il copy di progetto dichiara il serving combinato",
  projectCopy.includes("combined prefill/decode"));
checkProject("il copy di progetto dichiara l'ambito direzionale",
  projectCopy.includes("directional sensitivity estimator"));
checkProject("il copy di progetto identifica le prove di runtime fissate",
  projectCopy.includes("Pinned model, hardware and runtime evidence"));

function checkProject(name, condition) {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
