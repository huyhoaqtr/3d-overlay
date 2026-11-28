/* Web Worker: giải nén + parse .vsfx và dựng lưới, để main thread (UI, render) không bị chặn.
 * Model đầy đủ (shell, ma trận…) ở lại trong worker; main thread chỉ nhận tóm tắt và MeshData
 * (các Float32Array được chuyển giao, không sao chép). */
import { readStream } from './container';
import { parseRaw, summarize } from './parse';
import { buildMeshData, entityIds, meshDataTransferables, mergeMeshData } from './meshData';
import type { SliceJob, WorkerRequest, WorkerResponse } from './messages';
import type { BuildOptions, MeshData, VsfxModel } from './types';

// Kiểu tối thiểu cho phạm vi worker (lib "WebWorker" xung đột với lib "DOM" trong cùng tsconfig).
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let model: VsfxModel | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

/* Dựng lưới SONG SONG cho model lớn (file_14: 79 000 instance, 7.7 triệu tam giác, ~22 s tuần tự): chia danh sách instance thành các lát liên tiếp có tổng số đỉnh gần bằng nhau,
 * giao lát 1…H cho worker phụ (buildWorker.ts), worker này dựng lát 0, rồi ghép theo thứ tự (mergeMeshData) — kết quả giống từng số với dựng tuần tự.
 * Worker phụ giữ lại giữa các lần dựng (đổi kính/màu debug dựng lại không phải khởi động lại). Lỗi bất kỳ -> trả null để dựng tuần tự như cũ. */
interface SliceReply { id: number; data?: MeshData; error?: string }
const helpers: Worker[] = [];
let jobId = 0;
const PARALLEL_MIN_VERTS = 400_000, PARALLEL_MIN_INSTANCES = 1000;

const modelCosts = (m: VsfxModel) => m.instances.map(i => i.parts.reduce((a, p) => a + p.shells.reduce((b, s) => b + s.verts.length / 3, 0), 0));

function dropHelpers() { for (const h of helpers) h.terminate(); helpers.length = 0; }

async function buildParallel(m: VsfxModel, options: BuildOptions, costs: number[]): Promise<MeshData | null> {
  const cores = (self as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  const nHelpers = Math.max(0, Math.min(7, cores - 2));   // chừa 1 lõi cho main thread/UI, 1 cho chính worker này
  if (nHelpers < 1) return null;
  // Nhiều lát nhỏ hơn số worker (×4) và lấy lát kế tiếp khi rảnh: chi phí thật mỗi instance (lọc cạnh) không tỉ lệ đúng với số đỉnh nên chia đều từ đầu bị lệch (lát chậm nhất 5.5 s so với 2 s)
  const nSlices = Math.min(costs.length, (nHelpers + 1) * 4), total = costs.reduce((a, b) => a + b, 0);
  const bounds = [0];
  let acc = 0, next = 1;
  for (let i = 0; i < costs.length && next < nSlices; i++) {
    acc += costs[i];
    if (acc >= (total * next) / nSlices) { bounds.push(i + 1); next++; }
  }
  bounds.push(costs.length);
  const nS = bounds.length - 1;
  const { idOf, names, handles } = entityIds(m.instances);

  while (helpers.length < nHelpers) helpers.push(new Worker(new URL('./buildWorker.ts', import.meta.url), { type: 'module' }));
  const results: (MeshData | undefined)[] = new Array(nS);
  let nextSlice = 0, outstanding = 0, failed: Error | null = null;
  let finish: () => void = () => {};
  const allDone = new Promise<void>(resolve => { finish = resolve; });
  const takeSlice = () => (failed || nextSlice >= nS ? -1 : nextSlice++);
  const maybeFinish = () => { if (outstanding === 0 && (failed || nextSlice >= nS)) finish(); };

  const dispatch = (h: Worker) => {
    const k = takeSlice();
    if (k < 0) { maybeFinish(); return; }
    const lo = bounds[k], hi = bounds[k + 1], id = ++jobId;
    outstanding++;
    h.onmessage = (e: MessageEvent<SliceReply>) => {
      if (e.data.id !== id) return;
      outstanding--;
      if (e.data.data) { results[k] = e.data.data; dispatch(h); } else { failed = new Error(e.data.error ?? 'worker phụ lỗi'); maybeFinish(); }
    };
    h.onerror = ev => { outstanding--; failed = new Error(ev.message || 'worker phụ lỗi'); maybeFinish(); };
    const job: SliceJob = { id, instances: m.instances.slice(lo, hi).map(i => ({ ...i, M: Array.from(i.M.elements) })), unitMM: m.unitMM, options, base: lo, idOf };
    h.postMessage(job);
  };
  for (const h of helpers) dispatch(h);

  // chính worker này cũng dựng lát (xen kẽ nhường vòng lặp sự kiện để nhận kết quả và giao tiếp lát cho worker phụ vừa rảnh)
  for (;;) {
    const k = takeSlice();
    if (k < 0) break;
    results[k] = buildMeshData({ ...m, instances: m.instances.slice(bounds[k], bounds[k + 1]) }, options, { base: bounds[k], idOf });
    await new Promise<void>(r => setTimeout(r, 0));
  }
  maybeFinish();
  await allDone;
  if (failed) throw failed;
  return mergeMeshData(results as MeshData[], names, handles);
}

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'load') {
      model = null;
      post({ type: 'progress', id: req.id, stage: 'decompress' });
      const raw = await readStream(req.buffer);
      post({ type: 'progress', id: req.id, stage: 'parse' });
      model = parseRaw(raw);
      post({ type: 'loaded', id: req.id, summary: summarize(model) });
    } else {
      if (!model) throw new Error('Chưa có model để dựng lưới');
      post({ type: 'progress', id: req.id, stage: 'mesh' });
      let data: MeshData | null = null;
      if (!model.sheet && !model.plan && model.instances.length >= PARALLEL_MIN_INSTANCES) {
        const costs = modelCosts(model);
        if (costs.reduce((a, b) => a + b, 0) >= PARALLEL_MIN_VERTS) {
          try { data = await buildParallel(model, req.options, costs); } catch (err) { console.warn('Dựng song song lỗi, dựng tuần tự:', err); dropHelpers(); data = null; }
        }
      }
      if (!data) data = buildMeshData(model, req.options);
      post({ type: 'built', id: req.id, data }, meshDataTransferables(data));
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
