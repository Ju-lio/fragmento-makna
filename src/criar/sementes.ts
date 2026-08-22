/**
 * Os efeitos de partida do `/criar`.
 *
 * Não são exemplos de brinquedo: são os efeitos que foram MEDIDOS funcionando
 * durante o levantamento do LIMITES.md — o raio com `clip-path` + `drop-shadow`
 * + `mix-blend-mode`, o texto empilhado de seis camadas, o grão por
 * `feTurbulence`. Quem abre a página vê CSS que roda, não pseudocódigo.
 *
 * Cada tipo usa params DIFERENTES de propósito: quem abre em "texto" precisa
 * ver `texto()` existindo, senão supõe que só dá pra declarar número.
 */

import type { Tipo } from './api.ts';

export interface Semente {
  manifesto: string;
  html: string;
  css: string;
}

export const ROTULO: Record<Tipo, string> = {
  efeito: 'EFEITO',
  filtro: 'FILTRO',
  transicao: 'TRANSIÇÃO',
  texto: 'TEXTO',
};

export const ONDE_APARECE: Record<Tipo, string> = {
  efeito: 'Aplicado numa layer, na aba EFEITOS.',
  filtro: 'Aplicado nos pixels de uma layer, na aba FILTROS.',
  transicao: 'Entre dois clipes vizinhos — ou entre o nada e o primeiro.',
  texto: 'Uma layer de texto com aparência e animação prontas.',
};

