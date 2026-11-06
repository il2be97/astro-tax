// Estimated-tax calendar (Form 1040-ES) and "how much, by when".
// Dates are 'YYYY-MM-DD' strings throughout; they compare lexicographically.

import { annualTax } from './engine.js';
import { federalRules, EXPENSE_CATEGORIES } from './rules.js';
import { stateRate, stateByCode } from './states.js';

const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseIso = (s) => new Date(`${s}T00:00:00Z`);
export const todayIso = (now = new Date()) =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
export const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 86400000);

function nthWeekday(year, month, weekday, n) {
  const d = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + 7 * (n - 1)));
}

/** DC Emancipation Day (Apr 16, observed) and MLK Day can push an IRS date. */
function holidays(year) {
  const em = new Date(Date.UTC(year, 3, 16));
  if (em.getUTCDay() === 6) em.setUTCDate(15);
  if (em.getUTCDay() === 0) em.setUTCDate(17);
  return new Set([iso(em), iso(nthWeekday(year, 0, 1, 3)), `${year}-01-01`]);
}

/** Weekend or legal holiday → next business day. */
export function businessDay(s) {
  const d = parseIso(s);
  for (;;) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays(d.getUTCFullYear()).has(iso(d))) return iso(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** The four installment periods of a tax year (annualized-method factors). */
export function quarters(year) {
  return [
    { q: 1, start: `${year}-01-01`, end: `${year}-03-31`, due: businessDay(`${year}-04-15`), factor: 4, pct: 0.225 },
    { q: 2, start: `${year}-04-01`, end: `${year}-05-31`, due: businessDay(`${year}-06-15`), factor: 2.4, pct: 0.45 },
    { q: 3, start: `${year}-06-01`, end: `${year}-08-31`, due: businessDay(`${year}-09-15`), factor: 1.5, pct: 0.675 },
    { q: 4, start: `${year}-09-01`, end: `${year}-12-31`, due: businessDay(`${year + 1}-01-15`), factor: 1, pct: 0.9 },
  ];
}

export const returnDue = (year) => businessDay(`${year + 1}-04-15`);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const inYear = (year, from, to) => (e) => e.date >= from && e.date <= to && e.date.startsWith(String(year));

/** Sums of everything dated in [from, to]. */
export function totals(data, year, from = `${year}-01-01`, to = `${year}-12-31`) {
  const pick = inYear(year, from, to);
  const t = { seGross: 0, seExpenses: 0, adjustments: 0, wages: 0, fedWithheld: 0, stateWithheld: 0 };
  for (const i of (data.incomes ?? []).filter(pick)) {
    if (i.type === 'w2') {
      t.wages += num(i.amount);
      t.fedWithheld += num(i.fedWithheld);
      t.stateWithheld += num(i.stateWithheld);
    } else {
      t.seGross += num(i.amount);
    }
  }
  for (const e of (data.expenses ?? []).filter(pick)) {
    const cat = EXPENSE_CATEGORIES.find((c) => c.id === e.category) ?? { pct: 1 };
    const v = num(e.amount) * cat.pct;
    if (cat.kind === 'adj') t.adjustments += v;
    else t.seExpenses += v;
  }
  t.seNet = t.seGross - t.seExpenses;
  return t;
}

const scale = (t, k) => Object.fromEntries(Object.entries(t).map(([key, v]) => [key, v * k]));

function taxFor(t, profile, rules) {
  return annualTax({
    status: profile.filingStatus ?? 'single',
    seNet: t.seNet,
    wages: t.wages,
    adjustments: t.adjustments,
    stateRatePct: stateRate(profile).rate,
    localRatePct: num(profile.localRate),
    rules,
  });
}

/**
 * Full picture for a year as of `today`.
 * - projection: 'pace' annualizes year-to-date by elapsed days, 'actual' uses
 *   only what is entered.
 * - each quarter: required cumulative (lower of regular 90%/safe-harbor and
 *   annualized-income method), paid by its due date, what is still to pay.
 */
export function plan(data, profile, today) {
  const year = Number(profile.year) || Number(today.slice(0, 4));
  const { rules, fallback } = federalRules(year);
  const ytdEnd = today < `${year}-12-31` ? today : `${year}-12-31`;
  const ytd = totals(data, year, `${year}-01-01`, ytdEnd);

  let paceFactor = 1;
  if (profile.projection !== 'actual' && today >= `${year}-01-01` && today < `${year}-12-31`) {
    const elapsed = Math.max(30, daysBetween(`${year}-01-01`, today) + 1);
    const days = daysBetween(`${year}-01-01`, `${year + 1}-01-01`);
    paceFactor = days / elapsed;
  }
  if (today < `${year}-01-01`) paceFactor = 1;
  const projected = scale(ytd, paceFactor);
  const annual = taxFor(projected, profile, rules);
  const ytdTax = taxFor(ytd, profile, rules);

  const st = stateByCode(profile.state);
  const hasState = (stateRate(profile).rate > 0 || num(profile.localRate) > 0);

  const payments = (data.payments ?? []).filter((p) => num(p.year ?? year) === year);
  const paidBy = (kind, date) =>
    payments.filter((p) => p.kind === kind && p.date <= date).reduce((s, p) => s + num(p.amount), 0);

  const priorFed = num(profile.priorYearTax) * (profile.priorAgiHigh ? 1.1 : 1);
  const priorState = num(profile.priorYearStateTax);

  const fedNeed = Math.max(0, annual.federal - projected.fedWithheld);
  const stateNeed = Math.max(0, annual.stateTotal - projected.stateWithheld);
  const fedRegularYear = priorFed > 0 ? Math.min(0.9 * fedNeed, Math.max(0, priorFed - projected.fedWithheld)) : 0.9 * fedNeed;
  const stateRegularYear = priorState > 0 ? Math.min(0.9 * stateNeed, Math.max(0, priorState - projected.stateWithheld)) : 0.9 * stateNeed;

  const qs = quarters(year).map((q) => {
    const share = q.q / 4;
    let fedReq = fedRegularYear * share;
    let stateReq = stateRegularYear * share;
    if (today > q.end) {
      // Period closed → annualized-income method may lower the installment.
      const t = totals(data, year, `${year}-01-01`, q.end);
      const ann = taxFor(scale(t, q.factor), profile, rules);
      fedReq = Math.min(fedReq, Math.max(0, ann.federal * q.pct - t.fedWithheld));
      stateReq = Math.min(stateReq, Math.max(0, ann.stateTotal * q.pct - t.stateWithheld));
    }
    // Like the IRS, a payment goes to the earliest underpaid installment, so a
    // late payment still closes an overdue quarter (it just stops the penalty).
    const until = today > q.due ? today : q.due;
    const fedPaid = paidBy('federal', until);
    const statePaid = paidBy('state', until);
    const onTime = paidBy('federal', q.due) >= fedReq - 1 && (!hasState || paidBy('state', q.due) >= stateReq - 1);
    const fedDue = Math.max(0, fedReq - fedPaid);
    const stateDue = hasState ? Math.max(0, stateReq - statePaid) : 0;
    const toPay = fedDue + stateDue;
    let status = 'upcoming';
    if (toPay < 1) status = onTime || today <= q.due ? 'covered' : 'late';
    else if (today > q.due) status = 'overdue';
    else if (daysBetween(today, q.due) <= 21) status = 'soon';
    const late = status === 'overdue' ? daysBetween(q.due, today) : 0;
    const penalty = late > 0 ? toPay * rules.underpaymentRate * (late / 365) : 0;
    return {
      ...q,
      required: { fed: fedReq, state: hasState ? stateReq : 0 },
      paid: { fed: fedPaid, state: statePaid },
      toPay: { fed: fedDue, state: stateDue, total: toPay },
      status,
      daysLeft: daysBetween(today, q.due),
      penalty,
    };
  });

  const paidFed = payments.filter((p) => p.kind === 'federal').reduce((s, p) => s + num(p.amount), 0);
  const paidState = payments.filter((p) => p.kind === 'state').reduce((s, p) => s + num(p.amount), 0);
  const balance = {
    fed: annual.federal - projected.fedWithheld - paidFed,
    state: hasState ? annual.stateTotal - projected.stateWithheld - paidState : 0,
  };
  balance.total = balance.fed + balance.state;

  const next = qs.find((q) => q.status === 'overdue') ?? qs.find((q) => q.daysLeft >= 0 && q.toPay.total >= 1) ?? null;

  return {
    year,
    rulesYear: federalRules(year).year,
    fallback,
    paceFactor,
    ytd,
    ytdTax,
    projected,
    annual,
    state: st,
    hasState,
    quarters: qs,
    paid: { fed: paidFed, state: paidState, total: paidFed + paidState },
    withheld: { fed: projected.fedWithheld, state: projected.stateWithheld },
    balance,
    returnDue: returnDue(year),
    next,
  };
}
