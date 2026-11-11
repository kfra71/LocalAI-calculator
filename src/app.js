import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";
import { compute, computeSensitivity, packages } from "./engine.js";
import { APP_TAGLINE, applyScenarioPatch, exportJson, exportMarkdown, importJson } from "./io.js";
import { openRfqForm } from "./rfq.js";
import { bindingLabel, packageVerdictLabel } from "./labels.js";

const html = htm.bind(React.createElement);
const { useState, useEffect, useMemo, useRef, useCallback } = React;

/* ---------------- formatting ---------------- */
const nf = (n, d = 0) =>
  !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (n) => (Number.isFinite(n) ? "€" + nf(Math.round(n)) : "—");
const eur2 = (n) => (Number.isFinite(n) ? "€" + nf(n, 2) : "—");
const pct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "—");
const mult = (n) => (Number.isFinite(n) ? n.toFixed(2) + "×" : "—");

/* ---------------- primitives ---------------- */

const Panel = ({ title, hint, children, tight, actions }) => html`
  <section class="panel">
    ${(title || actions) &&
    html`<header>
      <h2>${title}</h2>
      ${hint && html`<span class="hint">${hint}</span>`}
      <div style=${{ flex: 1 }}></div>
      ${actions}
    </header>`}
    <div class=${"body" + (tight ? " tight" : "")}>${children}</div>
  </section>`;

const Field = ({ label, sub, unit, value, onChange, step = 1, min, max, derived, type = "number" }) => html`
  <div class=${"field" + (derived ? " derived" : "")}>
    <label>
      ${label}${unit ? html`<span key="u" class="unit"> ${unit}</span>` : null}
      ${sub ? html`<span key="s" class="sub">${sub}</span>` : null}
    </label>
    <input type=${type} value=${value} step=${step} min=${min} max=${max}
      readOnly=${!!derived} tabIndex=${derived ? -1 : 0}
      onChange=${(e) => onChange && onChange(type === "number" ? parseFloat(e.target.value) || 0 : e.target.value)} />
  </div>`;

const PctField = (p) => html`<${Field} ...${p} step=${0.01} value=${p.value} />`;

const Check = ({ label, sub, checked, onChange }) => html`
  <div class="field check">
    <label>${label}${sub ? html`<span key="s" class="sub">${sub}</span>` : null}</label>
    <input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} />
  </div>`;

const Readout = ({ k, v, n, tone }) => html`
  <div class=${"readout" + (tone ? " " + tone : "")}>
    <div class="k">${k}</div><div class="v">${v}</div>${n && html`<div class="n">${n}</div>`}
  </div>`;

const Badge = ({ kind, children }) => html`<span class=${"badge " + (kind || "")}>${children}</span>`;

/* ---------------- signature element: the constraint ladder ----------------
   Three limits, one of them binds. Everything else in the model is arithmetic;
   this is the thing a CTO actually needs to see at a glance.                */

const Ladder = ({ sizing }) => {
  if (!sizing.fits) return html`<span class="badge bad">non entra</span>`;
  const binds = sizing.bindings || String(sizing.binding || "").split("+").filter(Boolean);
  const rows = [
    { k: "kv", label: "KV", units: sizing.unitsKv },
    { k: "serving", label: "Prefill + decode", units: sizing.unitsServing },
    { k: "concurrency", label: "Sessioni", units: sizing.unitsSeqs },
  ].filter((r) => Number.isFinite(r.units));
  const max = Math.max(1, ...rows.map((r) => r.units));
  return html`
    <div>
      <div class="ladder">
        ${rows.map(
          (r) => html`
            <div class=${"rung" + (binds.includes(r.k) ? " binds" : "")} key=${r.k}>
              <span class="k">${r.label}</span>
              <span class="track"><span class="fill" style=${{ width: (r.units / max) * 100 + "%" }}></span></span>
              <span class="v">${nf(r.units)}</span>
            </div>`
        )}
      </div>
      <div class="ladder-note">
        Vincolo di base: <b>${bindingLabel(sizing.binding)}</b> → ${nf(sizing.minimumUnits)} · Conservativo: <b>${bindingLabel(sizing.recommendationBinding || sizing.binding)}</b> → ${nf(sizing.recommendedUnits)}
      </div>
    </div>`;
};

/* ---------------- first-visit wizard ---------------- */

const WIZARD_KEY = "localai-tco.wizard.done";
const WIZARD_STEPS = [
  { id: "welcome", label: "Benvenuto" },
  { id: "scenario", label: "Scenario" },
  { id: "model", label: "Modello" },
  { id: "result", label: "Risultato" },
];

function groupScenarios(scenarios = []) {
  const groups = [];
  const byName = new Map();
  for (const sc of scenarios) {
    if (!byName.has(sc.group)) {
      const g = { name: sc.group, items: [] };
      byName.set(sc.group, g);
      groups.push(g);
    }
    byName.get(sc.group).items.push(sc);
  }
  return groups;
}

function Wizard({ st, set, r, catalog, scenarios = [], selectedPresetId, onSelectPreset, onClose, onFinish, onTune }) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);
  const m = st.model;
  const best = r?.bestOwn;
  const premiumOver = r && r.premiumActual !== null && r.premiumActual > r.premiumAccepted;
  const scenarioGroups = useMemo(() => groupScenarios(scenarios), [scenarios]);
  const selectedPreset = scenarios.find((s) => s.id === selectedPresetId) || null;
  const headcount = (st.org?.devs || 0) + (st.org?.marketing || 0) + (st.org?.admin || 0);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const root = dialogRef.current;
    if (!root) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Do not use offsetParent: it is null for descendants of position:fixed.
    const focusable = () =>
      [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.getClientRects().length > 0);
    const first = focusable()[0];
    if (first) first.focus();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusable();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      if (e.shiftKey) {
        if (i <= 0) {
          e.preventDefault();
          list[list.length - 1].focus();
        }
      } else if (i === list.length - 1 || i === -1) {
        e.preventDefault();
        list[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  }, [onClose]);

  const goNext = () => setStep((s) => Math.min(s + 1, WIZARD_STEPS.length - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));
  const stepId = WIZARD_STEPS[step].id;

  return html`
    <div class="wizard-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" ref=${dialogRef}>
        <div class="wizard-progress" aria-label="Passi della configurazione">
          ${WIZARD_STEPS.map((s, i) => html`
            <div key=${s.id} class=${"wizard-step" + (i === step ? " is-current" : "") + (i < step ? " is-done" : "")}>
              <span class="wizard-step-idx">${String(i + 1).padStart(2, "0")}</span>
              <span class="wizard-step-label">${s.label}</span>
            </div>`)}
        </div>

        <div class="wizard-body">
          ${stepId === "welcome" && html`
            <h2 id="wizard-title">${APP_TAGLINE}</h2>
            <p class="lede">
              LocalAI-TCO individua il vincolo che lega — memoria KV, serving combinato prefill/decode o limite di sessioni — e confronta il prezzo dell'hardware di proprietà con le alternative utilizzabili. Scegli uno scenario di partenza realistico, così tassi di token, concorrenza e picchi corrispondono all'organizzazione — non un ufficio di 20 persone incollato su un portatile.
            </p>
            <div class="note info" style=${{ marginTop: 14 }}>
              Nulla di ciò che digiti lascia questa scheda del browser. Puoi saltare in qualsiasi momento per usare il calcolatore completo.
            </div>
          `}

          ${stepId === "scenario" && html`
            <h2 id="wizard-title">Quale scenario di partenza?</h2>
            <p class="lede">
              Ogni preset imposta l'organico <em>e</em> i campi del carico di lavoro collegati — token giornalieri,
              contesto, cache, comportamento di picco e agenti. Scegli la corrispondenza più vicina; potrai affinare
              ogni campo in seguito.
            </p>
            <div class="wizard-scenario-groups">
              ${scenarioGroups.map((g) => html`
                <div key=${g.name} class="wizard-scenario-group">
                  <h3>${g.name}</h3>
                  <div class="wizard-scenario-grid">
                    ${g.items.map((sc) => html`
                      <button
                        key=${sc.id}
                        type="button"
                        class=${"wizard-scenario-card" + (selectedPresetId === sc.id ? " is-selected" : "")}
                        onClick=${() => onSelectPreset(sc.id)}
                        aria-pressed=${selectedPresetId === sc.id}>
                        <strong>${sc.label}</strong>
                        <span>${sc.blurb}</span>
                      </button>`)}
                  </div>
                </div>`)}
            </div>
            ${selectedPreset && html`
              <div class="wizard-scenario-summary note info" style=${{ marginTop: 14 }}>
                <b>${selectedPreset.label}.</b>
                ${nf(headcount)} personale che usa l'AI
                (${nf(st.org.devs)} sviluppatori · ${nf(st.org.admin)} amministrazione · ${nf(st.org.marketing)} marketing)
                · ${nf(st.agents.count)} agents
                · ${nf(st.workload.devOut)} token di output/sviluppatore/giorno
                ${st.workload.peakManual > 0 ? ` · fattore di picco ${st.workload.peakManual}` : ""}.
              </div>`}
            ${!selectedPreset && html`
              <div class="note warn" style=${{ marginTop: 14 }}>
                Seleziona un preset per continuare. L'organico grezzo da solo è il modo in cui si inventano quattro Sparks per uno sviluppatore.
              </div>`}
          `}

          ${stepId === "model" && html`
            <h2 id="wizard-title">Quale modello?</h2>
            <p class="lede">
              Scegli dal catalogo. I parametri totali determinano l'ingombro; i parametri attivi determinano la velocità di decode; i KV per token determinano quante sessioni entrano.
            </p>
            <div class="wizard-fields">
              <div class="field wizard-select">
                <label>
                  Modello
                  <span class="sub">I parametri dell'architettura si caricano con la voce</span>
                </label>
                <select value=${m.id || ""} onChange=${(e) => {
                  const found = catalog.models.find((x) => x.id === e.target.value);
                  if (found) set("model", { ...found });
                }}>
                  ${catalog.models.map((x) => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}
                </select>
              </div>
              <div class="wizard-model-meta">
                <div class="kv">
                  <dt>Architettura</dt><dd>${m.arch || "—"}</dd>
                  <dt>Quantizzazione</dt><dd>${m.quantLabel || "—"}</dd>
                  <dt>Totali / attivi</dt><dd>${m.totalB}B / ${m.activeB}B</dd>
                  <dt>Confidenza</dt><dd><${Badge} kind=${m.confidence}>${m.confidence || "?"}<//></dd>
                </div>
              </div>
            </div>
          `}

          ${stepId === "result" && html`
            <h2 id="wizard-title">Il tuo primo risultato</h2>
            <p class="lede">
              Con il tuo scenario e il tuo modello, questa è l'opzione di proprietà più economica che entra — e quale limite è il vincolo. Apri il calcolatore completo per modificare carico di lavoro, hardware o comparabili.
            </p>
            <div class="readouts" style=${{ marginTop: 14 }}>
              <${Readout} k="Opzione di proprietà più economica" v=${eur(best?.cost.total)} tone="hi"
                n=${best ? `${best.hw.label} · ${best.cost.qty} unità` : "non entra"} />
              <${Readout} k="Premio di proprietà" v=${eur(r.delta)} tone=${premiumOver ? "warn" : "good"}
                n=${r.premiumActual !== null ? pct(r.premiumActual) + " rispetto all'alternativa" : ""} />
              <${Readout} k="Vincolo conservativo" v=${bindingLabel(best?.sizing.recommendationBinding || best?.sizing.binding)} tone="warn"
                n=${`base ${bindingLabel(best?.sizing.binding)} · ${nf(best?.sizing.recommendedUnits)} unità`} />
              <${Readout} k="Decode aggregato" v=${best?.sizing?.fits ? nf(best.sizing.aggregate) + " tok/s" : "—"} tone="hi"
                n=${best?.sizing?.fits
                  ? `per unità · ${best.cost.qty}× = ${nf(best.cost.qty * best.sizing.aggregate)} tok/s per l'intera flotta`
                  : "nessuna opzione di proprietà adatta"} />
            </div>
            ${best?.sizing && html`
              <div class="wizard-ladder">
                <${Ladder} sizing=${best.sizing} />
              </div>`}
          `}
        </div>

        <div class="wizard-actions">
          <button class="btn" type="button" onClick=${onClose}>Salta</button>
          <div class="spacer"></div>
          ${step > 0 && html`<button class="btn" type="button" onClick=${goBack}>Indietro</button>`}
          ${stepId !== "result"
            ? html`<button
                class="btn primary"
                type="button"
                onClick=${goNext}
                disabled=${stepId === "scenario" && !selectedPresetId}>
                ${stepId === "welcome" ? "Inizia" : "Continua"}
              </button>`
            : html`
              <button class="btn" type="button" onClick=${onTune}>Personalizza gli input</button>
              <button class="btn primary" type="button" onClick=${onFinish}>Vedi i risultati completi</button>
            `}
        </div>
      </div>
    </div>`;
}

