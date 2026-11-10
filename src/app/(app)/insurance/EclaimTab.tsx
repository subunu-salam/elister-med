import { Alert, Badge, Card, Table } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import type { Ctx } from "@/core/rbac/authorize";
import { getEclConfig, listEclTransactions } from "@/modules/integrations/eclaimlink/service";

const TONE = { accepted: "ok", processed: "ok", rejected: "danger", error: "danger" } as const;

export async function EclaimTab({ ctx, back }: { ctx: Ctx; back: string }) {
  const can = (p: string) => ctx.permissions.includes(p as never);
  const cfg = can("integrations:view") ? await getEclConfig(ctx) : null;
  const txs = await listEclTransactions(ctx, 60);
  const mapText = Object.entries(cfg?.payerMap ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  return (
    <>
      <Alert tone="warn">
        {cfg?.mode === "mock" || !cfg || cfg.mode === "off"
          ? "Mock mode: claims and authorisations go to the built-in MOCK DHA server (npm run mock:dha), never to DHA. Real DHA eClaimLink needs vendor onboarding, test credentials and the SOAP schema from DHA."
          : `Mode: ${cfg.mode}. The message layout is modelled on the eClaimLink transaction family and must be confirmed against DHA's current schema before production use.`}
      </Alert>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection" action={cfg && <Badge tone={cfg.mode === "off" ? "neutral" : cfg.mode === "production" ? "danger" : "info"}>{cfg.mode}</Badge>}>
          {can("integrations:update") ? (
            <ActionForm action="ecl.config" back={back} submit="Save connection" fields={[
              { name: "mode", label: "Mode", type: "select", defaultValue: cfg?.mode ?? "off", options: ["off", "mock", "test", "production"] },
              { name: "baseUrl", label: "Base URL", defaultValue: cfg?.baseUrl ?? "http://127.0.0.1:4010", placeholder: "https://…" },
              { name: "facilityId", label: "DHA facility ID (sender)", defaultValue: cfg?.facilityId ?? "DHA-F-0083721" },
              { name: "login", label: "eClaimLink login", defaultValue: cfg?.login ?? "elister_test" },
              { name: "password", label: "Password", type: "password", hint: cfg?.hasPassword ? "Saved (encrypted). Leave blank to keep." : "Stored encrypted." },
              { name: "payerMap", label: "Payer IDs (our code = DHA payer ID, one per line)", type: "textarea", span: 3, defaultValue: mapText, placeholder: "DAMAN=A001" },
            ]} />
          ) : <p className="text-sm text-muted">Only integration administrators can change the connection.</p>}
          {cfg && cfg.mode !== "off" && can("integrations:update") && <div className="mt-3 flex flex-wrap gap-2"><ActionButton action="ecl.test" back={back} variant="outline">Test connection</ActionButton></div>}
        </Card>
        <Card title="Inbox" action={can("insurance:approve") && cfg && cfg.mode !== "off" && <ActionButton action="ecl.poll" back={back}>Poll eClaimLink now</ActionButton>}>
          <p className="text-sm text-muted">Polling downloads new remittance advices and authorisation decisions, posts payments into the ledger, marks fully denied claims as rejected for correction, and updates pre-authorisations. Each file is applied once.</p>
          <p className="mt-2 text-xs text-muted">Send a claim: Claims → open a validated claim → Submit. Send an authorisation: Pre-authorisation tab → Send to eClaimLink.</p>
        </Card>
      </div>
      <Card title="Transaction log" flush>
        <Table head={["When", "Dir", "Type", "Reference", "Status", "Detail"]} empty={txs.length ? undefined : "No transactions yet."}>
          {txs.map((t) => (
            <tr key={t._id}>
              <td className="whitespace-nowrap text-xs">{fmtDateTime(t.at)}</td>
              <td>{t.direction === "out" ? "↑ sent" : "↓ received"}</td><td className="font-mono text-xs">{t.type}</td><td className="font-mono text-xs">{t.ref}</td>
              <td><Badge tone={TONE[t.status]}>{t.status}</Badge></td>
              <td className="max-w-md text-xs"><div>{t.summary ?? t.message}</div>{t.errors && t.errors.length > 0 && <div className="text-danger">{t.errors.slice(0, 3).join(" · ")}</div>}
                <details className="mt-1"><summary className="cursor-pointer text-primary">XML</summary><pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-[11px]">{t.xml.replace(/></g, ">\n<")}</pre></details></td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
