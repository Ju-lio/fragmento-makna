import { semArquivo } from '../engine/project.ts';
import type { MediaAsset, Project } from '../engine/types.ts';

/**
 * O acervo do projeto — os arquivos importados, usados ou não.
 *
 * Substituiu a lista de layers, que duplicava a timeline: as mesmas layers, na
 * mesma ordem, com menos informação do que o desenho dos clipes já dá. O que
 * faltava era isto — saber o que existe no projeto, e poder usar de novo sem
 * reimportar (o que guardava uma segunda cópia dos mesmos bytes).
 */

interface MediaPanelProps {
  project: Project;
  /** Põe o arquivo na linha do tempo, no cursor. */
  onUse: (asset: MediaAsset) => void;
  /** Tira do projeto — junto com as layers que o usam. */
  onRemove: (asset: MediaAsset) => void;
}

const KIND = (type: string): { tag: string; cls: string } => {
  if (type.startsWith('video/')) return { tag: 'VID', cls: 'video' };
  if (type.startsWith('audio/')) return { tag: 'SOM', cls: 'audio' };
  return { tag: 'IMG', cls: 'image' };
};

const secs = (d: number) => (d > 0 ? `${d.toFixed(1)}s` : '—');

export function MediaPanel({ project, onUse, onRemove }: MediaPanelProps) {
  if (!project.media.length) {
    return (
      <div className="hint">
        Nenhum arquivo ainda. Use <b>+ MÍDIA</b> ou arraste arquivos pra cá.
      </div>
    );
  }

  return (
    <div className="layer-list">
      {project.media.map(asset => {
        const kind = KIND(asset.type);
        // Quantas layers usam este arquivo. Zero é normal e não é problema:
        // importar e ainda não ter colocado na linha é um estado legítimo.
        const uses = project.layers.filter(
          l => !semArquivo(l) && l.mediaId === asset.id,
        ).length;

        return (
          <div className="layer-item" key={asset.id}>
            <span className={`tag tag-${kind.cls}`}>{kind.tag}</span>
            <span className="layer-name" title={asset.name}>{asset.name}</span>
            <span className="layer-track">{secs(asset.duration)}</span>
            <span className="layer-fx" title="Quantas vezes está na linha do tempo">
              {uses}×
            </span>

            <button
              className="btn btn-sm btn-gold"
              onClick={() => onUse(asset)}
              title="Colocar na linha do tempo, no cursor"
            >
              +
            </button>
            <button
              className="btn btn-sm btn-coral"
              onClick={() => onRemove(asset)}
              title={uses ? `Remover do projeto (e ${uses} clipe(s))` : 'Remover do projeto'}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
