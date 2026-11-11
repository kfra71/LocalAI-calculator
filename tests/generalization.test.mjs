/**
 * Generalizzazione dell'engine — modelli/configurazioni futuri sintetici, nessun id di catalogo.
 * Esegui con: node tests/generalization.test.mjs
 */
import {
  resolvePrecision, resolveProfile, requestedProfileContext,
  sizeOption, modelDerived, validateState, siblingProductionFactor,
  SIBLING_TRANSFER_HAIRCUT_SAME,
} from "../src/engine.js";

let pass = 0, fail = 0;
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= Math.abs(b) * tol + 1e-9;
function check(name, actual, expected, tol) {
  const ok = typeof expected === "number" ? near(actual, expected, tol) : actual === expected;
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  got ${actual}  want ${expected}`); }
}
function truthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const bareState = (model, extras = {}) => ({
  model,
  workload: { context: 4096, caching: 0, ...(extras.workload || {}) },
  agents: { count: 0, context: 128000, ...(extras.agents || {}) },
  resale: { mix: 0 },
  resilience: { targetUtilization: 1 },
  ...extras,
});

console.log("\n— precisione: override persistente, fallback più denso, byte mappati —");
{
  const model = {
    defaultPrecision: "nvfp4",
    supportedPrecisions: ["bf16", "fp8", "nvfp4"], // volutamente non ordinato
    bytesPerParam: 0.5,
    bytesPerParamByPrecision: { nvfp4: 0.5, fp8: 1.0, bf16: 2.0 },
  };
  const hopper = { supportedPrecisions: ["fp8", "bf16"], fp4: false };
  const blackwell = { supportedPrecisions: ["nvfp4", "fp8", "bf16"], fp4: true };

  check("Blackwell mantiene NVFP4 di default", resolvePrecision(model, blackwell).precision, "nvfp4");
  check("Hopper ricade su FP8 e non su BF16", resolvePrecision(model, hopper).precision, "fp8");
  truthy("Il fallback su Hopper è segnalato", resolvePrecision(model, hopper).fellBack);
  check("Byte per FP8 su Hopper", resolvePrecision(model, hopper).bytesPerParam, 1.0);
  truthy("Override persistente non supportato", !resolvePrecision(model, hopper, "nvfp4").compatible);

  const noMap = {
    defaultPrecision: "nvfp4",
    supportedPrecisions: ["nvfp4", "fp8"],
    bytesPerParam: 0.5,
    // fp8 assente di proposito
  };
  truthy("Fallback senza mappa dei byte incompatibile",
    !resolvePrecision(noMap, hopper).compatible);

  const onlyFp8 = {
    defaultPrecision: "fp8",
    supportedPrecisions: ["fp8"],
    bytesPerParam: 1,
    bytesPerParamByPrecision: { fp8: 1 },
  };
  truthy("Modello a singola precisione incompatibile su HW non supportato",
    !resolvePrecision(onlyFp8, { supportedPrecisions: ["nvfp4"] }).compatible);
}

console.log("\n— il contesto del profilo ignora le finestre idle degli agenti —");
{
  const st = bareState({ id: "m" }, {
    workload: { context: 8000 },
    agents: { count: 0, context: 200000 },
  });
  check("Contesto solo persone", requestedProfileContext(st), 8000);
  st.agents.count = 3;
  check("Gli agenti alzano il contesto richiesto", requestedProfileContext(st), 200000);
}

console.log("\n— la scelta multi-profilo preferisce la confidence più forte —");
{
  const model = { id: "future-moe" };
  const hw = { id: "future-node" };
  const profiles = [
    {
      id: "weak", modelId: "future-moe", hardwareId: "future-node",
      confidence: "community",
      decode: { low: 100, base: 100, high: 100 },
      prefill: { low: 1000, base: 1000, high: 1000 },
      testedContext: 8192,
    },
    {
      id: "strong", modelId: "future-moe", hardwareId: "future-node",
      confidence: "published",
      decode: { low: 200, base: 200, high: 200 },
      prefill: { low: 2000, base: 2000, high: 2000 },
      testedContext: 8192,
    },
  ];
  check("Preferisce published su community", resolveProfile(model, hw, profiles).id, "strong");
  check("L'override vince comunque",
    resolveProfile(model, hw, profiles, "weak").id, "weak");
}

console.log("\n— MoE futuri sintetici dimensionati su una nuova SKU —");
{
  const model = {
    id: "future-120a10",
    totalB: 120, activeB: 10, bytesPerParam: 0.5,
    defaultPrecision: "nvfp4",
    supportedPrecisions: ["nvfp4", "fp8"],
    bytesPerParamByPrecision: { nvfp4: 0.5, fp8: 1.0 },
    kvKbPerToken: 20, specTokens: 1, prefillRatio: 20,
    maxSeqs: 32, overheadPerGpu: 8, maxContext: 131072,
  };
  const hw = {
    id: "future-b400-2x",
    gpus: 2, memGb: 400, bandwidth: 10000, efficiency: 0.1, batching: 4,
    prefill: 40000, memReserveGb: 16,
    supportedPrecisions: ["nvfp4", "fp8"], fp4: true,
  };
  const st = bareState(model, { workload: { context: 16000, caching: 0.5 } });
  const wl = {
    decodePeak: 500, prefillPeak: 2000, kvRequired: 500_000, sessionsTotal: 10,
  };
  const estimated = sizeOption(hw, st, wl, []);
  truthy("La coppia futura sta in piedi solo su architettura", estimated.fits);
  check("Pesi", estimated.weightsGb, 60);
  check("GB/token = quota attiva", estimated.gbPerToken, 5); // 60 * 10/120
  truthy("Il vincolo è uno dei tre limiti",
    ["kv", "serving", "concurrency"].some((b) => estimated.bindings.includes(b)));

  const profiles = [{
    id: "future-measured",
    modelId: "future-120a10", hardwareId: "future-b400-2x",
    confidence: "measured",
    decode: { low: 800, base: 1000, high: 1200 },
    prefill: { low: 30000, base: 40000, high: 50000 },
    maxSeqs: 16, testedContext: 32768,
  }];
  const matched = sizeOption(hw, st, wl, profiles);
  check("Il profilo futuro viene abbinato", matched.profileId, "future-measured");
  check("Si usa l'aggregato del profilo", matched.aggregate, 1000);

  st.workload.context = 64000;
  const outside = sizeOption(hw, st, wl, profiles);
  check("Un contesto lungo fa cadere il profilo", outside.profileId, null);
  truthy("Il contesto lungo spiega testedContext",
    outside.warnings.some((w) => w.includes("tested only")));
}

console.log("\n— volume letto: dense vs MoE —");
{
  const dense = modelDerived(
    { totalB: 70, activeB: 70, bytesPerParam: 1, specTokens: 1,
      supportedPrecisions: ["fp8"], defaultPrecision: "fp8",
      bytesPerParamByPrecision: { fp8: 1 } },
    { supportedPrecisions: ["fp8"] }
  );
  const moe = modelDerived(
    { totalB: 70, activeB: 7, bytesPerParam: 1, specTokens: 1,
      supportedPrecisions: ["fp8"], defaultPrecision: "fp8",
      bytesPerParamByPrecision: { fp8: 1 } },
    { supportedPrecisions: ["fp8"] }
  );
  check("Stesso ingombro", dense.weightsGb, moe.weightsGb);
  check("Il MoE legge 10× meno per token", dense.gbPerToken / moe.gbPerToken, 10);
}

console.log("\n— validateState resta agnostico rispetto al modello —");
{
  const st = bareState({
    totalB: 10, activeB: 12, kvKbPerToken: 1, specTokens: 1, maxContext: 1000,
  }, {
    org: { workDays: 220, workHours: 8 },
    econ: { years: 4 },
    staff: { hoursYear: 1720 },
    hardware: [{ id: "x", label: "x", memGb: 10, bandwidth: 10, gpus: 1 }],
  });
  truthy("activeB > totalB viene rifiutato", !validateState(st).valid);
}

console.log("\n— il fattore di produzione dei sibling scala i modelli validati su appliance —");
{
  const model = {
    id: "tiny-moe",
    totalB: 30, activeB: 3, bytesPerParam: 0.5, specTokens: 1,
    defaultPrecision: "nvfp4", supportedPrecisions: ["nvfp4"],
    bytesPerParamByPrecision: { nvfp4: 0.5 },
    kvKbPerToken: 10, maxSeqs: 64, overheadPerGpu: 4, maxContext: 65536,
  };
  const spark = {
    id: "spark-like", gpus: 2, memGb: 200, bandwidth: 500,
    efficiency: 0.16, batching: 1.6, prefill: 2000, memReserveGb: 0,
    supportedPrecisions: ["nvfp4"], fp4: true,
  };
  const station = {
    id: "hbm-like", gpus: 1, memGb: 280, bandwidth: 7000,
    efficiency: 0.035, batching: 9.6, prefill: 40000, memReserveGb: 0,
    supportedPrecisions: ["nvfp4"], fp4: true,
  };
  // Profilo appliance: aggregato alto con continuous batching (classe vLLM).
  // teorico su spark = 500 / (30*0.5*3/30) = 500 / 1.5 ≈ 333.3
  // base 200 → fattore grezzo ≈ 0.60; fattore spark di catalogo 0.16*1.6=0.256
  const profiles = [{
    id: "tiny-spark-pub",
    modelId: "tiny-moe", hardwareId: "spark-like",
    confidence: "published",
    decode: { low: 50, base: 200, high: 250 },
    prefill: { low: 1000, base: 2000, high: 2000 },
    testedContext: 65536,
  }];
  const st = bareState(model);
  st.hardware = [spark, station];
  const sib = siblingProductionFactor(model, station, st, profiles);
  truthy("Trova il sibling spark", Boolean(sib));
  check("Applica lo stesso haircut di precisione", sib.haircut, SIBLING_TRANSFER_HAIRCUT_SAME);
  truthy("Il fattore trasferito batte il soglia di catalogo",
    sib.factor > station.efficiency * station.batching);

  const wl = { decodePeak: 800, prefillPeak: 2000, kvRequired: 100000, sessionsTotal: 8 };
  const onStation = sizeOption(station, st, wl, profiles);
  const catalogueAgg = (7000 / 1.5) * station.efficiency * station.batching;
  truthy("L'aggregato sulla station supera la stima di catalogo",
    onStation.aggregate > catalogueAgg * 1.2);
  check("La confidence diventa derived durante il trasferimento", onStation.profileConfidence, "derived");
  truthy("Avvisa sul trasferimento di classe vLLM",
    onStation.warnings.some((w) => w.includes("continuous-batching")));

  // Il fattore di catalogo è già più alto → non deve abbassarlo.
  const lowBatchProfiles = [{
    ...profiles[0],
    decode: { low: 10, base: 20, high: 30 }, // fattore ~0.06 < station 0.336
  }];
  const noRaise = sizeOption(station, st, wl, lowBatchProfiles);
  check("Non abbassa mai il soglia di catalogo", noRaise.aggregate, catalogueAgg, 0.001);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
