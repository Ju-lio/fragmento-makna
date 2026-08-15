/**
 * O som da reprodução, e o relógio que ela segue.
 *
 * A parte que toca o navegador; a política está em `soundSchedule.ts`, com o
 * relato do porquê deste módulo existir. Em uma linha: um `<video>` buscado a
 * cada corte perde ~11% do tempo real, e a linha do tempo seguia esse elemento.
 *
 * O modelo é o do export (`renderAudio`): cada clipe é um
 * `AudioBufferSourceNode` agendado em amostra exata. Preview e arquivo final
 * passam a montar o som com a MESMA conta, o que é bem mais forte que os dois
 * soarem parecido.
 */

import { mixPlan, soundLayers } from './audioMix.ts';
import { impliedPosition, projectSignature, scheduleFrom, soundAction } from './soundSchedule.ts';
import type { Anchor } from './soundSchedule.ts';
import type { ClockSample } from './player.ts';
import type { Layer } from './types.ts';

/** De onde vêm os bytes. Injetado pra este módulo não conhecer o IndexedDB. */
export type BlobResolver = (mediaId: string) => Promise<Blob | null>;

export interface SyncInput {
  t: number;
  playing: boolean;
  /** Onde o projeto acaba — o laço da reprodução volta daí. */
  duration: number;
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  /**
   * A saída única do tocador — todo clipe passa por aqui antes do alto-falante.
   *
   * Um nó só, e não cada fonte ligada direto no `destination`, porque é o que
   * dá um lugar pra ligar mais alguma coisa: um volume geral, um medidor, e a
   * gravação que a bancada usa pra conferir que o som que sai é o som certo.
   * Sem ele, o que o preview toca não é observável de lugar nenhum.
   */
  private saida: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  /** Mídia que não dá pra decodificar: vídeo mudo, codec ausente. Não insiste. */
  private semSom = new Set<string>();
  private decodificando = new Set<string>();
  private fontes: AudioBufferSourceNode[] = [];
  private anchor: Anchor | null = null;
  private assinatura = '';
  private tocando = false;
  private geracao = 0;
  private getBlob: BlobResolver | null = null;

  /** Quem entrega os bytes. Instalado uma vez, na montagem do editor. */
  setBlobResolver(fn: BlobResolver): void { this.getBlob = fn; }

