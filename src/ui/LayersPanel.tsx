import type { Layer, LayerType, Project } from '../engine/types.ts';

const TAGS: Record<LayerType, string> = {
  video: 'VID', image: 'IMG', text: 'TXT', audio: 'SOM',
};

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
  // Frente-a-fundo, como todo editor: a faixa mais alta desenha por cima, e
  // dentro de uma faixa vale a ordem do tempo — é como os clipes aparecem
  // enfileirados na timeline.
  const ordered = [...project.layers].sort(
    (a, b) => b.track - a.track || a.start - b.start,
  );

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
            <span className="layer-track" title="Faixa">F{layer.track}</span>

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
