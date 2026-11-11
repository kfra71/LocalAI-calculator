/**
 * Controlli del motore. Eseguiti con: node tests/engine.test.mjs
 * Nessun framework — se un numero si muove senza un motivo, questo indica quale.
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
  // Fissa DeepSeek per i pin di regressione aritmetica; il default di prodotto è models[0] (Qwen).
  model: { ...models.models.find((m) => m.id === "deepseek-v4-flash-0731") },
  hardware: hardware.hardware.map((h) => ({ ...h, enabled: true })),
  manualQty: {},
});

console.log("\n— costo orario del personale —");
{
  const s = staffing(defaults.staff);
  check("costo del datore di lavoro", s.employerCost, 85200);
  check("costo orario interno", s.internalHourly, 49.53);
  check("costo orario mediato (30% freelance)", s.blendedHourly, 57.17);
}

console.log("\n— workload, solo persone —");
{
  const st = baseState();
  const w = workload(st);
  check("token di input/anno", w.totalIn, 199_430_000_000);
  check("token di output/anno", w.totalOut, 1_694_000_000);
  check("rapporto input:output", w.ioRatio, 117.73, 0.01);
  // Il picco media sulla popolazione attiva pesata: dev + 0.15×admin + 0.15×marketing.
  check("fattore di picco (popolazione attiva pesata)", w.peakUsed, 3.384, 0.01);
  check("decode sostenuto, persone", w.decodePeople, 267.36);
  check("decode sostenuto, agenti (nessuno)", w.decodeAgents, 0);
  check("decode di picco combinato", w.decodePeak, 904.74, 0.01);
  check("sessioni concorrenti", w.sessionsTotal, 16.5);
  check("KV residenti richiesti", w.kvRequired, 1_650_000);
}

console.log("\n— workload, con 25 agenti autonomi —");
{
  const st = baseState();
  st.agents.count = 25;
  const w = workload(st);
  truthy("gli agenti aggiungono token", w.agents.totalIn > 0);
  check("token/anno degli agenti (in)", w.agents.totalIn, 25 * 365 * 16 * 3000000);
  truthy("il decode degli agenti è piatto, non di picco", w.decodeAgents * st.agents.peakFactor < w.decodePeople * w.peakUsed);
  check("la KV include ora il contesto degli agenti", w.kvRequired, 16.5 * 100000 + 25 * 180000);
}

console.log("\n— ingombro del modello —");
{
  const st = baseState();
  const wl = workload(st);
  const rtx4 = st.hardware.find((h) => h.id === "rtxpro-4x");
  const s = sizeOption(rtx4, st, wl);
  check("pesi su silicio FP4", s.weightsGb, 142);
  // overheadPerGpu × GPU + hardware memReserveGb
  check("overhead di 4 GPU + riserva", s.overhead, 52);
  check("libero per la KV", s.freeGb, 190);
  check("token di KV per unità", s.kvTokens, 6_841_916, 0.001);
  check("GB letti per token", s.gbPerToken, 1.621, 0.01);
  truthy("entra", s.fits);

  const h200 = st.hardware.find((h) => h.id === "h200-4x");
  const sh = sizeOption(h200, st, wl);
  // Un checkpoint NVFP4 su silicio non-FP4 è incompatibile — non viene ri-quantizzato silenziosamente.
  truthy("il modello NVFP4 non entra su H200 senza un checkpoint compatibile", !sh.fits);
  truthy("l'incompatibilità viene segnalata", sh.precision && sh.fits === false);
}

console.log("\n— tre vincoli e quale lega —");
{
  const st = baseState();
  const wl = workload(st);
  const rtx4 = st.hardware.find((h) => h.id === "rtxpro-4x");
  const s = sizeOption(rtx4, st, wl);
  check("unità per la KV", s.unitsKv, 1);
  check("unità serving combinate", s.unitsServing, 3);
  check("unità per la concorrenza (maxSeqs 64)", s.unitsSeqs, 1);
  check("unità acquistate", s.units, 3);
  truthy("il serving combinato è tra i vincoli che legano", (s.bindings || [s.binding]).includes("serving"));
}

console.log("\n— i profili measured battono le stime di bandwidth quando corrispondono —");
{
  const st = baseState();
  const wl = workload(st);
  const spark = st.hardware.find((h) => h.id === "spark-2x");
  const estimated = sizeOption(spark, st, wl, []);
  const matched = sizeOption(spark, st, wl, profiles);
  check("id del profilo corrispondente", matched.profileId, "deepseek-spark-published");
  truthy("il profilo corrispondente cambia l'aggregato rispetto alla stima", matched.aggregate !== estimated.aggregate);
  check("confidence level del profilo", matched.profileConfidence, "published");

  const laguna = baseState();
  laguna.model = { ...models.models.find((m) => m.id === "laguna-s-2-1") };
  laguna.workload.context = 300_000;
  const station = laguna.hardware.find((h) => h.id === "station-gb300");
  const outsideProfile = sizeOption(station, laguna, workload(laguna), profiles);
  check("il profilo fuori dal contesto testato ricade", outsideProfile.profileId, null);
  truthy("il fallback per contesto testato è spiegato",
    outsideProfile.warnings.some((w) => w.includes("tested only")));
}

console.log("\n— il soffitto di concorrenza può diventare il vincolo che lega —");
{
  const st = baseState();
  st.model.maxSeqs = 4;                    // il soffitto comunicato dalla community
  const wl = workload(st);
  const rtx4 = st.hardware.find((h) => h.id === "rtxpro-4x");
  const s = sizeOption(rtx4, st, wl);
  check("unità per la concorrenza a maxSeqs=4", s.unitsSeqs, 5);
  check("il vincolo passa alla concorrenza", s.binding, "concurrency");
  check("unità acquistate", s.units, 5);
}

console.log("\n— un modello che non entra viene segnalato, non dimensionato in silenzio —");
{
  const st = baseState();
  st.model.totalB = 2000;                  // assurdo di proposito
  const wl = workload(st);
  const spark = st.hardware.find((h) => h.id === "spark-2x");
  const s = sizeOption(spark, st, wl);
  truthy("non entra", !s.fits);
  check("token di KV pari a zero", s.kvTokens, 0);
}

console.log("\n— caching del prefill e semantica del prefisso condiviso —");
{
  const uncached = baseState(); uncached.workload.caching = 0;
  const cached = baseState(); cached.workload.caching = 0.9;
  const a = workload(uncached), b = workload(cached);
  truthy("i cache hit riducono il compute di prefill", b.prefillPeak < a.prefillPeak * 0.2);
  check("i cache hit da soli non riducono la KV", b.kvRequired, a.kvRequired);
  cached.workload.prefixSharing = true;
  cached.workload.sharedPrefixTokens = 50_000;
  truthy("un prefisso condiviso esplicito riduce la KV", workload(cached).kvRequired < b.kvRequired);
}

console.log("\n— il carico serving combinato divide il tempo dell'acceleratore —");
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
  check("il decode da solo ne richiede una", s.unitsDecode, 1);
  check("il prefill da solo ne richiede una", s.unitsPrefill, 1);
  check("il carico combinato ne richiede due", s.unitsServing, 2);
  truthy("il serving è il vincolo che lega", s.bindings.includes("serving"));
}

console.log("\n— precisione, validazione e raccomandazione per la produzione —");
{
  const st = baseState();
  st.model = { ...models.models.find((m) => m.id === "deepseek-v4-flash-0731-fp8") };
  const h200 = st.hardware.find((h) => h.id === "h200-4x");
  const fp8 = sizeOption(h200, st, workload(st));
  check("il checkpoint FP8 non è raddoppiato su H200", fp8.weightsGb, 284 * 0.588);

  st.workload.context = st.model.maxContext + 1;
  truthy("un contesto oltre il massimo del modello non è valido", !validateState(st).valid);

  const resilient = baseState();
  resilient.resilience.nPlusOne = true;
  const rtx = resilient.hardware.find((h) => h.id === "rtxpro-2x");
  resilient.model = { ...models.models.find((m) => (m.supportedPrecisions || []).includes("fp8")) || models.models[0] };
  const sr = sizeOption(rtx, resilient, workload(resilient), profiles);
  check("N+1 aggiunge una unità sopra il minimo conservativo",
    sr.recommendedUnits, sr.conservativeMinimumUnits + 1);
  truthy("la raccomandazione N+1 può superare di più di una unità il minimo base",
    sr.recommendedUnits > sr.minimumUnits + 1 || sr.conservativeMinimumUnits === sr.minimumUnits);
}

console.log("\n— eleggibilità e under-provisioning manuale —");
{
  const st = baseState();
  st.agents.count = 100;
  st.manualQty["rtxpro-4x"] = 1;
  const r = compute(st, profiles);
  const manual = r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("una quantità manuale sotto il minimo viene segnalata", manual.cost.underProvisioned);
  truthy("l'opzione under-provisioned non è eleggibile", !manual.eligibility.eligible);
  truthy("i noleggi non-UE restano eleggibili per il confronto dei costi",
    r.options.some((o) => o.kind === "rent" && o.hw.sovereign === false && o.eligibility.eligible));
  truthy("i noleggi non-UE sono etichettati come solo riferimento",
    r.options.some((o) => o.kind === "rent" && o.hw.sovereign === false && o.eligibility.referenceOnly));
  truthy("il confronto con il noleggio può selezionare un noleggio che entra",
    r.bestAlt?.kind === "rent" && r.bestAlt?.sizing?.fits);

  const manualConservative = baseState();
  const spark = manualConservative.hardware.find((h) => h.id === "spark-2x");
  const sparkSizing = sizeOption(spark, manualConservative, workload(manualConservative), profiles);
  manualConservative.manualQty["spark-2x"] = sparkSizing.minimumUnits;
  const sparkOption = compute(manualConservative, profiles).options.find((o) => o.hw.id === "spark-2x");
  truthy("una quantità manuale sotto la raccomandazione conservativa non è eleggibile",
    sparkSizing.conservativeMinimumUnits > sparkSizing.minimumUnits &&
    sparkOption.cost.underProvisioned && !sparkOption.eligibility.eligible);
}

console.log("\n— semantica dei costi —");
{
  const st = baseState();
  const r = compute(st, profiles);
  const rent = r.options.find((o) => o.hw.id === "scaleway-b300-8x");
  check("la temporizzazione del noleggio riconcilia", rent.cost.serviceUpfront + rent.cost.serviceRecurring, rent.cost.service4);

  const media = baseState(); media.workload.images *= 10; media.workload.videoSeconds *= 10;
  const rm = compute(media, profiles);
  check("i media esclusi non cambiano il TCO owned", rm.bestOwn.cost.total, r.bestOwn.cost.total);
  check("i media esclusi non cambiano il TCO della subscription",
    rm.options.find((o) => o.kind === "subscription").cost.total,
    r.options.find((o) => o.kind === "subscription").cost.total);

  const wear = baseState(); wear.mgmt.wearMultiplier = 99;
  check("il vecchio moltiplicatore di usura non cambia più il supporto",
    compute(wear, profiles).options.find((o) => o.hw.id === "rtxpro-4x").cost.support4,
    r.options.find((o) => o.hw.id === "rtxpro-4x").cost.support4);
}

console.log("\n— region match, sensibilità di peakManual e vincolo della raccomandazione —");
{
  const st = baseState();
  st.requirements.regions = ["EU (France)"];
  st.requirements.sovereignOnly = false;
  const r = compute(st, profiles);
  const scaleway = r.options.find((o) => o.hw.id === "scaleway-b300-8x");
  truthy("Scaleway Francia/Olanda rispetta la preferenza di regione EU (France)",
    !scaleway.eligibility.referenceNotes.some((n) => n.includes("preferred regions")));
  truthy("una preferenza di regione corrispondente mantiene il noleggio eleggibile", scaleway.eligibility.eligible);
  const usOnly = baseState();
  usOnly.requirements.regions = ["US"];
  usOnly.requirements.sovereignOnly = false;
  const usScaleway = compute(usOnly, profiles).options.find((o) => o.hw.id === "scaleway-b300-8x");
  truthy("Scaleway fuori da una preferenza solo-US è etichettata come riferimento, non esclusa",
    usScaleway.eligibility.eligible &&
    usScaleway.eligibility.referenceNotes.some((n) => n.includes("preferred regions")));

  const peak = baseState();
  peak.workload.peakManual = 5;
  peak.uncertainty.peakPct = 0.25;
  const band = computeSensitivity(peak, profiles);
  truthy("l'incertezza di peakManual allarga il decode di picco",
    band.conservative.workload.decodePeak >
    band.optimistic.workload.decodePeak);

  const spark = baseState().hardware.find((h) => h.id === "spark-2x");
  const sizing = sizeOption(spark, baseState(), workload(baseState()), profiles);
  truthy("il vincolo della raccomandazione viene riportato quando il conservativo supera la base",
    sizing.recommendationBinding &&
    (sizing.recommendedUnits > sizing.minimumUnits
      ? sizing.conservativeMinimumUnits >= sizing.minimumUnits
      : true));

  const badActive = baseState();
  badActive.model.activeB = badActive.model.totalB + 1;
  truthy("activeB maggiore di totalB non è valido", !validateState(badActive).valid);
}

console.log("\n— sensibilità e invarianti di monotonicità —");
{
  const st = baseState();
  const band = computeSensitivity(st, profiles);
  truthy("il TCO owned conservativo non è inferiore a quello ottimistico",
    band.summaries.conservative.ownTotal >= band.summaries.optimistic.ownTotal);

  const demands = [0.5, 1, 2, 4].map((factor) => {
    const x = baseState();
    x.workload.devIn *= factor;
    x.workload.devOut *= factor;
    const hw = x.hardware.find((h) => h.id === "rtxpro-4x");
    return sizeOption(hw, x, workload(x)).minimumUnits;
  });
  truthy("aumentare la domanda non riduce mai le unità",
    demands.every((value, index) => index === 0 || value >= demands[index - 1]));

  const lowCapacity = baseState();
  const normalHw = lowCapacity.hardware.find((h) => h.id === "rtxpro-4x");
  const slowerHw = { ...normalHw, bandwidth: normalHw.bandwidth / 2 };
  truthy("ridurre la capacità non può ridurre le unità minime",
    sizeOption(slowerHw, lowCapacity, workload(lowCapacity)).minimumUnits >=
    sizeOption(normalHw, lowCapacity, workload(lowCapacity)).minimumUnits);
}

console.log("\n— invarianti di energia, TCO, raccomandazione e dominio —");
{
  const low = baseState();
  low.manualQty["rtxpro-4x"] = 20;
  const high = baseState();
  high.manualQty["rtxpro-4x"] = 20;
  high.workload.devIn *= 3;
  high.workload.devOut *= 3;
  const option = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("l'energia derived cresce con la domanda di serving",
    option(compute(high, profiles)).cost.energy4 > option(compute(low, profiles)).cost.energy4);

  const r = compute(baseState(), profiles);
  truthy("le unità raccomandate non scendono mai sotto il minimo tecnico",
    r.options.filter((o) => o.kind !== "subscription" && o.sizing.fits)
      .every((o) =>
        o.sizing.recommendedUnits >= o.sizing.minimumUnits &&
        o.sizing.recommendedUnits >= o.sizing.conservativeMinimumUnits));
  const own = r.options.find((o) => o.kind === "own" && o.sizing.fits);
  const c = own.cost;
  check("le componenti del TCO riconciliano", c.total,
    c.capex + c.financing - c.residual + c.energy4 + c.mgmt4 + c.support4 +
    c.service4 + c.media4 + c.recurringExtras - c.resaleNet);
  check("il dominio segnala nove unità fuori perimetro", domainCheck(own.hw, 9).verdict, "out-of-domain");
}

console.log("\n— esecuzione completa —");
{
  const r = compute(baseState());
  truthy("c'è un'opzione owned vincente", !!r.bestOwn);
  truthy("c'è un'alternativa", !!r.bestAlt);
  truthy("ogni opzione ha un totale", r.options.every((o) => Number.isFinite(o.cost.total)));
  truthy("l'opzione subscription è presente", r.options.some((o) => o.kind === "subscription"));
  // Le quote e le ore di personale continuative partono da zero; mgmt4 per owned/rented
  // può comunque includere le ore di setup una tantum dal catalogo hardware.
  truthy("le quote di management FTE valgono zero per impostazione predefinita in ogni configurazione",
    r.options.every((o) => (o.cost.mgmtQuota || 0) === 0 && (o.cost.mgmtHoursDay || 0) === 0));
  truthy("le subscription non hanno euro di management quando la quota di piattaforma è zero",
    r.options.find((o) => o.kind === "subscription").cost.mgmt4 === 0);

  // Il confronto relativo appliance vs node sulle ore di personale compare solo quando l'utente opta per le quote.
  const withMgmt = baseState();
  withMgmt.mgmt = {
    platformQuota: 0.15, applianceQuota: 0.035, nodeQuota: 0.12, perUnitQuota: 0.01, automation: 0.4,
  };
  const rm = compute(withMgmt);
  truthy("le opzioni a noleggio costano le stesse ore di management dei nodi owned",
    Math.abs(
      rm.options.find((o) => o.hw.id === "ovh-h200-4x").cost.mgmtQuota -
      rm.options.find((o) => o.hw.id === "h200-4x").cost.mgmtQuota
    ) < 1e-9);
  truthy("gli appliance richiedono meno management dei nodi assemblati",
    rm.options.find((o) => o.hw.id === "station-gb300").cost.mgmtQuota <
    rm.options.find((o) => o.hw.id === "rtxpro-4x").cost.mgmtQuota);
  console.log(`       owned più economico:  ${r.bestOwn.hw.label} — €${Math.round(r.bestOwn.cost.total).toLocaleString()}`);
  console.log(`       alternativa più economica: ${r.bestAlt.hw.label} — €${Math.round(r.bestAlt.cost.total).toLocaleString()}`);
  console.log(`       premio di proprietà:  €${Math.round(r.delta).toLocaleString()} (${(r.premiumActual * 100).toFixed(1)}%)`);
}

console.log("\n— gli agenti autonomi riempiono il metallo invece di aggiungere picchi —");
{
  const a = compute(baseState());
  const stB = baseState(); stB.agents.count = 25;
  const b = compute(stB);
  const own = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("il volume di token cresce nettamente", b.workload.totalTokens > a.workload.totalTokens * 1.5);
  truthy("il costo della subscription cresce con il volume",
    b.options.find((o) => o.kind === "subscription").cost.total >
    a.options.find((o) => o.kind === "subscription").cost.total * 1.4);
  console.log(`       token/anno  ${(a.workload.totalTokens / 1e9).toFixed(0)} B → ${(b.workload.totalTokens / 1e9).toFixed(0)} B`);
  console.log(`       nodo owned €${Math.round(own(a).cost.total).toLocaleString()} → €${Math.round(own(b).cost.total).toLocaleString()}`);
  console.log(`       subscription €${Math.round(a.options.find((o) => o.kind === "subscription").cost.total).toLocaleString()} → €${Math.round(b.options.find((o) => o.kind === "subscription").cost.total).toLocaleString()}`);
}

console.log("\n— l'overage della subscription per le persone segue il volume di token misurato —");
{
  const a = compute(baseState(), profiles);
  const stB = baseState();
  stB.workload.devIn *= 3;
  stB.workload.devOut *= 3;
  const b = compute(stB, profiles);
  const sub = (r) => r.options.find((o) => o.kind === "subscription").cost;
  truthy("l'overage d'uso degli sviluppatori cresce con il volume di token",
    sub(b).devUsageOverage > sub(a).devUsageOverage);
  truthy("il totale della subscription cresce con il volume di token delle persone",
    sub(b).total > sub(a).total);
}

console.log("\n— il resale è disattivato per impostazione predefinita e limitato al margine fattibile —");
{
  const a = compute(baseState());
  const stB = baseState(); stB.resale.enabled = true;
  const b = compute(stB);
  const pick = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  check("nessun margine di resale per impostazione predefinita", pick(a).cost.resaleNet, 0);
  check("il margine di resale riconcilia dopo energia e operazioni",
    pick(b).cost.resaleNet,
    (pick(b).cost.resaleGross - pick(b).cost.resaleEnergy - pick(b).cost.resaleOps) * stB.econ.years);
  check("il resale cambia il TCO in base al suo risultato netto",
    pick(b).cost.total - pick(a).cost.total,
    -pick(b).cost.resaleNet);
  truthy("il resale non si applica ai nodi a noleggio",
    b.options.find((o) => o.hw.id === "ovh-h200-4x").cost.resaleNet === 0);
}

console.log("\n— il prezzo dell'elettricità muove l'energia, non molto altro —");
{
  const a = compute(baseState());
  const stB = baseState(); stB.econ.kwhPrice = 0.50;
  const b = compute(stB);
  const pick = (r) => r.options.find((o) => o.hw.id === "rtxpro-4x");
  truthy("l'energia scala con la tariffa", near(pick(b).cost.energy4 / pick(a).cost.energy4, 0.5 / 0.33, 0.001));
  truthy("l'energia è una minoranza del totale", pick(a).cost.energy4 < pick(a).cost.total * 0.3);
}

console.log("\n— pacchetti —");
{
  const rows = packages(baseState(), [
    { name: "S", employees: 150, aiUsers: 40, tokensOutPerDay: 180000 },
    { name: "M", employees: 300, aiUsers: 80, tokensOutPerDay: 250000 },
  ]);
  truthy("ogni pacchetto si risolve", rows.every((p) => p.feasible));
  truthy("il costo per utente non cresce con la scala",
    rows[1].perUserMonth <= rows[0].perUserMonth * 1.001);
  rows.forEach((p) => console.log(`       ${p.name}: ${p.units}× ${p.option} — €${Math.round(p.perUserMonth)}/utente/mese, seat di pareggio $${Math.round(p.breakEvenSeat)}`));
}

console.log("\n— scoring dei prospect —");
{
  const s1 = scoreProspect({ sectorId: 1, aiUsers: 80, pilotBlocked: false, hasServerRoom: false, filesPatents: false, hyperscalerLock: false }, defaults.sectors, null, 3689);
  const s2 = scoreProspect({ sectorId: 1, aiUsers: 80, pilotBlocked: true, hasServerRoom: true, filesPatents: true, hyperscalerLock: false }, defaults.sectors, null, 2800);
  truthy("il solo settore non basta", s1.total < 70);
  truthy("i trigger lo portano ad alta priorità", s2.total >= 70);
  console.log(`       solo settore: ${s1.total} (${s1.verdict})   ·   con trigger: ${s2.total} (${s2.verdict})`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
