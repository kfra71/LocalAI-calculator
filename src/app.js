import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";
import { compute, computeSensitivity, packages } from "./engine.js";
import { APP_TAGLINE, applyScenarioPatch, exportJson, exportMarkdown, importJson } from "./io.js";
import { openRfqForm } from "./rfq.js";

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
  if (!sizing.fits) return html`<span class="badge bad">does not fit</span>`;
  const binds = sizing.bindings || String(sizing.binding || "").split("+").filter(Boolean);
  const rows = [
    { k: "kv", label: "KV", units: sizing.unitsKv },
    { k: "serving", label: "Prefill + decode", units: sizing.unitsServing },
    { k: "concurrency", label: "Sessions", units: sizing.unitsSeqs },
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
        Base binding: <b>${sizing.binding}</b> → ${nf(sizing.minimumUnits)} ·
        Conservative: <b>${sizing.recommendationBinding || sizing.binding}</b> → ${nf(sizing.recommendedUnits)}
      </div>
    </div>`;
};

/* ---------------- first-visit wizard ---------------- */

const WIZARD_KEY = "bindwidth.wizard.done";
const WIZARD_STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "scenario", label: "Scenario" },
  { id: "model", label: "Model" },
  { id: "result", label: "Result" },
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
        <div class="wizard-progress" aria-label="Setup steps">
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
              Bindwidth finds which constraint binds — KV memory, combined prefill/decode serving, or session ceiling —
              and prices owned hardware against the alternatives you can use. Pick a realistic starting scenario so
              token rates, concurrency, and peaks match the organisation — not a 20-person office pasted onto one laptop.
            </p>
            <div class="note info" style=${{ marginTop: 14 }}>
              Nothing you type leaves this browser tab. Skip anytime to use the full calculator.
            </div>
          `}

          ${stepId === "scenario" && html`
            <h2 id="wizard-title">Which starting scenario?</h2>
            <p class="lede">
              Each preset sets headcount <em>and</em> the workload fields behind it — daily tokens, context, caching,
              peak behaviour, and agents. Pick the closest match; you can refine every field later.
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
                ${nf(headcount)} AI-using staff
                (${nf(st.org.devs)} developers · ${nf(st.org.admin)} admin · ${nf(st.org.marketing)} marketing)
                · ${nf(st.agents.count)} agents
                · ${nf(st.workload.devOut)} out tokens/dev/day
                ${st.workload.peakManual > 0 ? ` · peak factor ${st.workload.peakManual}` : ""}.
              </div>`}
            ${!selectedPreset && html`
              <div class="note warn" style=${{ marginTop: 14 }}>
                Select a preset to continue. Raw headcount alone is how people invent four Sparks for one developer.
              </div>`}
          `}

          ${stepId === "model" && html`
            <h2 id="wizard-title">Which model?</h2>
            <p class="lede">
              Pick from the catalogue. Total parameters set the footprint; active parameters set decode speed; KV per
              token sets how many sessions fit.
            </p>
            <div class="wizard-fields">
              <div class="field wizard-select">
                <label>
                  Model
                  <span class="sub">Architecture parameters load with the entry</span>
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
                  <dt>Architecture</dt><dd>${m.arch || "—"}</dd>
                  <dt>Quantisation</dt><dd>${m.quantLabel || "—"}</dd>
                  <dt>Total / active</dt><dd>${m.totalB}B / ${m.activeB}B</dd>
                  <dt>Confidence</dt><dd><${Badge} kind=${m.confidence}>${m.confidence || "?"}<//></dd>
                </div>
              </div>
            </div>
          `}

          ${stepId === "result" && html`
            <h2 id="wizard-title">Your first result</h2>
            <p class="lede">
              With your scenario and model, this is the cheapest owned option that fits — and which limit is binding.
              Open the full calculator to change workload, hardware, or comparables.
            </p>
            <div class="readouts" style=${{ marginTop: 14 }}>
              <${Readout} k="Cheapest owned" v=${eur(best?.cost.total)} tone="hi"
                n=${best ? `${best.hw.label} · ${best.cost.qty} unit${best.cost.qty === 1 ? "" : "s"}` : "nothing fits"} />
              <${Readout} k="Ownership premium" v=${eur(r.delta)} tone=${premiumOver ? "warn" : "good"}
                n=${r.premiumActual !== null ? pct(r.premiumActual) + " over the alternative" : ""} />
              <${Readout} k="Conservative binding" v=${best?.sizing.recommendationBinding || best?.sizing.binding || "—"} tone="warn"
                n=${`base ${best?.sizing.binding ?? "—"} · ${nf(best?.sizing.recommendedUnits)} units`} />
              <${Readout} k="Aggregate decode" v=${best?.sizing?.fits ? nf(best.sizing.aggregate) + " tok/s" : "—"} tone="hi"
                n=${best?.sizing?.fits
                  ? `per unit · ${best.cost.qty}× = ${nf(best.cost.qty * best.sizing.aggregate)} tok/s fleet`
                  : "no fitting owned option"} />
            </div>
            ${best?.sizing && html`
              <div class="wizard-ladder">
                <${Ladder} sizing=${best.sizing} />
              </div>`}
          `}
        </div>

        <div class="wizard-actions">
          <button class="btn" type="button" onClick=${onClose}>Skip</button>
          <div class="spacer"></div>
          ${step > 0 && html`<button class="btn" type="button" onClick=${goBack}>Back</button>`}
          ${stepId !== "result"
            ? html`<button
                class="btn primary"
                type="button"
                onClick=${goNext}
                disabled=${stepId === "scenario" && !selectedPresetId}>
                ${stepId === "welcome" ? "Start" : "Continue"}
              </button>`
            : html`
              <button class="btn" type="button" onClick=${onTune}>Tune inputs</button>
              <button class="btn primary" type="button" onClick=${onFinish}>See full results</button>
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
        Start with the shape of the organisation. The split matters more than the headcount:
        <strong>developers running agentic tools drive almost all the token volume</strong>, and the number of them
        also sets how spiky the load is — a handful of people produce violent peaks, a large population averages out.
      </p>
      <div class="grid two">
        <${Panel} title="People" hint=${`${head} total`}>
          <${Field} label="Developers" sub="Anyone using coding agents through the day" unit="people"
            value=${st.org.devs} onChange=${(v) => set("org.devs", v)} />
          <${Field} label="Marketing / sales" sub="Copy, briefs, image and video generation" unit="people"
            value=${st.org.marketing} onChange=${(v) => set("org.marketing", v)} />
          <${Field} label="Administrative" sub="Document parsing, email, research" unit="people"
            value=${st.org.admin} onChange=${(v) => set("org.admin", v)} />
          <${Field} label="Working days per year" unit="days" value=${st.org.workDays} onChange=${(v) => set("org.workDays", v)} />
          <${Field} label="Productive hours per day" sub="The window the peak has to fit into" unit="hours"
            value=${st.org.workHours} onChange=${(v) => set("org.workHours", v)} />
        <//>

        <${Panel} title="Autonomous agents" hint="a structurally different load">
          <p class="lede" style=${{ marginBottom: 10 }}>
            Not developers using an assistant — <strong>processes that run on their own</strong>: refactoring
            pipelines, ticket triage, monitoring, test generation, batch document analysis. They work nights and
            weekends, which flattens the load and raises hardware utilisation. Their cache hit rate is much higher
            because they replay the same prompts every cycle.
          </p>
          <${Field} label="Concurrent agents" sub="Set this above zero to model the shift to autonomous work"
            unit="agents" value=${st.agents.count} onChange=${(v) => set("agents.count", v)} />
          <${Field} label="Active hours per day" unit="hours" value=${st.agents.hoursDay} onChange=${(v) => set("agents.hoursDay", v)} />
          <${Field} label="Active days per year" unit="days" value=${st.agents.daysYear} onChange=${(v) => set("agents.daysYear", v)} />
          <${Field} label="Input tokens per agent-hour" unit="tokens" value=${st.agents.inPerHour}
            step=${50000} onChange=${(v) => set("agents.inPerHour", v)} />
          <${Field} label="Output tokens per agent-hour" unit="tokens" value=${st.agents.outPerHour}
            step=${5000} onChange=${(v) => set("agents.outPerHour", v)} />
          <${PctField} label="Cache hit rate" sub="Higher than interactive: same system prompt every cycle"
            unit="share" value=${st.agents.caching} onChange=${(v) => set("agents.caching", v)} />
          <${Check} label="Share a resident prefix across agents"
            sub="Enable only when the runtime deduplicates prefix KV"
            checked=${st.agents.prefixSharing}
            onChange=${(v) => set("agents.prefixSharing", v)} />
          <${Field} label="Shared agent prefix" unit="tokens"
            value=${st.agents.sharedPrefixTokens} derived=${!st.agents.prefixSharing}
            onChange=${(v) => set("agents.sharedPrefixTokens", v)} />
          <${Field} label="Average resident context" sub="Longer than interactive: agents carry state and tool output"
            unit="tokens" value=${st.agents.context} step=${10000} onChange=${(v) => set("agents.context", v)} />
          <${Field} label="Peak factor" sub="Close to 1: a continuous load has no peaks" unit="×"
            value=${st.agents.peakFactor} step=${0.05} onChange=${(v) => set("agents.peakFactor", v)} />
        <//>
      </div>

      <${Panel} title="Cost of an hour of technical time"
        hint="only multiplies into TCO once a management quota is above zero">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Blended hourly rate for the FTE quotas below. With all quotas at zero (the default), this rate does not
          add management euros — raise a quota when you want to model real ops staff.
        </p>
        <div class="grid two">
          <div>
            <${Field} label="Gross annual salary" sub="MLOps or SRE profile, before employer contributions" unit="€/yr"
              value=${st.staff.ral} step=${1000} onChange=${(v) => set("staff.ral", v)} />
            <${Field} label="Employer coefficient" sub="Contributions, severance accrual, workstation. Typical 1.35–1.50" unit="×"
              value=${st.staff.employerCoef} step=${0.01} onChange=${(v) => set("staff.employerCoef", v)} />
            <${Field} label="Working hours per year" unit="hours" value=${st.staff.hoursYear} step=${10}
              onChange=${(v) => set("staff.hoursYear", v)} />
          </div>
          <div>
            <${Field} label="Freelance rate" sub="On-call consultant for one-off work" unit="€/h"
              value=${st.staff.freelanceRate} step=${5} onChange=${(v) => set("staff.freelanceRate", v)} />
            <${PctField} label="Share of hours on freelance" sub="0 = all in-house, 1 = fully outsourced"
              unit="share" value=${st.staff.freelanceShare} onChange=${(v) => set("staff.freelanceShare", v)} />
          </div>
        </div>
      <//>

      <${Panel} title="Human management cost"
        hint="defaults to zero — opt in when you want ops staff in the TCO">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Management euros = FTE quotas × blended technical hourly × years (+ one-time setup hours on owned gear).
          Quotas start at <strong>0</strong> so every configuration’s Management column is hardware/energy/service
          only until you model people. Platform work applies everywhere; infrastructure quotas apply only when you
          run metal (own or rent), never on pure subscription seats.
        </p>
        <div class="grid two">
          <div>
            <${PctField} label="Platform quota"
              sub="FTE share for gateway, keys, FinOps, model lifecycle — own, rent, and subscriptions"
              unit="of one person"
              value=${st.mgmt.platformQuota} onChange=${(v) => set("mgmt.platformQuota", v)} />
            <${PctField} label="Infrastructure — appliance"
              sub="Extra FTE for vendor appliances only (own/rent). Ignored for subscriptions. Cut by automation"
              unit="added" value=${st.mgmt.applianceQuota} onChange=${(v) => set("mgmt.applianceQuota", v)} />
            <${PctField} label="Infrastructure — assembled or rented node"
              sub="Extra FTE for tuned nodes (engine, quant, on-call). Own/rent only; cut by automation"
              unit="added" value=${st.mgmt.nodeQuota} onChange=${(v) => set("mgmt.nodeQuota", v)} />
          </div>
          <div>
            <${PctField} label="Added per unit beyond the first"
              sub="Incremental FTE × max(0, qty − 1) on own/rent fleets. Zero keeps multi-unit Management at €0"
              unit="each" value=${st.mgmt.perUnitQuota} onChange=${(v) => set("mgmt.perUnitQuota", v)} />
            <${PctField} label="Supervision automation"
              sub="Fraction that cuts infrastructure quotas only — not platform. No effect while infra quotas are 0"
              unit="reduction" value=${st.mgmt.automation} onChange=${(v) => set("mgmt.automation", v)} />
            <${Field} label="Annual replacement reserve"
              sub="Expected failures and component replacement; support contracts are costed separately" unit="€/yr"
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
        <${Readout} k="Input tokens / year" v=${nf(w.totalIn / 1e9, 1) + " B"} />
        <${Readout} k="Output tokens / year" v=${nf(w.totalOut / 1e9, 1) + " B"} />
        <${Readout} k="Input : output" v=${w.ioRatio.toFixed(1) + ":1"}
          n="Input is far cheaper to serve than output, but priced at only a fraction less" />
        <${Readout} k="Peak decode" v=${nf(w.decodePeak) + " tok/s"} tone="hi" n="This is what sizes the hardware" />
        <${Readout} k="Peak prefill" v=${nf(w.prefillPeak) + " tok/s"} n="Shares serving capacity with decode" />
        <${Readout} k="Concurrent sessions" v=${nf(w.sessionsTotal, 1)} />
        <${Readout} k="Resident KV needed" v=${nf(w.kvRequired / 1e6, 2) + " M"} n="tokens held in memory at once" />
      </div>

      <div class="grid two">
        <${Panel} title="Interactive use" hint="people, during working hours">
          <${Field} label="Input tokens per developer per day" sub="Agentic loops re-read context constantly. The most sensitive number in the model."
            unit="tokens" value=${st.workload.devIn} step=${500000} onChange=${(v) => set("workload.devIn", v)} />
          <${Field} label="Output tokens per developer per day" unit="tokens" value=${st.workload.devOut}
            step=${50000} onChange=${(v) => set("workload.devOut", v)} />
          <${Field} label="Input per administrative user" unit="tokens" value=${st.workload.adminIn}
            step=${10000} onChange=${(v) => set("workload.adminIn", v)} />
          <${Field} label="Output per administrative user" unit="tokens" value=${st.workload.adminOut}
            step=${10000} onChange=${(v) => set("workload.adminOut", v)} />
          <${Field} label="Input per marketing / sales user" unit="tokens" value=${st.workload.mktIn}
            step=${10000} onChange=${(v) => set("workload.mktIn", v)} />
          <${Field} label="Output per marketing / sales user" unit="tokens" value=${st.workload.mktOut}
            step=${10000} onChange=${(v) => set("workload.mktOut", v)} />
          <${PctField} label="Prefill cache hit rate"
            sub="Reduces repeated prefill compute; KV changes only when shared-prefix storage is enabled" unit="share"
            value=${st.workload.caching} onChange=${(v) => set("workload.caching", v)} />
          <${PctField} label="Developer concurrency" sub="Share of developers with a resident session at peak"
            unit="share" value=${st.workload.devConcurrency}
            onChange=${(v) => set("workload.devConcurrency", v)} />
          <${PctField} label="Administrative concurrency" unit="share"
            value=${st.workload.adminConcurrency}
            onChange=${(v) => set("workload.adminConcurrency", v)} />
          <${PctField} label="Marketing concurrency" unit="share"
            value=${st.workload.marketingConcurrency}
            onChange=${(v) => set("workload.marketingConcurrency", v)} />
          <${Check} label="Share a resident prefix across interactive sessions"
            sub="Enable only when the selected runtime actually deduplicates prefix KV"
            checked=${st.workload.prefixSharing}
            onChange=${(v) => set("workload.prefixSharing", v)} />
          <${Field} label="Shared interactive prefix" unit="tokens"
            value=${st.workload.sharedPrefixTokens} derived=${!st.workload.prefixSharing}
            onChange=${(v) => set("workload.sharedPrefixTokens", v)} />
          <${Field} label="Average resident context" sub="Drives how much KV each session holds" unit="tokens"
            value=${st.workload.context} step=${10000} onChange=${(v) => set("workload.context", v)} />
        <//>

        <div class="stack">
          <${Panel} title="Burstiness" hint="decides how many machines you buy">
            <p class="lede" style=${{ marginBottom: 10 }}>
              With ten developers, three of them starting agents together is a peak. With five hundred, statistics
              flatten it. <strong>This is the assumption none of the benchmarks measure and the one that moves the
              machine count most</strong> — a month of hourly logging settles it.
            </p>
            <${Field} label="Burstiness coefficient" sub="Peak = 1 + k / √developers" unit="k"
              value=${st.workload.burstiness} step=${0.1} onChange=${(v) => set("workload.burstiness", v)} />
            <${Field} label="Peak factor, computed" unit="×" derived value=${w.peakAuto.toFixed(2)} />
            <${Field} label="Peak factor, measured" sub="Put your logged value here. Zero means use the computed one."
              unit="×" value=${st.workload.peakManual} step=${0.1} onChange=${(v) => set("workload.peakManual", v)} />
            <div class="note ${st.workload.peakManual > 0 ? "info" : "warn"}" style=${{ marginTop: 10 }}>
              ${st.workload.peakManual > 0
                ? html`<span>Using your measured value of <b>${st.workload.peakManual.toFixed(2)}×</b>.</span>`
                : html`<span>Using the estimate of <b>${w.peakAuto.toFixed(2)}×</b>. Until you measure it, the machine count is a guess with a formula in front of it.</span>`}
            </div>
          <//>

          <${Panel} title="Images and video">
            <div class="note warn" style=${{ marginBottom: 10 }}>
              Informational only. Media is excluded until both local and alternative profiles are supplied.
            </div>
            <${Field} label="Images per year" unit="images" value=${st.workload.images} derived />
            <${Field} label="Seconds of 720p video per year" unit="seconds" value=${st.workload.videoSeconds} derived />
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
        Swapping models is not swapping one number. <strong>Total parameters decide how many GPUs hold the weights;
        active parameters decide how fast it decodes; KV per token decides how many sessions fit.</strong> A 284B
        mixture-of-experts with 13B active occupies like a 284B and generates like a 13B. Get all six right and the
        rest of the tool follows.
      </p>

      <${Panel} title="Model" hint="pick from the catalogue or edit any field"
        actions=${html`<select value=${m.id || ""} onChange=${(e) => {
          const found = catalog.models.find((x) => x.id === e.target.value);
          if (found) set("model", { ...found });
        }}>
          <option value="">— load from catalogue —</option>
          ${catalog.models.map((x) => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}
        </select>`}>
        <div class="grid two">
          <div>
            <${Field} type="text" label="Name" value=${m.name} onChange=${(v) => set("model.name", v)} />
            <${Field} type="text" label="Quantisation" sub="Label only. The number that counts is bytes per parameter."
              value=${m.quantLabel} onChange=${(v) => set("model.quantLabel", v)} />
            <${Field} label="Total parameters" sub="Sets the memory footprint, says nothing about speed" unit="billions"
              value=${m.totalB} onChange=${(v) => set("model.totalB", v)} />
            <${Field} label="Active parameters per token" sub="On a MoE this drives decode. On a dense model it equals the total."
              unit="billions" value=${m.activeB} onChange=${(v) => set("model.activeB", v)} />
            <${Field} label="Bytes per parameter" sub="NVFP4 ≈ 0.50 · FP8 ≈ 1.00 · BF16 ≈ 2.00. Mixed checkpoints land in between."
              unit="bytes" value=${m.bytesPerParam} step=${0.01} onChange=${(v) => set("model.bytesPerParam", v)} />
          </div>
          <div>
            <${Field} label="KV cache per token" sub="Depends on the attention architecture, not on size. Compressed latent attention is 2–3× lighter than classic GQA."
              unit="KB" value=${m.kvKbPerToken} step=${0.01} onChange=${(v) => set("model.kvKbPerToken", v)} />
            <${Field} label="Accepted tokens per step" sub="Speculative decoding: weights are read once per step, not per token. Put 1.00 if you do not use a drafter."
              unit="tokens" value=${m.specTokens} step=${0.01} onChange=${(v) => set("model.specTokens", v)} />
            <${Field} label="Prefill / decode ratio" sub="Why providers price input at a fraction of output while it costs them far less than that fraction"
              unit="×" value=${m.prefillRatio} step=${0.1} onChange=${(v) => set("model.prefillRatio", v)} />
            <${Field} label="Maximum model context" sub="Contexts above this value invalidate the scenario"
              unit="tokens" value=${m.maxContext} onChange=${(v) => set("model.maxContext", v)} />
            <${Field} label="Fallback concurrent sessions" sub="Exact model/hardware/runtime profiles override this conservative fallback"
              unit="sessions" value=${m.maxSeqs} onChange=${(v) => set("model.maxSeqs", v)} />
            <${Field} label="Runtime overhead per GPU" sub="CUDA graphs, activation buffers, kernel workspace, drafter weights"
              unit="GB" value=${m.overheadPerGpu} onChange=${(v) => set("model.overheadPerGpu", v)} />
          </div>
        </div>
        <div class="readouts" style=${{ marginTop: 14 }}>
          <${Readout} k="Weights, FP4-capable silicon" v=${nf(weights) + " GB"} />
          <${Readout} k="Selected checkpoint precision" v=${m.defaultPrecision || m.quantLabel} tone="warn"
            n="Unsupported hardware combinations are excluded; precision is never silently doubled" />
          <${Readout} k="Read per generated token" v=${perToken.toFixed(2) + " GB"} tone="hi"
            n="This, divided into bandwidth, is your decode ceiling" />
        </div>
        ${m.kvKbRange?.status === "unresolved" && html`
          <div class="note warn" style=${{ marginTop: 12 }}>
            KV evidence is unresolved: ${m.kvKbRange.low}–${m.kvKbRange.high} KB/token.
            Results show sensitivity across this range.
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
            <${Badge} kind=${o.sizing.profileConfidence}>profile: ${o.sizing.profileConfidence}<//>`}
          ${o.hw.sovereign === false && html`<${Badge} kind="nonsov">non-EU<//>`}
          ${o.eligibility?.referenceOnly && html`<${Badge} kind="nonsov">reference<//>`}
          ${o.eligibility && !o.eligibility.eligible && html`<${Badge} kind="bad">ineligible<//>`}
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
      <td>${o.kind !== "subscription" ? html`<${Ladder} sizing=${o.sizing} />` : html`<span class="muted small">per seat and per token</span>`}</td>
      <td class="num">${o.sizing.fits && o.kind !== "subscription" ? nf(o.sizing.aggregate) : "—"}</td>
      <td class="num">${eur(o.cost.capex)}</td>
      <td class="num">${eur(o.cost.energy4)}</td>
      <td class="num">${eur(o.cost.mgmt4)}</td>
      <td class="num">${eur(o.cost.service4)}</td>
      <td class="num strong">${o.sizing.fits ? eur(o.cost.total) : "—"}</td>
      <td class="num">${o.sizing.fits ? (o.perMToken || 0).toFixed(3) : "—"}</td>
      <td>
        ${o.sizing.fits && o.eligibility?.eligible && !o.cost.underProvisioned
          ? html`<button class="btn sm" type="button" onClick=${() => onQuote(o)}>Quote</button>`
          : html`<span class="muted small">not eligible</span>`}
      </td>
    </tr>`;

  return html`
    <div class="stack">
      <p class="lede">
        Hardware options run the selected model under the same workload. Subscription alternatives preserve the
        workload shape but may differ in quality, latency, context and tooling. The ladder shows the three limits
        that decide machine count — KV memory, combined prefill/decode serving, and runtime sessions — with the
        binding one in amber. Sizing on anything other than the binding constraint is how people end up buying
        capacity they never use.
      </p>

      <${Panel} title="Own it" hint=${`capital expenditure, ${st.econ.years}-year horizon`} tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th>Configuration</th><th style=${{ width: 210 }}>Constraint ladder</th>
              <th class="num">Aggregate tok/s</th><th class="num">CapEx</th><th class="num">Energy</th>
              <th class="num">Management</th><th class="num">Service</th><th class="num">Total</th><th class="num">€/1M</th><th></th>
            </tr></thead>
            <tbody>${own.map((o) => Row(o, onQuote))}</tbody>
          </table>
        </div>
      <//>

      <${Panel} title="Rent it or subscribe" hint="eligible comparables and reference options" tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th>Option</th><th style=${{ width: 210 }}>Constraint ladder</th>
              <th class="num">Aggregate tok/s</th><th class="num">CapEx</th><th class="num">Energy</th>
              <th class="num">Management</th><th class="num">Service</th><th class="num">Total</th><th class="num">€/1M</th><th></th>
            </tr></thead>
            <tbody>${alt.map((o) => Row(o, onQuote))}</tbody>
          </table>
        </div>
        <details class="expand">
          <summary>Why per-token API providers are not in this list</summary>
          <div class="inner">
            If the reason you are reading this is data governance, providers that route your traffic through
            jurisdictions you cannot audit are not a comparable at any price. What remains is renting metal from a
            sovereign provider, or subscribing to a vendor you already trust with your CRM and your mail. Both are
            here. Add your own in <span class="mono">data/hardware.json</span> if your compliance envelope differs.
          </div>
        </details>
      <//>

      <div class="grid two">
        <${Panel} title="Catalogue" hint="untick to leave an option out of the comparison">
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
                <label>Runtime profile<span class="sub">Pinned model, hardware and runtime evidence</span></label>
                <select value=${st.profileOverrides[h.id] || ""}
                  onChange=${(e) => set(`profileOverrides.${h.id}`, e.target.value || null)}>
                  <option value="">automatic exact match</option>
                  ${matches.map((p) => html`<option key=${p.id} value=${p.id}>${p.id} · ${p.runtime}</option>`)}
                </select>
              </div>`}
              <${Field} label="Manual quantity"
                sub=${`0 = conservative recommendation ${nf(option?.sizing.recommendedUnits)}; base minimum ${nf(option?.sizing.minimumUnits)}`}
                unit="units" value=${st.manualQty[h.id] || 0}
                onChange=${(v) => set(`manualQty.${h.id}`, v)} />
            </div>`;
          })}
        <//>

        <${Panel} title="Rental terms">
          <${PctField} label="Reserved-term discount" sub="Multi-year commitments cut 30–60% off on-demand — and remove the elasticity that justified the premium"
            unit="off" value=${st.rental.reserveDiscount} onChange=${(v) => set("rental.reserveDiscount", v)} />
          <${PctField} label="Upfront share" sub="Cash-flow timing only; it does not change undiscounted TCO"
            unit="paid at signature" value=${st.rental.upfrontShare} onChange=${(v) => set("rental.upfrontShare", v)} />
          <div class="note warn" style=${{ marginTop: 12 }}>
            Weights must stay resident, so a rented node is billed 24/7 whether or not anyone is using it. The
            elasticity you are paying a premium for does not exist for this workload.
          </div>
        <//>
      </div>
    </div>`;
}

function ComparablesView({ st, set, catalog }) {
  return html`
    <div class="stack">
      <p class="lede">
        Priced by population, because the populations behave differently. Developers need a premium seat.
        Occasional users need a cheap one. <strong>Autonomous agents do not fit a per-seat plan at all</strong> —
        they burn tokens, and their bill is dominated by cache economics.
      </p>
      <div class="grid two">
        <${Panel} title="Seats">
          <${Field} label="Developer plan" sub="Cursor / code plan for intensive agentic coding" unit="$/seat/mo"
            value=${st.subs.devPlan} step=${5} onChange=${(v) => set("subs.devPlan", v)} />
          <${Field} label="Occasional user plan" sub="Productivity suite with assistant included" unit="$/seat/mo"
            value=${st.subs.casualPlan} step=${1} onChange=${(v) => set("subs.casualPlan", v)} />
          <${PctField} label="Overage on developer seats" sub="Even premium plans have quotas. Measure how often your people hit them before trusting list price."
            unit="added" value=${st.subs.overage} onChange=${(v) => set("subs.overage", v)} />
          <${Field} label="Included developer tokens per year"
            sub="Usage beyond this allowance is priced at the API rates below"
            unit="tokens/seat" value=${st.subs.devIncludedTokensYear} step=${100000000}
            onChange=${(v) => set("subs.devIncludedTokensYear", v)} />
          <${Field} label="Included occasional-user tokens per year"
            unit="tokens/seat" value=${st.subs.casualIncludedTokensYear} step=${10000000}
            onChange=${(v) => set("subs.casualIncludedTokensYear", v)} />
          <div class="sectionlabel" style=${{ marginTop: 16 }}>Reference prices</div>
          <dl class="kv">
            ${catalog.defaults.subscriptionRefs.flatMap((x, i) => [
              html`<dt key=${"t" + i}>${x.label}${x.note ? " — " + x.note : ""}</dt>`,
              html`<dd key=${"d" + i}>${x.price} <span class="muted">${x.unit}</span></dd>`,
            ])}
          </dl>
        <//>

        <div class="stack">
          <${Panel} title="Per-token API for agents">
            <${Field} label="Input, uncached" unit="$/1M" value=${st.subs.apiIn} step=${0.05} onChange=${(v) => set("subs.apiIn", v)} />
            <${Field} label="Input, cached" sub="A 90% discount on the repeated prefix — this is what makes autonomous agents affordable"
              unit="$/1M" value=${st.subs.apiCached} step=${0.01} onChange=${(v) => set("subs.apiCached", v)} />
            <${Field} label="Cache storage" sub="Providers bill for keeping the cache warm, not only for reading it. A large cache held longer than needed becomes its own cost centre."
              unit="$/1M/hour" value=${st.subs.apiStorage} step=${0.1} onChange=${(v) => set("subs.apiStorage", v)} />
            <${Field} label="Output" sub="Reasoning tokens bill at this rate: real output can far exceed the visible answer"
              unit="$/1M" value=${st.subs.apiOut} step=${0.25} onChange=${(v) => set("subs.apiOut", v)} />
          <//>
          <${Panel} title="Images and video">
            <div class="note warn" style=${{ marginBottom: 10 }}>
              Excluded from headline totals: this calculator has no matched local media-generation profile.
            </div>
            <${Field} label="Image generation" unit="$/image" value=${st.subs.imagePrice} step=${0.005}
              derived />
            <${Field} label="Video, 720p" unit="$/second" value=${st.subs.videoPrice} step=${0.01}
              derived />
          <//>
          <${Panel} title="Energy and horizon">
            <${Field} label="Electricity" sub="Industrial tariff at your site" unit="€/kWh" value=${st.econ.kwhPrice}
              step=${0.01} onChange=${(v) => set("econ.kwhPrice", v)} />
            <${PctField} label="Manual hardware utilisation"
              sub=${st.costs.energyMode === "derived" ? "Informational: energy currently uses demand-derived utilisation" : "Sets average draw between idle and peak"}
              unit="share" value=${st.econ.utilization}
              derived=${st.costs.energyMode === "derived"}
              onChange=${(v) => set("econ.utilization", v)} />
            <${Field} label="Horizon" unit="years" value=${st.econ.years} onChange=${(v) => set("econ.years", v)} />
            <${Field} label="USD → EUR" unit="rate" value=${st.econ.fx} step=${0.01} onChange=${(v) => set("econ.fx", v)} />
            <${PctField} label="Maximum premium your organisation accepts"
              sub="A scenario-specific decision threshold, not a market fact"
              unit="share" value=${st.econ.onPremPremium} onChange=${(v) => set("econ.onPremPremium", v)} />
          <//>
          <${Panel} title="Production and eligibility">
            <${PctField} label="Maximum target utilisation" sub="Leaves latency and traffic headroom"
              unit="share" value=${st.resilience.targetUtilization}
              onChange=${(v) => set("resilience.targetUtilization", v)} />
            <${Check} label="Add N+1 resilience" sub="One extra serving unit for maintenance or failure"
              checked=${st.resilience.nPlusOne} onChange=${(v) => set("resilience.nPlusOne", v)} />
            <${Field} label="Additional maintenance reserve" sub="Fixed units beyond conservative capacity"
              unit="units" value=${st.resilience.maintenanceReserve}
              onChange=${(v) => set("resilience.maintenanceReserve", v)} />
            <${Field} label="Expected model-serving hardware life" sub="Shorter than the horizon triggers replacement CapEx"
              unit="years" value=${st.costs.modelLifeYears}
              onChange=${(v) => set("costs.modelLifeYears", v)} />
            <${Check} label="Prefer sovereign alternatives"
              sub="Non-EU rentals stay in the cost comparison and are labelled as reference only"
              checked=${st.requirements.sovereignOnly}
              onChange=${(v) => set("requirements.sovereignOnly", v)} />
            <div class="field">
              <label>Preferred rental regions<span class="sub">Reference label only — does not exclude rentals. Comma-separated, for example EU, France</span></label>
              <input type="text" value=${(st.requirements.regions || []).join(", ")}
                onChange=${(e) => set("requirements.regions",
                  e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
            </div>
            <${Check} label="Require equivalent capability"
              sub="Excludes services without a separately validated quality/capability match"
              checked=${st.requirements.requireEquivalentCapability}
              onChange=${(v) => set("requirements.requireEquivalentCapability", v)} />
            <div class="field">
              <label>Minimum evidence confidence<span class="sub">Options below this level remain reference-only</span></label>
              <select value=${st.requirements.minimumConfidence}
                onChange=${(e) => set("requirements.minimumConfidence", e.target.value)}>
                ${["estimated", "community", "published", "measured"].map((x) =>
                  html`<option key=${x} value=${x}>${x}</option>`)}
              </select>
            </div>
          <//>
        </div>
      </div>

      <${Panel} title="Sell spare capacity to your own supply chain" hint="optional">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Not renting out GPUs — <strong>exposing an endpoint</strong>. Your weights and your data never leave;
          your customers' traffic comes in. Eligibility still depends on their contracts and your controls.
          Revenue is capped by measured serving headroom and can be unprofitable after energy and operations.
        </p>
        <div class="grid two">
          <div>
            <${Check} label="Model this revenue" sub="Off by default: it is a business decision, not an assumption"
              checked=${st.resale.enabled} onChange=${(v) => set("resale.enabled", v)} />
            <${PctField} label="Share of hours with spare capacity" sub="Falls as you add your own night agents — the two ways of filling the metal are alternatives"
              unit="share" value=${st.resale.freeHoursShare} onChange=${(v) => set("resale.freeHoursShare", v)} />
            <${PctField} label="Sell-through" sub="Demand from your supply chain is more predictable than a marketplace, but not continuous"
              unit="share" value=${st.resale.sellThrough} onChange=${(v) => set("resale.sellThrough", v)} />
          </div>
          <div>
            <${Field} label="Selling price, input" unit="€/1M" value=${st.resale.priceIn} step=${0.01}
              onChange=${(v) => set("resale.priceIn", v)} />
            <${Field} label="Selling price, output" unit="€/1M" value=${st.resale.priceOut} step=${0.01}
              onChange=${(v) => set("resale.priceOut", v)} />
            <${Field} label="Input : output of sold traffic" sub="Prefill and decode compete for the same silicon, so the mix sets real capacity"
              unit=":1" value=${st.resale.mix} step=${0.1} onChange=${(v) => set("resale.mix", v)} />
            <${PctField} label="Commercial and operational cost" sub="Metered billing, contracts, SLA, onboarding, first-line support. Selling to third parties is a business, not a saving."
              unit="of one person" value=${st.resale.opsQuota} onChange=${(v) => set("resale.opsQuota", v)} />
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
        <b>Invalid scenario.</b> ${r.validation.errors.join(" ")}
      </div>`}
      ${r.validation.warnings.length > 0 && html`<div class="note warn">
        <b>Decision warnings.</b> ${r.validation.warnings.join(" ")}
      </div>`}
      ${best?.sizing.warnings?.length > 0 && html`<div class="note warn">
        <b>Selected configuration evidence.</b> ${best.sizing.warnings.join(" ")}
      </div>`}
      ${st.resale.enabled && best && !best.cost.resaleFeasible && html`
        <div class="note warn"><b>Resale is capacity-infeasible.</b>
          No revenue is credited after internal demand and the configured utilisation reserve.
        </div>`}
      <div class="readouts">
        <${Readout} k="Cheapest owned" v=${eur(r.bestOwn?.cost.total)} tone="hi"
          n=${r.bestOwn ? `${r.bestOwn.hw.label} · ${r.bestOwn.cost.qty} unit${r.bestOwn.cost.qty === 1 ? "" : "s"}` : "nothing fits"} />
        <${Readout} k="Cheapest eligible alternative" v=${eur(r.bestAlt?.cost.total)} n=${r.bestAlt?.hw.label} />
        <${Readout} k="Ownership premium" v=${eur(r.delta)} tone=${premiumOver ? "warn" : "good"}
          n=${r.premiumActual !== null ? pct(r.premiumActual) + " over the alternative" : ""} />
        <${Readout} k="Per head per year" v=${eur(r.perHeadOwn)} n=${`vs ${eur(r.perHeadAlt)} on the alternative`} />
        <${Readout} k="Management load" v=${(best?.cost.mgmtHoursDay || 0).toFixed(2) + " h/day"}
          n="Sanity-check this against your team" />
        <${Readout} k="Energy utilisation" v=${pct(best?.cost.utilizationUsed || 0)}
          n=${best?.cost.energyBasis === "derived" ? "derived from annual serving demand" : "manual override"} />
        <${Readout} k="Conservative binding" v=${best?.sizing.recommendationBinding || best?.sizing.binding || "—"} tone="warn"
          n=${`base ${best?.sizing.binding ?? "—"} · min ${nf(best?.sizing.minimumUnits)} · rec ${nf(best?.sizing.recommendedUnits)}`} />
      </div>

      <${Panel} title="Request a quote" hint="buy or deploy a configuration">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Want help purchasing, renting, or standing up one of these options? Opens a Google Form and copies a
          scenario summary to your clipboard so you can paste it in. The calculator itself still does not send your data.
        </p>
        <div class="row" style=${{ gap: 8, flexWrap: "wrap" }}>
          <button class="btn primary" type="button" onClick=${() => onQuote(best || null)}
            disabled=${!best?.sizing?.fits || !best?.eligibility?.eligible || best?.cost?.underProvisioned}>
            Quote cheapest owned${best?.sizing?.fits ? ` — ${best.hw.label}` : ""}
          </button>
          ${r.bestAlt?.sizing?.fits && r.bestAlt?.eligibility?.eligible && !r.bestAlt?.cost?.underProvisioned && html`
            <button class="btn" type="button" onClick=${() => onQuote(r.bestAlt)}>
              Quote alternative — ${r.bestAlt.hw.label}
            </button>`}
        </div>
      <//>

      <${Panel} title="Sensitivity range" hint="conservative · base · optimistic">
        <div class="readouts">
          <${Readout} k="Conservative owned" v=${eur(sensitivity.summaries.conservative.ownTotal)}
            n=${`${nf(sensitivity.summaries.conservative.ownUnits)} units`} />
          <${Readout} k="Base owned" v=${eur(sensitivity.summaries.base.ownTotal)}
            n=${`${nf(sensitivity.summaries.base.ownUnits)} units`} />
          <${Readout} k="Optimistic owned" v=${eur(sensitivity.summaries.optimistic.ownTotal)}
            n=${`${nf(sensitivity.summaries.optimistic.ownUnits)} units`} />
        </div>
        ${(sensitivity.winnerChanges || sensitivity.bindingChanges) && html`
          <div class="note warn" style=${{ marginTop: 10 }}>
            The recommended winner or binding constraint changes inside the evidence range. Validate on the exact runtime before purchase.
          </div>`}
      <//>

      ${r.premiumActual !== null &&
      html`<div class=${"note " + (premiumOver ? "warn" : "info")}>
        ${premiumOver
          ? html`<span>The premium for owning is <b>${pct(r.premiumActual)}</b>, above the <b>${pct(r.premiumAccepted)}</b>
              configured as the accepted premium. Above this threshold, the decision needs an explicit non-economic driver.</span>`
          : html`<span>The premium for owning is <b>${pct(r.premiumActual)}</b>, inside the <b>${pct(r.premiumAccepted)}</b>
              configured as acceptable. This scenario is within that user-supplied threshold.</span>`}
      </div>`}

      ${best &&
      html`<${Panel} title="Is this tool still the right instrument" hint="domain check">
        <div class="grid three">
          <div class="kv">
            <dt>Units</dt><dd>${nf(best.domain.qty)}</dd>
            <dt>Peak power</dt><dd>${nf(best.domain.kwPeak, 1)} kW</dd>
            <dt>Per rack</dt><dd>${nf(best.domain.rackDensity, 1)} kW</dd>
            <dt>People who must know the stack</dt><dd>${best.domain.busFactor}</dd>
          </div>
          <div class="domain-note">
            ${best.domain.verdict === "out-of-domain"
              ? html`<div class="note bad"><b>Out of domain.</b> Above eight nodes or 150 kW the cost is dominated by
                  the facility — building, grid connection, redundancy, cooling, 24/7 shift cover. This model gives you
                  the IT load in kW, which is the <em>input</em> to a facility model, not the model itself.</div>`
              : best.domain.verdict === "at-limit"
              ? html`<div class="note warn"><b>At the limit.</b> The sizing still holds. Rework the cost side by hand on
                  facility and continuity assumptions. The thresholds are advisory and are not included in TCO.</div>`
              : html`<div class="note info"><b>In domain.</b> Server-room scale, one resident text model.
                  Facility and bus-factor guidance is advisory and not included in TCO.</div>`}
          </div>
        </div>
      <//>`}

      <${Panel} title="Cost per million tokens" hint="input/output columns allocate local TCO by accelerator service time" tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Option</th><th class="num">${st.econ.years}-year total</th><th class="num">Blended €/1M</th>
              <th class="num">Input €/1M</th><th class="num">Output €/1M</th>
              <th class="num">Peak occupancy</th><th class="num">Mean occupancy</th><th>Confidence</th></tr></thead>
            <tbody>
              ${[...r.options].sort((a, b) => (a.perMToken || 9e9) - (b.perMToken || 9e9)).map(
                (o) => html`<tr key=${o.hw.id} class=${!o.sizing.fits ? "is-dead" : ""}>
                  <td>${o.hw.label}</td>
                  <td class="num">${o.sizing.fits ? eur(o.cost.total) : "does not fit"}</td>
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
          <summary>Why mean occupancy is usually the uncomfortable number</summary>
          <div class="inner">
            You buy for the peak and use it during office hours. A provider aggregates demand across time zones and
            runs near saturation around the clock. Same silicon, an order of magnitude apart on cost per token —
            which is how a provider can take a healthy margin and still undercut you. Raising your own mean occupancy
            is the only lever that closes it, and autonomous agents are the realistic way to do it.
          </div>
        </details>
      <//>

      ${best?.util &&
      html`<${Panel} title="Headroom" hint="what you bought and are not using">
        <div class="readouts">
          <${Readout} k="Spare decode at peak" v=${nf(best.util.freeCapacity) + " tok/s"} />
          <${Readout} k="KV occupancy" v=${pct(best.util.occupancyKv)} />
          <${Readout} k="Developers you could add" v=${nf(best.util.extraDevs, 1)} tone="good"
            n="Before buying more metal" />
        </div>
      <//>`}
    </div>`;
}

function PackagesView({ st, r, catalog }) {
  const [sizes] = useState([
    { name: "XS — Foothold", employees: 80, aiUsers: 20, tokensOutPerDay: 120000, profile: "Professional practice, engineering boutique, R&D lab" },
    { name: "S — Department", employees: 150, aiUsers: 40, tokensOutPerDay: 180000, profile: "Technical office of an SME, pharma R&D division, aerospace subcontractor" },
    { name: "M — Company", employees: 300, aiUsers: 80, tokensOutPerDay: 250000, profile: "Precision mechanics, automation, packaging. Structured technical office with in-house IT" },
    { name: "L — Multi-site", employees: 600, aiUsers: 150, tokensOutPerDay: 250000, profile: "Industrial group, several plants, engineering and quality" },
    { name: "XL — District", employees: 1000, aiUsers: 250, tokensOutPerDay: 300000, profile: "Supply-chain lead that also serves its own suppliers" },
  ]);
  const rows = useMemo(
    () => packages(st, sizes, catalog.profiles?.profiles || []),
    [st, sizes, catalog]
  );

  return html`
    <div class="stack">
      <p class="lede">
        The same engine run across five team shapes. <strong>The column that matters in a meeting is the break-even
        seat price</strong> — the monthly per-seat figure at which the customer's current subscription costs exactly
        what your package costs. Below it you are asking for a premium and need a governance argument. Above it you
        are simply cheaper, and the conversation changes character.
      </p>

      <${Panel} title="Range" tight>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th>Package</th><th class="num">Staff</th><th class="num">AI users</th><th>Configuration</th>
              <th class="num">Units</th><th class="num">${st.econ.years}-year total</th><th class="num">€/user/mo</th>
              <th class="num">Break-even seat</th><th>Verdict</th>
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
                        ${p.verdict === "competitive" ? "competitive" : p.verdict === "hard-sell" ? "hard sell" : "needs a driver"}<//>`
                    : "—"}</td>
                </tr>`
              )}
            </tbody>
          </table>
        </div>
      <//>

      <div class="grid two">
        <${Panel} title="What to put on the table">
          <div class="stack" style=${{ gap: 12 }}>
            <div class="note info">
              <b>Lead with cost per user per month, not the project total.</b> It compares naturally with a
              professional software licence. The total triggers a defensive reflex before you finish the sentence.
            </div>
            <div class="note">
              <b>Do not ask what they spend on AI.</b> Ask which plan they are on and how often their people hit the
              limits. The first question gets you a defensive number; the second gets you the real comparable.
            </div>
            <div class="note">
              <b>The managed service is the product.</b> Hardware is a one-off sale at compressed margin. The bus
              factor bites from three nodes up: a customer with 300 staff cannot justify two dedicated people. You can,
              across ten customers.
            </div>
            <div class="note warn">
              <b>Do not sell a saving that is not there.</b> A CFO respects a quantified premium far more than an
              inflated saving, and will find the inflation.
            </div>
          </div>
        <//>

        <${Panel} title="Prospect prioritisation" hint="unvalidated sales heuristic; not part of engineering or TCO">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Sector</th><th class="num">Driver</th><th>Typical size</th></tr></thead>
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
        A historical record, not an input. <strong>Nothing here feeds the calculation directly</strong> — figures are
        transcribed into the model and hardware catalogues only after review, and each carries a confidence level.
        Six months from now, knowing which numbers were measured and which were guessed will matter more than the
        numbers themselves.
      </p>
      ${catalog.benchmarks.benchmarks.map(
        (b) => html`
          <${Panel} key=${b.id} title=${b.model}
            hint=${b.hardware + " · " + b.date}
            actions=${html`<${Badge} kind=${b.confidence}>${b.confidence}<//>`}>
            <div class="mono small muted" style=${{ marginBottom: 12, wordBreak: "break-word" }}>${b.config}</div>
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr><th>Metric</th><th class="num">Value</th><th>Note</th></tr></thead>
                <tbody>
                  ${b.metrics.map((m, i) => html`<tr key=${b.id + "-" + i}>
                    <td>${m.label}</td><td class="num strong">${m.value}</td><td class="small muted">${m.note || ""}</td>
                  </tr>`)}
                </tbody>
              </table>
            </div>
            ${b.qualification && html`<div class="note" style=${{ marginTop: 12 }}><b>Qualification.</b> ${b.qualification}</div>`}
            ${b.highlight && html`<div class="note info" style=${{ marginTop: 10 }}>${b.highlight}</div>`}
            ${b.caveats?.length &&
            html`<details class="expand" style=${{ marginTop: 12, marginLeft: -16, marginRight: -16, marginBottom: -16 }}>
              <summary>${b.caveats.length} caveat${b.caveats.length === 1 ? "" : "s"} worth reading before you trust these numbers</summary>
              <div class="inner">
                <ul style=${{ margin: 0, paddingLeft: 18 }}>
                  ${b.caveats.map((c, i) => html`<li key=${i} style=${{ marginBottom: 6 }}>${c}</li>`)}
                </ul>
              </div>
            </details>`}
          <//>`
      )}
      <${Panel} title="Contribute a run">
        <p class="lede">
          Open a pull request adding an entry to <span class="mono">data/benchmarks.json</span>. What makes a run
          usable by other people: a pinned engine build, the exact flags, the concurrency, whether the traffic was
          synthetic or realistic, and the failure modes you hit. A number without its configuration cannot be
          reproduced and will not be transcribed into the catalogues.
        </p>
      <//>
    </div>`;
}

function ExportView({ st, r, onImport, onExport, onMarkdown, onReset, onQuote }) {
  const fileRef = useRef(null);
  return html`
    <div class="stack">
      <p class="lede">
        No account, no database, no telemetry. <strong>A file on your disk is the entire persistence layer.</strong>
        Everything you have typed stays in this browser tab until you save it or close it.
      </p>
      <div class="grid two">
        <${Panel} title="Save">
          <div class="stack" style=${{ gap: 12 }}>
            <div>
              <button class="btn primary" onClick=${onMarkdown}>Save as Markdown</button>
              <p class="small muted" style=${{ marginTop: 6 }}>
                A readable report: inputs, workload, every option compared, sizing detail, the domain check and the
                confidence levels. Paste it into a decision record or a pull request.
              </p>
            </div>
            <div>
              <button class="btn" onClick=${onExport}>Save as JSON</button>
              <p class="small muted" style=${{ marginTop: 6 }}>
                The complete scenario. Reload it here to pick up exactly where you left off.
              </p>
            </div>
          </div>
        <//>
        <${Panel} title="Load">
          <div class="stack" style=${{ gap: 12 }}>
            <div>
              <button class="btn" onClick=${() => fileRef.current?.click()}>Choose a JSON scenario</button>
              <input ref=${fileRef} type="file" accept="application/json,.json" class="hidden-file"
                onChange=${(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} />
              <p class="small muted" style=${{ marginTop: 6 }}>
                Replaces everything currently on screen. Save first if you want to keep it.
              </p>
            </div>
            <div>
              <button class="btn" onClick=${onReset}>Reset to defaults</button>
            </div>
          </div>
        <//>
      </div>

      <${Panel} title="Request a quote">
        <p class="lede" style=${{ marginBottom: 12 }}>
          Ready to buy or deploy? We copy a Bindwidth scenario summary to your clipboard and open a Google Form.
        </p>
        <button class="btn primary" type="button" onClick=${() => onQuote(r.bestOwn || null)}
          disabled=${!r.validation?.valid || !r.bestOwn?.sizing?.fits || !r.bestOwn?.eligibility?.eligible || r.bestOwn?.cost?.underProvisioned}>
          Request a quote
        </button>
      <//>

      <${Panel} title="Scenario snapshot">
        <dl class="kv">
          <dt>Model</dt><dd>${st.model.name}</dd>
          <dt>Headcount</dt><dd>${nf(r.headcount)}</dd>
          <dt>Autonomous agents</dt><dd>${nf(st.agents.count)}</dd>
          <dt>Tokens per year</dt><dd>${nf(r.workload.totalTokens / 1e9, 1)} B</dd>
          <dt>Aggregate decode</dt><dd>${r.bestOwn?.sizing?.fits ? nf(r.bestOwn.sizing.aggregate) + " tok/s per unit" : "—"}</dd>
          <dt>Cheapest owned</dt><dd>${r.bestOwn ? r.bestOwn.hw.label + " — " + eur(r.bestOwn.cost.total) : "—"}</dd>
          <dt>Cheapest eligible alternative</dt><dd>${r.bestAlt ? r.bestAlt.hw.label + " — " + eur(r.bestAlt.cost.total) : "—"}</dd>
          <dt>Ownership premium</dt><dd>${eur(r.delta)}</dd>
        </dl>
      <//>
    </div>`;
}

/* ---------------- shell ---------------- */

const TABS = [
  ["team", "Team & cost"],
  ["workload", "Workload"],
  ["model", "Model"],
  ["hardware", "Configurations"],
  ["comparables", "Comparables"],
  ["results", "Results"],
  ["packages", "Packages"],
  ["benchmarks", "Benchmarks"],
  ["export", "Save & load"],
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
      say("This option is invalid, ineligible, or under-provisioned and cannot be quoted.", true);
      return;
    }
    const result = await openRfqForm(st, r, target);
    say(result.message, result.err);
  }, [st, r, canQuote]);

  const handleImport = async (file) => {
    try {
      const data = await importJson(file);
      setSt(data.state);
      const migrated = data.migrationsApplied?.length
        ? ` Migrated: ${data.migrationsApplied.join(", ")}.`
        : "";
      say(`Loaded “${data.scenarioName || "scenario"}”.${migrated}`);
    } catch (e) { say(e.message, true); }
  };

  if (!r) return html`<div class="main"><div class="note bad">The calculation failed. Check the console and reset to defaults.</div></div>`;

  return html`
    <div class="app">
      <header class="masthead">
        <div class="wordmark">Bindwidth <span class="dim">${APP_TAGLINE.toLowerCase()}</span></div>
        <div class="spacer"></div>
        <div class="masthead-tools">
          <input class="scenario" placeholder="Name this scenario" value=${st.scenarioName}
            onChange=${(e) => set("scenarioName", e.target.value)} />
          <div class="masthead-actions">
            <button class="btn ghost-dark sm" type="button" onClick=${openWizard}>Guided setup</button>
            <button class="btn ghost-dark sm" onClick=${() => exportMarkdown(st, r)}>Markdown</button>
            <button class="btn ghost-dark sm" onClick=${() => exportJson(st, r)}>JSON</button>
            <button class="btn ghost-dark sm" type="button" onClick=${() => handleQuote(r.bestOwn || null)}
              disabled=${!canQuote()}>
              Request quote
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
          onReset=${() => { setSelectedPresetId(null); setSt(build()); say("Back to defaults."); }} />`}
      </main>

      <footer class="foot">
        <div class="foot-in">
          <div>
            <h4>${APP_TAGLINE}</h4>
            <p>
              Memory bandwidth strongly influences decode, while prefill shares the same accelerator time.
              KV memory, combined serving and runtime sessions can tie as binding limits. Bindwidth surfaces them
              so you can size a private local stack against what actually binds.
            </p>
            <p>
              Frontend only. Nothing you type is transmitted anywhere. Add hardware, models and benchmarks by
              opening a pull request against the JSON files in <span class="mono">data/</span>.
            </p>
          </div>
          <div>
            <h4>Author</h4>
            <p><strong>Juxhin Radhima</strong></p>
            <p class="small muted">
              MIT licence. Contributions welcome: measured runs are worth more than opinions, and a number without
              its configuration cannot be reproduced.
            </p>
            <p>
              <button class="btn sm" type="button" onClick=${() => handleQuote(r.bestOwn || null)}
                disabled=${!canQuote()}>
                Request a quote
              </button>
            </p>
          </div>
          <div class="sponsor">
            <div class="name">Get Sh!t Done</div>
            <div class="tag">Repetitive work done for you. Not another tool to learn.</div>
            <p class="small">
              A done-for-you managed workforce of AI agents — sales, social, credit recovery and ads. We configure,
              launch and run them so your team focuses on what matters. Cloud and on-premise.
            </p>
            <a class="small" href="https://get.shitdone.ai/" target="_blank" rel="noopener">get.shitdone.ai →</a>
          </div>
        </div>
      </footer>

      <div class="verdict">
        <div class="cell"><span class="k">Cheapest owned</span><span class="v">${eur(r.bestOwn?.cost.total)}</span></div>
        <div class="cell"><span class="k">Eligible alternative</span><span class="v">${eur(r.bestAlt?.cost.total)}</span></div>
        <div class="cell"><span class="k">Premium for owning</span>
          <span class=${"v " + (r.delta > 0 ? "pos" : "neg")}>${eur(r.delta)}</span></div>
        <div class="cell"><span class="k">Per head / year</span><span class="v">${eur(r.perHeadOwn)}</span></div>
        <div class="cell"><span class="k">Conservative bind</span>
          <span class="v">${r.bestOwn?.sizing.recommendationBinding || r.bestOwn?.sizing.binding || "—"}</span></div>
        <div class="spacer"></div>
        <div class="cell"><span class="k">Aggregate decode</span><span class="v">${r.bestOwn?.sizing?.fits ? nf(r.bestOwn.sizing.aggregate) : "—"} <span style=${{ fontSize: 11, color: "#8d93a0" }}>tok/s</span></span></div>
        <button class="btn sm primary" type="button" onClick=${() => handleQuote(r.bestOwn || null)}
          disabled=${!canQuote()}>
          Request quote
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
         <h1 style="font-size:18px;margin:0 0 10px">The catalogues did not load</h1>
         <p style="color:#6b7280;font-size:14px;line-height:1.6">${e.message}</p>
         <p style="color:#6b7280;font-size:14px;line-height:1.6">
           Opening <code>index.html</code> straight from the filesystem will not work — browsers block
           <code>fetch</code> on <code>file://</code>. Serve the folder instead:
           <code style="display:block;margin-top:8px;padding:8px;background:#f2f3f5;border-radius:4px">python3 -m http.server 8080</code>
         </p>
       </div>`;
  }
}

boot();
