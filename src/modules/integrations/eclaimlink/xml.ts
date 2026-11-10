/**
 * eClaimLink-style XML: builders for what a facility sends (Claim.Submission, Prior.Request) and for what a payer returns
 * (Claim.Remittance, Prior.Authorization), plus a small parser. The element layout follows the publicly documented structure of the
 * DHA eClaimLink / DOH Shafafiya transaction family, but it is NOT certified against DHA's current schema: replace or confirm it with the
 * XSDs DHA issues at vendor onboarding. Everything that depends on the exact schema lives in this file.
 */
export type XNode = { name: string; text: string; children: XNode[] };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
type Child = string | null | undefined | false;

export function el(name: string, content?: string | number | Child[]): string {
  if (content === undefined || content === null) return `<${name}/>`;
  if (Array.isArray(content)) return `<${name}>${content.filter(Boolean).join("")}</${name}>`;
  return `<${name}>${esc(String(content))}</${name}>`;
}

/** Tolerant parser for the simple, attribute-free documents used here. */
export function parseXml(src: string): XNode {
  const s = src.replace(/^﻿/, "").replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  let i = 0;
  const node = (): XNode => {
    if (s[i] !== "<") throw new Error("Malformed XML: expected '<'");
    const end = s.indexOf(">", i);
    if (end < 0) throw new Error("Malformed XML: unterminated tag");
    const raw = s.slice(i + 1, end);
    const selfClosing = raw.endsWith("/");
    const name = raw.replace(/\/$/, "").trim().split(/\s+/)[0];
    if (!name || name.startsWith("/")) throw new Error("Malformed XML: unexpected closing tag");
    i = end + 1;
    const n: XNode = { name, text: "", children: [] };
    if (selfClosing) return n;
    for (;;) {
      if (i >= s.length) throw new Error(`Malformed XML: <${name}> is not closed`);
      if (s.startsWith("</", i)) {
        const e = s.indexOf(">", i);
        const close = s.slice(i + 2, e).trim();
        if (close !== name) throw new Error(`Malformed XML: </${close}> closes <${name}>`);
        i = e + 1;
        n.text = unesc(n.text.trim());
        return n;
      }
      if (s[i] === "<") n.children.push(node());
      else { const nx = s.indexOf("<", i); n.text += s.slice(i, nx < 0 ? s.length : nx); i = nx < 0 ? s.length : nx; }
    }
  };
  const root = node();
  if (s.slice(i).trim()) throw new Error("Malformed XML: content after the root element");
  return root;
}
export const kids = (n: XNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : []);
export const kid = (n: XNode | undefined, name: string) => kids(n, name)[0];
export const val = (n: XNode | undefined, name: string) => kid(n, name)?.text ?? "";

/** dd/MM/yyyy HH:mm in Dubai time, the format eClaimLink transactions use. */
export const dhaDate = (d: Date) => {
  const l = new Date(d.getTime() + 4 * 3600_000), p = (n: number) => String(n).padStart(2, "0");
  return `${p(l.getUTCDate())}/${p(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
};
export const parseDhaDate = (s: string): Date | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(s.trim());
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+04:00`) : null;
};
const amt = (n: string | number) => Number(n).toFixed(2);

export type Header = { sender: string; receiver: string; at: Date; count: number; disposition: "PRODUCTION" | "TEST" };
const header = (h: Header) => el("Header", [el("SenderID", h.sender), el("ReceiverID", h.receiver), el("TransactionDate", dhaDate(h.at)), el("RecordCount", h.count), el("DispositionFlag", h.disposition)]);

export type ActivityIn = { id: string; start: Date; type: number; code: string; quantity: number; net: string; clinician: string; priorAuth?: string };
export type ClaimIn = {
  id: string; memberId: string; payerId: string; providerId: string; emiratesId: string; gross: string; patientShare: string; net: string;
  encounter: { facilityId: string; type: number; patientId: string; start: Date; end: Date };
  diagnoses: { type: "Principal" | "Secondary"; code: string }[]; activities: ActivityIn[]; resubmission?: { type: string; comment: string };
};
const activity = (a: ActivityIn) => el("Activity", [el("ID", a.id), el("Start", dhaDate(a.start)), el("Type", a.type), el("Code", a.code), el("Quantity", a.quantity), el("Net", amt(a.net)), el("Clinician", a.clinician), a.priorAuth ? el("PriorAuthorizationID", a.priorAuth) : null]);

