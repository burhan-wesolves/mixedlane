import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CheckCheck, ChevronRight, CircleDot, FolderKanban, FolderPlus, Plus, Search } from "lucide-react";
import { sortTypes } from "@mixedlane/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { EmptyState, ProgressBar, ProjectIcon, TypeIcon } from "@/components/common";
import { useProjects } from "@/hooks/queries";
import { paths } from "@/lib/project";
import { useOrg } from "@/lib/auth";

export function ProjectsPage() {
  const { data: projects, isLoading, error, refetch } = useProjects();
  const [query, setQuery] = useState("");
  const visible = projects?.filter(p => `${p.name} ${p.key} ${p.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const totals = projects?.reduce((sum, p) => ({ total: sum.total + p.stats.total, done: sum.done + p.stats.done, active: sum.active + p.stats.inProgress }), { total: 0, done: 0, active: 0 });
  const canCreate = useOrg().can("project.create");

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b bg-card/40 px-4 py-6 sm:px-8">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Your workspace</p>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">A clear view of what your team is building.</p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link to={paths.newProject()}>
              <Plus className="size-4" /> New project
            </Link>
          </Button>
        )}
      </header>

      <div className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 sm:px-8">
        {!isLoading && !error && !!projects?.length && <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Projects", value: projects.length, icon: FolderKanban },
              { label: "Work items", value: totals?.total, icon: CheckCheck },
              { label: "In progress", value: totals?.active, icon: CircleDot },
              { label: "Completed", value: totals?.done, icon: CheckCheck },
            ].map(({ label, value, icon: Icon }) => <div key={label} className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{label}</span><Icon className="size-4 text-primary" /></div>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            </div>)}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">All projects <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{projects.length}</span></h2>
            <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search projects" placeholder="Search projects…" value={query} onChange={e => setQuery(e.target.value)} className="pl-9" /></div>
          </div>
        </>}
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <EmptyState icon={<FolderKanban className="size-5" />} title="Projects couldn't load" description={error.message} action={<Button variant="outline" onClick={() => void refetch()}>Try again</Button>} />
        ) : !projects?.length ? (
          <EmptyState
            icon={<FolderPlus className="size-5" />}
            title={canCreate ? "Create your first project" : "No projects yet"}
            description={canCreate ? "Pick the item types and workflow that fit — from a full Epic → Subtask hierarchy to a simple task list." : "You haven't been added to any project. Ask an admin to give you access."}
            action={
              canCreate && <Button asChild>
                <Link to={paths.newProject()}>
                  <Plus className="size-4" /> New project
                </Link>
              </Button>
            }
          />
        ) : !visible?.length ? (
          <EmptyState icon={<Search className="size-5" />} title="No matching projects" description="Try a different name or project key." action={<Button variant="outline" onClick={() => setQuery("")}>Clear search</Button>} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {visible.map((p) => {
              const pct = p.stats.total ? Math.round((p.stats.done / p.stats.total) * 100) : 0;
              return (
                <Link
                  key={p.id}
                  to={paths.project(p.key)}
                  className="group flex min-h-56 flex-col rounded-xl border bg-card p-5 shadow-xs transition-all hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-start gap-3">
                    <ProjectIcon icon={p.icon} color={p.color} size="lg" />
                    <div className="min-w-0 flex-1">
                      <h2 className="line-clamp-2 font-semibold group-hover:text-primary">{p.name}</h2>
                      <p className="font-mono text-xs text-muted-foreground">{p.key}</p>
                    </div>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                  </div>
                  {p.description && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{p.description}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {sortTypes(p.itemTypes).map((t, i) => (
                      <span key={t} className="flex items-center gap-1">
                        {i > 0 && <ChevronRight className="size-3" />}
                        <TypeIcon type={t} className="size-3.5" />
                      </span>
                    ))}
                    <span className="ml-1.5">· {p.statuses.length} statuses</span>
                  </div>
                  <div className="mt-auto pt-5">
                    <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
                      <span>
                        {p.stats.total} items · {p.stats.inProgress} in progress
                      </span>
                      <span className="font-medium tabular-nums text-foreground">{pct}%</span>
                    </div>
                    <ProgressBar progress={p.stats} />
                    <p className="mt-2 text-xs text-muted-foreground">{p.stats.done} of {p.stats.total} completed</p>
                  </div>
                </Link>
              );
            })}
            {canCreate && <Link
              to={paths.newProject()}
              className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/40 hover:text-foreground"
            >
              <Plus className="size-5" /> New project
              <span className="text-xs">Give your next idea a home</span>
            </Link>}
          </div>
        )}
      </div>
    </div>
  );
}
