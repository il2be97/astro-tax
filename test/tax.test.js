import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualTax, bracketTax, selfEmploymentTax } from '../js/tax/engine.js';
import { FEDERAL } from '../js/tax/rules.js';
import { quarters, businessDay, plan, totals } from '../js/tax/schedule.js';
import { desiredEvents, eventOps } from '../js/tax/sync.js';

const R = FEDERAL[2026];
const near = (a, b, eps = 1) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('brackets: single 2026, $60,000 taxable', () => {
  // 12,400×10% + 38,000×12% + 9,600×22%
  near(bracketTax(60000, R.brackets.single).tax, 1240 + 4560 + 2112);
});

test('SE tax: $100k net, no wages', () => {
  const se = selfEmploymentTax(100000, 0, R);
  near(se.total, 100000 * 0.9235 * 0.153);
});

test('SE tax: wages fill the Social Security base first', () => {
  const se = selfEmploymentTax(100000, 184500, R);
  near(se.ss, 0);
  near(se.total, 100000 * 0.9235 * 0.029);
});

test('SE tax: under $400 of net earnings is zero', () => {
  assert.equal(selfEmploymentTax(400, 0, R).total, 0);
});

test('annual: single freelancer $100k net, no state', () => {
  const t = annualTax({ status: 'single', seNet: 100000, rules: R });
  const se = 100000 * 0.9235 * 0.153;
  const agi = 100000 - se / 2;
  const tbq = agi - 16100;
  const qbi = 0.2 * Math.min(100000 - se / 2, tbq);
  const income = bracketTax(tbq - qbi, R.brackets.single).tax;
  near(t.federal, income + se);
  assert.equal(t.state, 0);
});

test('annual: state rate applies to AGI', () => {
  const t = annualTax({ status: 'single', seNet: 50000, stateRatePct: 5, rules: R });
  near(t.state, t.agi * 0.05);
});

test('calendar 2026: Apr 15, Jun 15, Sep 15, Jan 15 2027', () => {
  assert.deepEqual(quarters(2026).map((q) => q.due), ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
});

test('business day: weekend and Emancipation Day push the date', () => {
  assert.equal(businessDay('2028-04-15'), '2028-04-18'); // Sat → Mon 17 is Emancipation Day observed → Tue
  assert.equal(businessDay('2029-01-15'), '2029-01-16'); // MLK Day
});

test('totals: meals 50%, adjustments kept apart from Schedule C', () => {
  const t = totals({
    incomes: [{ date: '2026-02-01', amount: 1000, type: 'se' }],
    expenses: [
      { date: '2026-02-02', amount: 100, category: 'meals' },
      { date: '2026-02-03', amount: 300, category: 'health' },
    ],
  }, 2026);
  assert.equal(t.seExpenses, 50);
  assert.equal(t.adjustments, 300);
  assert.equal(t.seNet, 950);
});

const data = {
  incomes: [
    { date: '2026-01-20', amount: 20000, type: 'se' },
    { date: '2026-04-20', amount: 20000, type: 'se' },
    { date: '2026-07-20', amount: 20000, type: 'se' },
  ],
  expenses: [],
  payments: [{ date: '2026-04-10', amount: 1000, kind: 'federal', year: 2026 }],
};
const profile = { year: 2026, filingStatus: 'single', state: 'TX', projection: 'actual' };

test('plan: underpaid closed quarters are overdue with penalty', () => {
  const p = plan(data, profile, '2026-11-06');
  const [q1, q2, q3, q4] = p.quarters;
  assert.equal(q1.status, 'overdue');
  assert.equal(q3.status, 'overdue');
  assert.ok(q3.penalty > 0);
  assert.equal(q4.status, 'upcoming');
  assert.equal(p.next.q, 3);
  assert.equal(p.overdueFrom, 1);
  assert.equal(p.hasState, false);
});

test('plan: cumulative payments cover the quarter', () => {
  const p0 = plan(data, profile, '2026-11-06');
  const need = Math.ceil(p0.quarters[0].required.fed);
  const paid = { ...data, payments: [{ date: '2026-04-10', amount: need, kind: 'federal', year: 2026 }] };
  assert.equal(plan(paid, profile, '2026-11-06').quarters[0].status, 'covered');
});

test('plan: safe harbor lowers the requirement', () => {
  const p = plan(data, { ...profile, priorYearTax: 2000 }, '2026-11-06');
  near(p.quarters[3].required.fed, 2000, 1);
});

test('sync: idempotent, closed events untouched, resolved ones close', () => {
  const p = plan(data, profile, '2026-11-06');
  const want = desiredEvents(p, '2026-11-06');
  const first = eventOps([], want, 'T1');
  assert.ok(first.length > 0 && first.every((o) => o.op === 'set'));
  const stored = first.map((o) => ({ id: o.id, ...o.data }));
  assert.deepEqual(eventOps(stored, want, 'T2'), []);
  const read = stored.map((e) => ({ ...e, status: 'read' }));
  assert.deepEqual(eventOps(read, {}, 'T3'), []);
  const closing = eventOps(stored, {}, 'T4');
  assert.ok(closing.every((o) => o.data.status === 'closed'));
});

test('plan: a late payment closes an overdue quarter as late', () => {
  const p0 = plan(data, profile, '2026-11-06');
  const short = Math.ceil(p0.quarters[0].toPay.total);
  const late = { ...data, payments: [...data.payments, { date: '2026-11-05', amount: short, kind: 'federal', year: 2026 }] };
  const p = plan(late, profile, '2026-11-06');
  assert.equal(p.quarters[0].status, 'late');
  assert.notEqual(p.next.q, 1);
});

test('state tax is charged on AGI above the state deduction', async () => {
  const { stateDeduction } = await import('../js/tax/states.js');
  assert.equal(stateDeduction({ state: 'GA', filingStatus: 'single' }, R.stdDeduction), 12000);
  assert.equal(stateDeduction({ state: 'CO', filingStatus: 'mfj' }, R.stdDeduction), R.stdDeduction.mfj);
  assert.equal(stateDeduction({ state: 'GA', stateDeduction: '5000' }, R.stdDeduction), 5000);
  const t = annualTax({ seNet: 20000, stateRatePct: 5, stateDeduction: 12000, rules: R });
  assert.ok(Math.abs(t.state - Math.max(0, t.agi - 12000) * 0.05) < 0.01);
  assert.equal(annualTax({ seNet: 5000, stateRatePct: 5, stateDeduction: 12000, rules: R }).state, 0);
});
