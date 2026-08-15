/**
 * O histórico do projeto no disco: as últimas versões, pra quando algo der
 * errado.
 *
 * ## O que isto cobre que o undo não cobre
 *
 * O undo vive na memória da aba e morre com ela. Ele também não protege do caso
 * que assusta de verdade: você não desfez nada errado — o **editor** fez. Uma
 * migração com defeito, um campo que mudou de forma, um crash no meio de uma
 * edição. Aí o que está no disco é o estado ruim, e o undo já foi embora junto
 * com a aba.
 *
 * Snapshot é a resposta: o autosave deixa de ser uma cópia só e passa a ser as
 * últimas N. "Bugou e mexeu no projeto" vira "volto pra versão de dez minutos
 * atrás".
 *
 * ## Por que a política é pura, e mora aqui
 *
 * Porque ela DECIDE O QUE APAGAR. Um erro de um índice aqui não deixa rastro
 * nenhum na tela — some histórico, e você só descobre no dia em que precisar
 * dele, que é exatamente o dia em que não dá pra consertar.
 */

/** Uma versão guardada. `at` é a chave: milissegundos desde a época. */
export interface SnapshotMeta {
  at: number;
}

export interface SnapshotPolicy {
  /**
   * Intervalo mínimo entre duas versões guardadas.
   *
   * O autosave dispara a cada 600ms de pausa, e guardar uma versão em cada um
   * encheria o histórico com o mesmo minuto de trabalho, empurrando pra fora
   * justamente as versões antigas — que são as que interessam. Espaçando, as N
   * versões cobrem HORAS em vez de segundos.
   */
  everyMs: number;
  /** Quantas versões manter. Ver `snapshotPlan` pro que é descartado. */
  max: number;
}

export const DEFAULT_POLICY: SnapshotPolicy = {
  // Dois minutos: perto o bastante pra você não perder trabalho que doa, longe
  // o bastante pra vinte versões cobrirem quarenta minutos de edição.
  everyMs: 2 * 60_000,
  max: 20,
};

export interface SnapshotPlan {
  /** Guardar uma versão agora? */
  write: boolean;
  /** Chaves a apagar pra respeitar o teto. */
  drop: number[];
}

/**
 * O que fazer com o histórico neste autosave.
 *
 * `existing` vem ordenado ou não — não importa, a função ordena. O teto é
 * aplicado CONTANDO a versão que está prestes a entrar, senão o histórico
 * passaria do limite por um até a gravação seguinte.
 */
export function snapshotPlan(
  existing: readonly SnapshotMeta[],
  now: number,
  { everyMs, max }: SnapshotPolicy = DEFAULT_POLICY,
): SnapshotPlan {
  const ordenado = [...existing].map(s => s.at).sort((a, b) => a - b);
  const ultima = ordenado[ordenado.length - 1];

  /**
   * Cedo demais desde a última: não guarda, e **não apaga nada**.
   *
   * Sair daqui apagando seria o pior dos dois mundos — o histórico encolheria
   * de segundo em segundo sem nunca ganhar versão nova.
   */
  const write = ultima === undefined || now - ultima >= everyMs;
  if (!write) return { write: false, drop: [] };

  // Quantas sobrariam com a nova dentro. Só o excedente sai, e sempre pela
  // ponta velha: a versão mais recente é a que você mais provavelmente quer.
  const excedente = ordenado.length + 1 - Math.max(1, max);
  return { write: true, drop: excedente > 0 ? ordenado.slice(0, excedente) : [] };
}

/** Rótulo humano pra uma versão: "há 5 min", "ontem 14:32". */
export function snapshotLabel(at: number, now: number): string {
  const seg = Math.max(0, Math.round((now - at) / 1000));
  if (seg < 60) return 'agora mesmo';
  const min = Math.round(seg / 60);
  if (min < 60) return `há ${min} min`;

  const data = new Date(at);
  const hora = `${String(data.getHours()).padStart(2, '0')}:${String(data.getMinutes()).padStart(2, '0')}`;
  const hoje = new Date(now);
  const mesmoDia = data.toDateString() === hoje.toDateString();
  if (mesmoDia) return `hoje ${hora}`;

  const ontem = new Date(now - 86_400_000);
  if (data.toDateString() === ontem.toDateString()) return `ontem ${hora}`;

  return `${String(data.getDate()).padStart(2, '0')}/${String(data.getMonth() + 1).padStart(2, '0')} ${hora}`;
}
