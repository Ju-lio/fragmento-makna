/**
 * O demuxer, atrás de um `import()`.
 *
 * ## Por que um arquivo só pra isto
 *
 * `createDefaultDemuxerFactory` do `@elah/core` faz `import * as mediabunny`
 * no topo do próprio módulo. Importá-lo junto com o resto da engine arrastou o
 * mediabunny inteiro pro pacote principal: **330 kB viraram 987 kB**, pagos no
 * primeiro carregamento por todo mundo — inclusive por quem abre o editor pra
 * mexer num título e não tem um vídeo no projeto.
 *
 * Isolá-lo num módulo próprio, alcançado só por `import()`, devolve o demuxer
 * pro pedaço que o bundler carrega sob demanda. Nada aqui pode ser importado
 * estaticamente por ninguém, ou o efeito se desfaz em silêncio — o único sinal
 * seria o tamanho do pacote subindo de novo. Ver `demuxerFactory` no
 * `videoFrames.ts`, que é o único caminho até aqui.
 */

import { createDefaultDemuxerFactory } from '@elah/core';
import type { DemuxerFactory } from '@elah/core';

export const demuxerFactory: DemuxerFactory = createDefaultDemuxerFactory();
