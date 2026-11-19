import { ArrowDown, ArrowDownUp, ArrowUp } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  REPOSITORY_SORT_FIELDS,
  type RepositorySort,
  type RepositorySortDirection,
  type RepositorySortField,
  readRepositorySort,
  writeRepositorySort,
} from "./repositorySort";

/** LOCAL DIVERGENCE: the Files view's sort, remembered on this device. */
export function useRepositorySort() {
  const [sort, setSort] = React.useState(readRepositorySort);
  const change = React.useCallback((next: RepositorySort) => {
    setSort(next);
    writeRepositorySort(next);
  }, []);
  return [sort, change] as const;
}

/** The sort button beside the tiles/details toggle, and its menu. */
export function RepositorySortMenu({
  className,
  onChange,
  sort,
}: {
  className?: string;
  onChange: (sort: RepositorySort) => void;
  sort: RepositorySort;
}) {
  const current =
    REPOSITORY_SORT_FIELDS.find((option) => option.field === sort.field) ??
    REPOSITORY_SORT_FIELDS[0];
  const [ascending, descending] = current.directions;
  const DirectionIcon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the menu's clicks and keys (portalled, but bubbling through React) from reaching the header row, which opens the latest commit
    <span
      className={cn("inline-flex shrink-0", className)}
      onClick={stop}
      onKeyDown={stop}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`Sort by ${current.label}, ${sort.direction === "asc" ? ascending : descending}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
            data-testid="project-repository-sort"
            type="button"
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
            {current.label}
            <DirectionIcon className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Sort by
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) => {
              const field = value as RepositorySortField;
              const option = REPOSITORY_SORT_FIELDS.find(
                (candidate) => candidate.field === field,
              );
              if (!option) return;
              onChange({
                field,
                direction:
                  field === sort.field ? sort.direction : option.initial,
              });
            }}
            value={sort.field}
          >
            {REPOSITORY_SORT_FIELDS.map((option) => (
              <DropdownMenuRadioItem
                data-testid={`project-repository-sort-${option.field}`}
                key={option.field}
                value={option.field}
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              onChange({ ...sort, direction: value as RepositorySortDirection })
            }
            value={sort.direction}
          >
            <DropdownMenuRadioItem value="asc">
              <ArrowUp className="mr-1.5 h-3.5 w-3.5" />
              {ascending}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="desc">
              <ArrowDown className="mr-1.5 h-3.5 w-3.5" />
              {descending}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
