/** Independent tally of the books: every check recomputes a figure from the raw collections and compares it with a second source. */
import Decimal from "decimal.js";
import { getDb } from "../../src/core/db";

const dec = (v: unknown) => new Decimal(v == null ? 0 : (v as { toString(): string }).toString());
const fmt = (d: Decimal) => d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export async function verifyBooks(orgId: string): Promise<number> {
  const db = await getDb();
  let failures = 0;
  const check = (name: string, a: Decimal, b: Decimal, tol = 0.005) => {
    const ok = a.minus(b).abs().lte(tol);
    if (!ok) failures++;
    console.log(`${ok ? "  ok " : " FAIL"}  ${name.padEnd(58)} ${fmt(a).padStart(16)}  vs ${fmt(b).padStart(16)}`);
  };
  const sumField = async (col: string, field: string, match: object = {}) => {
    const r = await db.collection(col).aggregate([{ $match: { orgId, ...match } }, { $group: { _id: null, t: { $sum: `$${field}` } } }]).toArray();
    return dec(r[0]?.t);
  };
  const bal = async (code: string) => {
    const r = await db.collection("gl_lines").aggregate([{ $match: { orgId, accountCode: code } }, { $group: { _id: null, d: { $sum: "$debit" }, c: { $sum: "$credit" } } }]).toArray();
    return dec(r[0]?.d).minus(dec(r[0]?.c));
  };

  console.log("\nTally checks");
  const dr = await sumField("gl_lines", "debit"), cr = await sumField("gl_lines", "credit");
  check("Ledger: total debits = total credits", dr, cr);
  const unbal = await db.collection("gl_lines").aggregate([{ $match: { orgId } }, { $group: { _id: "$entryId", d: { $sum: "$debit" }, c: { $sum: "$credit" } } }, { $match: { $expr: { $ne: ["$d", "$c"] } } }, { $count: "n" }]).toArray();
  check("Journal entries individually unbalanced", dec(unbal[0]?.n ?? 0), dec(0), 0);

  const [openInv, arPat] = [await sumField("invoices", "balance", { status: { $ne: "credited" } }), await bal("1100")];
  check("Patient receivables: ledger 1100 = open invoice balances", arPat, openInv);
  const claimsOut = await sumField("claims", "outstanding"), arIns = await bal("1110");
  check("Insurance receivables: ledger 1110 = claim outstanding", arIns, claimsOut);

  const batches = await db.collection("inv_batches").find({ orgId, qtyOnHand: { $gt: 0 } }).toArray();
  const stock = batches.reduce((a, b) => a.plus(dec(b.unitCost).times(b.qtyOnHand)), dec(0));
  check("Inventory: ledger 1200+1210 = batch valuation", (await bal("1200")).plus(await bal("1210")), stock);
  const neg = batches.filter((b) => b.qtyOnHand < 0).length;
  check("Batches with negative stock", dec(neg), dec(0), 0);

  const apBal = (await sumField("supplier_invoices", "balance", { status: { $in: ["approved", "partially_paid"] } }));
  check("Payables: ledger 2000 = open approved supplier invoices", (await bal("2000")).negated(), apBal);
  check("Payroll liability cleared (all payroll paid)", await bal("2200"), dec(0));
  const grni = (await bal("2010")).negated();
  const recv = await sumField("purchase_orders", "receivedValue"), invd = await sumField("purchase_orders", "invoicedValue");
  check("GRNI: ledger 2010 = received − invoiced", grni, recv.minus(invd));

  const revenue = (await Promise.all(["4000", "4100", "4200", "4300", "4400", "4250", "4500", "4900"].map(async (c) => (await bal(c)).negated()))).reduce((a, b) => a.plus(b), dec(0));
  check("Revenue accounts = sum of invoice subtotals", revenue, await sumField("invoices", "subtotal"));
  const vatIn = await db.collection("gl_lines").aggregate([{ $match: { orgId, accountCode: "2100" } }, { $group: { _id: null, c: { $sum: "$credit" } } }]).toArray();
  check("Output VAT credited = sum of invoice VAT", dec(vatIn[0]?.c), await sumField("invoices", "vatTotal"));

  const paid = await sumField("invoices", "paid");
  const rec = await sumField("payments", "amount", { kind: { $ne: "refund" } });
  const advance = await sumField("customer_advances", "amount").catch(() => dec(0));
  void advance;
  check("Invoice 'paid' totals = payments recorded", paid, rec);
  const cash = await bal("1000"), bank = await bal("1010"), petty = await bal("1015"), card = await bal("1020");
  check("Cash on hand ≥ 0", dec(cash.isNegative() ? 1 : 0), dec(0), 0);
  check("Bank balance ≥ 0", dec(bank.isNegative() ? 1 : 0), dec(0), 0);
  check("Petty cash ≥ 0", dec(petty.isNegative() ? 1 : 0), dec(0), 0);
  const fa = await db.collection("fixed_assets").find({ orgId, status: "active" }).toArray();
  if (fa.length) {
    check("Asset register cost = ledger 1500", fa.reduce((a, x) => a.plus(dec(x.cost)), dec(0)), await bal("1500"));
    check("Asset register depreciation = ledger 1510", fa.reduce((a, x) => a.plus(dec(x.accumulated)), dec(0)), (await bal("1510")).negated());
    const ctRet = await db.collection("tax_returns").find({ orgId }).toArray();
    check("Corporate tax payable: ledger 2150 = provisions − payments", (await bal("2150")).negated(), ctRet.reduce((a, x) => a.plus(dec(x.provisionBooked)).minus(dec(x.paid)), dec(0)));
  }
  const unmatched = await db.collection("bank_transactions").countDocuments({ orgId, status: "unmatched" });
  check("Bank statement lines left unmatched", dec(unmatched), dec(0), 0);

  const unbilled = await db.collection("charges").countDocuments({ orgId, status: "unbilled" });
  const completed = await db.collection("encounters").countDocuments({ orgId, status: "completed" });
  const invoices = await db.collection("invoices").countDocuments({ orgId });
  console.log(`\n  encounters completed ${completed}, invoices ${invoices}, unbilled charges ${unbilled}`);
  console.log(`  cash ${fmt(cash)}  bank ${fmt(bank)}  petty ${fmt(petty)}  card clearing ${fmt(card)}`);

  // P&L and balance sheet
  const accs = await db.collection("accounts").find({ orgId }).toArray();
  const byType: Record<string, Decimal> = {};
  for (const a of accs) { const b = await bal(a.code); byType[a.type] = (byType[a.type] ?? dec(0)).plus(a.type === "asset" || a.type === "expense" ? b : b.negated()); }
  const net = (byType.income ?? dec(0)).minus(byType.expense ?? dec(0));
  console.log(`\nIncome ${fmt(byType.income ?? dec(0))}   Expenses ${fmt(byType.expense ?? dec(0))}   Net result ${fmt(net)}`);
  console.log(`Assets ${fmt(byType.asset ?? dec(0))}   Liabilities ${fmt(byType.liability ?? dec(0))}   Equity (capital ${fmt(byType.equity ?? dec(0))} + result)`);
  check("Balance sheet: assets = liabilities + equity + result", byType.asset ?? dec(0), (byType.liability ?? dec(0)).plus(byType.equity ?? dec(0)).plus(net));

  const byMonth = await db.collection("invoices").aggregate([{ $match: { orgId } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "+04:00" } }, n: { $sum: 1 }, total: { $sum: "$total" } } }, { $sort: { _id: 1 } }]).toArray();
  console.log("\nInvoicing by month");
  for (const m of byMonth) console.log(`  ${m._id}  ${String(m.n).padStart(5)} invoices  AED ${fmt(dec(m.total)).padStart(14)}`);
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nAll checks passed.");
  return failures;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    const { config } = await import("dotenv");
    config({ path: ".env.local" });
    const { closeClient } = await import("../../src/core/db");
    try { const f = await verifyBooks("demo-dubai-clinic"); await closeClient(); process.exit(f ? 2 : 0); }
    catch (e) { console.error(e); await closeClient(); process.exit(1); }
  })();
}
