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
  root.innerHTML = hero(plan) + notes() + actions(p) + feed(p) + more(plan);
}

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

function feed(p) {
  const y = String(p.year);
  const items = [
    ...(data.incomes ?? []).filter((x) => x.date?.startsWith(y)).map((x) => ({ col: 'incomes', x, g: 'in', icon: '↓', title: x.source || 'Доход', sub: accName(x.accountId), amount: `+${money(x.amount)}`, cls: 'ok' })),
    ...(data.expenses ?? []).filter((x) => x.date?.startsWith(y)).map((x) => ({ col: 'expenses', x, g: 'out', icon: '↑', title: EXPENSE_CATEGORIES.find((c) => c.id === x.category)?.label ?? 'Расход', sub: x.note || accName(x.accountId), amount: `−${money(x.amount)}`, cls: '' })),
    ...(data.payments ?? []).filter((x) => Number(x.year ?? x.date?.slice(0, 4)) === p.year).map((x) => ({ col: 'payments', x, g: 'tax', icon: '✓', title: `Налог ${x.kind === 'state' ? 'штату' : 'IRS'}`, sub: Number(x.quarter) ? `Q${x.quarter}` : 'декларация', amount: money(x.amount), cls: 'dim' })),
  ].sort((a, b) => (b.x.date ?? '').localeCompare(a.x.date ?? ''));
  const list = showAll ? items : items.slice(0, 6);
  return `<section>
    <div class="section-title"><span>Записи ${p.year}</span>${items.length > 6 ? `<button class="btn link" style="padding:0;font-size:11px" data-act="toggle-all">${showAll ? 'Свернуть' : `Все ${items.length}`}</button>` : ''}</div>
    <div class="feed">${list.length ? list.map((i) => `
      <button class="item" data-act="open-item" data-col="${i.col}" data-id="${esc(i.x.id)}">
        <span class="glyph ${i.g}">${i.icon}</span>
        <span class="t"><div>${esc(i.title)}</div><small>${shortDate(i.x.date)}${i.sub ? ` · ${esc(i.sub)}` : ''}</small></span>
        <span class="a ${i.cls}">${i.amount}</span>
      </button>`).join('') : '<div class="empty">Пока пусто. Добавь первый доход.</div>'}</div>
  </section>`;
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
    await onSubmit(Object.fromEntries(new FormData(form).entries()), form);
    sheet.close();
  });
  sheet.showModal();
  setTimeout(() => form.querySelector('.amount-input')?.focus(), 30);
}

const accountSelect = () => {
  const accs = data.accounts ?? [];
  const last = recall('last-account');
  return `<label class="field">Счёт
    <select name="accountId">
      <option value="">Без счёта</option>
      ${accs.map((a) => `<option value="${esc(a.id)}"${a.id === last ? ' selected' : ''}>${esc(a.name)}${a.last4 ? ` ••${esc(a.last4)}` : ''}</option>`).join('')}
      <option value="__new">+ Новый счёт…</option>
    </select></label>
    <input name="newAccount" placeholder="Название счёта (Chase, Stripe…)" hidden>`;
};

async function resolveAccount(r) {
  if (r.accountId !== '__new') { remember('last-account', r.accountId); return r.accountId; }
  const name = (r.newAccount || '').trim();
  if (!name) return '';
  const id = crypto.randomUUID();
  await store.put('accounts', id, { name, type: 'bank', last4: '' });
  remember('last-account', id);
  return id;
}

const amountField = (value = '') =>
  `<input class="amount-input" name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="$0" value="${value}" required>`;

function incomeSheet() {
  const mode = profile().workMode;
  openSheet('Доход', `
    ${amountField()}
    <div class="row2">
      <label class="field">Дата<input name="date" type="date" value="${todayIso()}" required></label>
      <label class="field">От кого<input name="source" placeholder="необязательно"></label>
    </div>
    ${accountSelect()}
    ${mode === 'mixed' ? '<div class="seg"><label><input type="radio" name="type" value="se" checked>1099</label><label><input type="radio" name="type" value="w2">Зарплата W-2</label></div>' : `<input type="hidden" name="type" value="${mode === 'w2' ? 'w2' : 'se'}">`}
    <div class="row2 w2"${mode === 'w2' ? '' : ' hidden'}>
      <label class="field">Удержано IRS<input name="fedWithheld" type="number" inputmode="decimal" step="0.01" min="0" placeholder="$0"></label>
      <label class="field">Удержано штатом<input name="stateWithheld" type="number" inputmode="decimal" step="0.01" min="0" placeholder="$0"></label>
    </div>
    <button class="btn primary block" type="submit">Добавить</button>`, async (r) => {
    const accountId = await resolveAccount(r);
    await store.add('incomes', {
      date: r.date, amount: amt(r.amount), accountId, source: (r.source || '').trim(), type: r.type || 'se',
      ...(r.type === 'w2' ? { fedWithheld: amt(r.fedWithheld), stateWithheld: amt(r.stateWithheld) } : {}),
    });
  });
}

