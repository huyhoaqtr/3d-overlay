import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Viewer, { type ViewLayer, type ViewerHandle } from './components/Viewer';
import ControlPanel, { type LayerView } from './components/ControlPanel';
import { AbortedError, VsfxWorkerClient } from './vsfx';
import type { MeshData, ModelSummary, SelectionInfo, Vec3, ViewOptions } from './vsfx';
import type { LoadStatus } from './components/ControlPanel';

// Các file mẫu đặt trong public/ (Vite phục vụ ở gốc site)
// const SAMPLES = ['revit.vsfx', 'mp.vsfx', 'dont.vsfx', 'school.vsfx'] as const;
const SAMPLES = Object.keys(
  import.meta.glob('/public/*.vsfx', {
    eager: true,
    query: '?url',
    import: 'default',
  })
).map(path => path.split('/').pop()!);

/** Một file đang mở. Overlay = nhiều layer chồng lên nhau; mỗi layer có Web Worker riêng giữ model đầy đủ. */
interface Layer {
  key: number;
  name: string;
  status: LoadStatus;
  summary: ModelSummary | null;
  data: MeshData | null;
  /** worker đang dựng lại lưới (vd sau khi đổi tùy chọn kính) */
  building: boolean;
  visible: boolean;
  /** kích thước (m), Viewer báo sau khi dựng */
  size: Vec3 | null;
}

