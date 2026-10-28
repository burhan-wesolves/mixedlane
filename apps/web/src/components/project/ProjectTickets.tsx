import { useState } from "react";
import { Link } from "react-router-dom";
import { TYPE_LABELS, type Project, type WorkItemSummary } from "@mixedlane/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusIcon, TypeIcon } from "@/components/common";
import { paths, useProjectScope } from "@/lib/project";

/** Flat view over the complete permission-filtered project tree, including every nested ticket. */
export function ProjectTickets({ project, items, preview = false }: { project: Project; items: WorkItemSummary[]; preview?: boolean }) {
  const { statusById } = useProjectScope();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [assignee, setAssignee] = useState("");
  const [sort, setSort] = useState("updated_desc");
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(preview ? 5 : 20);
  const needle = search.trim().toLocaleLowerCase();
  const filtered = items.filter((i) => (!status || i.status === status) && (!type || i.type === type)
    && (!assignee || (assignee === "__unassigned" ? !i.assignee : i.assignee === assignee))
    && (!needle || i.title.toLocaleLowerCase().includes(needle) || i.key.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => {
      const order = sort.startsWith("title") ? a.title.localeCompare(b.title)
        : Date.parse(sort.startsWith("created") ? a.createdAt : a.updatedAt) - Date.parse(sort.startsWith("created") ? b.createdAt : b.updatedAt);
      return (sort.endsWith("desc") ? -order : order) || a.key.localeCompare(b.key);
    });
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * size, (current + 1) * size);
  const assignees = [...new Set(items.flatMap((i) => i.assignee ? [i.assignee] : []))].sort();
  const selectClass = "h-9 max-w-full rounded-md border bg-background px-2 text-sm";
  const reset = () => { setSearch(""); setStatus(""); setType(""); setAssignee(""); setSort("updated_desc"); setPage(0); };

  return <section aria-label={preview ? "Ticket preview" : "All project tickets"} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">{preview ? "Tickets" : "All tickets"} <span className="font-normal text-muted-foreground">({filtered.length})</span></h2>
      {preview && <Button asChild variant="outline" size="sm"><Link to={`${paths.project(project.key, "list")}?view=all`}>View more</Link></Button>}
    </div>
    {!preview && <div className="flex flex-wrap gap-2">
      <Input aria-label="Search ticket titles or keys" className="min-w-48 flex-1" placeholder="Search title or key…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
      <select aria-label="Filter tickets by status" className={selectClass} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
        <option value="">All statuses</option>{project.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <select aria-label="Filter tickets by type" className={selectClass} value={type} onChange={(e) => { setType(e.target.value); setPage(0); }}>
        <option value="">All types</option>{project.itemTypes.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
      </select>
      <select aria-label="Filter tickets by assignee" className={selectClass} value={assignee} onChange={(e) => { setAssignee(e.target.value); setPage(0); }}>
        <option value="">All assignees</option><option value="__unassigned">Unassigned</option>{assignees.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <select aria-label="Sort tickets" className={selectClass} value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }}>
        <option value="updated_desc">Recently updated</option><option value="updated_asc">Least recently updated</option>
        <option value="created_desc">Newest created</option><option value="created_asc">Oldest created</option>
        <option value="title_asc">Title A–Z</option><option value="title_desc">Title Z–A</option>
      </select>
      <Button variant="ghost" onClick={reset}>Reset filters</Button>
    </div>}
    <div className="divide-y overflow-hidden rounded-xl border bg-card">
      {visible.map((i) => <Link key={i.id} to={paths.item(project.key, i)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <TypeIcon type={i.type} /><span className="font-mono text-xs text-muted-foreground">{i.key}</span>
        <span className="min-w-0 flex-1 break-words font-medium">{i.title}</span>
        <span className="text-xs text-muted-foreground">{TYPE_LABELS[i.type]}</span>
        <span className="flex items-center gap-1.5 text-xs"><StatusIcon status={statusById(i.status)} />{statusById(i.status).name}</span>
      </Link>)}
      {!visible.length && <p role="status" className="p-6 text-sm text-muted-foreground">{items.length ? "No tickets match your filters." : "No tickets yet."}</p>}
    </div>
    <nav aria-label={preview ? "Ticket preview pages" : "Ticket list pages"} className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">Per page
        <select aria-label="Tickets per page" className={selectClass} value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }}>
          {(preview ? [5, 10] : [10, 20, 50]).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span className="text-xs text-muted-foreground" aria-live="polite">Page {current + 1} of {pages} · {filtered.length} tickets</span>
      <div className="ml-auto flex gap-2">
        <Button size="sm" variant="outline" disabled={!current} onClick={() => setPage(current - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Button>
      </div>
    </nav>
  </section>;
}
