/**
 * Dual MoE yardsticks — profile match, precision gate, estimate sanity.
 * Run with: node tests/yardstick.test.mjs
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
    // Agent context also feeds requestedContext in sizeOption — keep it in-range.
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

console.log("\n— yardstick profiles match when context is in range —");
for (const y of yardsticks) {
  const st = stateFor(y.modelId, y.context);
  const hw = byId(st.hardware, y.hardwareId);
  const s = sizeOption(hw, st, workload(st), profiles);
  check(`${y.profileId} matched`, s.profileId, y.profileId);
  truthy(`${y.profileId} fits`, s.fits);
}

console.log("\n— precision gate: gpt-oss FP8 on H200, NVFP4 on B300 —");
{
  const gpt = byId(models, "gpt-oss-120b");
  const h200 = byId(hardware, "h200-4x");
  const b300 = byId(hardware, "b300-1x");
  const onH200 = resolvePrecision(gpt, h200);
  const onB300 = resolvePrecision(gpt, b300);
  check("H200 selects FP8", onH200.precision, "fp8");
  truthy("H200 is compatible via FP8 fallback", onH200.compatible);
  check("B300 keeps NVFP4 default", onB300.precision, "nvfp4");

  const deepseek = byId(models, "deepseek-v4-flash-0731");
  const dsH200 = resolvePrecision(deepseek, h200);
  truthy("DeepSeek NVFP4-only still incompatible on H200", !dsH200.compatible);

  const forced = resolvePrecision(gpt, h200, "nvfp4");
  truthy("explicit NVFP4 override on H200 stays incompatible", !forced.compatible);
  check("explicit override precision is sticky", forced.precision, "nvfp4");
}

console.log("\n— default Bindwidth contexts vs profile testedContext —");
{
  const st = stateFor("gpt-oss-120b", defaults.workload.context);
  st.agents = { ...defaults.agents }; // count 0, context 180k — idle agents must not count
  const b300 = byId(st.hardware, "b300-1x");
  const s = sizeOption(b300, st, workload(st), profiles);
  check("gpt-oss falls back at default people context (100k > 32k)", s.profileId, null);
  truthy("fallback warns about testedContext",
    s.warnings.some((w) => w.includes("tested only")));

  // Idle agent window alone must not invalidate a profile.
  const short = stateFor("gpt-oss-120b", 16000);
  short.agents = { ...defaults.agents, count: 0, context: 180000 };
  const shortSizing = sizeOption(b300, short, workload(short), profiles);
  check("idle agent context ignored for profile match", shortSizing.profileId, "gptoss-b300-fp4");

  const qwen = stateFor("qwen3.6-35b-a3b", defaults.workload.context);
  qwen.agents = { ...defaults.agents };
  const spark = byId(qwen.hardware, "spark-2x");
  const qs = sizeOption(spark, qwen, workload(qwen), profiles);
  check("Qwen Spark profile still matches default people context", qs.profileId, "qwen36-spark-nvfp4");
}

console.log("\n— Qwen on Spark: single-stream estimate within 2× of profile low —");
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
    `single-stream estimate (${estimated.singleStream.toFixed(1)}) vs profile low (${profile.decode.low}) within 2× (ratio ${ratio.toFixed(2)})`,
    ratio <= 2
  );
  truthy("matched profile overrides aggregate vs bandwidth estimate",
    matched.aggregate === profile.decode.base && matched.aggregate !== estimated.aggregate);
  // Aggregate at concurrency exceeds hardware.batching×single-stream; that is why the profile exists.
  truthy("profile aggregate exceeds naive batching estimate (MTP + concurrency)",
    profile.decode.base > estimated.singleStream * spark.batching);
}

console.log("\n— appliance-validated small MoE scales to datacenter SKUs —");
{
  // Qwen has a published Spark profile with strong continuous-batching aggregate.
  // Larger SKUs should not collapse to the pessimistic catalogue eff×batching floor.
  const st = stateFor("qwen3.6-35b-a3b", 32000);
  const spark = byId(st.hardware, "spark-2x");
  const sparkSizing = sizeOption(spark, st, workload(st), profiles);
  const sparkFactor = sparkSizing.aggregate / sparkSizing.theoretical;

  for (const hwId of ["station-gb300", "rtxpro-4x", "b300-1x", "h200-4x"]) {
    const hw = byId(st.hardware, hwId);
    const s = sizeOption(hw, st, workload(st), profiles);
    const catalogueAgg = s.theoretical * hw.efficiency * hw.batching;
    truthy(`${hwId} fits Qwen`, s.fits);
    truthy(`${hwId} aggregate above catalogue floor`, s.aggregate > catalogueAgg * 1.05);
    truthy(`${hwId} transfer warned`,
      s.warnings.some((w) => w.includes("continuous-batching") || w.includes("transferred")));
    // Transferred factor stays below the raw Spark production factor (haircut).
    truthy(`${hwId} production factor below raw Spark factor`,
      s.productionFactor < sparkFactor);
  }

  // DeepSeek Spark factor ≈ catalogue eff×batching — transfer must not invent uplift.
  const ds = stateFor("deepseek-v4-flash-0731", 32000);
  const station = byId(ds.hardware, "station-gb300");
  const dsStation = sizeOption(station, ds, workload(ds), profiles);
  const dsCatalogue = dsStation.theoretical * station.efficiency * station.batching;
  check("DeepSeek Station stays on catalogue floor", dsStation.aggregate, dsCatalogue, 0.001);
}

console.log("\n— product default and DeepSeek KV resolution —");
{
  check("models[0] is Qwen3.6 35B-A3B", models[0].id, "qwen3.6-35b-a3b");
  const ds = byId(models, "deepseek-v4-flash-0731");
  check("DeepSeek NVFP4 KV status resolved", ds.kvKbRange.status, "resolved");
  check("DeepSeek NVFP4 KV base", ds.kvKbPerToken, 27.77);
  const q35 = byId(models, "qwen3.5-397b-a17b");
  const b3004 = byId(hardware, "b300-4x");
  const st = stateFor("qwen3.5-397b-a17b", 4096);
  const s = sizeOption(b3004, st, workload(st), profiles);
  check("Qwen3.5 matches b300-4x profile", s.profileId, "qwen35-b300-4x-nvfp4");
  truthy("Qwen3.5 fits 4x B300", s.fits);
  truthy("qwen3.5 model present", Boolean(q35));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
