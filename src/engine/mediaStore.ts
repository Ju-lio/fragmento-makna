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
const DB_VERSION = 1;
const MEDIA_STORE = 'media';
const PROJECT_STORE = 'project';

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
