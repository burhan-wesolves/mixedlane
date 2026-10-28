import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PROJECT_ROLES, PROJECT_ROLE_LABELS, type ProjectRole } from "@mixedlane/shared";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type TeamProjectGrant = { projectId: string; role: ProjectRole };
export type AccessPrincipal = { type: "user" | "team"; id: string; name: string; elevated?: boolean };

export function TeamProjectGrants({ value, onChange, disabled }: { value: TeamProjectGrant[]; onChange: (grants: TeamProjectGrant[]) => void; disabled?: boolean }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects.list });
  return <fieldset className="space-y-2">
    <legend className="text-sm font-medium">Project access</legend>
    <p className="text-xs text-muted-foreground">Choose a role for each project. Everyone added to this team inherits these grants.</p>
    {projects.isPending && <p role="status" className="text-sm">Loading projects…</p>}
    {projects.isError && <div role="alert" className="text-sm text-destructive">Could not load projects. <Button type="button" variant="link" onClick={() => void projects.refetch()}>Retry</Button></div>}
    <div className="max-h-64 space-y-2 overflow-y-auto">
      {projects.data?.map((p) => <label key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
        <span>{p.key} · {p.name}</span>
        <select aria-label={`Team role for ${p.key}`} className="h-9 rounded-md border bg-background px-2" disabled={disabled} value={value.find((g) => g.projectId === p.id)?.role ?? "none"}
          onChange={(e) => onChange([...value.filter((g) => g.projectId !== p.id), ...(e.target.value === "none" ? [] : [{ projectId: p.id, role: e.target.value as ProjectRole }])])}>
          <option value="none">No team grant</option>{PROJECT_ROLES.map((role) => <option key={role} value={role}>{PROJECT_ROLE_LABELS[role]}</option>)}
        </select>
      </label>)}
    </div>
    {projects.data?.length === 0 && <p className="text-sm text-muted-foreground">No projects yet. You can assign access later from this team's Project access button.</p>}
  </fieldset>;
}

/** Organization admins can manage a principal across projects without hunting through project settings. */
export function PrincipalProjectAccess({ principal, onClose }: { principal: AccessPrincipal; onClose: () => void }) {
  const qc = useQueryClient();
  const access = useQuery({
    queryKey: ["org", "principal-access", principal.type, principal.id],
    queryFn: async () => {
      const projects = await api.projects.list();
      return Promise.all(projects.map(async (project) => ({ project, overview: await api.access.get(project.key) })));
    },
  });
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["org", "principal-access"] }), qc.invalidateQueries({ queryKey: ["access"] }), qc.invalidateQueries({ queryKey: ["projects"] }), qc.invalidateQueries({ queryKey: ["project"] })]);
      toast.success("Project access updated");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Project access for {principal.name}</DialogTitle>
        <DialogDescription>{principal.type === "team" ? "Manage the project roles inherited by every member of this team." : "An individual role overrides team and organization defaults. Remove it to inherit access again. Revocation blocks access regardless of these roles."}</DialogDescription>
      </DialogHeader>
      {principal.elevated && <p className="text-sm text-muted-foreground">Organization owners and admins always have admin access to every project.</p>}
      {access.isPending && <p role="status">Loading project access…</p>}
      {access.isError && <div role="alert" className="space-y-2 text-sm"><p>Could not load project access: {access.error.message}</p><Button variant="outline" onClick={() => void access.refetch()}>Retry</Button></div>}
      {access.data?.length === 0 && <p className="text-sm text-muted-foreground">No projects yet.</p>}
      <div className="space-y-3">{access.data?.map(({ project, overview }) => {
        const direct = overview.grants.find((g) => g.principalType === principal.type && g.principalId === principal.id);
        const member = principal.type === "user" ? overview.members.find((m) => m.userId === principal.id) : undefined;
        return <section key={project.id} aria-label={`Access to ${project.key}`} className="space-y-2 rounded-lg border p-3">
          <h3 className="text-sm font-semibold">{project.key} · {project.name}</h3>
          {member && <p className="text-xs text-muted-foreground">Effective access: {member.revoked ? "Revoked" : member.role ? PROJECT_ROLE_LABELS[member.role] : "No access"}. {member.sources.join(" · ") || "No grants"}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex flex-wrap items-center gap-2 text-sm">{principal.type === "team" ? "Team grant" : "Individual grant"}
              <select aria-label={`${principal.type === "team" ? "Team" : "Individual"} role for ${project.key}`} className="h-9 rounded-md border bg-background px-2" disabled={change.isPending || principal.elevated}
                value={direct?.role ?? "none"} onChange={(e) => {
                  const role = e.target.value;
                  if (role === "none") { if (direct) change.mutate(() => api.access.revoke(project.key, direct.id)); }
                  else change.mutate(() => api.access.grant(project.key, { principalType: principal.type, principalId: principal.id, role: role as ProjectRole }));
                }}>
                <option value="none">No {principal.type === "team" ? "team" : "individual"} grant</option>{PROJECT_ROLES.map((role) => <option key={role} value={role}>{PROJECT_ROLE_LABELS[role]}</option>)}
              </select>
            </label>
            {member && !principal.elevated && <Button size="sm" variant="outline" disabled={change.isPending} onClick={() => change.mutate(() => api.access.setRevocation(project.key, principal.id, !member.revoked))}>{member.revoked ? "Restore access" : "Revoke access"}<span className="sr-only"> to {project.key}</span></Button>}
          </div>
          {member?.revoked && <p className="text-xs text-muted-foreground">Restore access to apply the grants above. Changing a grant does not remove this exception.</p>}
        </section>;
      })}</div>
      <Button variant="outline" onClick={onClose}>Done</Button>
    </DialogContent>
  </Dialog>;
}
