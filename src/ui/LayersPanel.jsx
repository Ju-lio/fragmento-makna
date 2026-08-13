const TAGS = { video: 'VID', image: 'IMG', text: 'TXT' };

export function LayersPanel({ project, selectedId, onSelect, onDelete, onMove }) {
  // Later layers draw on top, so show the list front-to-back like every editor.
  const ordered = [...project.layers].reverse();
  const top = project.layers.length - 1;

  return (
    <div className="layer-list">
      {ordered.length === 0 && <div className="hint">Nenhuma layer. Use + TEXTO ou + MÍDIA.</div>}

      {ordered.map((layer, i) => {
        const index = top - i;   // position in the real draw order
        return (
          <div
            key={layer.id}
            className={`layer-item${layer.id === selectedId ? ' sel' : ''}`}
            onClick={() => onSelect(layer.id)}
          >
            <span className={`tag tag-${layer.type}`}>{TAGS[layer.type] ?? '???'}</span>
            <span className="layer-name">{layer.name}</span>
            <span className="layer-fx">{(layer.effects || []).length}fx</span>

            <span className="layer-order">
              <button
                className="btn btn-sm"
                disabled={index === top}
                onClick={e => { e.stopPropagation(); onMove(layer.id, +1); }}
                title="Trazer pra frente"
              >
                ▲
              </button>
              <button
                className="btn btn-sm"
                disabled={index === 0}
                onClick={e => { e.stopPropagation(); onMove(layer.id, -1); }}
                title="Mandar pra trás"
              >
                ▼
              </button>
            </span>

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
