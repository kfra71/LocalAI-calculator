import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
const files = ["data/defaults.json", "data/models.json", "data/hardware.json", "data/benchmarks.json", "data/profiles.json"];
const confidence = new Set([
  "measured", "published", "community", "list-price", "aggregator",
  "estimated", "template", "derived", "kv-derived",
]);
let pass = 0, fail = 0;
const check = (name, condition) => {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

for (const file of files) {
  const data = read(file);
  const schema = resolve(dirname(resolve(root, file)), data.$schema || "");
  check(`${file} schema esiste`, Boolean(data.$schema) && existsSync(schema));
  if (existsSync(schema)) {
    const definition = JSON.parse(readFileSync(schema, "utf8"));
    check(`${file} soddisfa i campi obbligatori di primo livello`,
      (definition.required || []).every((key) => Object.hasOwn(data, key)));
    for (const [key, property] of Object.entries(definition.properties || {})) {
      if (property.type === "array" && property.items?.required && Array.isArray(data[key])) {
        check(`${file} le voci di ${key} soddisfano i campi obbligatori`,
          data[key].every((entry) => property.items.required.every((field) => Object.hasOwn(entry, field))));
      }
    }
  }
}

const models = read("data/models.json").models;
const hardware = read("data/hardware.json").hardware;
const benchmarks = read("data/benchmarks.json").benchmarks;
const profiles = read("data/profiles.json").profiles;
const unique = (items) => new Set(items.map((x) => x.id)).size === items.length;

check("gli id dei modelli sono univoci", unique(models));
check("gli id dell'hardware sono univoci", unique(hardware));
check("gli id dei benchmark sono univoci", unique(benchmarks));
check("gli id dei profili sono univoci", unique(profiles));
check("tutti i valori di confidence level usano la tassonomia prevista",
  [...models, ...hardware, ...benchmarks, ...profiles].every((x) => confidence.has(x.confidence)));
check("tutte le unità dei modelli sono positive",
  models.every((m) => m.totalB > 0 && m.activeB > 0 && m.kvKbPerToken > 0 && m.maxContext > 0));
check("tutte le capacità dell'hardware sono positive",
  hardware.every((h) => h.memGb > 0 && h.bandwidth > 0 && h.supportedPrecisions.length > 0));
check("gli intervalli dei profili sono ordinati",
  profiles.every((p) =>
    p.decode.low <= p.decode.base && p.decode.base <= p.decode.high &&
    p.prefill.low <= p.prefill.base && p.prefill.base <= p.prefill.high));
check("i campi dei profili a confidence level misto indicano la loro fonte",
  profiles.every((p) => !p.prefillConfidence || Boolean(p.prefillSource)));
check("i riferimenti dei profili si risolvono",
  profiles.every((p) =>
    models.some((m) => m.id === p.modelId) &&
    hardware.some((h) => h.id === p.hardwareId) &&
    benchmarks.some((b) => b.id === p.sourceBenchmark)));
check("il default di prodotto models[0] è Qwen3.6 35B-A3B", models[0].id === "qwen3.6-35b-a3b");
const deepseekNvfp4 = models.find((m) => m.id === "deepseek-v4-flash-0731");
check("la contraddizione KV di DeepSeek NVFP4 è risolta",
  deepseekNvfp4?.kvKbRange?.status === "resolved" &&
  deepseekNvfp4.kvKbPerToken === 27.77 &&
  deepseekNvfp4.kvKbRange.low === deepseekNvfp4.kvKbRange.high);
check("il KV FP8 di DeepSeek resta sulla sua voce dedicata",
  models.find((m) => m.id === "deepseek-v4-flash-0731-fp8")?.kvKbPerToken === 10.6);
check("i modelli yardstick e flagship sono presenti",
  models.some((m) => m.id === "qwen3.6-35b-a3b") &&
  models.some((m) => m.id === "gpt-oss-120b") &&
  models.some((m) => m.id === "qwen3.5-397b-a17b"));
check("lo SKU multi-GPU b300-4x esiste", hardware.some((h) => h.id === "b300-4x" && h.gpus === 4));
check("i profileIds dei modelli si risolvono",
  models.every((m) => (m.profileIds || []).every((id) => profiles.some((p) => p.id === id))));
check("i profileIds dell'hardware si risolvono",
  hardware.every((h) => (h.profileIds || []).every((id) => profiles.some((p) => p.id === id))));
check("i profili yardstick coprono gli SKU appliance e datacenter",
  ["qwen36-spark-nvfp4", "qwen36-rtxpro2-nvfp4", "gptoss-b300-fp4", "gptoss-station-fp4", "gptoss-h200-fp8", "qwen35-b300-4x-nvfp4"]
    .every((id) => profiles.some((p) => p.id === id)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
