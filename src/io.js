/**
 * Save and reload a scenario. No server, no storage, no account —
 * a file on your disk is the whole persistence layer.
 */
import { validateState } from "./engine.js";
import { bindingLabel } from "./labels.js";

export const SCHEMA_VERSION = 2;
export const APP_NAME = "LocalAI-TCO";
export const APP_TAGLINE = "Dimensiona il tuo modo per l'AI locale e privata";

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
    throw new Error("applyScenarioPatch richiede un oggetto state e una patch.");
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
      `Questo scenario è stato salvato da una versione più recente (schema ${from}). Aggiorna lo strumento e riprova.`
    );
  }
  if (!payload.state) {
    throw new Error("Questo file non contiene alcuno scenario. È prevista una chiave chiamata 'state'.");
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
    throw new Error("Lo scenario deve includere un modello selezionato e almeno un'opzione hardware.");
  }
  const validation = validateState(state);
  if (!validation.valid) {
    throw new Error(`Lo scenario importato non è valido: ${validation.errors.join(" ")}`);
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

/** File-safe slug: folds accents to ASCII so Italian names stay readable. */
const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\W+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

export function buildExportPayload(state, results) {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_NAME,
    savedAt: new Date().toISOString(),
    scenarioName: state.scenarioName || "Scenario senza nome",
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
    `localai-tco-${slug(state.scenarioName) || "scenario"}-${stamp()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json"
  );
}

export function importJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Impossibile leggere il file."));
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch {
        reject(new Error("Questo file non è JSON valido. Controlla il file e riprova."));
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

  push(`# ${st.scenarioName || "Scenario LocalAI-TCO"}`, "");
  push(
    `Generato il ${new Date().toISOString().slice(0, 10)} con ${APP_NAME}.`,
    `Schema dello scenario ${SCHEMA_VERSION}. Stima direzionale, non un preventivo d'acquisto.`,
    `Orizzonte di ${st.econ.years} anni. Tutti i valori escludono l'IVA.`,
    ""
  );

  /* --- verdict ------------------------------------------------------ */
  push("## Cosa dice il modello", "");
  if (r.bestOwn && r.bestAlt) {
    push(
      `Configurazione di proprietà più economica: **${r.bestOwn.hw.label}** a **${eur(r.bestOwn.cost.total)}**` +
        ` (${r.bestOwn.cost.qty} unità, minimo tecnico ` +
        `${r.bestOwn.sizing.minimumUnits} · ${bindingLabel(r.bestOwn.sizing.binding)}, raccomandazione conservativa ` +
        `${r.bestOwn.sizing.recommendedUnits} · ${bindingLabel(r.bestOwn.sizing.recommendationBinding || r.bestOwn.sizing.binding)}).`,
      `Alternativa eleggibile più economica: **${r.bestAlt.hw.label}** a **${eur(r.bestAlt.cost.total)}**.`,
      `Differenza: **${eur(r.delta)}** su ${st.econ.years} anni, ` +
        `${eur(r.perHeadOwn)} vs ${eur(r.perHeadAlt)} per persona per anno.`,
      ""
    );
    if (r.premiumActual !== null) {
      push(
        `Premio di proprietà: **${pct(r.premiumActual)}** rispetto al premio accettabile configurato di ${pct(r.premiumAccepted)}.` +
          (r.premiumActual > r.premiumAccepted
            ? " Sopra la soglia — serve una motivazione non economica esplicita."
            : " Entro la soglia specifica dello scenario configurata per questa organizzazione."),
        ""
      );
    }
  }
  push("### Comparabilità ed eleggibilità", "");
  push(
    "Le opzioni sono confrontate sulla stessa forma del carico di lavoro: il confronto non garantisce la qualità del modello, né latenza, contesto, strumenti, disponibilità o idoneità legale.",
    `Preferisci alternative sovrane: ${st.requirements?.sovereignOnly ? "sì" : "no"}.`,
    "La preferenza UE / regione per i noleggi è etichettata solo a titolo di riferimento e non esclude i noleggi dal confronto dei costi.",
    ""
  );
  const referenced = r.options.filter((o) => o.eligibility?.referenceOnly);
  if (referenced.length) {
    push("Noleggi di riferimento:", "");
    push(...referenced.map((o) => `- ${o.hw.label}: ${o.eligibility.referenceNotes.join(" ")}`), "");
  }
  const excluded = r.options.filter((o) => o.eligibility && !o.eligibility.eligible);
  if (excluded.length) {
    push(...excluded.map((o) => `- ${o.hw.label}: ${o.eligibility.reasons.join(" ")}`), "");
  }
  if (r.validation?.warnings?.length) {
    push("### Avvertenze del modello", "", ...r.validation.warnings.map((x) => `- ${x}`), "");
  }
  push("### Tempistica del flusso di cassa del noleggio", "");
  push(
    `Sconto riservato: ${pct(st.rental.reserveDiscount)}. Allocazione anticipata: ${pct(st.rental.upfrontShare)}.`,
    "L'allocazione anticipata modifica la tempistica dei pagamenti, non l'impegno totale non scontato.",
    ""
  );
  for (const o of r.options.filter((x) => x.kind === "rent")) {
    push(`- ${o.hw.label}: ${eur(o.cost.serviceUpfront)} in anticipo; ${eur(o.cost.serviceRecurring)} ricorrenti.`);
  }
  push("");

  /* --- inputs ------------------------------------------------------- */
  push("## Dati di input", "");
  push("### Organizzazione", "");
  push("| Parametro | Valore |", "|---|---|");
  push(`| Sviluppatori | ${nf(st.org.devs)} |`);
  push(`| Marketing / vendite | ${nf(st.org.marketing)} |`);
  push(`| Amministrativo | ${nf(st.org.admin)} |`);
  push(`| Giorni lavorativi per anno | ${nf(st.org.workDays)} |`);
  push(`| Ore produttive per giorno | ${nf(st.org.workHours)} |`);
  push("");

  push("### Agenti autonomi", "");
  push("| Parametro | Valore |", "|---|---|");
  push(`| Agenti concorrenti | ${nf(st.agents.count)} |`);
  push(`| Ore di attività per giorno | ${nf(st.agents.hoursDay)} |`);
  push(`| Giorni di attività per anno | ${nf(st.agents.daysYear)} |`);
  push(`| Token di input per ora-agente | ${nf(st.agents.inPerHour)} |`);
  push(`| Token di output per ora-agente | ${nf(st.agents.outPerHour)} |`);
  push(`| Tasso di hit della cache | ${pct(st.agents.caching)} |`);
  push(`| Contesto residente medio | ${nf(st.agents.context)} token |`);
  push(`| Fattore di picco | ${st.agents.peakFactor.toFixed(2)}× |`);
  push("");

  push("### Modello", "");
  push("| Parametro | Valore |", "|---|---|");
  push(`| Nome | ${st.model.name} |`);
  push(`| Quantizzazione | ${st.model.quantLabel} |`);
  push(`| Parametri totali | ${nf(st.model.totalB)} B |`);
  push(`| Parametri attivi per token | ${nf(st.model.activeB)} B |`);
  push(`| Byte per parametro | ${st.model.bytesPerParam} |`);
  push(`| Cache KV per token | ${st.model.kvKbPerToken} KB |`);
  push(`| Token accettati per passo | ${st.model.specTokens} |`);
  push(`| Rapporto prefill / decode | ${st.model.prefillRatio}× |`);
  push(`| Sessioni concorrenti massime per nodo | ${nf(st.model.maxSeqs)} |`);
  push("");

  push("### Costo del tempo tecnico", "");
  push("| Parametro | Valore |", "|---|---|");
  push(`| Retribuzione annua lorda | ${eur(st.staff.ral)} |`);
  push(`| Coefficiente del datore di lavoro | ${st.staff.employerCoef} |`);
  push(`| Tariffa freelance | ${eur(st.staff.freelanceRate)}/ora |`);
  push(`| Quota di ore in freelance | ${pct(st.staff.freelanceShare)} |`);
  push(`| **Tariffa oraria media** | **${eur(r.rates.blendedHourly)}** |`);
  push("");

  /* --- workload ----------------------------------------------------- */
  push("## Carico di lavoro", "");
  push("| Metrica | Valore |", "|---|---|");
  push(`| Token di input per anno | ${nf(r.workload.totalIn / 1e9, 1)} B |`);
  push(`| Token di output per anno | ${nf(r.workload.totalOut / 1e9, 1)} B |`);
  push(`| Rapporto input / output | ${r.workload.ioRatio.toFixed(1)}:1 |`);
  push(`| Decode sostenuto, persone | ${nf(r.workload.decodePeople)} tok/s |`);
  push(`| Decode sostenuto, agenti | ${nf(r.workload.decodeAgents)} tok/s |`);
  push(`| Prefill sostenuto | ${nf(r.workload.prefillSustained)} tok/s |`);
  push(`| Prefill di picco | ${nf(r.workload.prefillPeak)} tok/s |`);
  push(`| Fattore di picco applicato | ${r.workload.peakUsed.toFixed(2)}× |`);
  push(`| **Decode di picco combinato** | **${nf(r.workload.decodePeak)} tok/s** |`);
  push(`| Sessioni concorrenti | ${nf(r.workload.sessionsTotal, 1)} |`);
  push(`| KV residenti richiesti | ${nf(r.workload.kvRequired)} token |`);
  push("");

  /* --- comparison --------------------------------------------------- */
  push("## Opzioni confrontate", "");
  push(
    "| Opzione | Minimo base / raccomandazione conservativa | Eliggibile | CapEx | Energia | Gestione | Supporto | Servizio / API | Totale | €/1M mediato | €/1M input | €/1M output | Vincolo base / conservativo |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const o of r.options) {
    if (!o.sizing.fits) {
      push(`| ${o.hw.label} | — | no | — | — | — | — | — | non entra | — | — | — | — |`);
      continue;
    }
    push(
      `| ${o.hw.label} | ${nf(o.sizing.minimumUnits)} / ${nf(o.sizing.recommendedUnits)} | ${o.eligibility?.eligible !== false ? "sì" : "no"} | ${eur(o.cost.capex)} | ${eur(o.cost.energy4)} | ` +
        `${eur(o.cost.mgmt4)} | ${eur(o.cost.support4)} | ${eur(o.cost.service4)} | ` +
        `**${eur(o.cost.total)}** | ${(o.perMToken || 0).toFixed(3)} | ` +
        `${o.perMInput != null ? o.perMInput.toFixed(3) : "—"} | ` +
        `${o.perMOutput != null ? o.perMOutput.toFixed(3) : "—"} | ${bindingLabel(o.sizing.binding)} / ${bindingLabel(o.sizing.recommendationBinding || o.sizing.binding)} |`
    );
  }
  push("");

  /* --- sizing detail ------------------------------------------------ */
  push("## Dettaglio del dimensionamento", "");
  push(
    "| Opzione | Profilo | Precisione | Pesi | Liberi per KV | KV per unità | Decode | Prefill | per KV | per serving | per concorrenza |",
    "|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const o of r.options) {
    if (!o.sizing.fits || o.kind === "subscription") continue;
    push(
      `| ${o.hw.label} | ${o.sizing.profileId || "stima di fallback"} | ${o.sizing.precision || "—"} | ` +
        `${nf(o.sizing.weightsGb)} GB | ${nf(o.sizing.freeGb)} GB | ${nf(o.sizing.kvTokens)} | ` +
        `${nf(o.sizing.aggregate)} tok/s | ${nf(o.sizing.prefill)} tok/s | ` +
        `${nf(o.sizing.unitsKv)} | ${nf(o.sizing.unitsServing)} | ${nf(o.sizing.unitsSeqs)} |`
    );
  }
  push("");

  /* --- domain ------------------------------------------------------- */
  if (r.bestOwn) {
    const d = r.bestOwn.domain;
    push("## Questo strumento è ancora lo strumento giusto", "");
    push(
      `L'opzione di proprietà più economica richiede ${nf(d.qty)} unità, ` +
        `${nf(d.kwPeak, 1)} kW di picco, ${nf(d.rackDensity, 1)} kW per rack, ` +
        `bus factor ${d.busFactor}: le persone che devono sapere come riavviare lo stack.`,
      "",
      d.verdict === "out-of-domain"
        ? "**Fuori dominio.** Oltre 8 nodi o 150 kW il costo è dominato dall'infrastruttura, non dall'hardware. Questo modello ti dà il carico IT in kW, che è l'input di un modello di infrastruttura, non il modello stesso."
        : d.verdict === "at-limit"
        ? "**Al limite.** Il dimensionamento regge ancora, ma rivedi a mano il lato dei costi su tre punti: bus factor, alimentazione elettrica e raffreddamento oltre 20 kW per rack."
        : "**Nel dominio.** Scala di sala server, un modello testuale residente. Questo controllo su infrastruttura e bus factor è consultivo e non è incluso nel TCO.",
      ""
    );
  }

  /* --- honesty ------------------------------------------------------ */
  push("## Cosa è misurato e cosa non lo è", "");
  push(
    `Confidenza del modello selezionato: **${st.model.confidence || "sconosciuto"}**. Evidenze hardware/profilo:`,
    ""
  );
  push("| Opzione | Confidenza | Nota |", "|---|---|---|");
  for (const o of r.options) {
    push(`| ${o.hw.label} | ${o.hw.confidence || "sconosciuto"} | ${(o.hw.notes || "").replace(/\|/g, "/")} |`);
  }
  push("");
  push(
    "Prima di impegnarti su un acquisto o su uno SLA, esegui tu stesso la configurazione candidata. " +
      "La maggior parte dei valori di decode in questo strumento è derivata da calcoli di banda e memoria, non misurata sull'hardware esatto.",
    ""
  );

  push("---", "");
  push(
    `Realizzato con [${APP_NAME}](https://localai-tco.dinova.one/) — solo frontend, nessun dato lascia il browser.`,
    "",
    "Autore: Juxhin Radhima",
    "",
    "LocalAI-TCO by Dinova — https://localai-tco.dinova.one/"
  );

  return L.join("\n");
}

export function exportMarkdown(state, r) {
  download(
    `localai-tco-${slug(state.scenarioName) || "scenario"}-${stamp()}.md`,
    buildMarkdown(state, r),
    "text/markdown"
  );
}
