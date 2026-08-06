import type { AgentEffortLevelInfo } from "@/shared/api/types";
import {
  PERSONA_FIELD_DESCRIPTION_CLASS,
  PERSONA_LABEL_OPTIONAL_CLASS,
} from "./agentConfigOptions";
import type { EnvVarsValue } from "./EnvVarsEditor";
import { PersonaDropdownField } from "./PersonaDropdownField";

/**
 * Env var `buzz-acp` reads the effort level from. Same arrangement as
 * [`PERMISSION_MODE_ENV_KEY`]: the picker is a typed view onto one key rather
 * than a new record field, and the harness translates it into
 * `session/set_config_option` after the model switch.
 */
export const EFFORT_ENV_KEY = "BUZZ_ACP_EFFORT";

/**
 * Name a level using only what its harness said about it.
 *
 * The adapter derives these names from its own level ids, so Buzz shows what it
 * was given and falls back to the raw id — never a table of its own. See
 * `AgentPermissionModeField` for why that rule exists.
 */
function levelLabel(level: AgentEffortLevelInfo) {
  return level.label?.trim() || level.id;
}

/**
 * Reasoning-effort picker for the selected model.
 *
 * Renders nothing when the harness advertises no levels — which covers three
 * cases the operator does not need distinguished: the harness has no effort
 * control at all, the selected model has none, or the probe has not answered
 * yet. In every one of them there is nothing truthful to offer.
 *
 * Offers only what the harness advertised, so choosing "no particular effort"
 * means picking the adapter's own such value rather than one Buzz invented.
 * A consequence worth knowing: once set there is no dropdown route back to
 * unset — the adapter's no-override level is the way to express that.
 *
 * Unlike the permission mode, this list is **per model**. The adapter rebuilds
 * it on every model switch, so a level stored for one model may not exist for
 * the next; the field reads as unset in that case rather than showing a level
 * the harness would reject.
 */
export function AgentEffortField({
  disabled,
  envVars,
  id,
  levels,
  onEnvVarsChange,
}: {
  disabled?: boolean;
  envVars: EnvVarsValue;
  id: string;
  levels: readonly AgentEffortLevelInfo[];
  onEnvVarsChange: (next: EnvVarsValue) => void;
}) {
  if (levels.length === 0) {
    return null;
  }

  const stored = envVars[EFFORT_ENV_KEY]?.trim() ?? "";
  const selected = levels.find((level) => level.id === stored);
  const current = selected ? stored : "";
  const selectedDescription = selected?.description?.trim();
  // Only the harness's own levels — no synthetic "unset" row. The adapter
  // already ships its own no-override value (claude-agent-acp calls it
  // "Default" and maps it to a null effort flag), so adding one of ours put two
  // rows meaning almost the same thing next to each other. Until something is
  // chosen the control shows its placeholder, which is unset without pretending
  // to be a level.
  const options = levels.map((level) => ({
    label: levelLabel(level),
    value: level.id,
  }));

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        Effort
        <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
      </label>
      <PersonaDropdownField
        disabled={disabled}
        id={id}
        onValueChange={(value) => {
          onEnvVarsChange({ ...envVars, [EFFORT_ENV_KEY]: value });
        }}
        options={options}
        placeholder="Choose Effort"
        value={current}
      />
      {selectedDescription ? (
        <p className={PERSONA_FIELD_DESCRIPTION_CLASS}>{selectedDescription}</p>
      ) : null}
    </div>
  );
}
