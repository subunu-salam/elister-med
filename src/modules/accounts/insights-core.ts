/**
 * Accounts AI: pure, deterministic heuristics over plain numbers. No I/O, no external model, no randomness, so every figure the
 * "AI CFO" shows can be traced back and unit-tested. The data loader (insights.ts) feeds these functions from the ledger.
 * Everything here is labelled in the UI as a transparent heuristic, not a validated forecast.
 */

const DAY = 86400000;
const round = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ------------------------------------------------------------------ financial health score

export type HealthInput = {
  cash: number; receivables: number; payables: number; vatPayable: number;
  income: number; expense: number; /** average monthly net cash movement over recent months (negative = burning cash) */ monthlyNetCash: number;
  /** share of corporate receivables that are past due, 0..1 */ overdueShare: number;
};
export type HealthFactor = { key: string; label: string; display: string; score: number; note: string };
export type Health = { score: number; grade: "Excellent" | "Healthy" | "Watch" | "At risk"; factors: HealthFactor[]; runwayMonths: number | null };

/** 0-100 score from liquidity, runway, margin and collections, each weighted 25. */
export function healthScore(h: HealthInput): Health {
  const shortTerm = h.payables + Math.max(0, h.vatPayable);
  const currentRatio = shortTerm > 0 ? (h.cash + h.receivables) / shortTerm : h.cash + h.receivables > 0 ? 9.99 : 0;
  const liquidity = clamp((currentRatio / 2) * 25, 0, 25);
  const runwayMonths = h.monthlyNetCash < 0 ? h.cash / -h.monthlyNetCash : null;
  const runway = runwayMonths === null ? 25 : clamp((runwayMonths / 12) * 25, 0, 25);
  const margin = h.income > 0 ? (h.income - h.expense) / h.income : h.expense > 0 ? -1 : 0;
  const marginScore = clamp(((margin + 0.05) / 0.3) * 25, 0, 25);
  const collections = clamp((1 - h.overdueShare / 0.5) * 25, 0, 25);
  const score = Math.round(liquidity + runway + marginScore + collections);
  const grade = score >= 80 ? "Excellent" : score >= 60 ? "Healthy" : score >= 40 ? "Watch" : "At risk";
  return {
    score, grade, runwayMonths: runwayMonths === null ? null : round(runwayMonths),
    factors: [
      { key: "liquidity", label: "Liquidity", display: `${currentRatio.toFixed(2)}×`, score: Math.round(liquidity), note: currentRatio >= 2 ? "Cash and receivables cover short-term obligations twice over." : currentRatio >= 1 ? "Short-term obligations are covered, with little headroom." : "Short-term obligations exceed cash plus receivables." },
      { key: "runway", label: "Cash runway", display: runwayMonths === null ? "Cash-generative" : `${runwayMonths.toFixed(1)} months`, score: Math.round(runway), note: runwayMonths === null ? "Cash has grown on average over recent months." : `At the recent burn rate, cash lasts about ${runwayMonths.toFixed(1)} months.` },
      { key: "margin", label: "Net margin (YTD)", display: `${(margin * 100).toFixed(1)}%`, score: Math.round(marginScore), note: margin >= 0.2 ? "Strong profitability." : margin >= 0 ? "Profitable, room to improve." : "Expenses exceed income this year." },
      { key: "collections", label: "Collections", display: `${(h.overdueShare * 100).toFixed(0)}% overdue`, score: Math.round(collections), note: h.overdueShare <= 0.1 ? "Clients pay on time." : h.overdueShare <= 0.3 ? "Some invoices are slipping past due." : "A large share of receivables is overdue." },
    ],
  };
}

// ------------------------------------------------------------------ 13-week cash forecast

export type Scheduled = { due: Date; amount: number; /** days past due today (0 or negative = not yet due) */ daysOverdue?: number };
export type ForecastPoint = { week: number; start: Date; expected: number; low: number; high: number; inflow: number; outflow: number };
export type Forecast = { points: ForecastPoint[]; lowest: { week: number; amount: number }; breachWeek: number | null; baselineWeekly: number; assumptions: string[] };

