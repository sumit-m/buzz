import {
  Check,
  Clock,
  ClockPlus,
  GitBranch,
  Image as ImageIcon,
  ImagePlay,
  Layers,
  LoaderCircle,
  type LucideIcon,
  Minus,
  Plus,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Speech,
  UserPlus,
  WandSparkles,
  X,
} from "lucide-react";
import * as React from "react";

import {
  activePreset,
  applyPreset,
  type ComposerControl,
  controlShown,
  type ComposerPanelState,
  type ComposerSpec,
  optionsFor,
  pickValue,
  presetControl,
  presetOptions,
  repoControl,
  resolvePanel,
  setMode,
  setRepo,
  valueControls,
} from "@/features/messages/lib/composerHarnessState";
import { assetControls } from "@/features/messages/lib/promptHandles";
import { cn } from "@/shared/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import {
  type ChannelRepository,
  ComposerRepoFolderPopup,
} from "./ComposerRepoFolderPopup";
import { AssetRow } from "./HarnessAssets";

const ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  wand: WandSparkles,
  "git-branch": GitBranch,
  photo: ImageIcon,
  "user-plus": UserPlus,
  shapes: Shapes,
  layers: Layers,
  "image-play": ImagePlay,
  speech: Speech,
  clock: Clock,
  "clock-plus": ClockPlus,
};

const BUTTON_CLASS =
  "inline-flex h-8 items-center gap-2 rounded-full border border-border/60 px-3 text-sm text-foreground transition-colors hover:bg-muted/60 data-[state=open]:bg-muted/70";

/** `16:9` as a shape to draw, for an option with no pixel size. */
function ratioOf(value: string): [number, number] | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

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
  heading,
  keepEditorFocus = false,
  label,
  open,
  onOpenChange,
  trigger,
  testId,
}: {
  children: React.ReactNode;
  heading?: React.ReactNode;
  /** A pick writes into the prompt, so closing leaves focus in the editor. */
  keepEditorFocus?: boolean;
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
      <PopoverContent
        align="start"
        className="w-auto min-w-48 p-3"
        onCloseAutoFocus={
          keepEditorFocus ? (event) => event.preventDefault() : undefined
        }
        side="top"
      >
        <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          {heading ?? label}
        </p>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function ListRows({
  hintBelow = false,
  options,
  selected,
  onPick,
}: {
  /** The hint as a line under the label (a model's speed), keeping the check. */
  hintBelow?: boolean;
  options: { value: string; label: string; hint?: string }[];
  selected: string | null;
  onPick: (value: string | null) => void;
}) {
  const check = (value: string) =>
    selected === value ? <Check className="h-3.5 w-3.5" /> : null;
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
          {hintBelow ? (
            <span className="flex flex-col">
              {option.label}
              {option.hint ? (
                <span className="text-xs text-muted-foreground">
                  {option.hint}
                </span>
              ) : null}
            </span>
          ) : (
            <span>{option.label}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {hintBelow
              ? check(option.value)
              : (option.hint ?? check(option.value))}
          </span>
        </button>
      ))}
    </div>
  );
}

