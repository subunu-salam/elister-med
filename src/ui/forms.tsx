import type { ReactNode } from "react";
import { dispatch } from "@/app/(app)/dispatch";
import { Button, Field, Input, Select, Textarea, cn } from "@/ui/kit";

export type FieldDef = {
  name: string; label: string; type?: "text" | "number" | "date" | "datetime-local" | "time" | "email" | "password" | "textarea" | "select" | "checkbox" | "hidden";
  required?: boolean; options?: { value: string; label: string }[] | string[]; placeholder?: string; defaultValue?: string | number | boolean; hint?: string; step?: string; span?: 1 | 2 | 3;
};

const opt = (o: NonNullable<FieldDef["options"]>) => o.map((x) => (typeof x === "string" ? { value: x, label: x } : x));

/**
 * Generic form that posts to the central, permission-checked dispatcher. `action` names a registered action;
 * the underlying service still authorizes every call on the server. `back` is where the user returns (errors are shown there).
 */
export function ActionForm({ action, back, fields, submit, hidden, variant = "primary", inline, className }: {
  action: string; back: string; fields: FieldDef[]; submit: ReactNode; hidden?: Record<string, string | number>; variant?: "primary" | "outline" | "danger" | "ghost"; inline?: boolean; className?: string;
}) {
  return (
    <form action={dispatch} className={cn(inline ? "flex flex-wrap items-end gap-2" : "grid gap-3 sm:grid-cols-3", className)}>
      <input type="hidden" name="_a" value={action} />
      <input type="hidden" name="_back" value={back} />
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)}
      {fields.map((f) => {
        if (f.type === "hidden") return <input key={f.name} type="hidden" name={f.name} value={String(f.defaultValue ?? "")} />;
        const wrap = (child: ReactNode) => (
          <div key={f.name} className={cn(!inline && f.span === 2 && "sm:col-span-2", !inline && f.span === 3 && "sm:col-span-3")}>
            {f.type === "checkbox" ? child : <Field label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint}>{child}</Field>}
          </div>
        );
        if (f.type === "select") return wrap(<Select name={f.name} required={f.required} defaultValue={f.defaultValue as string | undefined}>{opt(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>);
        if (f.type === "textarea") return wrap(<Textarea name={f.name} required={f.required} defaultValue={f.defaultValue as string | undefined} placeholder={f.placeholder} />);
        if (f.type === "checkbox") return wrap(<label className="flex items-center gap-2 text-sm"><input type="checkbox" name={f.name} defaultChecked={Boolean(f.defaultValue)} /> {f.label}</label>);
        return wrap(<Input name={f.name} type={f.type ?? "text"} required={f.required} defaultValue={f.defaultValue as string | number | undefined} placeholder={f.placeholder} step={f.step} />);
      })}
      <div className={cn(!inline && "flex items-end")}><Button variant={variant}>{submit}</Button></div>
    </form>
  );
}

/** One-button form for actions that need no input (approve, release, lock…). */
export function ActionButton({ action, back, hidden, children, variant = "outline", className }: { action: string; back: string; hidden?: Record<string, string | number>; children: ReactNode; variant?: "primary" | "outline" | "danger" | "ghost"; className?: string }) {
  return (
    <form action={dispatch} className="inline">
      <input type="hidden" name="_a" value={action} />
      <input type="hidden" name="_back" value={back} />
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)}
      <Button variant={variant} className={cn("px-2 py-1 text-xs", className)}>{children}</Button>
    </form>
  );
}

export const fmtDate = (d: Date | string | undefined | null) => (d ? new Date(d).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" }) : "—");
export const fmtDateTime = (d: Date | string | undefined | null) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "—");
