import type { AgentPermissionModeInfo } from "@/shared/api/types";
import {
  PERSONA_FIELD_DESCRIPTION_CLASS,
  PERSONA_LABEL_OPTIONAL_CLASS,
} from "./agentConfigOptions";
import type { EnvVarsValue } from "./EnvVarsEditor";
import { PersonaDropdownField } from "./PersonaDropdownField";

/**
 * Env var the harness reads its permission mode from. The picker is a typed
 * view onto this one key rather than a new record field: `descriptor.env` is
 * written last at spawn (see `runtime.rs`), the key is not reserved, and the
 * value is what already worked when set by hand. Nothing new to migrate, and
 * the raw Advanced → env editor stays the escape hatch.
 */
export const PERMISSION_MODE_ENV_KEY = "BUZZ_ACP_PERMISSION_MODE";

/**
 * Name a mode using only what its harness said about it.
 *
 * Buzz deliberately ships no label table. Mode ids are per-harness — `auto` is
 * claude-agent-acp's and exists nowhere else — and the same spelling can mean
 * something different on another adapter, so inventing names here would be
 * guessing on the operator's behalf. An adapter that supplies nothing shows
 * its raw id, which is at least true.
 *
 * The description is deliberately left out: it belongs under the field, where
 * it has the full dialog width, rather than in a dropdown row that clips it.
 */
function modeLabel(mode: AgentPermissionModeInfo) {
  return mode.label?.trim() || mode.id;
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
  modes: readonly AgentPermissionModeInfo[];
  onEnvVarsChange: (next: EnvVarsValue) => void;
}) {
  if (modes.length === 0) {
    return null;
  }

  const stored = envVars[PERMISSION_MODE_ENV_KEY]?.trim() ?? "";
  const selected = modes.find((mode) => mode.id === stored);
  // Only ever offer what this harness advertises. A stored mode it does not
  // support — `auto` seeded for Claude, then the model or harness changed —
  // is not a choice here, so the control reads as unset rather than listing a
  // mode that would be rejected. Modes are per-harness and `auto` is further
  // gated per-model by `supportsAutoMode`, so this is a normal transition.
  const current = selected ? stored : "";
  // Shown under the field so it gets the dialog's full width. Absent while
  // unset, and for adapters that ship names without descriptions.
  const selectedDescription = selected?.description?.trim();
  // Only the harness's own modes — no synthetic "unset" row. Every adapter that
  // advertises modes also advertises one meaning "ask me normally"
  // (claude-agent-acp calls it "Manual"), so ours only added a second row for
  // an idea the harness already had a name for. Until something is chosen the
  // control shows its placeholder.
  const options = modes.map((mode) => ({
    label: modeLabel(mode),
    value: mode.id,
  }));

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
          onEnvVarsChange({ ...envVars, [PERMISSION_MODE_ENV_KEY]: value });
        }}
        options={options}
        placeholder="Not set"
        value={current}
      />
      {selectedDescription ? (
        <p className={PERSONA_FIELD_DESCRIPTION_CLASS}>{selectedDescription}</p>
      ) : null}
    </div>
  );
}
