/**
 * LocalAI-TCO — calculation engine
 *
 * Pure functions, no DOM, no imports. Given a state object it returns every
 * derived number the UI shows. Keeping it separate means the maths can be
 * tested, reviewed and reused without touching the interface.
 *
 * Author: Juxhin Radhima
 * Licence: MIT
 */

export const SEC_PER_HOUR = 3600;

const ceil = (x) => Math.ceil(x - 1e-9);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const safeDiv = (a, b) => (b ? a / b : 0);
const finitePositive = (x) => Number.isFinite(x) && x > 0;
const range = (value, fallback = value) => {
  if (value && typeof value === "object") {
    return { low: value.low ?? fallback, base: value.base ?? fallback, high: value.high ?? fallback };
  }
  return { low: fallback, base: value ?? fallback, high: fallback };
};

/* ------------------------------------------------------------------ *
 *  1. Cost of an hour of technical time
 * ------------------------------------------------------------------ */
export function staffing(s) {
  const employerCost = s.ral * s.employerCoef;
  const internalHourly = safeDiv(employerCost, s.hoursYear);
  const blendedHourly =
    internalHourly * (1 - s.freelanceShare) + s.freelanceRate * s.freelanceShare;
  return { employerCost, internalHourly, blendedHourly };
}

/* ------------------------------------------------------------------ *
 *  2. Workload — interactive people and autonomous agents are different
 *     animals and are kept apart all the way through.
 * ------------------------------------------------------------------ */
export function workload(st) {
  const { org, workload: w, agents: a } = st;
  const days = org.workDays;

  const people = {
    devIn: org.devs * days * w.devIn,
    devOut: org.devs * days * w.devOut,
    adminIn: org.admin * days * w.adminIn,
    adminOut: org.admin * days * w.adminOut,
    mktIn: org.marketing * days * w.mktIn,
    mktOut: org.marketing * days * w.mktOut,
  };
  people.totalIn = people.devIn + people.adminIn + people.mktIn;
  people.totalOut = people.devOut + people.adminOut + people.mktOut;

  const agentHours = a.count * a.daysYear * a.hoursDay;
  const agentsTotals = {
    totalIn: agentHours * a.inPerHour,
    totalOut: agentHours * a.outPerHour,
    activeHours: agentHours,
  };

  const totalIn = people.totalIn + agentsTotals.totalIn;
  const totalOut = people.totalOut + agentsTotals.totalOut;

  // Peak factor: bursts average out across the weighted active population.
  const activePopulation =
    org.devs + org.admin * (w.adminConcurrency ?? 0.15) +
    org.marketing * (w.marketingConcurrency ?? 0.15);
  const peakAuto = clamp(1 + w.burstiness / Math.sqrt(Math.max(1, activePopulation)), 1.2, 6);
  const peakUsed = w.peakManual > 0 ? w.peakManual : peakAuto;

  const officeSeconds = days * org.workHours * SEC_PER_HOUR;
  const agentSeconds = a.daysYear * a.hoursDay * SEC_PER_HOUR;

  const decodePeople = safeDiv(people.totalOut, officeSeconds);
  const decodeAgents = safeDiv(agentsTotals.totalOut, agentSeconds);
  // People spike, agents do not. Each component carries its own factor.
  const decodePeak = decodePeople * peakUsed + decodeAgents * a.peakFactor;
  const prefillPeople = safeDiv(people.totalIn * (1 - clamp(w.caching ?? 0, 0, 1)), officeSeconds);
  const prefillAgents = safeDiv(
    agentsTotals.totalIn * (1 - clamp(a.caching ?? 0, 0, 1)),
    agentSeconds
  );
  const prefillSustained = prefillPeople + prefillAgents;
  const prefillPeak = prefillPeople * peakUsed + prefillAgents * a.peakFactor;

  const sessionsPeople =
    org.devs * (w.devConcurrency ?? 0.6) +
    org.admin * (w.adminConcurrency ?? 0.15) +
    org.marketing * (w.marketingConcurrency ?? 0.15);
  const sessionsTotal = sessionsPeople + a.count;
  // Two populations, two context lengths — the KV requirement is the sum.
  const peopleShared = w.prefixSharing ? Math.min(w.context, w.sharedPrefixTokens ?? 0) : 0;
  const agentsShared = a.prefixSharing ? Math.min(a.context, a.sharedPrefixTokens ?? 0) : 0;
  const kvRequired =
    sessionsPeople * Math.max(0, w.context - peopleShared) + (sessionsPeople > 0 ? peopleShared : 0) +
    a.count * Math.max(0, a.context - agentsShared) + (a.count > 0 ? agentsShared : 0);

  return {
    people, agents: agentsTotals,
    totalIn, totalOut, totalTokens: totalIn + totalOut,
    peakAuto, peakUsed,
    decodePeople, decodeAgents, decodePeak,
    prefillPeople, prefillAgents, prefillSustained, prefillPeak,
    sessionsPeople, sessionsTotal, kvRequired,
    ioRatio: safeDiv(totalIn, totalOut),
  };
}

/* ------------------------------------------------------------------ *
 *  3. Model architecture → memory footprint and read volume per token
 * ------------------------------------------------------------------ */
// Prefer denser checkpoints when the default is unavailable on this hardware.
// Unknown labels sort after the known ladder (stable among unknowns).
const PRECISION_PREFERENCE = ["nvfp4", "fp8", "bf16", "fp16", "legacy"];
const CONFIDENCE_RANK = {
  template: 0, estimated: 1, derived: 1, "kv-derived": 1,
  aggregator: 1, community: 2, "list-price": 2, published: 3, measured: 4,
};
function rankPrecision(p) {
  const i = PRECISION_PREFERENCE.indexOf(p);
  return i === -1 ? PRECISION_PREFERENCE.length : i;
}
function pickPreferredPrecision(candidates) {
  if (!candidates.length) return undefined;
  return [...candidates].sort((a, b) => rankPrecision(a) - rankPrecision(b))[0];
}

