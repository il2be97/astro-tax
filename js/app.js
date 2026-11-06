import { LocalStore, CloudStore, cloudConfigured, initCloud, watchAuth, signIn, signOut } from './store.js';
import { plan as buildPlan, todayIso, parseIso } from './tax/schedule.js';
import { desiredEvents, eventOps } from './tax/sync.js';
import { FILING_STATUSES, WORK_MODES, EXPENSE_CATEGORIES } from './tax/rules.js';
import { STATES, stateByCode, stateRate } from './tax/states.js';

// ───────────── helpers ─────────────
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
};
const longDate = (s) => parseIso(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDate = (s) => parseIso(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n, a, b, c) => {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return a;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b;
  return c;
};
const days = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const opts = (list, value, key = 'id', label = 'label') =>
  list.map((o) => `<option value="${esc(o[key])}"${String(o[key]) === String(value ?? '') ? ' selected' : ''}>${esc(o[label])}</option>`).join('');
const amt = (v) => Math.round(Number(v) * 100) / 100 || 0;
const remember = (k, v) => { try { localStorage.setItem(`astro-tax/${k}`, v); } catch { /* ignore */ } };
const recall = (k) => { try { return localStorage.getItem(`astro-tax/${k}`) ?? ''; } catch { return ''; } };

const QUICK_CATS = ['software', 'equipment', 'office', 'phone', 'travel', 'meals', 'car', 'advertising', 'contract', 'legal', 'fees', 'rent', 'education', 'home', 'insurance', 'health', 'retirement', 'other'];
const CATS = QUICK_CATS.map((id) => EXPENSE_CATEGORIES.find((c) => c.id === id)).filter(Boolean);

// ───────────── state ─────────────
let store = null;
let data = null;
let user = null;
let unwatch = null;
let syncing = false;
let showAll = false;
let tab = recall('tab') || 'home';
let clientSel = '';
const root = $('#root');
const sheet = $('#sheet');

const profile = () => {
  const p = data?.profile ?? {};
  return {
    ...p,
    filingStatus: p.filingStatus || 'single',
    workMode: p.workMode || 'self',
    projection: p.projection || 'pace',
    year: Number(p.year) || Number(todayIso().slice(0, 4)),
  };
};
const currentPlan = () => buildPlan(data, profile(), todayIso());

// ───────────── boot ─────────────
async function boot() {
  // ?local — try the app without an account (data stays in this browser).
  if (!cloudConfigured() || new URLSearchParams(location.search).has('local')) { start(new LocalStore()); return; }
  gate('Подключение…');
  const slow = setTimeout(() => gate('Не удаётся подключиться.', 'Проверь интернет или отключи блокировщик рекламы для этого сайта.', true), 12000);
  try {
    await initCloud();
    await watchAuth((u) => {
      clearTimeout(slow);
      user = u;
      if (unwatch) { unwatch(); unwatch = null; }
      if (!u) { store = null; data = null; $('#settings-btn').hidden = true; gate(); return; }
      gate('Загрузка данных…');
      start(new CloudStore(u.uid));
    });
  } catch (e) { clearTimeout(slow); gate('Не удалось подключиться.', String(e?.message ?? e), true); }
}

function start(s) {
  store = s;
  data = null;
  // Firestore waits for the server on a first load; never leave the user staring at a spinner.
  const slow = setTimeout(() => { if (!data) gate('Данные не загружаются.', 'Проверь интернет или отключи блокировщик рекламы для этого сайта.', true); }, 12000);
  unwatch = store.watch((snap, err) => {
    clearTimeout(slow);
    if (err) { gate('Нет доступа к данным.', String(err?.message ?? err), true); return; }
    data = snap;
    render();
    sync();
  });
}

// The tax clock: compare deadlines with "now" and keep the event log in step.
async function sync() {
  if (syncing || !data?.profile?.state) return;
  syncing = true;
  try {
    await mergeDuplicates();
    await runRecurring();
    const today = todayIso();
    const now = new Date().toISOString();
    const ops = eventOps(data.events ?? [], desiredEvents(currentPlan(), today), now);
    for (const o of ops) {
      if (o.op === 'set') await store.put('events', o.id, o.data);
      else await store.update('events', o.id, o.data);
    }
    const stale = !data.profile.syncedAt || Date.now() - Date.parse(data.profile.syncedAt) > 10 * 60 * 1000;
    if (ops.length || stale) await store.setProfile({ syncedAt: now });
  } finally { syncing = false; }
}

// Monthly expenses: add every month after rule.last up to today (ids are
// deterministic, and rule.last moves forward, so a deleted month stays deleted).
async function runRecurring() {
  const today = todayIso();
  const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
  for (const r of data.recurring ?? []) {
    let ym = r.last || r.start;
    let last = r.last;
    for (;;) {
      const n = nextYm(ym);
      const lastDay = new Date(Number(n.slice(0, 4)), Number(n.slice(5, 7)), 0).getDate();
      const date = `${n}-${String(Math.min(r.day || 1, lastDay)).padStart(2, '0')}`;
      if (date > today) break;
      await store.put('expenses', `${r.id}-${n}`, {
        date, amount: r.amount, category: r.category, accountId: r.accountId ?? '', note: r.note ?? '', recurringId: r.id,
      });
      ym = n;
      last = n;
    }
    if (last !== r.last) await store.update('recurring', r.id, { last });
  }
}

// Accounts / clients with the same name (made twice by accident) → keep the first,
// move its records over, delete the rest. Idempotent: does nothing once clean.
async function mergeDuplicates() {
  const refs = { accounts: ['accountId', ['incomes', 'expenses']], clients: ['clientId', ['incomes']] };
  for (const [col, [field, users]] of Object.entries(refs)) {
    const keep = new Map();
    for (const a of data[col] ?? []) {
      const key = nameKey(a.name);
      const first = keep.get(key);
      if (!first) { keep.set(key, a); continue; }
      for (const u of users) {
        for (const x of (data[u] ?? []).filter((i) => i[field] === a.id)) await store.update(u, x.id, { [field]: first.id });
      }
      if (!first.last4 && a.last4) await store.update(col, first.id, { last4: a.last4 });
      await store.remove(col, a.id);
    }
  }
}

// ───────────── screens ─────────────
function gate(message, error, stuck) {
  root.innerHTML = `
    <section class="gate"><div class="hero">
      <div class="logo-mark" style="margin:0 auto 14px">A</div>
      <div class="kicker">Astro · Tax</div>
      <p class="when" style="margin:14px 0 22px">${esc(message ?? 'Налоги США без головной боли: сколько и когда платить.')}</p>
      ${message ? '' : '<button class="btn primary block" data-act="signin">Войти через Google</button>'}
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      ${stuck ? `<div style="display:flex;gap:10px;margin-top:18px">
        <button class="btn primary block" data-act="reload">Обновить</button>
        ${user ? '<button class="btn block" data-act="signout">Выйти</button>' : ''}</div>` : ''}
    </div></section>`;
  syncDot();
}

function syncDot() {
  const el = $('#sync');
  el.className = `sync${store?.mode !== 'cloud' ? ' off' : data?.pending ? ' pending' : !navigator.onLine ? ' off' : ''}`;
  el.title = store?.mode !== 'cloud' ? 'Локально — только в этом браузере' : data?.pending ? 'Синхронизация…' : navigator.onLine ? 'Синхронизировано' : 'Офлайн';
}

function render() {
  if (!data) return;
  syncDot();
  $('#settings-btn').hidden = false;
  const p = profile();
  if (!p.state) { welcome(); return; }
  const plan = currentPlan();
  const views = {
    home: () => hero(plan) + notes() + actions(p) + feed(p),
    income: () => incomeView(p, plan),
    expense: () => expenseView(p),
    tax: () => taxView(p, plan),
  };
  root.innerHTML = (views[tab] ?? views.home)() + tabbar();
  root.querySelector('details.more.open-default')?.setAttribute('open', '');
}

const TABS = [['home', 'Главная', '◎'], ['income', 'Доходы', '↓'], ['expense', 'Расходы', '↑'], ['tax', 'Налоги', '%']];
const tabbar = () => `<nav class="tabbar">${TABS.map(([id, label, icon]) => `
  <button class="${id === tab ? 'on' : ''}" data-act="tab" data-tab="${id}"><i>${icon}</i>${label}</button>`).join('')}</nav>`;

function welcome() {
  root.innerHTML = `
    <section class="hero welcome">
      <div class="kicker" style="text-align:center">Начнём</div>
      <h1>Два вопроса — и всё</h1>
      <p>Остальное можно поменять потом в настройках.</p>
      <label class="field">Где живёшь
        <select id="w-state"><option value="">Выбери штат</option>${STATES.map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field">Как работаешь
        <select id="w-mode">${opts(WORK_MODES, 'self')}</select></label>
      <button class="btn primary block" data-act="welcome-done">Готово</button>
    </section>`;
}

function hero(plan) {
  const n = plan.next;
  const paid = plan.paid.total + plan.withheld.fed + plan.withheld.state;
  const total = plan.annual.total;
  const share = total > 0 ? Math.min(100, (paid / total) * 100) : 0;
  const year = `
    <div class="year">
      <div class="year-line"><span>Налог за ${plan.year}</span><span><b>${money(paid)}</b> из ${money(total)}</span></div>
      <div class="bar"><i style="width:${share.toFixed(1)}%"></i></div>
    </div>`;
  if (!n) {
    const left = Math.max(0, plan.balance.total);
    return `<section class="hero">
      <div class="kicker">${left > 1 ? 'Остаток к декларации' : 'Всё оплачено'}</div>
      <div class="big">${money(left)}</div>
      <div class="when">${left > 1 ? `до ${longDate(plan.returnDue)}` : 'квартальные платежи закрыты'}</div>
      ${left > 1 ? kinds(plan, Math.max(0, plan.balance.fed), Math.max(0, plan.balance.state)) : ""}
      ${year}
    </section>`;
  }
  const late = n.status === 'overdue';
  const d = Math.abs(n.daysLeft);
  return `<section class="hero${late ? ' alert' : ''}">
    <div class="kicker">${late ? 'Просрочено' : 'Следующий платёж'}</div>
    <div class="big">${money(n.toPay.total)}</div>
    <div class="when">${late ? `${plan.overdueFrom < n.q ? `за Q${plan.overdueFrom}–Q${n.q}` : `Q${n.q}`} · срок был ${longDate(n.due)}` : n.daysLeft === 0 ? 'сегодня' : `до ${longDate(n.due)} · через ${days(d)}`}</div>
    ${kinds(plan, n.toPay.fed, n.toPay.state)}
    ${year}
    <button class="btn primary block" data-act="pay">Оплатил</button>
  </section>`;
}

// Split a federal amount into income tax vs self-employment tax (both go to the IRS)
// in the same proportion as the annual estimate; the state part is separate.
function kinds(plan, fed, state) {
  const a = plan.annual;
  const seShare = a.federal > 0 ? a.seTax / a.federal : 0;
  const cells = [
    ['Федеральный', fed * (1 - seShare)],
    ['Самозанятость', fed * seShare],
    [plan.hasState ? `Штат ${esc(plan.state?.code ?? '')}` : 'Штат', plan.hasState ? state : 0],
  ].filter(([, v]) => v >= 1);
  if (cells.length < 2) return '';
  return `<div class="split">${cells.map(([l, v]) => `<span>${l}<b>${money(v)}</b></span>`).join('')}</div>`;
}

// Only events that add something beyond the hero.
function notes() {
  const shown = (data.events ?? []).filter((e) => e.status === 'open' && (e.kind === 'return' || e.kind === 'info'));
  return shown.map((e) => `
    <div class="note${e.level === 'alert' ? ' alert' : ''}"><i></i><div><b>${esc(e.title)}</b>${esc(e.body)}</div>
      <button data-act="ack" data-id="${esc(e.id)}" aria-label="Скрыть">×</button></div>`).join('');
}

function actions(p) {
  return `<div class="actions"${p.workMode === 'w2' ? ' style="grid-template-columns:1fr"' : ''}>
    <button class="btn" data-act="income"><span class="plus">+</span>Доход</button>
    ${p.workMode === 'w2' ? '' : '<button class="btn" data-act="expense"><span class="plus">+</span>Расход</button>'}
  </div>`;
}

function feed(p, { cols = ['incomes', 'expenses', 'payments'], pred = () => true, title = `Записи ${p.year}`, totals: withTotals = true } = {}) {
  const y = String(p.year);
  const want = (col) => (x) => cols.includes(col) && pred(x, col);
  const items = [
    ...(data.incomes ?? []).filter((x) => x.date?.startsWith(y)).filter(want('incomes')).map((x) => ({ col: 'incomes', x, g: 'in', icon: '↓', title: clientName(x) || (x.type === 'w2' ? 'Зарплата' : 'Доход'), sub: [x.type === 'w2' ? 'W-2' : '', accName(x.accountId)].filter(Boolean).join(' · '), amount: `+${money(x.amount)}`, cls: 'ok' })),
    ...(data.expenses ?? []).filter((x) => x.date?.startsWith(y)).filter(want('expenses')).map((x) => ({ col: 'expenses', x, g: 'out', icon: '↑', title: `${EXPENSE_CATEGORIES.find((c) => c.id === x.category)?.label ?? 'Расход'}${x.recurringId ? ' ↻' : ''}${x.hasReceipt ? ' 📎' : ''}`, sub: x.note || accName(x.accountId), amount: `−${money(x.amount)}`, cls: '' })),
    ...(data.payments ?? []).filter((x) => Number(x.year ?? x.date?.slice(0, 4)) === p.year).filter(want('payments')).map((x) => ({ col: 'payments', x, g: 'tax', icon: '✓', title: `Налог ${x.kind === 'state' ? 'штату' : 'IRS'}`, sub: Number(x.quarter) ? `Q${x.quarter}` : 'декларация', amount: money(x.amount), cls: 'dim' })),
  ].sort((a, b) => (b.x.date ?? '').localeCompare(a.x.date ?? ''));
  const list = showAll ? items : items.slice(0, 6);
  const sum = (col) => (data[col] ?? []).filter((x) => x.date?.startsWith(y)).reduce((t, x) => t + (Number(x.amount) || 0), 0);
  const inc = sum('incomes');
  const exp = sum('expenses');
  const totals = withTotals && (inc || exp) ? `<div class="split totals">
      <span>Доход<b class="ok">${money(inc)}</b></span>
      <span>Расход<b>${money(exp)}</b></span>
      <span>Прибыль<b>${money(inc - exp)}</b></span>
    </div>` : '';
  return `<section>
    <div class="section-title"><span>${title}</span>${items.length > 6 ? `<button class="btn link" style="padding:0;font-size:11px" data-act="toggle-all">${showAll ? 'Свернуть' : `Все ${items.length}`}</button>` : ''}</div>
    ${totals}
    <div class="feed">${list.length ? list.map((i) => `
      <button class="item" data-act="open-item" data-col="${i.col}" data-id="${esc(i.x.id)}">
        <span class="glyph ${i.g}">${i.icon}</span>
        <span class="t"><div>${esc(i.title)}</div><small>${shortDate(i.x.date)}${i.sub ? ` · ${esc(i.sub)}` : ''}</small></span>
        <span class="a ${i.cls}">${i.amount}</span>
      </button>`).join('') : '<div class="empty">Пока пусто.</div>'}</div>
  </section>`;
}

// ───────────── charts ─────────────
// Horizontal bars, one hue: magnitude only, so no legend; label + value are text.
function bars(rows, max = Math.max(...rows.map((r) => r.v), 1), act = '') {
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row${act ? ' tap' : ''}"${act ? ` data-act="${act}" data-key="${esc(r.key)}"` : ''} title="${esc(r.label)}: ${money(r.v)}${r.note ? ` · ${esc(r.note)}` : ''}">
      <div class="bar-head"><span>${esc(r.label)}</span><b>${money(r.v)}</b></div>
      <div class="bar-track"><i style="width:${Math.max(r.v > 0 ? 1.5 : 0, (r.v / max) * 100).toFixed(1)}%"></i></div>
      ${r.note ? `<small>${esc(r.note)}</small>` : ''}
    </div>`).join('')}</div>`;
}

// 12 monthly columns of income for the year.
function months(p, pred = () => true) {
  const y = String(p.year);
  const m = Array(12).fill(0);
  for (const x of data.incomes ?? []) if (x.date?.startsWith(y) && pred(x)) m[Number(x.date.slice(5, 7)) - 1] += Number(x.amount) || 0;
  const max = Math.max(...m, 1);
  const names = ['Я', 'Ф', 'М', 'А', 'М', 'И', 'И', 'А', 'С', 'О', 'Н', 'Д'];
  const full = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  return `<div class="cols">${m.map((v, i) => `
    <div class="col" title="${full[i]}: ${money(v)}" data-act="month" data-label="${full[i]} · ${money(v)}"><div class="col-track"><i style="height:${v > 0 ? Math.max(3, (v / max) * 100).toFixed(1) : 0}%"></i></div><span>${names[i]}</span></div>`).join('')}</div>`;
}

// Who an income belongs to — a client, legacy free text, W-2 wages, or nobody.
const clientKey = (x) => x.clientId || (x.type === 'w2' ? '__w2' : x.source ? `src:${x.source}` : '__none');
const clientLabel = (x) => clientName(x) || (x.type === 'w2' ? 'Зарплата W-2' : 'Без заказчика');

function incomeView(p, plan) {
  const y = String(p.year);
  const inc = (data.incomes ?? []).filter((x) => x.date?.startsWith(y));
  const groups = new Map();
  for (const x of inc) {
    const k = clientKey(x);
    const g = groups.get(k) ?? { key: k, label: clientLabel(x), v: 0, se: 0, n: 0 };
    g.v += Number(x.amount) || 0;
    if (x.type !== 'w2') g.se += Number(x.amount) || 0;
    g.n += 1;
    groups.set(k, g);
  }
  const all = [...groups.values()].sort((a, b) => b.v - a.v);
  const total = all.reduce((t, g) => t + g.v, 0);
  const totalSe = all.reduce((t, g) => t + g.se, 0);
  if (clientSel && !groups.has(clientSel)) clientSel = '';
  const sel = groups.get(clientSel);
  const pick = `<label class="field picker">Заказчик
    <select data-act-change="client">
      <option value="">Все заказчики · ${money(total)}</option>
      ${all.map((g) => `<option value="${esc(g.key)}"${g.key === clientSel ? ' selected' : ''}>${esc(g.label)} · ${money(g.v)}</option>`).join('')}
    </select></label>`;

  let body;
  if (!sel) {
    const rows = all.map((g) => ({ label: g.label, v: g.v, note: total ? `${Math.round((g.v / total) * 100)}% · ${g.n} ${g.n === 1 ? 'платёж' : g.n < 5 ? 'платежа' : 'платежей'}` : '', key: g.key }));
    body = `${rows.length ? `<div class="chart"><div class="chart-title">Доход по заказчикам<span>${money(total)}</span></div>${bars(rows, undefined, 'client')}<div class="fine" style="text-align:left;margin-top:10px">Нажми на заказчика — подробнее</div></div>` : ''}
      <div class="chart"><div class="chart-title">Доход по месяцам<span></span></div>${months(p)}</div>`;
  } else {
    // Tax attributed to this client: income tax and state by share of all income,
    // self-employment tax by share of 1099 income. An estimate on the year forecast.
    const a = plan.annual;
    const share = total ? sel.v / total : 0;
    const seShare = totalSe ? sel.se / totalSe : 0;
    const t = { fed: (a.incomeTax + a.addlMedicare) * share, se: a.seTax * seShare, st: a.stateTotal * share };
    const tTotal = t.fed + t.se + t.st;
    body = `<section class="hero client">
        <div class="kicker">${esc(sel.label)}</div>
        <div class="big">${money(sel.v)}</div>
        <div class="when">${Math.round(share * 100)}% дохода за ${p.year} · ${sel.n} ${sel.n === 1 ? 'платёж' : sel.n < 5 ? 'платежа' : 'платежей'}</div>
        <div class="split">
          <span>Налог ≈<b>${money(tTotal)}</b></span>
          <span>На руки ≈<b>${money(sel.v - tTotal)}</b></span>
          <span>Ставка<b>${sel.v ? `${((tTotal / sel.v) * 100).toFixed(1)}%` : '—'}</b></span>
        </div>
      </section>
      <div class="chart"><div class="chart-title">Налоги с этого дохода<span>${money(tTotal)}</span></div>
        ${bars([
          { label: 'Федеральный подоходный', v: t.fed },
          ...(t.se >= 1 ? [{ label: 'Самозанятость', v: t.se }] : []),
          ...(plan.hasState ? [{ label: `Штат ${esc(plan.state?.code ?? '')}`, v: t.st }] : []),
        ])}
        <div class="fine" style="text-align:left;margin-top:10px">Доля от годового налога пропорционально доходу; расходы делятся на всех.</div></div>
      <div class="chart"><div class="chart-title">По месяцам<span></span></div>${months(p, (x) => clientKey(x) === sel.key)}</div>`;
  }
  return `${pick}${body}${feed(p, { cols: ['incomes'], pred: (x) => !sel || clientKey(x) === sel.key, title: sel ? 'Платежи' : `Доходы ${p.year}`, totals: false })}
    <div class="actions" style="grid-template-columns:1fr"><button class="btn" data-act="income">＋ Доход</button></div>`;
}

function expenseView(p) {
  const y = String(p.year);
  const exps = (data.expenses ?? []).filter((x) => x.date?.startsWith(y));
  const byCat = new Map();
  for (const x of exps) { const k = EXPENSE_CATEGORIES.find((c) => c.id === x.category)?.label ?? 'Другое'; byCat.set(k, (byCat.get(k) ?? 0) + (Number(x.amount) || 0)); }
  const cats = [...byCat].map(([label, v]) => ({ label, v })).sort((a, b) => b.v - a.v);
  const catTotal = cats.reduce((t, r) => t + r.v, 0);
  const recRows = (data.recurring ?? []).map((r) => ({ label: r.note || EXPENSE_CATEGORIES.find((c) => c.id === r.category)?.label || 'Трата', v: Number(r.amount) || 0, note: accName(r.accountId) })).sort((a, b) => b.v - a.v);
  const recTotal = recRows.reduce((t, r) => t + r.v, 0);
  return `<div class="split totals">
      <span>Расходы за ${p.year}<b>${money(catTotal)}</b></span>
      <span>Постоянные<b>${money(recTotal)}/мес</b></span>
    </div>
    ${recRows.length ? `<div class="chart"><div class="chart-title">Постоянные траты<span>${money(recTotal)}/мес</span></div>${bars(recRows)}<div class="fine" style="text-align:left;margin-top:10px">≈ ${money(recTotal * 12)} в год · остановить — в настройках</div></div>` : ''}
    ${cats.length ? `<div class="chart"><div class="chart-title">По категориям<span>${money(catTotal)}</span></div>${bars(cats)}</div>` : ''}
    ${feed(p, { cols: ['expenses'], title: `Расходы ${p.year}`, totals: false })}
    <div class="actions" style="grid-template-columns:1fr"><button class="btn" data-act="expense">＋ Расход</button></div>`;
}

function taxView(p, plan) {
  const a = plan.annual;
  const st = plan.state?.code ?? '';
  const taxes = [
    { label: 'Федеральный подоходный', v: a.incomeTax + a.addlMedicare },
    { label: 'Самозанятость (соцстрах + Medicare)', v: a.seTax },
    { label: `Штат ${st}`, v: a.state, note: plan.hasState ? '' : 'в этом штате нет подоходного налога' },
    ...(a.local ? [{ label: 'Город', v: a.local }] : []),
  ].filter((r) => r.v >= 1 || r.note);
  const paidFed = plan.paid.fed + plan.withheld.fed;
  const paidSt = plan.paid.state + plan.withheld.state;
  return `<div class="split totals">
      <span>Налог за ${p.year}<b>${money(a.total)}</b></span>
      <span>Оплачено<b class="ok">${money(paidFed + paidSt)}</b></span>
      <span>Осталось<b>${money(Math.max(0, plan.balance.total))}</b></span>
    </div>
    <div class="chart"><div class="chart-title">Налоги за год<span>${money(a.total)}</span></div>${bars(taxes)}
      <div class="fine" style="text-align:left;margin-top:10px">Оплачено: IRS ${money(paidFed)}${plan.hasState ? ` · штат ${money(paidSt)}` : ''}</div></div>
    ${more(plan).replace('<details class="more">', '<details class="more open-default">')}
    ${feed(p, { cols: ['payments'], title: `Платежи налогов ${p.year}`, totals: false })}
    <div class="actions" style="grid-template-columns:1fr"><button class="btn" data-act="pay">Оплатил налог</button></div>`;
}

const STATUS_TEXT = { covered: 'оплачен', late: 'оплачен', upcoming: '', soon: 'скоро', overdue: 'просрочен' };

function more(plan) {
  const a = plan.annual;
  const proj = plan.paceFactor > 1.001;
  const qs = plan.quarters.map((q) => `
    <div class="q ${q.status}">
      <div class="qn">Q${q.q}</div>
      <div class="qd">${shortDate(q.due)}</div>
      <div class="qa">${q.toPay.total >= 1 ? money(q.toPay.total) : '✓'}</div>
      <div class="qd">${STATUS_TEXT[q.status]}</div>
    </div>`).join('');
  const line = (label, v, cls = '') => `<div class="line ${cls}"><span>${label}</span><b>${v}</b></div>`;
  return `<details class="more">
    <summary>Подробнее: кварталы и расчёт</summary>
    <div class="more-body">
      <div class="quarters">${qs}</div>
      <div class="lines">
        ${line(`Прибыль${proj ? ' (прогноз на год)' : ''}`, money(plan.projected.seNet + plan.projected.wages))}
        ${line('Федеральный подоходный', money(a.incomeTax))}
        ${a.seTax ? line('Self-employment (соцстрах + Medicare)', money(a.seTax)) : ''}
        ${a.addlMedicare ? line('Доп. Medicare', money(a.addlMedicare)) : ''}
        ${plan.hasState ? line(`Штат ${esc(plan.state?.code ?? '')}`, money(a.stateTotal)) : ''}
        ${line('Всего за год', money(a.total), 'total')}
        ${line('Эффективная ставка', `${(a.effective * 100).toFixed(1)}%`)}
      </div>
      <div class="fine">Оценка, не налоговая консультация. Оплатить: <a href="https://www.irs.gov/payments/direct-pay" target="_blank" rel="noopener">IRS Direct Pay</a></div>
    </div>
  </details>`;
}

const accName = (id) => {
  const a = (data?.accounts ?? []).find((x) => x.id === id);
  return a ? `${a.name}${a.last4 ? ` ••${a.last4}` : ''}` : '';
};
// Same name regardless of case, spaces or invisible characters ("PayPal" = "pay pal\u200b").
const nameKey = (n) => String(n ?? '').normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200d\ufeff]+/g, '');
const clientName = (x) => (data?.clients ?? []).find((c) => c.id === x.clientId)?.name || x.source || '';

