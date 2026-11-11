/**
 * Yardstick MoE duali — abbinamento del profilo, gate di precisione, sanità delle stime.
 * Esegui con: node tests/yardstick.test.mjs
 */
import { readFileSync } from "node:fs";
import { sizeOption, workload, resolvePrecision } from "../src/engine.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const models = read("../data/models.json").models;
const hardware = read("../data/hardware.json").hardware;
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

const byId = (list, id) => list.find((x) => x.id === id);

function stateFor(modelId, context = 8000) {
  return {
    org: { ...defaults.org }, staff: { ...defaults.staff }, mgmt: { ...defaults.mgmt },
    econ: { ...defaults.econ }, workload: { ...defaults.workload, context },
    // Anche il contesto degli agenti alimenta requestedContext in sizeOption — tienilo in range.
    agents: { ...defaults.agents, count: 0, context },
    rental: { ...defaults.rental },
    subs: { ...defaults.subs }, resale: { ...defaults.resale },
    resilience: { ...defaults.resilience }, requirements: { ...defaults.requirements },
    media: { ...defaults.media }, costs: { ...defaults.costs },
    uncertainty: { ...defaults.uncertainty },
    model: { ...byId(models, modelId) },
    hardware: hardware.map((h) => ({ ...h, enabled: true })),
    manualQty: {},
  };
}

const yardsticks = [
  { modelId: "qwen3.6-35b-a3b", hardwareId: "spark-2x", profileId: "qwen36-spark-nvfp4", context: 100000 },
  { modelId: "qwen3.6-35b-a3b", hardwareId: "rtxpro-2x", profileId: "qwen36-rtxpro2-nvfp4", context: 8000 },
  { modelId: "gpt-oss-120b", hardwareId: "b300-1x", profileId: "gptoss-b300-fp4", context: 8000 },
  { modelId: "gpt-oss-120b", hardwareId: "station-gb300", profileId: "gptoss-station-fp4", context: 8000 },
  { modelId: "gpt-oss-120b", hardwareId: "h200-4x", profileId: "gptoss-h200-fp8", context: 8000 },
];

console.log("\n— i profili yardstick vengono abbinati quando il contesto è in range —");
for (const y of yardsticks) {
  const st = stateFor(y.modelId, y.context);
  const hw = byId(st.hardware, y.hardwareId);
  const s = sizeOption(hw, st, workload(st), profiles);
  check(`${y.profileId} abbinato`, s.profileId, y.profileId);
  truthy(`${y.profileId} sta in piedi`, s.fits);
}

console.log("\n— gate di precisione: gpt-oss FP8 su H200, NVFP4 su B300 —");
{
  const gpt = byId(models, "gpt-oss-120b");
  const h200 = byId(hardware, "h200-4x");
  const b300 = byId(hardware, "b300-1x");
  const onH200 = resolvePrecision(gpt, h200);
  const onB300 = resolvePrecision(gpt, b300);
  check("H200 seleziona FP8", onH200.precision, "fp8");
  truthy("H200 è compatibile via fallback FP8", onH200.compatible);
  check("B300 mantiene NVFP4 di default", onB300.precision, "nvfp4");

  const deepseek = byId(models, "deepseek-v4-flash-0731");
  const dsH200 = resolvePrecision(deepseek, h200);
  truthy("DeepSeek solo NVFP4 resta incompatibile su H200", !dsH200.compatible);

  const forced = resolvePrecision(gpt, h200, "nvfp4");
  truthy("L'override esplicito NVFP4 su H200 resta incompatibile", !forced.compatible);
  check("La precisione dell'override esplicito è persistente", forced.precision, "nvfp4");
}

console.log("\n— contesti predefiniti di LocalAI-TCO rispetto al testedContext del profilo —");
{
  const st = stateFor("gpt-oss-120b", defaults.workload.context);
  st.agents = { ...defaults.agents }; // count 0, context 180k — gli agenti idle non devono contare
  const b300 = byId(st.hardware, "b300-1x");
  const s = sizeOption(b300, st, workload(st), profiles);
  check("gpt-oss ricade al contesto persone di default (100k > 32k)", s.profileId, null);
  truthy("Il fallback avvisa su testedContext",
    s.warnings.some((w) => w.includes("testato solo")));

  // La sola finestra idle degli agenti non deve invalidare un profilo.
  const short = stateFor("gpt-oss-120b", 16000);
  short.agents = { ...defaults.agents, count: 0, context: 180000 };
  const shortSizing = sizeOption(b300, short, workload(short), profiles);
  check("Il contesto idle degli agenti è ignorato per l'abbinamento del profilo", shortSizing.profileId, "gptoss-b300-fp4");

  const qwen = stateFor("qwen3.6-35b-a3b", defaults.workload.context);
  qwen.agents = { ...defaults.agents };
  const spark = byId(qwen.hardware, "spark-2x");
  const qs = sizeOption(spark, qwen, workload(qwen), profiles);
  check("Il profilo Qwen Spark è abbinato anche al contesto persone di default", qs.profileId, "qwen36-spark-nvfp4");
}

