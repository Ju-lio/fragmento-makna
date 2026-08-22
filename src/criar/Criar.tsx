/**
 * O playground de criação de efeito.
 *
 * O que ele faz HOJE: fecha o laço entre declarar `params` e ver os controles
 * que o editor vai desenhar. É a metade do contrato que já existe — a outra
 * metade (o efeito virando pixel) é a fase B do PRIORIDADES.md, e a página diz
 * isso na cara em vez de fingir.
 *
 * Por que isso já vale sozinho: o painel é a parte do contrato mais fácil de
 * errar em silêncio. Um `min` esquecido vira campo sem slider, um nome de
 * param inválido vira CSS quebrado longe da causa. Ver o resultado enquanto se
 * escreve é o que impede publicar um efeito que "parece certo".
 *
 * O manifesto entra como JSON, e não TS, porque ainda não há compilador no
 * navegador. Os descritores de `api.ts` são objetos simples de propósito —
 * `num(0.5, { max: 2 })` e `{"tipo":"num","padrao":0.5,"max":2}` são o mesmo
 * objeto —, então o que se testa aqui é exatamente o que o TS vai produzir.
 */

import { useState } from 'react';
import { Win } from '../ui/Win.tsx';
import { CamposDeParams } from '../ui/CamposDeParams.tsx';
import { TIPOS, validarManifesto, padroes, variaveisCss, normalizar } from './api.ts';
import type { Esquema, Tipo } from './api.ts';

/**
 * Um manifesto de partida por tipo.
 *
 * Cada um usa params DIFERENTES de propósito: quem abre em "filtro" precisa ver
 * que o vocabulário é o mesmo do "efeito", e quem abre em "texto" precisa ver
 * `texto()` existindo — senão a pessoa supõe que só dá pra declarar número.
 */
const SEMENTES: Record<Tipo, string> = {
  efeito: `{
  "meta": { "tipo": "efeito", "nome": "Raio", "autor": "voce" },
  "params": {
    "intensidade": { "tipo": "num", "padrao": 1, "min": 0, "max": 3, "passo": 0.05,
                     "rotulo": "Intensidade" },
    "brilho":      { "tipo": "num", "padrao": 34, "min": 0, "max": 80, "unidade": "px",
                     "rotulo": "Brilho" },
    "cor":         { "tipo": "cor", "padrao": "#6ba9d6", "rotulo": "Cor" }
  }
}`,
  filtro: `{
  "meta": { "tipo": "filtro", "nome": "Granulado", "autor": "voce" },
  "params": {
    "quantidade": { "tipo": "num", "padrao": 0.2, "min": 0, "max": 1, "passo": 0.01,
                    "rotulo": "Quantidade" },
    "escala":     { "tipo": "num", "padrao": 0.8, "min": 0.1, "max": 2, "passo": 0.05,
                    "rotulo": "Escala do grão" },
    "colorido":   { "tipo": "bool", "padrao": false, "rotulo": "Grão colorido" }
  }
}`,
  transicao: `{
  "meta": { "tipo": "transicao", "nome": "Empurrar", "autor": "voce" },
  "params": {
    "direcao": { "tipo": "opcao", "valores": ["esquerda", "direita", "cima", "baixo"],
                 "padrao": "esquerda", "rotulo": "Direção" },
    "suavizar": { "tipo": "num", "padrao": 0.5, "min": 0, "max": 1, "passo": 0.05,
                  "rotulo": "Suavizar" }
  }
}`,
  texto: `{
  "meta": { "tipo": "texto", "nome": "Retrô empilhado", "autor": "voce" },
  "params": {
    "conteudo": { "tipo": "texto", "padrao": "FRAGMENTO", "rotulo": "Texto" },
    "camadas":  { "tipo": "num", "padrao": 5, "min": 1, "max": 8, "passo": 1,
                  "rotulo": "Camadas" },
    "desloc":   { "tipo": "num", "padrao": 3, "min": 1, "max": 12, "unidade": "px",
                  "rotulo": "Deslocamento" },
    "corBase":  { "tipo": "cor", "padrao": "#0b0b2a", "rotulo": "Cor da frente" }
  }
}`,
};

const ROTULO: Record<Tipo, string> = {
  efeito: 'EFEITO',
  filtro: 'FILTRO',
  transicao: 'TRANSIÇÃO',
  texto: 'TEXTO',
};

const ONDE_APARECE: Record<Tipo, string> = {
  efeito: 'Aplicado numa layer, na aba EFEITOS.',
  filtro: 'Aplicado nos pixels de uma layer, na aba FILTROS.',
  transicao: 'Entre dois clipes vizinhos — ou entre o nada e o primeiro.',
  texto: 'Uma layer de texto com aparência e animação prontas.',
};