// ───────────── sheets ─────────────
function openSheet(title, body, onSubmit) {
  $('#sheet-body').innerHTML = `
    <form class="sheet-in" id="sheet-form" autocomplete="off">
      <div class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn" data-act="close" aria-label="Закрыть">✕</button></div>
      ${body}
    </form>`;
  const form = $('#sheet-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    // Once only, and close right away: Firestore shows the write locally at once,
    // but its promise waits for the server — that wait used to invite repeat taps.
    if (form._busy) return;
    form._busy = true;
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const values = Object.fromEntries(new FormData(form).entries());
    sheet.close();
    try { await onSubmit(values, form); } catch (e) { alert(`Не сохранилось: ${e?.message ?? e}`); }
  });
  sheet.showModal();
  setTimeout(() => form.querySelector('.amount-input')?.focus(), 30);
}

// A select over a small named list (accounts, clients) with an inline "+ new…" entry.
function pickSelect({ name, label, list, selected, empty, newLabel, placeholder, newValue = '' }) {
  const asNew = Boolean(newValue && !selected);
  return `<label class="field">${label}
    <select name="${name}" data-new="${name}New">
      <option value="">${empty}</option>
      ${list.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}${a.last4 ? ` ••${esc(a.last4)}` : ''}</option>`).join('')}
      <option value="__new"${asNew ? ' selected' : ''}>${newLabel}</option>
    </select></label>
    <input name="${name}New" placeholder="${placeholder}" value="${esc(newValue)}"${asNew ? '' : ' hidden'}>`;
}

const accountSelect = (selected = recall('last-account')) => pickSelect({
  name: 'accountId', label: 'Счёт', list: data.accounts ?? [], selected,
  empty: 'Без счёта', newLabel: '+ Новый счёт…', placeholder: 'Название счёта (Chase, Stripe…)',
});
const clientSelect = (selected = '', newValue = '') => pickSelect({
  name: 'clientId', label: 'Заказчик', list: data.clients ?? [], selected,
  empty: 'Не указан', newLabel: '+ Новый заказчик…', placeholder: 'Имя заказчика', newValue,
});

async function resolvePick(col, value, newName, extra = {}) {
  if (value !== '__new') return value || '';
  const name = (newName || '').trim();
  if (!name) return '';
  const same = (data[col] ?? []).find((a) => nameKey(a.name) === nameKey(name));
  if (same) return same.id;
  const id = crypto.randomUUID();
  await store.put(col, id, { name, ...extra });
  return id;
}
async function resolveAccount(r) {
  const id = await resolvePick('accounts', r.accountId, r.accountIdNew, { type: 'bank', last4: '' });
  remember('last-account', id);
  return id;
}

const amountField = (value = '') =>
  `<input class="amount-input" name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="$0" value="${value}" required>`;

// Bottom of every sheet: "Add" for a new record; "Save" + "Delete" when editing one.
const sheetButtons = (col, x) => x
  ? `<button class="btn primary block" type="submit">Сохранить</button>
     <button class="btn danger block" type="button" data-act="del-item" data-col="${col}" data-id="${esc(x.id)}">Удалить</button>`
  : '<button class="btn primary block" type="submit">Добавить</button>';

// New record → add; existing → replace it, keeping fields this form doesn't know about.
async function save(col, x, rec) {
  if (!x) return store.add(col, rec);
  const { id, ...rest } = x;
  return store.put(col, id, { ...rest, ...rec });
}

function incomeSheet(x) {
  const mode = profile().workMode;
  const type = x?.type || (mode === 'w2' ? 'w2' : 'se');
  openSheet('Доход', `
    ${amountField(x?.amount ?? '')}
    <label class="field">Дата<input name="date" type="date" value="${x?.date ?? todayIso()}" required></label>
    ${clientSelect(x?.clientId ?? '', x?.clientId ? '' : (x?.source ?? ''))}
    ${accountSelect(x ? x.accountId : undefined)}
    <div class="seg"><label><input type="radio" name="type" value="se"${type === 'se' ? ' checked' : ''}>1099 / самозанятость</label><label><input type="radio" name="type" value="w2"${type === 'w2' ? ' checked' : ''}>Зарплата W-2</label></div>
    <div class="row2 w2"${type === 'w2' ? '' : ' hidden'}>
      <label class="field">Удержано IRS<input name="fedWithheld" type="number" inputmode="decimal" step="0.01" min="0" placeholder="$0" value="${x?.fedWithheld || ''}"></label>
      <label class="field">Удержано штатом<input name="stateWithheld" type="number" inputmode="decimal" step="0.01" min="0" placeholder="$0" value="${x?.stateWithheld || ''}"></label>
    </div>
    ${sheetButtons('incomes', x)}`, async (r) => {
    const accountId = await resolveAccount(r);
    const clientId = await resolvePick('clients', r.clientId, r.clientIdNew);
    await save('incomes', x, {
      date: r.date, amount: amt(r.amount), accountId, clientId, source: '', type: r.type || 'se',
      fedWithheld: r.type === 'w2' ? amt(r.fedWithheld) : 0, stateWithheld: r.type === 'w2' ? amt(r.stateWithheld) : 0,
    });
  });
}

function expenseSheet(x) {
  const cat = x?.category || recall('last-cat') || 'software';
  openSheet('Расход', `
    ${amountField(x?.amount ?? '')}
    <label class="field">На что<select name="category">${opts(CATS, cat)}</select></label>
    <div class="row2">
      <label class="field">Дата<input name="date" type="date" value="${x?.date ?? todayIso()}" required></label>
      <label class="field">Заметка<input name="note" placeholder="необязательно" value="${esc(x?.note ?? '')}"></label>
    </div>
    ${accountSelect(x ? x.accountId : undefined)}
    ${x ? (x.recurringId ? '<div class="fine" style="text-align:left">↻ Постоянная трата — остановить можно в настройках.</div>' : '') : '<label class="check"><input type="checkbox" name="monthly"> Каждый месяц (подписка, аренда…)</label>'}
    <div class="field">Чек
      <div class="receipt" id="receipt">
        ${x?.hasReceipt ? '<span class="dim">Загрузка…</span>' : ''}
        <label class="btn receipt-add"${x?.hasReceipt ? ' hidden' : ''}>📎 Прикрепить фото или PDF<input type="file" name="receiptFile" accept="image/*,application/pdf" hidden></label>
      </div>
    </div>
    ${sheetButtons('expenses', x)}`, async (r, form) => {
    const accountId = await resolveAccount(r);
    if (!x) remember('last-cat', r.category);
    const rec = { date: r.date, amount: amt(r.amount), category: r.category, accountId, note: (r.note || '').trim() };
    const pending = form._receipt; // undefined = unchanged, null = removed, object = new
    if (pending !== undefined) rec.hasReceipt = Boolean(pending);
    let id = x?.id ?? crypto.randomUUID();
    if (!x && r.monthly) {
      // A monthly rule; this record is its first month, sync() adds the following ones.
      const rid = crypto.randomUUID();
      const ym = r.date.slice(0, 7);
      await store.put('recurring', rid, { ...rec, day: Number(r.date.slice(8, 10)), start: ym, last: ym });
      id = `${rid}-${ym}`;
      rec.recurringId = rid;
    }
    if (pending) await store.saveReceipt(id, pending);
    else if (pending === null && x?.hasReceipt) await store.deleteReceipt(id);
    if (x) await save('expenses', x, rec);
    else await store.put('expenses', id, rec);
  });
  const form = $('#sheet-form');
  const box = $('#receipt');
  const show = (rc) => {
    box.querySelector('.receipt-view')?.remove();
    box.querySelector('.dim')?.remove();
    box.querySelector('.receipt-add').hidden = Boolean(rc);
    if (!rc) return;
    box.insertAdjacentHTML('afterbegin', `<div class="receipt-view">
      ${rc.type === 'application/pdf' ? '<span class="pdf">PDF</span>' : `<img src="${rc.data}" alt="Чек">`}
      <span class="t">${esc(rc.name || 'Чек')}</span>
      <button type="button" class="btn link" data-act="receipt-open">Открыть</button>
      <button type="button" class="icon-btn" data-act="receipt-del" aria-label="Убрать чек">✕</button></div>`);
    form._shown = rc;
  };
  form._show = show;
  if (x?.hasReceipt) store.loadReceipt(x.id).then((rc) => show(rc)).catch(() => show(null));
  form.receiptFile.addEventListener('change', async () => {
    const f = form.receiptFile.files[0];
    if (!f) return;
    try { const rc = await readReceipt(f); form._receipt = rc; show(rc); }
    catch (e) { alert(String(e.message ?? e)); }
    form.receiptFile.value = '';
  });
}

// Photo → JPEG ≤1600px, shrunk until it fits a Firestore doc; small PDFs as is.
const RECEIPT_MAX = 900_000; // data-URL chars (Firestore doc limit is 1 MiB)
async function readReceipt(file) {
  const asUrl = (b) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
  const meta = { name: file.name, createdAt: new Date().toISOString() };
  if (file.type === 'application/pdf') {
    const data = await asUrl(file);
    if (data.length > RECEIPT_MAX) throw new Error('PDF больше ~650 КБ — сфотографируй чек или сожми PDF.');
    return { ...meta, type: file.type, data };
  }
  const img = await createImageBitmap(file);
  for (const [side, q] of [[1600, 0.75], [1280, 0.7], [1024, 0.6], [800, 0.55]]) {
    const k = Math.min(1, side / Math.max(img.width, img.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', q);
    if (data.length <= RECEIPT_MAX) return { ...meta, type: 'image/jpeg', data };
  }
  throw new Error('Не удалось сжать фото.');
}

// Q4 and the return are paid in the next calendar year (Jan / Apr).
function taxYearOfPayment(date, quarter) {
  const y = Number(date.slice(0, 4));
  return (quarter === 4 || quarter === 0) && Number(date.slice(5, 7)) <= 4 ? y - 1 : y;
}

function paySheet(x) {
  const plan = currentPlan();
  const n = plan.next;
  const fed = n ? n.toPay.fed : 0;
  const st = n ? n.toPay.state : 0;
  const kind = x?.kind || (fed >= 1 || !plan.hasState ? 'federal' : 'state');
  const q = x ? Number(x.quarter) || 0 : (n ? n.q : 0);
  const qOpts = [[1, 'Q1'], [2, 'Q2'], [3, 'Q3'], [4, 'Q4'], [0, 'Декларация']];
  openSheet(x ? 'Платёж' : 'Оплатил налог', `
    ${plan.hasState || kind === 'state' ? `<div class="seg"><label><input type="radio" name="kind" value="federal"${kind === 'federal' ? ' checked' : ''}>IRS</label><label><input type="radio" name="kind" value="state"${kind === 'state' ? ' checked' : ''}>Штат ${esc(plan.state?.code ?? '')}</label></div>` : '<input type="hidden" name="kind" value="federal">'}
    ${amountField(x ? x.amount : (kind === 'federal' ? fed : st).toFixed(2))}
    <div class="row2">
      <label class="field">Дата<input name="date" type="date" value="${x?.date ?? todayIso()}" required></label>
      <label class="field">За что<select name="quarter">${qOpts.map(([v, l]) => `<option value="${v}"${v === q ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    ${x ? sheetButtons('payments', x) : '<button class="btn primary block" type="submit">Сохранить</button>'}`, async (r) => {
    const qq = Number(r.quarter);
    await save('payments', x, { date: r.date, amount: amt(r.amount), kind: r.kind, quarter: qq, note: x?.note ?? '', year: taxYearOfPayment(r.date, qq) });
  });
  if (x) return;
  const form = $('#sheet-form');
  form.querySelectorAll('[name=kind]').forEach((el) => el.addEventListener('change', () => {
    form.amount.value = (el.value === 'federal' ? fed : st).toFixed(2);
  }));
}