/** Probability that a receivable is collected, by how late it already is. */
export function collectionProbability(daysOverdue: number): number {
  if (daysOverdue <= 0) return 0.9;
  if (daysOverdue <= 30) return 0.75;
  if (daysOverdue <= 60) return 0.5;
  if (daysOverdue <= 90) return 0.3;
  return 0.1;
}

/**
 * Weekly cash projection: opening cash + expected receipts (weighted by collection probability; overdue items land in week 1-4)
 * − bills due + a baseline drift (half the recent average weekly net cash movement, to avoid double counting the scheduled items).
 * The band widens with the volatility of recent monthly cash movement.
 */
export function forecastCash(input: { today: Date; openingCash: number; monthlyNet: number[]; receivables: Scheduled[]; payables: Scheduled[]; weeks?: number; buffer?: number }): Forecast {
  const weeks = input.weeks ?? 13;
  const weekly = input.monthlyNet.map((m) => m / 4.345);
  const baselineWeekly = round(mean(weekly) * 0.5);
  const vol = stdev(weekly);
  const weekOf = (d: Date, overdue: number) => {
    if (overdue > 0) return clamp(Math.ceil(overdue / 30), 1, 4) - 1; // late payers trickle in over the next month
    return clamp(Math.floor((d.getTime() - input.today.getTime()) / (7 * DAY)), 0, weeks - 1);
  };
  const inflow = Array<number>(weeks).fill(0), outflow = Array<number>(weeks).fill(0);
  for (const r of input.receivables) {
    const od = r.daysOverdue ?? 0;
    if ((r.due.getTime() - input.today.getTime()) / DAY > weeks * 7) continue;
    inflow[weekOf(r.due, od)] += r.amount * collectionProbability(od);
  }
  for (const p of input.payables) {
    if ((p.due.getTime() - input.today.getTime()) / DAY > weeks * 7) continue;
    outflow[(p.daysOverdue ?? 0) > 0 ? 0 : weekOf(p.due, 0)] += p.amount;
  }
  let run = input.openingCash;
  const points: ForecastPoint[] = [];
  for (let w = 0; w < weeks; w++) {
    run += inflow[w] - outflow[w] + baselineWeekly;
    const band = vol * Math.sqrt(w + 1);
    points.push({ week: w + 1, start: new Date(input.today.getTime() + w * 7 * DAY), expected: round(run), low: round(run - band), high: round(run + band), inflow: round(inflow[w]), outflow: round(outflow[w]) });
  }
  const low = points.reduce((a, p) => (p.expected < a.expected ? p : a), points[0]);
  const buffer = input.buffer ?? 0;
  const breach = points.find((p) => p.expected < buffer);
  return {
    points, lowest: { week: low.week, amount: low.expected }, breachWeek: breach ? breach.week : null, baselineWeekly,
    assumptions: [
      "Receivables weighted by collection probability: current 90%, 1-30 days late 75%, 31-60 50%, 61-90 30%, older 10%.",
      "Approved supplier bills are paid on their due date; overdue bills in week 1.",
      `Plus a baseline of ${baselineWeekly >= 0 ? "+" : ""}${baselineWeekly.toFixed(2)} a week (half the recent average weekly cash movement).`,
    ],
  };
}

// ------------------------------------------------------------------ anomalies

export type Posting = { id: string; date: Date; accountCode: string; accountName: string; amount: number; memo: string };
export type Anomaly = { id: string; kind: "outlier" | "spike"; severity: "high" | "medium"; title: string; detail: string; amount: number; accountCode: string; date?: Date };

/**
 * Two checks on expense postings:
 *  - outlier: a single posting in the last 30 days that is > 2.5 standard deviations and > 2× the median of that account's history;
 *  - spike: this month's total for an account is > 40% above its prior 3-month average and the increase is over AED 1,000.
 */
