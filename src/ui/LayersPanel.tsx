import type { Layer, LayerType, Project } from '../engine/types.ts';

const TAGS: Record<LayerType, string> = { video: 'VID', image: 'IMG', text: 'TXT' };

interface LayersPanelProps {
  project: Project;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
}

/**
 * Lista de layers — leitura e seleção, não reordenação.
 *
 * A ordem se muda arrastando o clipe entre as faixas da timeline, que é onde
 * você já está olhando quando pensa em ordem. As setas ▲▼ que existiam aqui
 * pediam para você mirar num alvo pequeno, num painel diferente do que mostra
 * o resultado, uma posição por clique.
 */
export function LayersPanel({ project, selectedId, onSelect, onDelete }: LayersPanelProps) {
  // Later layers draw on top, so show the list front-to-back like every editor.
  const ordered = [...project.layers].reverse();

  return (
    <div className="layer-list">
      {ordered.length === 0 && <div className="hint">Nenhuma layer. Use + TEXTO ou + MÍDIA.</div>}

      {ordered.map((layer: Layer) => {
        return (
          <div
            key={layer.id}
            className={`layer-item${layer.id === selectedId ? ' sel' : ''}`}
            onClick={() => onSelect(layer.id)}
          >
            <span className={`tag tag-${layer.type}`}>{TAGS[layer.type] ?? '???'}</span>
            <span className="layer-name">{layer.name}</span>
            <span className="layer-fx">{(layer.effects || []).length}fx</span>

            <button
              className="btn btn-sm btn-coral"
              onClick={e => { e.stopPropagation(); onDelete(layer.id); }}
              title="Excluir layer"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
