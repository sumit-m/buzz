import { ChevronDown, FolderGit2 } from "lucide-react";

import type { Project, Repository } from "@/features/projects/hooks";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/**
 * LOCAL DIVERGENCE. Repository scope control for a workspace sheet tab.
 *
 * The sheet already holds one selected repository (`workspaceRepositoryId` in
 * `ProjectChannelHome`) and every repo-scoped query reads it, but upstream
 * renders the picker only inside the Codebase panel. On a project with two
 * repositories that leaves Reviews showing the alphabetically-first one with
 * nothing on screen saying so, and the only way to change it is to visit Files.
 *
 * Deliberately a copy of the Codebase panel's inline dropdown rather than an
 * extraction of it: upstream owns that component and is still iterating on this
 * surface. Duplicating ~25 lines keeps our diff to one new file plus one switch
 * arm, so when upstream fixes Reviews properly this is deleted rather than
 * merged.
 */
export function ProjectRepositoryScopePicker({
  onSelectRepository,
  project,
  repository,
  testId,
}: {
  onSelectRepository: (repositoryId: string) => void;
  project: Project;
  repository: Repository;
  testId: string;
}) {
  if (project.repositories.length <= 1) {
    return null;
  }

  return (
    <div className="shrink-0 px-4 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-7 max-w-full justify-start gap-2 px-2 text-sm font-normal"
            data-testid={`${testId}-trigger`}
            size="sm"
            type="button"
            variant="ghost"
          >
            <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{repository.name}</span>
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {project.repositories.map((candidate) => (
            <DropdownMenuItem
              key={candidate.id}
              onSelect={() => onSelectRepository(candidate.id)}
            >
              {candidate.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
