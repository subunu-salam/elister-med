/**
 * Adds corporate-customer activity (occupational health contracts, a kiosk tenant, a hotel plan) to the demo organisation through the
 * real services, so every posting is balanced and dated. Safe to re-run: it does nothing if the customers already exist.
 * Usage: npx tsx scripts/seed-books.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const ORG = "demo-dubai-clinic";
const at = (y: number, m: number, d: number) => new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T10:00:00+04:00`);

async function main() {
  const { ensureIndexes, closeClient } = await import("../src/core/db");
  const { permissionsFor } = await import("../src/core/rbac/roles");
  const bk = await import("../src/modules/books/service");
  await ensureIndexes();
  const ctx = { userId: "seed-finance", orgId: ORG, branchId: `${ORG}:main`, roles: ["finance_manager" as const], permissions: permissionsFor(["finance_manager"]) };
  const existing = await bk.listCustomers(ctx);
  if ((await bk.listTradeInvoices(ctx)).length > 0) { console.log("Business books demo data already present."); await closeClient(); return; }

  const mk = async (name: string, trn: string, terms: number, email: string) => existing.find((c) => c.name === name) ?? bk.createCustomer(ctx, { name, trn, termsDays: terms, email, phone: "+97143000000" });
  const logi = await mk("Emirates Logistics Group LLC", "100345678900003", 30, "accounts@emiratelogistics.example");
  const hotel = await mk("Palm Crescent Hotels LLC", "100456789010003", 45, "finance@palmcrescent.example");
  const build = await mk("Al Noor Contracting LLC", "100567890120003", 30, "hr@alnoor.example");
  const kiosk = await mk("Green Leaf Pharmacy Kiosk", "100678901230003", 15, "owner@greenleaf.example");

  let k = 0;
  const key = () => `seed-books-${k++}`;
  const inv = (customerId: string, date: Date, lines: string, issue = true) => bk.createInvoice(ctx, { customerId, issueDate: date, lines: bk.parseLines(lines, "4500"), issue, idempotencyKey: key() });
  const pay = (customerId: string, invoiceId: string | undefined, amount: string, date: Date, method: "bank" | "cash" = "bank") => bk.recordReceipt(ctx, { customerId, invoiceId, amount, method, date, idempotencyKey: key(), reference: "Bank transfer" });

  // Monthly occupational-health contract: logistics drivers' fitness-to-work medicals, paid within terms except the most recent two.
  for (let m = 1; m <= 10; m++) {
    const i = await inv(logi._id, at(2026, m, 5), `Driver fitness medicals | ${20 + m} | 220 | STD\nChest X-ray screening | ${20 + m} | 90 | STD\nOnsite vaccination day | 1 | 1500 | ZERO`);
    if (m <= 8) await pay(logi._id, i._id, (Number(i.total.toString())).toFixed(2), at(2026, m, 28));
  }
  // Hotel annual staff wellness plan, billed quarterly, one quarter part-paid.
  const q: string[] = [];
  for (const [m, id] of [[1, 0], [4, 1], [7, 2], [10, 3]] as const) {
    const i = await inv(hotel._id, at(2026, m, 3), "Staff wellness plan (quarter) | 1 | 18000 | STD\nFlu vaccination programme | 120 | 65 | ZERO");
    q.push(i._id);
    if (id < 2) await pay(hotel._id, i._id, Number(i.total.toString()).toFixed(2), at(2026, m + 1, 14));
    if (id === 2) await pay(hotel._id, i._id, "10000.00", at(2026, 8, 20));
  }
  // Construction firm: pre-employment medicals, one credit note for no-shows, one on-account advance.
  const b1 = await inv(build._id, at(2026, 3, 12), "Pre-employment medicals | 60 | 180 | STD\nTB screening | 60 | 70 | STD");
  await pay(build._id, b1._id, Number(b1.total.toString()).toFixed(2), at(2026, 4, 9));
  const b2 = await inv(build._id, at(2026, 8, 10), "Pre-employment medicals | 45 | 180 | STD\nTB screening | 45 | 70 | STD");
  await bk.issueTradeCreditNote(ctx, { customerId: build._id, invoiceId: b2._id, lines: bk.parseLines("Medicals not attended | 5 | 180 | STD", "4500"), reason: "5 workers did not attend", idempotencyKey: key() });
  await pay(build._id, undefined, "5000.00", at(2026, 10, 2));
  // Pharmacy kiosk tenant: monthly rent via a recurring profile, caught up to today.
  await bk.createRecurring(ctx, { name: "Pharmacy kiosk rent", customerId: kiosk._id, frequency: "monthly", startDate: at(2026, 9, 1), lines: bk.parseLines("Kiosk space rent | 1 | 4500 | STD | 4800", "4500") });
  console.log("recurring invoices generated:", await bk.runDueRecurring(ctx));
  const s = await bk.booksSummary(ctx), ar = await bk.tradeAging(ctx);
  console.log("corporate AR total", ar.total.toFixed(2), "| receivables all", s.receivables.toFixed(2));
  await closeClient();
}
main().catch((e) => { console.error(e); process.exit(1); });
