import { useState } from 'react';
import { PRESETS } from '../engine/presets.js';
import { validateEffect } from '../engine/effects.js';
import { clone } from '../engine/project.js';
import { player } from '../engine/player.js';

export function EffectsPanel({ layer, onChange }) {
  const [json, setJson] = useState('');
  const [err, setErr] = useState('');

  if (!layer) return <div className="hint">Selecione uma layer.</div>;

  const effects = layer.effects || [];

  const addEffect = eff => {
    onChange(layer.id, { effects: [...effects, eff] });
    player.seek(layer.start);   // jump to the start so you actually see it fire
  };

  const removeEffect = i => {
    onChange(layer.id, { effects: effects.filter((_, k) => k !== i) });
  };

  const applyJson = () => {
    const raw = json.trim();
    if (!raw) return setErr('Cole um JSON primeiro.');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (ex) {
      return setErr('JSON inválido: ' + ex.message);
    }
    const problem = validateEffect(parsed);
    if (problem) return setErr(problem);
    setErr('');
    addEffect(parsed);
  };

  return (
    <div>
      <div className="field-label">Nesta layer</div>
      <div className="fx-list">
        {effects.length === 0 && <div className="hint">Nenhum efeito ainda.</div>}
        {effects.map((eff, i) => (
          <div className="fx-chip" key={i}>
            <span className="fx-name">{eff.name || '(sem nome)'}</span>
            {eff.loop && <span className="fx-badge">loop</span>}
            {eff.anchor === 'end' && <span className="fx-badge fx-badge-out">out</span>}
            <button
              className="btn btn-sm"
              onClick={() => setJson(JSON.stringify(eff, null, 2))}
              title="Carregar no editor abaixo"
            >
              ✎
            </button>
            <button className="btn btn-sm btn-coral" onClick={() => removeEffect(i)}>✕</button>
          </div>
        ))}
      </div>

      <div className="field-label" style={{ marginTop: 10 }}>Presets</div>
      <div className="preset-grid">
        {Object.keys(PRESETS).map(k => (
          <button key={k} className="btn btn-sm preset-btn" onClick={() => addEffect(clone(PRESETS[k]))}>
            {k}
          </button>
        ))}
      </div>

      <div className="field-label" style={{ marginTop: 10 }}>Colar efeito (JSON)</div>
      <textarea
        className="inp"
        style={{ height: 150 }}
        spellCheck={false}
        value={json}
        onChange={e => setJson(e.target.value)}
        placeholder='{ "name": "...", "duration": 0.6, "tracks": [...] }'
      />
      <div className="err">{err}</div>
      <button className="btn btn-gold" style={{ width: '100%' }} onClick={applyJson}>
        + Adicionar à layer
      </button>

      <div className="hint" style={{ marginTop: 8 }}>
        Clique em <b>SCHEMA</b> na barra de cima, cole no chat com o efeito que você
        quer, e traga o JSON de volta pra cá.
      </div>
    </div>
  );
}
