/**
 * A bandeja: como um efeito sai do `/criar` e chega no editor.
 *
 * As duas páginas são entradas SEPARADAS do Vite — não compartilham estado, e é
 * de propósito (ver `criar.html`). Então o efeito atravessa por
 * `localStorage`, que é o único canal que as duas enxergam.
 *
 * Deliberadamente burro: um slot só, sobrescrito a cada envio, lido e
 * **consumido** pelo editor. Não é biblioteca de efeitos nem persistência de
 * projeto — é a bandeja onde se apoia uma coisa pra pegar do outro lado. Uma
 * biblioteca de verdade é a fase F, e vai precisar de decisões (versão,
 * atualização, conflito) que não cabem num `localStorage.setItem`.
 */

import { validarEsquema } from './api.ts';
import type { Esquema } from './api.ts';

const CHAVE = 'fragmento:bandeja-efeito';

export interface EfeitoNaBandeja {
  nome: string;
  html: string;
  css: string;
  schema: Esquema;
  values: Record<string, unknown>;
}

/** Deixa um efeito na bandeja. Sobrescreve o que estava lá. */
export function guardar(efeito: EfeitoNaBandeja): void {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(efeito));
  } catch {
    // Modo anônimo, cota estourada. Perder a bandeja é chato, não é fatal —
    // e derrubar o /criar por causa disso seria pior.
  }
}

/**
 * Pega o efeito da bandeja, se houver.
 *
 * NÃO consome: quem chama decide, porque o editor pode querer só saber se há
 * algo esperando (pra acender o botão) sem esvaziar.
 */
export function espiar(): EfeitoNaBandeja | null {
  let cru: string | null = null;
  try {
    cru = localStorage.getItem(CHAVE);
  } catch { return null; }
  if (!cru) return null;

  try {
    const o = JSON.parse(cru) as Partial<EfeitoNaBandeja>;
    if (typeof o.html !== 'string' || typeof o.css !== 'string') return null;
    // Schema quebrado vira vazio, não descarta o efeito — a mesma escolha do
    // `readLayer` em serialize.ts: o CSS desenha sem o schema; só o painel
    // depende dele.
    const schema = (typeof o.schema === 'object' && o.schema && validarEsquema(o.schema) === null)
      ? o.schema : {};
    return {
      nome: typeof o.nome === 'string' && o.nome ? o.nome : 'Efeito',
      html: o.html,
      css: o.css,
      schema,
      values: (typeof o.values === 'object' && o.values) ? o.values : {},
    };
  } catch {
    return null;
  }
}

/** Esvazia. Chamado depois de o efeito virar layer. */
export function limpar(): void {
  try { localStorage.removeItem(CHAVE); } catch { /* ver `guardar` */ }
}