export function buildClaimSubmission(h: Omit<Header, "count">, claims: ClaimIn[]): string {
  const body = claims.map((c) => el("Claim", [
    el("ID", c.id), el("MemberID", c.memberId), el("PayerID", c.payerId), el("ProviderID", c.providerId), el("EmiratesIDNumber", c.emiratesId),
    el("Gross", amt(c.gross)), el("PatientShare", amt(c.patientShare)), el("Net", amt(c.net)),
    el("Encounter", [el("FacilityID", c.encounter.facilityId), el("Type", c.encounter.type), el("PatientID", c.encounter.patientId), el("Start", dhaDate(c.encounter.start)), el("End", dhaDate(c.encounter.end)), el("StartType", 1), el("EndType", 1)]),
    ...c.diagnoses.map((d) => el("Diagnosis", [el("Type", d.type), el("Code", d.code)])),
    ...c.activities.map(activity),
    c.resubmission ? el("Resubmission", [el("Type", c.resubmission.type), el("Comment", c.resubmission.comment)]) : null,
  ])).join("");
  return `<?xml version="1.0" encoding="utf-8"?><Claim.Submission>${header({ ...h, count: claims.length })}${body}</Claim.Submission>`;
}

export type PriorIn = { id: string; memberId: string; payerId: string; emiratesId: string; ordered: Date; facilityId: string; diagnoses: { type: "Principal" | "Secondary"; code: string }[]; activities: ActivityIn[] };
export function buildPriorRequest(h: Omit<Header, "count">, p: PriorIn): string {
  return `<?xml version="1.0" encoding="utf-8"?><Prior.Request>${header({ ...h, count: 1 })}${el("Authorization", [
    el("Type", "Authorization"), el("ID", p.id), el("MemberID", p.memberId), el("PayerID", p.payerId), el("EmiratesIDNumber", p.emiratesId), el("DateOrdered", dhaDate(p.ordered)),
    el("Encounter", [el("FacilityID", p.facilityId), el("Type", 1)]), ...p.diagnoses.map((d) => el("Diagnosis", [el("Type", d.type), el("Code", d.code)])), ...p.activities.map(activity),
  ])}</Prior.Request>`;
}

// ----- payer side (used by the mock server, and the shape the poller expects) -----
export type RemitActivity = { id: string; net: string; paid: string; denialCode?: string };
export type RemitClaim = { id: string; payerRef: string; paymentReference: string; settled: Date; activities: RemitActivity[] };
export function buildRemittance(h: Omit<Header, "count">, claims: RemitClaim[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><Claim.Remittance>${header({ ...h, count: claims.length })}${claims.map((c) => el("Claim", [
    el("ID", c.id), el("IDPayer", c.payerRef), el("PaymentReference", c.paymentReference), el("DateSettlement", dhaDate(c.settled)),
    ...c.activities.map((a) => el("Activity", [el("ID", a.id), el("Net", amt(a.net)), el("PaymentAmount", amt(a.paid)), a.denialCode ? el("DenialCode", a.denialCode) : null])),
  ])).join("")}</Claim.Remittance>`;
}
export type AuthDecision = { requestId: string; approved: boolean; payerRef: string; start: Date; end: Date; limit: string; comments: string; activities: { id: string; approved: boolean; denialCode?: string }[] };
export function buildPriorAuthorization(h: Omit<Header, "count">, a: AuthDecision): string {
  return `<?xml version="1.0" encoding="utf-8"?><Prior.Authorization>${header({ ...h, count: 1 })}${el("Authorization", [
    el("Result", a.approved ? "Yes" : "No"), el("ID", a.requestId), el("IDPayer", a.payerRef), el("Start", dhaDate(a.start)), el("End", dhaDate(a.end)), el("Limit", amt(a.limit)), el("Comments", a.comments),
    ...a.activities.map((x) => el("Activity", [el("ID", x.id), el("Result", x.approved ? "Yes" : "No"), x.denialCode ? el("DenialCode", x.denialCode) : null])),
  ])}</Prior.Authorization>`;
}
