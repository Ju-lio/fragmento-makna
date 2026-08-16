/**
 * A matemática de posicionar, escalar e girar uma layer direto no palco.
 *
 * Existe porque ninguém posiciona um título digitando coordenada — era o que o
 * editor pedia, e é o tipo de coisa que faz você desistir antes do segundo
 * clipe.
 *
 * Tudo aqui é puro e trabalha em **coordenadas lógicas da composição** (as
 * mesmas do `drawFrame`), nunca em pixels de tela. Quem chama converte uma vez,
 * dividindo pelo zoom do viewport — é o mesmo motivo de o `drawFrame` desenhar
 * em coordenadas lógicas: a conta não pode depender de quão grande a coisa está
 * aparecendo agora.
 */

import { displayText } from './countUp.ts';
import type { Layer, LayerState, Project, VisualLayer } from './types.ts';

export interface Point { x: number; y: number }
/** Tamanho da layer antes de escala e rotação, em unidades da composição. */
export interface Box { w: number; h: number }

/** Mede a largura de uma linha de texto numa dada fonte. Injetado: só o DOM sabe. */
export type TextMeasurer = (line: string, font: string) => number;

/** Entrelinha do `drawText`. Repetida aqui porque a caixa tem que bater com o desenho. */
const LINE_HEIGHT = 1.12;

/**
 * Tamanho da layer na composição, antes de escala e rotação.
 *
 * Só o texto precisa de medição de verdade; imagem e vídeo saem da mesma conta
 * que o `drawSource` usa pra desenhar. Ter as duas contas em lugares diferentes
 * é justamente o que faria a moldura não bater com o que está na tela.
 */
export function layerBox(
  layer: VisualLayer,
  project: Project,
  measure: TextMeasurer,
  t: number,
): Box {
  if (layer.type === 'text') {
    const font = `${layer.size}px ${layer.font}`;
    // `displayText`, não `layer.text` direto — ver o comentário em
    // `countUp.ts`: com um contador ligado, medir o texto estático deixaria a
    // moldura de seleção (e o hit-test de `pickLayer`) presas no tamanho
    // errado enquanto o número na tela muda de largura a cada quadro.
    const lines = displayText(layer, t).split('\n');
    const w = lines.reduce((max, ln) => Math.max(max, measure(ln, font)), 0);
    // Mesma conta do `drawText`: as linhas se espalham a partir do centro, então
    // a altura é o vão entre a primeira e a última mais um corpo de fonte.
    return { w, h: (lines.length - 1) * layer.size * LINE_HEIGHT + layer.size };
  }

  const source = layer.type === 'image' ? layer.img : layer.video;
  const srcW = layer.type === 'image' ? source?.width : (source as HTMLVideoElement)?.videoWidth;
  const srcH = layer.type === 'image' ? source?.height : (source as HTMLVideoElement)?.videoHeight;
  if (!srcW || !srcH) return { w: 0, h: 0 };

  const s = Math.min(project.width / srcW, project.height / srcH) * (layer.fit ?? 0.8);
  return { w: srcW * s, h: srcH * s };
}

/** Onde o centro da layer cai na composição, já com efeitos aplicados. */
export function layerCenter(project: Project, st: LayerState): Point {
  return { x: project.width / 2 + st.x, y: project.height / 2 + st.y };
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Leva um ponto da composição pro referencial da layer: desfaz translação,
 * rotação e escala, nessa ordem.
 *
 * É o que permite testar acerto numa layer girada sem calcular polígono nenhum
 * — no referencial dela, a caixa volta a ser um retângulo alinhado aos eixos.
 */
export function toLocal(p: Point, center: Point, rotateDeg: number, scale: number): Point {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const a = rad(-rotateDeg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const s = scale || 1;
  return { x: (dx * cos - dy * sin) / s, y: (dx * sin + dy * cos) / s };
}

/**
 * O ponto está dentro da caixa?
 *
 * `pad` dá folga em unidades da composição: uma layer de texto fino é quase
 * impossível de acertar sem isso, e clicar "quase em cima" e não selecionar
 * nada parece defeito.
 */
export function hitBox(local: Point, box: Box, pad = 0): boolean {
  return Math.abs(local.x) <= box.w / 2 + pad && Math.abs(local.y) <= box.h / 2 + pad;
}

/**
 * A layer mais à frente sob o ponto, ou `null`.
 *
 * Percorre a ordem de desenho ao contrário: quem está por cima é quem você
 * quis pegar. Só considera layers vivas no instante `t` — clicar não pode
 * selecionar algo que não está na tela.
 */
export function pickLayer(
  order: readonly VisualLayer[],
  point: Point,
  project: Project,
  measure: TextMeasurer,
  stateOf: (layer: Layer) => LayerState,
  t: number,
  pad = 0,
): VisualLayer | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const layer = order[i];
    if (!layer) continue;
    const st = stateOf(layer);
    const box = layerBox(layer, project, measure, t);
    if (box.w <= 0 || box.h <= 0) continue;
    if (hitBox(toLocal(point, layerCenter(project, st), st.rotate, st.scale), box, pad)) {
      return layer;
    }
  }
  return null;
}

