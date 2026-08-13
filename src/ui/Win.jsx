/** A beveled pixel window with a hatched title bar. */
export function Win({ title, icon, right, children, className = '', bodyClass = '', style }) {
  return (
    <div className={`win ${className}`} style={style}>
      <div className="win-title">
        {icon && <span aria-hidden="true">{icon}</span>}
        <span>{title}</span>
        <span className="stripes" />
        {right}
      </div>
      <div className={`win-body ${bodyClass}`}>{children}</div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

export function NumField({ label, value, onChange, step = 1, min }) {
  return (
    <Field label={label}>
      <input
        className="inp"
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
      />
    </Field>
  );
}

export function TextField({ label, value, onChange, area = false, rows = 2 }) {
  const Cmp = area ? 'textarea' : 'input';
  return (
    <Field label={label}>
      <Cmp
        className="inp"
        value={value}
        rows={area ? rows : undefined}
        onChange={e => onChange(e.target.value)}
      />
    </Field>
  );
}
