import type { ReactNode } from "react";
import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, Stat, Table, aed } from "@/ui/kit";
import { ActionForm, fmtDate } from "@/ui/forms";
import { dispatch } from "@/app/(app)/dispatch";
import { latestEligibility, listPlans, listPolicies, listPreauths } from "@/modules/insurance/masters";
import { listClaims } from "@/modules/insurance/claims";
import { listUnbilledCharges } from "@/modules/billing/charges";
import { PatientPicker } from "../appointments/PatientPicker";

type C = Awaited<ReturnType<typeof requireCtx>>;

function Step({ n, title, state, children }: { n: number; title: string; state: "done" | "todo" | "wait" | "skip"; children?: ReactNode }) {
  const tone = state === "done" ? "ok" : state === "wait" ? "warn" : "neutral";
  const word = state === "done" ? "Done" : state === "wait" ? "Waiting" : state === "skip" ? "Not needed" : "To do";
  return (
    <div className="rounded-ui border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2"><span className="brand-grad flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white">{n}</span><h3 className="text-sm font-semibold">{title}</h3><Badge tone={tone}>{word}</Badge></div>
      {children}
    </div>
  );
}

export async function Guide({ ctx }: { ctx: C }) {
  const claimsAll = await listClaims(ctx);
  const pre = await listPreauths(ctx);
  const count = (st: string[]) => claimsAll.filter((c) => st.includes(c.status)).length;
  const steps: [string, string, string][] = [
    ["1. Add the patient's policy", "Pick the patient, choose their plan and type the member number from the insurance card.", "/insurance?tab=patient"],
    ["2. Check coverage", "Press Verify with payer. It asks the insurer through DHA eClaimLink whether the member is active. The answer is saved with a reference number.", "/insurance?tab=patient"],
    ["3. Get approval if the plan needs it", "Procedures such as MRI, surgery or some drugs need prior approval. The system tells you when it is required and fills the request in for you.", "/insurance?tab=preauth"],
    ["4. Treat, then bill", "After the visit the charges appear as unbilled. Tick them and press Create invoice and claim. The patient's co-pay and the insurer's share are worked out and posted to the ledger.", "/insurance?tab=patient"],
    ["5. Send the claim", "Open the claim, press Validate (it lists anything missing), then Submit. Rejected claims can be fixed and resubmitted.", "/insurance?tab=claims"],
    ["6. Record the payment", "When the insurer pays or denies, the remittance is read from eClaimLink or entered on the claim. Payments clear the receivable; denials stay visible until you resubmit or write off.", "/insurance?tab=recon"],
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Claims to send" value={count(["draft", "validated"])} hint="Draft or validated" />
        <Stat label="Waiting for insurer" value={count(["submitted", "accepted"])} />
        <Stat label="Rejected or part-paid" value={count(["rejected", "partially_paid"])} tone={count(["rejected"]) ? "warn" : undefined} hint="Need attention" />
        <Stat label="Pre-auths waiting" value={pre.filter((p) => p.status === "requested").length} />
      </div>
      <Card title="How an insured patient is handled, start to finish">
        <ol className="grid gap-3 md:grid-cols-2">{steps.map(([t, d, h]) => <li key={t} className="rounded-ui border border-border p-3"><a href={h} className="font-semibold text-primary hover:underline">{t}</a><p className="mt-1 text-sm text-muted">{d}</p></li>)}</ol>
        <p className="mt-3 text-sm text-muted">Patients paying cash or by card need none of this: bill them from <a className="text-primary hover:underline" href="/billing">Billing</a>. Companies you invoice directly are in <a className="text-primary hover:underline" href="/accounts/sales?tab=customers">Accounts → Sales</a>.</p>
      </Card>
    </div>
  );
}

