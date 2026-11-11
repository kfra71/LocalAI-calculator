/**
 * Request-for-quote → Dinova contact page.
 * Paste the published contact URL below when you have it.
 * The app copies a scenario summary to the clipboard, then opens the contact
 * page so the requester can paste it into the message field of the form.
 */
import { bindingLabel, kindLabel } from "./labels.js";

export const RFQ_FORM_URL = "https://www.dinova.one/contatti/";

const nf = (n, d = 0) =>
  !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (n) => (Number.isFinite(n) ? "€" + nf(Math.round(n)) : "—");

export function isRfqConfigured() {
  return typeof RFQ_FORM_URL === "string" && /^https?:\/\//i.test(RFQ_FORM_URL.trim());
}

/** Compact block the user pastes into the contact form message field. */
export function buildRfqSummary(st, r, option = null) {
  const target = option || r.bestOwn;
  const lines = [
    `Riepilogo richiesta di preventivo LocalAI-TCO — ${new Date().toISOString().slice(0, 10)}`,
    `Scenario: ${st.scenarioName || "Scenario senza nome"}`,
    "",
    "— Configurazione di interesse —",
    target
      ? [
          `Opzione: ${target.hw.label}`,
          `Tipo: ${kindLabel(target.kind)}`,
          `Eleggibile: ${target.eligibility?.eligible ? "sì" : "no"}`,
          `Note di eleggibilità: ${target.eligibility?.reasons?.join(" ") || "nessuna"}`,
          `Unità: minimo tecnico ${nf(target.sizing?.minimumUnits)}, raccomandata ${nf(target.sizing?.recommendedUnits)}, quotata ${nf(target.cost.qty)}`,
          `Vincolo base: ${bindingLabel(target.sizing?.binding)} · Conservativo: ${bindingLabel(target.sizing?.recommendationBinding || target.sizing?.binding)}`,
          `Precisione / profilo: ${target.sizing?.precision || "—"} / ${target.sizing?.profileId || "stima di fallback"}`,
          `Confidenza del profilo: ${target.sizing?.profileConfidence || target.hw.confidence || "sconosciuto"}`,
          `Totale su ${st.econ.years} anni (modello): ${target.sizing?.fits ? eur(target.cost.total) : "—"}`,
          `€/1M token: ${target.sizing?.fits && target.perMToken != null ? target.perMToken.toFixed(3) : "—"}`,
          target.hw.provider ? `Fornitore: ${target.hw.provider}` : null,
          target.hw.topology ? `Topologia: ${target.hw.topology}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "Nessuna configurazione di proprietà adatta in questo scenario.",
    "",
    "— Carico di lavoro —",
    `Modello: ${st.model.name} (${st.model.quantLabel || "—"})`,
    `Organico: ${nf(r.headcount)} (sviluppatori ${nf(st.org.devs)}, marketing ${nf(st.org.marketing)}, admin ${nf(st.org.admin)})`,
    `Agenti autonomi: ${nf(st.agents.count)}`,
    `Token / anno: ${nf(r.workload.totalTokens / 1e9, 1)} B`,
    `Decode di picco: ${nf(r.workload.decodePeak)} tok/s`,
    `Prefill di picco: ${nf(r.workload.prefillPeak)} tok/s`,
    `Sessioni concorrenti: ${nf(r.workload.sessionsTotal, 1)}`,
    `KV residenti richiesti: ${nf(r.workload.kvRequired)} token`,
    "",
    "— Istantanea del confronto —",
    `Opzione di proprietà più economica: ${r.bestOwn ? `${r.bestOwn.hw.label} — ${eur(r.bestOwn.cost.total)}` : "—"}`,
    `Alternativa eleggibile più economica: ${r.bestAlt ? `${r.bestAlt.hw.label} — ${eur(r.bestAlt.cost.total)}` : "—"}`,
    `Premio di proprietà (modello): ${eur(r.delta)}`,
    `Orizzonte: ${st.econ.years} anni · Elettricità: ${st.econ.kwhPrice} €/kWh`,
    `Resilienza: obiettivo ${(st.resilience?.targetUtilization * 100).toFixed(0)}% · N+1 ${st.resilience?.nPlusOne ? "sì" : "no"}`,
    `Avvertenze: ${r.validation?.warnings?.join(" ") || "nessuna"}`,
    "Comparabilità: la forma del carico di lavoro è allineata; qualità del modello, latenza, contesto, strumenti e idoneità legale richiedono una validazione separata.",
    "",
    "Incolla questo blocco nel campo messaggio del modulo.",
  ];
  return lines.join("\n");
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copy the RFQ summary and open the contact page.
 * @returns {Promise<{ ok: boolean, message: string, err?: boolean }>}
 */
export async function openRfqForm(st, r, option = null) {
  const summary = buildRfqSummary(st, r, option);
  const copied = await copyText(summary);

  if (!isRfqConfigured()) {
    return {
      ok: false,
      err: true,
      message: copied
        ? "Riepilogo dello scenario copiato, ma l'URL del modulo di preventivo non è ancora configurato."
        : "L'URL del modulo di preventivo non è ancora configurato.",
    };
  }

  window.open(RFQ_FORM_URL.trim(), "_blank", "noopener,noreferrer");
  return {
    ok: true,
    message: copied
      ? "Riepilogo dello scenario copiato. Incollalo nel campo messaggio."
      : "Modulo di preventivo aperto. Se serve, copia il tuo export Markdown/JSON nel campo messaggio.",
  };
}
