/**
 * O playground de criação de efeito.
 *
 * Fecha os dois laços que importam:
 *
 *   1. declarar `params` → ver os controles que o editor vai desenhar
 *   2. escrever HTML+CSS → ver o quadro que o export vai produzir
 *
 * O segundo usa o MESMO `Overlay` que o editor vai usar. Se fossem caminhos
 * diferentes, o preview mentiria — que é exatamente o que esta página existe
 * pra evitar.
 *
 * O manifesto entra como JSON, e não TS, porque ainda não há compilador no
 * navegador. Os descritores de `api.ts` são objetos simples de propósito, então
 * o que se testa aqui é exatamente o que o TS vai produzir.
 */

import { useEffect, useRef, useState } from 'react';
import { Win } from '../ui/Win.tsx';
import { CamposDeParams } from '../ui/CamposDeParams.tsx';
import { TIPOS, validarManifesto, padroes, variaveisCss, normalizar } from './api.ts';
import { Overlay } from './overlay.ts';
import { recursosExternos, temStyleInline } from './svg.ts';
import { SEMENTES, ROTULO, ONDE_APARECE } from './sementes.ts';
import type { Esquema, Tipo } from './api.ts';

/** `criar.html?tipo=filtro` abre direto no tipo, pra servir de link. */
function tipoDaUrl(): Tipo {
  const t = new URLSearchParams(location.search).get('tipo');
  return TIPOS.includes(t as Tipo) ? (t as Tipo) : 'efeito';
}

type Aba = 'manifesto' | 'html' | 'css';

