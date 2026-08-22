/**
 * Os controles do painel, desenhados a partir de um esquema.
 *
 * Este arquivo é o outro lado do `criar/api.ts`: lá o autor DECLARA
 * `intensidade: num(0.5, { min: 0, max: 2 })`, aqui nasce o slider. Nenhum
 * dos dois sabe que efeito é — é isso que permite um efeito de terceiro
 * ganhar painel sem uma linha de React escrita por nós.
 *
 * Sem estado próprio de propósito. Os valores vêm por prop e voltam pelo
 * `onChange`, como o resto dos painéis — quem guarda é o projeto, e é o que
 * faz undo/redo funcionar de graça.
 */

import { Field } from './Win.tsx';
import { normalizar, conferirValores } from '../criar/api.ts';
import type { Desc, DescOpcao, Esquema } from '../criar/api.ts';

/** Paleta rápida, a mesma do PropsPanel — cor digitada continua valendo. */
const SWATCHES = ['#f7efdc', '#f0c04a', '#e2615c', '#64c48a', '#6ba9d6', '#c9a6e8', '#241a33'];

interface CamposProps {
  esquema: Esquema;
  valores: Record<string, unknown>;
  onChange: (valores: Record<string, unknown>) => void;
  /** Ações discretas (botão, opção) não devem se fundir no histórico. Ver App. */
  onChangeDiscreta?: (valores: Record<string, unknown>) => void;
}

export function CamposDeParams({ esquema, valores, onChange, onChangeDiscreta }: CamposProps) {
  const chaves = Object.keys(esquema);
  if (!chaves.length) return null;

  // Normaliza uma vez pra desenhar: os campos precisam de um valor concreto,
  // e `normalizar` nunca falha — ver o porquê em api.ts.
  const v = normalizar(esquema, valores) as Record<string, unknown>;
  const problemas = conferirValores(esquema, valores);

  const mudar = (chave: string, valor: unknown, discreta = false) => {
    const proximo = { ...v, [chave]: valor };
    if (discreta && onChangeDiscreta) onChangeDiscreta(proximo);
    else onChange(proximo);
  };

  return (
    <div className="params">
      {chaves.map(chave => (
        <Campo
          key={chave}
          chave={chave}
          desc={esquema[chave]!}
          valor={v[chave]}
          onChange={(valor, discreta) => mudar(chave, valor, discreta)}
        />
      ))}
      {problemas.map((p, i) => <div className="err" key={i}>{p}</div>)}
    </div>
  );
}

interface CampoProps {
  chave: string;
  desc: Desc;
  valor: unknown;
  onChange: (valor: unknown, discreta?: boolean) => void;
}

function Campo({ chave, desc, valor, onChange }: CampoProps) {
  const rotulo = desc.rotulo ?? chave;

  switch (desc.tipo) {
    /**
     * Com min E max, o controle é slider + número lado a lado.
     *
     * O slider sozinho não deixa digitar um valor exato, e o número sozinho
     * não deixa TATEAR — e efeito se ajusta tateando, arrastando e olhando o
     * palco. Os dois juntos custam uma linha de CSS e cobrem os dois usos.
     *
     * Sem faixa declarada, sobra o campo numérico: um slider sem limites não
     * significa nada.
     */
    case 'num': {
      const n = valor as number;
      const temFaixa = desc.min != null && desc.max != null;
      const passo = desc.passo ?? 1;
      return (
        <Field label={<>{rotulo}{desc.unidade && <span className="unid"> ({desc.unidade})</span>}</>}>
          <div className="row">
            {temFaixa && (
              <input
                className="slider"
                type="range"
                min={desc.min}
                max={desc.max}
                step={passo}
                value={n}
                title={desc.ajuda}
                onChange={e => onChange(parseFloat(e.target.value))}
              />
            )}
            <input
              className="inp inp-num"
              type="number"
              value={n}
              step={passo}
              min={desc.min}
              max={desc.max}
              title={desc.ajuda}
              // Sem `|| 0`: campo vazio tem que continuar vazio enquanto se
              // digita, e `normalizar` já devolve o padrão pra string vazia.
              onChange={e => onChange(e.target.value === '' ? '' : parseFloat(e.target.value))}
            />
          </div>
        </Field>
      );
    }

    case 'cor': {
      const c = valor as string;
      return (
        <Field label={rotulo}>
          <div className="swatches">
            {SWATCHES.map(s => (
              <button
                key={s}
                className={`swatch${c === s ? ' on' : ''}`}
                style={{ background: s }}
                onClick={() => onChange(s, true)}
                title={s}
              />
            ))}
          </div>
          <input className="inp" value={c} title={desc.ajuda} onChange={e => onChange(e.target.value)} />
        </Field>
      );
    }

    case 'bool':
      return (
        <Field label={rotulo}>
          <button
            className={`btn btn-sm${valor ? ' on' : ''}`}
            title={desc.ajuda}
            onClick={() => onChange(!valor, true)}
          >
            {valor ? 'LIGADO' : 'DESLIGADO'}
          </button>
        </Field>
      );

    case 'texto':
      return (
        <Field label={rotulo}>
          {(desc.linhas ?? 1) > 1 ? (
            <textarea
              className="inp"
              rows={desc.linhas}
              value={valor as string}
              title={desc.ajuda}
              onChange={e => onChange(e.target.value)}
            />
          ) : (
            <input
              className="inp"
              value={valor as string}
              title={desc.ajuda}
              onChange={e => onChange(e.target.value)}
            />
          )}
        </Field>
      );

    /**
     * Botões, não `<select>`: a lista é curta por natureza (é uma escolha de
     * efeito, não um país), e ver as opções todas de uma vez é mais rápido
     * que abrir um menu. Mesmo espírito dos swatches de cor.
     */
    case 'opcao': {
      const d = desc as DescOpcao;
      return (
        <Field label={rotulo}>
          <div className="row" title={desc.ajuda}>
            {d.valores.map(op => (
              <button
                key={op}
                className={`btn btn-sm${valor === op ? ' on' : ''}`}
                onClick={() => onChange(op, true)}
              >
                {op}
              </button>
            ))}
          </div>
        </Field>
      );
    }
  }
}