/** `criar.html?tipo=filtro` abre direto no tipo, pra servir de link. */
function tipoDaUrl(): Tipo {
  const t = new URLSearchParams(location.search).get('tipo');
  return TIPOS.includes(t as Tipo) ? (t as Tipo) : 'efeito';
}

export function Criar() {
  const [tipo, setTipo] = useState<Tipo>(tipoDaUrl);
  const [fonte, setFonte] = useState(() => SEMENTES[tipoDaUrl()]);
  /** Os valores que a pessoa mexeu no painel de teste. */
  const [valores, setValores] = useState<Record<string, unknown>>({});

  const trocarTipo = (t: Tipo) => {
    setTipo(t);
    setFonte(SEMENTES[t]);
    setValores({});
    // Mantém a URL contando a verdade, pra F5 e link não mentirem.
    history.replaceState(null, '', `?tipo=${t}`);
  };

  let manifesto: { meta?: { nome?: string }; params?: Esquema } | null = null;
  let problema: string | null = null;
  try {
    manifesto = JSON.parse(fonte);
  } catch (e) {
    problema = 'JSON inválido: ' + (e instanceof Error ? e.message : String(e));
  }
  if (!problema) problema = validarManifesto(manifesto);

  const esquema: Esquema = (!problema && manifesto?.params) || {};
  const temParams = Object.keys(esquema).length > 0;
  // `padroes` como base: o painel precisa desenhar algo antes de a pessoa mexer.
  const atuais = temParams ? { ...padroes(esquema), ...valores } : {};
  const css = temParams ? variaveisCss(esquema, normalizar(esquema, atuais)) : {};

  return (
    <div className="criar">
      <header className="criar-topo">
        <span className="criar-marca">FRAGMENTO</span>
        <span className="criar-sub">/ CRIAR</span>
        <span className="stripes" />
        <a className="btn btn-sm" href="/">◀ EDITOR</a>
      </header>

      <div className="criar-tipos">
        {TIPOS.map(t => (
          <button
            key={t}
            className={`btn criar-tipo${tipo === t ? ' on' : ''}`}
            onClick={() => trocarTipo(t)}
          >
            {ROTULO[t]}
          </button>
        ))}
      </div>
      <div className="criar-onde">{ONDE_APARECE[tipo]}</div>

      <div className="criar-corpo">
        <Win title="MANIFESTO" className="criar-col">
          <div className="hint">
            O que o editor precisa saber sobre o seu efeito: o que ele é, e quais
            controles desenhar.
          </div>
          <textarea
            className="inp criar-fonte"
            spellCheck={false}
            value={fonte}
            onChange={e => { setFonte(e.target.value); setValores({}); }}
          />
          {problema
            ? <div className="err">{problema}</div>
            : <div className="criar-ok">✓ manifesto válido</div>}
        </Win>

        <Win title="COMO FICA NO EDITOR" className="criar-col">
          {problema && <div className="hint">Corrija o manifesto pra ver o painel.</div>}
          {!problema && !temParams && (
            <div className="hint">
              Sem <code>params</code>, o efeito não tem controle nenhum — o que é
              legítimo. Adicione um param pra ver os campos nascerem.
            </div>
          )}
          {!problema && temParams && (
            <>
              <div className="field-label">{manifesto?.meta?.nome}</div>
              <CamposDeParams
                esquema={esquema}
                valores={atuais}
                onChange={setValores}
                onChangeDiscreta={setValores}
              />

              {/*
                O que o CSS do autor de fato recebe. É a parte do contrato que
                ninguém adivinha: que `raio` com unidade `px` chega como `34px`
                e não `34`, e que booleano vira 1/0 porque CSS não tem booleano.
              */}
              <div className="field-label" style={{ marginTop: 12 }}>
                O SEU CSS RECEBE
              </div>
              <pre className="criar-css">
{Object.entries(css).map(([k, v]) => `${k}: ${v};`).join('\n')}
              </pre>
              <div className="hint">
                Use assim: <code>filter: drop-shadow(0 0 var(--p-brilho) var(--p-cor));</code>
              </div>
            </>
          )}
        </Win>
      </div>

      {/*
        Dizer o que ainda não existe é mais útil que esconder: quem chega aqui
        esperando escrever o CSS e ver o vídeo precisa saber onde está.
      */}
      <footer className="criar-rodape">
        <b>Ainda não dá pra escrever o CSS aqui.</b> Esta página fecha o laço do
        painel — declarar <code>params</code> e ver os controles. O efeito virando
        pixel é a próxima fase. O que dá e o que não dá pra fazer com CSS está no{' '}
        <code>LIMITES.md</code>.
      </footer>
    </div>
  );
}