/* ---------------- views ---------------- */

function TeamView({ st, set }) {
  const head = st.org.devs + st.org.marketing + st.org.admin;
  return html`
    <div class="stack">
      <p class="lede">
        Parti dalla forma dell'organizzazione. La ripartizione conta più dell'organico:
        <strong>gli sviluppatori che usano strumenti agentici generano quasi tutto il volume di token</strong>, e il loro numero determina anche quanto è piccatoso il carico — poche persone producono picchi violenti, una popolazione ampia li media.
      </p>
      <div class="grid two">
        <${Panel} title="Persone" hint=${`${head} total`}>
          <${Field} label="Sviluppatori" sub="Chi usa agenti di coding durante il giorno" unit="persone"
            value=${st.org.devs} onChange=${(v) => set("org.devs", v)} />
          <${Field} label="Marketing e vendite" sub="Copy, brief, generazione di immagini e video" unit="persone"
            value=${st.org.marketing} onChange=${(v) => set("org.marketing", v)} />
          <${Field} label="Amministrativo" sub="Analisi dei documenti, email, ricerca" unit="persone"
            value=${st.org.admin} onChange=${(v) => set("org.admin", v)} />
          <${Field} label="Giorni lavorativi per anno" unit="giorni" value=${st.org.workDays} onChange=${(v) => set("org.workDays", v)} />
          <${Field} label="Ore produttive al giorno" sub="La finestra in cui deve rientrare il picco" unit="ore"
            value=${st.org.workHours} onChange=${(v) => set("org.workHours", v)} />
        <//>

        <${Panel} title="Agenti autonomi" hint="un carico strutturalmente diverso">
          <p class="lede" style=${{ marginBottom: 10 }}>
            Non sviluppatori che usano un assistente — <strong>processi che funzionano da soli</strong>: pipeline di refactoring, smistamento dei ticket, monitoraggio, generazione di test, analisi di documenti in lotti. Lavorano di notte e nei fine settimana, il che appiattisce il carico e aumenta l'utilizzo dell'hardware. Il loro tasso di hit della cache è molto più alto perché ripetono gli stessi prompt a ogni ciclo.
          </p>
          <${Field} label="Agenti concorrenti" sub="Imposta questo valore sopra zero per modellare il passaggio al lavoro autonomo"
            unit="agenti" value=${st.agents.count} onChange=${(v) => set("agents.count", v)} />
          <${Field} label="Ore attive al giorno" unit="ore" value=${st.agents.hoursDay} onChange=${(v) => set("agents.hoursDay", v)} />
          <${Field} label="Giorni attivi per anno" unit="giorni" value=${st.agents.daysYear} onChange=${(v) => set("agents.daysYear", v)} />
          <${Field} label="Token di input per ora-agente" unit="token" value=${st.agents.inPerHour}
            step=${50000} onChange=${(v) => set("agents.inPerHour", v)} />
          <${Field} label="Token di output per ora-agente" unit="token" value=${st.agents.outPerHour}
            step=${5000} onChange=${(v) => set("agents.outPerHour", v)} />
          <${PctField} label="Tasso di hit della cache" sub="Più alto rispetto all'uso interattivo: lo stesso system prompt a ogni ciclo"
            unit="quota" value=${st.agents.caching} onChange=${(v) => set("agents.caching", v)} />
          <${Check} label="Condividi un prefisso residente tra gli agenti"
            sub="Abilita solo quando il runtime deduplica il prefisso KV"
            checked=${st.agents.prefixSharing}
            onChange=${(v) => set("agents.prefixSharing", v)} />
          <${Field} label="Prefisso condiviso degli agenti" unit="token"
            value=${st.agents.sharedPrefixTokens} derived=${!st.agents.prefixSharing}
            onChange=${(v) => set("agents.sharedPrefixTokens", v)} />
          <${Field} label="Contesto residente medio" sub="Più lungo rispetto all'uso interattivo: gli agenti trasportano stato e output degli strumenti"
            unit="token" value=${st.agents.context} step=${10000} onChange=${(v) => set("agents.context", v)} />
          <${Field} label="Fattore di picco" sub="Vicino a 1: un carico continuo non ha picchi" unit="×"
            value=${st.agents.peakFactor} step=${0.05} onChange=${(v) => set("agents.peakFactor", v)} />
        <//>
      </div>

      <${Panel} title="Costo di un'ora di tempo tecnico"
        hint="moltiplica nel TCO solo quando una quota di gestione è sopra zero">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Tariffa oraria media per le quote FTE qui sotto. Con tutte le quote a zero (il valore predefinito), questa tariffa non aggiunge euro di gestione — alza una quota quando vuoi modellare personale ops reale.
        </p>
        <div class="grid two">
          <div>
            <${Field} label="Retribuzione annua lorda" sub="Profilo MLOps o SRE, prima dei contributi del datore di lavoro" unit="€/anno"
              value=${st.staff.ral} step=${1000} onChange=${(v) => set("staff.ral", v)} />
            <${Field} label="Coefficiente del datore di lavoro" sub="Contributi, accantonamento per licenziamenti, postazione di lavoro. Tipico 1.35–1.50" unit="×"
              value=${st.staff.employerCoef} step=${0.01} onChange=${(v) => set("staff.employerCoef", v)} />
            <${Field} label="Ore lavorate per anno" unit="ore" value=${st.staff.hoursYear} step=${10}
              onChange=${(v) => set("staff.hoursYear", v)} />
          </div>
          <div>
            <${Field} label="Tariffa freelance" sub="Consulente reperibile per lavori occasionali" unit="€/ora"
              value=${st.staff.freelanceRate} step=${5} onChange=${(v) => set("staff.freelanceRate", v)} />
            <${PctField} label="Quota di ore in freelance" sub="0 = tutto interno, 1 = completamente in outsourcing"
              unit="quota" value=${st.staff.freelanceShare} onChange=${(v) => set("staff.freelanceShare", v)} />
          </div>
        </div>
      <//>

      <${Panel} title="Costo di gestione del personale"
        hint="predefinito a zero — attivalo quando vuoi personale ops nel TCO">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Euro di gestione = quote FTE × tariffa oraria tecnica media × anni (+ ore di setup una tantum sull'hardware di proprietà). Le quote partono da <strong>0</strong> quindi la colonna Gestione di ogni configurazione comprende solo hardware/energia/servizio finché non modelli il personale. Il lavoro di piattaforma si applica ovunque; le quote di infrastruttura si applicano solo quando gestisci l'hardware (di proprietà o in noleggio), mai sui soli posti in abbonamento.
        </p>
        <div class="grid two">
          <div>
            <${PctField} label="Quota di piattaforma"
              sub="Quota FTE per gateway, chiavi, FinOps, ciclo di vita dei modelli — di proprietà, noleggio e abbonamenti"
              unit="di una persona"
              value=${st.mgmt.platformQuota} onChange=${(v) => set("mgmt.platformQuota", v)} />
            <${PctField} label="Infrastruttura — appliance"
              sub="FTE aggiuntivi solo per appliance dei vendor (proprietà/noleggio). Ignorati per gli abbonamenti. Ridotti dall'automazione"
              unit="aggiunti" value=${st.mgmt.applianceQuota} onChange=${(v) => set("mgmt.applianceQuota", v)} />
            <${PctField} label="Infrastruttura — nodo assemblato o in noleggio"
              sub="FTE aggiuntivi per nodi ottimizzati (engine, quant, reperibilità). Solo proprietà/noleggio; ridotti dall'automazione"
              unit="aggiunti" value=${st.mgmt.nodeQuota} onChange=${(v) => set("mgmt.nodeQuota", v)} />
          </div>
          <div>
            <${PctField} label="Aggiunti per unità oltre la prima"
              sub="FTE incrementali × max(0, qty − 1) sulle flotte di proprietà/noleggio. Zero mantiene la Gestione su più unità a €0"
              unit="unità" value=${st.mgmt.perUnitQuota} onChange=${(v) => set("mgmt.perUnitQuota", v)} />
            <${PctField} label="Automazione della supervisione"
              sub="Frazione che riduce solo le quote di infrastruttura, non quelle di piattaforma. Nessun effetto mentre le quote infra sono 0"
              unit="riduzione" value=${st.mgmt.automation} onChange=${(v) => set("mgmt.automation", v)} />
            <${Field} label="Accantonamento annuo per la sostituzione"
              sub="Guasti previsti e sostituzione dei componenti; i contratti di supporto sono conteggiati separatamente" unit="€/anno"
              value=${st.costs.replacementReserveAnnual} step=${500}
              onChange=${(v) => set("costs.replacementReserveAnnual", v)} />
          </div>
        </div>
      <//>
    </div>`;
}

