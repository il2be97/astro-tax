// State income tax — rough 2026 guide. `none` states have no wage income tax,
// `flat` carry the statutory flat rate, `prog` carry a mid-income guide rate.
// Progressive states differ by bracket: the user should set their own rate in
// the profile (override) — the UI says so.

export const STATES = [
  ['AL', 'Alabama', 'prog', 5.0], ['AK', 'Alaska', 'none', 0], ['AZ', 'Arizona', 'flat', 2.5],
  ['AR', 'Arkansas', 'prog', 3.9], ['CA', 'California', 'prog', 6.0], ['CO', 'Colorado', 'flat', 4.4],
  ['CT', 'Connecticut', 'prog', 5.0], ['DE', 'Delaware', 'prog', 5.5], ['DC', 'District of Columbia', 'prog', 6.5],
  ['FL', 'Florida', 'none', 0], ['GA', 'Georgia', 'flat', 5.09], ['HI', 'Hawaii', 'prog', 7.0],
  ['ID', 'Idaho', 'flat', 5.3], ['IL', 'Illinois', 'flat', 4.95], ['IN', 'Indiana', 'flat', 2.95],
  ['IA', 'Iowa', 'flat', 3.8], ['KS', 'Kansas', 'prog', 5.58], ['KY', 'Kentucky', 'flat', 3.5],
  ['LA', 'Louisiana', 'flat', 3.0], ['ME', 'Maine', 'prog', 6.75], ['MD', 'Maryland', 'prog', 4.75],
  ['MA', 'Massachusetts', 'flat', 5.0], ['MI', 'Michigan', 'flat', 4.25], ['MN', 'Minnesota', 'prog', 6.8],
  ['MS', 'Mississippi', 'flat', 4.0], ['MO', 'Missouri', 'prog', 4.7], ['MT', 'Montana', 'prog', 5.9],
  ['NE', 'Nebraska', 'prog', 4.55], ['NV', 'Nevada', 'none', 0], ['NH', 'New Hampshire', 'none', 0],
  ['NJ', 'New Jersey', 'prog', 5.5], ['NM', 'New Mexico', 'prog', 4.9], ['NY', 'New York', 'prog', 6.0],
  ['NC', 'North Carolina', 'flat', 3.99], ['ND', 'North Dakota', 'prog', 1.95], ['OH', 'Ohio', 'flat', 2.75],
  ['OK', 'Oklahoma', 'prog', 4.75], ['OR', 'Oregon', 'prog', 8.75], ['PA', 'Pennsylvania', 'flat', 3.07],
  ['RI', 'Rhode Island', 'prog', 4.75], ['SC', 'South Carolina', 'prog', 6.0], ['SD', 'South Dakota', 'none', 0],
  ['TN', 'Tennessee', 'none', 0], ['TX', 'Texas', 'none', 0], ['UT', 'Utah', 'flat', 4.5],
  ['VT', 'Vermont', 'prog', 6.6], ['VA', 'Virginia', 'prog', 5.75], ['WA', 'Washington', 'none', 0],
  ['WV', 'West Virginia', 'prog', 4.8], ['WI', 'Wisconsin', 'prog', 5.3], ['WY', 'Wyoming', 'none', 0],
].map(([code, name, kind, rate]) => ({ code, name, kind, rate }));

export const stateByCode = (code) => STATES.find((s) => s.code === code) ?? null;

// Approximate standard deduction / personal exemption, [single, married jointly].
// 'fed' = the state starts from the federal standard deduction. States not listed
// count from 0 (errs on paying a bit more). The user can set their own amount.
const STATE_STD = {
  GA: [12000, 24000], NC: [12750, 25500], CA: [5540, 11080], NY: [8000, 16050], VA: [8500, 17000],
  MN: [14950, 29900], LA: [12500, 25000], MI: [5600, 11200], MA: [4400, 8800], IL: [2850, 5700],
  OR: [2835, 5670], KY: [3270, 3270], MS: [8300, 16600], OK: [7350, 14700], VT: [7400, 14850],
  RI: [10900, 21800], WI: [13230, 24490], IN: [1000, 2000], NJ: [1000, 2000], MD: [2700, 5450],
  AZ: 'fed', CO: 'fed', ID: 'fed', MO: 'fed', ND: 'fed', NM: 'fed', SC: 'fed', MT: 'fed', DC: 'fed', ME: 'fed',
};

/** State deduction in dollars: the user's own amount wins over the guide. */
export function stateDeduction(profile, fedStd = {}) {
  const own = Number(profile?.stateDeduction);
  if (profile?.stateDeduction !== '' && profile?.stateDeduction != null && Number.isFinite(own)) return own;
  const v = STATE_STD[profile?.state];
  const status = profile?.filingStatus ?? 'single';
  if (v === 'fed') return fedStd[status] ?? 0;
  if (!v) return 0;
  return status === 'mfj' ? v[1] : v[0];
}

/** Effective state rate in percent: the user's override wins over the guide. */
export function stateRate(profile) {
  const override = Number(profile?.stateRateOverride);
  if (profile?.stateRateOverride !== '' && profile?.stateRateOverride != null && Number.isFinite(override)) {
    return { rate: override, source: 'override' };
  }
  const s = stateByCode(profile?.state);
  if (!s) return { rate: 0, source: 'none' };
  return { rate: s.rate, source: s.kind };
}
