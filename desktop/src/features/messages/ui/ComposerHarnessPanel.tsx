import {
  Check,
  GitBranch,
  Image as ImageIcon,
  type LucideIcon,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import * as React from "react";

import {
  applyPreset,
  type ComposerControl,
  type ComposerPanelState,
  type ComposerSpec,
  effectiveOption,
  effectiveValue,
  optionsFor,
  pickValue,
  presetControl,
  repoControl,
  scaledSize,
  setMode,
  setRepo,
  valueControls,
} from "@/features/messages/lib/composerHarnessState";
import { cn } from "@/shared/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import {
  type ChannelRepository,
  ComposerRepoFolderPopup,
} from "./ComposerRepoFolderPopup";

const ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  wand: WandSparkles,
  "git-branch": GitBranch,
  photo: ImageIcon,
};

const BUTTON_CLASS =
  "inline-flex h-8 items-center gap-2 rounded-full border border-border/60 px-3 text-sm text-foreground transition-colors hover:bg-muted/60 data-[state=open]:bg-muted/70";

function Shape({ size, max }: { size?: [number, number]; max: number }) {
  if (!size) {
    return (
      <span
        className="inline-block rounded-[3px] border-[1.5px] border-dashed border-current"
        style={{ width: max * 0.7, height: max * 0.7 }}
      />
    );
  }
  const scale = max / Math.max(size[0], size[1]);
  return (
    <span
      className="inline-block rounded-[3px] border-[1.5px] border-current"
      style={{
        width: Math.round(size[0] * scale),
        height: Math.round(size[1] * scale),
      }}
    />
  );
}

