/** Starter effect library. Everything beyond this is meant to be generated
 *  from SCHEMA_DOC and pasted in — the app ships a runtime, not a catalogue. */
export const PRESETS = {
  'fade-up': {
    name: 'fade-up', duration: 0.7,
    tracks: [
      { prop: 'opacity', keys: [[0, 0], [0.55, 1]], ease: 'outQuad' },
      { prop: 'y', keys: [[0, 60], [1, 0]], ease: 'outQuint' },
    ],
  },
  'zoom-punch': {
    name: 'zoom-punch', duration: 0.6,
    tracks: [
      { prop: 'scale', keys: [[0, 0.6], [0.55, 1.06], [1, 1]], ease: 'outQuint' },
      { prop: 'opacity', keys: [[0, 0], [0.3, 1]], ease: 'outQuad' },
    ],
  },
  'spring-pop': {
    name: 'spring-pop', duration: 0.9,
    tracks: [
      { prop: 'scale', keys: [[0, 0.3], [1, 1]], ease: 'outBack' },
      { prop: 'rotate', keys: [[0, -12], [1, 0]], ease: 'outBack' },
      { prop: 'opacity', keys: [[0, 0], [0.25, 1]] },
    ],
  },
  'blur-in': {
    name: 'blur-in', duration: 0.8,
    tracks: [
      { prop: 'blur', keys: [[0, 26], [1, 0]], ease: 'outQuint' },
      { prop: 'opacity', keys: [[0, 0], [0.5, 1]], ease: 'outQuad' },
      { prop: 'scale', keys: [[0, 1.15], [1, 1]], ease: 'outQuint' },
    ],
  },
  'slide-track': {
    name: 'slide-track', duration: 1.0,
    tracks: [
      { prop: 'x', keys: [[0, -140], [1, 0]], ease: 'outExpo' },
      { prop: 'letterSpacing', keys: [[0, 34], [1, 0]], ease: 'outExpo' },
      { prop: 'opacity', keys: [[0, 0], [0.3, 1]] },
    ],
  },
  'float-loop': {
    name: 'float-loop', duration: 3.0, loop: true,
    tracks: [
      { prop: 'y', keys: [[0, 0], [0.5, -22], [1, 0]], ease: 'inOutQuad' },
      { prop: 'rotate', keys: [[0, -1.5], [0.5, 1.5], [1, -1.5]], ease: 'inOutQuad' },
    ],
  },
  'glitch-shake': {
    name: 'glitch-shake', duration: 0.5,
    tracks: [
      { prop: 'x', keys: [[0, 0], [0.15, -18], [0.3, 15], [0.45, -11], [0.6, 7], [0.8, -3], [1, 0]] },
      { prop: 'rotate', keys: [[0, 0], [0.2, -2], [0.5, 2], [0.75, -1], [1, 0]] },
    ],
  },
  'neon-pulse': {
    name: 'neon-pulse', duration: 1.6, loop: true,
    tracks: [
      { prop: 'brightness', keys: [[0, 1], [0.5, 1.6], [1, 1]], ease: 'inOutQuad' },
      { prop: 'scale', keys: [[0, 1], [0.5, 1.03], [1, 1]], ease: 'inOutQuad' },
    ],
  },
  'fade-out-down': {
    name: 'fade-out-down', duration: 0.6, anchor: 'end',
    tracks: [
      { prop: 'opacity', keys: [[0, 1], [1, 0]], ease: 'inQuad' },
      { prop: 'y', keys: [[0, 0], [1, 50]], ease: 'inCubic' },
      { prop: 'scale', keys: [[0, 1], [1, 0.92]], ease: 'inQuad' },
    ],
  },
};

export const SCHEMA_DOC = `# Schema de efeitos — Fragmento

Um efeito e' JSON puro (sem codigo). Formato:

{
  "name": "meu-efeito",
  "duration": 0.8,          // segundos
  "anchor": "start",        // "start" (padrao) ou "end" (animacao de saida)
  "delay": 0,               // segundos, opcional
  "loop": false,            // opcional: repete pra sempre
  "tracks": [
    { "prop": "scale", "keys": [[0, 0.5], [1, 1]], "ease": "outBack" }
  ]
}

## keys
Pares [tempoNormalizado, valor]. O tempo vai de 0 a 1 (fracao da duration),
entao o mesmo efeito funciona em qualquer duracao.

## props disponiveis (SOMENTE estas)
  x, y            px, somados a posicao base
  scale           multiplicador (1 = normal)
  rotate          graus, somado
  opacity         multiplicador 0..1
  blur            px, somado
  brightness      multiplicador (1 = normal)
  letterSpacing   px, somado (so faz efeito em layers de texto)

## regra de composicao
scale, opacity e brightness MULTIPLICAM o valor base.
x, y, rotate, blur e letterSpacing SOMAM.
Varios efeitos na mesma layer se combinam por essa regra.

## eases disponiveis
linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, outQuart,
outQuint, inQuint, outExpo, inBack, outBack, outElastic, outBounce

## exemplo completo
{
  "name": "zoom-punch",
  "duration": 0.6,
  "tracks": [
    {"prop":"scale","keys":[[0,0.6],[0.55,1.06],[1,1]],"ease":"outQuint"},
    {"prop":"opacity","keys":[[0,0],[0.3,1]],"ease":"outQuad"}
  ]
}

Responda SEMPRE apenas com o JSON do efeito, sem explicacao.`;