export function resolvePrecision(m, hwOrFp4, override) {
  // Retain the legacy boolean call shape for imported v1 scenarios and tests.
  if (typeof hwOrFp4 === "boolean") {
    const precision = hwOrFp4 ? (m.defaultPrecision || "legacy") : "legacy-fallback";
    return {
      compatible: true,
      precision,
      bytesPerParam: hwOrFp4 ? m.bytesPerParam : m.bytesPerParam * 2,
      fellBack: false,
    };
  }
  const hw = hwOrFp4 || {};
  const modelPrecisions = m.supportedPrecisions || [m.defaultPrecision || "legacy"];
  const hardwarePrecisions = hw.supportedPrecisions ||
    (hw.fp4 ? ["nvfp4", "fp8", "bf16"] : ["fp8", "bf16"]);
  const mutual = modelPrecisions.filter((p) => hardwarePrecisions.includes(p));
  // Explicit override is sticky: unsupported combinations stay incompatible.
  if (override) {
    const compatible = modelPrecisions.includes(override) && hardwarePrecisions.includes(override);
    return {
      compatible,
      precision: override,
      bytesPerParam: m.bytesPerParamByPrecision?.[override] ?? m.bytesPerParam,
      fellBack: false,
    };
  }
  // Default may fall back to the best mutually supported checkpoint
  // (e.g. NVFP4 default → FP8 on Hopper). NVFP4-only models stay blocked.
  const preferred = m.defaultPrecision;
  const selected = (preferred && mutual.includes(preferred))
    ? preferred
    : pickPreferredPrecision(mutual);
  const fellBack = Boolean(selected && preferred && selected !== preferred);
  // A fallback precision needs an explicit bytes map — do not reuse the
  // default checkpoint's bytesPerParam for a different format.
  const hasMappedBytes = !fellBack || m.bytesPerParamByPrecision?.[selected] != null;
  const compatible = Boolean(selected) && hasMappedBytes;
  const precision = selected || preferred || modelPrecisions[0];
  return {
    compatible,
    precision,
    bytesPerParam: m.bytesPerParamByPrecision?.[precision] ?? m.bytesPerParam,
    fellBack,
  };
}

export function modelDerived(m, hwOrFp4, precisionOverride) {
  const resolved = resolvePrecision(m, hwOrFp4, precisionOverride);
  const bytesPerParam = resolved.bytesPerParam;
  const weightsGb = m.totalB * bytesPerParam;
  // Weights are read once per step, not once per token: divide by accepted tokens.
  const gbPerToken = safeDiv(weightsGb * safeDiv(m.activeB, m.totalB), m.specTokens || 1);
  return { ...resolved, bytesPerParam, weightsGb, gbPerToken };
}

export function resolveProfile(m, hw, profiles = [], profileOverride = null) {
  const matches = profiles.filter((p) =>
    p.modelId === m.id &&
    p.hardwareId === hw.id &&
    (!profileOverride || p.id === profileOverride)
  );
  if (!matches.length) return null;
  // Explicit override already filtered above. Otherwise prefer stronger evidence.
  const found = matches.reduce((best, p) =>
    (CONFIDENCE_RANK[p.confidence] ?? -1) > (CONFIDENCE_RANK[best.confidence] ?? -1) ? p : best
  );
  return {
    ...found,
    decode: range(found.decode),
    prefill: range(found.prefill),
  };
}

/** Context length that must be covered by a profile's testedContext. */
export function requestedProfileContext(st) {
  const people = st.workload?.context || 0;
  const agents = (st.agents?.count > 0 ? st.agents.context : 0) || 0;
  return Math.max(people, agents);
}

/**
 * When a model has a published/measured profile on another SKU (e.g. Spark),
 * recover aggregate÷theoretical as a production serving factor and optionally
 * transfer it to the estimate path on larger boxes. Assumes continuous-batching
 * runtimes (vLLM-class). Never raises a factor without a haircut; never lowers
 * the hardware catalogue floor.
 */
export const SIBLING_TRANSFER_HAIRCUT_SAME = 0.85;
export const SIBLING_TRANSFER_HAIRCUT_CROSS = 0.75;

export function siblingProductionFactor(m, hw, st, profiles = []) {
  const hardware = st.hardware || [];
  let best = null;
  for (const p of profiles) {
    if (p.modelId !== m.id || p.hardwareId === hw.id) continue;
    if (p.confidence !== "published" && p.confidence !== "measured") continue;
    const srcHw = hardware.find((h) => h.id === p.hardwareId);
    if (!srcHw) continue;
    const srcDerived = modelDerived(m, srcHw, st.precisionOverride);
    if (!srcDerived.compatible || !finitePositive(srcDerived.gbPerToken)) continue;
    const srcTheoretical = safeDiv(srcHw.bandwidth, srcDerived.gbPerToken);
    const decodeBase = range(p.decode).base;
    if (!finitePositive(srcTheoretical) || !finitePositive(decodeBase)) continue;
    const factor = decodeBase / srcTheoretical;
    const samePrecision = srcDerived.precision === modelDerived(m, hw, st.precisionOverride).precision;
    const ranked = CONFIDENCE_RANK[p.confidence] ?? -1;
    if (
      !best ||
      ranked > best.ranked ||
      (ranked === best.ranked && factor > best.rawFactor)
    ) {
      best = {
        rawFactor: factor,
        factor,
        samePrecision,
        profileId: p.id,
        hardwareId: p.hardwareId,
        confidence: p.confidence,
        ranked,
        srcTheoretical,
        decodeBase,
      };
    }
  }
  if (!best) return null;
  const haircut = best.samePrecision
    ? SIBLING_TRANSFER_HAIRCUT_SAME
    : SIBLING_TRANSFER_HAIRCUT_CROSS;
  return { ...best, haircut, factor: best.rawFactor * haircut };
}