function ControlPopup({
  children,
  label,
  open,
  onOpenChange,
  trigger,
  testId,
}: {
  children: React.ReactNode;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  testId: string;
}) {
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger
        aria-label={label}
        className={BUTTON_CLASS}
        data-testid={testId}
        type="button"
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-48 p-3" side="top">
        <p className="mb-2 text-xs text-muted-foreground">{label}</p>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function ListRows({
  options,
  selected,
  onPick,
}: {
  options: { value: string; label: string; hint?: string }[];
  selected: string | null;
  onPick: (value: string | null) => void;
}) {
  return (
    <div className="flex flex-col">
      {options.map((option) => (
        <button
          className={cn(
            "flex items-center justify-between gap-6 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60",
            selected === option.value && "bg-muted/60",
          )}
          key={option.value || "none"}
          onClick={() => onPick(option.value || null)}
          type="button"
        >
          <span>{option.label}</span>
          <span className="text-xs text-muted-foreground">
            {option.hint ??
              (selected === option.value ? (
                <Check className="h-3.5 w-3.5" />
              ) : null)}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * LOCAL DIVERGENCE: the message-box panel a custom harness declares — a mode
 * toggle (rendered separately, top right) and a row of popup controls. It
 * shows values only; the harness maps them to its CLI.
 */
export function ComposerHarnessControls({
  error,
  onChange,
  repositories,
  spec,
  state,
}: {
  error: string | null;
  onChange: (state: ComposerPanelState) => void;
  repositories: ChannelRepository[];
  spec: ComposerSpec;
  state: ComposerPanelState;
}) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const openChange = (id: string) => (open: boolean) =>
    setOpenId(open ? id : null);
  const preset = presetControl(spec);
  const repo = repoControl(spec);
  const close = (next: ComposerPanelState) => {
    onChange(next);
    setOpenId(null);
  };

  const renderValueControl = (control: ComposerControl) => {
    const current = effectiveOption(state, control);
    const value = effectiveValue(state, control);
    const options = optionsFor(control, state.mode);
    const Icon = control.icon ? ICONS[control.icon] : undefined;
    const testId = `composer-control-${control.id}`;
    if (control.kind === "shapes") {
      return (
        <ControlPopup
          key={control.id}
          label={control.label}
          onOpenChange={openChange(control.id)}
          open={openId === control.id}
          testId={testId}
          trigger={
            <>
              <Shape max={14} size={current?.size} />
              {current?.label ?? value}
            </>
          }
        >
          <div className="grid grid-cols-3 gap-1.5">
            {options.map((option) => {
              const size = scaledSize(option, state, spec);
              return (
                <button
                  className={cn(
                    "flex h-24 w-20 flex-col items-center justify-end gap-1.5 rounded-md pb-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    value === option.value && "bg-muted/70 text-foreground",
                  )}
                  key={option.value}
                  onClick={() =>
                    close(pickValue(state, control.id, option.value))
                  }
                  type="button"
                >
                  <Shape max={30} size={option.size} />
                  <span>{option.label}</span>
                  {size ? (
                    <span className="-mt-1 text-[11px] text-muted-foreground">
                      {size[0]}×{size[1]}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </ControlPopup>
      );
    }
    if (control.kind === "segmented") {
      return (
        <ControlPopup
          key={control.id}
          label={control.label}
          onOpenChange={openChange(control.id)}
          open={openId === control.id}
          testId={testId}
          trigger={current?.label ?? value}
        >
          <div className="flex gap-1">
            {options.map((option) => (
              <button
                className={cn(
                  "rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  value === option.value && "bg-muted/70 text-foreground",
                )}
                key={option.value}
                onClick={() =>
                  close(pickValue(state, control.id, option.value))
                }
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </ControlPopup>
      );
    }
    return (
      <ControlPopup
        key={control.id}
        label={control.label}
        onOpenChange={openChange(control.id)}
        open={openId === control.id}
        testId={testId}
        trigger={
          <>
            {Icon ? <Icon className="h-4 w-4" /> : null}
            {current?.label ?? value}
          </>
        }
      >
        <ListRows
          onPick={(picked) =>
            picked ? close(pickValue(state, control.id, picked)) : undefined
          }
          options={options}
          selected={value}
        />
      </ControlPopup>
    );
  };

  const PresetIcon = (preset?.icon && ICONS[preset.icon]) || WandSparkles;
  const RepoIcon = (repo?.icon && ICONS[repo.icon]) || GitBranch;
  const repoLabel = (() => {
    if (!state.repo) return null;
    const [qualified, folder] = [
      state.repo.slice(0, state.repo.indexOf(":")),
      state.repo.slice(state.repo.indexOf(":") + 1),
    ];
    const dtag = qualified.slice(qualified.indexOf("/") + 1);
    const name = repositories.find((r) => r.dtag === dtag)?.name ?? dtag;
    return `${name}: ${folder || "/"}`;
  })();

  return (
    <div
      className="mt-4 -mb-4 flex flex-col gap-1"
      data-testid="composer-harness-controls"
    >
      <div className="-ml-2 flex flex-wrap items-center gap-1.5">
        {valueControls(spec).map(renderValueControl)}
        {preset ? (
          <ControlPopup
            label={preset.label}
            onOpenChange={openChange(preset.id)}
            open={openId === preset.id}
            testId={`composer-control-${preset.id}`}
            trigger={
              <>
                <PresetIcon className="h-4 w-4" />
                <span className={state.preset ? "" : "text-muted-foreground"}>
                  {state.preset ?? preset.label}
                </span>
              </>
            }
          >
            <ListRows
              onPick={(picked) => close(applyPreset(state, spec, picked))}
              options={[
                { value: "", label: "None" },
                ...preset.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                  hint: Object.entries(option.sets ?? {})
                    .map(([id, value]) => {
                      const control = spec.controls.find((c) => c.id === id);
                      return (
                        control?.options.find((o) => o.value === value)
                          ?.label ?? value
                      );
                    })
                    .join(" · "),
                })),
              ]}
              selected={state.preset ?? ""}
            />
          </ControlPopup>
        ) : null}
        {repo && (repositories.length > 0 || state.repo) ? (
          <span className="inline-flex items-center">
            <ControlPopup
              label={repo.label}
              onOpenChange={openChange(repo.id)}
              open={openId === repo.id}
              testId={`composer-control-${repo.id}`}
              trigger={
                <>
                  <RepoIcon className="h-4 w-4" />
                  {repoLabel}
                </>
              }
            >
              <ComposerRepoFolderPopup
                defaultFolder={repo.defaultFolder}
                onPick={(value) => close(setRepo(state, value))}
                repositories={repositories}
              />
            </ControlPopup>
            {state.repo ? (
              <button
                aria-label="Clear repo"
                className="ml-0.5 rounded-full p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                onClick={() => onChange(setRepo(state, null))}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </span>
        ) : null}
        {valueControls(spec).length === 0 && !preset && !repo ? (
          <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ComposerHarnessModeToggle({
  onChange,
  spec,
  state,
}: {
  onChange: (state: ComposerPanelState) => void;
  spec: ComposerSpec;
  state: ComposerPanelState;
}) {
  if (spec.modes.length < 2) return null;
  return (
    <div
      className="flex shrink-0 rounded-full bg-muted/60 p-0.5"
      data-testid="composer-harness-mode"
    >
      {spec.modes.map((mode) => (
        <button
          aria-pressed={state.mode === mode.id}
          className={cn(
            "rounded-full px-4 py-1 text-sm text-muted-foreground",
            state.mode === mode.id &&
              "border border-border/60 bg-background text-foreground",
          )}
          key={mode.id}
          onClick={() => onChange(setMode(state, mode.id))}
          type="button"
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}
