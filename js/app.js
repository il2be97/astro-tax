import { LocalStore, CloudStore, cloudConfigured, initCloud, watchAuth, signIn, signOut } from './store.js';
import { plan as buildPlan, todayIso, parseIso } from './tax/schedule.js';
import { desiredEvents, eventOps } from './tax/sync.js';
import { FILING_STATUSES, WORK_MODES, EXPENSE_CATEGORIES, ACCOUNT_TYPES } from './tax/rules.js';
import { STATES, stateByCode, stateRate } from './tax/states.js';

// ───────────────────────── helpers ─────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cents = false) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return `${v < 0 ? '−' : ''}$${s}`;
};
const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
const ruDate = (s, opts = { day: 'numeric', month: 'short' }) => parseIso(s).toLocaleDateString('ru-RU', { ...opts, timeZone: 'UTC' });
const shortDate = (s) => parseIso(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const options = (list, value, key = 'id', label = 'label') =>
  list.map((o) => `<option value="${esc(o[key])}"${String(o[key]) === String(value ?? '') ? ' selected' : ''}>${esc(o[label])}</option>`).join('');
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const plural = (n, one, few, many) => {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

// ───────────────────────── state ─────────────────────────
let store = null;
let data = null;
let user = null;
let lastSync = null;          // Date of the last sync in this session
let prevSyncedAt = null;      // profile.syncedAt seen at start → "since last visit"
let unwatch = null;
let syncing = false;

const root = $('#root');

// ───────────────────────── boot ─────────────────────────
async function boot() {
  if (!cloudConfigured()) {
    start(new LocalStore());
    return;
  }
  renderGate('Подключение…');
  try {
    await initCloud();
  } catch (e) {
    renderGate('Не удалось загрузить Firebase. Проверь сеть.', String(e?.message ?? e));
    return;
  }
  await watchAuth((u) => {
    user = u;
    if (unwatch) { unwatch(); unwatch = null; }
    prevSyncedAt = null;
    lastSync = null;
    if (!u) { store = null; renderWho(); renderGate(null); return; }
    start(new CloudStore(u.uid));
  });
}

function start(s) {
  store = s;
  data = null;
  shellBuilt = false;
  renderWho();
  unwatch = store.watch((snap, err) => {
    if (err) { renderGate('Нет доступа к данным.', String(err?.message ?? err)); return; }
    data = snap;
    if (prevSyncedAt === null) prevSyncedAt = snap.profile?.syncedAt ?? '';
    render();
    sync();
  });
}

// ───────────────────────── sync (the tax clock) ─────────────────────────
async function sync() {
  if (syncing || !data || !data.profile?.state) return;
  syncing = true;
  try {
    const today = todayIso();
    const p = buildPlan(data, profileWithDefaults(), today);
    const now = new Date().toISOString();
    const ops = eventOps(data.events, desiredEvents(p, today), now);
    for (const o of ops) {
      if (o.op === 'set') await store.put('events', o.id, o.data);
      else await store.update('events', o.id, o.data);
    }
    const stale = !data.profile.syncedAt || Date.now() - Date.parse(data.profile.syncedAt) > 10 * 60 * 1000;
    if (ops.length || stale) await store.setProfile({ syncedAt: now });
    lastSync = new Date();
    renderClock();
  } finally {
    syncing = false;
  }
}

function profileWithDefaults() {
  const p = data?.profile ?? {};
  return {
    ...p,
    filingStatus: p.filingStatus || 'single',
    workMode: p.workMode || 'self',
    projection: p.projection || 'pace',
    year: Number(p.year) || Number(todayIso().slice(0, 4)),
  };
}

// ───────────────────────── top bar ─────────────────────────
function renderWho() {
  const who = $('#who');
  if (store?.mode === 'cloud' && user) {
    who.innerHTML = `${user.photoURL ? `<img src="${esc(user.photoURL)}" alt="">` : ''}<button class="small ghost" data-act="signout">Выйти</button>`;
  } else if (store?.mode === 'local') {
    who.innerHTML = '<span class="tag dim" title="Firebase не настроен — данные только в этом браузере">локально</span>';
  } else who.innerHTML = '';
}

function renderClock() {
  const el = $('#clock');
  if (!el) return;
  const t = lastSync ? lastSync.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '——:——';
  let away = '';
  if (prevSyncedAt) {
    const days = Math.floor((Date.now() - Date.parse(prevSyncedAt)) / 86400000);
    if (days >= 1) away = `<span>Δ ${days} ${plural(days, 'день', 'дня', 'дней')}</span>`;
  }
  const dot = store?.mode === 'local' ? 'local' : data?.pending ? 'pending' : '';
  const label = store?.mode === 'local' ? 'локально' : data?.pending ? 'синхронизация' : navigator.onLine ? 'облако' : 'офлайн';
  el.innerHTML = `<span><i class="dot ${dot}"></i>${label}</span><span>синк ${t}</span>${away}`;
}

// ───────────────────────── gate ─────────────────────────
function renderGate(message, error) {
  shellBuilt = false;
  root.innerHTML = `
    <section class="gate">
      <div class="module">
        <div class="logo-mark" style="margin:0 auto">A</div>
        <h1>Astro · Tax</h1>
        <p>${esc(message ?? 'Налоговая консоль для США: сроки, суммы, вычеты. Войди — твои данные видишь только ты.')}</p>
        ${message ? '' : '<button class="primary" data-act="signin">Войти через Google</button>'}
        ${error ? `<div class="err">${esc(error)}</div>` : ''}
        <p class="hint" style="margin-top:18px">Аккаунт создаётся при первом входе.</p>
      </div>
    </section>`;
  renderClock();
}

// ───────────────────────── console shell ─────────────────────────
let shellBuilt = false;

function buildShell() {
  const today = todayIso();
  root.innerHTML = `
    <section class="cockpit" id="cockpit"></section>
    <div class="grid">
      <section class="module span-7" id="m-events">
        <div class="module-head"><span class="idx">01</span><h2>Интерком</h2><span class="meta" id="events-meta"></span></div>
        <div class="events" id="events"></div>
      </section>

      <section class="module span-5" id="m-profile">
        <div class="module-head"><span class="idx">02</span><h2>Профиль</h2><span class="meta" id="profile-meta"></span></div>
        <div id="profile-notice"></div>
        <form class="form" id="f-profile" autocomplete="off">
          <label class="field">Год<select name="year">${[2025, 2026, 2027].map((y) => `<option>${y}</option>`).join('')}</select></label>
          <label class="field">Штат<select name="state"><option value="">— выбрать —</option>${STATES.map((s) => `<option value="${s.code}">${s.code} · ${esc(s.name)}</option>`).join('')}</select></label>
          <label class="field wide">Режим работы<select name="workMode">${options(WORK_MODES, 'self')}</select></label>
          <label class="field wide">Статус подачи<select name="filingStatus">${options(FILING_STATUSES, 'single')}</select></label>
          <label class="field">Ставка штата, %<input name="stateRateOverride" type="number" step="0.01" min="0" max="20" placeholder="авто"><span class="hint" id="state-hint"></span></label>
          <label class="field">Город / округ, %<input name="localRate" type="number" step="0.001" min="0" max="10" placeholder="0"></label>
          <label class="field wide">Прогноз за год<select name="projection"><option value="pace">По темпу (год-к-дате × год)</option><option value="actual">Только внесённое</option></select></label>
          <label class="field">Налог прошлого года (фед.)<input name="priorYearTax" type="number" step="1" min="0" placeholder="для safe harbor"></label>
          <label class="field">Налог прошлого года (штат)<input name="priorYearStateTax" type="number" step="1" min="0" placeholder="необязательно"></label>
          <label class="check wide"><input type="checkbox" name="priorAgiHigh"> AGI прошлого года &gt; $150k (порог 110%)</label>
        </form>
      </section>

      <section class="module span-12" id="m-quarters">
        <div class="module-head"><span class="idx">03</span><h2>График платежей</h2><span class="meta">Form 1040-ES · штат — те же даты</span></div>
        <div class="scroll-x" id="quarters"></div>
      </section>

      <section class="module span-6" id="m-income">
        <div class="module-head"><span class="idx">04</span><h2>Доходы</h2><span class="meta" id="income-meta"></span></div>
        <form class="form" id="f-income" autocomplete="off">
          <label class="field">Дата<input name="date" type="date" value="${today}" required></label>
          <label class="field">Сумма, $<input name="amount" type="number" step="0.01" min="0" required class="num"></label>
          <label class="field">Счёт<select name="accountId" id="income-account"></select></label>
          <label class="field" id="income-type-wrap">Тип<select name="type"><option value="se">1099 / самозанятость</option><option value="w2">W-2 зарплата</option></select></label>
          <label class="field wide">Источник<input name="source" placeholder="клиент, платформа…"></label>
          <label class="field w2only">Удержано фед., $<input name="fedWithheld" type="number" step="0.01" min="0" class="num"></label>
          <label class="field w2only">Удержано штат, $<input name="stateWithheld" type="number" step="0.01" min="0" class="num"></label>
          <button class="primary" type="submit">+ Доход</button>
        </form>
        <div class="list" id="incomes"></div>
      </section>

      <section class="module span-6" id="m-expense">
        <div class="module-head"><span class="idx">05</span><h2>Списания</h2><span class="meta" id="expense-meta"></span></div>
        <div id="expense-notice"></div>
        <form class="form" id="f-expense" autocomplete="off">
          <label class="field">Дата<input name="date" type="date" value="${today}" required></label>
          <label class="field">Сумма, $<input name="amount" type="number" step="0.01" min="0" required class="num"></label>
          <label class="field wide">Категория<select name="category">${options(EXPENSE_CATEGORIES, 'software')}</select></label>
          <label class="field">Счёт<select name="accountId" id="expense-account"></select></label>
          <label class="field">Заметка<input name="note" placeholder="что это"></label>
          <button class="primary" type="submit">+ Списание</button>
        </form>
        <div class="list" id="expenses"></div>
      </section>

      <section class="module span-7" id="m-breakdown">
        <div class="module-head"><span class="idx">06</span><h2>Расклад налогов</h2><span class="meta" id="breakdown-meta"></span></div>
        <div class="scroll-x" id="breakdown"></div>
      </section>

      <section class="module span-5" id="m-payments">
        <div class="module-head"><span class="idx">07</span><h2>Платежи</h2><span class="meta" id="payments-meta"></span></div>
        <form class="form" id="f-payment" autocomplete="off">
          <label class="field">Дата<input name="date" type="date" value="${today}" required></label>
          <label class="field">Сумма, $<input name="amount" type="number" step="0.01" min="0" required class="num"></label>
          <label class="field">Куда<select name="kind"><option value="federal">IRS (федеральный)</option><option value="state">Штат</option></select></label>
          <label class="field">Квартал<select name="quarter"><option value="1">Q1</option><option value="2">Q2</option><option value="3">Q3</option><option value="4">Q4</option><option value="0">Декларация</option></select></label>
          <label class="field wide">Заметка<input name="note" placeholder="подтверждение, способ"></label>
          <button class="primary" type="submit">+ Оплата</button>
        </form>
        <div class="list" id="payments"></div>
        <p class="hint" style="margin-top:10px">Оплатить: <a href="https://www.irs.gov/payments/direct-pay" target="_blank" rel="noopener">IRS Direct Pay</a> · <a href="https://www.eftps.gov" target="_blank" rel="noopener">EFTPS</a></p>
      </section>

      <section class="module span-12" id="m-accounts">
        <div class="module-head"><span class="idx">08</span><h2>Счета</h2><span class="meta" id="accounts-meta"></span></div>
        <form class="form" id="f-account" autocomplete="off">
          <label class="field wide">Название<input name="name" required placeholder="Chase Business, Stripe…"></label>
          <label class="field">Тип<select name="type">${options(ACCOUNT_TYPES, 'bank')}</select></label>
          <label class="field">Последние 4 цифры<input name="last4" maxlength="4" inputmode="numeric" pattern="[0-9]{0,4}" class="num"></label>
          <button class="primary" type="submit">+ Счёт</button>
        </form>
        <div class="list" id="accounts"></div>
      </section>
    </div>`;
  shellBuilt = true;
  wireForms();
}

// ───────────────────────── render ─────────────────────────
function render() {
  if (!data) return;
  if (!shellBuilt) buildShell();
  const profile = profileWithDefaults();
  const today = todayIso();
  const p = buildPlan(data, profile, today);

  renderClock();
  fillProfile(profile);
  renderCockpit(p, profile, today);
  renderEvents();
  renderQuarters(p);
  renderAccounts(profile);
  renderIncomes(profile);
  renderExpenses(profile);
  renderPayments(profile);
  renderBreakdown(p, profile);
  applyMode(profile);
}

function fillProfile(profile) {
  const f = $('#f-profile');
  for (const el of f.elements) {
    if (!el.name || el === document.activeElement) continue;
    const v = profile[el.name];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v ?? '';
  }
  const st = stateByCode(profile.state);
  const r = stateRate(profile);
  $('#state-hint').textContent = !st ? '' : st.kind === 'none' ? 'нет подоходного налога' :
    st.kind === 'flat' ? `плоская ${st.rate}%` : `прогрессивная, ориентир ${st.rate}% — укажи свою`;
  $('#profile-meta').textContent = st ? `${st.code} · ${r.rate}%${r.source === 'override' ? ' (свой)' : ''}` : '';
  $('#profile-notice').innerHTML = profile.state ? '' :
    '<div class="notice">Начни отсюда: выбери штат и режим работы — после этого появятся сроки и суммы.</div>';
  $('#m-profile').classList.toggle('focus', !profile.state);
}

function applyMode(profile) {
  const mode = profile.workMode;
  const typeSel = $('#f-income [name=type]');
  if (mode === 'self') typeSel.value = 'se';
  if (mode === 'w2') typeSel.value = 'w2';
  $('#income-type-wrap').hidden = mode !== 'mixed';
  const w2 = typeSel.value === 'w2';
  document.querySelectorAll('#f-income .w2only').forEach((el) => { el.hidden = !w2; });
  $('#expense-notice').innerHTML = mode === 'w2'
    ? '<div class="notice">В режиме W-2 бизнес-списания не уменьшают налог. Корректировки (HSA/IRA и т.п.) можно внести как «Прочая корректировка AGI».</div>'
    : '';
}

function renderCockpit(p, profile, today) {
  const el = $('#cockpit');
  const st = p.state;
  const mode = WORK_MODES.find((m) => m.id === profile.workMode)?.label.split(' (')[0] ?? '';
  const n = p.next;
  const strip = `
    <div class="cockpit-strip">
      <span>${p.year} · ${st ? st.code : 'штат не выбран'} · ${esc(mode)}</span>
      <span class="actions">
        ${n ? `<button class="small primary" data-act="pay-next">Отметить оплату →</button>` : ''}
        <button class="small ghost" data-act="jump" data-to="m-income">+ доход</button>
        <button class="small ghost" data-act="jump" data-to="m-expense">+ списание</button>
      </span>
    </div>`;

  if (!profile.state) {
    el.className = 'cockpit';
    el.innerHTML = `<div class="cockpit-scene"><div><div class="kicker">Рубка</div><div class="big">$—</div><div class="when">Выбери штат в профиле, чтобы запустить расчёт.</div></div></div>${strip}`;
    return;
  }

  let headline;
  if (n) {
    const late = n.status === 'overdue';
    const days = Math.abs(n.daysLeft);
    headline = `
      <div class="kicker">${late ? 'Просрочено' : 'Следующий платёж'} · Q${n.q}</div>
      <div class="big">${money(n.toPay.total)}</div>
      <div class="when">${late ? `срок был ${ruDate(n.due, { day: 'numeric', month: 'long', year: 'numeric' })} · ${days} ${plural(days, 'день', 'дня', 'дней')} назад · пени ≈ ${money(n.penalty)}`
        : `до ${ruDate(n.due, { day: 'numeric', month: 'long', year: 'numeric' })} · ${n.daysLeft === 0 ? 'сегодня' : `через ${days} ${plural(days, 'день', 'дня', 'дней')}`}`}</div>
      <div class="split">
        <div>IRS<b>${money(n.toPay.fed)}</b></div>
        ${p.hasState ? `<div>${esc(st.code)}<b>${money(n.toPay.state)}</b></div>` : ''}
        <div>за период<b class="dim">${shortDate(n.start)}–${shortDate(n.end)}</b></div>
      </div>`;
  } else {
    const after = p.balance.total;
    headline = `
      <div class="kicker">Квартальные платежи закрыты</div>
      <div class="big">${money(Math.max(0, after))}</div>
      <div class="when">${after > 1 ? `остаток к доплате с декларацией до ${ruDate(p.returnDue, { day: 'numeric', month: 'long', year: 'numeric' })}` : 'по прогнозу ничего не должен — отлично'}</div>`;
  }

  const total = p.annual.total;
  const paid = p.paid.total + p.withheld.fed + p.withheld.state;
  const share = total > 0 ? Math.min(1, paid / total) : 0;
  el.className = `cockpit${n?.status === 'overdue' ? ' alert' : ''}`;
  el.innerHTML = `
    <div class="cockpit-scene">
      <div>${headline}</div>
      <div class="gauges">
        <div class="gauge"><span>Налог за год${p.paceFactor > 1.001 ? ' · прогноз' : ''}</span><b>${money(total)}</b></div>
        <div class="gauge"><span>Оплачено и удержано</span><b class="ok">${money(paid)}</b><div class="bar"><i style="width:${(share * 100).toFixed(1)}%"></i></div></div>
        <div class="gauge"><span>Осталось за год</span><b>${money(Math.max(0, total - paid))}</b></div>
        <div class="gauge"><span>Эффективная ставка</span><b class="dim">${pct(p.annual.effective)}</b></div>
      </div>
    </div>${strip}`;
}

function renderEvents() {
  const evs = [...(data.events ?? [])].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const open = evs.filter((e) => e.status === 'open');
  const closed = evs.filter((e) => e.status !== 'open').slice(0, 6);
  $('#events-meta').textContent = open.length ? `${open.length} активн.` : 'тихо';
  const item = (e) => `
    <div class="event ${esc(e.level)}${e.status !== 'open' ? ' closed' : ''}">
      <i></i>
      <div><h3>${esc(e.title)}</h3><p>${esc(e.body)}</p>
        <div class="when">${e.at ? ruDate(e.at, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}${e.status === 'closed' ? ' · решено' : e.status === 'read' ? ' · прочитано' : ''}</div></div>
      <div>${e.status === 'open' ? `<button class="small ghost" data-act="ack" data-id="${esc(e.id)}">Ок</button>` : ''}</div>
    </div>`;
  $('#events').innerHTML = (open.length || closed.length)
    ? open.map(item).join('') + closed.map(item).join('')
    : '<div class="empty">Событий нет. Часы налогов проверяют сроки при каждом входе и изменении.</div>';
}

const STATUS_TAG = {
  covered: '<span class="tag ok">закрыт</span>',
  late: '<span class="tag warn">закрыт с опозд.</span>',
  upcoming: '<span class="tag info">впереди</span>',
  soon: '<span class="tag warn">скоро</span>',
  overdue: '<span class="tag bad">просрочен</span>',
};

function renderQuarters(p) {
  if (!data.profile?.state) { $('#quarters').innerHTML = '<div class="empty">Нужен штат в профиле.</div>'; return; }
  const rows = p.quarters.map((q) => `
    <tr>
      <td><b>Q${q.q}</b></td>
      <td class="dim">${shortDate(q.start)}–${shortDate(q.end)}</td>
      <td class="mono">${ruDate(q.due, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
      <td class="n">${money(q.required.fed)}</td>
      ${p.hasState ? `<td class="n">${money(q.required.state)}</td>` : ''}
      <td class="n ok">${money(q.paid.fed + q.paid.state)}</td>
      <td class="n"><b>${money(q.toPay.total)}</b></td>
      <td>${STATUS_TAG[q.status]}</td>
    </tr>`).join('');
  $('#quarters').innerHTML = `
    <table>
      <thead><tr><th>Кв.</th><th>Период дохода</th><th>Срок</th><th class="n">Нужно IRS*</th>${p.hasState ? '<th class="n">Нужно штат*</th>' : ''}<th class="n">Оплачено</th><th class="n">К оплате</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint" style="margin-top:8px">* нарастающим итогом. Меньшее из: 90% налога этого года, 100/110% прошлого (если указан), метод annualized income для закрытых кварталов. Налог с декларацией: ${ruDate(p.returnDue, { day: 'numeric', month: 'long', year: 'numeric' })}.</p>`;
}

function accountName(id) {
  const a = (data.accounts ?? []).find((x) => x.id === id);
  return a ? `${a.name}${a.last4 ? ` ••${a.last4}` : ''}` : '';
}

function fillAccountSelect(sel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">—</option>${(data.accounts ?? []).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.last4 ? ` ••${esc(a.last4)}` : ''}</option>`).join('')}`;
  sel.value = (data.accounts ?? []).some((a) => a.id === cur) ? cur : (localStorage.getItem(`astro-tax/last-${sel.id}`) ?? '');
  if (![...sel.options].some((o) => o.value === sel.value)) sel.value = '';
}

const yearOf = (profile) => (e) => (e.date ?? '').startsWith(String(profile.year));
const byDateDesc = (a, b) => (b.date ?? '').localeCompare(a.date ?? '');

function renderAccounts(profile) {
  fillAccountSelect($('#income-account'));
  fillAccountSelect($('#expense-account'));
  const accs = data.accounts ?? [];
  const inc = (data.incomes ?? []).filter(yearOf(profile));
  const exp = (data.expenses ?? []).filter(yearOf(profile));
  $('#accounts-meta').textContent = `${accs.length}`;
  $('#accounts').innerHTML = accs.length ? accs.map((a) => {
    const i = inc.filter((x) => x.accountId === a.id).reduce((s, x) => s + Number(x.amount || 0), 0);
    const e = exp.filter((x) => x.accountId === a.id).reduce((s, x) => s + Number(x.amount || 0), 0);
    const type = ACCOUNT_TYPES.find((t) => t.id === a.type)?.label ?? '';
    return `<div class="row"><span class="d">${esc(type)}</span><span class="t">${esc(a.name)}${a.last4 ? `<small>••${esc(a.last4)}</small>` : ''}</span>
      <span class="a"><span class="ok">+${money(i)}</span> <span class="dim">/ −${money(e)}</span></span>
      <button class="icon" title="Удалить" data-act="del" data-col="accounts" data-id="${esc(a.id)}">×</button></div>`;
  }).join('') : '<div class="empty">Сохрани счета, куда приходят деньги — потом выбирай их при вводе.</div>';
}

function renderIncomes(profile) {
  const list = (data.incomes ?? []).filter(yearOf(profile)).sort(byDateDesc);
  const sum = list.reduce((s, x) => s + Number(x.amount || 0), 0);
  $('#income-meta').textContent = `${profile.year} · ${money(sum)}`;
  $('#incomes').innerHTML = list.length ? list.map((x) => `
    <div class="row"><span class="d">${shortDate(x.date)}</span>
      <span class="t">${esc(x.source || '—')}<small>${esc(accountName(x.accountId))}${x.type === 'w2' ? ' · W-2' : ''}</small></span>
      <span class="a ok">+${money(x.amount, true)}</span>
      <button class="icon" title="Удалить" data-act="del" data-col="incomes" data-id="${esc(x.id)}">×</button></div>`).join('')
    : '<div class="empty">Пока нет доходов за этот год.</div>';
}

function renderExpenses(profile) {
  const list = (data.expenses ?? []).filter(yearOf(profile)).sort(byDateDesc);
  const ded = list.reduce((s, x) => s + Number(x.amount || 0) * (EXPENSE_CATEGORIES.find((c) => c.id === x.category)?.pct ?? 1), 0);
  $('#expense-meta').textContent = `вычет ${money(ded)}`;
  $('#expenses').innerHTML = list.length ? list.map((x) => {
    const c = EXPENSE_CATEGORIES.find((k) => k.id === x.category);
    return `<div class="row"><span class="d">${shortDate(x.date)}</span>
      <span class="t">${esc(c?.label ?? x.category)}<small>${esc([x.note, accountName(x.accountId)].filter(Boolean).join(' · '))}</small></span>
      <span class="a">−${money(x.amount, true)}${c && c.pct < 1 ? `<small class="faint"> ×${c.pct}</small>` : ''}</span>
      <button class="icon" title="Удалить" data-act="del" data-col="expenses" data-id="${esc(x.id)}">×</button></div>`;
  }).join('') : '<div class="empty">Бизнес-расходы уменьшают и подоходный, и self-employment налог.</div>';
}

function renderPayments(profile) {
  const list = (data.payments ?? []).filter((x) => Number(x.year ?? x.date?.slice(0, 4)) === profile.year).sort(byDateDesc);
  const sum = list.reduce((s, x) => s + Number(x.amount || 0), 0);
  $('#payments-meta').textContent = `${money(sum)}`;
  $('#payments').innerHTML = list.length ? list.map((x) => `
    <div class="row"><span class="d">${shortDate(x.date)}</span>
      <span class="t">${x.kind === 'state' ? 'Штат' : 'IRS'} · ${Number(x.quarter) ? `Q${x.quarter}` : 'декларация'}<small>${esc(x.note ?? '')}</small></span>
      <span class="a">${money(x.amount, true)}</span>
      <button class="icon" title="Удалить" data-act="del" data-col="payments" data-id="${esc(x.id)}">×</button></div>`).join('')
    : '<div class="empty">Отмечай здесь каждый платёж — он закрывает кварталы и события.</div>';
}

function renderBreakdown(p, profile) {
  const a = p.annual;
  const y = p.ytdTax;
  const proj = p.paceFactor > 1.001;
  $('#breakdown-meta').textContent = p.fallback ? `по ставкам ${p.rulesYear}` : `${profile.year}`;
  const row = (label, ytd, year, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="n">${ytd}</td>${proj ? `<td class="n">${year}</td>` : ''}</tr>`;
  const m = (k, src) => money(src[k]);
  const pj = p.projected;
  const yt = p.ytd;
  $('#breakdown').innerHTML = `
    <table>
      <thead><tr><th></th><th class="n">На сегодня</th>${proj ? `<th class="n">Прогноз года ×${p.paceFactor.toFixed(2)}</th>` : ''}</tr></thead>
      <tbody>
        ${row('Доход 1099', money(yt.seGross), money(pj.seGross), 'sub')}
        ${row('− Списания (Schedule C)', money(yt.seExpenses), money(pj.seExpenses), 'sub')}
        ${row('= Чистая прибыль', money(yt.seNet), money(pj.seNet))}
        ${yt.wages || pj.wages ? row('Зарплата W-2', money(yt.wages), money(pj.wages), 'sub') : ''}
        ${row('− ½ SE налога и корректировки', money(y.halfSE + yt.adjustments), money(a.halfSE + pj.adjustments), 'sub')}
        ${row('AGI', m('agi', y), m('agi', a))}
        ${row('− Стандартный вычет', m('stdDeduction', y), m('stdDeduction', a), 'sub')}
        ${row('− QBI (20% бизнес-дохода)', m('qbiDeduction', y), m('qbiDeduction', a), 'sub')}
        ${row('Облагаемый доход', m('taxable', y), m('taxable', a))}
        ${row(`Подоходный (маржинальная ${pct(a.marginal, 0)})`, m('incomeTax', y), m('incomeTax', a))}
        ${row('Self-employment (SS 12.4% + Medicare 2.9%)', m('seTax', y), m('seTax', a))}
        ${a.addlMedicare ? row('Доп. Medicare 0.9%', m('addlMedicare', y), m('addlMedicare', a)) : ''}
        ${row('Федеральный итого', m('federal', y), m('federal', a), 'sub')}
        ${row(`Штат ${p.state ? p.state.code : ''} ${stateRate(profile).rate}%`, m('state', y), m('state', a))}
        ${a.local ? row(`Город / округ ${profile.localRate}%`, m('local', y), m('local', a)) : ''}
        ${row('Всего налогов', m('total', y), m('total', a), 'total')}
        ${row('Эффективная ставка', pct(y.effective), pct(a.effective), 'sub')}
      </tbody>
    </table>`;
}

// ───────────────────────── interactions ─────────────────────────
// Q4 and the return are paid in the next calendar year (Jan / Apr).
function taxYearOfPayment(date, quarter) {
  const y = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return (quarter === 4 || quarter === 0) && month <= 4 ? y - 1 : y;
}

function wireForms() {
  $('#f-profile').addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el.name) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.name === 'year') v = Number(v);
    store.setProfile({ [el.name]: v });
  });

  $('#f-income [name=type]').addEventListener('change', () => applyMode(profileWithDefaults()));

  const submit = (id, col, map) => $(id).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const raw = formData(f);
    const item = map(raw);
    if (!(item.amount > 0) && col !== 'accounts') return;
    await store.add(col, item);
    for (const sel of f.querySelectorAll('select[id]')) {
      try { localStorage.setItem(`astro-tax/last-${sel.id}`, sel.value); } catch { /* ignore */ }
    }
    f.querySelectorAll('input:not([type=date])').forEach((i) => { i.value = ''; });
    f.querySelector('[name=amount], [name=name]')?.focus();
  });

  const amt = (v) => Math.round(Number(v) * 100) / 100 || 0;
  submit('#f-income', 'incomes', (r) => ({
    date: r.date, amount: amt(r.amount), accountId: r.accountId || '', source: r.source?.trim() ?? '',
    type: r.type || 'se',
    ...(r.type === 'w2' ? { fedWithheld: amt(r.fedWithheld), stateWithheld: amt(r.stateWithheld) } : {}),
  }));
  submit('#f-expense', 'expenses', (r) => ({
    date: r.date, amount: amt(r.amount), category: r.category, accountId: r.accountId || '', note: r.note?.trim() ?? '',
  }));
  submit('#f-payment', 'payments', (r) => ({
    date: r.date, amount: amt(r.amount), kind: r.kind, quarter: Number(r.quarter), note: r.note?.trim() ?? '',
    year: taxYearOfPayment(r.date, Number(r.quarter)),
  }));
  submit('#f-account', 'accounts', (r) => ({ name: r.name.trim(), type: r.type, last4: (r.last4 || '').replace(/\D/g, '') }));
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'signin') {
    try { await signIn(); } catch (e) { renderGate(null, e?.code === 'auth/popup-closed-by-user' ? 'Окно входа закрыто.' : String(e?.message ?? e)); }
  } else if (act === 'signout') {
    await signOut();
  } else if (act === 'del') {
    if (confirm('Удалить запись?')) await store.remove(b.dataset.col, b.dataset.id);
  } else if (act === 'ack') {
    await store.update('events', b.dataset.id, { status: 'read', updatedAt: new Date().toISOString() });
  } else if (act === 'jump') {
    const m = $(`#${b.dataset.to}`);
    m.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => m.querySelector('[name=amount]')?.focus(), 350);
  } else if (act === 'pay-next') {
    const p = buildPlan(data, profileWithDefaults(), todayIso());
    const n = p.next;
    if (!n) return;
    const f = $('#f-payment');
    f.kind.value = n.toPay.fed >= 1 ? 'federal' : 'state';
    f.amount.value = (f.kind.value === 'federal' ? n.toPay.fed : n.toPay.state).toFixed(2);
    f.quarter.value = String(n.q);
    f.date.value = todayIso();
    $('#m-payments').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => f.amount.focus(), 350);
  }
});

window.addEventListener('online', renderClock);
window.addEventListener('offline', renderClock);
// The clock ticks on its own too: a deadline can arrive while the tab is open.
setInterval(() => { if (data) { render(); sync(); } }, 15 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data) { render(); sync(); } });

boot();