function itemSheet(col, id) {
  const x = (data[col] ?? []).find((i) => i.id === id);
  if (!x) return;
  if (col === 'incomes') incomeSheet(x);
  else if (col === 'expenses') expenseSheet(x);
  else if (col === 'payments') paySheet(x);
}

// Settings: a named list (accounts / clients) with add + remove in place.
const listRow = (col, a) => `<div class="acc"><span>${esc(a.name)}${a.last4 ? ` <span class="dim">••${esc(a.last4)}</span>` : ''}</span><button type="button" data-act="del-named" data-col="${col}" data-id="${esc(a.id)}" aria-label="Удалить">×</button></div>`;
const namedList = (col, title, list, placeholder) => `
    <div class="sub">${title}</div>
    <div class="acc-list" id="list-${col}">${list.map((a) => listRow(col, a)).join('')}</div>
    <div class="add-row"><input id="new-${col}" placeholder="${placeholder}"><button type="button" class="btn" data-act="add-named" data-col="${col}">Добавить</button></div>`;

function settingsSheet() {
  const p = profile();
  const st = stateByCode(p.state);
  const r = stateRate(p);
  const accs = data.accounts ?? [];
  openSheet('Настройки', `
    <label class="field">Штат<select name="state">${STATES.map((s) => `<option value="${s.code}"${s.code === p.state ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <span class="hint">${!st ? '' : st.kind === 'none' ? 'Без подоходного налога штата' : st.kind === 'flat' ? `Ставка ${st.rate}%` : `Ставка примерно ${r.rate}% — можно уточнить ниже`}</span></label>
    <label class="field">Как работаешь<select name="workMode">${opts(WORK_MODES, p.workMode)}</select></label>
    <label class="field">Статус подачи<select name="filingStatus">${opts(FILING_STATUSES, p.filingStatus)}</select></label>

${namedList('accounts', 'Счета', accs, 'Chase, Stripe…')}
${namedList('clients', 'Заказчики', data.clients ?? [], 'Имя заказчика')}
${(data.recurring ?? []).length ? `<div class="sub">Постоянные траты</div>
    <div class="acc-list">${data.recurring.map((r) => listRow('recurring', { id: r.id, name: `${r.note || EXPENSE_CATEGORIES.find((c) => c.id === r.category)?.label || 'Трата'} · ${money(r.amount)}/мес` })).join('')}</div>
    <div class="fine" style="text-align:left">× — остановить. Уже списанные месяцы останутся.</div>` : ''}

    <details class="more" style="background:none;border:0">
      <summary style="padding:10px 0">Точнее расчёт</summary>
      <div class="more-body" style="padding:0 0 4px;gap:12px">
        <div class="row2">
          <label class="field">Своя ставка штата, %<input name="stateRateOverride" type="number" step="0.01" min="0" max="20" value="${esc(p.stateRateOverride ?? '')}" placeholder="${st?.rate ?? ''}"></label>
          <label class="field">Город, %<input name="localRate" type="number" step="0.001" min="0" max="10" value="${esc(p.localRate ?? '')}" placeholder="0"></label>
        </div>
        <label class="field">Налог за прошлый год (IRS)<input name="priorYearTax" type="number" step="1" min="0" value="${esc(p.priorYearTax ?? '')}" placeholder="уменьшит квартальные платежи"></label>
        <label class="check"><input type="checkbox" name="priorAgiHigh"${p.priorAgiHigh ? ' checked' : ''}> Доход прошлого года больше $150k</label>
        <label class="field">Год<select name="year">${[2025, 2026, 2027].map((y) => `<option${y === p.year ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
      </div>
    </details>

    <button class="btn primary block" type="submit">Сохранить</button>
    ${store.mode === 'cloud' ? `<button class="btn link" type="button" data-act="signout">Выйти${user?.email ? ` · ${esc(user.email)}` : ''}</button>` : ''}`, async (v, form) => {
    await store.setProfile({
      state: v.state, workMode: v.workMode, filingStatus: v.filingStatus,
      stateRateOverride: v.stateRateOverride ?? '', localRate: v.localRate ?? '',
      priorYearTax: v.priorYearTax ?? '', priorAgiHigh: form.priorAgiHigh.checked, year: Number(v.year),
    });
  });
}

// ───────────── events ─────────────
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset?.actChange === 'client') { clientSel = el.value; render(); return; }
  const extra = el.dataset?.new && el.form?.elements[el.dataset.new];
  if (extra) {
    extra.hidden = el.value !== '__new';
    if (!extra.hidden) extra.focus();
  }
  if (el.name === 'type' && el.form?.querySelector('.w2')) el.form.querySelector('.w2').hidden = el.value !== 'w2';
});

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'signin') {
    try { await signIn(); } catch (e) { if (e?.code !== 'auth/popup-closed-by-user') gate(null, String(e?.message ?? e)); }
  } else if (act === 'signout') { sheet.close(); await signOut(); }
  else if (act === 'reload') location.reload();
  else if (act === 'tab') { tab = b.dataset.tab; remember('tab', tab); showAll = false; render(); scrollTo(0, 0); }
  else if (act === 'client') { clientSel = b.dataset.key; render(); scrollTo(0, 0); }
  else if (act === 'receipt-del') { const f = $('#sheet-form'); f._receipt = null; f._show(null); }
  else if (act === 'receipt-open') {
    // Synchronous, so the new tab still counts as a user gesture (Safari).
    const rc = $('#sheet-form')._shown;
    const [head, b64] = rc.data.split(',');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    window.open(URL.createObjectURL(new Blob([bytes], { type: head.slice(5).split(';')[0] })), '_blank');
  } else if (act === 'month') {
    const t = b.closest('.chart').querySelector('.chart-title span');
    t.textContent = b.dataset.label;
  }
  else if (act === 'close') sheet.close();
  else if (act === 'settings') settingsSheet();
  else if (act === 'income') incomeSheet();
  else if (act === 'expense') expenseSheet();
  else if (act === 'pay') paySheet();
  else if (act === 'open-item') itemSheet(b.dataset.col, b.dataset.id);
  else if (act === 'toggle-all') { showAll = !showAll; render(); }
  else if (act === 'ack') await store.update('events', b.dataset.id, { status: 'read', updatedAt: new Date().toISOString() });
  else if (act === 'del-item') {
    if (!confirm('Удалить запись?')) return;
    sheet.close();
    const x = (data[b.dataset.col] ?? []).find((i) => i.id === b.dataset.id);
    if (x?.hasReceipt) await store.deleteReceipt(x.id).catch(() => {});
    await store.remove(b.dataset.col, b.dataset.id);
  } else if (act === 'del-named') { await store.remove(b.dataset.col, b.dataset.id); b.closest('.acc').remove(); }
  else if (act === 'add-named') {
    const col = b.dataset.col;
    const input = $(`#new-${col}`);
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const id = crypto.randomUUID();
    await store.put(col, id, col === 'accounts' ? { name, type: 'bank', last4: '' } : { name });
    $(`#list-${col}`).insertAdjacentHTML('beforeend', listRow(col, { id, name }));
    input.value = '';
    input.focus();
  }
  else if (act === 'welcome-done') {
    const state = $('#w-state').value;
    if (!state) { $('#w-state').focus(); return; }
    await store.setProfile({ state, workMode: $('#w-mode').value, year: Number(todayIso().slice(0, 4)) });
  }
});

// Enter in an "add account / client" field adds it instead of submitting settings.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || !ev.target.id?.startsWith('new-')) return;
  ev.preventDefault();
  ev.target.nextElementSibling?.click();
});

sheet.addEventListener('click', (ev) => { if (ev.target === sheet) sheet.close(); });
window.addEventListener('online', syncDot);
window.addEventListener('offline', syncDot);
setInterval(() => { if (data && !sheet.open) { render(); sync(); } }, 15 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data && !sheet.open) { render(); sync(); } });

boot();
