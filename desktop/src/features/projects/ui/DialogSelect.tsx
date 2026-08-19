import { Check, ChevronDown } from "lucide-react";
import type * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/**
 * A labelled picker for the Projects dialogs.
 *
 * A native `<select>` renders its popup with the operating system's control
 * style, so no amount of CSS on the closed field makes the open list match the
 * app. This is the same `DropdownMenu` used everywhere else, dressed as a form
 * field.
 *
 * `helper` keeps its line whether or not it has anything to say, so the dialog
 * does not resize under the pointer while you choose.
 */
export function DialogSelect({
  ariaLabel,
  disabled,
  helper,
  itemTestId,
  label,
  onChange,
  options,
  placeholder,
  testId,
  triggerClassName,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  helper?: React.ReactNode;
  itemTestId?: (value: string) => string;
  label: React.ReactNode;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ label: string; value: string }>;
  placeholder: string;
  testId?: string;
  /** Match the surrounding form's field shell where it differs from a Button. */
  triggerClassName?: string;
  value: string;
}) {
  const selected = options.find((option) => option.value === value);

  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={ariaLabel}
            className={cn(
              "h-11 w-full justify-between rounded-xl px-3 font-normal",
              triggerClassName,
            )}
            data-testid={testId}
            disabled={disabled}
            type="button"
            variant="outline"
          >
            <span
              className={cn(
                "truncate",
                // Keyed off the value, not the match: an option may exist for
                // the empty value — "no channel" is a real answer — and it has
                // to still read as nothing chosen.
                value ? "text-foreground" : "text-muted-foreground/55",
              )}
            >
              {selected ? selected.label : placeholder}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
        >
          {options.map((option) => (
            <DropdownMenuItem
              className="justify-between gap-4"
              data-testid={itemTestId?.(option.value)}
              key={option.value}
              onSelect={() => onChange(option.value)}
            >
              <span className="min-w-0 truncate">{option.label}</span>
              {option.value === value ? (
                <Check className="h-4 w-4 shrink-0" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="min-h-4 text-xs text-muted-foreground">{helper}</p>
    </div>
  );
}
