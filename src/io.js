/**
 * Save and reload a scenario. No server, no storage, no account —
 * a file on your disk is the whole persistence layer.
 */
import { validateState } from "./engine.js";

export const SCHEMA_VERSION = 2;
export const APP_NAME = "LocalAI-TCO";
export const APP_TAGLINE = "Size your way to private local AI";

const V2_DEFAULTS = {
  workload: {
    sharedPrefixTokens: 0, prefixSharing: false,
    devConcurrency: 0.6, adminConcurrency: 0.15, marketingConcurrency: 0.15,
  },
  agents: { sharedPrefixTokens: 0, prefixSharing: false },
  resilience: { targetUtilization: 0.85, maintenanceReserve: 0, nPlusOne: false },
  requirements: {
    sovereignOnly: true,
    regions: ["EU"],
    requireEquivalentCapability: false,
    minimumConfidence: "estimated",
  },
  media: { scope: "excluded", ownedAnnualCost: 0 },
  costs: {
    networkAnnual: 0, storageAnnual: 0, softwareAnnual: 0,
    financingRate: 0, residualShare: 0, replacementReserveAnnual: 0,
    energyMode: "derived", modelLifeYears: 4,
  },
  uncertainty: {
    peakPct: 0.2, managementPct: 0.25, pricePct: 0.15,
    modelLifeLow: 3, modelLifeHigh: 5,
  },
  profileOverrides: {},
  manualQty: {},
};

const SCENARIO_PATCH_KEYS = ["org", "workload", "agents", "mgmt", "resilience", "requirements"];

/**
 * Apply a guided-setup preset patch onto an existing state.
 * Deep-merges sizing-relevant objects and sets scenarioName.
 * Leaves model, hardware, economics, and staff rates untouched.
 * Guided presets reset mgmt quotas to zero so management cost starts off.
 */
export function applyScenarioPatch(state, patch) {
  if (!state || !patch) {
    throw new Error("applyScenarioPatch requires a state object and a patch.");
  }
  const next = { ...state };
  if (typeof patch.scenarioName === "string") {
    next.scenarioName = patch.scenarioName;
  }
  for (const key of SCENARIO_PATCH_KEYS) {
    if (patch[key] && typeof patch[key] === "object") {
      next[key] = { ...(state[key] || {}), ...patch[key] };
    }
  }
  return next;
}

export function migratePayload(payload) {
  const from = Number(payload.schemaVersion || 1);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `This scenario was saved by a newer version (schema ${from}). Update the tool and try again.`
    );
  }
  if (!payload.state) {
    throw new Error("This file has no scenario in it. Expected a key named 'state'.");
  }
  const state = JSON.parse(JSON.stringify(payload.state));
  const migrationsApplied = [];
  for (const [key, value] of Object.entries(V2_DEFAULTS)) {
    state[key] = { ...value, ...(state[key] || {}) };
  }
  if (from < 2) {
    state.hardware = (state.hardware || []).map((hw) => ({
      ...hw,
      supportedPrecisions: hw.supportedPrecisions ||
        (hw.fp4 ? ["nvfp4", "fp8", "bf16"] : ["fp8", "bf16"]),
      memReserveGb: hw.memReserveGb || 0,
    }));
    state.model = {
      defaultPrecision: state.model.defaultPrecision ||
        (/fp8/i.test(state.model.quantLabel || "") ? "fp8" : "nvfp4"),
      supportedPrecisions: state.model.supportedPrecisions || [
        /fp8/i.test(state.model.quantLabel || "") ? "fp8" : "nvfp4",
      ],
      bytesPerParamByPrecision: state.model.bytesPerParamByPrecision || {},
      ...state.model,
    };
    if (!Object.keys(state.model.bytesPerParamByPrecision || {}).length) {
      state.model.bytesPerParamByPrecision = {
        [state.model.defaultPrecision]: state.model.bytesPerParam,
      };
    }
    migrationsApplied.push("v1-to-v2");
  }
  if (!Array.isArray(state.hardware) || !state.hardware.length || !state.model) {
    throw new Error("The scenario must include a selected model and at least one hardware option.");
  }
  const validation = validateState(state);
  if (!validation.valid) {
    throw new Error(`The imported scenario is invalid: ${validation.errors.join(" ")}`);
  }
  return { ...payload, schemaVersion: SCHEMA_VERSION, state, migrationsApplied };
}

const nf = (n, d = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (n) => (Number.isFinite(n) ? "€" + nf(Math.round(n)) : "—");
const pct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "—");

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

