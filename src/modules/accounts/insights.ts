import type { Decimal128 } from "mongodb";
import { tenantCol } from "@/core/db";
import { fromDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { booksSummary } from "@/modules/books/service";
import { trialBalance } from "@/modules/reports/trialBalance";
import * as core from "./insights-core";

/**
 * Accounts AI ("AI CFO"). Loads ledger, receivables, payables and expenses for the signed-in org and runs the transparent heuristics in
 * insights-core.ts. Read-only: nothing here posts, sends or changes data. Runs locally (no external model), in line with AI_PROVIDER.
 */
const n = (x: unknown) => fromDecimal128(x as Decimal128).toNumber();
const DAY = 86400000;
const CASH_CODES = ["1000", "1010", "1015", "1016", "1020"];
type Inv = { _id: string; number: string; customerId: string; dueDate: Date; balance: Decimal128; status: string };
type Bill = { _id: string; supplierId: string; invoiceNo: string; invoiceDate: Date; dueDate: Date; total: Decimal128; balance: Decimal128; status: string; createdAt: Date };
type Exp = { _id: string; date: Date; vendor: string; description: string; category: string; total: Decimal128; reference?: string };

const daysLate = (due: Date, today: Date) => Math.floor((today.getTime() - due.getTime()) / DAY);

/** Average net movement of cash accounts per calendar month (Dubai), oldest first, for the last `months` complete months. */
async function monthlyNetCash(ctx: Ctx, today: Date, months = 6): Promise<number[]> {
  const from = new Date(today.getTime() - (months + 1) * 31 * DAY);
  const rows = await tenantCol(ctx.orgId, "gl_lines").aggregate<{ _id: string; d: unknown; c: unknown }>([
    { $match: { accountCode: { $in: CASH_CODES }, date: { $gte: from, $lt: today } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$date", timezone: "+04:00" } }, d: { $sum: "$debit" }, c: { $sum: "$credit" } } },
    { $sort: { _id: 1 } },
  ]);
  const thisMonth = new Date(today.getTime() + 4 * 3600000).toISOString().slice(0, 7);
  return rows.filter((r) => r._id !== thisMonth).slice(-months).map((r) => n(r.d) - n(r.c));
}

async function openReceivables(ctx: Ctx, today: Date) {
  const inv = await tenantCol<Inv>(ctx.orgId, "trade_invoices").find({ status: { $in: ["open", "partially_paid"] } } as never, { limit: 5000 });
  const names = new Map((await tenantCol<{ _id: string; name: string; email?: string }>(ctx.orgId, "customers").find({} as never, { limit: 5000 })).map((c) => [c._id, c]));
  return inv.map((i) => ({ id: i._id, number: i.number, customer: names.get(i.customerId)?.name ?? "Client", email: names.get(i.customerId)?.email, balance: n(i.balance), due: i.dueDate, daysOverdue: daysLate(i.dueDate, today) }));
}

async function openPayables(ctx: Ctx, today: Date) {
  if (!ctx.permissions.includes("procurement:view")) return [];
  const bills = await tenantCol<Bill>(ctx.orgId, "supplier_invoices").find({ status: { $in: ["approved", "partially_paid"] } } as never, { limit: 5000 });
  return bills.map((b) => ({ due: b.dueDate, amount: n(b.balance), daysOverdue: daysLate(b.dueDate, today) }));
}

export async function cfoInsights(ctx: Ctx, today = new Date()) {
  assertPermission(ctx, "ledger:view");
  const [summary, monthly, ar, ap, tb] = await Promise.all([booksSummary(ctx), monthlyNetCash(ctx, today), openReceivables(ctx, today), openPayables(ctx, today), trialBalance(ctx, {})]);
  const cash = summary.cash.toNumber();
  const tradeAr = ar.reduce((a, i) => a + i.balance, 0);
  const overdue = ar.filter((i) => i.daysOverdue > 0).reduce((a, i) => a + i.balance, 0);
  const health = core.healthScore({
    cash, receivables: summary.receivables.toNumber(), payables: summary.payables.toNumber(), vatPayable: summary.vatPayable.toNumber(),
    income: summary.income.toNumber(), expense: summary.expense.toNumber(), monthlyNetCash: monthly.length ? monthly.reduce((a, b) => a + b, 0) / monthly.length : 0,
    overdueShare: tradeAr > 0 ? overdue / tradeAr : 0,
  });
  const forecast = core.forecastCash({ today, openingCash: cash, monthlyNet: monthly, receivables: ar.map((i) => ({ due: i.due, amount: i.balance, daysOverdue: i.daysOverdue })), payables: ap });

  // expense postings for anomaly detection (7 months)
  const since = new Date(today.getTime() - 213 * DAY);
  const lines = await tenantCol<{ entryId: string; accountId: string; accountCode: string; date: Date; debit: Decimal128; credit: Decimal128 }>(ctx.orgId, "gl_lines")
    .find({ accountType: "expense", date: { $gte: since } } as never, { limit: 20000 });
  const accNames = new Map((await tenantCol<{ code: string; name: string }>(ctx.orgId, "accounts").find({} as never, { limit: 1000 })).map((a) => [a.code, a.name]));
  const memos = new Map((await tenantCol<{ _id: string; memo: string }>(ctx.orgId, "journal_entries").find({ _id: { $in: [...new Set(lines.map((l) => l.entryId))] } } as never, { limit: 20000 })).map((e) => [e._id, e.memo]));
  const anomalies = core.detectAnomalies(lines.map((l, i) => ({ id: `${l.entryId}:${i}`, date: l.date, accountCode: l.accountCode, accountName: accNames.get(l.accountCode) ?? l.accountCode, amount: n(l.debit) - n(l.credit), memo: memos.get(l.entryId) ?? "" })), today);

  // duplicates across expenses and supplier bills (90 days)
  const d90 = new Date(today.getTime() - 90 * DAY);
  const exps = await tenantCol<Exp>(ctx.orgId, "expenses").find({ date: { $gte: d90 } } as never, { limit: 2000 });
  const bills = ctx.permissions.includes("procurement:view") ? await tenantCol<Bill>(ctx.orgId, "supplier_invoices").find({ invoiceDate: { $gte: d90 } } as never, { limit: 2000 }) : [];
  const sup = new Map((await tenantCol<{ _id: string; name: string }>(ctx.orgId, "suppliers").find({} as never, { limit: 2000 })).map((x) => [x._id, x.name]));
  const duplicates = core.findDuplicates([
    ...exps.map((e) => ({ id: e._id, source: "expense" as const, vendor: e.vendor, amount: n(e.total), date: e.date, ref: e.reference })),
    ...bills.filter((b) => b.status !== "rejected").map((b) => ({ id: b._id, source: "bill" as const, vendor: sup.get(b.supplierId) ?? b.supplierId, amount: n(b.total), date: b.invoiceDate, ref: b.invoiceNo })),
  ]);

  const collections = core.prioritizeCollections(ar.map(({ id, number, customer, balance, daysOverdue, email }) => ({ id, number, customer, balance, daysOverdue, email }))).slice(0, 8);

  // month-end close readiness
  const thisMonthStart = new Date(Date.UTC(new Date(today.getTime() + 4 * 3600000).getUTCFullYear(), new Date(today.getTime() + 4 * 3600000).getUTCMonth(), 1) - 4 * 3600000);
  const [unmatchedBank, draftJournals, draftInvoices, billsAwaiting, dueRecurring, openPrior] = await Promise.all([
    tenantCol(ctx.orgId, "bank_transactions").count({ status: "unmatched" } as never),
    tenantCol(ctx.orgId, "draft_journals").count({ status: "pending" } as never),
    tenantCol(ctx.orgId, "trade_invoices").count({ status: "draft" } as never),
    tenantCol(ctx.orgId, "supplier_invoices").count({ status: "pending_approval" } as never),
    tenantCol(ctx.orgId, "recurring_invoices").count({ status: "active", nextDate: { $lte: today } } as never),
    tenantCol(ctx.orgId, "fiscal_periods").count({ status: "open", end: { $lte: thisMonthStart } } as never),
  ]);
  const close = core.closeReadiness({ unmatchedBank, draftJournals, draftInvoices, billsAwaitingApproval: billsAwaiting, dueRecurring, trialBalanced: tb.totalDebit.equals(tb.totalCredit), openPriorPeriods: openPrior });

  return { summary, health, forecast, anomalies, duplicates, collections, close, monthly, generatedAt: today };
}

/** Learns categories from the org's own expense history; used for the "smart categorise" helper on the expense form. */
export async function categorise(ctx: Ctx, text: string) {
  assertPermission(ctx, "ledger:view");
  const hist = await tenantCol<Exp>(ctx.orgId, "expenses").find({} as never, { sort: { date: -1 }, limit: 500 });
  return core.suggestCategory(text, hist.map((h) => ({ text: `${h.vendor} ${h.description}`, code: h.category })));
}

/** "Ask your books": answers a plain-English question from the ledger. Returns the figure, a sentence, and how it was worked out. */
export async function askBooks(ctx: Ctx, question: string, today = new Date()): Promise<{ answer: string; figure?: string; method: string; rows?: { label: string; amount: number }[] }> {
  assertPermission(ctx, "ledger:view");
  const q = question.trim().slice(0, 300);
  const intent = core.parseIntent(q);
  const period = core.parsePeriod(q, today);
  const fmt = (v: number) => `AED ${v.toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const accs = await tenantCol<{ code: string; name: string; type: string }>(ctx.orgId, "accounts").find({} as never, { limit: 1000 });
  const byType = async (type: "income" | "expense", codes?: string[]) => {
    const rows = await tenantCol(ctx.orgId, "gl_lines").aggregate<{ _id: string; d: unknown; c: unknown }>([
      { $match: { accountType: type, date: { $gte: period.from, $lt: period.to }, ...(codes ? { accountCode: { $in: codes } } : {}) } },
      { $group: { _id: "$accountCode", d: { $sum: "$debit" }, c: { $sum: "$credit" } } },
    ]);
    return rows.map((r) => ({ label: `${r._id} ${accs.find((a) => a.code === r._id)?.name ?? ""}`.trim(), amount: type === "income" ? n(r.c) - n(r.d) : n(r.d) - n(r.c) })).sort((a, b) => b.amount - a.amount);
  };
  const total = (rs: { amount: number }[]) => rs.reduce((a, r) => a + r.amount, 0);
  switch (intent.kind) {
    case "spend": {
      const term = intent.term?.toLowerCase();
      const codes = term ? accs.filter((a) => a.type === "expense" && a.name.toLowerCase().includes(term.replace(/s$/, ""))).map((a) => a.code) : undefined;
      if (term && !codes?.length) {
        const exps = await tenantCol<Exp>(ctx.orgId, "expenses").find({ date: { $gte: period.from, $lt: period.to } } as never, { limit: 5000 });
        const hits = exps.filter((e) => `${e.vendor} ${e.description}`.toLowerCase().includes(term));
        const v = hits.reduce((a, e) => a + n(e.total), 0);
        return { answer: `You recorded ${hits.length} expense(s) matching "${term}" ${period.label}, totalling ${fmt(v)} including VAT.`, figure: fmt(v), method: `Searched expense descriptions and vendors for "${term}" (no expense account is named like it).` };
      }
      const rows = await byType("expense", codes);
      return { answer: `${term ? `Spend on ${term}` : "Total expenses"} ${period.label}: ${fmt(total(rows))}.`, figure: fmt(total(rows)), rows: rows.slice(0, 8), method: `Sum of posted debits less credits on ${codes ? `account(s) ${codes.join(", ")}` : "all expense accounts"}, ${period.label}.` };
    }
    case "top_expenses": { const rows = await byType("expense"); return { answer: rows.length ? `Biggest cost ${period.label} was ${rows[0].label} at ${fmt(rows[0].amount)}, of ${fmt(total(rows))} in total.` : `No expenses posted ${period.label}.`, rows: rows.slice(0, 8), method: `Expense accounts ranked by net posting, ${period.label}.` }; }
    case "income": { const rows = await byType("income"); return { answer: `Income ${period.label}: ${fmt(total(rows))}.`, figure: fmt(total(rows)), rows: rows.slice(0, 8), method: `Credits less debits on income accounts, ${period.label}.` }; }
    case "profit": {
      const [i, e] = await Promise.all([byType("income"), byType("expense")]);
      const net = total(i) - total(e);
      return { answer: `Net profit ${period.label}: ${fmt(net)} (income ${fmt(total(i))}, expenses ${fmt(total(e))}${total(i) ? `, margin ${((net / total(i)) * 100).toFixed(1)}%` : ""}).`, figure: fmt(net), method: `Income less expenses from the general ledger, ${period.label}.` };
    }
    case "top_customers": {
      const inv = await tenantCol<{ customerId: string; total: Decimal128; issueDate: Date; status: string }>(ctx.orgId, "trade_invoices").find({ issueDate: { $gte: period.from, $lt: period.to }, status: { $nin: ["draft", "void"] } } as never, { limit: 10000 });
      const names = new Map((await tenantCol<{ _id: string; name: string }>(ctx.orgId, "customers").find({} as never, { limit: 5000 })).map((c) => [c._id, c.name]));
      const m = new Map<string, number>();
      for (const x of inv) m.set(x.customerId, (m.get(x.customerId) ?? 0) + n(x.total));
      const rows = [...m].map(([id, amount]) => ({ label: names.get(id) ?? id, amount })).sort((a, b) => b.amount - a.amount);
      return { answer: rows.length ? `Top corporate client ${period.label}: ${rows[0].label} with ${fmt(rows[0].amount)} invoiced.` : `No corporate invoices issued ${period.label}.`, rows: rows.slice(0, 8), method: `Issued corporate invoices (incl. VAT) grouped by client, ${period.label}. Patient billing is not included.` };
    }
    default: {
      const s = await booksSummary(ctx);
      if (intent.kind === "cash") return { answer: `Cash and bank stand at ${fmt(s.cash.toNumber())} right now.`, figure: fmt(s.cash.toNumber()), method: "Balances of cash on hand, current and savings bank and petty cash." };
      if (intent.kind === "receivables") return { answer: `Customers, patients and insurers owe ${fmt(s.receivables.toNumber())} in total.`, figure: fmt(s.receivables.toNumber()), method: "Balances of receivable accounts 1100, 1110 and 1120. See Sales → Invoices for who owes what." };
      if (intent.kind === "payables") return { answer: `You owe suppliers ${fmt(s.payables.toNumber())}.`, figure: fmt(s.payables.toNumber()), method: "Balance of accounts payable (2000)." };
      if (intent.kind === "vat") return { answer: `Net VAT payable is ${fmt(s.vatPayable.toNumber())} (output VAT less recoverable input VAT).`, figure: fmt(s.vatPayable.toNumber()), method: "Account 2100 less account 1600." };
      if (intent.kind === "runway") {
        const m = await monthlyNetCash(ctx, today);
        const avg = m.length ? m.reduce((a, b) => a + b, 0) / m.length : 0;
        return avg >= 0
          ? { answer: `Cash has grown by about ${fmt(avg)} a month on average over the last ${m.length} month(s), so there is no burn to run out on.`, method: "Average monthly net movement of cash and bank accounts." }
          : { answer: `At the recent burn of ${fmt(-avg)} a month, ${fmt(s.cash.toNumber())} lasts about ${(s.cash.toNumber() / -avg).toFixed(1)} months.`, method: "Cash ÷ average monthly net cash outflow over recent months." };
      }
      return { answer: "I can answer questions about spend, income, profit, cash, receivables, payables, VAT, runway, top expenses and top clients. Try \"How much did we spend on rent last quarter?\"", method: "No matching question type." };
    }
  }
}
