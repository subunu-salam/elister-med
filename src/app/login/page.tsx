"use client";
import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { CalendarCheck, Languages, ShieldCheck, Stethoscope } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/ui/kit";

const POINTS = [
  { icon: CalendarCheck, title: "One connected journey", text: "From booking and check-in to consultation, billing and payment." },
  { icon: Stethoscope, title: "Built for multi-specialty care", text: "General medicine, dermatology, dentistry, OB & Gynaecology, paediatrics and pathology." },
  { icon: Languages, title: "English and Arabic", text: "Full right-to-left support for patients and staff." },
  { icon: ShieldCheck, title: "Secure and auditable", text: "Role-based access, MFA and a complete audit trail." },
];

export default function LoginPage() {
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const done = () => { router.push("/dashboard"); router.refresh(); };

  async function onCredentials(fd: FormData) {
    setBusy(true); setError("");
    const res = await authClient.signIn.email({ email: String(fd.get("email")), password: String(fd.get("password")) });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "Sign-in failed");
    if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return setStep("totp");
    done();
  }
  async function onTotp(fd: FormData) {
    setBusy(true); setError("");
    const res = await authClient.twoFactor.verifyTotp({ code: String(fd.get("code")) });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "Invalid code");
    done();
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="side-grad relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Image src="/brand/mark.png" alt="" aria-hidden width={640} height={640} className="pointer-events-none absolute -bottom-32 -end-24 size-[560px] opacity-[0.07]" />
        <div aria-hidden className="pointer-events-none absolute -start-24 -top-24 size-96 rounded-full bg-cyan-300/15 blur-3xl" />
        <Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} priority className="relative h-14 w-auto self-start" />
        <div className="relative max-w-xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">Dubai · Al Qusais</p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">Your trusted family healthcare partner in Dubai.</h1>
          <p className="mt-4 text-base text-white/70" dir="rtl" lang="ar">شريكك الموثوق لرعاية أسرتك في دبي</p>
          <ul className="mt-10 grid gap-5 sm:grid-cols-2">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-cyan-200 ring-1 ring-white/15"><p.icon size={18} /></span>
                <div><div className="text-sm font-semibold">{p.title}</div><div className="mt-0.5 text-xs leading-relaxed text-white/65">{p.text}</div></div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/45">www.elistermed.ae · +971 4 283 8398</p>
      </section>

      <section className="grid place-items-center p-6">
        <div className="page-in w-full max-w-sm space-y-6">
          <div className="text-center lg:text-start">
            <Image src="/brand/logo-footer.png" alt="Elister Med" width={235} height={117} priority className="mx-auto mb-6 h-14 w-auto lg:hidden dark:hidden" />
            <Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} className="mx-auto mb-6 hidden h-14 w-auto dark:block dark:lg:hidden" />
            <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
            <p className="mt-1 text-sm text-muted">Sign in to Elister Med clinic management</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-pop)]">
            {error && <div className="mb-4"><Alert>{error}</Alert></div>}
            {step === "credentials" ? (
              <form action={onCredentials} className="space-y-4">
                <Field label="Email"><Input name="email" type="email" required autoComplete="username" placeholder="you@elistermed.ae" /></Field>
                <Field label="Password"><Input name="password" type="password" required autoComplete="current-password" /></Field>
                <Button className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
              </form>
            ) : (
              <form action={onTotp} className="space-y-4">
                <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
                <Field label="Authenticator code"><Input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" /></Field>
                <Button className="w-full" disabled={busy}>Verify</Button>
              </form>
            )}
          </div>
          <p className="text-center text-xs text-muted">Demo environment with synthetic data only.</p>
        </div>
      </section>
    </main>
  );
}
