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
  const options = [
    { label: "Harness default", value: "" },
    ...levels.map((level) => ({ label: levelLabel(level), value: level.id })),
  ];

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
          const next = { ...envVars };
          if (value) {
            next[EFFORT_ENV_KEY] = value;
          } else {
            delete next[EFFORT_ENV_KEY];
          }
          onEnvVarsChange(next);
        }}
        options={options}
        placeholder="Harness default"
        value={current}
      />
      {selectedDescription ? (
        <p className={PERSONA_FIELD_DESCRIPTION_CLASS}>{selectedDescription}</p>
      ) : null}
    </div>
  );
}
