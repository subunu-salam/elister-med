import { MODULES, type ModuleKey } from "@/core/rbac/modules";
import { ROLE_INFO, STAFF_ROLES } from "@/modules/admin/service";
import type { RoleKey } from "@/core/rbac/roles";

/** Role + module pickers shared by "add person" and "edit person". Plain form fields, so they work without JavaScript. */
export function AccessFields({ roles, modules, available, canGrantPlatform }: { roles: RoleKey[]; modules: ModuleKey[] | null; available?: ModuleKey[]; canGrantPlatform: boolean }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Role</h3>
        <p className="text-xs text-muted">What the person may do. Pick one or more.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {STAFF_ROLES.filter((r) => canGrantPlatform || r !== "platform_super_admin").map((r) => (
            <label key={r} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3 text-sm transition has-[:checked]:border-primary has-[:checked]:bg-primary/5">
              <input type="checkbox" name="roles" value={r} defaultChecked={roles.includes(r)} className="mt-0.5 accent-[var(--primary)]" />
              <span><span className="font-medium">{ROLE_INFO[r].label}</span><span className="block text-xs text-muted">{ROLE_INFO[r].hint}</span></span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold">Module access</h3>
        <p className="text-xs text-muted">Which parts of the business the person can see at all. This is enforced on the server, not just hidden from the menu.</p>
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5"><input type="radio" name="moduleMode" value="all" defaultChecked={modules === null} className="accent-[var(--primary)]" />Everything the role allows</label>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5"><input type="radio" name="moduleMode" value="custom" defaultChecked={modules !== null} className="accent-[var(--primary)]" />Only the modules I choose</label>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {MODULES.map((m) => {
            const inRole = !available || available.includes(m.key);
            return (
              <label key={m.key} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3 text-sm transition has-[:checked]:border-primary has-[:checked]:bg-primary/5 ${inRole ? "" : "opacity-55"}`}>
                <input type="checkbox" name="modules" value={m.key} defaultChecked={modules === null ? inRole : modules.includes(m.key)} className="mt-0.5 accent-[var(--primary)]" />
                <span><span className="font-medium">{m.label}</span><span className="block text-xs text-muted">{m.hint}{!inRole && " · not in this role"}</span></span>
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">Ticks only count when &quot;Only the modules I choose&quot; is selected. A module outside the person&apos;s role stays closed even if ticked: change the role to open it.</p>
      </div>
    </div>
  );
}