console.log("\n— Qwen su Spark: stima a singolo stream entro 2× dal minimo del profilo —");
{
  const st = stateFor("qwen3.6-35b-a3b", 100000);
  const spark = byId(st.hardware, "spark-2x");
  const estimated = sizeOption(spark, st, workload(st), []);
  const matched = sizeOption(spark, st, workload(st), profiles);
  const profile = byId(profiles, "qwen36-spark-nvfp4");
  const ratio = Math.max(
    estimated.singleStream / profile.decode.low,
    profile.decode.low / estimated.singleStream
  );
  truthy(
    `stima a singolo stream (${estimated.singleStream.toFixed(1)}) contro il minimo del profilo (${profile.decode.low}) entro 2× (rapporto ${ratio.toFixed(2)})`,
    ratio <= 2
  );
  truthy("Il profilo abbinato sovrascrive l'aggregato rispetto alla stima via bandwidth",
    matched.aggregate === profile.decode.base && matched.aggregate !== estimated.aggregate);
  // L'aggregato con concorrenza supera hardware.batching×singolo stream: è il motivo per cui esiste il profilo.
  truthy("L'aggregato del profilo supera la stima naïve di batching (MTP + concorrenza)",
    profile.decode.base > estimated.singleStream * spark.batching);
}

console.log("\n— un piccolo MoE validato su appliance scala verso SKU datacenter —");
{
  // Qwen ha un profilo Spark published con un forte aggregato con continuous batching.
  // Gli SKU più grandi non devono collassare sul floor pessimistico eff×batching di catalogo.
  const st = stateFor("qwen3.6-35b-a3b", 32000);
  const spark = byId(st.hardware, "spark-2x");
  const sparkSizing = sizeOption(spark, st, workload(st), profiles);
  const sparkFactor = sparkSizing.aggregate / sparkSizing.theoretical;

  for (const hwId of ["station-gb300", "rtxpro-4x", "b300-1x", "h200-4x"]) {
    const hw = byId(st.hardware, hwId);
    const s = sizeOption(hw, st, workload(st), profiles);
    const catalogueAgg = s.theoretical * hw.efficiency * hw.batching;
    truthy(`${hwId} regge Qwen`, s.fits);
    truthy(`${hwId} aggregato sopra il soglia di catalogo`, s.aggregate > catalogueAgg * 1.05);
    truthy(`${hwId} trasferimento avvisato`,
      s.warnings.some((w) => w.includes("continuous-batching") || w.includes("transferred")));
    // Il fattore trasferito resta sotto il fattore di produzione grezzo dello Spark (haircut).
    truthy(`${hwId} fattore di produzione sotto il fattore grezzo dello Spark`,
      s.productionFactor < sparkFactor);
  }

  // Fattore Spark di DeepSeek ≈ eff×batching di catalogo — il trasferimento non deve inventare uplift.
  const ds = stateFor("deepseek-v4-flash-0731", 32000);
  const station = byId(ds.hardware, "station-gb300");
  const dsStation = sizeOption(station, ds, workload(ds), profiles);
  const dsCatalogue = dsStation.theoretical * station.efficiency * station.batching;
  check("DeepSeek Station resta sul soglia di catalogo", dsStation.aggregate, dsCatalogue, 0.001);
}

console.log("\n— default di prodotto e risoluzione KV di DeepSeek —");
{
  check("models[0] è Qwen3.6 35B-A3B", models[0].id, "qwen3.6-35b-a3b");
  const ds = byId(models, "deepseek-v4-flash-0731");
  check("Lo stato KV NVFP4 di DeepSeek è risolto", ds.kvKbRange.status, "resolved");
  check("Valore base KV NVFP4 di DeepSeek", ds.kvKbPerToken, 27.77);
  const q35 = byId(models, "qwen3.5-397b-a17b");
  const b3004 = byId(hardware, "b300-4x");
  const st = stateFor("qwen3.5-397b-a17b", 4096);
  const s = sizeOption(b3004, st, workload(st), profiles);
  check("Qwen3.5 è abbinato al profilo b300-4x", s.profileId, "qwen35-b300-4x-nvfp4");
  truthy("Qwen3.5 regge su 4x B300", s.fits);
  truthy("il modello qwen3.5 è presente", Boolean(q35));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
