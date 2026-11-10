/**
 * MOCK DHA eClaimLink. A stand-in for DHA's test environment so the integration can be built and tested end to end with no onboarding.
 * It speaks the same four operations a facility uses (UploadTransaction, GetNewTransactions, DownloadTransactionFile,
 * SetTransactionDownloaded) over plain JSON/HTTP, with the XML payloads base64-encoded. The real service is SOAP: that envelope binding
 * belongs in client.ts once DHA issues the WSDL. Error codes and denial codes here are ILLUSTRATIVE, not DHA's published code lists.
 *
 * Payer behaviour is scripted and deterministic: a claim or prior request is "adjudicated" the next time the facility polls
 * (or after `delayMs`), using scenario overrides first and otherwise a seeded draw: ~86% paid, ~9% partly denied, ~5% fully denied.
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { buildPriorAuthorization, buildRemittance, kid, kids, parseDhaDate, parseXml, val, type XNode } from "./xml";

export type MockFacility = { facilityId: string; login: string; password: string };
export type Scenario = "paid" | "partial" | "denied";
export type MockOptions = {
  port?: number; facilities?: MockFacility[]; payers?: string[]; delayMs?: number;
  /** service codes that need a prior authorisation on the claim (denied with AUTH-001 otherwise) */
  authRequired?: string[]; /** prior requests for these codes are refused */ authRefused?: string[]; authLimit?: number;
};
type Tx = { fileId: string; fileName: string; xml: string; type: string; sender: string; receiver: string; recordCount: number; at: number; downloaded: boolean; direction: "in" | "out"; facilityId: string };
type Pending = { kind: "claim" | "prior"; id: string; facilityId: string; payer: string; xml: string; readyAt: number };

export const DENIAL = {
  AUTH: { code: "AUTH-001", text: "Prior authorization required and not provided" },
  CLINICAL: { code: "MNEC-003", text: "Service not clinically consistent with the diagnosis" },
  COVERAGE: { code: "CODE-010", text: "Service not covered under the member's plan" },
  DUPLICATE: { code: "DUPL-001", text: "Duplicate service already paid" },
};

export type MockDha = {
  url: string; close(): Promise<void>; port: number;
  /** force the outcome for a claim ID (or prior request ID with "paid" = approve, "denied" = refuse) */
  scenario(id: string, outcome: Scenario): void;
  /** adjudicate everything pending right now */
  process(): number;
  transactions(): Tx[]; reset(): void; setDelay(ms: number): void;
};

const hash = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