export function detectAnomalies(postings: Posting[], today: Date): Anomaly[] {
  const out: Anomaly[] = [];
  const recentFrom = today.getTime() - 30 * DAY;
  const byAcc = new Map<string, Posting[]>();
  for (const p of postings) { if (p.amount <= 0) continue; const l = byAcc.get(p.accountCode) ?? []; l.push(p); byAcc.set(p.accountCode, l); }
  for (const [code, ps] of byAcc) {
    const hist = ps.filter((p) => p.date.getTime() < recentFrom).map((p) => p.amount);
    if (hist.length >= 4) {
      const m = mean(hist), sd = stdev(hist), md = median(hist);
      for (const p of ps.filter((x) => x.date.getTime() >= recentFrom)) {
        if (sd > 0 && (p.amount - m) / sd > 2.5 && p.amount > 2 * md) {
          out.push({ id: `o:${p.id}`, kind: "outlier", severity: p.amount > 4 * md ? "high" : "medium", accountCode: code, date: p.date, amount: round(p.amount),
            title: `Unusual ${p.accountName} posting`, detail: `${p.memo || "Posting"} is ${(p.amount / md).toFixed(1)}× the usual amount for ${code} ${p.accountName} (median ${md.toFixed(2)}).` });
        }
      }
    }
    const ym = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
    const cur = ym(today);
    const tot = (k: number) => ps.filter((p) => ym(p.date) === k).reduce((a, p) => a + p.amount, 0);
    const prior = [tot(cur - 1), tot(cur - 2), tot(cur - 3)];
    const avg = mean(prior), now = tot(cur);
    if (prior.filter((x) => x > 0).length >= 2 && now > avg * 1.4 && now - avg > 1000) {
      const name = ps[0].accountName;
      out.push({ id: `s:${code}`, kind: "spike", severity: now > avg * 2 ? "high" : "medium", accountCode: code, amount: round(now - avg),
        title: `${name} up ${Math.round((now / avg - 1) * 100)}% this month`, detail: `${now.toFixed(2)} so far this month against a 3-month average of ${avg.toFixed(2)}.` });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? b.amount - a.amount : a.severity === "high" ? -1 : 1));
}

// ------------------------------------------------------------------ duplicates

export type Payable = { id: string; source: "expense" | "bill"; vendor: string; amount: number; date: Date; ref?: string };
export type DuplicatePair = { a: Payable; b: Payable; reason: string };
const norm = (s: string) => s.toLowerCase().replace(/\b(llc|l\.l\.c|fze|fzco|co|trading|est|the)\b/g, "").replace(/[^a-z0-9]/g, "");

