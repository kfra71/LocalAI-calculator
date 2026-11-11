/**
 * Display labels for internal enum values.
 *
 * The engine and the data files keep their canonical tokens in English
 * ("kv", "serving", "concurrency", "measured", …) because they are compared
 * against data and asserted by the test suite. This module maps those tokens
 * to the Italian wording a visitor actually reads, so the UI never leaks an
 * internal identifier into a sentence.
 */

/** Binding constraint tokens → Italian labels. */
const BINDING_LABELS = {
  kv: "memoria KV",
  serving: "serving prefill/decode",
  concurrency: "sessioni concorrenti",
  none: "nessun vincolo",
};

/**
 * Italian label for a binding constraint.
 * Accepts a single token ("serving") or a joined combination ("kv+serving").
 */
export function bindingLabel(binding) {
  if (!binding) return "—";
  return String(binding)
    .split("+")
    .map((token) => BINDING_LABELS[token] || token)
    .join(" + ");
}

/** Verdict tokens ("out-of-domain", "at-limit", "in-domain") → Italian labels. */
const VERDICT_LABELS = {
  "out-of-domain": "fuori dominio",
  "at-limit": "al limite",
  "in-domain": "nel dominio",
};

export function verdictLabel(verdict) {
  if (!verdict) return "—";
  return VERDICT_LABELS[verdict] || verdict;
}

/** Package verdict tokens (engine output) → Italian labels. */
const PACKAGE_VERDICT_LABELS = {
  "competitive": "competitivo",
  "needs-governance-driver": "serve una motivazione di governance",
  "hard-sell": "vendita difficile",
};

export function packageVerdictLabel(verdict) {
  if (!verdict) return "—";
  return PACKAGE_VERDICT_LABELS[verdict] || verdict;
}

/** Option kind tokens ("own", "rent", "subscription") → Italian labels. */
const KIND_LABELS = {
  "own": "di proprietà",
  "rent": "in noleggio",
  "subscription": "abbonamento",
};

export function kindLabel(kind) {
  if (!kind) return "—";
  return KIND_LABELS[kind] || kind;
}
