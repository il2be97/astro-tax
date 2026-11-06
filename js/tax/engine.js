// Pure annual tax math — no dates, no storage. Every figure is an estimate.

const round2 = (n) => Math.round(n * 100) / 100;

export function bracketTax(taxable, brackets) {
  let tax = 0;
  let floor = 0;
  let marginal = brackets[0][1];
  for (const [ceil, rate] of brackets) {
    if (taxable <= floor) break;
    const slice = Math.min(taxable, ceil) - floor;
    tax += slice * rate;
    marginal = rate;
    floor = ceil;
  }
  return { tax, marginal };
}

/**
 * Self-employment tax (Schedule SE). `wages` are W-2 wages already subject to
 * Social Security — they eat into the wage base first.
 */
export function selfEmploymentTax(seNet, wages, rules) {
  const base = Math.max(0, seNet) * 0.9235;
  if (base < 400) return { base, ss: 0, medicare: 0, total: 0 };
  const ssRoom = Math.max(0, rules.ssWageBase - Math.max(0, wages));
  const ss = Math.min(base, ssRoom) * 0.124;
  const medicare = base * 0.029;
  return { base, ss, medicare, total: ss + medicare };
}

/**
 * Whole-year estimate.
 * @param {object} p
 * @param {'single'|'mfj'|'mfs'|'hoh'} p.status
 * @param {number} p.seNet      Schedule C net profit (gross − deductible expenses)
 * @param {number} p.wages      W-2 wages
 * @param {number} p.adjustments above-the-line (SE health, SEP/401k, other)
 * @param {number} p.stateRatePct
 * @param {number} p.localRatePct
 * @param {object} p.rules      FEDERAL[year]
 */
export function annualTax({ status = 'single', seNet = 0, wages = 0, adjustments = 0, stateRatePct = 0, stateDeduction = 0, localRatePct = 0, rules }) {
  const se = selfEmploymentTax(seNet, wages, rules);
  const halfSE = se.total / 2;

  const medicareWages = Math.max(0, wages) + se.base;
  const addlMedicare = Math.max(0, medicareWages - rules.addlMedicareThreshold[status]) * 0.009;

  const agi = Math.max(0, wages + seNet - halfSE - adjustments);
  const std = rules.stdDeduction[status];
  const taxableBeforeQbi = Math.max(0, agi - std);

  // QBI: 20% of qualified business income, capped at 20% of taxable income.
  const qbi = Math.max(0, seNet - halfSE - adjustments);
  let qbiDeduction = 0.2 * Math.min(qbi, taxableBeforeQbi);
  const over = taxableBeforeQbi - rules.qbiThreshold[status];
  if (over > 0) qbiDeduction *= Math.max(0, 1 - over / rules.qbiPhaseIn[status]);

  const taxable = Math.max(0, taxableBeforeQbi - qbiDeduction);
  const { tax: incomeTax, marginal } = bracketTax(taxable, rules.brackets[status]);

  const federal = incomeTax + se.total + addlMedicare;
  // States mostly start from federal AGI; state deductions are ignored, which
  // errs on the side of paying slightly more.
  const state = Math.max(0, agi - stateDeduction) * (stateRatePct / 100);
  const local = agi * (localRatePct / 100);
  const total = federal + state + local;
  const gross = Math.max(0, wages) + Math.max(0, seNet);

  return {
    seNet: round2(seNet),
    seTax: round2(se.total),
    ss: round2(se.ss),
    medicare: round2(se.medicare),
    addlMedicare: round2(addlMedicare),
    halfSE: round2(halfSE),
    agi: round2(agi),
    stdDeduction: std,
    qbiDeduction: round2(qbiDeduction),
    taxable: round2(taxable),
    incomeTax: round2(incomeTax),
    marginal,
    federal: round2(federal),
    state: round2(state),
    local: round2(local),
    stateTotal: round2(state + local),
    total: round2(total),
    effective: gross > 0 ? total / gross : 0,
  };
}
