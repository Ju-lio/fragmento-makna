import { NumField, TextField, Field } from './Win.tsx';
import { maxDuration } from '../engine/project.ts';
import { seedCountUpFromText } from '../engine/countUp.ts';
import { EASE_NAMES } from '../engine/easings.ts';
import type { CountUp, Layer, LayerPatch } from '../engine/types.ts';

interface PropsPanelProps {
  layer: Layer | null;
  onChange: (id: number, patch: LayerPatch) => void;
  /** Tira o som do clipe de vídeo e o põe numa faixa própria. */
  onDetachAudio: (id: number) => void;
}

const SWATCHES = ['#f7efdc', '#f0c04a', '#e2615c', '#64c48a', '#6ba9d6', '#c9a6e8', '#241a33'];

export function PropsPanel({ layer, onChange, onDetachAudio }: PropsPanelProps) {
  if (!layer) return <div className="hint">Selecione uma layer.</div>;

  const set = (patch: LayerPatch) => onChange(layer.id, patch);

  return (
    <div>
      <TextField label="Nome" value={layer.name} onChange={v => set({ name: v })} />

      {layer.type === 'text' ? (
        <>
          <TextField
            label="Texto"
            value={layer.text}
            onChange={v => set({ text: v })}
            area
            rows={2}
            disabled={Boolean(layer.countUp)}
          />
          {layer.countUp && <div className="hint">Ocupado pelo contador — desligue pra editar</div>}

          {/*
            O contador SUBSTITUI o texto, nunca combina — ver `CountUp` em
            types.ts. Por isso o campo "Texto" acima fica desabilitado (não
            escondido: o valor continua existindo, é o que volta se você
            desligar) em vez de os dois convivendo e um confundindo o outro.

            Ligar tenta ler um número que você já tinha digitado ("559.872 km
            rodados") pra pré-preencher `to`/sufixo — é de graça
            (`seedCountUpFromText`) e cobre o caso mais comum: escrever o valor
            final primeiro, depois decidir animá-lo.
          */}
          <Field label="Contador">
            <button
              className={`btn btn-sm${layer.countUp ? ' on' : ''}`}
              onClick={() => set({
                countUp: layer.countUp ? undefined : {
                  from: 0,
                  duration: layer.duration,
                  decimals: 0,
                  separator: true,
                  // `outQuad`, não `outExpo`: medido, o expo chega a 97% do
                  // valor final já na METADE do tempo — parece que o número
                  // só "aparece" grande, sem o efeito de contar de verdade.
                  // O quad sobe gradual e ainda desacelera no fim.
                  ease: 'outQuad',
                  ...(seedCountUpFromText(layer.text) ?? { to: 100 }),
                },
              })}
              title={layer.countUp ? 'Desligar e voltar ao texto fixo' : 'Animar este texto como um número contando'}
            >
              {layer.countUp ? '🔢 CONTANDO' : '🔢 VIRAR CONTADOR'}
            </button>
          </Field>

          {layer.countUp && (
            <CountUpFields countUp={layer.countUp} onChange={cu => set({ countUp: cu })} />
          )}

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

          {/*
            Legibilidade. Título claro sobre imagem clara some, e é o caso mais
            comum de todos — legenda por cima de footage. Os dois padrões vêm
            zerados: texto que já se lê não precisa deles.

            Um botão "LEGÍVEL" antes dos números porque a resposta certa é quase
            sempre a mesma (contorno escuro grosso), e ninguém quer descobrir
            isso ajustando dois campos.
          */}
          <Field label="Legibilidade">
            <div className="row">
              <button
                className="btn btn-sm btn-mint"
                onClick={() => set({
                  stroke: '#171021',
                  strokeWidth: Math.max(2, Math.round(layer.size * 0.06)),
                  shadow: '#171021',
                  shadowBlur: Math.max(4, Math.round(layer.size * 0.12)),
                  shadowOffset: Math.max(2, Math.round(layer.size * 0.04)),
                })}
                title="Contorno escuro e sombra, proporcionais ao tamanho do texto"
              >
                LEGÍVEL
              </button>
              <button
                className="btn btn-sm"
                onClick={() => set({ strokeWidth: 0, shadowBlur: 0, shadowOffset: 0 })}
                title="Sem contorno nem sombra"
              >
                LIMPO
              </button>
            </div>
          </Field>

          <div className="row">
            <NumField
              label="Contorno"
              value={layer.strokeWidth}
              step={1}
              onChange={v => set({ strokeWidth: Math.max(0, v) })}
            />
            <input
              className="inp"
              value={layer.stroke}
              onChange={e => set({ stroke: e.target.value })}
              title="Cor do contorno"
            />
          </div>

          <div className="row">
            <NumField
              label="Sombra"
              value={layer.shadowBlur}
              step={1}
              onChange={v => set({ shadowBlur: Math.max(0, v) })}
            />
            <NumField
              label="Descida"
              value={layer.shadowOffset}
              step={1}
              onChange={v => set({ shadowOffset: v })}
            />
            <input
              className="inp"
              value={layer.shadow}
              onChange={e => set({ shadow: e.target.value })}
              title="Cor da sombra"
            />
          </div>
        </>
      ) : (
        <>
          {layer.type !== 'audio' && layer.type !== 'overlay' && (
            <NumField label="Escala base" value={layer.fit} step={0.05} onChange={v => set({ fit: v })} />
          )}

          {/*
            Separar o som é operação de VÍDEO: uma faixa de áudio já está
            separada. Some depois de usar, porque o clipe fica mudo e separar
            de novo produziria uma segunda faixa idêntica em silêncio.
          */}
          {layer.type === 'video' && !layer.mute && (
            <Field label="Áudio do clipe">
              <button
                className="btn btn-sm"
                onClick={() => onDetachAudio(layer.id)}
                title="Move o som pra uma faixa própria e cala o clipe"
              >
                ⇥ SEPARAR ÁUDIO
              </button>
            </Field>
          )}

          {(layer.type === 'video' || layer.type === 'audio') && (
            <Field label={`Volume — ${Math.round(layer.volume * 100)}%`}>
              <div className="row">
                <input
                  className="slider"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={layer.volume}
                  onChange={e => set({ volume: parseFloat(e.target.value) })}
                />
                <button
                  className={`btn btn-sm${layer.mute ? ' on' : ''}`}
                  onClick={() => set({ mute: !layer.mute })}
                  title={layer.mute ? 'Reativar som' : 'Silenciar'}
                >
                  {layer.mute ? '🔇' : '🔊'}
                </button>
              </div>
            </Field>
          )}

          {(layer.type === 'video' || layer.type === 'audio') && (
            <Field label={`Trim — fonte tem ${layer.sourceDuration.toFixed(2)}s`}>
              <div className="row">
                <input
                  className="inp"
                  type="number"
                  step="0.1"
                  min="0"
                  max={Math.max(0, layer.sourceDuration - 0.1)}
                  value={layer.trimStart ?? 0}
                  onChange={e => {
                    const trimStart = clamp(parseFloat(e.target.value) || 0, 0, layer.sourceDuration - 0.1);
                    // Shortening the tail must not leave the clip reading past the file's end.
                    const room = layer.sourceDuration - trimStart;
                    set({ trimStart, duration: Math.min(layer.duration, room) });
                  }}
                />
                <input
                  className="inp"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max={maxDuration(layer)}
                  value={layer.duration}
                  onChange={e => {
                    const d = clamp(parseFloat(e.target.value) || 0.1, 0.1, maxDuration(layer));
                    set({ duration: d });
                  }}
                />
              </div>
              <div className="hint">início na fonte / duração</div>
            </Field>
          )}
        </>
      )}

      <div className="row">
        <NumField label="Pos X" value={layer.x} step={10} onChange={v => set({ x: v })} />
        <NumField label="Pos Y" value={layer.y} step={10} onChange={v => set({ y: v })} />
      </div>

      <div className="row">
        <NumField label="Início (s)" value={layer.start} step={0.1} min={0} onChange={v => set({ start: v })} />
        <NumField
          label="Duração (s)"
          value={layer.duration}
          step={0.1}
          min={0.1}
          onChange={v => set({ duration: clamp(v, 0.1, maxDuration(layer)) })}
        />
      </div>
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface CountUpFieldsProps {
  countUp: CountUp;
  onChange: (cu: CountUp) => void;
}

/**
 * Os campos do contador, uma vez ligado.
 *
 * `anchor` e `loop` ficam de fora de propósito: o motor puro (`countUp.ts`)
 * já os suporta de graça, reaproveitando `effectProgress`, mas expor os dois
 * juntos (ancorar no fim ENQUANTO repete) é complexidade que não serve o caso
 * de uso principal — um contador que corre do início ao fim do texto na tela.
 * Fácil de acrescentar depois se alguém pedir; editável na unha num `.frag`
 * até lá.
 */
function CountUpFields({ countUp, onChange }: CountUpFieldsProps) {
  const patch = (p: Partial<CountUp>) => onChange({ ...countUp, ...p });

  return (
    <>
      <div className="row">
        <NumField label="De" value={countUp.from} step={1} onChange={v => patch({ from: v })} />
        <NumField label="Até" value={countUp.to} step={1} onChange={v => patch({ to: v })} />
      </div>

      <div className="row">
        <NumField
          label="Duração (s)"
          value={countUp.duration ?? 0}
          step={0.1}
          min={0.1}
          onChange={v => patch({ duration: Math.max(0.1, v) })}
        />
        <NumField
          label="Atraso (s)"
          value={countUp.delay ?? 0}
          step={0.1}
          min={0}
          onChange={v => patch({ delay: Math.max(0, v) })}
        />
      </div>

      <div className="row">
        <NumField
          label="Casas decimais"
          value={countUp.decimals ?? 0}
          step={1}
          min={0}
          onChange={v => patch({ decimals: Math.max(0, Math.round(v)) })}
        />
        <Field label="Separador">
          <button
            className={`btn btn-sm${countUp.separator !== false ? ' on' : ''}`}
            onClick={() => patch({ separator: countUp.separator === false })}
            title="Separador de milhar, no padrão brasileiro (559.872)"
          >
            {countUp.separator !== false ? '1.234' : '1234'}
          </button>
        </Field>
      </div>

      <div className="row">
        <TextField label="Prefixo" value={countUp.prefix ?? ''} onChange={v => patch({ prefix: v })} />
        <TextField label="Sufixo" value={countUp.suffix ?? ''} onChange={v => patch({ suffix: v })} />
      </div>

      <Field label="Suavização">
        <select
          className="inp"
          value={countUp.ease ?? 'outExpo'}
          onChange={e => patch({ ease: e.target.value as CountUp['ease'] })}
        >
          {EASE_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </Field>
    </>
  );
}
