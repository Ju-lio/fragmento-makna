import { NumField, TextField, Field } from './Win.jsx';

const SWATCHES = ['#f7efdc', '#f0c04a', '#e2615c', '#64c48a', '#6ba9d6', '#c9a6e8', '#241a33'];

export function PropsPanel({ layer, onChange }) {
  if (!layer) return <div className="hint">Selecione uma layer.</div>;

  const set = patch => onChange(layer.id, patch);

  return (
    <div>
      <TextField label="Nome" value={layer.name} onChange={v => set({ name: v })} />

      {layer.type === 'text' ? (
        <>
          <TextField label="Texto" value={layer.text} onChange={v => set({ text: v })} area rows={2} />
          <div className="row">
            <NumField label="Tamanho" value={layer.size} step={2} onChange={v => set({ size: v })} />
          </div>

          <Field label="Cor">
            <div className="swatches">
              {SWATCHES.map(c => (
                <button
                  key={c}
                  className={`swatch${layer.color === c ? ' on' : ''}`}
                  style={{ background: c }}
                  onClick={() => set({ color: c })}
                  title={c}
                />
              ))}
            </div>
            <input className="inp" value={layer.color} onChange={e => set({ color: e.target.value })} />
          </Field>
        </>
      ) : (
        <NumField label="Escala base" value={layer.fit ?? 0.8} step={0.05} onChange={v => set({ fit: v })} />
      )}

      <div className="row">
        <NumField label="Pos X" value={layer.x} step={10} onChange={v => set({ x: v })} />
        <NumField label="Pos Y" value={layer.y} step={10} onChange={v => set({ y: v })} />
      </div>

      <div className="row">
        <NumField label="Início (s)" value={layer.start} step={0.1} min={0} onChange={v => set({ start: v })} />
        <NumField label="Duração (s)" value={layer.duration} step={0.1} min={0.1} onChange={v => set({ duration: v })} />
      </div>
    </div>
  );
}
