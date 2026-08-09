export function PreferenceCheckbox({
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
    <label className="preference-checkbox" data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="preference-checkbox__copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}
