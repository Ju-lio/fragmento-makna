import { useState } from 'react';
import { PRESETS } from '../engine/presets.ts';
import { validateEffect } from '../engine/effects.ts';
import { clone } from '../engine/project.ts';
import { player } from '../engine/player.ts';
import { CamposDeParams } from './CamposDeParams.tsx';
import { ESQUEMA_JANELA, janelaDeEfeito, comJanela } from '../criar/janela.ts';
import type { ValoresJanela } from '../criar/janela.ts';
import type { Effect, Layer, LayerPatch } from '../engine/types.ts';

interface EffectsPanelProps {
  layer: Layer | null;
  /** `coalesce: false` porque adicionar/remover efeito é ação discreta. */
  onChange: (id: number, patch: LayerPatch, coalesce?: boolean) => void;
}

export function EffectsPanel({ layer, onChange }: EffectsPanelProps) {
  const [json, setJson] = useState('');
  const [err, setErr] = useState('');
  /** Qual efeito está com os controles abertos. `null` = nenhum. */
  const [aberto, setAberto] = useState<number | null>(null);

  if (!layer) return <div className="hint">Selecione uma layer.</div>;

  const effects = layer.effects || [];

  const addEffect = (eff: Effect) => {
    // Sem o `false`, clicar em dois presets em sequência rápida viraria um
    // único passo de histórico e o Ctrl+Z removeria os dois.
    onChange(layer.id, { effects: [...effects, eff] }, false);
    player.seek(layer.start);   // jump to the start so you actually see it fire
  };

  const removeEffect = (i: number) => {
    onChange(layer.id, { effects: effects.filter((_, k) => k !== i) }, false);
    // Sem isto, remover o efeito de cima abriria os controles do que tomou o
    // lugar dele no array — o índice sobrevive ao efeito que ele apontava.
    setAberto(null);
  };

  /**
   * Troca um efeito no lugar.
   *
   * `coalesce` liga pra arrasto de slider: um gesto contínuo tem que virar UM
   * passo de histórico, senão o Ctrl+Z desfaz pixel a pixel. Clique em botão
   * passa `false` — ver o mesmo cuidado em `addEffect`.
   */
  const trocarEfeito = (i: number, eff: Effect, coalesce: boolean) => {
    onChange(layer.id, { effects: effects.map((e, k) => (k === i ? eff : e)) }, coalesce);
  };

  const applyJson = () => {
    const raw = json.trim();
    if (!raw) return setErr('Cole um JSON primeiro.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (ex) {
      return setErr('JSON inválido: ' + (ex instanceof Error ? ex.message : String(ex)));
    }
    const problem = validateEffect(parsed);
    if (problem) return setErr(problem);
    setErr('');
    // `validateEffect` acabou de estabelecer a forma; é aqui que `unknown`
    // legitimamente vira Effect, e em nenhum outro ponto.
    addEffect(parsed as Effect);
  };

  return (
    <div>
      <div className="field-label">Nesta layer</div>
      <div className="fx-list">
        {effects.length === 0 && <div className="hint">Nenhum efeito ainda.</div>}
        {effects.map((eff, i) => (
          <div key={i}>
            <div className={`fx-chip${aberto === i ? ' on' : ''}`}>
              <button
                className="fx-name fx-name-btn"
                onClick={() => setAberto(aberto === i ? null : i)}
                title="Abrir os controles deste efeito"
              >
                {aberto === i ? '▾' : '▸'} {eff.name || '(sem nome)'}
              </button>
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

            {/*
              Os controles nascem do ESQUEMA, não de campos escritos à mão —
              é o mesmo caminho que um efeito de terceiro vai usar pra ganhar
              painel. A janela de tempo é a cobaia porque já existia e só era
              editável colando JSON.
            */}
            {aberto === i && (
              <div className="fx-controles">
                <CamposDeParams
                  esquema={ESQUEMA_JANELA}
                  valores={janelaDeEfeito(eff)}
                  onChange={v => trocarEfeito(i, comJanela(eff, v as ValoresJanela), true)}
                  onChangeDiscreta={v => trocarEfeito(i, comJanela(eff, v as ValoresJanela), false)}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="field-label" style={{ marginTop: 10 }}>Presets</div>
      <div className="preset-grid">
        {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map(k => (
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