export function buildExportPayload(state, results) {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_NAME,
    savedAt: new Date().toISOString(),
    scenarioName: state.scenarioName || "Untitled scenario",
    state,
    summary: results
      ? {
          bestOwn: results.bestOwn?.hw.label ?? null,
          bestOwnTotal: results.bestOwn?.cost.total ?? null,
          bestAlt: results.bestAlt?.hw.label ?? null,
          bestAltTotal: results.bestAlt?.cost.total ?? null,
          delta: results.delta,
          totalTokensPerYear: results.workload.totalTokens,
          validation: results.validation,
          resilience: state.resilience,
          requirements: state.requirements,
          options: results.options.map((o) => ({
            id: o.hw.id,
            label: o.hw.label,
            kind: o.kind,
            eligible: o.eligibility?.eligible ?? true,
            eligibilityReasons: o.eligibility?.reasons ?? [],
            referenceOnly: o.eligibility?.referenceOnly ?? false,
            referenceNotes: o.eligibility?.referenceNotes ?? [],
            profileId: o.sizing.profileId ?? null,
            profileConfidence: o.sizing.profileConfidence ?? o.hw.confidence ?? null,
            precision: o.sizing.precision ?? null,
            warnings: o.sizing.warnings ?? [],
            binding: o.sizing.binding,
            recommendationBinding: o.sizing.recommendationBinding,
            minimumUnits: o.sizing.minimumUnits,
            conservativeMinimumUnits: o.sizing.conservativeMinimumUnits,
            recommendedUnits: o.sizing.recommendedUnits,
            uncertaintyBands: o.sizing.bands ?? null,
            perMToken: o.perMToken,
            perMInput: o.perMInput,
            perMOutput: o.perMOutput,
            total: o.cost.total,
          })),
        }
      : null,
  };
}

