export function PreferenceSwitch({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly description: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="preference-switch" data-disabled={disabled || undefined}>
      <span className="preference-switch__copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="preference-switch__control">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="preference-switch__track" aria-hidden="true" />
      </span>
    </label>
  );
}
