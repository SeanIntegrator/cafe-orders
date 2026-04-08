/**
 * TEMPORARY — Flow milk chip QA: scan modifier names + customer note for texture/temperature phrases.
 * Remove or replace when Square/catalog mapping is final.
 */

/** Longer / more specific patterns first */
const TEXTURE_SPECS = [
  { re: /\bextra\s+dry\b/i, label: 'Extra dry' },
  { re: /\bless\s+foam\b/i, label: 'Less foam' },
  { re: /\bno\s+foam\b/i, label: 'No foam' },
  { re: /\bfoamy\b/i, label: 'Foamy' },
  { re: /\bwet\b/i, label: 'Wet' },
  { re: /\bdry\b/i, label: 'Dry' },
];

const TEMP_SPECS = [
  { re: /\bextra\s+hot\b/i, label: 'Extra hot' },
  { re: /\bhot\b/i, label: 'Hot' },
  { re: /\bwarm\b/i, label: 'Warm' },
];

/**
 * @param {string} text
 * @returns {string|null} First matching texture label
 */
export function parseFlowMilkTextureFromText(text) {
  const s = String(text || '');
  for (const { re, label } of TEXTURE_SPECS) {
    if (re.test(s)) return label;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string|null} First matching temperature label
 */
export function parseFlowMilkTemperatureFromText(text) {
  const s = String(text || '');
  for (const { re, label } of TEMP_SPECS) {
    if (re.test(s)) return label;
  }
  return null;
}

/**
 * @param {string[]} names - ordered modifier names
 * @param {string|null|undefined} customerNote
 */
export function buildFlowMilkScanText(names, customerNote) {
  const parts = [...(names || []).map((n) => String(n))];
  if (customerNote != null && String(customerNote).trim()) {
    parts.push(String(customerNote).trim());
  }
  return parts.join(' ');
}