export async function PatientTab({ ctx, patientId, back }: { ctx: C; patientId?: string; back: string }) {
  const plans = await listPlans(ctx);
  const policies = patientId ? await listPolicies(ctx, patientId) : [];
  const charges = patientId ? await listUnbilledCharges(ctx, patientId) : [];
  const allPre = patientId ? (await listPreauths(ctx)).filter((p) => p.patientId === patientId) : [];
  const here = `${back}&patientId=${patientId}`;
  const now = new Date();
  const active = policies.filter((p) => p.active && new Date(p.startDate) <= now && new Date(p.endDate) >= now);
  const elig = new Map<string, Awaited<ReturnType<typeof latestEligibility>>>();
  for (const p of policies) elig.set(p._id, await latestEligibility(ctx, p._id));
  const planOf = new Map(plans.map((p) => [p._id, p]));
  const polLabel = (p: (typeof policies)[number]) => `${p.memberNo} · ${planOf.get(p.planId)?.name ?? "plan"}`;
  const first = active[0];
  const eligOk = first ? elig.get(first._id)?.result === "eligible" : false;
  const required = first ? charges.filter((c) => planOf.get(first.planId)?.preauthServiceCodes.includes(c.serviceCode)) : [];
  const estimate = required.reduce((a, c) => a + Number(fromDecimal128(c.unitPrice).toFixed(2)) * c.qty, 0).toFixed(2);
  const approved = first ? allPre.some((p) => p.policyId === first._id && p.status === "approved") : false;
  const pending = first ? allPre.some((p) => p.policyId === first._id && p.status === "requested") : false;
  const canCreate = ctx.permissions.includes("insurance:create" as never);
  return (
    <div className="space-y-4">
      <Card title="Find patient"><form className="flex gap-2"><input type="hidden" name="tab" value="patient" /><div className="flex-1"><PatientPicker /></div><button className="rounded-ui border border-border px-3 text-sm">Load</button></form></Card>
      {patientId && (
        <>
          <Step n={1} title="Policy on file" state={first ? "done" : "todo"}>
            <Table head={["Member no.", "Plan", "Valid", "Status"]} empty="No policy on file yet. Add one below.">{policies.map((p) => <tr key={p._id}><td>{p.memberNo}</td><td>{planOf.get(p.planId)?.name}</td><td>{fmtDate(p.startDate)} → {fmtDate(p.endDate)}</td><td><Badge tone={active.includes(p) ? "ok" : "warn"}>{active.includes(p) ? "valid today" : "expired"}</Badge></td></tr>)}</Table>
            {plans.length === 0 ? <div className="mt-2"><Alert tone="warn">No plans exist yet. Add the payer and plan first on the Payers &amp; plans tab.</Alert></div> : canCreate && (
              <details className="mt-2" open={!first}><summary className="cursor-pointer text-sm text-primary">Add a policy</summary><div className="mt-2"><ActionForm action="ins.policy" back={here} hidden={{ patientId }} submit="Save policy" fields={[{ name: "planId", label: "Plan", type: "select", options: plans.map((p) => ({ value: p._id, label: p.name })) }, { name: "memberNo", label: "Member number (from the card)", required: true }, { name: "start", label: "Valid from", type: "date", required: true }, { name: "end", label: "Valid to", type: "date", required: true }]} /></div></details>
            )}
          </Step>
          <Step n={2} title="Coverage check" state={!first ? "wait" : eligOk ? "done" : "todo"}>
            {first ? (
              <div className="space-y-2">
                {active.map((p) => { const e = elig.get(p._id); return <p key={p._id} className="text-sm">{polLabel(p)}: {e ? <><Badge tone={e.result === "eligible" ? "ok" : e.result === "not_eligible" ? "danger" : "warn"}>{e.result.replace("_", " ")}</Badge> <span className="text-xs text-muted">{e.source}{e.reference ? ` · ref ${e.reference}` : ""} · {fmtDate(e.at)}</span></> : <span className="text-muted">not checked yet</span>}</p>; })}
                {canCreate && (
                  <div className="flex flex-wrap items-end gap-3">
                    <ActionForm inline action="ecl.eligibility" back={here} submit="Verify with payer (eClaimLink)" fields={[{ name: "policyId", label: "Policy", type: "select", options: active.map((p) => ({ value: p._id, label: polLabel(p) })) }]} />
                    <details><summary className="cursor-pointer text-xs text-muted">Record a phone or portal check instead</summary><div className="mt-2"><ActionForm action="ins.eligibility" back={here} hidden={{ patientId }} variant="outline" submit="Save result" fields={[{ name: "policyId", label: "Policy", type: "select", options: active.map((p) => ({ value: p._id, label: polLabel(p) })) }, { name: "result", label: "Result", type: "select", options: ["eligible", "not_eligible", "unknown"] }, { name: "reference", label: "Payer reference / call ID" }, { name: "notes", label: "Notes" }]} /></div></details>
                  </div>
                )}
              </div>
            ) : <p className="text-sm text-muted">Add a valid policy first.</p>}
          </Step>
          <Step n={3} title="Pre-authorisation" state={!first ? "wait" : required.length === 0 ? "skip" : approved ? "done" : pending ? "wait" : "todo"}>
            {!first ? <p className="text-sm text-muted">Add a valid policy first.</p> : required.length === 0 ? <p className="text-sm text-muted">None of the unbilled services on this plan need prior approval.</p> : (
              <div className="space-y-2">
                <Alert tone="warn">This plan needs prior approval for: {required.map((c) => c.name).join(", ")}. Claims for these are rejected without it.</Alert>
                {allPre.map((p) => <p key={p._id} className="text-sm">{p.serviceCodes.join(", ")} · {aed(fromDecimal128(p.estimatedAmount).toFixed(2))} <Badge tone={p.status === "approved" ? "ok" : p.status === "rejected" ? "danger" : "warn"}>{p.status}</Badge>{p.reference && <span className="ms-1 text-xs text-muted">ref {p.reference}</span>}</p>)}
                {!approved && !pending && canCreate && <ActionForm action="ins.preauthRequest" back={here} hidden={{ patientId, policyId: first._id, codes: required.map((c) => c.serviceCode).join(","), amount: estimate }} submit={`Request approval (AED ${estimate})`} fields={[]} />}
                {pending && <p className="text-xs text-muted">Waiting for the insurer. Send or record the decision on the Pre-authorisation tab.</p>}
              </div>
            )}
          </Step>
          <Step n={4} title="Bill the insurer" state={charges.length === 0 ? "skip" : !first ? "wait" : "todo"}>
            {charges.length === 0 ? <p className="text-sm text-muted">No unbilled charges for this patient. Charges appear after the doctor finishes the visit.</p> : policies.length === 0 ? <p className="text-sm text-muted">Add a policy first.</p> : (
              <form action={dispatch} className="space-y-3">
                <input type="hidden" name="_a" value="ins.invoice" /><input type="hidden" name="_back" value="/insurance?tab=claims" /><input type="hidden" name="patientId" value={patientId} />
                <Table head={["", "Service", "Qty", "Unit price"]}>{charges.map((c) => <tr key={c._id}><td><input type="checkbox" name="chargeId" value={c._id} defaultChecked /></td><td>{c.name}</td><td>{c.qty}</td><td>{aed(fromDecimal128(c.unitPrice).toFixed(2))}</td></tr>)}</Table>
                {required.length > 0 && !approved && <Alert tone="warn">Pre-authorisation is not approved yet. You can still create the claim, but expect a rejection.</Alert>}
                <div className="flex items-end gap-2"><select name="policyId" className="rounded-ui border border-border bg-surface px-3 py-2 text-sm">{(active.length ? active : policies).map((p) => <option key={p._id} value={p._id}>{polLabel(p)}</option>)}</select><button className="rounded-ui bg-primary px-3 py-2 text-sm font-medium text-primary-fg">Create invoice and claim</button></div>
                <p className="text-xs text-muted">The patient pays their co-pay; the insurer&apos;s share becomes a claim. You are then taken to the claims list to validate and send it.</p>
              </form>
            )}
          </Step>
        </>
      )}
    </div>
  );
}
