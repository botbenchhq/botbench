/** One option of an option picker: a native radio in a full-width row, named by its name and described by its description and state. */
export function Option({ group, id, value, checked, onChange, name, description, state, disabled = false, warning = false, path = null }: { group: string; id: string; value: string; checked: boolean; onChange: () => void; name: string; description?: string | null; state?: string | null; disabled?: boolean; warning?: boolean; path?: [string, string] | null }) {
  const described = [state ? `${id}-state` : null, description || path ? `${id}-description` : null].filter((x) => x !== null).join(" ");
  return (
    <label className="ds-option-picker__option">
      <input className="ds-option-picker__input" type="radio" name={group} value={value} checked={checked} disabled={disabled} onChange={onChange} aria-labelledby={`${id}-name`} aria-describedby={described === "" ? undefined : described} />
      <span className="ds-option-picker__body">
        <span className="ds-option-picker__text">
          <span className="ds-option-picker__name" id={`${id}-name`}>
            {name}
          </span>
          {path !== null ? (
            <span className="ds-option-picker__description" id={`${id}-description`} data-ds-content="">
              {/* Drawn cut in the middle; read out whole, as a browser reads a space between the two drawn parts. */}
              <span className="ds-option-picker__path" aria-hidden="true">
                <span className="ds-option-picker__start">{path[0]}</span>
                <span className="ds-option-picker__end">{path[1]}</span>
              </span>
              <span className="ds-visually-hidden">{path.join("")}</span>
            </span>
          ) : (
            description && (
              <span className="ds-option-picker__description" id={`${id}-description`}>
                {description}
              </span>
            )
          )}
        </span>
        {state && (
          <span className={warning ? "ds-option-picker__state ds-option-picker__state--warning" : "ds-option-picker__state"} id={`${id}-state`}>
            {state}
          </span>
        )}
      </span>
    </label>
  );
}
