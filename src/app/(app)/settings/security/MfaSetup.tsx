"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/ui/kit";

export function MfaSetup() {
  const [uri, setUri] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function enable(fd: FormData) {
    setMsg(null);
    const r = await authClient.twoFactor.enable({ password: String(fd.get("password")) });
    if (r.error) return setMsg({ tone: "danger", text: r.error.message ?? "Could not start setup" });
    if (!r.data || !("totpURI" in r.data)) return setMsg({ tone: "danger", text: "Unexpected response" });
    setUri(r.data.totpURI); setCodes(r.data.backupCodes ?? []);
  }
  async function verify(fd: FormData) {
    const r = await authClient.twoFactor.verifyTotp({ code: String(fd.get("code")) });
    setMsg(r.error ? { tone: "danger", text: r.error.message ?? "Invalid code" } : { tone: "ok", text: "Two-factor authentication is on." });
  }

  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!uri ? (
        <form action={enable} className="space-y-3">
          <Field label="Confirm your password"><Input name="password" type="password" required autoComplete="current-password" /></Field>
          <Button>Set up authenticator</Button>
        </form>
      ) : (
        <>
          <p className="text-sm">Add this key to your authenticator app (enter the setup URI or secret manually), then confirm with a code.</p>
          <code className="block break-all rounded-ui bg-surface-2 p-2 text-xs">{uri}</code>
          {codes.length > 0 && <div><div className="text-xs font-medium text-muted">Backup codes — store them safely</div><div className="mt-1 grid grid-cols-2 gap-1 font-mono text-xs">{codes.map((c) => <span key={c}>{c}</span>)}</div></div>}
          <form action={verify} className="flex items-end gap-2"><Field label="6-digit code"><Input name="code" inputMode="numeric" maxLength={6} required /></Field><Button>Verify</Button></form>
        </>
      )}
    </div>
  );
}
