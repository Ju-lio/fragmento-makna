export function LayersPanel({ project, selectedId, onSelect, onDelete }) {
  // Topmost layer draws last, so show the list back-to-front like every editor.
  const ordered = [...project.layers].reverse();

  return (
    <div className="layer-list">
      {ordered.length === 0 && <div className="hint">Nenhuma layer. Use + TEXTO acima.</div>}

      {ordered.map(layer => (
        <div
          key={layer.id}
          className={`layer-item${layer.id === selectedId ? ' sel' : ''}`}
          onClick={() => onSelect(layer.id)}
        >
          <span className={`tag${layer.type === 'image' ? ' tag-img' : ''}`}>
            {layer.type === 'image' ? 'IMG' : 'TXT'}
          </span>
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
      ))}
    </div>
  );
}
