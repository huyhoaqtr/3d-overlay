import { useState } from 'react';
import type { RefObject } from 'react';
import { unitLabel } from '../vsfx';
import type { LoadStage, ModelSummary, SelectionInfo, Vec3, ViewOptions } from '../vsfx';
import type { ViewerHandle } from './Viewer';

export type LoadStatus =
  | { state: 'idle' }
  | { state: 'loading'; name: string; stage: LoadStage }
  | { state: 'ready'; name: string }
  | { state: 'error'; name: string; message: string };

/** Thông tin một file đang mở, để hiện trong danh sách overlay. */
export interface LayerView {
  key: number;
  name: string;
  status: LoadStatus;
  summary: ModelSummary | null;
  building: boolean;
  visible: boolean;
  /** kích thước (m) */
  size: Vec3 | null;
}

const STAGE_LABEL: Record<LoadStage, string> = {
  decompress: 'giải nén',
  parse: 'phân tích cấu trúc',
  mesh: 'dựng lưới',
};

const TOGGLES: [Exclude<keyof ViewOptions, 'contrast'>, string][] = [
  ['edges', 'Hiện cạnh'],
  ['light', 'Nền sáng'],
  ['glass', 'Kính trong suốt'],
  ['debugColors', 'Màu theo entity (debug)'],
];

const fmtSize = (s: Vec3, digits = 1) => s.map(v => v.toFixed(digits)).join(' × ') + ' m';

function ModelInfo({ layer }: { layer: LayerView }) {
  const s = layer.summary;
  if (!s) return null;
  return (
    <dl className="info">
      <dt>File</dt><dd>{layer.name}</dd>
      <dt>Định dạng</dt><dd>{s.format}</dd>
      <dt>Hình học</dt><dd>{s.shellCount} shell → {s.meshCount} mesh{s.lineCount > 0 && `, ${s.lineCount} đường`}, {s.instanceCount} entity/instance</dd>
      <dt>Cấu trúc</dt><dd>{s.records} node/bản ghi, {s.transforms} transform, {s.inserts} block INSERT</dd>
      {s.skipped > 0 && <><dt>Ẩn</dt><dd>{s.skipped} shell trong block không được tham chiếu</dd></>}
      {layer.size && (
        <>
          <dt>Kích thước</dt>
          <dd>{fmtSize(layer.size)}<span className="muted"> (đơn vị file: {unitLabel(s.unitMM)})</span></dd>
        </>
      )}
    </dl>
  );
}

function LayerStatus({ layer }: { layer: LayerView }) {
  const st = layer.status;
  if (st.state === 'loading') return <span className="muted">{STAGE_LABEL[st.stage]}…</span>;
  if (st.state === 'error') return <span className="error">lỗi: {st.message}</span>;
  if (layer.building) return <span className="muted">dựng lại lưới…</span>;
  return layer.size ? <span className="muted">{fmtSize(layer.size, 0)}</span> : null;
}

/* Danh sách file đang mở (overlay). Bấm tên = tô sáng cả model của file đó; bấm lại để tắt. */
function LayerList({ layers, highlightKey, onHighlight, onToggleVisible, onRemove }: {
  layers: LayerView[]; highlightKey: number | null;
  onHighlight: (key: number) => void; onToggleVisible: (key: number) => void; onRemove: (key: number) => void;
}) {
  return (
    <ul className="layers">
      {layers.map(l => (
        <li key={l.key} className={l.key === highlightKey ? 'active' : undefined}>
          <input type="checkbox" checked={l.visible} title="Hiện / ẩn file" onChange={() => onToggleVisible(l.key)} />
          <button
            className="name"
            title="Tô sáng cả model của file này"
            disabled={l.status.state !== 'ready'}
            onClick={() => onHighlight(l.key)}
          >{l.name}</button>
          <LayerStatus layer={l} />
          {layers.length > 1 && <button className="remove" title="Gỡ file" onClick={() => onRemove(l.key)}>✕</button>}
        </li>
      ))}
    </ul>
  );
}