/** − N +, changed only by its buttons. */
function NumberStepper({
  max,
  min,
  onChange,
  unit,
  value,
}: {
  max: number;
  min: number;
  onChange: (value: number) => void;
  unit?: string;
  value: number;
}) {
  const set = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== value) onChange(clamped);
  };
  const stepClass =
    "flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-foreground hover:bg-muted/60 disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <button
        aria-label="Fewer"
        className={stepClass}
        disabled={value <= min}
        onClick={() => set(value - 1)}
        type="button"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <output
        aria-live="polite"
        className="flex h-8 w-12 items-center justify-center rounded-md border border-border/60 text-sm tabular-nums"
      >
        {value}
      </output>
      <button
        aria-label="More"
        className={stepClass}
        disabled={value >= max}
        onClick={() => set(value + 1)}
        type="button"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {unit ? (
        <span className="text-sm text-muted-foreground">{unit.trim()}</span>
      ) : null}
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
  onControlOpen,
  onInsertHandle,
  onMenuOpen,
  refreshingId,
  repositories,
  spec,
  state,
}: {
  error: string | null;
  onChange: (state: ComposerPanelState) => void;
  /** A control with a `refresh` opened its menu. */
  onControlOpen?: (controlId: string) => void;
  /** An `assets` pick: puts `@handle` in the prompt. */
  onInsertHandle?: (handle: string) => void;
  /** A model, aspect, resolution or preset menu opened: re-read the panel. */
  onMenuOpen?: () => void;
  refreshingId?: string | null;
  repositories: ChannelRepository[];
  spec: ComposerSpec;
  state: ComposerPanelState;
}) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const openChange = (id: string) => (open: boolean) =>
    setOpenId(open ? id : null);
  const preset = presetControl(spec);
  const pickedPreset = activePreset(state, spec);
  const repo = repoControl(spec);
  const close = (next: ComposerPanelState) => {
    onChange(next);
    setOpenId(null);
  };
  const resolved = resolvePanel(state, spec);
  const pick = (control: ComposerControl, value: string) =>
    close(pickValue(state, spec, control.id, value));

  const renderValueControl = (control: ComposerControl) => {
    const current = resolved.options[control.id] ?? null;
    const value = resolved.values[control.id] ?? "";
    const options = optionsFor(
      control,
      state.mode,
      resolved.values,
      state.images,
    );
    const Icon = control.icon ? ICONS[control.icon] : undefined;
    const testId = `composer-control-${control.id}`;
    const onOpenChange = (open: boolean) => {
      if (open) onMenuOpen?.();
      openChange(control.id)(open);
    };
    if (control.kind === "shapes") {
      return (
        <ControlPopup
          key={control.id}
          label={control.label}
          onOpenChange={onOpenChange}
          open={openId === control.id}
          testId={testId}
          trigger={
            <>
              <Shape max={14} size={current?.size ?? ratioOf(value)} />
              {current?.label ?? value}
            </>
          }
        >
          <div className="grid grid-cols-3 gap-1.5">
            {options.map((option) => (
              <button
                className={cn(
                  "flex h-24 w-20 flex-col items-center justify-end gap-1.5 rounded-md pb-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  value === option.value && "bg-muted/70 text-foreground",
                )}
                key={option.value}
                onClick={() => pick(control, option.value)}
                type="button"
              >
                <Shape max={30} size={option.size ?? ratioOf(option.value)} />
                <span>{option.label}</span>
                {option.hint ? (
                  <span className="-mt-1 text-2xs text-muted-foreground">
                    {option.hint}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </ControlPopup>
      );
    }
    if (control.kind === "number") {
      return (
        <ControlPopup
          key={control.id}
          label={control.label}
          onOpenChange={onOpenChange}
          open={openId === control.id}
          testId={testId}
          trigger={
            <>
              {Icon ? <Icon className="h-4 w-4" /> : null}
              {current?.label ?? value}
            </>
          }
        >
          <NumberStepper
            max={Number(options[options.length - 1]?.value ?? value)}
            min={Number(options[0]?.value ?? value)}
            onChange={(next) =>
              onChange(pickValue(state, spec, control.id, String(next)))
            }
            unit={control.unit}
            value={Number(value)}
          />
        </ControlPopup>
      );
    }
    if (control.kind === "segmented") {
      return (
        <ControlPopup
          key={control.id}
          label={control.label}
          onOpenChange={onOpenChange}
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
                onClick={() => pick(control, option.value)}
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
        onOpenChange={onOpenChange}
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
          hintBelow
          onPick={(picked) => (picked ? pick(control, picked) : undefined)}
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
        {valueControls(spec)
          .filter((control) => controlShown(control, resolved))
          .map(renderValueControl)}
        {preset && presetOptions(spec, state.mode).length > 0 ? (
          <ControlPopup
            label={preset.label}
            onOpenChange={(open) => {
              if (open) onMenuOpen?.();
              openChange(preset.id)(open);
            }}
            open={openId === preset.id}
            testId={`composer-control-${preset.id}`}
            trigger={
              <>
                <PresetIcon className="h-4 w-4" />
                <span className={pickedPreset ? "" : "text-muted-foreground"}>
                  {pickedPreset ?? preset.label}
                </span>
              </>
            }
          >
            <ListRows
              onPick={(picked) => close(applyPreset(state, spec, picked))}
              options={[
                { value: "", label: "None" },
                ...presetOptions(spec, state.mode).map((option) => ({
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
              selected={pickedPreset ?? ""}
            />
          </ControlPopup>
        ) : null}
        {assetControls(spec)
          .filter((control) => controlShown(control, resolved))
          .map((control) => {
            const Icon = (control.icon && ICONS[control.icon]) || UserPlus;
            return (
              <ControlPopup
                heading={
                  <>
                    {control.title ?? control.label}
                    {refreshingId === control.id ? (
                      <LoaderCircle
                        aria-label="Refreshing"
                        className="h-3 w-3 animate-spin"
                      />
                    ) : null}
                  </>
                }
                keepEditorFocus
                key={control.id}
                label={control.label}
                onOpenChange={(open) => {
                  if (open && control.refresh?.length) {
                    onControlOpen?.(control.id);
                  }
                  openChange(control.id)(open);
                }}
                open={openId === control.id}
                testId={`composer-control-${control.id}`}
                trigger={
                  <>
                    <Icon className="h-4 w-4" />
                    {control.label}
                  </>
                }
              >
                {control.options.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    {refreshingId === control.id ? "Loading…" : "None found"}
                  </p>
                ) : (
                  <div className="-mx-1 flex max-h-80 min-w-64 flex-col overflow-y-auto">
                    {control.options.map((option) => (
                      <button
                        className="rounded-lg px-2 py-2 hover:bg-muted/60"
                        key={option.value}
                        onClick={() => {
                          onInsertHandle?.(option.value);
                          setOpenId(null);
                        }}
                        type="button"
                      >
                        <AssetRow large option={option} />
                      </button>
                    ))}
                  </div>
                )}
              </ControlPopup>
            );
          })}
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
  if (spec.modes.length === 0) return null;
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