export function Criar() {
  const inicial = tipoDaUrl();
  const [tipo, setTipo] = useState<Tipo>(inicial);
  const [aba, setAba] = useState<Aba>('css');
  const [fonte, setFonte] = useState(() => SEMENTES[inicial]);
  const [valores, setValores] = useState<Record<string, unknown>>({});
  const [t, setT] = useState(0.35);
  const [erroRender, setErroRender] = useState('');
  const [ms, setMs] = useState(0);

  const telaRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<Overlay | null>(null);

  const trocarTipo = (novo: Tipo) => {
    setTipo(novo);
    setFonte(SEMENTES[novo]);
    setValores({});
    setT(0.35);
    history.replaceState(null, '', `?tipo=${novo}`);
  };

  const editar = (parte: keyof typeof fonte, texto: string) => {
    setFonte({ ...fonte, [parte]: texto });
    if (parte === 'manifesto') setValores({});
  };

  // --- validação ---------------------------------------------------------
  let manifesto: { meta?: { nome?: string }; params?: Esquema } | null = null;
  let problema: string | null = null;
  try {
    manifesto = JSON.parse(fonte.manifesto);
  } catch (e) {
    problema = 'JSON inválido: ' + (e instanceof Error ? e.message : String(e));
  }
  if (!problema) problema = validarManifesto(manifesto);

  const esquema: Esquema = (!problema && manifesto?.params) || {};
  const temParams = Object.keys(esquema).length > 0;
  const atuais = temParams ? { ...padroes(esquema), ...valores } : {};
  const vars = temParams ? variaveisCss(esquema, normalizar(esquema, atuais)) : {};
  /**
   * A chave de dependência do render.
   *
   * `vars` é um objeto novo a cada render, então pô-lo no array de
   * dependências redesenharia sempre — inclusive ao digitar no textarea do
   * manifesto, que não muda um pixel. O que importa é o CONTEÚDO, e é ele que
   * esta string carrega.
   */
  const chaveDosVars = JSON.stringify(vars);

  // Avisos que não impedem de rodar — a §6 do LIMITES.md é a lista completa;
  // estes dois são os que já dá pra detectar sem o pacote inteiro.
  const avisos = [
    ...recursosExternos(fonte.css).map(u => `Recurso externo não carrega no quadro final: ${u}`),
    ...(temStyleInline(fonte.html) ? ['<style> dentro do HTML não passa pelo CDATA — mova pro CSS.'] : []),
  ];

  // --- render ------------------------------------------------------------
  // O Overlay é remontado só quando HTML ou CSS mudam; mexer num slider ou no
  // tempo reaproveita o palco, que é o caso comum e o que precisa ser rápido.
  useEffect(() => {
    overlayRef.current?.destruir();
    overlayRef.current = new Overlay({
      meta: { tipo, nome: manifesto?.meta?.nome ?? 'sem nome' },
      html: fonte.html,
      css: fonte.css,
    });
    return () => { overlayRef.current?.destruir(); overlayRef.current = null; };
    // `manifesto.meta.nome` de propósito fora: mudar o nome não muda um pixel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonte.html, fonte.css, tipo]);

  useEffect(() => {
    let cancelado = false;
    const tela = telaRef.current;
    const ov = overlayRef.current;
    if (!tela || !ov) return;

    (async () => {
      const inicio = performance.now();
      try {
        const img = await ov.quadro({
          largura: tela.width, altura: tela.height, t, duracao: 2, params: vars,
        });
        if (cancelado) return;
        const ctx = tela.getContext('2d')!;
        ctx.clearRect(0, 0, tela.width, tela.height);
        ctx.drawImage(img, 0, 0, tela.width, tela.height);
        setErroRender('');
        setMs(Math.round(performance.now() - inicio));
      } catch (e) {
        if (!cancelado) setErroRender(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => { cancelado = true; };
    // `vars` fora do array de propósito: quem representa ele aqui é
    // `chaveDosVars` — ver a nota na declaração.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonte.html, fonte.css, t, chaveDosVars]);

  const textoDaAba = fonte[aba];

  return (
    <div className="criar">
      <header className="criar-topo">
        <span className="criar-marca">FRAGMENTO</span>
        <span className="criar-sub">/ CRIAR</span>
        <span className="stripes" />
        <a className="btn btn-sm" href="/">◀ EDITOR</a>
      </header>

      <div className="criar-tipos">
        {TIPOS.map(x => (
          <button key={x} className={`btn criar-tipo${tipo === x ? ' on' : ''}`} onClick={() => trocarTipo(x)}>
            {ROTULO[x]}
          </button>
        ))}
      </div>
      <div className="criar-onde">{ONDE_APARECE[tipo]}</div>

      <div className="criar-corpo">
        <Win
          title="O SEU EFEITO"
          className="criar-col"
          right={
            <div className="criar-abas">
              {(['css', 'html', 'manifesto'] as Aba[]).map(a => (
                <button key={a} className={`btn btn-sm${aba === a ? ' on' : ''}`} onClick={() => setAba(a)}>
                  {a.toUpperCase()}
                </button>
              ))}
            </div>
          }
        >
          <textarea
            className="inp criar-fonte"
            spellCheck={false}
            value={textoDaAba}
            onChange={e => editar(aba, e.target.value)}
          />
          {aba === 'manifesto' && (problema
            ? <div className="err">{problema}</div>
            : <div className="criar-ok">✓ manifesto válido</div>)}
          {avisos.map((a, i) => <div className="criar-aviso" key={i}>⚠ {a}</div>)}
          {erroRender && <div className="err">Não deu pra desenhar: {erroRender}</div>}
        </Win>

        <Win title="COMO FICA" className="criar-col">
          {/* Xadrez por baixo: o overlay é transparente, e sem isso não dá pra
              distinguir "fundo preto" de "nada desenhado". */}
          <div className="criar-tela-caixa">
            {/*
              Renderiza em 1280x720 e mostra reduzido, em vez de renderizar no
              tamanho da caixa. Se o preview fosse 640 de largura, quem escreve
              calibraria `vw`, `%` e desfoque pra uma composição que não existe
              — e o efeito sairia diferente no projeto de verdade.
            */}
            <canvas ref={telaRef} width={1280} height={720} className="criar-tela" />
          </div>

          <div className="row criar-tempo">
            <input
              className="slider"
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={t}
              onChange={e => setT(parseFloat(e.target.value))}
            />
            <span className="criar-relogio">{t.toFixed(2)}s · {ms}ms</span>
          </div>

          {problema && <div className="hint">Corrija o manifesto pra ver os controles.</div>}
          {!problema && temParams && (
            <>
              <div className="field-label" style={{ marginTop: 8 }}>CONTROLES</div>
              <CamposDeParams
                esquema={esquema}
                valores={atuais}
                onChange={setValores}
                onChangeDiscreta={setValores}
              />
              <div className="field-label" style={{ marginTop: 10 }}>O SEU CSS RECEBE</div>
              <pre className="criar-css">
{Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join('\n')}
{'\n--frag-t, --frag-progresso, --frag-largura, --frag-altura, --frag-duracao'}
              </pre>
            </>
          )}
        </Win>
      </div>

      <footer className="criar-rodape">
        Arraste o tempo e veja o quadro exato — é o mesmo <code>Overlay</code> que o
        editor usa, então o que aparece aqui é o que vai pro vídeo.{' '}
        <b>Ainda não dá pra salvar nem aplicar numa layer.</b> O que dá e o que não dá
        pra fazer com CSS está no <code>LIMITES.md</code>.
      </footer>
    </div>
  );
}
