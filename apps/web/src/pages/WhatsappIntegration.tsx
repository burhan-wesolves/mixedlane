import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Plus, QrCode, RefreshCw, Trash2 } from "lucide-react";
import { AI_PROVIDERS, type WhatsappSettingsInput, type WhatsappSettingsInfo } from "@mixedlane/shared";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useOrg } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const names = { ollama: "Ollama Cloud · Primary", gemini: "Gemini · First fallback", grok: "Grok (xAI) · Second fallback" };

export function WhatsappIntegration() {
  const { org, can } = useOrg();
  const manage = can("integration.manage");
  const qc = useQueryClient();
  const key = ["whatsapp", org?.id];
  const settings = useQuery({ queryKey: [...key, "settings"], queryFn: api.whatsapp.settings, enabled: manage });
  const accounts = useQuery({ queryKey: [...key, "sessions"], queryFn: api.whatsapp.sessions, enabled: manage && !!settings.data?.configured, refetchInterval: 8000 });
  const available = useQuery({ queryKey: [...key, "available"], queryFn: api.whatsapp.available, enabled: manage && !!settings.data?.configured });
  const contacts = useQuery({ queryKey: [...key, "contacts"], queryFn: api.whatsapp.contacts, enabled: manage });
  const members = useQuery({ queryKey: [...key, "members"], queryFn: api.orgs.members, enabled: manage });
  const drafts = useQuery({ queryKey: [...key, "drafts"], queryFn: api.whatsapp.drafts, refetchInterval: 8000 });
  const [accountName, setAccountName] = useState("");
  const [phone, setPhone] = useState("");
  const [userId, setUserId] = useState("");
  const [qrSession, setQrSession] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const qr = useQuery({ queryKey: [...key, "qr", qrSession], queryFn: () => api.whatsapp.qr(qrSession!), enabled: !!qrSession, refetchInterval: 4000, retry: false });
  useEffect(() => { if (accounts.data?.find((a) => a.id === qrSession)?.status === "ready") { setQrSession(null); toast.success("WhatsApp connected"); } }, [accounts.data, qrSession]);
  const action = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); }, onError: (e: Error) => toast.error(e.message) });
  return <section className="overflow-hidden rounded-xl border bg-card">
    <div className="flex items-center gap-3 border-b px-5 py-4"><MessageCircle className="size-7 text-emerald-600" /><div><h2 className="font-semibold">WhatsApp</h2><p className="text-sm text-muted-foreground">Turn team messages into reviewed tickets with AI.</p></div></div>
    <div className="space-y-7 p-5">
      {manage && settings.isLoading && <p className="text-sm text-muted-foreground">Loading WhatsApp settings…</p>}
      {settings.error && <p role="alert" className="text-sm text-destructive">{settings.error.message}</p>}
      {manage && settings.data && <ConnectionForm info={settings.data} onSave={(input) => action.mutateAsync(() => api.whatsapp.save(input))} pending={action.isPending} />}
      {manage && settings.data?.configured && <>
        <div className="space-y-3 border-t pt-5"><h3 className="text-sm font-semibold">Connected accounts</h3><p className="text-xs text-muted-foreground">Owners and admins scan the QR here. Each connected number receives direct-message reports.</p>
          {available.data?.map((a) => <div key={a.id} className="flex items-center justify-between rounded-lg bg-muted/40 p-3 text-sm"><span>{a.name} · {a.phone || a.status}</span><Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate(() => api.whatsapp.linkSession(a.id))}>Link existing account</Button></div>)}
          {accounts.error && <p role="alert" className="text-sm text-destructive">{accounts.error.message}</p>}
          {accounts.data?.map((a) => <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{a.name}</p><p className="text-xs text-muted-foreground">{a.phone || "Awaiting connection"} · {a.status}</p>{a.lastError && <p className="text-xs text-destructive">{a.lastError}</p>}</div>
            {a.status !== "ready" && <><Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate(() => api.whatsapp.start(a.id))}><RefreshCw /> Start</Button><Button size="sm" variant="outline" onClick={() => setQrSession(a.id)}><QrCode /> Scan QR</Button></>}
            <Button size="icon" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => setRemoveId(a.id)}><Trash2 className="size-4" /></Button>
          </div>)}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); action.mutateAsync(() => api.whatsapp.createSession(accountName)).then(() => setAccountName("")).catch(() => {}); }}><Input aria-label="Account name" placeholder="Account name, e.g. team-support" value={accountName} onChange={(e) => setAccountName(e.target.value)} pattern="[a-zA-Z0-9-]{3,25}" required /><Button disabled={action.isPending}><Plus /> Add account</Button></form>
        </div>
        <div className="space-y-3 border-t pt-5"><h3 className="text-sm font-semibold">Team WhatsApp numbers</h3><p className="text-xs text-muted-foreground">Map each sender’s number, including country code, to their Mixedlane account. Their current project permissions apply. Unlisted numbers and group messages are ignored.</p>
          {contacts.error && <p role="alert" className="text-sm text-destructive">{contacts.error.message}</p>}
          {contacts.data?.map((c) => <div key={c.id} className="flex items-center justify-between text-sm"><span>+{c.phone} · {members.data?.find((m) => m.userId === c.userId)?.name ?? "Member"}</span><Button size="icon" variant="ghost" aria-label={`Remove number ${c.phone}`} disabled={action.isPending} onClick={() => action.mutate(() => api.whatsapp.removeContact(c.id))}><Trash2 className="size-4" /></Button></div>)}
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); action.mutateAsync(() => api.whatsapp.contact(phone, userId)).then(() => setPhone("")).catch(() => {}); }}><Input className="min-w-40 flex-1" aria-label="WhatsApp phone number" placeholder="+919876543210" value={phone} onChange={(e) => setPhone(e.target.value)} pattern="\+?[0-9]{6,20}" required /><select className="h-9 min-w-40 rounded-md border bg-background px-3 text-sm" aria-label="Team member" value={userId} onChange={(e) => setUserId(e.target.value)} required><option value="">Choose a member</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select><Button disabled={action.isPending}>Link number</Button></form>
        </div>
      </>}
      <div className="space-y-3 border-t pt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Ticket drafts</h3><Button size="sm" variant="ghost" onClick={() => void drafts.refetch()}><RefreshCw className="size-3.5" /> Refresh</Button></div><p className="text-xs text-muted-foreground">The sender or an admin can approve. AI chooses the ticket type and parent. Send a report directly, or prefix it with a project code, e.g. APP Login fails after reset.</p>
        {drafts.error && <p role="alert" className="text-sm text-destructive">{drafts.error.message}</p>}
        {!drafts.isLoading && !drafts.data?.length && <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">No WhatsApp reports yet.</p>}
        {drafts.data?.map((d) => <article key={d.id} className="space-y-3 rounded-lg border p-4"><div className="flex items-start justify-between gap-3"><h4 className="text-sm font-medium">{d.proposal?.title ?? d.report.slice(0, 140)}</h4><span className="rounded-full bg-muted px-2 py-1 text-xs">{d.status.replaceAll("_", " ")}</span></div><p className="text-xs text-muted-foreground">{d.chatId.split("@")[0]} · {new Date(d.createdAt).toLocaleString()}{d.provider ? ` · ${d.provider}` : ""}</p>
          {d.proposal && <><p className="text-xs font-medium">{d.proposal.type} · {d.proposal.category} · {d.proposal.priority}{d.proposal.parentId ? ` · Parent: ${d.proposal.parentId}` : ""}</p><p className="whitespace-pre-wrap text-sm">{d.proposal.description}</p><p className="text-xs text-muted-foreground">{d.proposal.reason}</p>{d.proposal.duplicateId && <p className="text-xs text-amber-600">Possible duplicate: {d.proposal.duplicateId}. Ask the sender to revise the report before creating a ticket.</p>}</>}
          {d.error && <p className="text-sm text-destructive">{d.error}</p>}
          {d.status === "review" && <div className="flex gap-2"><Button size="sm" disabled={action.isPending || !!d.proposal?.duplicateId} onClick={() => action.mutate(() => api.whatsapp.review(d.id, "approve"))}>Create ticket</Button><Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate(() => api.whatsapp.review(d.id, "cancel"))}>Cancel</Button></div>}
          {d.status === "failed" && <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate(() => api.whatsapp.review(d.id, "retry"))}>Retry AI</Button>}
        </article>)}
      </div>
    </div>
    <Dialog open={!!qrSession} onOpenChange={(open) => { if (!open) setQrSession(null); }}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Connect WhatsApp</DialogTitle><DialogDescription>On your phone, open WhatsApp → Linked devices → Link a device.</DialogDescription></DialogHeader>{qr.data?.qrCode?.startsWith("data:image/png;base64,") ? <img src={qr.data.qrCode} alt="WhatsApp connection QR code" className="mx-auto size-64 rounded-lg bg-white p-2" /> : <p className="text-sm text-muted-foreground">{qr.error ? "QR is not ready. Start the account and wait a few seconds; this view refreshes automatically." : "Waiting for QR code…"}</p>}</DialogContent></Dialog>
    <Dialog open={!!removeId} onOpenChange={(open) => { if (!open) setRemoveId(null); }}><DialogContent><DialogHeader><DialogTitle>Remove WhatsApp account?</DialogTitle><DialogDescription>This removes the connection and associated drafts. Sessions created here are also deleted from OpenWA; existing sessions linked here remain in OpenWA. Created tickets remain in Mixedlane.</DialogDescription></DialogHeader><Button variant="destructive" disabled={action.isPending} onClick={() => { if (removeId) action.mutateAsync(() => api.whatsapp.removeSession(removeId)).then(() => setRemoveId(null)).catch(() => {}); }}>Remove account</Button></DialogContent></Dialog>
  </section>;
}

