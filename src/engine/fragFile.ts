/**
 * O arquivo `.frag`: um projeto do Fragmento, em JSON, fora do navegador.
 *
 * ## Por que um arquivo, se já existe autosave
 *
 * O autosave mora no IndexedDB da aba. Ele some se você limpar os dados do
 * site, não atravessa pra outra máquina, não entra num backup, e não tem
 * história — é uma cópia só. O `.frag` é o contrário em todas essas: é seu, é
 * um arquivo, e você decide onde ele fica.
 *
 * ## É o MESMO objeto que vai pro disco interno
 *
 * O `.frag` não é um segundo formato. É exatamente o que `serializeProject`
 * produz, com um cabeçalho a mais — então não existe "converter pra exportar",
 * e portanto não existe divergir. Um `.frag` pode ser colado direto no
 * IndexedDB e um projeto do IndexedDB pode ser gravado direto como `.frag`.
 * Dois formatos que se parecem são dois formatos que um dia discordam.
 *
 * ## Legível de propósito
 *
 * Indentado, e com as chaves na ordem em que o `serializeProject` as constrói
 * (que é fixa, porque JS preserva a ordem de inserção). Três coisas saem daí de
 * graça:
 *
 *  - dá pra **ler** e entender o que está no projeto sem abrir o editor;
 *  - dá pra **colar num chat** e pedir pra uma IA explicar ou consertar;
 *  - dá pra **versionar em git**, e o `git diff` entre dois `.frag` mostra o que
 *    mudou na edição — que é o backup mais forte que existe, e de graça.
 *
 * ## O que ele NÃO carrega
 *
 * Os bytes da mídia. Não é esquecimento: base64 incha 33% e um vídeo de 50 MB
 * viraria uma string que trava a aba ao serializar — a mesma razão que já tirou
 * o base64 do armazenamento (ver `mediaStore.ts`). O `.frag` guarda a EDIÇÃO,
 * como um `.fcpxml` ou um `.kdenlive`: o acervo (`media`) descreve os arquivos
 * por id, nome, tipo e duração, e reabrir sem eles reporta quais faltam em vez
 * de fingir que está tudo lá.
 *
 * ## Migração é por CÓDIGO, não por adivinhação
 *
 * `format` diz o dialeto, e as migrações vivem no `serialize.ts`, testadas. Uma
 * IA ajuda a escrever a migração quando o formato muda; ela não deve ser a
 * migração, senão duas aberturas do mesmo arquivo podem dar projetos
 * diferentes.
 */

import { PROJECT_FORMAT, serializeProject } from './serialize.ts';
import type { SerializedProject } from './serialize.ts';
import type { Project } from './types.ts';

export const FRAG_EXT = '.frag';

/** O que o cabeçalho acrescenta ao projeto serializado. */
export interface FragHeader {
  /**
   * Quem gerou. É o que separa um `.frag` de qualquer outro JSON solto — e o
   * que diz a uma IA, daqui a um ano, de que dialeto se trata.
   */
  app: 'fragmento';
  /** Formato do arquivo no momento da gravação. Redundante com `format`
   *  de propósito: o cabeçalho tem que ser legível sem conhecer o resto. */
  appFormat: number;
  /** ISO 8601. Serve pra você reconhecer a versão certa numa pasta com dez. */
  savedAt: string;
}

export type FragFile = FragHeader & SerializedProject;

/**
 * Nome de arquivo sugerido. Sem `:` nem `/`, que não passam em todo sistema.
 */
export function fragFileName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const carimbo = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
    + `_${p(at.getHours())}${p(at.getMinutes())}`;
  return `fragmento_${carimbo}${FRAG_EXT}`;
}

/** O projeto como texto `.frag`. */
export function toFrag(project: Project, at = new Date()): string {
  const arquivo: FragFile = {
    app: 'fragmento',
    appFormat: PROJECT_FORMAT,
    savedAt: at.toISOString(),
    ...serializeProject(project),
  };
  // Dois espaços, e `\n` no fim: é um arquivo de texto, e ferramenta de texto
  // (git, diff, editor) espera terminar em quebra de linha.
  return `${JSON.stringify(arquivo, null, 2)}\n`;
}

/** O arquivo não é um projeto do Fragmento, ou está corrompido. */
export class FragFileError extends Error {}

/**
 * Texto `.frag` -> o objeto que `restoreProject` sabe ler.
 *
 * Só valida o que é preciso pra saber que vale a pena continuar; o resto —
 * migração, campos de layer, formato do futuro — é do `restoreProject`, que já
 * faz isso pro projeto guardado e não pode divergir daqui.
 *
 * As mensagens são o produto desta função tanto quanto o objeto. "Erro ao
 * abrir" manda a pessoa adivinhar; dizer que o arquivo é de outra coisa, ou que
 * veio de uma versão mais nova, diz o que fazer a seguir.
 */
export function fromFrag(text: string): unknown {
  let dados: unknown;
  try {
    dados = JSON.parse(text);
  } catch {
    throw new FragFileError('Este arquivo não é um JSON válido — pode ter sido cortado no meio.');
  }

  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    throw new FragFileError('Este arquivo não parece um projeto do Fragmento.');
  }

  const obj = dados as Record<string, unknown>;

  /**
   * Aceita sem cabeçalho, desde que tenha `format`.
   *
   * É deliberado: o projeto do autosave não tem cabeçalho, e alguém que copie
   * esse objeto do IndexedDB e salve num arquivo tem em mãos um projeto válido.
   * Recusá-lo por falta de um campo decorativo seria pedantismo em cima de
   * alguém tentando recuperar o próprio trabalho.
   */
  if (typeof obj.format !== 'number') {
    throw new FragFileError(
      'Este arquivo não parece um projeto do Fragmento: falta o campo `format`.',
    );
  }

  if (obj.app !== undefined && obj.app !== 'fragmento') {
    throw new FragFileError(`Este projeto foi gerado por outro programa (\`${String(obj.app)}\`).`);
  }

  return obj;
}