export async function startMockDha(opts: MockOptions = {}): Promise<MockDha> {
  const facilities = opts.facilities ?? [{ facilityId: "DHA-F-0083721", login: "elister_test", password: "Mock-Only-Pass-1" }];
  const payers = new Set(opts.payers ?? ["DAMAN", "NAS", "SUKOON", "GIG", "CIGNA", "METLIFE", "ORIENT"]);
  const authRequired = new Set(opts.authRequired ?? ["DENT-RCT", "DENT-SURGEXT", "DERM-BIOPSY"]);
  const authRefused = new Set(opts.authRefused ?? ["AES-BOTOX", "AES-FILLER"]);
  let delayMs = opts.delayMs ?? 0;
  let txs: Tx[] = [], pending: Pending[] = [], seq = 0, raSeq = 0;
  const scenarios = new Map<string, Scenario>();
  const seenClaims = new Set<string>();
  const approvals = new Map<string, Set<string>>(); // claim member -> approved auth ids (by payer ref)

  const auth = (login?: string, pwd?: string) => facilities.find((f) => f.login === login && f.password === pwd);
  const addTx = (t: Omit<Tx, "fileId" | "at" | "downloaded">): Tx => { const x = { ...t, fileId: `TX${String(++seq).padStart(6, "0")}`, at: Date.now(), downloaded: false }; txs.push(x); return x; };

  /** Structural and business validation. Returns [] when acceptable, otherwise illustrative error lines. */
  function validate(root: XNode, f: MockFacility): string[] {
    const errs: string[] = [];
    const need = (n: XNode | undefined, path: string, label = path) => { if (!n || !val(n, path)) errs.push(`E-REQ: ${label} is required`); };
    const h = kid(root, "Header");
    if (!h) return ["E-STRUCT: Header is missing"];
    if (val(h, "SenderID") !== f.facilityId) errs.push(`E-SENDER: SenderID ${val(h, "SenderID")} does not match the authenticated facility`);
    if (!payers.has(val(h, "ReceiverID"))) errs.push(`E-RECEIVER: ReceiverID ${val(h, "ReceiverID")} is not a registered payer`);
    if (!parseDhaDate(val(h, "TransactionDate"))) errs.push("E-DATE: TransactionDate must be dd/MM/yyyy HH:mm");
    const records = root.name === "Claim.Submission" ? kids(root, "Claim") : kids(root, "Authorization");
    if (Number(val(h, "RecordCount")) !== records.length) errs.push(`E-COUNT: RecordCount ${val(h, "RecordCount")} does not match ${records.length} record(s)`);
    if (!records.length) errs.push("E-STRUCT: no records");
    for (const r of records) {
      for (const p of ["ID", "MemberID", "PayerID", "EmiratesIDNumber"]) need(r, p);
      if (!/^784-?\d{4}-?\d{7}-?\d$/.test(val(r, "EmiratesIDNumber"))) errs.push(`E-EID: ${val(r, "ID")} Emirates ID format is invalid`);
      if (!payers.has(val(r, "PayerID"))) errs.push(`E-PAYER: PayerID ${val(r, "PayerID")} is not registered`);
      const dx = kids(r, "Diagnosis");
      if (!dx.length || !dx.some((d) => val(d, "Type") === "Principal")) errs.push(`E-DIAG: ${val(r, "ID")} needs a Principal diagnosis`);
      for (const d of dx) if (!/^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?$/.test(val(d, "Code"))) errs.push(`E-DIAG: ${val(d, "Code")} is not an ICD-10 code`);
      const acts = kids(r, "Activity");
      if (!acts.length) errs.push(`E-ACT: ${val(r, "ID")} has no activities`);
      for (const a of acts) { for (const p of ["ID", "Type", "Code", "Net", "Clinician"]) need(a, p, `Activity/${p}`); if (!(Number(val(a, "Quantity")) > 0)) errs.push(`E-ACT: ${val(a, "ID")} quantity must be positive`); }
      if (root.name === "Claim.Submission") {
        const gross = Number(val(r, "Gross")), share = Number(val(r, "PatientShare")), net = Number(val(r, "Net"));
        if (Math.abs(gross - share - net) > 0.005) errs.push(`E-AMT: ${val(r, "ID")} Gross - PatientShare must equal Net`);
        const sum = acts.reduce((a, x) => a + Number(val(x, "Net")), 0);
        if (Math.abs(sum - net) > 0.005) errs.push(`E-AMT: ${val(r, "ID")} activity Net total ${sum.toFixed(2)} differs from claim Net ${net.toFixed(2)}`);
        const enc = kid(r, "Encounter");
        const s = parseDhaDate(val(enc, "Start")), e = parseDhaDate(val(enc, "End"));
        if (!s || !e || e < s) errs.push(`E-ENC: ${val(r, "ID")} encounter dates are invalid`);
        if (val(enc, "FacilityID") !== f.facilityId) errs.push(`E-ENC: encounter FacilityID does not match the facility`);
        if (seenClaims.has(`${f.facilityId}:${val(r, "ID")}`) && !kid(r, "Resubmission")) errs.push(`E-DUP: claim ${val(r, "ID")} was already submitted; send a Resubmission to correct it`);
      }
    }
    return errs;
  }

  function adjudicateClaim(p: Pending): string {
    const root = parseXml(p.xml);
    const out = [];
    for (const c of kids(root, "Claim").filter((x) => val(x, "ID") === p.id)) {
      const id = val(c, "ID");
      const sc = scenarios.get(id) ?? (() => { const x = hash(id); return x < 0.86 ? "paid" : x < 0.95 ? "partial" : "denied"; })();
      const acts = kids(c, "Activity");
      const memberAuth = approvals.get(val(c, "MemberID"));
      const lines = acts.map((a, idx) => {
        const net = val(a, "Net"), code = val(a, "Code");
        const needsAuth = authRequired.has(code) && !(val(a, "PriorAuthorizationID") && memberAuth?.has(val(a, "PriorAuthorizationID")));
        if (needsAuth) return { id: val(a, "ID"), net, paid: "0.00", denialCode: DENIAL.AUTH.code };
        if (sc === "denied") return { id: val(a, "ID"), net, paid: "0.00", denialCode: DENIAL.COVERAGE.code };
        if (sc === "partial" && idx === acts.length - 1) return { id: val(a, "ID"), net, paid: (Number(net) * 0.5).toFixed(2), denialCode: DENIAL.CLINICAL.code };
        return { id: val(a, "ID"), net, paid: net };
      });
      out.push({ id, payerRef: `${p.payer}-${id}`, paymentReference: `RA-${p.payer}-${String(++raSeq).padStart(5, "0")}`, settled: new Date(), activities: lines });
    }
    return buildRemittance({ sender: p.payer, receiver: p.facilityId, at: new Date(), disposition: "TEST" }, out);
  }
  function adjudicatePrior(p: Pending): string {
    const root = parseXml(p.xml);
    const a = kids(root, "Authorization").find((x) => val(x, "ID") === p.id)!;
    const id = val(a, "ID");
    const acts = kids(a, "Activity");
    const total = acts.reduce((s, x) => s + Number(val(x, "Net")), 0);
    const forced = scenarios.get(id);
    const lines = acts.map((x) => ({ id: val(x, "ID"), approved: !authRefused.has(val(x, "Code")), denialCode: authRefused.has(val(x, "Code")) ? DENIAL.COVERAGE.code : undefined }));
    let approved = lines.every((l) => l.approved) && total <= (opts.authLimit ?? 20000);
    if (forced) approved = forced !== "denied";
    const payerRef = `AUTH-${p.payer}-${String(++raSeq).padStart(5, "0")}`;
    if (approved) { const set = approvals.get(val(a, "MemberID")) ?? new Set<string>(); set.add(payerRef); approvals.set(val(a, "MemberID"), set); }
    return buildPriorAuthorization({ sender: p.payer, receiver: p.facilityId, at: new Date(), disposition: "TEST" }, {
      requestId: id, approved, payerRef: approved ? payerRef : "", start: new Date(), end: new Date(Date.now() + 30 * 86400000), limit: String(total),
      comments: approved ? "Approved as requested" : "Not approved: service excluded, limit exceeded or manual review required",
      activities: approved ? lines.map((l) => ({ ...l, approved: true, denialCode: undefined })) : lines,
    });
  }
  function process(): number {
    const due = pending.filter((p) => p.readyAt <= Date.now());
    pending = pending.filter((p) => p.readyAt > Date.now());
    for (const p of due) {
      const xml = p.kind === "claim" ? adjudicateClaim(p) : adjudicatePrior(p);
      addTx({ fileName: `${p.kind === "claim" ? "RA" : "PA"}_${p.payer}_${seq + 1}.xml`, xml, type: p.kind === "claim" ? "Claim.Remittance" : "Prior.Authorization", sender: p.payer, receiver: p.facilityId, recordCount: 1, direction: "in", facilityId: p.facilityId });
    }
    return due.length;
  }

  const handlers: Record<string, (b: Record<string, string>) => unknown> = {
    "/eclaimlink/UploadTransaction": (b) => {
      const f = auth(b.login, b.pwd);
      if (!f) return { code: 1, message: "E-AUTH: invalid login or password" };
      let xml: string, root: XNode;
      try { xml = unb64(b.fileBase64 ?? ""); root = parseXml(xml); } catch (e) { return { code: 1, message: (e as Error).message, errorReportBase64: b64((e as Error).message) }; }
      if (!["Claim.Submission", "Prior.Request"].includes(root.name)) return { code: 1, message: `E-TYPE: unsupported transaction ${root.name}` };
      const errs = validate(root, f);
      if (errs.length) return { code: 1, message: errs[0], errorReportBase64: b64(errs.join("\n")), errors: errs };
      const h = kid(root, "Header")!;
      const tx = addTx({ fileName: b.fileName ?? "upload.xml", xml, type: root.name, sender: f.facilityId, receiver: val(h, "ReceiverID"), recordCount: Number(val(h, "RecordCount")), direction: "out", facilityId: f.facilityId });
      tx.downloaded = true;
      for (const r of root.name === "Claim.Submission" ? kids(root, "Claim") : kids(root, "Authorization")) {
        if (root.name === "Claim.Submission") seenClaims.add(`${f.facilityId}:${val(r, "ID")}`);
        pending.push({ kind: root.name === "Claim.Submission" ? "claim" : "prior", id: val(r, "ID"), facilityId: f.facilityId, payer: val(h, "ReceiverID"), readyAt: Date.now() + delayMs, xml });
      }
      return { code: 0, message: "Transaction accepted", transactionId: tx.fileId };
    },
    "/eclaimlink/GetNewTransactions": (b) => {
      const f = auth(b.login, b.pwd);
      if (!f) return { code: 1, message: "E-AUTH: invalid login or password", transactions: [] };
      process();
      return { code: 0, message: "OK", transactions: txs.filter((t) => t.direction === "in" && t.facilityId === f.facilityId && !t.downloaded).map((t) => ({ fileId: t.fileId, fileName: t.fileName, recordCount: t.recordCount, senderId: t.sender, transactionType: t.type })) };
    },
    "/eclaimlink/DownloadTransactionFile": (b) => {
      const f = auth(b.login, b.pwd);
      if (!f) return { code: 1, message: "E-AUTH: invalid login or password" };
      const t = txs.find((x) => x.fileId === b.fileId && x.facilityId === f.facilityId && x.direction === "in");
      return t ? { code: 0, fileName: t.fileName, fileBase64: b64(t.xml) } : { code: 1, message: "E-NOTFOUND: transaction not found" };
    },
    "/eclaimlink/SetTransactionDownloaded": (b) => {
      const f = auth(b.login, b.pwd);
      if (!f) return { code: 1, message: "E-AUTH: invalid login or password" };
      const t = txs.find((x) => x.fileId === b.fileId && x.facilityId === f.facilityId);
      if (!t) return { code: 1, message: "E-NOTFOUND: transaction not found" };
      t.downloaded = true;
      return { code: 0, message: "OK" };
    },
    /** Payer-portal style eligibility: member numbers ending in 0 are not active; ending in 9 are active but not covered for dental. */
    "/eligibility": (b) => {
      const f = auth(b.login, b.pwd);
      if (!f) return { code: 1, message: "E-AUTH: invalid login or password" };
      if (!payers.has(b.payerId)) return { code: 1, message: `E-PAYER: ${b.payerId} is not registered` };
      const active = !(b.memberId ?? "").endsWith("0");
      return { code: 0, eligible: active, reference: `ELG-${b.payerId}-${hash(b.memberId ?? "").toFixed(6).slice(2)}`, notes: active ? ((b.memberId ?? "").endsWith("9") ? "Active; dental not covered" : "Active") : "Policy inactive or member not found" };
    },
  };

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        const url = (req.url ?? "").split("?")[0];
        // Requests that came through Cloudflare carry cf-connecting-ip: the admin controls are local-only.
        if (url.startsWith("/admin/") && req.headers["cf-connecting-ip"]) return send(403, { code: 1, message: "Admin endpoints are not available over the public address" });
        if (req.method === "GET" && url === "/admin/state") return send(200, { transactions: txs.map(({ xml, ...t }) => { void xml; return t; }), pending: pending.length });
        if (req.method === "POST" && url === "/admin/process") return send(200, { processed: process() });
        if (req.method === "POST" && url === "/admin/scenario") { const j = JSON.parse(data || "{}"); scenarios.set(j.id, j.outcome); return send(200, { ok: true }); }
        if (req.method === "POST" && url === "/admin/reset") { txs = []; pending = []; seenClaims.clear(); approvals.clear(); scenarios.clear(); return send(200, { ok: true }); }
        const h = handlers[url];
        if (req.method !== "POST" || !h) return send(404, { code: 1, message: "Unknown operation" });
        return send(200, h(JSON.parse(data || "{}")));
      } catch (e) { return send(500, { code: 1, message: `E-SERVER: ${(e as Error).message}` }); }
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, port,
    close: () => new Promise((r) => server.close(() => r())),
    scenario: (id, o) => void scenarios.set(id, o), process, transactions: () => txs, reset: () => { txs = []; pending = []; seenClaims.clear(); approvals.clear(); scenarios.clear(); }, setDelay: (ms) => { delayMs = ms; },
  };
}
