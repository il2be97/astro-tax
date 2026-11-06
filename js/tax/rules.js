// Federal constants per tax year. Source: IRS Rev. Proc. 2025-32 (tax year 2026),
// SSA 2026 wage base. A year without its own table falls back to the latest
// known one and the UI warns about it.

const INF = Infinity;

export const FEDERAL = {
  2026: {
    stdDeduction: { single: 16100, mfj: 32200, hoh: 24150, mfs: 16100 },
    brackets: {
      single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [INF, 0.37]],
      mfj: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [INF, 0.37]],
      hoh: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [INF, 0.37]],
      mfs: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [384350, 0.35], [INF, 0.37]],
    },
    ssWageBase: 184500,
    addlMedicareThreshold: { single: 200000, mfj: 250000, hoh: 200000, mfs: 125000 },
    // QBI (§199A): full 20% below the threshold, phased out over the range
    // above it. Treated conservatively (as if SSTB without W-2 wages).
    qbiThreshold: { single: 201750, mfj: 403500, hoh: 201750, mfs: 201750 },
    qbiPhaseIn: { single: 75000, mfj: 150000, hoh: 75000, mfs: 75000 },
    underpaymentRate: 0.07,
  },
};

export function federalRules(year) {
  if (FEDERAL[year]) return { year, rules: FEDERAL[year], fallback: false };
  const known = Object.keys(FEDERAL).map(Number).sort((a, b) => b - a)[0];
  return { year: known, rules: FEDERAL[known], fallback: true };
}

export const FILING_STATUSES = [
  { id: 'single', label: 'Single — одиночка' },
  { id: 'mfj', label: 'Married filing jointly — семья' },
  { id: 'mfs', label: 'Married filing separately' },
  { id: 'hoh', label: 'Head of household' },
];

export const WORK_MODES = [
  { id: 'self', label: 'Самозанятость (1099 / Schedule C)' },
  { id: 'w2', label: 'Наёмный (W-2)' },
  { id: 'mixed', label: 'Смешанный (W-2 + 1099)' },
];

// Schedule C expense categories. `pct` — deductible share. `kind: 'adj'` —
// above-the-line adjustment: lowers AGI but not self-employment tax.
export const EXPENSE_CATEGORIES = [
  { id: 'advertising', label: 'Реклама', pct: 1 },
  { id: 'car', label: 'Авто / пробег', pct: 1 },
  { id: 'contract', label: 'Подрядчики', pct: 1 },
  { id: 'insurance', label: 'Страховка бизнеса', pct: 1 },
  { id: 'legal', label: 'Юристы / бухгалтер', pct: 1 },
  { id: 'office', label: 'Офис / расходники', pct: 1 },
  { id: 'software', label: 'Софт / подписки', pct: 1 },
  { id: 'equipment', label: 'Техника / оборудование', pct: 1 },
  { id: 'rent', label: 'Аренда', pct: 1 },
  { id: 'travel', label: 'Командировки', pct: 1 },
  { id: 'meals', label: 'Бизнес-обеды (50%)', pct: 0.5 },
  { id: 'phone', label: 'Телефон / интернет', pct: 1 },
  { id: 'home', label: 'Домашний офис', pct: 1 },
  { id: 'education', label: 'Обучение', pct: 1 },
  { id: 'fees', label: 'Комиссии банков / платёжек', pct: 1 },
  { id: 'other', label: 'Прочее (бизнес)', pct: 1 },
  { id: 'health', label: 'Мед. страховка самозанятого', pct: 1, kind: 'adj' },
  { id: 'retirement', label: 'SEP-IRA / Solo 401(k)', pct: 1, kind: 'adj' },
  { id: 'adj_other', label: 'Прочая корректировка AGI', pct: 1, kind: 'adj' },
];

export const ACCOUNT_TYPES = [
  { id: 'bank', label: 'Банк' },
  { id: 'card', label: 'Карта' },
  { id: 'payments', label: 'Stripe / PayPal' },
  { id: 'cash', label: 'Наличные' },
  { id: 'other', label: 'Другое' },
];