/** Same vendor and amount within 7 days, or the same vendor reference recorded twice. */
export function findDuplicates(items: Payable[]): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  const s = [...items].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      const a = s[i], b = s[j];
      if (norm(a.vendor) !== norm(b.vendor)) continue;
      if (a.ref && b.ref && a.ref.trim().toLowerCase() === b.ref.trim().toLowerCase()) out.push({ a, b, reason: `Reference ${a.ref} recorded twice` });
      else if (Math.abs(a.amount - b.amount) < 0.005 && (b.date.getTime() - a.date.getTime()) / DAY <= 7) out.push({ a, b, reason: `Same amount ${a.amount.toFixed(2)} within ${Math.round((b.date.getTime() - a.date.getTime()) / DAY)} day(s)` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ collections

export type OpenInvoice = { id: string; number: string; customer: string; balance: number; daysOverdue: number; email?: string };
export type CollectionAction = OpenInvoice & { priority: number; stage: "Gentle reminder" | "Firm follow-up" | "Final notice" | "Not due"; message: string };

/** Ranks open invoices by money at risk (balance × chance it is never paid) and drafts a reminder in the right tone. */
export function prioritizeCollections(inv: OpenInvoice[]): CollectionAction[] {
  return inv.filter((i) => i.balance > 0).map((i) => {
    const risk = 1 - collectionProbability(i.daysOverdue);
    const stage: CollectionAction["stage"] = i.daysOverdue <= 0 ? "Not due" : i.daysOverdue <= 30 ? "Gentle reminder" : i.daysOverdue <= 60 ? "Firm follow-up" : "Final notice";
    const amt = `AED ${i.balance.toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const message = stage === "Not due"
      ? `Dear ${i.customer}, a courtesy note that invoice ${i.number} for ${amt} falls due soon. Thank you.`
      : stage === "Gentle reminder"
        ? `Dear ${i.customer}, invoice ${i.number} for ${amt} is ${i.daysOverdue} day(s) past due. Could you let us know when payment is scheduled? Thank you.`
        : stage === "Firm follow-up"
          ? `Dear ${i.customer}, invoice ${i.number} (${amt}) is now ${i.daysOverdue} days overdue. Please arrange payment this week or contact us to agree a date.`
          : `Dear ${i.customer}, invoice ${i.number} (${amt}) is ${i.daysOverdue} days overdue. Please settle within 7 days to avoid suspension of services under the contract.`;
    return { ...i, priority: round(i.balance * Math.max(risk, 0.05) * (1 + Math.max(0, i.daysOverdue) / 90)), stage, message };
  }).sort((a, b) => b.priority - a.priority);
}

// ------------------------------------------------------------------ expense categorisation

const KEYWORDS: [RegExp, string][] = [
  [/\b(rent|lease|ejari|landlord)\b/i, "5100"], [/\b(dewa|sewa|addc|electric|water|utility|utilities|chiller|empower|etisalat|du |internet)\b/i, "5200"],
  [/\b(gloves|syringe|gauze|consumable|mask|dressing)\b/i, "5300"], [/\b(reagent|lab|laboratory)\b/i, "5500"], [/\b(repair|maintenance|service contract|amc|calibration)\b/i, "5600"],
  [/\b(ads?|advert|google|meta|facebook|instagram|marketing|campaign|seo|flyer)\b/i, "5700"], [/\b(salary|salaries|payroll|wps)\b/i, "5000"],
  [/\b(bank charge|card fee|merchant|pos fee|commission)\b/i, "5810"], [/\b(stationery|office|courier|licen[cs]e|software|subscription|printing)\b/i, "5800"],
];
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Suggests an expense account: first from how this vendor/description was categorised before, then from keywords. */
export function suggestCategory(text: string, history: { text: string; code: string }[]): { code: string; confidence: number; why: string } | null {
  const t = new Set(tokens(text));
  let best: { code: string; score: number; text: string } | null = null;
  for (const h of history) {
    const ht = tokens(h.text); if (!ht.length) continue;
    const overlap = ht.filter((x) => t.has(x)).length / Math.max(ht.length, t.size);
    if (overlap > (best?.score ?? 0)) best = { code: h.code, score: overlap, text: h.text };
  }
  if (best && best.score >= 0.5) return { code: best.code, confidence: Math.round(Math.min(0.95, 0.5 + best.score / 2) * 100) / 100, why: `Matches an earlier expense "${best.text}"` };
  for (const [re, code] of KEYWORDS) if (re.test(` ${text} `)) return { code, confidence: 0.7, why: `Keyword match` };
  return null;
}

// ------------------------------------------------------------------ ask your books

export type Intent =
  | { kind: "spend"; term?: string } | { kind: "income" } | { kind: "profit" } | { kind: "cash" } | { kind: "receivables" } | { kind: "payables" }
  | { kind: "vat" } | { kind: "top_expenses" } | { kind: "top_customers" } | { kind: "runway" } | { kind: "unknown" };
export type Period = { from: Date; to: Date; label: string };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const dubai = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d) - 4 * 3600000); // midnight Asia/Dubai

/** Period phrases: this/last month, quarter, year, ytd, last N days, a month name (optionally with a year). Defaults to this month. */
export function parsePeriod(q: string, today: Date): Period {
  const s = q.toLowerCase();
  const local = new Date(today.getTime() + 4 * 3600000);
  const y = local.getUTCFullYear(), m = local.getUTCMonth();
  const end = new Date(dubai(y, m, local.getUTCDate()).getTime() + DAY);
  const days = s.match(/last (\d{1,3}) days/);
  if (days) return { from: new Date(end.getTime() - Number(days[1]) * DAY), to: end, label: `the last ${days[1]} days` };
  if (/last month|previous month/.test(s)) return { from: dubai(y, m - 1), to: dubai(y, m), label: "last month" };
  if (/this quarter|current quarter|qtd/.test(s)) { const qs = m - (m % 3); return { from: dubai(y, qs), to: end, label: "this quarter" }; }
  if (/last quarter|previous quarter/.test(s)) { const qs = m - (m % 3); return { from: dubai(y, qs - 3), to: dubai(y, qs), label: "last quarter" }; }
  if (/last year|previous year/.test(s)) return { from: dubai(y - 1, 0), to: dubai(y, 0), label: `${y - 1}` };
  if (/this year|ytd|year to date/.test(s)) return { from: dubai(y, 0), to: end, label: "this year to date" };
  for (let i = 0; i < 12; i++) {
    const mm = s.match(new RegExp(`\\b(${MONTHS[i]}|${MONTHS[i].slice(0, 3)})\\b(?:\\s+(\\d{4}))?`));
    if (mm && !(MONTHS[i] === "may" && /\bmay (i|we|you)\b/.test(s))) {
      const yy = mm[2] ? Number(mm[2]) : i > m ? y - 1 : y;
      return { from: dubai(yy, i), to: dubai(yy, i + 1), label: `${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)} ${yy}` };
    }
  }
  return { from: dubai(y, m), to: end, label: "this month" };
}

export function parseIntent(q: string): Intent {
  const s = q.toLowerCase();
  if (/runway|how long.*cash|burn/.test(s)) return { kind: "runway" };
  if (/top (expense|cost|spend)|biggest (expense|cost)|where.*(money|spend)/.test(s)) return { kind: "top_expenses" };
  if (/top (customer|client)|biggest (customer|client)|best (customer|client)/.test(s)) return { kind: "top_customers" };
  if (/\bvat\b|tax payable/.test(s)) return { kind: "vat" };
  if (/owe us|receivable|outstanding from|unpaid invoice|who owes/.test(s)) return { kind: "receivables" };
  if (/we owe|payable|bills due|unpaid bill/.test(s)) return { kind: "payables" };
  if (/profit|net income|margin|p&l|p and l/.test(s)) return { kind: "profit" };
  if (/cash|bank balance|in the bank/.test(s)) return { kind: "cash" };
  if (/revenue|income|sales|earn/.test(s)) return { kind: "income" };
  const spend = s.match(/(?:spend|spent|cost|expense|pay|paid)(?:s|ing)?\s+(?:on|for)\s+([a-z &]+?)(?:\s+(?:this|last|in|during|over|for|ytd)\b|\?|$)/);
  if (spend) return { kind: "spend", term: spend[1].trim() };
  if (/spend|spent|expense|cost/.test(s)) return { kind: "spend" };
  return { kind: "unknown" };
}

// ------------------------------------------------------------------ month-end close readiness

export type CloseCheck = { label: string; ok: boolean; detail: string; href: string };
export function closeReadiness(c: { unmatchedBank: number; draftJournals: number; draftInvoices: number; billsAwaitingApproval: number; dueRecurring: number; trialBalanced: boolean; openPriorPeriods: number }): { pct: number; checks: CloseCheck[] } {
  const checks: CloseCheck[] = [
    { label: "Bank statement lines matched", ok: c.unmatchedBank === 0, detail: c.unmatchedBank ? `${c.unmatchedBank} unmatched line(s)` : "All matched", href: "/finance?tab=bank" },
    { label: "Journals awaiting approval", ok: c.draftJournals === 0, detail: c.draftJournals ? `${c.draftJournals} waiting` : "None", href: "/accounts/accountant?tab=journals" },
    { label: "Draft invoices issued or voided", ok: c.draftInvoices === 0, detail: c.draftInvoices ? `${c.draftInvoices} still in draft` : "None in draft", href: "/accounts/sales?tab=invoices" },
    { label: "Supplier bills approved", ok: c.billsAwaitingApproval === 0, detail: c.billsAwaitingApproval ? `${c.billsAwaitingApproval} awaiting approval` : "None pending", href: "/accounts/purchases?tab=bills" },
    { label: "Recurring invoices generated", ok: c.dueRecurring === 0, detail: c.dueRecurring ? `${c.dueRecurring} due to run` : "Up to date", href: "/accounts/sales?tab=recurring" },
    { label: "Trial balance balances", ok: c.trialBalanced, detail: c.trialBalanced ? "Debits equal credits" : "Out of balance", href: "/accounts/reports?r=trial-balance" },
    { label: "Earlier months locked", ok: c.openPriorPeriods === 0, detail: c.openPriorPeriods ? `${c.openPriorPeriods} earlier month(s) still open` : "All locked", href: "/accounts/accountant?tab=lock" },
  ];
  return { pct: Math.round((checks.filter((x) => x.ok).length / checks.length) * 100), checks };
}
