/**
 * Request-for-quote → Google Form.
 * Paste the published form URL below when you have it.
 * The app copies a scenario summary to the clipboard, then opens the form
 * so the requester can paste it into "Scenario summary from Bindwidth".
 */
export const RFQ_FORM_URL = "https://forms.gle/Dm3w5JAhwHGrCSBo8";

const nf = (n, d = 0) =>
  !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (n) => (Number.isFinite(n) ? "€" + nf(Math.round(n)) : "—");

export function isRfqConfigured() {
  return typeof RFQ_FORM_URL === "string" && /^https?:\/\//i.test(RFQ_FORM_URL.trim());
}

/** Compact block the user pastes into the Google Form textarea. */
export function buildRfqSummary(st, r, option = null) {
  const target = option || r.bestOwn;
  const lines = [
    `Bindwidth RFQ summary — ${new Date().toISOString().slice(0, 10)}`,
    `Scenario: ${st.scenarioName || "Untitled"}`,
    "",
    "— Configuration of interest —",
    target
      ? [
          `Option: ${target.hw.label}`,
          `Kind: ${target.kind}`,
          `Eligible: ${target.eligibility?.eligible ? "yes" : "no"}`,
          `Eligibility notes: ${target.eligibility?.reasons?.join(" ") || "none"}`,
          `Units: technical minimum ${nf(target.sizing?.minimumUnits)}, recommended ${nf(target.sizing?.recommendedUnits)}, quoted ${nf(target.cost.qty)}`,
          `Binding constraint: ${target.sizing?.binding ?? "—"}`,
          `Precision / profile: ${target.sizing?.precision || "—"} / ${target.sizing?.profileId || "estimated fallback"}`,
          `Profile confidence: ${target.sizing?.profileConfidence || target.hw.confidence || "unknown"}`,
          `${st.econ.years}-year total (model): ${target.sizing?.fits ? eur(target.cost.total) : "—"}`,
          `€/1M tokens: ${target.sizing?.fits && target.perMToken != null ? target.perMToken.toFixed(3) : "—"}`,
          target.hw.provider ? `Provider: ${target.hw.provider}` : null,
          target.hw.topology ? `Topology: ${target.hw.topology}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "No fitting owned configuration in this scenario.",
    "",
    "— Workload —",
    `Model: ${st.model.name} (${st.model.quantLabel || "—"})`,
    `Headcount: ${nf(r.headcount)} (devs ${nf(st.org.devs)}, marketing ${nf(st.org.marketing)}, admin ${nf(st.org.admin)})`,
    `Autonomous agents: ${nf(st.agents.count)}`,
    `Tokens / year: ${nf(r.workload.totalTokens / 1e9, 1)} B`,
    `Peak decode: ${nf(r.workload.decodePeak)} tok/s`,
    `Peak prefill: ${nf(r.workload.prefillPeak)} tok/s`,
    `Concurrent sessions: ${nf(r.workload.sessionsTotal, 1)}`,
    `Resident KV required: ${nf(r.workload.kvRequired)} tokens`,
    "",
    "— Comparison snapshot —",
    `Cheapest owned: ${r.bestOwn ? `${r.bestOwn.hw.label} — ${eur(r.bestOwn.cost.total)}` : "—"}`,
    `Cheapest eligible alternative: ${r.bestAlt ? `${r.bestAlt.hw.label} — ${eur(r.bestAlt.cost.total)}` : "—"}`,
    `Ownership premium (model): ${eur(r.delta)}`,
    `Horizon: ${st.econ.years} years · Electricity: ${st.econ.kwhPrice} €/kWh`,
    `Resilience: target ${(st.resilience?.targetUtilization * 100).toFixed(0)}% · N+1 ${st.resilience?.nPlusOne ? "yes" : "no"}`,
    `Warnings: ${r.validation?.warnings?.join(" ") || "none"}`,
    "Comparability: workload shape is aligned; model quality, latency, context, tooling and legal suitability require separate validation.",
    "",
    "Paste this block into the form field “Scenario summary from Bindwidth”.",
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
 * Copy the RFQ summary and open the Google Form.
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
        ? "Scenario summary copied, but the quote form URL is not configured yet."
        : "Quote form URL is not configured yet.",
    };
  }

  window.open(RFQ_FORM_URL.trim(), "_blank", "noopener,noreferrer");
  return {
    ok: true,
    message: copied
      ? "Scenario summary copied. Paste it into the form field “Scenario summary from Bindwidth”."
      : "Quote form opened. Copy your Markdown/JSON export into the scenario summary field if needed.",
  };
}