/* ------------------------------------------------------------------ *
 *  4. Size one hardware option against the workload
 * ------------------------------------------------------------------ */
export function sizeOption(hw, st, wl, profiles = [], sensitivity = "base") {
  const m = st.model;
  const derived = modelDerived(m, hw, st.precisionOverride);
  const { weightsGb, gbPerToken } = derived;
  const requestedProfile = st.profileOverrides?.[hw.id] || null;
  const candidateProfile = resolveProfile(m, hw, profiles, requestedProfile);
  const requestedContext = requestedProfileContext(st);
  const profile = candidateProfile &&
    (!candidateProfile.testedContext || requestedContext <= candidateProfile.testedContext)
    ? candidateProfile
    : null;
  const warnings = [];

  const overhead = (m.overheadPerGpu || 0) * hw.gpus + (hw.memReserveGb ?? 0);
  const freeGb = hw.memGb - weightsGb - overhead;
  const kvRange = range(m.kvKbRange, m.kvKbPerToken);
  const kvKbPerToken = sensitivity === "low"
    ? kvRange.high
    : sensitivity === "high"
      ? kvRange.low
      : kvRange.base;
  const kvTokens = freeGb > 0 && finitePositive(kvKbPerToken)
    ? (freeGb * 1e6) / kvKbPerToken
    : 0;

  const theoretical = safeDiv(hw.bandwidth, gbPerToken);
  const catalogueFactor = (hw.efficiency || 0) * (hw.batching || 1);
  const singleStream = theoretical * (hw.efficiency || 0);
  let productionFactor = catalogueFactor;
  let sibling = null;
  if (!profile) {
    sibling = siblingProductionFactor(m, hw, st, profiles);
    if (sibling && sibling.factor > productionFactor) {
      productionFactor = sibling.factor;
    }
  }
  const fallbackAggregate = theoretical * productionFactor;
  const aggregateRange = profile?.decode || range(fallbackAggregate);
  const prefillRange = profile?.prefill || range(hw.prefill || fallbackAggregate * (m.prefillRatio || 1));
  const aggregate = aggregateRange[sensitivity] ?? aggregateRange.base;
  const prefill = prefillRange[sensitivity] ?? prefillRange.base;
  const maxSeqs = profile?.maxSeqs ?? m.maxSeqs;
  const targetUtilization = clamp(st.resilience?.targetUtilization ?? 1, 0.1, 1);

  // Prefill and decode compete for the same silicon: in a given second you
  // either read context or generate. This is the throughput you can actually sell.
  const blended = safeDiv(1, safeDiv(1, aggregate) + safeDiv(st.resale?.mix || 0, prefill));

  const fits = derived.compatible && freeGb > 0 && finitePositive(aggregate) && finitePositive(prefill);
  if (!derived.compatible) {
    warnings.push(
      derived.fellBack
        ? `Ripiego a ${derived.precision} ma bytesPerParamByPrecision non ha una voce corrispondente.`
        : "La precisione del checkpoint selezionato non è supportata su questo hardware."
    );
  } else if (derived.fellBack) {
    warnings.push(`Checkpoint predefinito non disponibile qui; si usa ${derived.precision}.`);
  }
  if (candidateProfile && !profile) {
    warnings.push(
      `Il profilo corrispondente ${candidateProfile.id} è stato testato solo fino a ${candidateProfile.testedContext} token; per questo contesto si usa una stima.`
    );
  }
  if (!profile) {
    if (sibling && productionFactor > catalogueFactor) {
      warnings.push(
        `Nessun profilo esatto; il decode aggregato usa il fattore di produzione ${productionFactor.toFixed(2)} ` +
        `trasferito da ${sibling.profileId} su ${sibling.hardwareId} ` +
        `(×${sibling.haircut} haircut cross-SKU${sibling.samePrecision ? "" : ", cross-precision"}). ` +
        `Si assume serving continuous-batching (classe vLLM), non chat a stream singolo.`
      );
    } else {
      warnings.push("Nessun profilo esatto modello/hardware/runtime; si usa una stima di bandwidth.");
    }
  }
  if (profile?.prefillConfidence && profile.prefillConfidence !== profile.confidence) {
    warnings.push(`L'evidenza di prefill è ${profile.prefillConfidence}; l'evidenza di decode è ${profile.confidence}.`);
  }

  const unitsKv = fits ? ceil(safeDiv(wl.kvRequired, kvTokens)) : Infinity;
  const unitsDecode = fits ? ceil(safeDiv(wl.decodePeak, aggregate * targetUtilization)) : Infinity;
  const unitsPrefill = fits ? ceil(safeDiv(wl.prefillPeak, prefill * targetUtilization)) : Infinity;
  const servingLoad = safeDiv(wl.decodePeak, aggregate) + safeDiv(wl.prefillPeak, prefill);
  const unitsServing = fits ? ceil(servingLoad / targetUtilization) : Infinity;
  const unitsSeqs = fits ? ceil(safeDiv(wl.sessionsTotal, maxSeqs)) : Infinity;
  const minimumUnits = fits
    ? Math.max(1, unitsKv, unitsDecode, unitsPrefill, unitsServing, unitsSeqs)
    : Infinity;
  const conservativeKvTokens = freeGb > 0 ? (freeGb * 1e6) / kvRange.high : 0;
  const unitsKvConservative = fits ? ceil(safeDiv(wl.kvRequired, conservativeKvTokens)) : Infinity;
  const conservativeServingLoad =
    safeDiv(wl.decodePeak, aggregateRange.low) + safeDiv(wl.prefillPeak, prefillRange.low);
  const unitsServingConservative = fits ? ceil(conservativeServingLoad / targetUtilization) : Infinity;
  const conservativeMinimumUnits = fits
    ? Math.max(1, unitsKvConservative, unitsServingConservative, unitsSeqs)
    : Infinity;
  const reserveUnits = fits ? Math.max(0, Math.ceil(st.resilience?.maintenanceReserve ?? 0)) : 0;
  const recommendedUnits = fits
    ? conservativeMinimumUnits + reserveUnits + (st.resilience?.nPlusOne ? 1 : 0)
    : Infinity;

  const bindingFrom = (target, values) => {
    if (!fits) return { binding: "none", bindings: [] };
    const bindings = Object.entries(values).filter(([, v]) => v === target).map(([k]) => k);
    return { binding: bindings.join("+"), bindings };
  };
  const baseBinding = bindingFrom(minimumUnits, {
    kv: unitsKv, serving: unitsServing, concurrency: unitsSeqs,
  });
  const recommendationBinding = bindingFrom(conservativeMinimumUnits, {
    kv: unitsKvConservative, serving: unitsServingConservative, concurrency: unitsSeqs,
  });

  const usedSiblingTransfer = Boolean(!profile && sibling && productionFactor > catalogueFactor);
  return {
    precision: derived.precision, weightsGb, overhead, freeGb, kvTokens, kvKbPerToken,
    kvRange, gbPerToken, theoretical, singleStream, aggregate, prefill, blended,
    profileId: profile?.id ?? null,
    profileConfidence: profile?.confidence ?? (usedSiblingTransfer ? "derived" : "estimated"),
    productionFactor, catalogueFactor, siblingTransfer: usedSiblingTransfer ? sibling : null,
    bands: { decode: aggregateRange, prefill: prefillRange, kvKbPerToken: kvRange },
    maxSeqs, targetUtilization, servingLoad,
    fits, unitsKv, unitsDecode, unitsPrefill, unitsServing, unitsSeqs,
    unitsKvConservative, unitsServingConservative,
    minimumUnits, conservativeMinimumUnits, recommendedUnits, units: recommendedUnits,
    binding: baseBinding.binding, bindings: baseBinding.bindings,
    recommendationBinding: recommendationBinding.binding,
    recommendationBindings: recommendationBinding.bindings,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 *  5. Cost over the selected horizon
 * ------------------------------------------------------------------ */
export function costOption(hw, st, wl, sizing, rates) {
  const { econ, mgmt, resale } = st;
  const extraCosts = st.costs || {};
  const Y = econ.years;
  const units = Number.isFinite(sizing.units) ? Math.max(0, sizing.units) : 0;
  const qty = st.manualQty?.[hw.id] > 0 ? st.manualQty[hw.id] : units;
  const underProvisioned = qty < (sizing.recommendedUnits ?? sizing.minimumUnits ?? units);

  // Platform work (gateway, routing, FinOps, evals) exists in every scenario.
  // Infrastructure work is on top of it, and only when you run the metal —
  // whether you own it or rent it makes no difference to the hours.
  const infraBase = hw.class === "appliance" ? mgmt.applianceQuota : mgmt.nodeQuota;
  const infraQuota = infraBase * (1 - mgmt.automation);

  let capex = 0, energy4 = 0, support4 = 0, service4 = 0, serviceUpfront = 0;
  let mgmtQuota = 0, setupCost = 0;
  let derivedUtilization = 0, utilizationUsed = 0;
  let purchaseCycles = 0;

  if (hw.kind === "own") {
    purchaseCycles = Math.max(1, Math.ceil(Y / Math.max(0.1, extraCosts.modelLifeYears || Y)));
    capex = qty * (hw.priceUsd * econ.fx * purchaseCycles + hw.infraPerUnit);
    const yearSeconds = econ.hoursYear * SEC_PER_HOUR;
    const effectiveInput = wl.prefillPeople * st.org.workDays * st.org.workHours * SEC_PER_HOUR +
      wl.prefillAgents * st.agents.daysYear * st.agents.hoursDay * SEC_PER_HOUR;
    const averageServingLoad =
      safeDiv(safeDiv(wl.totalOut, yearSeconds), sizing.aggregate) +
      safeDiv(safeDiv(effectiveInput, yearSeconds), sizing.prefill);
    derivedUtilization = clamp(safeDiv(averageServingLoad, Math.max(1, qty)), 0, 1);
    utilizationUsed = extraCosts.energyMode === "manual"
      ? clamp(econ.utilization, 0, 1)
      : derivedUtilization;
    const avgKw = hw.idleKw + utilizationUsed * (hw.peakKw - hw.idleKw);
    energy4 = avgKw * qty * econ.hoursYear * hw.pue * econ.kwhPrice * Y;
    support4 = hw.supportPerUnit * qty * Y;
    mgmtQuota = mgmt.platformQuota + infraQuota + mgmt.perUnitQuota * Math.max(0, qty - 1);
    setupCost = hw.setupHours * rates.blendedHourly;
  } else if (hw.kind === "rent") {
    const eur = hw.currency === "USD" ? econ.fx : 1;
    service4 = qty * hw.hourly * eur * econ.hoursYear * Y * (1 - st.rental.reserveDiscount);
    serviceUpfront = service4 * clamp(st.rental.upfrontShare ?? 0, 0, 1);
    mgmtQuota = mgmt.platformQuota + infraQuota + mgmt.perUnitQuota * Math.max(0, qty - 1);
    setupCost = 0;
  }

  const mgmtHoursYear = mgmtQuota * st.staff.hoursYear;
  const mgmt4 = mgmtHoursYear * rates.blendedHourly * Y + setupCost;

  // Media requires a separate measured profile. Without one it is excluded on both sides.
  const media4 = st.media?.scope === "separate-cost" ? (st.media.ownedAnnualCost || 0) * Y : 0;
  const mediaExcluded = (st.workload.images > 0 || st.workload.videoSeconds > 0) &&
    st.media?.scope !== "separate-cost";

  // Optional: sell idle capacity to your own supply chain.
  let resaleGross = 0, resaleEnergy = 0, resaleOps = 0, resaleNet = 0, resaleFeasible = false;
  if (resale.enabled && hw.kind === "own" && qty > 0 && !underProvisioned) {
    const decodeHeadroom = Math.max(
      0,
      qty * sizing.aggregate * sizing.targetUtilization - wl.decodePeak
    );
    const prefillHeadroom = Math.max(
      0,
      qty * sizing.prefill * sizing.targetUtilization - wl.prefillPeak
    );
    const sellableOutput = decodeHeadroom > 0 && prefillHeadroom > 0
      ? safeDiv(1, safeDiv(1, decodeHeadroom) + safeDiv(resale.mix, prefillHeadroom))
      : 0;
    const outTokensM =
      (sellableOutput * SEC_PER_HOUR * econ.hoursYear *
        resale.freeHoursShare * resale.sellThrough) / 1e6;
    resaleFeasible = outTokensM > 0;
    const inTokensM = outTokensM * resale.mix;
    resaleGross = inTokensM * resale.priceIn + outTokensM * resale.priceOut;
    const soldUtilization =
      safeDiv(sellableOutput, qty * sizing.aggregate) +
      safeDiv(sellableOutput * resale.mix, qty * sizing.prefill);
    resaleEnergy =
      (hw.peakKw - hw.idleKw) * qty * clamp(soldUtilization, 0, 1) * econ.hoursYear *
      resale.freeHoursShare * resale.sellThrough * hw.pue * econ.kwhPrice;
    resaleOps = resaleFeasible
      ? resale.opsQuota * st.staff.hoursYear * rates.blendedHourly
      : 0;
    resaleNet = resaleGross - resaleEnergy - resaleOps;
  }

  const recurringExtras =
    ((extraCosts.networkAnnual || 0) + (extraCosts.storageAnnual || 0) +
      (extraCosts.softwareAnnual || 0) + (extraCosts.replacementReserveAnnual || 0)) * Y;
  const financing = capex * (extraCosts.financingRate || 0) * Y;
  const residual = capex * clamp(extraCosts.residualShare || 0, 0, 1);
  const total =
    capex + financing - residual + energy4 + mgmt4 + support4 + service4 +
    media4 + recurringExtras - resaleNet * Y;

  return {
    qty, capex, purchaseCycles, financing, residual, recurringExtras,
    energy4, mgmt4, support4, service4, serviceUpfront,
    serviceRecurring: service4 - serviceUpfront, media4, mediaExcluded,
    energyBasis: extraCosts.energyMode === "manual" ? "manual" : "derived",
    derivedUtilization, utilizationUsed,
    mgmtQuota, mgmtHoursYear, mgmtHoursDay: safeDiv(mgmtHoursYear, st.org.workDays),
    resaleGross, resaleEnergy, resaleOps, resaleNet: resaleNet * Y, resaleFeasible,
    underProvisioned, total,
  };
}

/* ------------------------------------------------------------------ *
 *  6. Subscriptions + per-token API, priced by population
 * ------------------------------------------------------------------ */
export function costSubscriptions(st, wl, rates) {
  const { org, subs, econ, agents, mgmt, staff } = st;
  const Y = econ.years;

  const devSeatBase = org.devs * subs.devPlan * 12 * Y * econ.fx;
  const casualSeatBase = (org.admin + org.marketing) * subs.casualPlan * 12 * Y * econ.fx;
  const pricedInput = (tokens, caching) =>
    (tokens / 1e6) * ((1 - caching) * subs.apiIn + caching * subs.apiCached);
  const pricedOutput = (tokens) => (tokens / 1e6) * subs.apiOut;
  const excessCost = (input, output, included) => {
    const total = input + output;
    const excessShare = total > 0 ? Math.max(0, total - included) / total : 0;
    return (pricedInput(input * excessShare, st.workload.caching) +
      pricedOutput(output * excessShare)) * econ.fx * Y;
  };
  const devUsageOverage = excessCost(
    wl.people.devIn,
    wl.people.devOut,
    org.devs * (subs.devIncludedTokensYear || 0)
  );
  const casualUsageOverage = excessCost(
    wl.people.adminIn + wl.people.mktIn,
    wl.people.adminOut + wl.people.mktOut,
    (org.admin + org.marketing) * (subs.casualIncludedTokensYear || 0)
  );
  const devOverage = Math.max(devSeatBase * subs.overage, devUsageOverage);
  const devSeats = devSeatBase + devOverage;
  const casualSeats = casualSeatBase + casualUsageOverage;

  // Autonomous agents do not live in a per-seat plan. They burn tokens.
  const agIn = wl.agents.totalIn / 1e6;
  const agOut = wl.agents.totalOut / 1e6;
  const cacheStorageM = (agents.count * agents.context) / 1e6;
  const agentTokens =
    (agIn * ((1 - agents.caching) * subs.apiIn + agents.caching * subs.apiCached) +
      agOut * subs.apiOut +
      cacheStorageM * subs.apiStorage * agents.daysYear * agents.hoursDay) *
    econ.fx * Y;

  const media = st.media?.scope === "included-comparison"
    ? (st.workload.images * subs.imagePrice + st.workload.videoSeconds * subs.videoPrice) *
      econ.fx * Y
    : 0;

  const mgmtHoursYear = mgmt.platformQuota * staff.hoursYear;
  const mgmt4 = mgmtHoursYear * rates.blendedHourly * Y;

  return {
    devSeats, casualSeats, devSeatBase, casualSeatBase,
    devUsageOverage, casualUsageOverage, agentTokens, media, mgmt4,
    mediaExcluded: (st.workload.images > 0 || st.workload.videoSeconds > 0) &&
      st.media?.scope !== "included-comparison",
    mgmtHoursYear, mgmtHoursDay: safeDiv(mgmtHoursYear, org.workDays),
    service4: devSeats + casualSeats + agentTokens + media,
    total: devSeats + casualSeats + agentTokens + media + mgmt4,
  };
}

/* ------------------------------------------------------------------ *
 *  7. Utilisation: how much of what you bought is actually working
 * ------------------------------------------------------------------ */
export function utilisation(hw, st, wl, sizing, qty) {
  const capacity = qty * sizing.aggregate;
  const kvCapacity = qty * sizing.kvTokens;
  const occupancyPeak = safeDiv(wl.decodePeak, capacity);
  const sustained = wl.decodePeople + wl.decodeAgents;
  const occupancyMean = safeDiv(sustained, capacity);
  const freeCapacity = capacity - wl.decodePeak;
  const occupancyKv = safeDiv(wl.kvRequired, kvCapacity);

  const perDevDecode = safeDiv(st.workload.devOut, st.org.workHours * SEC_PER_HOUR) * wl.peakUsed;
  const perDevPrefill =
    safeDiv(
      st.workload.devIn * (1 - clamp(st.workload.caching ?? 0, 0, 1)),
      st.org.workHours * SEC_PER_HOUR
    ) * wl.peakUsed;
  const devsByDecode = safeDiv(freeCapacity, perDevDecode);
  const prefillCapacity = qty * sizing.prefill - wl.prefillPeak;
  const devsByPrefill = safeDiv(prefillCapacity, perDevPrefill);
  const devsByKv = safeDiv(kvCapacity - wl.kvRequired, st.workload.context * 0.6);
  const devsBySessions = Math.max(0, qty * sizing.maxSeqs - wl.sessionsTotal) /
    (st.workload.devConcurrency ?? 0.6);
  const extraDevs = Math.max(0, Math.min(devsByDecode, devsByPrefill, devsByKv, devsBySessions));

  return {
    capacity, kvCapacity, occupancyPeak, occupancyMean, occupancyKv,
    prefillCapacity, freeCapacity, extraDevs,
  };
}

/* ------------------------------------------------------------------ *
 *  8. Domain check — when this tool stops being the right instrument
 * ------------------------------------------------------------------ */
export function domainCheck(hw, qty) {
  const kwPeak = hw.kind === "own" ? hw.peakKw * qty : 0;
  const rackDensity = hw.kind === "own" ? Math.min(4, qty) * hw.peakKw : 0;
  const busFactor = qty >= 3 ? 2 : 1;
  let verdict = "in-domain";
  if (qty > 8 || kwPeak > 150) verdict = "out-of-domain";
  else if (qty > 3 || kwPeak > 100 || rackDensity > 20) verdict = "at-limit";
  return { qty, kwPeak, rackDensity, busFactor, verdict, advisoryOnly: true };
}

export function validateState(st) {
  const errors = [], warnings = [];
  const positive = [
    ["Giorni di lavoro", st.org?.workDays],
    ["Ore di lavoro", st.org?.workHours],
    ["Parametri del modello", st.model?.totalB],
    ["Parametri attivi", st.model?.activeB],
    ["KV per token", st.model?.kvKbPerToken],
    ["Token speculativi", st.model?.specTokens],
    ["Orizzonte", st.econ?.years],
    ["Ore di lavoro del personale", st.staff?.hoursYear],
  ];
  for (const [label, value] of positive) {
    if (!finitePositive(value)) errors.push(`${label} deve essere un numero positivo e finito.`);
  }
  if ((st.workload?.context ?? 0) > (st.model?.maxContext ?? Infinity)) {
    errors.push("Il contesto interattivo supera il contesto massimo del modello.");
  }
  if ((st.agents?.context ?? 0) > (st.model?.maxContext ?? Infinity)) {
    errors.push("Il contesto degli agenti supera il contesto massimo del modello.");
  }
  if ((st.model?.activeB ?? 0) > (st.model?.totalB ?? 0)) {
    errors.push("I parametri attivi non possono superare i parametri totali.");
  }
  const nonNegative = [
    ["Sviluppatori", st.org?.devs], ["Utenti amministrativi", st.org?.admin],
    ["Utenti marketing", st.org?.marketing], ["Numero di agenti", st.agents?.count],
    ["Contesto interattivo", st.workload?.context], ["Contesto degli agenti", st.agents?.context],
    ["Token di input", st.workload?.devIn], ["Token di output", st.workload?.devOut],
    ["Retribuzione annua lorda", st.staff?.ral], ["Tariffa freelance", st.staff?.freelanceRate],
    ["Prezzo dell'elettricità", st.econ?.kwhPrice],
  ];
  for (const [label, value] of nonNegative) {
    if (!Number.isFinite(value) || value < 0) errors.push(`${label} non può essere negativo o non finito.`);
  }
  const fractions = [
    ["Tasso di hit della cache interattiva", st.workload?.caching],
    ["Tasso di hit della cache degli agenti", st.agents?.caching],
    ["Quota freelance", st.staff?.freelanceShare],
    ["Sconto sul noleggio", st.rental?.reserveDiscount],
    ["Quota iniziale del noleggio", st.rental?.upfrontShare],
  ];
  for (const [label, value] of fractions) {
    if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`${label} deve essere compreso tra zero e uno.`);
  }
  if ((st.org?.workHours ?? 0) > 24 || (st.agents?.hoursDay ?? 0) > 24) {
    errors.push("Le ore attive giornaliere non possono superare 24.");
  }
  if ((st.org?.workDays ?? 0) > 366 || (st.agents?.daysYear ?? 0) > 366) {
    errors.push("I giorni attivi annuali non possono superare 366.");
  }
  for (const hw of st.hardware || []) {
    if (!finitePositive(hw.memGb) || !finitePositive(hw.bandwidth) || !finitePositive(hw.gpus)) {
      errors.push(`${hw.label || hw.id || "Hardware"} ha memoria, bandwidth o numero di GPU non validi.`);
    }
  }
  const target = st.resilience?.targetUtilization ?? 1;
  if (target <= 0 || target > 1) {
    errors.push("L'utilizzo target deve essere maggiore di zero e al massimo uno.");
  }
  if ((st.workload?.peakManual ?? 0) === 0) {
    warnings.push("La domanda di picco è derivata dalla formula; sostituiscila con telemetria misurata prima dell'acquisto.");
  }
  if (st.model?.kvKbRange?.status === "unresolved") {
    warnings.push("Il modello selezionato ha misurazioni KV per token non risolte.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

function regionTokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function regionsOverlap(a, b) {
  const left = new Set(regionTokens(a));
  if (!left.size) return false;
  return regionTokens(b).some((token) => left.has(token));
}

function optionEligibility(hw, st, sizing, cost) {
  const reasons = [];
  const referenceNotes = [];
  const req = st.requirements || {};
  // EU / sovereignty for rentals is labelled for reference only — hard-excluding
  // them leaves the rent comparison empty when EU catalogue options do not fit.
  if (hw.kind === "rent") {
    if (req.sovereignOnly && hw.sovereign !== true) {
      referenceNotes.push("Fuori dalla preferenza di sovranità — mostrato solo per riferimento.");
    }
    if (req.regions?.length && hw.region) {
      const regionMatches = req.regions.some((region) => regionsOverlap(region, hw.region));
      if (!regionMatches) {
        referenceNotes.push("La regione del provider è fuori dalle regioni preferite — mostrata solo per riferimento.");
      }
    }
  } else if (req.sovereignOnly && hw.kind !== "own" && hw.sovereign !== true) {
    reasons.push("Non eleggibile con il requisito di sola sovranità.");
  }
  if (req.requireEquivalentCapability && hw.equivalentCapability === false) {
    reasons.push("Non è stata verificata una capacità di modello equivalente.");
  }
  const minimum = CONFIDENCE_RANK[req.minimumConfidence] ?? 0;
  const actual = CONFIDENCE_RANK[sizing.profileConfidence || hw.confidence] ?? 0;
  if (actual < minimum) reasons.push("Il livello di confidenza dell'evidenza è inferiore al minimo dello scenario.");
  if (!sizing.fits) reasons.push("Il modello non entra o il deployment è incompatibile.");
  if (cost.underProvisioned) reasons.push("La quantità manuale è inferiore alla raccomandazione conservativa di produzione.");
  return {
    eligible: reasons.length === 0,
    reasons,
    referenceNotes,
    referenceOnly: referenceNotes.length > 0,
  };
}

/* ------------------------------------------------------------------ *
 *  9. Full run
 * ------------------------------------------------------------------ */
export function compute(st, profiles = []) {
  const rates = staffing(st.staff);
  const wl = workload(st);
  const sensitivity = st.sensitivityMode || "base";
  const validation = validateState(st);

  const options = st.hardware
    .filter((hw) => hw.enabled !== false)
    .map((hw) => {
      const sizing = sizeOption(hw, st, wl, profiles, sensitivity);
      const cost = costOption(hw, st, wl, sizing, rates);
      const util = utilisation(hw, st, wl, sizing, cost.qty);
      const domain = domainCheck(hw, cost.qty);
      const perMToken = safeDiv(cost.total, (wl.totalTokens * st.econ.years) / 1e6);
      const inputService =
        safeDiv(wl.prefillPeople * st.org.workDays * st.org.workHours * SEC_PER_HOUR, sizing.prefill) +
        safeDiv(wl.prefillAgents * st.agents.daysYear * st.agents.hoursDay * SEC_PER_HOUR, sizing.prefill);
      const outputService = safeDiv(wl.totalOut, sizing.aggregate);
      const serviceTotal = inputService + outputService;
      const inputAllocated = cost.total * safeDiv(inputService, serviceTotal);
      const outputAllocated = cost.total * safeDiv(outputService, serviceTotal);
      const perMInput = safeDiv(inputAllocated, (wl.totalIn * st.econ.years) / 1e6);
      const perMOutput = safeDiv(outputAllocated, (wl.totalOut * st.econ.years) / 1e6);
      const eligibility = optionEligibility(hw, st, sizing, cost);
      return {
        hw, sizing, cost, util, domain, eligibility,
        perMToken, perMInput, perMOutput, kind: hw.kind,
      };
    });

  const subs = costSubscriptions(st, wl, rates);
  const subsPerM = safeDiv(subs.total, (wl.totalTokens * st.econ.years) / 1e6);
  options.push({
    hw: {
      id: "subscriptions",
      kind: "subscription",
      label: "Abbonamenti + API per token",
      class: "service",
      sovereign: false,
      equivalentCapability: false,
      notes:
        "Piano premium per sviluppatori, piano base per utenti occasionali, API per token per agenti autonomi. Modelli chiusi, server tipicamente fuori dall'UE, quote che gli utenti agentici intensi superano.",
      confidence: "list-price",
    },
    sizing: {
      fits: true, units: 0, minimumUnits: 0, recommendedUnits: 0,
      binding: "none", aggregate: 0, prefill: 0, kvTokens: 0,
      profileConfidence: "list-price",
    },
    cost: { ...subs, qty: 0, capex: 0, energy4: 0, support4: 0, resaleNet: 0 },
    util: null,
    domain: { qty: 0, kwPeak: 0, rackDensity: 0, busFactor: 0, verdict: "n/a" },
    eligibility: optionEligibility(
      { kind: "subscription", sovereign: false, equivalentCapability: false, confidence: "list-price" },
      st,
      { fits: true, profileConfidence: "list-price" },
      { underProvisioned: false }
    ),
    perMToken: subsPerM,
    perMInput: null,
    perMOutput: null,
    kind: "subscription",
  });

  const viable = validation.valid
    ? options.filter((o) => o.sizing.fits && o.eligibility.eligible)
    : [];
  const own = viable.filter((o) => o.kind === "own");
  const alt = viable.filter((o) => o.kind !== "own");
  const bestOwn = own.length ? own.reduce((a, b) => (a.cost.total <= b.cost.total ? a : b)) : null;
  const bestAlt = alt.length ? alt.reduce((a, b) => (a.cost.total <= b.cost.total ? a : b)) : null;

  const delta = bestOwn && bestAlt ? bestOwn.cost.total - bestAlt.cost.total : null;
  const headcount = st.org.devs + st.org.marketing + st.org.admin;

  return {
    rates, workload: wl, options, bestOwn, bestAlt, delta, validation, sensitivityMode: sensitivity,
    headcount,
    perHeadOwn: bestOwn ? safeDiv(bestOwn.cost.total, headcount * st.econ.years) : null,
    perHeadAlt: bestAlt ? safeDiv(bestAlt.cost.total, headcount * st.econ.years) : null,
    premiumAccepted: st.econ.onPremPremium,
    premiumActual: bestOwn && bestAlt ? safeDiv(delta, bestAlt.cost.total) : null,
  };
}

export function computeSensitivity(st, profiles = []) {
  const u = st.uncertainty || {};
  const scenario = (mode, direction) => {
    const factor = (pct) => 1 + direction * (pct || 0);
    const local = JSON.parse(JSON.stringify(st));
    local.costs ||= { modelLifeYears: local.econ.years };
    local.sensitivityMode = mode;
    local.workload.burstiness *= factor(u.peakPct);
    if ((local.workload.peakManual || 0) > 0) {
      local.workload.peakManual *= factor(u.peakPct);
    }
    for (const key of ["platformQuota", "applianceQuota", "nodeQuota", "perUnitQuota"]) {
      local.mgmt[key] *= factor(u.managementPct);
    }
    local.hardware = local.hardware.map((hw) => ({
      ...hw,
      priceUsd: hw.priceUsd ? hw.priceUsd * factor(u.pricePct) : hw.priceUsd,
      hourly: hw.hourly ? hw.hourly * factor(u.pricePct) : hw.hourly,
    }));
    local.costs.modelLifeYears = direction > 0
      ? (u.modelLifeLow || local.costs.modelLifeYears)
      : direction < 0
        ? (u.modelLifeHigh || local.costs.modelLifeYears)
        : local.costs.modelLifeYears;
    return compute(local, profiles);
  };
  const conservative = scenario("low", 1);
  const base = scenario("base", 0);
  const optimistic = scenario("high", -1);
  const summarize = (r) => ({
    bestOwn: r.bestOwn?.hw.id ?? null,
    bestAlt: r.bestAlt?.hw.id ?? null,
    ownUnits: r.bestOwn?.sizing.recommendedUnits ?? null,
    ownTotal: r.bestOwn?.cost.total ?? null,
    binding: r.bestOwn?.sizing.binding ?? null,
  });
  const summaries = {
    conservative: summarize(conservative),
    base: summarize(base),
    optimistic: summarize(optimistic),
  };
  return {
    conservative, base, optimistic, summaries,
    winnerChanges: new Set(Object.values(summaries).map((x) => x.bestOwn)).size > 1,
    bindingChanges: new Set(Object.values(summaries).map((x) => x.binding)).size > 1,
  };
}

/* ------------------------------------------------------------------ *
 * 10. Package sizing — the same engine, run across a range of team sizes
 * ------------------------------------------------------------------ */
export function packages(st, sizes, profiles = []) {
  return sizes.map((p) => {
    const local = JSON.parse(JSON.stringify(st));
    local.org.devs = Math.round(p.aiUsers);
    local.org.admin = Math.max(0, p.employees - Math.round(p.aiUsers));
    local.org.marketing = 0;
    local.workload.devOut = p.tokensOutPerDay;
    local.workload.devIn = p.tokensOutPerDay * safeDiv(st.workload.devIn, st.workload.devOut);
    local.workload.peakManual = 0;
    const res = compute(local, profiles);
    const pick = res.bestOwn;
    if (!pick) return { ...p, feasible: false };
    const perUserMonth = safeDiv(pick.cost.total, p.aiUsers * st.econ.years * 12);
    const breakEvenSeat = safeDiv(perUserMonth, st.econ.fx);
    return {
      ...p,
      feasible: true,
      option: pick.hw.label,
      units: pick.cost.qty,
      capex: pick.cost.capex,
      total: pick.cost.total,
      perUserYear: safeDiv(pick.cost.total, p.aiUsers * st.econ.years),
      perUserMonth,
      breakEvenSeat,
      multiple: safeDiv(perUserMonth, st.subs.devPlan * st.econ.fx),
      binding: pick.sizing.binding,
      verdict:
        breakEvenSeat >= 150 ? "competitive" :
        breakEvenSeat >= 60 ? "needs-governance-driver" : "hard-sell",
    };
  });
}

/* ------------------------------------------------------------------ *
 * 11. Prospect scoring
 * ------------------------------------------------------------------ */
export function scoreProspect(p, sectors, st, perUserYear) {
  const sector = sectors.find((s) => s.id === Number(p.sectorId)) || { driver: 0 };
  const economics =
    perUserYear < 1500 ? 25 : perUserYear < 3000 ? 18 : perUserYear < 5000 ? 10 : 0;
  const parts = [
    { label: "Fattore di governance del settore", value: sector.driver, max: 40 },
    { label: "Economia per utente", value: economics, max: 25 },
    { label: "Il legale ha già bloccato una sperimentazione cloud", value: p.pilotBlocked ? 15 : 0, max: 15 },
    { label: "Sala server e personale già predisposti", value: p.hasServerRoom ? 10 : 0, max: 10 },
    { label: "Brevetti depositati", value: p.filesPatents ? 10 : 0, max: 10 },
    { label: "Accordo di framework con un hyperscaler", value: p.hyperscalerLock ? -25 : 0, max: 0 },
    { label: "Fuori dalla fascia di dimensionamento", value: p.aiUsers < 40 ? -20 : 0, max: 0 },
  ];
  const total = Math.max(0, parts.reduce((a, b) => a + b.value, 0));
  const verdict =
    total >= 70 ? "Priorità alta" :
    total >= 45 ? "Da coltivare" :
    total >= 25 ? "Priorità bassa" : "Da non inseguire";
  return { parts, total, verdict };
}
