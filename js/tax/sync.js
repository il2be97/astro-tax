// The tax clock — the same idea as the ship clock in Astro Routine.
//
// The profile carries `syncedAt`. On every sync the engine looks at the year
// as of *now* and decides which events should exist (a payment is close, a
// payment is overdue, the return is close). EventSync then writes them
// idempotently:
//   - no event       → written (open)
//   - open, changed  → updated; open but no longer wanted → closed ('resolved')
//   - closed / read  → never touched again
// So a sync can run on every app start, on every edit and on every device —
// the log converges to the same state.

import { daysBetween, parseIso, iso } from './schedule.js';

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const ruDate = (s) => parseIso(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/\s?г\.$/, '');
const minusDays = (s, d) => { const x = parseIso(s); x.setUTCDate(x.getUTCDate() - d); return iso(x); };

/** What the log should hold for this plan, keyed by stable id. */
export function desiredEvents(plan, today) {
  const out = {};
  const y = plan.year;
  for (const q of plan.quarters) {
    if (q.status === 'soon') {
      out[`${y}-q${q.q}-soon`] = {
        kind: 'soon', level: 'warn', at: minusDays(q.due, 21),
        title: `Платёж Q${q.q} через ${q.daysLeft} дн.`,
        body: `До ${ruDate(q.due)}: федеральный ${money(q.toPay.fed)}${q.toPay.state ? `, штат ${money(q.toPay.state)}` : ''}.`,
        amount: Math.round(q.toPay.total),
      };
    }
    if (q.status === 'overdue') {
      out[`${y}-q${q.q}-overdue`] = {
        kind: 'overdue', level: 'alert', at: q.due,
        title: `Просрочен платёж Q${q.q}`,
        body: `Не хватает ${money(q.toPay.total)} с ${ruDate(q.due)}. Пени растут ≈ ${money(q.penalty)} на сегодня.`,
        amount: Math.round(q.toPay.total),
      };
    }
  }
  const toReturn = daysBetween(today, plan.returnDue);
  if (toReturn >= 0 && toReturn <= 60 && plan.balance.total > 1) {
    out[`${y}-return`] = {
      kind: 'return', level: 'warn', at: minusDays(plan.returnDue, 60),
      title: `Декларация за ${y} — до ${ruDate(plan.returnDue)}`,
      body: `Ожидаемый остаток к доплате ${money(plan.balance.total)}.`,
      amount: Math.round(plan.balance.total),
    };
  }
  if (plan.fallback) {
    out[`${y}-rules`] = {
      kind: 'info', level: 'info', at: `${y}-01-01`,
      title: `Ставки ${y} ещё не загружены`,
      body: `Считаю по правилам ${plan.rulesYear} года. Обнови js/tax/rules.js, когда IRS опубликует новые.`,
    };
  }
  return out;
}

const same = (a, b) => a.title === b.title && a.body === b.body && a.amount === b.amount && a.level === b.level;

/** Diff the stored log against the desired one → write operations. */
export function eventOps(existing, desired, nowIso) {
  const ops = [];
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const [id, ev] of Object.entries(desired)) {
    const cur = byId.get(id);
    if (!cur) ops.push({ op: 'set', id, data: { ...ev, status: 'open', createdAt: nowIso, updatedAt: nowIso } });
    else if (cur.status === 'open' && !same(cur, ev)) ops.push({ op: 'update', id, data: { ...ev, updatedAt: nowIso } });
  }
  for (const e of existing) {
    if (e.status === 'open' && !desired[e.id] && e.kind !== 'note') {
      ops.push({ op: 'update', id: e.id, data: { status: 'closed', closedReason: 'resolved', updatedAt: nowIso } });
    }
  }
  return ops;
}
