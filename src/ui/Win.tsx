import type { CSSProperties, ReactNode } from 'react';

interface WinProps {
  title: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClass?: string;
  style?: CSSProperties;
}

/** A beveled pixel window with a hatched title bar. */
export function Win({ title, icon, right, children, className = '', bodyClass = '', style }: WinProps) {
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

interface FieldProps {
  label: ReactNode;
  children?: ReactNode;
}

export function Field({ label, children }: FieldProps) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

interface NumFieldProps {
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
}

export function NumField({ label, value, onChange, step = 1, min }: NumFieldProps) {
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

interface TextFieldProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** Renderiza um `<textarea>` no lugar do `<input>`. */
  area?: boolean;
  rows?: number;
}

export function TextField({ label, value, onChange, area = false, rows = 2 }: TextFieldProps) {
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
