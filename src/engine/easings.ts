export type EasingFn = (t: number) => number;

/** Easing functions available to effect tracks. Names are part of the public
 *  effect schema — adding one here makes it usable in generated effect JSON. */
export const EASE = {
  linear:    t => t,
  inQuad:    t => t * t,
  outQuad:   t => 1 - (1 - t) ** 2,
  inOutQuad: t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  inCubic:   t => t ** 3,
  outCubic:  t => 1 - (1 - t) ** 3,
  outQuart:  t => 1 - (1 - t) ** 4,
  outQuint:  t => 1 - (1 - t) ** 5,
  inQuint:   t => t ** 5,
  outExpo:   t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inBack:    t => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t ** 3 - c1 * t * t; },
  outBack:   t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; },
  outElastic: t => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  outBounce: t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  // `satisfies` em vez de anotação: o objeto continua com as chaves literais,
  // então EaseName abaixo é a lista de verdade e não `string`. Adicionar um
  // easing aqui passa a ser aceito no JSON de efeito sem tocar em mais nada.
} satisfies Record<string, EasingFn>;

/** Nomes válidos de easing — parte do schema público de efeitos. */
export type EaseName = keyof typeof EASE;

export const EASE_NAMES = Object.keys(EASE) as EaseName[];