declare global {
  interface Window {
    /** Hook gỡ lỗi (chỉ ở chế độ dev) */
    __vsfx?: () => { layers: Layer[] };
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fetchSample = (name: string) => async () => {
  const r = await fetch(`${import.meta.env.BASE_URL}${name}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.arrayBuffer();
};

export default function App() {
  const [source, setSource] = useState<string | null>(SAMPLES[0]);   // file mẫu đang làm nền; null = file tự chọn
  const [layers, setLayers] = useState<Layer[]>([]);
  const [highlightKey, setHighlightKey] = useState<number | null>(null);
  const [options, setOptions] = useState<ViewOptions>({ edges: true, light: true, glass: true, debugColors: false, contrast: 1.15 });
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [hasHidden, setHasHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const viewerRef = useRef<ViewerHandle>(null);
  const clients = useRef(new Map<number, VsfxWorkerClient>());
  const nextKey = useRef(0);
  const buildIds = useRef(new Map<number, number>());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const layersRef = useRef(layers);
  layersRef.current = layers;

  const patch = useCallback((key: number, p: Partial<Layer> | ((l: Layer) => Partial<Layer>)) => {
    setLayers(ls => ls.map(l => (l.key === key ? { ...l, ...(typeof p === 'function' ? p(l) : p) } : l)));
  }, []);

  // Dựng lưới cho một layer; bỏ kết quả nếu đã có yêu cầu build mới hơn hoặc layer đã bị gỡ.
  const buildLayer = useCallback((key: number) => {
    const client = clients.current.get(key);
    if (!client) return;
    const id = (buildIds.current.get(key) ?? 0) + 1;
    buildIds.current.set(key, id);
    const current = () => buildIds.current.get(key) === id && clients.current.get(key) === client;
    const { glass, debugColors } = optionsRef.current;
    patch(key, { building: true });
    client.build({ glass, debugColors }, stage => {
      if (current()) patch(key, l => (l.status.state === 'loading' ? { status: { ...l.status, stage } } : {}));
    })
      .then(data => { if (current()) patch(key, l => ({ data, building: false, status: { state: 'ready', name: l.name } })); })
      .catch(e => {
        if (e instanceof AbortedError || !current()) return;
        console.error(e);
        patch(key, l => ({ building: false, status: { state: 'error', name: l.name, message: errorMessage(e) } }));
      });
  }, [patch]);

  /** Mở một file: `replace` = thay toàn bộ (mở file mới), không thì chồng thêm (overlay). */
  const addLayer = useCallback(async (getBuffer: () => Promise<ArrayBuffer>, name: string, replace: boolean) => {
    const key = ++nextKey.current;
    if (replace) {
      for (const c of clients.current.values()) c.terminate();
      clients.current.clear();
      setHighlightKey(null);
    }
    const client = new VsfxWorkerClient();
    clients.current.set(key, client);
    const layer: Layer = {
      key, name, status: { state: 'loading', name, stage: 'decompress' }, summary: null, data: null,
      building: false, visible: true, size: null,
    };
    setLayers(ls => (replace ? [layer] : [...ls, layer]));
    try {
      const buf = await getBuffer();
      if (clients.current.get(key) !== client) return;
      const summary = await client.load(buf, stage => patch(key, { status: { state: 'loading', name, stage } }));
      if (clients.current.get(key) !== client) return;
      patch(key, { summary });
      buildLayer(key);
    } catch (e) {
      if (e instanceof AbortedError || clients.current.get(key) !== client) return;
      console.error(e);
      patch(key, { status: { state: 'error', name, message: errorMessage(e) } });
    }
  }, [patch, buildLayer]);

  const removeLayer = useCallback((key: number) => {
    clients.current.get(key)?.terminate();
    clients.current.delete(key);
    setLayers(ls => ls.filter(l => l.key !== key));
    setHighlightKey(h => (h === key ? null : h));
  }, []);

  // Worker của mọi layer dừng khi App unmount
  useEffect(() => () => { for (const c of clients.current.values()) c.terminate(); clients.current.clear(); }, []);

  // File mẫu ban đầu. (StrictMode ở dev chạy effect 2 lần, lần dọn dẹp đã dừng worker -> lần 2 thay bằng layer mới.)
  useEffect(() => {
    addLayer(fetchSample(SAMPLES[0]), SAMPLES[0], true);
  }, [addLayer]);

  // Đổi tùy chọn ảnh hưởng tới lưới (kính, màu debug) -> dựng lại mọi layer đã parse xong
  const { glass, debugColors } = options;
  const firstOptions = useRef(true);
  useEffect(() => {
    if (firstOptions.current) { firstOptions.current = false; return; }
    for (const l of layersRef.current) if (l.summary) buildLayer(l.key);
  }, [glass, debugColors, buildLayer]);

  const openSample = useCallback((name: string | null) => {
    setSource(name);
    if (name) addLayer(fetchSample(name), name, true);
  }, [addLayer]);
  const openFile = useCallback((file: File) => {
    setSource(null);
    addLayer(() => file.arrayBuffer(), file.name, true);
  }, [addLayer]);
  const addSample = useCallback((name: string) => addLayer(fetchSample(name), name, false), [addLayer]);
  const addFile = useCallback((file: File) => addLayer(() => file.arrayBuffer(), file.name, false), [addLayer]);

  // Kéo thả: thay toàn bộ; giữ Shift khi thả = chồng thêm
  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      if (e.shiftKey) files.forEach(addFile);
      else { openFile(files[0]); files.slice(1).forEach(addFile); }   // nhiều file một lần: file đầu làm nền, còn lại chồng
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [openFile, addFile]);

  useEffect(() => {
    if (import.meta.env.DEV) window.__vsfx = () => ({ layers });
  }, [layers]);

  const viewLayers = useMemo<ViewLayer[]>(() => layers
    .filter(l => l.data && l.summary)
    .map(l => ({ key: l.key, name: l.name, data: l.data!, unitMM: l.summary!.unitMM, visible: l.visible })), [layers]);
  const onLayerSize = useCallback((key: number, size: Vec3) => patch(key, { size }), [patch]);

  const panelLayers = useMemo<LayerView[]>(() => layers.map(l => ({
    key: l.key, name: l.name, status: l.status, summary: l.summary, building: l.building, visible: l.visible, size: l.size,
  })), [layers]);

  return (
    <div className="app">
      <Viewer
        ref={viewerRef}
        layers={viewLayers}
        highlightKey={highlightKey}
        edges={options.edges}
        light={options.light}
        contrast={options.contrast}
        onLayerSize={onLayerSize}
        onSelect={setSelection}
        onHiddenChange={setHasHidden}
      />
      <ControlPanel
        samples={SAMPLES}
        source={source}
        onSourceChange={openSample}
        onFile={openFile}
        onAddSample={addSample}
        onAddFile={addFile}
        layers={panelLayers}
        highlightKey={highlightKey}
        onHighlight={key => setHighlightKey(h => (h === key ? null : key))}
        onToggleVisible={key => patch(key, l => ({ visible: !l.visible }))}
        onRemove={removeLayer}
        options={options}
        onOptionsChange={setOptions}
        selection={selection}
        hasHidden={hasHidden}
        viewer={viewerRef}
      />
      {dragging && <div className="drop">Thả file .vsfx vào đây (giữ Shift để chồng thêm)</div>}
    </div>
  );
}
