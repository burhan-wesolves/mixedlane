import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentSkill } from "@mixedlane/shared";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RichText } from "@/components/editor/RichEditor";
import { api } from "@/lib/api";
import { useOrg } from "@/lib/auth";

export function AgentSkillSettings() {
  const { org } = useOrg();
  const queryKey = ["agent-skill", org?.id];
  const skill = useQuery({ queryKey, queryFn: api.agents.skill });
  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <div>
        <h2 className="font-semibold">Organization agent skill</h2>
        <p className="text-sm text-muted-foreground">Customize ticket titles, body templates, Markdown, media uploads and planning rules for all agents in {org?.name}. Owners, admins and members can edit this skill.</p>
      </div>
      {skill.isLoading && <p className="text-sm text-muted-foreground">Loading skill…</p>}
      {skill.isError && <div role="alert" className="text-sm text-destructive">{skill.error.message} <Button variant="outline" onClick={() => void skill.refetch()}>Retry</Button></div>}
      {skill.data && <SkillEditor initial={skill.data} queryKey={queryKey} />}
    </section>
  );
}

function SkillEditor({ initial, queryKey }: { initial: AgentSkill; queryKey: (string | undefined)[] }) {
  const qc = useQueryClient();
  const [saved, setSaved] = useState(initial);
  const [content, setContent] = useState(initial.content);
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [restoreDefault, setRestoreDefault] = useState(false);
  const accept = (skill: AgentSkill) => {
    setSaved(skill);
    setContent(skill.content);
    setConflict(false);
    setRestoreDefault(false);
    qc.setQueryData(queryKey, skill);
  };
  const save = useMutation({
    mutationFn: () => api.agents.updateSkill({ content: restoreDefault ? null : content, version: saved.version }),
    onSuccess: (skill) => { accept(skill); toast.success("Organization agent skill saved"); },
    onError: (error: Error & { status?: number }) => { setConflict(error.status === 409); toast.error(error.message); },
  });
  const reload = useMutation({ mutationFn: api.agents.skill, onSuccess: accept, onError: (e: Error) => toast.error(e.message) });
  const dirty = content !== saved.content || (restoreDefault && saved.customized);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="agent-skill-content" className="flex-1">{saved.customized ? "Custom skill" : "Default skill"} · version {saved.version}{dirty ? " · Unsaved changes" : ""}</Label>
        <Button size="sm" variant="outline" onClick={() => setPreview(!preview)}>{preview ? "Edit Markdown" : "Preview"}</Button>
      </div>
      {preview ? <div className="max-h-[34rem] overflow-y-auto rounded-lg border p-4"><RichText html={content} /></div> : (
        <Textarea id="agent-skill-content" rows={20} maxLength={100_000} value={content} readOnly={!saved.canEdit || save.isPending} onChange={(e) => { setContent(e.target.value); setRestoreDefault(false); }} className="font-mono text-xs" />
      )}
      <p className="text-xs text-muted-foreground">Use Markdown headings, lists, checklists, links and fenced code blocks. Agents fetch the latest saved skill before writing tickets; this applies to every agent in this organization. Project permissions still apply.</p>
      {conflict && <p role="alert" className="text-sm text-destructive">Someone else saved a newer version. Copy your draft before reloading, then merge your changes.</p>}
      {saved.canEdit && <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dirty || !content.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save skill"}</Button>
        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => { setContent(saved.defaultContent); setRestoreDefault(true); }}>Restore default draft</Button>
        <Button size="sm" variant="ghost" disabled={!dirty || save.isPending} onClick={() => { setContent(saved.content); setRestoreDefault(false); }}>Discard draft</Button>
        {conflict && <Button size="sm" variant="outline" disabled={reload.isPending} onClick={() => reload.mutate()}>Reload saved skill</Button>}
      </div>}
    </div>
  );
}