function SelectionPanel({ selection, hasHidden, viewer, multi }: {
  selection: SelectionInfo | null; hasHidden: boolean; viewer: RefObject<ViewerHandle>; multi: boolean;
}) {
  return (
    <fieldset className="selection">
      <legend>Chọn</legend>
      {selection ? (
        <>
          <dl className="info">
            {multi && selection.file && <><dt>File</dt><dd>{selection.file}</dd></>}
            <dt>Tên</dt><dd>{selection.name}</dd>
            <dt>Handle</dt><dd>{selection.handle}</dd>
            <dt>Tam giác</dt><dd>{selection.triangles.toLocaleString()}{selection.lines > 0 && ` · ${selection.lines.toLocaleString()} đoạn thẳng`}</dd>
            <dt>Kích thước</dt><dd>{fmtSize(selection.size, 2)}</dd>
          </dl>
          <div className="actions">
            <button onClick={() => viewer.current?.hideSelected()}>Ẩn (H)</button>
            <button onClick={() => viewer.current?.isolateSelected()}>Cô lập (I)</button>
            <button onClick={() => viewer.current?.clearSelection()}>Bỏ chọn (Esc)</button>
          </div>
        </>
      ) : <p className="muted">Bấm vào model để chọn một đối tượng.</p>}
      {hasHidden && <div className="actions"><button onClick={() => viewer.current?.showAll()}>Hiện tất cả (Shift+H)</button></div>}
    </fieldset>
  );
}

interface Props {
  samples: readonly string[];
  /** file mẫu đang làm nền; null = file tự chọn */
  source: string | null;
  onSourceChange: (source: string | null) => void;
  onFile: (file: File) => void;
  onAddSample: (name: string) => void;
  onAddFile: (file: File) => void;
  layers: LayerView[];
  highlightKey: number | null;
  onHighlight: (key: number) => void;
  onToggleVisible: (key: number) => void;
  onRemove: (key: number) => void;
  options: ViewOptions;
  onOptionsChange: (options: ViewOptions) => void;
  selection: SelectionInfo | null;
  hasHidden: boolean;
  viewer: RefObject<ViewerHandle>;
}

export default function ControlPanel({
  samples, source, onSourceChange, onFile, onAddSample, onAddFile, layers, highlightKey, onHighlight, onToggleVisible,
  onRemove, options, onOptionsChange, selection, hasHidden, viewer,
}: Props) {
  const [open, setOpen] = useState(false);   // mặc định thu gọn
  const anyReady = layers.some(l => l.status.state === 'ready');
  // thông tin chi tiết: file đang tô sáng, không thì file đầu tiên
  const detail = layers.find(l => l.key === highlightKey) ?? layers[0];
  return (
    <aside className={open ? 'panel' : 'panel collapsed'}>
      <button type="button" className="panel-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="chev">{open ? '▾' : '▸'}</span> VSFX viewer
      </button>
      {open && <>

      <label className="row">
        File mẫu:{' '}
        <select value={source ?? ''} onChange={e => onSourceChange(e.target.value || null)}>
          {source == null && <option value="">(file tự chọn)</option>}
          {samples.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="row">
        Mở file khác:{' '}
        <input type="file" accept=".vsfx" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      </label>

      <fieldset className="overlay">
        <legend>Overlay — các file đang mở</legend>
        <LayerList layers={layers} highlightKey={highlightKey} onHighlight={onHighlight} onToggleVisible={onToggleVisible} onRemove={onRemove} />
        <label className="row">
          Chồng thêm file mẫu:{' '}
          <select value="" onChange={e => { if (e.target.value) onAddSample(e.target.value); }}>
            <option value="">— chọn —</option>
            {samples.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="row">
          Chồng thêm file:{' '}
          <input type="file" accept=".vsfx" multiple onChange={e => { [...(e.target.files ?? [])].forEach(onAddFile); e.target.value = ''; }} />
        </label>
        <p className="hint">Bấm tên file để tô sáng cả model của file đó. Các file chồng theo toạ độ gốc của dự án, quy về mét.</p>
      </fieldset>

      {detail && <ModelInfo layer={detail} />}

      <fieldset>
        {TOGGLES.map(([key, label]) => (
          <label key={key} className="row">
            <input type="checkbox" checked={options[key]} onChange={e => onOptionsChange({ ...options, [key]: e.target.checked })} />{' '}
            {label}
          </label>
        ))}
        <label className="row">
          Tương phản: {options.contrast.toFixed(2)}{' '}
          <input
            type="range" min={0.6} max={1.8} step={0.05} value={options.contrast}
            onChange={e => onOptionsChange({ ...options, contrast: Number(e.target.value) })}
            onDoubleClick={() => onOptionsChange({ ...options, contrast: 1 })}
            title="Nhấp đúp để về mặc định"
          />
        </label>
      </fieldset>
      {anyReady && <SelectionPanel selection={selection} hasHidden={hasHidden} viewer={viewer} multi={layers.length > 1} />}
      <p className="hint">Kéo thả file .vsfx vào cửa sổ để mở (giữ Shift để chồng thêm). Phân tích file chạy trong Web Worker.</p>
      </>}
    </aside>
  );
}
