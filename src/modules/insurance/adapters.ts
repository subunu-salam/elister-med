/**
 * Claims transport boundary. Real regulator/payer connections (DHA eClaimLink, DOH Shafafiya, Riayati, TPAs)
 * each need onboarding, credentials and conformance testing, and are NOT implemented. Only a clearly labelled
 * SANDBOX adapter exists. It never contacts any external system.
 */
export type ClaimPayload = { number: string; version: number; payerId: string; total: string; items: { serviceCode: string; diagnosisCodes: string[]; payerShare: string }[] };
export type SubmitResult = { adapter: string; mode: "sandbox" | "production"; reference: string; status: "received" | "error"; errors: string[] };

export interface ClaimsAdapter {
  name: string;
  mode: "sandbox" | "production";
  submit(c: ClaimPayload): Promise<SubmitResult>;
}

export const sandboxAdapter: ClaimsAdapter = {
  name: "sandbox",
  mode: "sandbox",
  async submit(c) {
    const errors: string[] = [];
    if (!c.items.length) errors.push("No items");
    for (const i of c.items) if (!i.diagnosisCodes.length) errors.push(`Item ${i.serviceCode} has no diagnosis`);
    return {
      adapter: "sandbox", mode: "sandbox", reference: `SBX-${c.number}-v${c.version}`,
      status: errors.length ? "error" : "received", errors,
    };
  },
};

const registry = new Map<string, ClaimsAdapter>([["sandbox", sandboxAdapter]]);
/** Every payer currently resolves to the sandbox adapter. Production adapters register here once certified. */
export function adapterFor(_payerId: string): ClaimsAdapter {
  void _payerId;
  return registry.get("sandbox")!;
}
