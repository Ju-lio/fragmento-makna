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
import { TIPOS, validarManifesto, padroes, variaveisCss, normalizar, composicaoDe } from './api.ts';
import { Overlay } from './overlay.ts';
import { analisar, podeCarregar } from './validador.ts';
import { SEMENTES, ROTULO, ONDE_APARECE } from './sementes.ts';
import { guardar } from './bandeja.ts';
import type { Esquema, Mistura, Tipo } from './api.ts';

/**
 * Um "quadro de vídeo" pra compor por cima.
 *
 * Não é enfeite: sem alguma coisa embaixo, `screen`, `multiply` e `overlay`
 * não mostram nada, e quem escreve um granulado não tem como julgar o
 * resultado. Tem claro, escuro e cor saturada de propósito — os três lugares
 * onde uma mistura se comporta diferente.
 */
function desenharAmostra(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#123b63');
  g.addColorStop(0.55, '#6f7f95');
  g.addColorStop(1, '#0d1622');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `hsl(${i * 26}, 70%, ${28 + (i % 5) * 12}%)`;
    ctx.fillRect((i * 137) % w, (i * 83) % h, w * 0.07, h * 0.12);
  }
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(h * 0.09)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('VÍDEO', w / 2, h * 0.55);
}

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
  const [enviado, setEnviado] = useState(false);
  /**
   * Compor sobre o quê.
   *
   * O xadrez mostra a transparência, e era o único fundo — o que fazia um
   * efeito de MISTURA ser impossível de julgar: `screen` sobre o nada não
   * mostra nada. A amostra é o padrão porque, num projeto de verdade, o efeito
   * está sempre por cima de alguma coisa.
   */
  const [fundo, setFundo] = useState<'amostra' | 'xadrez'>('amostra');

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
  let manifesto: { meta?: { nome?: string; mistura?: Mistura }; params?: Esquema } | null = null;
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

  /**
   * O mesmo validador que a importação de um pacote de terceiro vai usar.
   *
   * Ao vivo, enquanto se digita: o valor de cada checagem está em ela aparecer
   * ANTES de o efeito sair daqui. Um `Math.random()` só se manifesta como
   * tremeliques no MP4 de outra pessoa.
   */
  const problemas = manifesto
    ? analisar({ meta: manifesto.meta, params: manifesto.params, html: fonte.html, css: fonte.css })
    : [];

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
        if (fundo === 'amostra') desenharAmostra(ctx, tela.width, tela.height);
        // A mistura vem do `meta`, e é a MESMA conta que o editor faz — se
        // divergissem, o preview mentiria.
        ctx.globalCompositeOperation = composicaoDe(manifesto?.meta?.mistura);
        ctx.drawImage(img, 0, 0, tela.width, tela.height);
        ctx.globalCompositeOperation = 'source-over';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonte.html, fonte.css, t, chaveDosVars, fundo, manifesto?.meta?.mistura]);

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
          {problema && <div className="err">{problema}</div>}
          {!problema && problemas.length === 0 && (
            <div className="criar-ok">✓ sem problemas — pode usar</div>
          )}
          {problemas.map((pb, i) => (
            <div className={`criar-nota criar-nota-${pb.nivel}`} key={i}>
              <b>{pb.nivel === 'erro' ? '✕' : pb.nivel === 'aviso' ? '⚠' : '⏱'}</b> {pb.mensagem}
              {pb.saida && <div className="criar-saida">→ {pb.saida}</div>}
            </div>
          ))}
          {erroRender && <div className="err">Não deu pra desenhar: {erroRender}</div>}
        </Win>

        <Win title="COMO FICA" className="criar-col">
          {/* Xadrez por baixo: o overlay é transparente, e sem isso não dá pra
              distinguir "fundo preto" de "nada desenhado". */}
          <div className="row criar-fundos">
            <span className="criar-rotulo-fundo">compor sobre:</span>
            {(['amostra', 'xadrez'] as const).map(f => (
              <button key={f} className={`btn btn-sm${fundo === f ? ' on' : ''}`} onClick={() => setFundo(f)}>
                {f}
              </button>
            ))}
          </div>
          <div className={`criar-tela-caixa${fundo === 'amostra' ? ' liso' : ''}`}>
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

      <div className="criar-enviar">
        <button
          className="btn btn-gold"
          disabled={Boolean(problema) || !podeCarregar(problemas)}
          onClick={() => {
            guardar({
              nome: manifesto?.meta?.nome ?? 'Efeito',
              html: fonte.html,
              css: fonte.css,
              schema: esquema,
              values: normalizar(esquema, atuais) as Record<string, unknown>,
            });
            setEnviado(true);
            setTimeout(() => setEnviado(false), 2600);
          }}
          title={problema || !podeCarregar(problemas)
            ? 'Corrija os erros primeiro'
            : 'Deixa o efeito pronto pro editor pegar'}
        >
          ▶ USAR NO EDITOR
        </button>
        {enviado && (
          <span className="criar-enviado">
            pronto — no editor, clique em <b>+ EFEITO</b>
          </span>
        )}
      </div>

      <footer className="criar-rodape">
        Arraste o tempo e veja o quadro exato — é o mesmo <code>Overlay</code> que o
        editor usa, então o que aparece aqui é o que vai pro vídeo.{' '}
        <b>Ainda não dá pra salvar seus efeitos numa biblioteca</b> — o botão acima
        deixa UM efeito na bandeja, e o editor pega. O que dá e o que não dá pra
        fazer com CSS está no <code>LIMITES.md</code>.
      </footer>
    </div>
  );
}