/**
 * Quanto a layer cresceu, pelo eixo em que a mão andou mais.
 *
 * A escala é uniforme porque o modelo tem um tamanho só (`size` no texto, `fit`
 * na mídia), e inventar largura e altura separadas criaria um estado que o
 * renderer não sabe desenhar. Uniforme significa que a quina **não pode**
 * seguir o cursor nos dois eixos ao mesmo tempo: encolher a largura encolhe a
 * altura junto, e a quina sobe mesmo que a mão só tenha ido pra esquerda.
 *
 * Então ela segue **um** eixo — o que você de fato moveu. "Puxei 200 pra
 * esquerda" quer dizer 200 mais estreito, e é isso que acontece.
 *
 * Duas tentativas anteriores, e por que não bastam:
 *
 *  - **Distância ao centro.** Puxar 200px na horizontal mal muda a hipotenusa
 *    (a componente vertical continua inteira lá), então a caixa encolhia muito
 *    menos do que a mão andou. Medido: 200px de arrasto moviam a quina 106px.
 *  - **Projeção no raio.** Minimiza a distância entre a quina e o ponteiro, o
 *    que é ótimo no papel e ainda deixa 71px de erro no eixo que a pessoa está
 *    olhando.
 *
 * A conta roda no referencial da LAYER, não da tela: numa layer deitada, "o
 * eixo em que a mão andou" é o eixo dela, e usar x/y da tela faria a alça
 * responder torto exatamente quando há rotação.
 */
export function scaleFactor(
  from: Point, to: Point, center: Point, rotateDeg = 0,
): number {
  const a = toLocal(from, center, rotateDeg, 1);
  const b = toLocal(to, center, rotateDeg, 1);

  const useX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const ref = useX ? a.x : a.y;
  const now = useX ? b.x : b.y;

  // Alça largada em cima do eixo do centro: a razão explodiria, e um pixel de
  // tremor viraria 10x.
  if (Math.abs(ref) < 1e-6) return 1;
  return now / ref;
}

/** Quantos graus o ponteiro girou em torno do centro, entre dois pontos. */
export function rotationDelta(from: Point, to: Point, center: Point): number {
  const a0 = Math.atan2(from.y - center.y, from.x - center.x);
  const a1 = Math.atan2(to.y - center.y, to.x - center.x);
  let deg = ((a1 - a0) * 180) / Math.PI;
  // Normaliza pra (-180, 180]: sem isso, cruzar a linha dos 180° dá um salto de
  // uma volta inteira no meio do gesto.
  while (deg > 180) deg -= 360;
  while (deg <= -180) deg += 360;
  return deg;
}

/** Prende um ângulo a 0..360, pra o campo numérico não acumular voltas. */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Passo de rotação com Shift. 15° é o que todo editor usa. */
export const SNAP_DEGREES = 15;

export function snapAngle(deg: number, snap: boolean): number {
  return snap ? Math.round(deg / SNAP_DEGREES) * SNAP_DEGREES : deg;
}

/**
 * O ímã do palco: centralizar um elemento exatamente no meio da composição.
 *
 * Mesma ideia do ímã da timeline (`magnet.ts`), só que em duas dimensões e com
 * um alvo só — o centro. Sem ele, "centralizar" arrastando é sorte: a mão
 * pousa a 2px do meio e ninguém enxerga a diferença olhando, mas ela está lá —
 * e num título de formato retrato é justamente o tipo de desalinho que salta
 * aos olhos depois de exportado.
 *
 * Cada eixo gruda sozinho: um título perto do meio na horizontal mas ainda
 * subindo na vertical mostra só a guia vertical, não as duas — é o que faz a
 * guia dizer a verdade sobre qual eixo já chegou.
 *
 * O raio é passado já em pixels da COMPOSIÇÃO. Quem chama converte de pixels
 * de TELA (`CENTER_SNAP_PX`), pelo mesmo motivo do `magnet.ts`: em pixels de
 * tela o ímã tem sempre a mesma força na mão, em qualquer zoom.
 */
export interface CenterSnap {
  x: number;
  y: number;
  /** Qual eixo grudou — decide se a guia desenhada é vertical, horizontal ou as duas. */
  snapX: boolean;
  snapY: boolean;
}

export function snapToCenter(x: number, y: number, radius: number): CenterSnap {
  const snapX = radius > 0 && Math.abs(x) <= radius;
  const snapY = radius > 0 && Math.abs(y) <= radius;
  return { x: snapX ? 0 : x, y: snapY ? 0 : y, snapX, snapY };
}

/** A força do ímã do palco, em pixels de tela — mesmo raciocínio do `MAGNET_PX` da timeline. */
export const CENTER_SNAP_PX = 8;

/** As quatro quinas da caixa, no referencial da composição. Alimentam as alças. */
export function boxCorners(center: Point, box: Box, rotateDeg: number, scale: number): Point[] {
  const a = rad(rotateDeg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const hw = (box.w / 2) * scale;
  const hh = (box.h / 2) * scale;

  return [
    { x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh },
  ].map(p => ({
    x: center.x + p.x * cos - p.y * sin,
    y: center.y + p.x * sin + p.y * cos,
  }));
}
