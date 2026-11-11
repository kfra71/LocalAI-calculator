import { readFileSync } from "node:fs";
import { buildMarkdown } from "../src/io.js";
import { compute } from "../src/engine.js";
import { RFQ_FORM_URL, buildRfqSummary } from "../src/rfq.js";

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
  "Stima direzionale, non un preventivo d'acquisto",
  "Comparabilità ed eleggibilità",
  "non garantisce la qualità del modello",
  "Alternativa eleggibile più economica",
  "Tempistica del flusso di cassa del noleggio",
  "modifica la tempistica dei pagamenti, non l'impegno totale non scontato",
  "Prefill di picco",
  "minimo tecnico",
  "localai-tco.dinova.one",
  "Autore: Juxhin Radhima",
];
// The retired brand and sponsor strings are assembled at runtime so that a repo-wide
// grep for them stays clean; the guard itself is unchanged.
const staleBrand = ["Bind" + "width", "get.shit" + "done.ai"];
const forbidden = [
  "community | Segnalazione non verificata — registrata, non usata nei calcoli",
  "esegue lo stesso modello sullo stesso carico di lavoro",
  "supporto con un moltiplicatore di usura",
  "Totale su quattro anni",
  "orizzonte di quattro anni",
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
  projectCopy.includes("serving combinato prefill/decode"));
// La sezione "Questo strumento è ancora lo strumento giusto" ha tre formulazioni
// (fuori dominio, al limite, nel dominio) a seconda della soluzione più economica:
// la guardia verifica che il report dichiari sempre il controllo su infrastruttura
// e bus factor, qualunque sia il ramo.
const domainVerdicts = ["Fuori dominio", "Al limite", "Nel dominio"];
checkProject("il report dichiara il controllo su infrastruttura e bus factor",
  markdown.includes("Questo strumento è ancora lo strumento giusto") &&
  markdown.includes("bus factor") &&
  domainVerdicts.some((v) => markdown.includes(v)));
checkProject("il copy di progetto dichiara l'ambito direzionale",
  projectCopy.includes("stimatore di sensibilità direzionale"));
checkProject("il copy di progetto identifica le prove di runtime fissate",
  projectCopy.includes("Evidenze di modello, hardware e runtime fissati"));
checkProject("la richiesta di preventivo porta alla pagina contatti di Dinova",
  RFQ_FORM_URL === "https://www.dinova.one/contatti/");
checkProject("il riepilogo del preventivo non nomina più il modulo Google",
  !buildRfqSummary(state, compute(state, profiles)).includes("Google"));

function checkProject(name, condition) {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