function ConnectionForm({ info, onSave, pending }: { info: WhatsappSettingsInfo; onSave: (input: WhatsappSettingsInput) => Promise<unknown>; pending: boolean }) {
  const [baseUrl, setBaseUrl] = useState(info.baseUrl);
  const [callbackUrl, setCallbackUrl] = useState(info.callbackUrl);
  const [apiKey, setApiKey] = useState("");
  const [providers, setProviders] = useState(() => Object.fromEntries(AI_PROVIDERS.map((p) => [p, { model: info.providers[p].model, apiKey: "" }])) as Record<typeof AI_PROVIDERS[number], { model: string; apiKey: string }>);
  return <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); const input = { baseUrl, callbackUrl, ...(apiKey ? { apiKey } : {}), providers: Object.fromEntries(AI_PROVIDERS.map((p) => [p, { model: providers[p].model, ...(providers[p].apiKey ? { apiKey: providers[p].apiKey } : {}) }])) } as WhatsappSettingsInput; onSave(input).then(() => { setApiKey(""); setProviders((prev) => Object.fromEntries(AI_PROVIDERS.map((p) => [p, { ...prev[p], apiKey: "" }])) as typeof providers); toast.success("WhatsApp settings saved"); }).catch(() => {}); }}>
    <div className="grid gap-4 md:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="wa-url">OpenWA URL</Label><Input id="wa-url" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required /></div><div className="space-y-1.5"><Label htmlFor="wa-key">OpenWA API key</Label><Input id="wa-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={info.hasApiKey ? "Saved — leave blank to keep" : "Enter gateway API key"} required={!info.hasApiKey} /></div></div>
    <div className="space-y-1.5"><Label htmlFor="wa-callback">Mixedlane URL reachable from OpenWA</Label><Input id="wa-callback" type="url" value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} required /><p className="text-xs text-muted-foreground">Use this app’s LAN or public base URL. OpenWA delivers signed message events here.</p></div>
    <div className="space-y-3"><h3 className="text-sm font-semibold">AI providers</h3><p className="text-xs text-muted-foreground">Tried in this order. Missing providers are skipped; errors and invalid ticket proposals move to the next provider. Use a model available in your provider account. Keys are encrypted on the server.</p>
      {AI_PROVIDERS.map((p) => <div key={p} className="grid gap-3 rounded-lg bg-muted/35 p-3 md:grid-cols-[180px_1fr_1fr]"><Label className="self-center" htmlFor={`wa-${p}-model`}>{names[p]}</Label><Input id={`wa-${p}-model`} aria-label={`${p} model`} placeholder="Model name" value={providers[p].model} onChange={(e) => setProviders({ ...providers, [p]: { ...providers[p], model: e.target.value } })} /><Input aria-label={`${p} API key`} type="password" autoComplete="new-password" placeholder={info.providers[p].configured ? "Saved — leave blank to keep" : "API key"} value={providers[p].apiKey} onChange={(e) => setProviders({ ...providers, [p]: { ...providers[p], apiKey: e.target.value } })} /></div>)}
    </div><Button disabled={pending}>{pending ? "Saving…" : "Save connection settings"}</Button>
  </form>;
}
