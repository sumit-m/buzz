import type { EnvVarsValue } from "./EnvVarsEditor";
import { PERSONA_LABEL_OPTIONAL_CLASS } from "./agentConfigOptions";
import { PersonaDropdownField } from "./PersonaDropdownField";

/**
 * Env var the harness reads its permission mode from. The picker is a typed
 * view onto this one key rather than a new record field: `descriptor.env` is
 * written last at spawn (see `runtime.rs`), the key is not reserved, and the
 * value is what already worked when set by hand. Nothing new to migrate, and
 * the raw Advanced → env editor stays the escape hatch.
 */
export const PERMISSION_MODE_ENV_KEY = "BUZZ_ACP_PERMISSION_MODE";

/** Labels for the modes claude-agent-acp advertises. Unknown ids show raw. */
const MODE_LABELS: Record<string, string> = {
  acceptEdits: "Accept edits — auto-approve file edits, ask for other tools",
  auto: "Auto — the harness decides, no prompt",
  bypassPermissions: "Bypass permissions — skip the permission flow entirely",
  default: "Manual — ask for every tool call",
  dontAsk: "Don't ask — refuse anything needing approval",
  plan: "Plan only — no tool execution",
};

function modeLabel(mode: string) {
  return MODE_LABELS[mode] ?? mode;
}

/**
 * Permission-mode picker, populated from whatever the harness advertises.
 *
 * LOCAL: deliberately unfiltered. Upstream removed `bypassPermissions` so it
 * could not be chosen (block/buzz#4609); here the operator picks. `buzz-acp`
 * still never *grants* a permission request — `handle_permission_request`
 * denies unconditionally regardless of this value.
 *
 * Renders nothing when the harness advertises no modes (goose, buzz-agent) or
 * when discovery has not run, so no harness gets a list invented for it.
 */
export function AgentPermissionModeField({
  disabled,
  envVars,
  id,
  modes,
  onEnvVarsChange,
}: {
  disabled?: boolean;
  envVars: EnvVarsValue;
  id: string;
  modes: readonly string[];
  onEnvVarsChange: (next: EnvVarsValue) => void;
}) {
  if (modes.length === 0) {
    return null;
  }

  const current = envVars[PERMISSION_MODE_ENV_KEY]?.trim() ?? "";
  const options = [
    { label: "Harness default", value: "" },
    ...modes.map((mode) => ({ label: modeLabel(mode), value: mode })),
  ];
  // A mode saved by hand, or by a harness that has since stopped listing it,
  // must stay visible — otherwise opening the dialog silently discards it.
  if (current && !modes.includes(current)) {
    options.push({ label: `${current} (not advertised)`, value: current });
  }

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        Mode
        <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
      </label>
      <PersonaDropdownField
        disabled={disabled}
        id={id}
        onValueChange={(value) => {
          const next = { ...envVars };
          if (value) {
            next[PERMISSION_MODE_ENV_KEY] = value;
          } else {
            delete next[PERMISSION_MODE_ENV_KEY];
          }
          onEnvVarsChange(next);
        }}
        options={options}
        placeholder="Harness default"
        value={current}
      />
      <p className="text-xs text-muted-foreground">
        Agents reply by running the <code>buzz</code> CLI, which the default{" "}
        <code>dontAsk</code> refuses. Pick <code>auto</code> if an agent says it
        cannot send messages.
      </p>
    </div>
  );
}