export const SEMENTES: Record<Tipo, Semente> = {
  efeito: {
    manifesto: `{
  "meta": { "tipo": "efeito", "nome": "Raio", "autor": "voce" },
  "params": {
    "brilho":  { "tipo": "num", "padrao": 34, "min": 0, "max": 90, "unidade": "px",
                 "rotulo": "Brilho" },
    "cor":     { "tipo": "cor", "padrao": "#4a7cff", "rotulo": "Cor do brilho" },
    "largura": { "tipo": "num", "padrao": 7, "min": 2, "max": 20, "passo": 0.5,
                 "unidade": "%", "rotulo": "Espessura" }
  }
}`,
    html: `<div class="brilho"></div>
<div class="raio"></div>`,
    css: `/* Tudo aqui é CSS comum. O editor injeta os params como --p-*,
   e leva a animação ao instante certo sozinho. */

.raio {
  position: absolute;
  left: 50%; top: -10%;
  width: var(--p-largura);
  height: 120%;
  margin-left: calc(var(--p-largura) / -2);
  background: linear-gradient(180deg, #fff 0%, #9fd4ff 35%,
              var(--p-cor) 70%, transparent 100%);
  clip-path: polygon(52% 0, 32% 42%, 48% 42%, 26% 100%,
                     58% 46%, 42% 46%, 64% 0);
  filter: drop-shadow(0 0 12px #6aa8ff)
          drop-shadow(0 0 var(--p-brilho) var(--p-cor));
  mix-blend-mode: screen;
  animation: piscar 1.6s infinite steps(1);
}
@keyframes piscar {
  0%   { opacity: 0 }
  6%   { opacity: 1 }
  11%  { opacity: .15 }
  17%  { opacity: 1 }
  27%, 100% { opacity: 0 }
}

.brilho {
  position: absolute; inset: 0;
  background: radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--p-cor), white 30%), transparent 55%);
  mix-blend-mode: screen;
  animation: clarao 1.6s infinite steps(1);
}
@keyframes clarao {
  0%, 27%, 100% { opacity: 0 }
  6%  { opacity: .9 }
  11% { opacity: .1 }
  17% { opacity: .7 }
}`,
  },

  texto: {
    manifesto: `{
  "meta": { "tipo": "texto", "nome": "Retrô empilhado", "autor": "voce" },
  "params": {
    "conteudo": { "tipo": "texto", "padrao": "FRAGMENTO", "rotulo": "Texto" },
    "corpo":    { "tipo": "num", "padrao": 9, "min": 2, "max": 20, "passo": 0.5,
                  "unidade": "vw", "rotulo": "Tamanho" },
    "desloc":   { "tipo": "num", "padrao": 0.35, "min": 0.05, "max": 1.5, "passo": 0.05,
                  "unidade": "vw", "rotulo": "Profundidade" },
    "corFrente":{ "tipo": "cor", "padrao": "#0b0b2a", "rotulo": "Cor da frente" }
  }
}`,
    html: `<div class="titulo">
  <span style="--i:0">F</span><span style="--i:1">R</span><span style="--i:2">A</span
  ><span style="--i:3">G</span><span style="--i:4">M</span><span style="--i:5">E</span
  ><span style="--i:6">N</span><span style="--i:7">T</span><span style="--i:8">O</span>
</div>`,
    css: `/* Seis camadas de sombra fazem a extrusão; o --i de cada letra
   escalona a entrada sem uma linha de JS.

   Tamanho em vw, não px: vw resolve contra o TAMANHO DO PROJETO, então o
   mesmo efeito serve 1920x1080 e 1080x1920 sem você mexer em nada.
   Com px, ele vazaria da tela ao trocar de formato. Ver LIMITES.md §3. */

.titulo {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font: 900 var(--p-corpo)/1 system-ui, sans-serif;
  color: var(--p-corFrente);
  text-shadow:
    calc(var(--p-desloc) * 1) calc(var(--p-desloc) * 1) 0 #1e3fff,
    calc(var(--p-desloc) * 2) calc(var(--p-desloc) * 2) 0 #3b7bd8,
    calc(var(--p-desloc) * 3) calc(var(--p-desloc) * 3) 0 #d98b5f,
    calc(var(--p-desloc) * 4) calc(var(--p-desloc) * 4) 0 #f2c9a0,
    calc(var(--p-desloc) * 5) calc(var(--p-desloc) * 5) 0 #fdf0d5;
}

.titulo span {
  display: inline-block;
  animation: entra .5s cubic-bezier(.2, .9, .3, 1.4) both;
  animation-delay: calc(var(--i) * .06s);
}
@keyframes entra {
  from { opacity: 0; transform: translateY(70px) rotate(-8deg) }
  to   { opacity: 1; transform: none }
}`,
  },

  filtro: {
    manifesto: `{
  "meta": { "tipo": "filtro", "nome": "Granulado", "autor": "voce" },
  "params": {
    "quantidade": { "tipo": "num", "padrao": 0.22, "min": 0, "max": 1, "passo": 0.01,
                    "rotulo": "Quantidade" },
    "escala":     { "tipo": "num", "padrao": 0.85, "min": 0.1, "max": 2, "passo": 0.05,
                    "rotulo": "Escala do grão" },
    "vinheta":    { "tipo": "num", "padrao": 0.7, "min": 0, "max": 1, "passo": 0.05,
                    "rotulo": "Vinheta" }
  }
}`,
    html: `<svg width="0" height="0">
  <filter id="grao">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="5"/>
    <feColorMatrix type="saturate" values="0"/>
  </filter>
</svg>
<div class="grao"></div>
<div class="vinheta"></div>`,
    css: `/* Grão de filme. feTurbulence é ruído procedural e tem seed,
   então o mesmo instante dá sempre o mesmo grão — sem isso o vídeo
   sairia fervendo. Ver LIMITES.md §2.1. */

.grao {
  position: absolute; inset: 0;
  opacity: var(--p-quantidade);
  filter: url(#grao);
  transform: scale(var(--p-escala));
  transform-origin: center;
}

.vinheta {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 50%,
              transparent 42%,
              rgba(0,0,0, calc(var(--p-vinheta) * 0.85)) 100%);
}`,
  },

  transicao: {
    manifesto: `{
  "meta": { "tipo": "transicao", "nome": "Empurrar", "autor": "voce" },
  "params": {
    "suavizar": { "tipo": "num", "padrao": 0.6, "min": 0, "max": 1, "passo": 0.05,
                  "rotulo": "Suavizar" }
  }
}`,
    html: `<div class="v1" data-frag="video1"></div>
<div class="v2" data-frag="video2"></div>`,
    css: `/* Uma transição declara ONDE cada clipe fica; quem desenha os
   pixels é o compositor. O data-frag marca o slot.

   ATENÇÃO: os slots ainda não estão ligados (fase D do PRIORIDADES).
   Aqui eles aparecem como blocos coloridos, pra você ver a geometria. */

.v1, .v2 {
  position: absolute; inset: 0;
  animation-duration: 1s;
  animation-timing-function: cubic-bezier(calc(.4 - var(--p-suavizar) * .4), 0, .2, 1);
  animation-fill-mode: both;
}
.v1 { background: #c0392b; animation-name: sai }
.v2 { background: #2471a3; animation-name: entra }

@keyframes sai   { from { transform: translateX(0) }    to { transform: translateX(-100%) } }
@keyframes entra { from { transform: translateX(100%) } to { transform: translateX(0) } }`,
  },
};
