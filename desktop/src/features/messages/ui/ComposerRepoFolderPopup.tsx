import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, FolderPlus, Loader2 } from "lucide-react";
import * as React from "react";

import {
  folderSuggestions,
  foldersFromFilePaths,
  normalizeFolder,
} from "@/features/messages/lib/composerFolderSuggestions";
import { useRepoStateQuery } from "@/features/projects/hooks";
import type { Repository } from "@/features/projects/projectModels";
import { getProjectRepoFolders } from "@/shared/api/harnessComposer";
import type { ProjectRepoSnapshot } from "@/shared/api/projectGitTypes";
import { Input } from "@/shared/ui/input";

export type ChannelRepository = Repository;

/**
 * The repo's folders at its branch tip, cached in memory only. The tip comes
 * from the repo's published ref state, so a new commit refetches; a Files tab
 * snapshot already loaded at that tip is reused instead of cloning.
 */
function useRepoFolders(repository: Repository) {
  const queryClient = useQueryClient();
  const branch = repository.defaultBranch || null;
  const repoState = useRepoStateQuery(repository);
  const tip =
    repoState.data?.branches.find((candidate) => candidate.name === branch)
      ?.commit ?? null;
  return useQuery({
    enabled: Boolean(repository.cloneUrls[0]) && !repoState.isLoading,
    queryKey: ["project", repository.id, "repo-folders", branch, tip],
    queryFn: async () => {
      const snapshot = queryClient.getQueryData<ProjectRepoSnapshot>([
        "project",
        repository.id,
        "repo-snapshot",
        branch ?? "default",
        "none",
        "none",
        "no-tag",
        "no-tag-commit",
      ]);
      if (tip && snapshot?.latestCommit?.hash === tip) {
        return foldersFromFilePaths(snapshot.files.map((file) => file.path));
      }
      return getProjectRepoFolders({
        cloneUrl: repository.cloneUrls[0],
        branch,
      });
    },
    staleTime: tip ? Number.POSITIVE_INFINITY : 60_000,
  });
}

function FolderPicker({
  defaultFolder,
  onBack,
  onPick,
  repository,
}: {
  defaultFolder?: string;
  onBack: (() => void) | null;
  onPick: (folder: string) => void;
  repository: Repository;
}) {
  const [query, setQuery] = React.useState("");
  const folders = useRepoFolders(repository);
  const recent = defaultFolder ? [normalizeFolder(defaultFolder)] : [];
  const rows = folderSuggestions(folders.data ?? [], query, recent);

  return (
    <div className="flex w-64 flex-col gap-1.5">
      <p className="truncate text-xs font-medium">{repository.name}</p>
      <Input
        autoFocus
        className="h-8 text-sm"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && query.trim()) {
            event.preventDefault();
            onPick(normalizeFolder(query));
          }
        }}
        placeholder="Filter or new folder"
        value={query}
      />
      <div className="max-h-56 overflow-y-auto">
        {folders.isLoading ? (
          <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading folders…
          </p>
        ) : null}
        {folders.isError ? (
          <p className="px-2 py-1.5 text-xs text-destructive">
            Couldn't load folders. Type a folder instead.
          </p>
        ) : null}
        {rows.map((row) => (
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
            key={`${row.kind}:${row.path}`}
            onClick={() => onPick(row.path)}
            type="button"
          >
            {row.kind === "create" ? (
              <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
            ) : null}
            <span className="truncate">
              {row.kind === "root"
                ? "/"
                : row.kind === "create"
                  ? `Create ${row.path}`
                  : row.path}
            </span>
          </button>
        ))}
      </div>
      {onBack ? (
        <button
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Repos
        </button>
      ) : null}
    </div>
  );
}

/** Pick a channel repo, then a folder; the value is `<dtag>:<folder>/`. */
export function ComposerRepoFolderPopup({
  defaultFolder,
  onPick,
  repositories,
}: {
  defaultFolder?: string;
  onPick: (value: string) => void;
  repositories: ChannelRepository[];
}) {
  const [chosen, setChosen] = React.useState<Repository | null>(
    repositories.length === 1 ? repositories[0] : null,
  );
  if (repositories.length === 0) {
    return (
      <p className="w-56 text-sm text-muted-foreground">
        No repositories are bound to this channel.
      </p>
    );
  }
  if (chosen) {
    return (
      <FolderPicker
        defaultFolder={defaultFolder}
        onBack={repositories.length > 1 ? () => setChosen(null) : null}
        onPick={(folder) => onPick(`${chosen.owner}/${chosen.dtag}:${folder}`)}
        repository={chosen}
      />
    );
  }
  return (
    <div className="flex w-56 flex-col">
      {repositories.map((repository) => (
        <button
          className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
          key={repository.id}
          onClick={() => setChosen(repository)}
          type="button"
        >
          <span className="truncate">{repository.name}</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}