function expenseSheet() {
  const last = recall('last-cat') || 'software';
  openSheet('Расход', `
    ${amountField()}
    <label class="field">На что<select name="category">${opts(CATS, last)}</select></label>
    <div class="row2">
      <label class="field">Дата<input name="date" type="date" value="${todayIso()}" required></label>
      <label class="field">Заметка<input name="note" placeholder="необязательно"></label>
    </div>
    ${accountSelect()}
    <button class="btn primary block" type="submit">Добавить</button>`, async (r) => {
    const accountId = await resolveAccount(r);
    remember('last-cat', r.category);
    await store.add('expenses', { date: r.date, amount: amt(r.amount), category: r.category, accountId, note: (r.note || '').trim() });
  });
}

// Q4 and the return are paid in the next calendar year (Jan / Apr).
function taxYearOfPayment(date, quarter) {
  const y = Number(date.slice(0, 4));
  return (quarter === 4 || quarter === 0) && Number(date.slice(5, 7)) <= 4 ? y - 1 : y;
}

function paySheet() {
  const plan = currentPlan();
  const n = plan.next;
  const fed = n ? n.toPay.fed : 0;
  const st = n ? n.toPay.state : 0;
  const kind = fed >= 1 || !plan.hasState ? 'federal' : 'state';
  openSheet('Оплатил налог', `
    ${plan.hasState ? `<div class="seg"><label><input type="radio" name="kind" value="federal"${kind === 'federal' ? ' checked' : ''}>IRS</label><label><input type="radio" name="kind" value="state"${kind === 'state' ? ' checked' : ''}>Штат ${esc(plan.state?.code ?? '')}</label></div>` : '<input type="hidden" name="kind" value="federal">'}
    ${amountField((kind === 'federal' ? fed : st).toFixed(2))}
    <label class="field">Дата<input name="date" type="date" value="${todayIso()}" required></label>
    <input type="hidden" name="quarter" value="${n ? n.q : 0}">
    <button class="btn primary block" type="submit">Сохранить</button>`, async (r) => {
    const q = Number(r.quarter);
    await store.add('payments', { date: r.date, amount: amt(r.amount), kind: r.kind, quarter: q, note: '', year: taxYearOfPayment(r.date, q) });
  });
  const form = $('#sheet-form');
  form.querySelectorAll('[name=kind]').forEach((el) => el.addEventListener('change', () => {
    form.amount.value = (el.value === 'federal' ? fed : st).toFixed(2);
  }));
}

function itemSheet(col, id) {
  const x = (data[col] ?? []).find((i) => i.id === id);
  if (!x) return;
  const title = col === 'incomes' ? 'Доход' : col === 'expenses' ? 'Расход' : 'Платёж';
  const what = col === 'incomes' ? (x.source || '') : col === 'expenses' ? (EXPENSE_CATEGORIES.find((c) => c.id === x.category)?.label ?? '') : (x.kind === 'state' ? 'Штат' : 'IRS');
  const acc = accName(x.accountId);
  openSheet(title, `
    <div class="big" style="text-align:center;font-size:36px">${money(x.amount)}</div>
    <div class="when" style="text-align:center">${longDate(x.date)}${what ? ` · ${esc(what)}` : ''}${acc ? ` · ${esc(acc)}` : ''}</div>
    <button class="btn danger block" type="submit">Удалить</button>`, async () => { await store.remove(col, id); });
}

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

    <div class="sub">Счета</div>
    <div class="acc-list">${accs.length ? accs.map((a) => `<div class="acc"><span>${esc(a.name)}${a.last4 ? ` <span class="dim">••${esc(a.last4)}</span>` : ''}</span><button type="button" data-act="del-acc" data-id="${esc(a.id)}" aria-label="Удалить">×</button></div>`).join('') : '<div class="fine" style="text-align:left">Счета добавляются прямо при вводе дохода.</div>'}</div>

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
  if (el.name === 'accountId' && el.form?.newAccount) {
    el.form.newAccount.hidden = el.value !== '__new';
    if (!el.form.newAccount.hidden) el.form.newAccount.focus();
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
  else if (act === 'close') sheet.close();
  else if (act === 'settings') settingsSheet();
  else if (act === 'income') incomeSheet();
  else if (act === 'expense') expenseSheet();
  else if (act === 'pay') paySheet();
  else if (act === 'open-item') itemSheet(b.dataset.col, b.dataset.id);
  else if (act === 'toggle-all') { showAll = !showAll; render(); }
  else if (act === 'ack') await store.update('events', b.dataset.id, { status: 'read', updatedAt: new Date().toISOString() });
  else if (act === 'del-acc') { await store.remove('accounts', b.dataset.id); b.closest('.acc').remove(); }
  else if (act === 'welcome-done') {
    const state = $('#w-state').value;
    if (!state) { $('#w-state').focus(); return; }
    await store.setProfile({ state, workMode: $('#w-mode').value, year: Number(todayIso().slice(0, 4)) });
  }
});

sheet.addEventListener('click', (ev) => { if (ev.target === sheet) sheet.close(); });
window.addEventListener('online', syncDot);
window.addEventListener('offline', syncDot);
setInterval(() => { if (data && !sheet.open) { render(); sync(); } }, 15 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data && !sheet.open) { render(); sync(); } });

boot();