function WorkloadView({ st, set, r }) {
  const w = r.workload;
  return html`
    <div class="stack">
      <div class="readouts">
        <${Readout} k="Token di input / anno" v=${nf(w.totalIn / 1e9, 1) + " B"} />
        <${Readout} k="Token di output / anno" v=${nf(w.totalOut / 1e9, 1) + " B"} />
        <${Readout} k="Input : output" v=${w.ioRatio.toFixed(1) + ":1"}
          n="L'input costa molto meno da erogare rispetto all'output, ma viene prezzato solo per una frazione inferiore" />
        <${Readout} k="Decode di picco" v=${nf(w.decodePeak) + " tok/s"} tone="hi" n="È questo che determina il dimensionamento dell'hardware" />
        <${Readout} k="Prefill di picco" v=${nf(w.prefillPeak) + " tok/s"} n="Condivide la capacità di serving con il decode" />
        <${Readout} k="Sessioni concorrenti" v=${nf(w.sessionsTotal, 1)} />
        <${Readout} k="KV residenti necessari" v=${nf(w.kvRequired / 1e6, 2) + " M"} n="token tenuti in memoria contemporaneamente" />
      </div>

      <div class="grid two">
        <${Panel} title="Uso interattivo" hint="persone, durante l'orario di lavoro">
          <${Field} label="Token di input per sviluppatore al giorno" sub="I cicli agentici rileggono costantemente il contesto. Il numero più sensibile del modello."
            unit="token" value=${st.workload.devIn} step=${500000} onChange=${(v) => set("workload.devIn", v)} />
          <${Field} label="Token di output per sviluppatore al giorno" unit="token" value=${st.workload.devOut}
            step=${50000} onChange=${(v) => set("workload.devOut", v)} />
          <${Field} label="Token di input per utente amministrativo" unit="token" value=${st.workload.adminIn}
            step=${10000} onChange=${(v) => set("workload.adminIn", v)} />
          <${Field} label="Token di output per utente amministrativo" unit="token" value=${st.workload.adminOut}
            step=${10000} onChange=${(v) => set("workload.adminOut", v)} />
          <${Field} label="Token di input per utente marketing / vendite" unit="token" value=${st.workload.mktIn}
            step=${10000} onChange=${(v) => set("workload.mktIn", v)} />
          <${Field} label="Token di output per utente marketing / vendite" unit="token" value=${st.workload.mktOut}
            step=${10000} onChange=${(v) => set("workload.mktOut", v)} />
          <${PctField} label="Tasso di hit della cache di prefill"
            sub="Riduce il calcolo di prefill ripetuto; i KV cambiano solo se è abilitata la memorizzazione del prefisso condiviso" unit="quota"
            value=${st.workload.caching} onChange=${(v) => set("workload.caching", v)} />
          <${PctField} label="Concorrenza degli sviluppatori" sub="Quota di sviluppatori con una sessione residente al picco"
            unit="quota" value=${st.workload.devConcurrency}
            onChange=${(v) => set("workload.devConcurrency", v)} />
          <${PctField} label="Concorrenza amministrativa" unit="quota"
            value=${st.workload.adminConcurrency}
            onChange=${(v) => set("workload.adminConcurrency", v)} />
          <${PctField} label="Concorrenza marketing" unit="quota"
            value=${st.workload.marketingConcurrency}
            onChange=${(v) => set("workload.marketingConcurrency", v)} />
          <${Check} label="Condividi un prefisso residente tra le sessioni interattive"
            sub="Abilita solo quando il runtime scelto deduplica davvero il prefisso KV"
            checked=${st.workload.prefixSharing}
            onChange=${(v) => set("workload.prefixSharing", v)} />
          <${Field} label="Prefisso condiviso interattivo" unit="token"
            value=${st.workload.sharedPrefixTokens} derived=${!st.workload.prefixSharing}
            onChange=${(v) => set("workload.sharedPrefixTokens", v)} />
          <${Field} label="Contesto residente medio" sub="Determina quanti KV trattiene ogni sessione" unit="token"
            value=${st.workload.context} step=${10000} onChange=${(v) => set("workload.context", v)} />
        <//>

        <div class="stack">
          <${Panel} title="Burstiness" hint="decide quanti macchine compri">
            <p class="lede" style=${{ marginBottom: 10 }}>
              Con dieci sviluppatori, tre che avviano agenti insieme sono un picco. Con cinquecento, la statistica lo appiattisce. <strong>È l'ipotesi che nessun benchmark misura e quella che sposta di più il numero di macchine</strong> — un mese di log orari la risolve.
            </p>
            <${Field} label="Coefficiente di burstiness" sub="Picco = 1 + k / √sviluppatori" unit="k"
              value=${st.workload.burstiness} step=${0.1} onChange=${(v) => set("workload.burstiness", v)} />
            <${Field} label="Fattore di picco, calcolato" unit="×" derived value=${w.peakAuto.toFixed(2)} />
            <${Field} label="Fattore di picco, misurato" sub="Inserisci qui il valore registrato. Zero significa usare quello calcolato."
              unit="×" value=${st.workload.peakManual} step=${0.1} onChange=${(v) => set("workload.peakManual", v)} />
            <div class="note ${st.workload.peakManual > 0 ? "info" : "warn"}" style=${{ marginTop: 10 }}>
              ${st.workload.peakManual > 0
                ? html`<span>Si sta usando il valore misurato di <b>${st.workload.peakManual.toFixed(2)}×</b>.</span>`
                : html`<span>Si sta usando la stima di <b>${w.peakAuto.toFixed(2)}×</b>. Finché non lo misuri, il numero di macchine è un'ipotesi con una formula davanti.</span>`}
            </div>
          <//>

          <${Panel} title="Immagini e video">
            <div class="note warn" style=${{ marginBottom: 10 }}>
              Solo informativo. I media sono esclusi finché non sono forniti sia i profili locali sia quelli delle alternative.
            </div>
            <${Field} label="Immagini per anno" unit="immagini" value=${st.workload.images} derived />
            <${Field} label="Secondi di video 720p per anno" unit="secondi" value=${st.workload.videoSeconds} derived />
          <//>
        </div>
      </div>
    </div>`;
}

function ModelView({ st, set, catalog }) {
  const m = st.model;
  const weights = m.totalB * m.bytesPerParam;
  const perToken = (weights * (m.activeB / m.totalB)) / m.specTokens;
  return html`
    <div class="stack">
      <p class="lede">
        Sostituire un modello non significa sostituire un numero. <strong>I parametri totali determinano quanti GPU contengono i pesi; i parametri attivi determinano la velocità di decode; i KV per token determinano quante sessioni entrano.</strong> Un mixture-of-experts da 284B con 13B attivi occupa come un 284B e genera come un 13B. Imposta bene tutti e sei i parametri e il resto dello strumento segue.
      </p>

      <${Panel} title="Modello" hint="scegli dal catalogo o modifica un campo qualsiasi"
        actions=${html`<select value=${m.id || ""} onChange=${(e) => {
          const found = catalog.models.find((x) => x.id === e.target.value);
          if (found) set("model", { ...found });
        }}>
          <option value="">— carica dal catalogo —</option>
          ${catalog.models.map((x) => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}
        </select>`}>
        <div class="grid two">
          <div>
            <${Field} type="text" label="Nome" value=${m.name} onChange=${(v) => set("model.name", v)} />
            <${Field} type="text" label="Quantizzazione" sub="Solo etichetta. Il numero che conta sono i byte per parametro."
              value=${m.quantLabel} onChange=${(v) => set("model.quantLabel", v)} />
            <${Field} label="Parametri totali" sub="Determina l'ingombro in memoria, non dice nulla sulla velocità" unit="miliardi"
              value=${m.totalB} onChange=${(v) => set("model.totalB", v)} />
            <${Field} label="Parametri attivi per token" sub="Su un MoE determina il decode. Su un modello denso equivale al totale."
              unit="miliardi" value=${m.activeB} onChange=${(v) => set("model.activeB", v)} />
            <${Field} label="Byte per parametro" sub="NVFP4 ≈ 0.50 · FP8 ≈ 1.00 · BF16 ≈ 2.00. I checkpoint misti si collocano a metà."
              unit="byte" value=${m.bytesPerParam} step=${0.01} onChange=${(v) => set("model.bytesPerParam", v)} />
          </div>
          <div>
            <${Field} label="KV cache per token" sub="Dipende dall'architettura dell'attenzione, non dalla dimensione. L'attenzione latente compressa è 2–3× più leggera della GQA classica."
              unit="KB" value=${m.kvKbPerToken} step=${0.01} onChange=${(v) => set("model.kvKbPerToken", v)} />
            <${Field} label="Token accettati per passo" sub="Decode speculativo: i pesi vengono letti una volta per passo, non per token. Metti 1.00 se non usi un drafter."
              unit="token" value=${m.specTokens} step=${0.01} onChange=${(v) => set("model.specTokens", v)} />
            <${Field} label="Rapporto prefill / decode" sub="Perché i provider prezzano l'input a una frazione dell'output, mentre per loro costa molto meno di quella frazione"
              unit="×" value=${m.prefillRatio} step=${0.1} onChange=${(v) => set("model.prefillRatio", v)} />
            <${Field} label="Contesto massimo del modello" sub="Contesti superiori a questo valore invalidano lo scenario"
              unit="token" value=${m.maxContext} onChange=${(v) => set("model.maxContext", v)} />
            <${Field} label="Sessioni concorrenti di fallback" sub="I profili esatti modello/hardware/runtime sostituiscono questo fallback conservativo"
              unit="sessioni" value=${m.maxSeqs} onChange=${(v) => set("model.maxSeqs", v)} />
            <${Field} label="Overhead di runtime per GPU" sub="CUDA graphs, buffer di attivazione, workspace dei kernel, pesi del drafter"
              unit="GB" value=${m.overheadPerGpu} onChange=${(v) => set("model.overheadPerGpu", v)} />
          </div>
        </div>
        <div class="readouts" style=${{ marginTop: 14 }}>
          <${Readout} k="Pesi, silicio compatibile con FP4" v=${nf(weights) + " GB"} />
          <${Readout} k="Precisione del checkpoint selezionato" v=${m.defaultPrecision || m.quantLabel} tone="warn"
            n="Le combinazioni di hardware non supportate sono escluse; la precisione non viene mai raddoppiata silenziosamente" />
          <${Readout} k="Lettura per token generato" v=${perToken.toFixed(2) + " GB"} tone="hi"
            n="Questo, diviso per la bandwidth, è il limite del tuo decode" />
        </div>
        ${m.kvKbRange?.status === "unresolved" && html`
          <div class="note warn" style=${{ marginTop: 12 }}>
            Le evidenze KV non sono risolte: ${m.kvKbRange.low}–${m.kvKbRange.high} KB/token.
            I risultati mostrano la sensibilità su questo intervallo.
          </div>`}
        ${m.notes && html`<div class="note" style=${{ marginTop: 12 }}>${m.notes}</div>`}
      <//>
    </div>`;
}

function HardwareView({ st, set, r, catalog, onQuote }) {
  const toggle = (id) =>
    set("hardware", st.hardware.map((h) => (h.id === id ? { ...h, enabled: h.enabled === false } : h)));
  const own = r.options.filter((o) => o.kind === "own");
  const alt = r.options.filter((o) => o.kind !== "own");

  const Row = (o, onQuote) => html`
    <tr key=${o.hw.id} class=${!o.sizing.fits ? "is-dead" : o === r.bestOwn || o === r.bestAlt ? "is-best" : ""}>
      <td>
        <div class="row" style=${{ gap: 6 }}>
          <strong>${o.hw.label}</strong>
          <${Badge} kind=${o.hw.confidence}>${o.hw.confidence || "?"}<//>
          ${o.sizing.profileConfidence && html`
            <${Badge} kind=${o.sizing.profileConfidence}>profilo: ${o.sizing.profileConfidence}<//>`}
          ${o.hw.sovereign === false && html`<${Badge} kind="nonsov">non UE<//>`}
          ${o.eligibility?.referenceOnly && html`<${Badge} kind="nonsov">riferimento<//>`}
          ${o.eligibility && !o.eligibility.eligible && html`<${Badge} kind="bad">non eleggibile<//>`}
        </div>
        <div class="small muted" style=${{ marginTop: 3 }}>
          ${o.hw.topology || o.hw.class}${o.hw.provider ? " · " + o.hw.provider : ""}
        </div>
        ${o.eligibility?.referenceNotes?.length > 0 && html`
          <div class="small muted" style=${{ marginTop: 3 }}>${o.eligibility.referenceNotes.join(" ")}</div>`}
        ${o.eligibility && !o.eligibility.eligible && html`
          <div class="small" style=${{ marginTop: 3 }}>${o.eligibility.reasons.join(" ")}</div>`}
        ${o.sizing.warnings?.length > 0 && html`
          <div class="small muted" style=${{ marginTop: 3 }}>${o.sizing.warnings.join(" ")}</div>`}
      </td>
      <td>${o.kind !== "subscription" ? html`<${Ladder} sizing=${o.sizing} />` : html`<span class="muted small">per posto e per token</span>`}</td>
      <td class="num">${o.sizing.fits && o.kind !== "subscription" ? nf(o.sizing.aggregate) : "—"}</td>
      <td class="num">${eur(o.cost.capex)}</td>
      <td class="num">${eur(o.cost.energy4)}</td>
      <td class="num">${eur(o.cost.mgmt4)}</td>
      <td class="num">${eur(o.cost.service4)}</td>
      <td class="num strong">${o.sizing.fits ? eur(o.cost.total) : "—"}</td>
      <td class="num">${o.sizing.fits ? (o.perMToken || 0).toFixed(3) : "—"}</td>
      <td>
        ${o.sizing.fits && o.eligibility?.eligible && !o.cost.underProvisioned
          ? html`<button class="btn sm" type="button" onClick=${() => onQuote(o)}>Preventivo</button>`
          : html`<span class="muted small">non eleggibile</span>`}
      </td>
    </tr>`;

  return html`
    <div class="stack">
      <p class="lede">
        Le opzioni hardware eseguono il modello selezionato con lo stesso carico di lavoro. Le alternative in abbonamento mantengono la forma del carico di lavoro ma possono differire per qualità, latenza, contesto e strumenti. La scala mostra i tre limiti che determinano il numero di macchine — memoria KV, serving combinato prefill/decode e sessioni di runtime — con il vincolo in ambra. Dimensionare in base a qualcosa di diverso dal vincolo è il modo in cui si acquista capacità che non si usa mai.
      </p>

      <${Panel} title="Di proprietà" hint=${`spesa di capitale, ${st.econ.years} anni`} tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th>Configurazione</th><th style=${{ width: 210 }}>Scala dei vincoli</th>
              <th class="num">tok/s aggregati</th><th class="num">CapEx</th><th class="num">Energia</th>
              <th class="num">Gestione</th><th class="num">Servizio</th><th class="num">Totale</th><th class="num">€/1M</th><th></th>
            </tr></thead>
            <tbody>${own.map((o) => Row(o, onQuote))}</tbody>
          </table>
        </div>
      <//>

      <${Panel} title="Noleggio o abbonamento" hint="comparabili eleggibili e opzioni di riferimento" tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th>Opzione</th><th style=${{ width: 210 }}>Scala dei vincoli</th>
              <th class="num">tok/s aggregati</th><th class="num">CapEx</th><th class="num">Energia</th>
              <th class="num">Gestione</th><th class="num">Servizio</th><th class="num">Totale</th><th class="num">€/1M</th><th></th>
            </tr></thead>
            <tbody>${alt.map((o) => Row(o, onQuote))}</tbody>
          </table>
        </div>
        <details class="expand">
          <summary>Perché i provider API per token non sono in questo elenco</summary>
          <div class="inner">
            Se il motivo per cui stai leggendo è la governance dei dati, i provider che instradano il tuo traffico attraverso giurisdizioni che non puoi verificare non sono comparabili a nessun prezzo. Rimane affittare l'hardware a un provider sovrano, oppure abbonarsi a un vendor di cui ti fidi già per il CRM e la posta. Entrambi sono qui. Aggiungi il tuo in <span class="mono">data/hardware.json</span> se il tuo perimetro di conformità è diverso.
          </div>
        </details>
      <//>

      <div class="grid two">
        <${Panel} title="Catalogo" hint="deseleziona per escludere un'opzione dal confronto">
          ${st.hardware.map((h) => {
            const option = r.options.find((o) => o.hw.id === h.id);
            const matches = (catalog.profiles?.profiles || []).filter(
              (p) => p.modelId === st.model.id && p.hardwareId === h.id
            );
            return html`<div key=${h.id} style=${{ marginBottom: 10 }}>
              <${Check} label=${h.label}
                sub=${(h.provider ? h.provider + " · " : "") + (h.confidence || "")}
                checked=${h.enabled !== false} onChange=${() => toggle(h.id)} />
              ${matches.length > 0 && html`<div class="field">
                <label>Profilo di runtime<span class="sub">Evidenze di modello, hardware e runtime fissati</span></label>
                <select value=${st.profileOverrides[h.id] || ""}
                  onChange=${(e) => set(`profileOverrides.${h.id}`, e.target.value || null)}>
                  <option value="">corrispondenza esatta automatica</option>
                  ${matches.map((p) => html`<option key=${p.id} value=${p.id}>${p.id} · ${p.runtime}</option>`)}
                </select>
              </div>`}
              <${Field} label="Quantità manuale"
                sub=${`0 = raccomandazione conservativa ${nf(option?.sizing.recommendedUnits)}; minimo di base ${nf(option?.sizing.minimumUnits)}`}
                unit="unità" value=${st.manualQty[h.id] || 0}
                onChange=${(v) => set(`manualQty.${h.id}`, v)} />
            </div>`;
          })}
        <//>

        <${Panel} title="Condizioni di noleggio">
          <${PctField} label="Sconto per impegno pluriennale" sub="Gli impegni pluriennali riducono l'on-demand del 30–60% — ed eliminano l'elasticità che giustificava il premio"
            unit="sconto" value=${st.rental.reserveDiscount} onChange=${(v) => set("rental.reserveDiscount", v)} />
          <${PctField} label="Quota anticipata" sub="Solo la tempistica del flusso di cassa; non modifica il TCO non attualizzato"
            unit="pagata alla firma" value=${st.rental.upfrontShare} onChange=${(v) => set("rental.upfrontShare", v)} />
          <div class="note warn" style=${{ marginTop: 12 }}>
            I pesi devono restare residenti, quindi un nodo in noleggio viene fatturato 24/7 che lo si usi o no. L'elasticità per cui paghi un premio non esiste per questo carico di lavoro.
          </div>
        <//>
      </div>
    </div>`;
}

function ComparablesView({ st, set, catalog }) {
  return html`
    <div class="stack">
      <p class="lede">
        Prezzato per popolazione, perché le popolazioni si comportano diversamente. Gli sviluppatori hanno bisogno di un posto premium. Gli utenti occasionali di un posto economico. <strong>Gli agenti autonomi non rientrano in un piano per posto</strong> — consumano token, e la loro fattura è dominata dall'economia della cache.
      </p>
      <div class="grid two">
        <${Panel} title="Posti">
          <${Field} label="Piano sviluppatori" sub="Piano Cursor / code per il coding agentico intensivo" unit="$/posto/mese"
            value=${st.subs.devPlan} step=${5} onChange=${(v) => set("subs.devPlan", v)} />
          <${Field} label="Piano utente occasionale" sub="Suite di produttività con assistente incluso" unit="$/posto/mese"
            value=${st.subs.casualPlan} step=${1} onChange=${(v) => set("subs.casualPlan", v)} />
          <${PctField} label="Eccedenza sui posti sviluppatore" sub="Anche i piani premium hanno quote. Misura quanto spesso le persone le raggiungono prima di fidarti del list-price."
            unit="aggiunti" value=${st.subs.overage} onChange=${(v) => set("subs.overage", v)} />
          <${Field} label="Token di sviluppatore inclusi per anno"
            sub="L'utilizzo oltre questa dotazione è prezzato alle tariffe API qui sotto"
            unit="token/posto" value=${st.subs.devIncludedTokensYear} step=${100000000}
            onChange=${(v) => set("subs.devIncludedTokensYear", v)} />
          <${Field} label="Token di utente occasionale inclusi per anno"
            unit="token/posto" value=${st.subs.casualIncludedTokensYear} step=${10000000}
            onChange=${(v) => set("subs.casualIncludedTokensYear", v)} />
          <div class="sectionlabel" style=${{ marginTop: 16 }}>Prezzi di riferimento</div>
          <dl class="kv">
            ${catalog.defaults.subscriptionRefs.flatMap((x, i) => [
              html`<dt key=${"t" + i}>${x.label}${x.note ? " — " + x.note : ""}</dt>`,
              html`<dd key=${"d" + i}>${x.price} <span class="muted">${x.unit}</span></dd>`,
            ])}
          </dl>
        <//>

        <div class="stack">
          <${Panel} title="API per token per agenti">
            <${Field} label="Input, non in cache" unit="$/1M" value=${st.subs.apiIn} step=${0.05} onChange=${(v) => set("subs.apiIn", v)} />
            <${Field} label="Input, in cache" sub="Uno sconto del 90% sul prefisso ripetuto — è questo che rende sostenibili gli agenti autonomi"
              unit="$/1M" value=${st.subs.apiCached} step=${0.01} onChange=${(v) => set("subs.apiCached", v)} />
            <${Field} label="Conservazione della cache" sub="I provider fatturano il mantenimento della cache attiva, non solo la lettura. Una cache di grandi dimensioni mantenuta più a lungo del necessario diventa un centro di costo a sé."
              unit="$/1M/ora" value=${st.subs.apiStorage} step=${0.1} onChange=${(v) => set("subs.apiStorage", v)} />
            <${Field} label="Output" sub="I token di ragionamento vengono fatturati a questa tariffa: l'output reale può superare di molto la risposta visibile"
              unit="$/1M" value=${st.subs.apiOut} step=${0.25} onChange=${(v) => set("subs.apiOut", v)} />
          <//>
          <${Panel} title="Immagini e video">
            <div class="note warn" style=${{ marginBottom: 10 }}>
              Esclusi dai totali principali: questo calcolatore non ha un profilo locale di generazione media corrispondente.
            </div>
            <${Field} label="Generazione di immagini" unit="$/immagine" value=${st.subs.imagePrice} step=${0.005}
              derived />
            <${Field} label="Video, 720p" unit="$/secondo" value=${st.subs.videoPrice} step=${0.01}
              derived />
          <//>
          <${Panel} title="Energia e orizzonte">
            <${Field} label="Elettricità" sub="Tariffa industriale del tuo sito" unit="€/kWh" value=${st.econ.kwhPrice}
              step=${0.01} onChange=${(v) => set("econ.kwhPrice", v)} />
            <${PctField} label="Utilizzo hardware manuale"
              sub=${st.costs.energyMode === "derived" ? "Informativo: l'energia usa attualmente un utilizzo derivato dalla domanda" : "Determina l'assorbimento medio tra inattivo e picco"}
              unit="quota" value=${st.econ.utilization}
              derived=${st.costs.energyMode === "derived"}
              onChange=${(v) => set("econ.utilization", v)} />
            <${Field} label="Orizzonte" unit="anni" value=${st.econ.years} onChange=${(v) => set("econ.years", v)} />
            <${Field} label="USD → EUR" unit="tasso" value=${st.econ.fx} step=${0.01} onChange=${(v) => set("econ.fx", v)} />
            <${PctField} label="Premio massimo accettato dalla tua organizzazione"
              sub="Una soglia di decisione specifica dello scenario, non un fatto di mercato"
              unit="quota" value=${st.econ.onPremPremium} onChange=${(v) => set("econ.onPremPremium", v)} />
          <//>
          <${Panel} title="Produzione ed eleggibilità">
            <${PctField} label="Utilizzo target massimo" sub="Lascia margine di capacità per latenza e traffico"
              unit="quota" value=${st.resilience.targetUtilization}
              onChange=${(v) => set("resilience.targetUtilization", v)} />
            <${Check} label="Aggiungi resilienza N+1" sub="Una unità di serving in più per manutenzione o guasto"
              checked=${st.resilience.nPlusOne} onChange=${(v) => set("resilience.nPlusOne", v)} />
            <${Field} label="Riserva di manutenzione aggiuntiva" sub="Unità fisse oltre la capacità conservativa"
              unit="unità" value=${st.resilience.maintenanceReserve}
              onChange=${(v) => set("resilience.maintenanceReserve", v)} />
            <${Field} label="Vita prevista dell'hardware per l'erogazione del modello" sub="Più breve dell'orizzonte comporta CapEx di sostituzione"
              unit="anni" value=${st.costs.modelLifeYears}
              onChange=${(v) => set("costs.modelLifeYears", v)} />
            <${Check} label="Preferisci alternative sovrane"
              sub="I noleggi non UE restano nel confronto di costo e sono etichettati come solo riferimento"
              checked=${st.requirements.sovereignOnly}
              onChange=${(v) => set("requirements.sovereignOnly", v)} />
            <div class="field">
              <label>Regioni di noleggio preferite<span class="sub">Solo etichetta di riferimento — non esclude i noleggi. Separate da virgole, ad esempio UE, Francia</span></label>
              <input type="text" value=${(st.requirements.regions || []).join(", ")}
                onChange=${(e) => set("requirements.regions",
                  e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
            </div>
            <${Check} label="Richiedi capacità equivalente"
              sub="Esclude i servizi senza una corrispondenza di qualità/capacità validata separatamente"
              checked=${st.requirements.requireEquivalentCapability}
              onChange=${(v) => set("requirements.requireEquivalentCapability", v)} />
            <div class="field">
              <label>Confidenza minima delle evidenze<span class="sub">Le opzioni sotto questo livello restano solo di riferimento</span></label>
              <select value=${st.requirements.minimumConfidence}
                onChange=${(e) => set("requirements.minimumConfidence", e.target.value)}>
                ${["estimated", "community", "published", "measured"].map((x) =>
                  html`<option key=${x} value=${x}>${x}</option>`)}
              </select>
            </div>
          <//>
        </div>
      </div>

      <${Panel} title="Vendi la capacità residua alla tua filiera" hint="optional">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Non si tratta di affittare GPU — <strong>esporre un endpoint</strong> — I tuoi pesi e i tuoi dati non escono mai; entra il traffico dei tuoi clienti. L'eleggibilità dipende comunque dai loro contratti e dai tuoi controlli. I ricavi sono limitati dal margine di capacità di serving misurato e possono essere non redditizi dopo energia e gestione operativa.
        </p>
        <div class="grid two">
          <div>
            <${Check} label="Modella questo ricavo" sub="Disattivato per impostazione predefinita: è una decisione commerciale, non un'ipotesi"
              checked=${st.resale.enabled} onChange=${(v) => set("resale.enabled", v)} />
            <${PctField} label="Quota di ore con capacità residua" sub="Diminuisce man mano che aggiungi i tuoi agenti notturni — le due modalità di riempire l'hardware sono alternative"
              unit="quota" value=${st.resale.freeHoursShare} onChange=${(v) => set("resale.freeHoursShare", v)} />
            <${PctField} label="Vendita realizzata" sub="La domanda della tua filiera è più prevedibile di un marketplace, ma non è continua"
              unit="quota" value=${st.resale.sellThrough} onChange=${(v) => set("resale.sellThrough", v)} />
          </div>
          <div>
            <${Field} label="Prezzo di vendita, input" unit="€/1M" value=${st.resale.priceIn} step=${0.01}
              onChange=${(v) => set("resale.priceIn", v)} />
            <${Field} label="Prezzo di vendita, output" unit="€/1M" value=${st.resale.priceOut} step=${0.01}
              onChange=${(v) => set("resale.priceOut", v)} />
            <${Field} label="Input : output del traffico venduto" sub="Prefill e decode competono per lo stesso silicio, quindi il mix determina la capacità reale"
              unit=":1" value=${st.resale.mix} step=${0.1} onChange=${(v) => set("resale.mix", v)} />
            <${PctField} label="Costo commerciale e operativo" sub="Fatturazione a consumo, contratti, SLA, onboarding, supporto di primo livello. Vendere a terzi è un business, non un risparmio."
              unit="di una persona" value=${st.resale.opsQuota} onChange=${(v) => set("resale.opsQuota", v)} />
          </div>
        </div>
      <//>
    </div>`;
}

function ResultsView({ st, r, sensitivity, onQuote }) {
  const best = r.bestOwn;
  const premiumOver = r.premiumActual !== null && r.premiumActual > r.premiumAccepted;
  return html`
    <div class="stack">
      ${!r.validation.valid && html`<div class="note bad">
        <b>Scenario non valido.</b> ${r.validation.errors.join(" ")}
      </div>`}
      ${r.validation.warnings.length > 0 && html`<div class="note warn">
        <b>Avvertenze decisionali.</b> ${r.validation.warnings.join(" ")}
      </div>`}
      ${best?.sizing.warnings?.length > 0 && html`<div class="note warn">
        <b>Evidenze della configurazione selezionata.</b> ${best.sizing.warnings.join(" ")}
      </div>`}
      ${st.resale.enabled && best && !best.cost.resaleFeasible && html`
        <div class="note warn"><b>La rivendita non è sostenibile in termini di capacità.</b>
          Nessun ricavo è riconosciuto dopo la domanda interna e la riserva di utilizzo configurata.
        </div>`}
      <div class="readouts">
        <${Readout} k="Opzione di proprietà più economica" v=${eur(r.bestOwn?.cost.total)} tone="hi"
          n=${r.bestOwn ? `${r.bestOwn.hw.label} · ${r.bestOwn.cost.qty} unità` : "non entra"} />
        <${Readout} k="Alternativa eleggibile più economica" v=${eur(r.bestAlt?.cost.total)} n=${r.bestAlt?.hw.label} />
        <${Readout} k="Premio di proprietà" v=${eur(r.delta)} tone=${premiumOver ? "warn" : "good"}
          n=${r.premiumActual !== null ? pct(r.premiumActual) + " rispetto all'alternativa" : ""} />
        <${Readout} k="Per persona per anno" v=${eur(r.perHeadOwn)} n=${`rispetto a ${eur(r.perHeadAlt)} con l'alternativa`} />
        <${Readout} k="Carico di gestione" v=${(best?.cost.mgmtHoursDay || 0).toFixed(2) + " h/day"}
          n="Verificalo rispetto al tuo team" />
        <${Readout} k="Utilizzo dell'energia" v=${pct(best?.cost.utilizationUsed || 0)}
          n=${best?.cost.energyBasis === "derived" ? "derivato dalla domanda annuale di serving" : "sostituzione manuale"} />
        <${Readout} k="Vincolo conservativo" v=${bindingLabel(best?.sizing.recommendationBinding || best?.sizing.binding)} tone="warn"
          n=${`base ${bindingLabel(best?.sizing.binding)} · min ${nf(best?.sizing.minimumUnits)} · rac ${nf(best?.sizing.recommendedUnits)}`} />
      </div>

      <${Panel} title="Richiedi un preventivo" hint="acquista o distribuisci una configurazione">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Vuoi aiuto per acquistare, noleggiare o mettere in funzione una di queste opzioni? Apre la pagina contatti di Dinova e copia un riepilogo dello scenario negli appunti, così puoi incollarlo. Il calcolatore in sé continua a non inviare i tuoi dati.
        </p>
        <div class="row" style=${{ gap: 8, flexWrap: "wrap" }}>
          <button class="btn primary" type="button" onClick=${() => onQuote(best || null)}
            disabled=${!best?.sizing?.fits || !best?.eligibility?.eligible || best?.cost?.underProvisioned}>
            Preventivo per l'opzione di proprietà più economica${best?.sizing?.fits ? ` — ${best.hw.label}` : ""}
          </button>
          ${r.bestAlt?.sizing?.fits && r.bestAlt?.eligibility?.eligible && !r.bestAlt?.cost?.underProvisioned && html`
            <button class="btn" type="button" onClick=${() => onQuote(r.bestAlt)}>
              Preventivo per l'alternativa — ${r.bestAlt.hw.label}
            </button>`}
        </div>
      <//>

      <${Panel} title="Intervallo di sensibilità" hint="conservativo · base · ottimistico">
        <div class="readouts">
          <${Readout} k="Di proprietà conservativo" v=${eur(sensitivity.summaries.conservative.ownTotal)}
            n=${`${nf(sensitivity.summaries.conservative.ownUnits)} unità`} />
          <${Readout} k="Di proprietà base" v=${eur(sensitivity.summaries.base.ownTotal)}
            n=${`${nf(sensitivity.summaries.base.ownUnits)} unità`} />
          <${Readout} k="Di proprietà ottimistico" v=${eur(sensitivity.summaries.optimistic.ownTotal)}
            n=${`${nf(sensitivity.summaries.optimistic.ownUnits)} unità`} />
        </div>
        ${(sensitivity.winnerChanges || sensitivity.bindingChanges) && html`
          <div class="note warn" style=${{ marginTop: 10 }}>
            Il vincitore raccomandato o il vincolo cambia all'interno dell'intervallo delle evidenze. Verifica sul runtime esatto prima dell'acquisto.
          </div>`}
      <//>

      ${r.premiumActual !== null &&
      html`<div class=${"note " + (premiumOver ? "warn" : "info")}>
        ${premiumOver
          ? html`<span>Il premio per la proprietà è <b>${pct(r.premiumActual)}</b>, above the <b>${pct(r.premiumAccepted)}</b>
              configurato come premio accettato. Sopra questa soglia, la decisione richiede una motivazione esplicita non economica.</span>`
          : html`<span>Il premio per la proprietà è <b>${pct(r.premiumActual)}</b>, inside the <b>${pct(r.premiumAccepted)}</b>
              configurato come accettabile. Questo scenario rientra nella soglia fornita dall'utente.</span>`}
      </div>`}

      ${best &&
      html`<${Panel} title="Questo strumento è ancora quello giusto" hint="controllo di dominio">
        <div class="grid three">
          <div class="kv">
            <dt>Unità</dt><dd>${nf(best.domain.qty)}</dd>
            <dt>Assorbimento di picco</dt><dd>${nf(best.domain.kwPeak, 1)} kW</dd>
            <dt>Per rack</dt><dd>${nf(best.domain.rackDensity, 1)} kW</dd>
            <dt>Persone che devono conoscere lo stack</dt><dd>${best.domain.busFactor}</dd>
          </div>
          <div class="domain-note">
            ${best.domain.verdict === "out-of-domain"
              ? html`<div class="note bad"><b>Fuori dominio.</b> Sopra otto nodi o 150 kW il costo è dominato
                  dall'infrastruttura — edificio, allaccio alla rete, ridondanza, raffreddamento, turni 24/7. Questo modello
                  ti dà il carico IT in kW, che è l'<em>input</em> di un modello di infrastruttura, non il modello stesso.</div>`
              : best.domain.verdict === "at-limit"
              ? html`<div class="note warn"><b>Al limite.</b> Il dimensionamento regge. Rielabora a mano la voce dei costi sulla base delle ipotesi di infrastruttura e continuità. Le soglie sono indicative e non sono incluse nel TCO.</div>`
              : html`<div class="note info"><b>Nel dominio.</b> Scala di una sala server, un modello testuale residente. Le indicazioni su infrastruttura e bus factor sono indicative e non incluse nel TCO.</div>`}
          </div>
        </div>
      <//>`}

      <${Panel} title="Costo per milione di token" hint="le colonne input/output ripartiscono il TCO locale in base al tempo di servizio dell'acceleratore" tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Opzione</th><th class="num">${st.econ.years} anni</th><th class="num">€/1M medio</th>
              <th class="num">Input €/1M</th><th class="num">Output €/1M</th>
              <th class="num">Occupazione di picco</th><th class="num">Occupazione media</th><th>Confidenza</th></tr></thead>
            <tbody>
              ${[...r.options].sort((a, b) => (a.perMToken || 9e9) - (b.perMToken || 9e9)).map(
                (o) => html`<tr key=${o.hw.id} class=${!o.sizing.fits ? "is-dead" : ""}>
                  <td>${o.hw.label}</td>
                  <td class="num">${o.sizing.fits ? eur(o.cost.total) : "non entra"}</td>
                  <td class="num strong">${o.sizing.fits ? (o.perMToken || 0).toFixed(3) : "—"}</td>
                  <td class="num">${o.perMInput != null ? o.perMInput.toFixed(3) : "—"}</td>
                  <td class="num">${o.perMOutput != null ? o.perMOutput.toFixed(3) : "—"}</td>
                  <td class="num">${o.util ? pct(o.util.occupancyPeak) : "—"}</td>
                  <td class="num">${o.util ? pct(o.util.occupancyMean) : "—"}</td>
                  <td><${Badge} kind=${o.sizing.profileConfidence || o.hw.confidence}>
                    ${o.sizing.profileConfidence || o.hw.confidence || "?"}<//></td>
                </tr>`
              )}
            </tbody>
          </table>
        </div>
        <details class="expand">
          <summary>Perché l'occupazione media è di solito il numero scomodo</summary>
          <div class="inner">
            Compri per il picco e lo usi durante l'orario d'ufficio. Un provider aggrega la domanda tra fusi orari e lavora vicino alla saturazione 24 ore su 24. Stesso silicio, un ordine di grandezza di differenza sul costo per token — è così che un provider può prendersi un margine sano e comunque batterti sul prezzo. Alzare la propria occupazione media è l'unica leva che chiude il gap, e gli agenti autonomi sono il modo realistico di farlo.
          </div>
        </details>
      <//>

      ${best?.util &&
      html`<${Panel} title="Margine di capacità" hint="ciò che hai comprato e non usi">
        <div class="readouts">
          <${Readout} k="Decode residuo al picco" v=${nf(best.util.freeCapacity) + " tok/s"} />
          <${Readout} k="Occupazione KV" v=${pct(best.util.occupancyKv)} />
          <${Readout} k="Sviluppatori che potresti aggiungere" v=${nf(best.util.extraDevs, 1)} tone="good"
            n="Prima di comprare altro hardware" />
        </div>
      <//>`}
    </div>`;
}

function PackagesView({ st, r, catalog }) {
  const [sizes] = useState([
    { name: "XS — Base di partenza", employees: 80, aiUsers: 20, tokensOutPerDay: 120000, profile: "Studio professionale, boutique ingegneristica, laboratorio R&D" },
    { name: "S — Reparto", employees: 150, aiUsers: 40, tokensOutPerDay: 180000, profile: "Ufficio tecnico di una PMI, divisione R&D farmaceutica, subappaltatore aerospaziale" },
    { name: "M — Azienda", employees: 300, aiUsers: 80, tokensOutPerDay: 250000, profile: "Meccanica di precisione, automazione, packaging. Ufficio tecnico strutturato con IT interno" },
    { name: "L — Multi-sede", employees: 600, aiUsers: 150, tokensOutPerDay: 250000, profile: "Gruppo industriale, diversi stabilimenti, ingegneria e qualità" },
    { name: "XL — Distretto", employees: 1000, aiUsers: 250, tokensOutPerDay: 300000, profile: "Leader nella supply chain che serve anche i propri fornitori" },
  ]);
  const rows = useMemo(
    () => packages(st, sizes, catalog.profiles?.profiles || []),
    [st, sizes, catalog]
  );

  return html`
    <div class="stack">
      <p class="lede">
        Lo stesso motore applicato a cinque forme dell'organico. <strong>La colonna che conta in una riunione è il prezzo di pareggio per posto</strong>  — l'importo mensile per posto a cui l'abbonamento attuale del cliente costa esattamente quanto il tuo pacchetto. Sotto questo valore stai chiedendo un premio e servono argomentazioni di governance. Sopra sei semplicemente più economico, e la conversazione cambia natura.
      </p>

      <${Panel} title="Gamma" tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th>Pacchetto</th><th class="num">Personale</th><th class="num">Utenti AI</th><th>Configurazione</th>
              <th class="num">Unità</th><th class="num">${st.econ.years} anni</th><th class="num">€/utente/mese</th>
              <th class="num">Posto di pareggio</th><th>Esito</th>
            </tr></thead>
            <tbody>
              ${rows.map(
                (p) => html`<tr key=${p.name}>
                  <td><strong>${p.name}</strong><div class="small muted" style=${{ maxWidth: 260, marginTop: 3 }}>${p.profile}</div></td>
                  <td class="num">${nf(p.employees)}</td>
                  <td class="num">${nf(p.aiUsers)}</td>
                  <td>${p.feasible ? p.option : "—"}</td>
                  <td class="num">${p.feasible ? nf(p.units) : "—"}</td>
                  <td class="num strong">${p.feasible ? eur(p.total) : "—"}</td>
                  <td class="num">${p.feasible ? eur2(p.perUserMonth) : "—"}</td>
                  <td class="num strong">${p.feasible ? "$" + nf(p.breakEvenSeat, 0) : "—"}</td>
                  <td>${p.feasible
                    ? html`<${Badge} kind=${p.verdict === "competitive" ? "ok" : p.verdict === "hard-sell" ? "bad" : "estimated"}>
                        ${packageVerdictLabel(p.verdict)}<//>`
                    : "—"}</td>
                </tr>`
              )}
            </tbody>
          </table>
        </div>
      <//>

      <div class="grid two">
        <${Panel} title="Cosa portare sul tavolo">
          <div class="stack" style=${{ gap: 12 }}>
            <div class="note info">
              <b>Inizia dal costo per utente al mese, non dal totale del progetto.</b> Si confronta naturalmente con una licenza software professionale. Il totale scatena una reazione difensiva prima ancora che tu finisca la frase.
            </div>
            <div class="note">
              <b>Non chiedere quanto spendono per l'AI.</b> Chiedi su quale piano sono e quanto spesso le loro persone raggiungono i limiti. La prima domanda ti dà un numero difensivo; la seconda ti dà il vero comparabile.
            </div>
            <div class="note">
              <b>Il servizio gestito è il prodotto.</b> L'hardware è una vendita una tantum a margine compresso. Il bus factor morde da tre nodi in su: un cliente con 300 persone non può giustificare due persone dedicate. Tu puoi, su dieci clienti.
            </div>
            <div class="note warn">
              <b>Non vendere un risparmio che non esiste.</b> Un CFO rispetta molto di più un premio quantificato di un risparmio gonfiato, e troverà il gonfiamento.
            </div>
          </div>
        <//>

        <${Panel} title="Priorità dei prospect" hint="euristica commerciale non validata; non fa parte dell'ingegneria né del TCO">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Settore</th><th class="num">Motivo</th><th>Dimensione tipica</th></tr></thead>
              <tbody>
                ${catalog.defaults.sectors.map(
                  (s) => html`<tr key=${s.id}>
                    <td><strong>${s.name}</strong><div class="small muted" style=${{ marginTop: 3 }}>${s.note}</div></td>
                    <td class="num">${s.driver}</td>
                    <td class="small">${s.typicalSize}</td>
                  </tr>`
                )}
              </tbody>
            </table>
          </div>
        <//>
      </div>
    </div>`;
}

function BenchmarksView({ catalog }) {
  return html`
    <div class="stack">
      <p class="lede">
        Uno storico, non un input. <strong>Nulla qui alimenta direttamente il calcolo</strong>  — i dati vengono riportati nei cataloghi dei modelli e dell'hardware solo dopo la revisione, e ciascuno è accompagnato da un livello di confidenza. Tra sei mesi sapere quali numeri erano misurati e quali erano ipotizzati conterà più dei numeri stessi.
      </p>
      ${catalog.benchmarks.benchmarks.map(
        (b) => html`
          <${Panel} key=${b.id} title=${b.model}
            hint=${b.hardware + " · " + b.date}
            actions=${html`<${Badge} kind=${b.confidence}>${b.confidence}<//>`}>
            <div class="mono small muted" style=${{ marginBottom: 12, wordBreak: "break-word" }}>${b.config}</div>
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr><th>Metrica</th><th class="num">Valore</th><th>Nota</th></tr></thead>
                <tbody>
                  ${b.metrics.map((m, i) => html`<tr key=${b.id + "-" + i}>
                    <td>${m.label}</td><td class="num strong">${m.value}</td><td class="small muted">${m.note || ""}</td>
                  </tr>`)}
                </tbody>
              </table>
            </div>
            ${b.qualification && html`<div class="note" style=${{ marginTop: 12 }}><b>Qualificazione.</b> ${b.qualification}</div>`}
            ${b.highlight && html`<div class="note info" style=${{ marginTop: 10 }}>${b.highlight}</div>`}
            ${b.caveats?.length &&
            html`<details class="expand" style=${{ marginTop: 12, marginLeft: -16, marginRight: -16, marginBottom: -16 }}>
              <summary>${b.caveats.length} avvertenz${b.caveats.length === 1 ? "a" : "e"} da leggere prima di fidarti di questi numeri</summary>
              <div class="inner">
                <ul style=${{ margin: 0, paddingLeft: 18 }}>
                  ${b.caveats.map((c, i) => html`<li key=${i} style=${{ marginBottom: 6 }}>${c}</li>`)}
                </ul>
              </div>
            </details>`}
          <//>`
      )}
    </div>`;
}

function ExportView({ st, r, onImport, onExport, onMarkdown, onReset, onQuote }) {
  const fileRef = useRef(null);
  return html`
    <div class="stack">
      <p class="lede">
        Nessun account, nessun database, nessuna telemetria. <strong>Un file sul tuo disco è l'intero livello di persistenza.</strong>
        Tutto ciò che hai digitato resta in questa scheda del browser finché non lo salvi o chiudi.
      </p>
      <div class="grid two">
        <${Panel} title="Esporta">
          <div class="stack" style=${{ gap: 12 }}>
            <div>
              <button class="btn primary" onClick=${onMarkdown}>Esporta come Markdown</button>
              <p class="small muted" style=${{ marginTop: 6 }}>
                Un report leggibile: input, carico di lavoro, tutte le opzioni confrontate, dettagli del dimensionamento, il controllo di dominio e i livelli di confidenza. Incollalo in un verbale decisionale.
              </p>
            </div>
            <div>
              <button class="btn" onClick=${onExport}>Esporta come JSON</button>
              <p class="small muted" style=${{ marginTop: 6 }}>
                Lo scenario completo. Ricaricalo qui per riprendere esattamente da dove avevi lasciato.
              </p>
            </div>
          </div>
        <//>
        <${Panel} title="Importa">
          <div class="stack" style=${{ gap: 12 }}>
            <div>
              <button class="btn" onClick=${() => fileRef.current?.click()}>Importa uno scenario JSON</button>
              <input ref=${fileRef} type="file" accept="application/json,.json" class="hidden-file"
                onChange=${(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} />
              <p class="small muted" style=${{ marginTop: 6 }}>
                Sostituisce tutto ciò che è attualmente sullo schermo. Esporta prima se vuoi conservarlo.
              </p>
            </div>
            <div>
              <button class="btn" onClick=${onReset}>Reimposta i valori predefiniti</button>
            </div>
          </div>
        <//>
      </div>

      <${Panel} title="Richiedi un preventivo">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Pronto ad acquistare o distribuire? Copiamo un riepilogo dello scenario LocalAI-TCO negli appunti e apriamo la pagina contatti di Dinova.
        </p>
        <button class="btn primary" type="button" onClick=${() => onQuote(r.bestOwn || null)}
          disabled=${!r.validation?.valid || !r.bestOwn?.sizing?.fits || !r.bestOwn?.eligibility?.eligible || r.bestOwn?.cost?.underProvisioned}>
          Richiedi un preventivo
        </button>
      <//>

      <${Panel} title="Istantanea dello scenario">
        <dl class="kv">
          <dt>Modello</dt><dd>${st.model.name}</dd>
          <dt>Organico</dt><dd>${nf(r.headcount)}</dd>
          <dt>Agenti autonomi</dt><dd>${nf(st.agents.count)}</dd>
          <dt>Token per anno</dt><dd>${nf(r.workload.totalTokens / 1e9, 1)} B</dd>
          <dt>Decode aggregato</dt><dd>${r.bestOwn?.sizing?.fits ? nf(r.bestOwn.sizing.aggregate) + " tok/s per unità" : "—"}</dd>
          <dt>Opzione di proprietà più economica</dt><dd>${r.bestOwn ? r.bestOwn.hw.label + " — " + eur(r.bestOwn.cost.total) : "—"}</dd>
          <dt>Alternativa eleggibile più economica</dt><dd>${r.bestAlt ? r.bestAlt.hw.label + " — " + eur(r.bestAlt.cost.total) : "—"}</dd>
          <dt>Premio di proprietà</dt><dd>${eur(r.delta)}</dd>
        </dl>
      <//>
    </div>`;
}

/* ---------------- shell ---------------- */

const TABS = [
  ["team", "Organico e costi"],
  ["workload", "Carico di lavoro"],
  ["model", "Modello"],
  ["hardware", "Configurazioni"],
  ["comparables", "Comparabili"],
  ["results", "Risultati"],
  ["packages", "Pacchetti"],
  ["benchmarks", "Benchmarks"],
  ["export", "Esporta e importa"],
];

function App({ catalog }) {
  const build = useCallback(() => {
    const d = catalog.defaults;
    return {
      scenarioName: "",
      org: { ...d.org }, staff: { ...d.staff }, mgmt: { ...d.mgmt },
      econ: { ...d.econ }, workload: { ...d.workload }, agents: { ...d.agents },
      rental: { ...d.rental }, subs: { ...d.subs }, resale: { ...d.resale },
      resilience: { ...d.resilience }, requirements: { ...d.requirements },
      media: { ...d.media }, costs: { ...d.costs }, uncertainty: { ...d.uncertainty },
      model: { ...catalog.models.models[0] },
      hardware: catalog.hardware.hardware.map((h) => ({ ...h, enabled: true })),
      manualQty: {}, profileOverrides: {},
    };
  }, [catalog]);

  const [st, setSt] = useState(build);
  const [tab, setTab] = useState("team");
  const [toast, setToast] = useState(null);
  const [selectedPresetId, setSelectedPresetId] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(() => {
    try { return localStorage.getItem(WIZARD_KEY) !== "1"; }
    catch { return true; }
  });
  const scenarioList = catalog.scenarios?.scenarios || [];

  const say = (msg, err) => { setToast({ msg, err }); setTimeout(() => setToast(null), 3800); };

  const set = useCallback((path, value) => {
    setSt((prev) => {
      const next = { ...prev };
      const parts = path.split(".");
      let node = next;
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = Array.isArray(node[parts[i]]) ? [...node[parts[i]]] : { ...node[parts[i]] };
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = value;
      return next;
    });
  }, []);

  const applyPreset = useCallback((id) => {
    const preset = scenarioList.find((s) => s.id === id);
    if (!preset) return;
    setSelectedPresetId(id);
    setSt((prev) => applyScenarioPatch(prev, preset.patch));
  }, [scenarioList]);

  const markWizardDone = useCallback(() => {
    try { localStorage.setItem(WIZARD_KEY, "1"); } catch { /* private mode */ }
  }, []);

  const closeWizard = useCallback(() => {
    markWizardDone();
    setWizardOpen(false);
  }, [markWizardDone]);

  const finishWizard = useCallback(() => {
    markWizardDone();
    setWizardOpen(false);
    setTab("results");
  }, [markWizardDone]);

  const tuneWizard = useCallback(() => {
    markWizardDone();
    setWizardOpen(false);
    setTab("team");
  }, [markWizardDone]);

  const openWizard = useCallback(() => {
    setWizardOpen(true);
  }, []);

  const profileList = catalog.profiles?.profiles || [];
  const r = useMemo(() => {
    try { return compute(st, profileList); }
    catch (e) { console.error(e); return null; }
  }, [st, profileList]);
  const sensitivity = useMemo(
    () => computeSensitivity(st, profileList),
    [st, profileList]
  );

  const canQuote = useCallback((option = null) => {
    if (!r?.validation?.valid) return false;
    const target = option || r.bestOwn;
    return !!(target?.sizing?.fits && target?.eligibility?.eligible && !target?.cost?.underProvisioned);
  }, [r]);

  const handleQuote = useCallback(async (option = null) => {
    if (!r) return;
    const target = option || r.bestOwn;
    if (!canQuote(target)) {
      say("Questa opzione non è valida, non è eleggibile o è sottodimensionata e non può ricevere un preventivo.", true);
      return;
    }
    const result = await openRfqForm(st, r, target);
    say(result.message, result.err);
  }, [st, r, canQuote]);

  // I campi del modello che l'utente può modificare a schermo: uno scenario
  // importato li conserva, tutto il resto (ricette, note, percorso di offload)
  // torna al catalogo corrente, così uno scenario salvato prima non resta con
  // metadati vecchi.
  const EDITABLE_MODEL_FIELDS = [
    "name", "quantLabel", "totalB", "activeB", "bytesPerParam", "kvKbPerToken",
    "specTokens", "prefillRatio", "maxContext", "maxSeqs", "overheadPerGpu",
  ];

  const handleImport = async (file) => {
    try {
      const data = await importJson(file);
      const next = data.state;
      const cat = next?.model?.id
        ? catalog.models.models.find((m) => m.id === next.model.id)
        : null;
      if (cat) {
        const edited = {};
        for (const k of EDITABLE_MODEL_FIELDS) {
          if (next.model[k] !== undefined) edited[k] = next.model[k];
        }
        next.model = { ...cat, ...edited };
      }
      // Anche l'hardware torna al catalogo: l'unico campo che l'utente decide
      // è se la riga resta nel confronto.
      const catHw = new Map(catalog.hardware.hardware.map((h) => [h.id, h]));
      if (Array.isArray(next.hardware)) {
        next.hardware = next.hardware.map((h) => {
          const entry = catHw.get(h.id);
          return entry ? { ...entry, enabled: h.enabled !== false } : h;
        });
      }
      setSt(next);
      const migrated = data.migrationsApplied?.length
        ? ` Migrato: ${data.migrationsApplied.join(", ")}.`
        : "";
      say(`Caricato “${data.scenarioName || "scenario"}”.${migrated}`);
    } catch (e) { say(e.message, true); }
  };

  if (!r) return html`<div class="main"><div class="note bad">Il calcolo è fallito. Controlla la console e reimposta i valori predefiniti.</div></div>`;

  return html`
    <div class="app">
      <header class="masthead">
        <div class="wordmark">LocalAI-TCO <span class="dim">${APP_TAGLINE.toLowerCase()}</span></div>
        <div class="spacer"></div>
        <div class="masthead-tools">
          <input class="scenario" placeholder="Assegna un nome a questo scenario" value=${st.scenarioName}
            onChange=${(e) => set("scenarioName", e.target.value)} />
          <div class="masthead-actions">
            <button class="btn ghost-dark sm" type="button" onClick=${openWizard}>Configurazione guidata</button>
            <button class="btn ghost-dark sm" onClick=${() => exportMarkdown(st, r)}>Markdown</button>
            <button class="btn ghost-dark sm" onClick=${() => exportJson(st, r)}>JSON</button>
            <button class="btn ghost-dark sm" type="button" onClick=${() => handleQuote(r.bestOwn || null)}
              disabled=${!canQuote()}>
              Richiedi un preventivo
            </button>
          </div>
        </div>
      </header>

      <nav class="tabs">
        ${TABS.map(([id, label], i) => html`
          <button key=${id} class="tab" aria-current=${tab === id ? "page" : undefined} onClick=${() => setTab(id)}>
            <span class="idx">${String(i + 1).padStart(2, "0")}</span>${label}
          </button>`)}
      </nav>

      <main class="main">
        ${tab === "team" && html`<${TeamView} st=${st} set=${set} />`}
        ${tab === "workload" && html`<${WorkloadView} st=${st} set=${set} r=${r} />`}
        ${tab === "model" && html`<${ModelView} st=${st} set=${set} catalog=${catalog.models} />`}
        ${tab === "hardware" && html`<${HardwareView} st=${st} set=${set} r=${r} catalog=${catalog} onQuote=${handleQuote} />`}
        ${tab === "comparables" && html`<${ComparablesView} st=${st} set=${set} catalog=${catalog} />`}
        ${tab === "results" && html`<${ResultsView} st=${st} r=${r} sensitivity=${sensitivity} onQuote=${handleQuote} />`}
        ${tab === "packages" && html`<${PackagesView} st=${st} r=${r} catalog=${catalog} />`}
        ${tab === "benchmarks" && html`<${BenchmarksView} catalog=${catalog} />`}
        ${tab === "export" && html`<${ExportView} st=${st} r=${r}
          onImport=${handleImport} onExport=${() => exportJson(st, r)}
          onMarkdown=${() => exportMarkdown(st, r)}
          onQuote=${handleQuote}
          onReset=${() => { setSelectedPresetId(null); setSt(build()); say("Torna ai valori predefiniti."); }} />`}
      </main>

      <footer class="foot">
        <div class="foot-in">
          <div>
            <h4>${APP_TAGLINE}</h4>
            <p>
              La bandwidth di memoria influenza fortemente il decode, mentre il prefill condivide lo stesso tempo dell'acceleratore. Memoria KV, serving combinato prefill/decode e sessioni di runtime possono pareggiarsi come limiti vincolanti. LocalAI-TCO li mette in evidenza, così puoi dimensionare uno stack locale privato rispetto a ciò che lega davvero.
            </p>
            <p>
              Solo frontend. Nulla di ciò che digiti viene trasmesso da nessuna parte. I cataloghi sono semplici file JSON in
              <span class="mono">data/</span>.
            </p>
          </div>
          <div>
            <h4>Autore</h4>
            <p><strong>Juxhin Radhima</strong></p>
            <p class="small muted">
              Licenza MIT. Autore: Juxhin Radhima.
            </p>
            <p>
              <button class="btn sm" type="button" onClick=${() => handleQuote(r.bestOwn || null)}
                disabled=${!canQuote()}>
                Richiedi un preventivo
              </button>
            </p>
          </div>
          <div class="sponsor">
            <div class="name">Dinova</div>
            <div class="tag">LocalAI-TCO by Dinova</div>
            <p class="small">
              Dimensionamento direzionale per l'AI locale privata. Solo frontend: nessun server, nessuna telemetria, nulla di ciò che digiti lascia il browser.
            </p>
            <a class="small" href="https://localai-tco.dinova.one/" target="_blank" rel="noopener">localai-tco.dinova.one →</a>
          </div>
        </div>
      </footer>

      <div class="verdict">
        <div class="cell"><span class="k">Opzione di proprietà più economica</span><span class="v">${eur(r.bestOwn?.cost.total)}</span></div>
        <div class="cell"><span class="k">Alternativa eleggibile</span><span class="v">${eur(r.bestAlt?.cost.total)}</span></div>
        <div class="cell"><span class="k">Premio di proprietà</span>
          <span class=${"v " + (r.delta > 0 ? "pos" : "neg")}>${eur(r.delta)}</span></div>
        <div class="cell"><span class="k">Per persona / anno</span><span class="v">${eur(r.perHeadOwn)}</span></div>
        <div class="cell"><span class="k">Vincolo conservativo</span>
          <span class="v">${bindingLabel(r.bestOwn?.sizing.recommendationBinding || r.bestOwn?.sizing.binding)}</span></div>
        <div class="spacer"></div>
        <div class="cell"><span class="k">Decode aggregato</span><span class="v">${r.bestOwn?.sizing?.fits ? nf(r.bestOwn.sizing.aggregate) : "—"} <span style=${{ fontSize: 11, color: "#8d93a0" }}>tok/s</span></span></div>
        <button class="btn sm primary" type="button" onClick=${() => handleQuote(r.bestOwn || null)}
          disabled=${!canQuote()}>
          Richiedi un preventivo
        </button>
      </div>

      ${toast && html`<div class=${"toast" + (toast.err ? " err" : "")}>${toast.msg}</div>`}

      ${wizardOpen && html`<${Wizard}
        st=${st} set=${set} r=${r} catalog=${catalog.models}
        scenarios=${scenarioList}
        selectedPresetId=${selectedPresetId}
        onSelectPreset=${applyPreset}
        onClose=${closeWizard} onFinish=${finishWizard} onTune=${tuneWizard} />`}
    </div>`;
}

/* ---------------- boot ---------------- */

async function boot() {
  const el = document.getElementById("root");
  try {
    const [models, hardware, defaults, benchmarks, profiles, scenarios] = await Promise.all(
      ["models", "hardware", "defaults", "benchmarks", "profiles", "scenarios"].map((n) =>
        fetch(`./data/${n}.json`).then((res) => {
          if (!res.ok) throw new Error(`data/${n}.json — ${res.status}`);
          return res.json();
        })
      )
    );
    createRoot(el).render(html`<${App} catalog=${{ models, hardware, defaults, benchmarks, profiles, scenarios }} />`);
  } catch (e) {
    el.innerHTML =
      `<div style="max-width:640px;margin:80px auto;padding:24px;font-family:system-ui">
         <h1 style="font-size:18px;margin:0 0 10px">I cataloghi non sono stati caricati</h1>
         <p style="color:#6b7280;font-size:14px;line-height:1.6">${e.message}</p>
         <p style="color:#6b7280;font-size:14px;line-height:1.6">
           Aprendo <code>index.html</code> dritto dal filesystem non funziona — i browser bloccano
           <code>fetch</code> su <code>file://</code>. Serve la cartella invece:
           <code style="display:block;margin-top:8px;padding:8px;background:#f2f3f5;border-radius:4px">python3 -m http.server 8080</code>
         </p>
       </div>`;
  }
}

boot();
