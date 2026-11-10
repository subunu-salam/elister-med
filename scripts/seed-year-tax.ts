/**
 * Adds the corporate-tax and fixed-asset layer to the one-year dataset in .seed-cache/year (run after `npm run seed:year`):
 * loads the cache into a throw-away database, registers the clinic's equipment so the register ties to the ledger, records tagged
 * expenses (entertainment, fines), sets up corporate tax and files the FY2025 return, verifies, and writes the cache back.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs";
import path from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, BSON, type Document } from "mongodb";
import { installClock, setNow, uninstallClock } from "./year/clock";

const ORG = "demo-dubai-clinic";
const cache = path.resolve(".seed-cache/year");

async function main() {
  if (!fs.existsSync(path.join(cache, "_meta.json"))) throw new Error("Run `npm run seed:year` first.");
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    MONGODB_URI: rs.getUri(), MONGODB_DB: "healthos_year", AUTH_SECRET: "local-dev-secret-local-dev-secret-0123456789", BETTER_AUTH_URL: "http://localhost:3000",
    FIELD_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"), DISPLAY_KEY: "local-display-key",
  });
  delete process.env.TEST_MONGODB_URI;
  const raw = await new MongoClient(rs.getUri()).connect();
  const rdb = raw.db("healthos_year");
  for (const f of fs.readdirSync(cache).filter((x) => x.endsWith(".ejson"))) {
    const docs = fs.readFileSync(path.join(cache, f), "utf8").split("\n").filter(Boolean).map((l) => BSON.EJSON.parse(l, { relaxed: false }) as Document);
    for (let i = 0; i < docs.length; i += 1000) await rdb.collection(f.replace(".ejson", "")).insertMany(docs.slice(i, i + 1000));
  }
  const { ensureIndexes, closeClient, getDb } = await import("../src/core/db");
  const { permissionsFor } = await import("../src/core/rbac/roles");
  await ensureIndexes();
  const mk = (roles: import("../src/core/rbac/roles").RoleKey[], userId: string) => ({ userId, orgId: ORG, branchId: `${ORG}:main`, roles, permissions: permissionsFor(roles) });
  const fm = mk(["finance_manager"], "seed-finance"), acct = mk(["accountant"], "seed-accountant");
  const CT = await import("../src/modules/tax/corporateTax");
  const FA = await import("../src/modules/assets/service");
  const EX = await import("../src/modules/finance/expenses");
  const { fromDecimal128, money } = await import("../src/core/money");
  const db = await getDb();
  await CT.ensureTaxAccounts(ORG); await FA.ensureAssetAccounts(ORG);

  // ---- asset register, loaded to match the ledger exactly (cost 1500, accumulated depreciation 1510) ----
  const bal = async (code: string) => { const a = await db.collection("gl_lines").aggregate([{ $match: { orgId: ORG, accountCode: code } }, { $group: { _id: null, d: { $sum: "$debit" }, c: { $sum: "$credit" } } }]).toArray(); return fromDecimal128(a[0]?.d).minus(fromDecimal128(a[0]?.c)); };
  const cost = await bal("1500"), acc = (await bal("1510")).negated();
  const lastDep = (await db.collection("journal_entries").find({ orgId: ORG, "sourceRef.type": "manual", memo: /^Monthly depreciation/ }).sort({ date: -1 }).limit(1).toArray())[0];
  const through = lastDep ? new Date(lastDep.date.getTime() + 4 * 3600_000).toISOString().slice(0, 7) : "2026-10";
  const LIST: [string, string, number, string, number, string][] = [
    ["Dental chair unit 1", "Dental equipment", 52000, "2025-10-20", 60, "Dental surgery 1"], ["Dental chair unit 2", "Dental equipment", 52000, "2025-10-20", 60, "Dental surgery 2"], ["Dental chair unit 3", "Dental equipment", 52000, "2025-10-22", 60, "Dental surgery 3"],
    ["Digital X-ray system (DR)", "Imaging equipment", 98000, "2025-10-18", 60, "Imaging room"], ["Orthopantomogram (OPG) unit", "Imaging equipment", 85000, "2025-10-18", 60, "Imaging room"],
    ["Ultrasound scanner (general + OB)", "Imaging equipment", 64000, "2025-10-25", 60, "Imaging room"], ["Class B autoclaves (2)", "Medical equipment", 29000, "2025-10-27", 60, "Sterilisation room"],
    ["Haematology and chemistry analysers", "Laboratory equipment", 46000, "2025-10-28", 60, "Laboratory"], ["Clinic fit-out and partitions", "Furniture and fit-out", 90000, "2025-10-10", 60, "Premises"],
    ["Reception, waiting-area and consulting furniture", "Furniture and fit-out", 42000, "2025-10-30", 60, "Premises"], ["IT hardware, network and clinic workstations", "IT and software", 40000, "2025-10-31", 60, "Premises"],
  ];
  const total = LIST.reduce((a, r) => a + r[2], 0);
  if (!money(total).equals(cost)) throw new Error(`Register total ${total} differs from ledger cost ${cost.toFixed(2)}`);
  let left = acc;
  for (const [i, [name, category, c, date, life, location]] of LIST.entries()) {
    const share = i === LIST.length - 1 ? left : acc.times(c).div(total).toDecimalPlaces(2);
    left = left.minus(share);
    await FA.registerAsset(acct, { name, category, cost: c.toFixed(2), lifeMonths: life, purchaseDate: new Date(`${date}T10:00:00+04:00`), startMonth: "2025-11", location, vendor: "Dubai Dental Depot LLC", alreadyInLedger: { accumulated: share.toFixed(2), depreciatedThrough: through } });
  }

  // ---- tagged expenses (feed corporate-tax add-backs) ----
  const E = (date: string, category: string, vendor: string, description: string, net: string, treatment: "entertainment_50" | "non_deductible", paidFrom: "bank" | "card_clearing", key: string, vat: "STD" | "ZERO" = "STD") =>
    EX.recordExpense(acct, { date: new Date(`${date}T12:00:00+04:00`), category, vendor, description, net, vatRate: vat, paidFrom, treatment, idempotencyKey: key, reference: `INV-${key}` });
  await E("2026-03-12", "5700", "Jumeirah Events & Catering LLC", "Ramadan iftar for referring physicians and corporate clients", "6800.00", "entertainment_50", "bank", "ent-ramadan");
  await E("2026-05-08", "5700", "Al Barari Hospitality LLC", "Dental conference sponsor dinner", "3400.00", "entertainment_50", "bank", "ent-dental");
  await E("2026-09-16", "5700", "Burj Gardens Restaurant", "Insurance network relationship lunch", "1850.00", "entertainment_50", "card_clearing", "ent-lunch");
  await E("2026-04-21", "5800", "Dubai Police - traffic fines", "Company vehicle fines", "1200.00", "non_deductible", "bank", "fine-rta", "ZERO");
  await E("2026-08-17", "5800", "Dubai Municipality", "Administrative penalty (signage permit)", "3000.00", "non_deductible", "bank", "fine-dm", "ZERO");

  // ---- corporate tax set-up ----
  setNow(new Date("2026-02-02T10:00:00+04:00")); installClock(); setNow(new Date("2026-02-02T10:00:00+04:00"));
  await CT.setTaxConfig(fm, { trn: "100469715300003", registered: true, sbrElected: false, firstYear: 2025, lossesBroughtForward: "0.00", notes: "Small Business Relief not elected: it would forgo loss carry-forward in the start-up year." });
  setNow(new Date("2026-09-22T11:00:00+04:00"));
  const c25 = await CT.computeCorporateTax(fm, 2025);
  await CT.provisionCorporateTax(fm, 2025);
  await CT.markReturnFiled(fm, { year: 2025, reference: "EMT-CT-2025-0004127" });
  uninstallClock();
  const c26 = await CT.computeCorporateTax(fm, 2026);
  await CT.provisionCorporateTax(fm, 2026);
  console.log(`FY2025: profit ${c25.accountingProfit.toFixed(2)}  tax ${c25.tax.toFixed(2)}  loss c/f ${c25.lossCarriedForward.toFixed(2)}`);
  console.log(`FY2026 (to date): profit ${c26.accountingProfit.toFixed(2)}  add-backs ${c26.addBacks.map((a) => `${a.label} ${a.amount.toFixed(2)}`).join("; ")}  loss c/f ${c26.lossCarriedForward.toFixed(2)}  tax ${c26.tax.toFixed(2)}`);
  const s = await FA.assetRegisterSummary(acct);
  console.log(`Asset register: cost ${s.cost.toFixed(2)} accumulated ${s.accumulated.toFixed(2)} NBV ${s.nbv.toFixed(2)} reconciled ${s.reconciled}`);

  // ---- re-export the cache, then verify ----
  await closeClient();
  const names = (await rdb.listCollections().toArray()).map((x) => x.name).filter((n) => !n.startsWith("system.") && n !== "session" && n !== "verification");
  let total2 = 0;
  for (const n of names) {
    const out = fs.createWriteStream(path.join(cache, `${n}.ejson`));
    for await (const d of rdb.collection(n).find({})) { out.write(BSON.EJSON.stringify(d, { relaxed: false }) + "\n"); total2++; }
    await new Promise((r) => out.end(r));
  }
  const meta = JSON.parse(fs.readFileSync(path.join(cache, "_meta.json"), "utf8"));
  fs.writeFileSync(path.join(cache, "_meta.json"), JSON.stringify({ ...meta, collections: names, docsTotal: total2, taxLayerAt: new Date().toISOString() }));
  const { verifyBooks } = await import("./year/verify");
  const bad = await verifyBooks(ORG);
  await raw.close(); await rs.stop();
  process.exit(bad ? 2 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
