/**
 * Demo data for the Accounts section: catalogue items and a few months of expenses (including a marketing spike and a look-alike
 * pair) so the AI CFO has something to find. Goes through the real services. Safe to re-run: skips if items already exist.
 * Usage: npx tsx scripts/seed-accounts.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const ORG = "demo-dubai-clinic";

async function main() {
  const { ensureIndexes, closeClient } = await import("../src/core/db");
  const { permissionsFor } = await import("../src/core/rbac/roles");
  const items = await import("../src/modules/accounts/items");
  const { recordExpense } = await import("../src/modules/finance/expenses");
  await ensureIndexes();
  const ctx = { userId: "seed-finance", orgId: ORG, branchId: `${ORG}:main`, roles: ["finance_manager" as const], permissions: permissionsFor(["finance_manager"]) };
  if ((await items.listItems(ctx)).length > 0) { console.log("Accounts demo data already present."); await closeClient(); return; }

  const cat: [string, string, string, "STD" | "ZERO" | "EXEMPT", string][] = [
    ["MED-PRE", "Pre-employment medical", "180", "STD", "4500"], ["VAC-FLU", "Flu vaccination", "65", "ZERO", "4500"],
    ["CHK-EXE", "Executive health check", "1250", "STD", "4500"], ["MED-DRV", "Driver fitness medical", "220", "STD", "4500"],
    ["WEL-SES", "Workplace wellness session", "1500", "STD", "4500"], ["FIRST-AID", "First-aid training (per person)", "350", "STD", "4500"],
  ];
  for (const [sku, name, rate, vatRate, incomeCode] of cat) await items.createItem(ctx, { sku, name, rate, vatRate, incomeCode, kind: "service" });

  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86400000);
  type E = [number, string, string, string, string, "bank" | "cash" | "petty_cash"];
  const rows: E[] = [];
  for (let m = 5; m >= 0; m--) {
    const d = m * 30 + 4;
    rows.push([d, "5100", "Al Futtaim Properties", "Clinic rent", "45000", "bank"]);
    rows.push([d - 2, "5200", "DEWA", "Electricity and water", String(6200 + m * 140), "bank"]);
    rows.push([d - 3, "5300", "Gulf Medical Supplies", "Gloves, syringes, gauze", String(3600 + m * 90), "bank"]);
    rows.push([d - 5, "5700", "Meta Platforms", "Instagram campaign", m === 0 ? "8400" : String(3700 + m * 60), "bank"]);
    rows.push([d - 6, "5800", "Etisalat", "Internet and phones", "1450", "bank"]);
  }
  rows.push([2, "5300", "Gulf Medical Supplies LLC", "Gloves, syringes, gauze", String(3600), "bank"]); // look-alike of this month's order
  rows.push([9, "5600", "Biomed Services", "X-ray calibration", "2750", "bank"]);
  for (const [i, [days, category, vendor, description, net, paidFrom]] of rows.entries())
    await recordExpense(ctx, { date: ago(Math.max(1, days)), category, vendor, description: `${description}`, net, paidFrom, idempotencyKey: `seed-acc-exp-${i}` });
  console.log(`Seeded ${cat.length} items and ${rows.length} expenses.`);
  await closeClient();
}
main().catch((e) => { console.error(e); process.exit(1); });
