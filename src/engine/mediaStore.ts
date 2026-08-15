/**
 * Onde os arquivos de mídia realmente moram.
 *
 * O projeto salvo guarda um `mediaId` por layer; os bytes ficam aqui, em
 * IndexedDB. Foi a escolha em vez das duas alternativas óbvias:
 *
 *  - **Embutir em base64 no JSON** inchava o arquivo em ~33% e transformava um
 *    vídeo de 50 MB numa string que trava a aba ao serializar.
 *  - **Guardar o caminho do arquivo** não existe no browser: o `File` que você
 *    escolheu não pode ser reaberto sozinho depois: reabrir exigiria o usuário
 *    reapontar cada mídia a cada vez que abre o editor.
 *
 * Com os blobs em IndexedDB, recarregar a página devolve o projeto inteiro
 * funcionando, offline, sem pedir nada.
 *
 * As URLs `blob:` criadas aqui vivem enquanto a aba viver. Isso é deliberado:
 * o undo pode ressuscitar uma layer excluída, então revogar a URL ao excluir
 * faria a layer voltar preta. Quem libera é `releaseAll`, na troca de projeto.
 */

const DB_NAME = 'fragmento';
/**
 * 1 → 2: entrou o store `snapshots` (o histórico de versões do projeto).
 *
 * Subir a versão é o único jeito de criar um store, e o `onupgradeneeded` abaixo
 * é escrito pra rodar em qualquer ponto de partida: cada store é criado só se
 * ainda não existir, então quem vem da 1 ganha o novo e mantém os dois antigos
 * intactos. Nada é reescrito, nada é migrado — o projeto guardado continua
 * exatamente onde estava.
 */
const DB_VERSION = 2;
const MEDIA_STORE = 'media';
const PROJECT_STORE = 'project';
const SNAPSHOT_STORE = 'snapshots';

/** Só existe um projeto por enquanto; a chave é fixa. */
const CURRENT_PROJECT = 'current';

export interface StoredMedia {
  id: string;
  name: string;
  /** MIME do arquivo — é o que diz se a layer é imagem ou vídeo ao reabrir. */
  type: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE);
      // Chave = instante da gravação, então listar já vem em ordem cronológica.
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponível'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(store, mode).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('falha no IndexedDB'));
  }));
}

/** id -> object URL viva nesta sessão. Evita criar duas URLs pro mesmo arquivo. */
const urls = new Map<string, string>();

export const newMediaId = (): string =>
  `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export async function putMedia(id: string, file: File): Promise<void> {
  await tx(MEDIA_STORE, 'readwrite', s =>
    s.put({ id, name: file.name, type: file.type, blob: file } satisfies StoredMedia));
}

/** Os bytes de uma mídia. `null` quando ela não está mais guardada. */
export async function mediaBlob(id: string): Promise<Blob | null> {
  const found = await tx<StoredMedia | undefined>(MEDIA_STORE, 'readonly', s => s.get(id));
  return found?.blob ?? null;
}

export async function allMedia(): Promise<StoredMedia[]> {
  return await tx<StoredMedia[]>(MEDIA_STORE, 'readonly', s => s.getAll());
}

/**
 * URL estável pra um blob já carregado. Chamar duas vezes com o mesmo id
 * devolve a mesma URL — criar uma nova a cada uso vazaria uma cópia por vez.
 */
export function urlFor(id: string, blob: Blob): string {
  const existing = urls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

/**
 * A URL já criada pra esta mídia, ou `null`.
 *
 * Existe pra quem precisa de um SEGUNDO elemento sobre a mesma fonte sem ter os
 * bytes na mão — separar o áudio de um clipe é isso: um `<audio>` novo lendo a
 * mesma blob que o `<video>` já está lendo. Nada é baixado nem duplicado.
 */
export function existingUrl(id: string): string | null {
  return urls.get(id) ?? null;
}

/** Libera todas as URLs desta sessão. Chamado ao trocar de projeto. */
export function releaseAll(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

/**
 * Apaga a mídia que nenhuma layer usa mais.
 *
 * Roda na troca de projeto, não a cada exclusão de layer: enquanto o histórico
 * puder desfazer a exclusão, o arquivo ainda é necessário.
 */
export async function pruneMedia(keep: Set<string>): Promise<void> {
  const stored = await allMedia();
  await Promise.all(
    stored
      .filter(m => !keep.has(m.id))
      .map(m => tx(MEDIA_STORE, 'readwrite', s => s.delete(m.id))),
  );
}

export async function saveProject(data: unknown): Promise<void> {
  await tx(PROJECT_STORE, 'readwrite', s => s.put(data, CURRENT_PROJECT));
}

export async function loadProject(): Promise<unknown> {
  return await tx(PROJECT_STORE, 'readonly', s => s.get(CURRENT_PROJECT));
}

export async function clearProject(): Promise<void> {
  await tx(PROJECT_STORE, 'readwrite', s => s.delete(CURRENT_PROJECT));
}

// --- histórico de versões -------------------------------------------------

/**
 * As versões guardadas, da mais antiga pra mais nova.
 *
 * Só as CHAVES — os projetos em si podem ser dezenas, e a lista é lida a cada
 * autosave só pra decidir se cabe uma nova (ver `snapshotPlan`). Trazer o
 * conteúdo junto seria ler megabytes pra responder uma pergunta sobre datas.
 */
export async function listSnapshots(): Promise<number[]> {
  const chaves = await tx<IDBValidKey[]>(SNAPSHOT_STORE, 'readonly', s => s.getAllKeys());
  return chaves.filter((k): k is number => typeof k === 'number').sort((a, b) => a - b);
}

export async function putSnapshot(at: number, data: unknown): Promise<void> {
  await tx(SNAPSHOT_STORE, 'readwrite', s => s.put(data, at));
}

export async function getSnapshot(at: number): Promise<unknown> {
  return await tx(SNAPSHOT_STORE, 'readonly', s => s.get(at));
}

export async function deleteSnapshots(ats: readonly number[]): Promise<void> {
  await Promise.all(ats.map(at => tx(SNAPSHOT_STORE, 'readwrite', s => s.delete(at))));
}

export async function clearSnapshots(): Promise<void> {
  await tx(SNAPSHOT_STORE, 'readwrite', s => s.clear());
}