export function exportJson(state, results) {
  const payload = buildExportPayload(state, results);
  download(
    `localai-tco-${(state.scenarioName || "scenario").replace(/\W+/g, "-").toLowerCase()}-${stamp()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json"
  );
}

export function importJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch {
        reject(new Error("This is not valid JSON. Check the file and try again."));
        return;
      }
      try {
        resolve(migratePayload(data));
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsText(file);
  });
}

export function buildMarkdown(state, r) {
  const st = state;
  const L = [];
  const push = (...x) => L.push(...x);

  push(`# ${st.scenarioName || "LocalAI-TCO scenario"}`, "");
  push(
    `Generated ${new Date().toISOString().slice(0, 10)} with ${APP_NAME}.`,
    `Scenario schema ${SCHEMA_VERSION}. Directional estimate, not a procurement quote.`,
    `Horizon ${st.econ.years} years. All figures exclude VAT.`,
    ""
  );

  /* --- verdict ------------------------------------------------------ */
  push("## What the model says", "");
  if (r.bestOwn && r.bestAlt) {
    push(
      `Cheapest owned configuration: **${r.bestOwn.hw.label}** at **${eur(r.bestOwn.cost.total)}**` +
        ` (${r.bestOwn.cost.qty} unit${r.bestOwn.cost.qty === 1 ? "" : "s"}, technical minimum ` +
        `${r.bestOwn.sizing.minimumUnits} · ${r.bestOwn.sizing.binding}, conservative recommendation ` +
        `${r.bestOwn.sizing.recommendedUnits} · ${r.bestOwn.sizing.recommendationBinding || r.bestOwn.sizing.binding}).`,
      `Cheapest eligible alternative: **${r.bestAlt.hw.label}** at **${eur(r.bestAlt.cost.total)}**.`,
      `Difference: **${eur(r.delta)}** over ${st.econ.years} years, ` +
        `${eur(r.perHeadOwn)} vs ${eur(r.perHeadAlt)} per head per year.`,
      ""
    );
    if (r.premiumActual !== null) {
      push(
        `Ownership premium: **${pct(r.premiumActual)}** against the configured acceptable premium of ${pct(r.premiumAccepted)}.` +
          (r.premiumActual > r.premiumAccepted
            ? " Above the threshold — this needs an explicit non-economic driver."
            : " Within the scenario-specific threshold configured for this organisation."),
        ""
      );
    }
  }
  push("### Comparability and eligibility", "");
  push(
    "Options are compared on the same workload shape, not guaranteed model quality, latency, context, tools, availability, or legal suitability.",
    `Prefer sovereign alternatives: ${st.requirements?.sovereignOnly ? "yes" : "no"}.`,
    "EU / region preference for rentals is labelled for reference only and does not exclude them from the cost comparison.",
    ""
  );
  const referenced = r.options.filter((o) => o.eligibility?.referenceOnly);
  if (referenced.length) {
    push("Reference rentals:", "");
    push(...referenced.map((o) => `- ${o.hw.label}: ${o.eligibility.referenceNotes.join(" ")}`), "");
  }
  const excluded = r.options.filter((o) => o.eligibility && !o.eligibility.eligible);
  if (excluded.length) {
    push(...excluded.map((o) => `- ${o.hw.label}: ${o.eligibility.reasons.join(" ")}`), "");
  }
  if (r.validation?.warnings?.length) {
    push("### Model warnings", "", ...r.validation.warnings.map((x) => `- ${x}`), "");
  }
  push("### Rental cash-flow timing", "");
  push(
    `Reserved discount: ${pct(st.rental.reserveDiscount)}. Upfront allocation: ${pct(st.rental.upfrontShare)}.`,
    "The upfront allocation changes payment timing, not undiscounted total commitment.",
    ""
  );
  for (const o of r.options.filter((x) => x.kind === "rent")) {
    push(`- ${o.hw.label}: ${eur(o.cost.serviceUpfront)} upfront; ${eur(o.cost.serviceRecurring)} recurring.`);
  }
  push("");

  /* --- inputs ------------------------------------------------------- */
  push("## Inputs", "");
  push("### Organisation", "");
  push("| Parameter | Value |", "|---|---|");
  push(`| Developers | ${nf(st.org.devs)} |`);
  push(`| Marketing / sales | ${nf(st.org.marketing)} |`);
  push(`| Administrative | ${nf(st.org.admin)} |`);
  push(`| Working days per year | ${nf(st.org.workDays)} |`);
  push(`| Productive hours per day | ${nf(st.org.workHours)} |`);
  push("");

  push("### Autonomous agents", "");
  push("| Parameter | Value |", "|---|---|");
  push(`| Concurrent agents | ${nf(st.agents.count)} |`);
  push(`| Active hours per day | ${nf(st.agents.hoursDay)} |`);
  push(`| Active days per year | ${nf(st.agents.daysYear)} |`);
  push(`| Input tokens per agent-hour | ${nf(st.agents.inPerHour)} |`);
  push(`| Output tokens per agent-hour | ${nf(st.agents.outPerHour)} |`);
  push(`| Cache hit rate | ${pct(st.agents.caching)} |`);
  push(`| Average resident context | ${nf(st.agents.context)} tokens |`);
  push(`| Peak factor | ${st.agents.peakFactor.toFixed(2)}× |`);
  push("");

  push("### Model", "");
  push("| Parameter | Value |", "|---|---|");
  push(`| Name | ${st.model.name} |`);
  push(`| Quantisation | ${st.model.quantLabel} |`);
  push(`| Total parameters | ${nf(st.model.totalB)} B |`);
  push(`| Active parameters per token | ${nf(st.model.activeB)} B |`);
  push(`| Bytes per parameter | ${st.model.bytesPerParam} |`);
  push(`| KV cache per token | ${st.model.kvKbPerToken} KB |`);
  push(`| Accepted tokens per step | ${st.model.specTokens} |`);
  push(`| Prefill / decode ratio | ${st.model.prefillRatio}× |`);
  push(`| Max concurrent sessions per node | ${nf(st.model.maxSeqs)} |`);
  push("");

  push("### Cost of technical time", "");
  push("| Parameter | Value |", "|---|---|");
  push(`| Gross annual salary | ${eur(st.staff.ral)} |`);
  push(`| Employer coefficient | ${st.staff.employerCoef} |`);
  push(`| Freelance rate | ${eur(st.staff.freelanceRate)}/hour |`);
  push(`| Share of hours on freelance | ${pct(st.staff.freelanceShare)} |`);
  push(`| **Blended hourly rate** | **${eur(r.rates.blendedHourly)}** |`);
  push("");

  /* --- workload ----------------------------------------------------- */
  push("## Workload", "");
  push("| Metric | Value |", "|---|---|");
  push(`| Input tokens per year | ${nf(r.workload.totalIn / 1e9, 1)} B |`);
  push(`| Output tokens per year | ${nf(r.workload.totalOut / 1e9, 1)} B |`);
  push(`| Input / output ratio | ${r.workload.ioRatio.toFixed(1)}:1 |`);
  push(`| Sustained decode, people | ${nf(r.workload.decodePeople)} tok/s |`);
  push(`| Sustained decode, agents | ${nf(r.workload.decodeAgents)} tok/s |`);
  push(`| Sustained prefill | ${nf(r.workload.prefillSustained)} tok/s |`);
  push(`| Peak prefill | ${nf(r.workload.prefillPeak)} tok/s |`);
  push(`| Peak factor applied | ${r.workload.peakUsed.toFixed(2)}× |`);
  push(`| **Combined peak decode** | **${nf(r.workload.decodePeak)} tok/s** |`);
  push(`| Concurrent sessions | ${nf(r.workload.sessionsTotal, 1)} |`);
  push(`| Resident KV required | ${nf(r.workload.kvRequired)} tokens |`);
  push("");

  /* --- comparison --------------------------------------------------- */
  push("## Options compared", "");
  push(
    "| Option | Base min / conservative recommendation | Eligible | CapEx | Energy | Management | Support | Service / API | Total | Blended €/1M | Input €/1M | Output €/1M | Base / conservative binding |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const o of r.options) {
    if (!o.sizing.fits) {
      push(`| ${o.hw.label} | — | no | — | — | — | — | — | does not fit | — | — | — | — |`);
      continue;
    }
    push(
      `| ${o.hw.label} | ${nf(o.sizing.minimumUnits)} / ${nf(o.sizing.recommendedUnits)} | ${o.eligibility?.eligible !== false ? "yes" : "no"} | ${eur(o.cost.capex)} | ${eur(o.cost.energy4)} | ` +
        `${eur(o.cost.mgmt4)} | ${eur(o.cost.support4)} | ${eur(o.cost.service4)} | ` +
        `**${eur(o.cost.total)}** | ${(o.perMToken || 0).toFixed(3)} | ` +
        `${o.perMInput != null ? o.perMInput.toFixed(3) : "—"} | ` +
        `${o.perMOutput != null ? o.perMOutput.toFixed(3) : "—"} | ${o.sizing.binding} / ${o.sizing.recommendationBinding || o.sizing.binding} |`
    );
  }
  push("");

  /* --- sizing detail ------------------------------------------------ */
  push("## Sizing detail", "");
  push(
    "| Option | Profile | Precision | Weights | Free for KV | KV per unit | Decode | Prefill | by KV | by serving | by concurrency |",
    "|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const o of r.options) {
    if (!o.sizing.fits || o.kind === "subscription") continue;
    push(
      `| ${o.hw.label} | ${o.sizing.profileId || "estimated fallback"} | ${o.sizing.precision || "—"} | ` +
        `${nf(o.sizing.weightsGb)} GB | ${nf(o.sizing.freeGb)} GB | ${nf(o.sizing.kvTokens)} | ` +
        `${nf(o.sizing.aggregate)} tok/s | ${nf(o.sizing.prefill)} tok/s | ` +
        `${nf(o.sizing.unitsKv)} | ${nf(o.sizing.unitsServing)} | ${nf(o.sizing.unitsSeqs)} |`
    );
  }
  push("");

  /* --- domain ------------------------------------------------------- */
  if (r.bestOwn) {
    const d = r.bestOwn.domain;
    push("## Is this tool still the right instrument", "");
    push(
      `Cheapest owned option needs ${nf(d.qty)} unit${d.qty === 1 ? "" : "s"}, ` +
        `${nf(d.kwPeak, 1)} kW peak, ${nf(d.rackDensity, 1)} kW per rack, ` +
        `${d.busFactor} people who need to know how to restart the stack.`,
      "",
      d.verdict === "out-of-domain"
        ? "**Out of domain.** Above 8 nodes or 150 kW the cost is dominated by the facility, not the hardware. This model gives you the IT load in kW, which is the input to a facility model, not the model itself."
        : d.verdict === "at-limit"
        ? "**At the limit.** Sizing still holds, but rework the cost side by hand on three points: bus factor, power supply, and cooling above 20 kW per rack."
        : "**In domain.** Server-room scale, one resident text model. This facility and bus-factor check is advisory and is not included in TCO.",
      ""
    );
  }

  /* --- honesty ------------------------------------------------------ */
  push("## What is measured and what is not", "");
  push(
    `Selected model confidence: **${st.model.confidence || "unknown"}**. Hardware/profile evidence:`,
    ""
  );
  push("| Option | Confidence | Note |", "|---|---|---|");
  for (const o of r.options) {
    push(`| ${o.hw.label} | ${o.hw.confidence || "unknown"} | ${(o.hw.notes || "").replace(/\|/g, "/")} |`);
  }
  push("");
  push(
    "Before committing to a purchase or an SLA, run the candidate configuration yourself. " +
      "Most decode figures in this tool are derived from bandwidth and memory arithmetic, not measured on the exact hardware.",
    ""
  );

  push("---", "");
  push(
    `Built with [${APP_NAME}](https://localai-tco.dinova.one/) — frontend only, no data leaves your browser.`,
    "",
    "Author: Juxhin Radhima",
    "",
    "LocalAI-TCO by Dinova — https://localai-tco.dinova.one/"
  );

  return L.join("\n");
}

export function exportMarkdown(state, r) {
  download(
    `localai-tco-${(state.scenarioName || "scenario").replace(/\W+/g, "-").toLowerCase()}-${stamp()}.md`,
    buildMarkdown(state, r),
    "text/markdown"
  );
}
