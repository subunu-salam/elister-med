/**
 * Transport to DHA eClaimLink (or the mock). The four operations match what a facility system uses against eClaimLink / Shafafiya:
 * upload a transaction file, list new inbound transactions, download one, and mark it downloaded.
 * The wire format here is JSON over HTTPS with base64 XML, which is what the mock speaks. DHA's real service is SOAP: when the WSDL and
 * credentials are issued, only `call()` changes (build the SOAP envelope, parse the SOAP response); callers keep the same methods.
 */
export type EClaimLinkConfig = { baseUrl: string; login: string; password: string; timeoutMs?: number };
export type UploadResult = { ok: boolean; code: number; message: string; transactionId?: string; errors: string[] };
export type InboxItem = { fileId: string; fileName: string; recordCount: number; senderId: string; transactionType: string };

export class EClaimLinkError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message); }
}

export class EClaimLinkClient {
  constructor(private cfg: EClaimLinkConfig) {}

  private async call<T extends { code: number; message?: string }>(op: string, body: Record<string, unknown>): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 20_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${op}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: this.cfg.login, pwd: this.cfg.password, ...body }), signal: ctl.signal,
      });
      if (res.status >= 500) throw new EClaimLinkError(`eClaimLink returned HTTP ${res.status}`, true);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof EClaimLinkError) throw e;
      throw new EClaimLinkError(`Cannot reach eClaimLink: ${(e as Error).message}`, true);
    } finally { clearTimeout(timer); }
  }

  async upload(xml: string, fileName: string): Promise<UploadResult> {
    const r = await this.call<{ code: number; message: string; transactionId?: string; errors?: string[]; errorReportBase64?: string }>("/eclaimlink/UploadTransaction", { fileName, fileBase64: Buffer.from(xml, "utf8").toString("base64") });
    const errors = r.errors ?? (r.errorReportBase64 ? Buffer.from(r.errorReportBase64, "base64").toString("utf8").split("\n") : r.code === 0 ? [] : [r.message]);
    return { ok: r.code === 0, code: r.code, message: r.message, transactionId: r.transactionId, errors };
  }
  async inbox(): Promise<InboxItem[]> {
    const r = await this.call<{ code: number; message: string; transactions: InboxItem[] }>("/eclaimlink/GetNewTransactions", {});
    if (r.code !== 0) throw new EClaimLinkError(r.message, false);
    return r.transactions;
  }
  async download(fileId: string): Promise<{ fileName: string; xml: string }> {
    const r = await this.call<{ code: number; message?: string; fileName: string; fileBase64: string }>("/eclaimlink/DownloadTransactionFile", { fileId });
    if (r.code !== 0) throw new EClaimLinkError(r.message ?? "Download failed", false);
    return { fileName: r.fileName, xml: Buffer.from(r.fileBase64, "base64").toString("utf8") };
  }
  async markDownloaded(fileId: string): Promise<void> {
    const r = await this.call<{ code: number; message?: string }>("/eclaimlink/SetTransactionDownloaded", { fileId });
    if (r.code !== 0) throw new EClaimLinkError(r.message ?? "Could not mark downloaded", false);
  }
  async eligibility(input: { memberId: string; payerId: string; emiratesId?: string }): Promise<{ eligible: boolean; reference: string; notes: string }> {
    const r = await this.call<{ code: number; message?: string; eligible: boolean; reference: string; notes: string }>("/eligibility", input);
    if (r.code !== 0) throw new EClaimLinkError(r.message ?? "Eligibility check failed", false);
    return { eligible: r.eligible, reference: r.reference, notes: r.notes };
  }
}