  /**
   * O contexto, criado no primeiro uso.
   *
   * Tarde de propósito: um `AudioContext` criado na carga da página nasce
   * suspenso pela política de autoplay e fica lá segurando o dispositivo de
   * áudio à toa. Criar quando o play acontece é criar depois do gesto.
   */
  private contexto(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === 'undefined') return null;
    this.ctx = new AudioContext();
    this.saida = this.ctx.createGain();
    this.saida.connect(this.ctx.destination);
    return this.ctx;
  }

  /**
   * A saída, pra quem precisa escutar o que está sendo tocado.
   *
   * `null` antes da primeira reprodução, porque o contexto nasce no play. Ver
   * `saida` — existe pra que o som do preview seja verificável, e não só
   * audível.
   */
  output(): GainNode | null { return this.saida; }

  /**
   * Decodifica o que ainda falta, em segundo plano.
   *
   * Idempotente e barato de chamar de novo: cada `mediaId` é decodificado uma
   * vez só, mesmo aparecendo em vinte clipes — cortar uma música em pedaços é o
   * caso comum, e é o mesmo motivo que o `renderAudio` já tinha.
   */
  ensure(layers: readonly Layer[]): void {
    const ctx = this.contexto();
    const getBlob = this.getBlob;
    if (!ctx || !getBlob) return;

    for (const layer of soundLayers(layers)) {
      const id = layer.mediaId;
      if (this.buffers.has(id) || this.semSom.has(id) || this.decodificando.has(id)) continue;

      this.decodificando.add(id);
      void (async () => {
        try {
          const blob = await getBlob(id);
          if (!blob) { this.semSom.add(id); return; }
          this.buffers.set(id, await ctx.decodeAudioData(await blob.arrayBuffer()));
          // A agenda no ar foi montada sem esta trilha. Forçar o próximo tick a
          // remontá-la é o que faz o som entrar assim que ele existe, em vez de
          // só no próximo corte.
          this.assinatura = '';
        } catch {
          // Vídeo sem trilha de áudio, ou codec que este navegador não abre.
          // Seguir sem ele é melhor que derrubar a reprodução inteira.
          this.semSom.add(id);
        } finally {
          this.decodificando.delete(id);
        }
      })();
    }
  }

  /**
   * Chamado a cada tick. Quase sempre não faz nada — ver `soundAction`.
   */
  sync(layers: readonly Layer[], { t, playing, duration }: SyncInput): void {
    const ctx = this.contexto();
    if (!ctx) return;

    if (playing) this.ensure(layers);

    // O que AGENDAR sai do playhead; o que COMPARAR é o projeto inteiro. Ver
    // `projectSignature` — confundir os dois refaz a agenda a cada quadro.
    const clips = playing ? mixPlan(layers, { from: t, to: duration }) : [];
    const assinatura = playing ? projectSignature(layers, duration) : '';
    const acao = soundAction(
      { tocando: this.tocando, anchor: this.anchor, assinatura: this.assinatura },
      { t, playing, ctxNow: ctx.currentTime, assinatura },
    );

    if (acao === 'seguir') return;
    this.pararFontes();
    if (acao === 'parar') return;

    // O gesto do usuário já aconteceu (o play parte de um clique ou da barra de
    // espaço), mas o contexto pode ter nascido suspenso mesmo assim.
    if (ctx.state === 'suspended') void ctx.resume();

    /**
     * A âncora conta a partir de quando o som fica AUDÍVEL, não de quando ele é
     * agendado.
     *
     * Entre `start(quando)` e o alto-falante existe a latência de saída do
     * dispositivo — de poucos milissegundos a mais de cem, dependendo da placa
     * e do sistema. Ancorar em `currentTime` puro deixaria a imagem adiantada
     * exatamente por essa latência, em todo projeto, num desencontro constante
     * que ninguém consegue atribuir a nada olhando o editor.
     */
    const latencia = ctx.outputLatency || ctx.baseLatency || 0;
    const agenda = scheduleFrom(clips, {
      ctxNow: ctx.currentTime,
      bufferDurationOf: id => this.buffers.get(id)?.duration ?? null,
    });

    const saida = this.saida ?? ctx.destination;
    for (const s of agenda) {
      const buffer = this.buffers.get(s.mediaId);
      if (!buffer) continue;

      const fonte = ctx.createBufferSource();
      fonte.buffer = buffer;
      const ganho = ctx.createGain();
      ganho.gain.value = s.gain;
      fonte.connect(ganho).connect(saida);
      fonte.start(s.when, s.offset, s.duration);
      this.fontes.push(fonte);
    }

    this.geracao++;
    this.anchor = { t, ctx: ctx.currentTime + latencia, geracao: this.geracao };
    this.assinatura = assinatura;
    this.tocando = true;
  }

  /**
   * A leitura pro `player.setTimeSource`.
   *
   * `null` quando não há som tocando — aí o `player` volta pro rAF, que é o
   * melhor disponível quando não existe nada melhor. Um projeto mudo continua
   * reproduzindo exatamente como antes.
   */
  clock(): ClockSample | null {
    if (!this.tocando || !this.anchor || !this.ctx) return null;
    // Sem fonte agendada não há som saindo, e o `currentTime` do contexto
    // andaria sozinho — seria um relógio de parede se passando por relógio de
    // áudio. Num trecho silencioso é o rAF que deve conduzir.
    if (!this.fontes.length) return null;
    return {
      position: impliedPosition(this.anchor, this.ctx.currentTime),
      id: `webaudio:${this.anchor.geracao}`,
    };
  }

  /** Silêncio imediato — o transporte parou. */
  stop(): void {
    this.pararFontes();
    this.assinatura = '';
  }

  /** Troca de projeto: o material anterior não vale mais. */
  release(): void {
    this.stop();
    this.buffers.clear();
    this.semSom.clear();
  }

  private pararFontes(): void {
    for (const f of this.fontes) {
      // Uma fonte que já terminou sozinha lança ao ser parada de novo.
      try { f.stop(); } catch { /* já acabou */ }
      f.disconnect();
    }
    this.fontes = [];
    this.anchor = null;
    this.tocando = false;
  }
}

export const soundEngine = new SoundEngine();
