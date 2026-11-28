/* Web Worker: giải nén + parse .vsfx và dựng lưới, để main thread (UI, render) không bị chặn.
 * Model đầy đủ (shell, ma trận…) ở lại trong worker; main thread chỉ nhận tóm tắt và MeshData
 * (các Float32Array được chuyển giao, không sao chép). */
import { readStream } from './container';
import * as THREE from 'three';
import { parseRaw, summarize } from './parse';
import { parseIfc } from './parseIfc';
import { parseTv } from './parseTv';
import { scanShells } from './scan';
import { isLowMemoryDevice } from './device';
import { buildMeshData, entityIds, meshDataTransferables, mergeMeshData } from './meshData';
import type { ScanJob, ScanResult, ScanTask, SliceJob, WorkerRequest, WorkerResponse } from './messages';
import type { BuildOptions, MeshData, VsfxModel } from './types';

// Kiểu tối thiểu cho phạm vi worker (lib "WebWorker" xung đột với lib "DOM" trong cùng tsconfig).
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let model: VsfxModel | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

/* Phân tích SONG SONG cho file lớn (IFC: file_14 263 MB ~5.4 s tuần tự; OdTv/Revit: file_1 201 MB ~7.3 s): các lượt quét byte độc lập nhau nên chia cho 3 worker phụ (A: node + ma trận ~1.8 s; B: header entity + đơn vị ~1.5 s;
 * C: handle nguồn + bảng extents ~1.9 s) chạy cùng lúc, worker này quét shell; rồi parseIfc dùng kết quả tính sẵn.
 * Luồng nằm trong SharedArrayBuffer (khi trang cô lập chéo nguồn, xem vite.config.ts) thì dùng chung không sao chép; không thì mỗi worker nhận BẢN SAO (3 × kích thước luồng bộ nhớ tạm) —
 * chỉ chấp nhận tới COPY_MAX. Không đủ điều kiện (không phải IFC, luồng quá lớn để sao chép) hoặc lỗi -> trả null để phân tích tuần tự như cũ. */
const COPY_MAX = 320 * 1024 * 1024;
const PARSE_PARALLEL_MIN = 32 * 1024 * 1024;   // dưới ngưỡng này phân tích tuần tự đã nhanh (khởi động worker phụ không đáng)
/** Thiết bị ít RAM: ít worker phụ hơn và không sao chép luồng 263 MB (mỗi worker phụ và mỗi bản sao đều tính vào giới hạn ~1–1.5 GB của tab iOS) — xem device.ts. */
const lowMemory = isLowMemoryDevice();

const scanHelpers: Worker[] = [];
let scanJobId = 0;

function looksLikeIfc(raw: Uint8Array): boolean {
  const lim = Math.min(raw.length - 12, 48 * 1024 * 1024);
  for (let o = raw.indexOf(0x40); o !== -1 && o < lim; o = raw.indexOf(0x40, o + 1))
    if (raw[o + 1] === 0x10 && raw[o + 2] === 0x11 && !raw[o + 3] && !raw[o + 4] && raw[o + 5] === 1 && raw[o + 6] === 1 && !raw[o + 7] && !raw[o + 8] && !raw[o + 9] && (raw[o + 10] === 0x70 || raw[o + 10] === 0x72)) return true;
  return false;
}

/** Mảng phẳng (off + 16 số Matrix4.elements mỗi mục) -> danh sách { off, M }. */
function rehydrateXfs(f: Float64Array): { off: number; M: THREE.Matrix4 }[] {
  const xfs: { off: number; M: THREE.Matrix4 }[] = [];
  for (let i = 0; i + 17 <= f.length; i += 17) xfs.push({ off: f[i], M: new THREE.Matrix4().fromArray(Array.from(f.subarray(i + 1, i + 17))) });
  return xfs;
}

async function parseParallel(raw: Uint8Array): Promise<VsfxModel | null> {
  const shared = typeof SharedArrayBuffer !== 'undefined' && raw.buffer instanceof SharedArrayBuffer;
  if (raw.length < PARSE_PARALLEL_MIN || (!shared && (lowMemory || raw.length > COPY_MAX))) return null;
  const ifc = looksLikeIfc(raw);
  // IFC: 3 nhóm quét. OdTv/Revit (file_1: 13 lượt quét độc lập, ~7.3 s tuần tự): 4 nhóm cân nhau ~1.2–2 s — chữ/đường/vòng tròn; ma trận + tên phần tử + đơn vị; bản ghi + phần tử + màu; vật liệu + dò marker IFC.
  const tasks: ScanTask[] = ifc ? ['nodesXfs', 'entUnit', 'srcExt'] : ['tvText', 'tvXfm', 'tvRecs', 'tvMats'];
  while (scanHelpers.length < tasks.length) scanHelpers.push(new Worker(new URL('./scanWorker.ts', import.meta.url), { type: 'module' }));
  const run = (h: Worker, task: ScanTask) => new Promise<ScanResult>((resolve, reject) => {
    const id = ++scanJobId;
    h.onmessage = (e: MessageEvent<ScanResult>) => { if (e.data.id !== id) return; if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data); };
    h.onerror = ev => reject(new Error(ev.message || 'worker quét lỗi'));
    const job: ScanJob = { id, task, raw };
    h.postMessage(job);
  });
  const pending = tasks.map((t, i) => run(scanHelpers[i], t));
  const shells = scanShells(raw);   // cùng lúc với các nhóm quét ở worker phụ
  const res = await Promise.all(pending);
  if (ifc) {
    const [nx, eu, se] = res;
    if (!nx.nodes || !nx.nodes.length || !nx.xfs) return null;
    return parseIfc(raw, shells, nx.nodes, { xfs: rehydrateXfs(nx.xfs), ents: eu.ents, srcRecs: se.srcRecs, unitMM: eu.unitMM, ext: se.ext });
  }
  const [tx, xm, rc, mt] = res;
  if (!tx.shells || !xm.xfs || !rc.recs || !mt.materials || !mt.matUse) return null;
  if (mt.nodes && mt.nodes.length) return null;   // có marker IFC ngoài 48 MB đầu mà dò nhanh bỏ sót: để parseRaw tuần tự quyết định nhánh
  return parseTv(raw, [...shells, ...tx.shells].sort((a, b) => a.off - b.off), {
    recs: rc.recs, elements: rc.elements, colors: rc.colors, elementNames: xm.elementNames, xfs: rehydrateXfs(xm.xfs), unitMM: xm.unitMM,
    materials: mt.materials, opacity: mt.opacity, matUse: mt.matUse,
  });
}

function dropScanHelpers() { for (const h of scanHelpers) h.terminate(); scanHelpers.length = 0; }

/* Dựng lưới SONG SONG cho model lớn (file_14: 79 000 instance, 7.7 triệu tam giác, ~22 s tuần tự): chia danh sách instance thành các lát liên tiếp có tổng số đỉnh gần bằng nhau,
 * giao cho các worker phụ (buildWorker.ts; worker này chỉ điều phối), rồi ghép theo thứ tự (mergeMeshData) — kết quả giống từng số với dựng tuần tự.
 * Worker phụ giữ lại giữa các lần dựng (đổi kính/màu debug dựng lại không phải khởi động lại). Lỗi bất kỳ -> trả null để dựng tuần tự như cũ. */
interface SliceReply { id: number; data?: MeshData; error?: string }
const helpers: Worker[] = [];
let jobId = 0;
const PARALLEL_MIN_VERTS = 400_000, PARALLEL_MIN_INSTANCES = 1000;

const modelCosts = (m: VsfxModel) => m.instances.map(i => i.parts.reduce((a, p) => a + p.shells.reduce((b, s) => b + s.verts.length / 3, 0), 0));

function dropHelpers() { for (const h of helpers) h.terminate(); helpers.length = 0; }

async function buildParallel(m: VsfxModel, options: BuildOptions, costs: number[]): Promise<MeshData | null> {
  const cores = (self as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  const nHelpers = Math.max(0, Math.min(lowMemory ? 2 : 8, cores - 1));   // chừa 1 lõi cho main thread/UI; worker này chỉ điều phối (không dựng lát) nên luôn phản hồi ngay
  if (nHelpers < (lowMemory ? 1 : 2)) return null;
  // Nhiều lát nhỏ hơn số worker (×6) và lấy lát kế tiếp khi rảnh: chi phí thật mỗi instance (lọc cạnh) không tỉ lệ đúng với số đỉnh nên chia đều từ đầu bị lệch (lát chậm nhất 5.5 s so với 2 s)
  const nSlices = Math.min(costs.length, nHelpers * 6), total = costs.reduce((a, b) => a + b, 0);
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

  // Mỗi worker phụ giữ sẵn tối đa DEPTH lát trong hàng đợi để không phải chờ vòng giao việc kế tiếp (sao chép dữ liệu lát nằm ở worker này)
  const DEPTH = lowMemory ? 1 : 2;
  const jobSlice = new Map<number, number>();
  const dispatch = (h: Worker) => {
    const k = takeSlice();
    if (k < 0) { maybeFinish(); return; }
    const lo = bounds[k], hi = bounds[k + 1], id = ++jobId;
    outstanding++;
    jobSlice.set(id, k);
    const job: SliceJob = { id, instances: m.instances.slice(lo, hi).map(i => ({ ...i, M: Array.from(i.M.elements) })), unitMM: m.unitMM, options, base: lo, idOf };
    h.postMessage(job);
  };
  for (const h of helpers) {
    h.onmessage = (e: MessageEvent<SliceReply>) => {
      const k = jobSlice.get(e.data.id);
      if (k === undefined) return;
      jobSlice.delete(e.data.id);
      outstanding--;
      if (e.data.data) { results[k] = e.data.data; dispatch(h); } else { failed = new Error(e.data.error ?? 'worker phụ lỗi'); maybeFinish(); }
    };
    h.onerror = ev => { outstanding--; failed = new Error(ev.message || 'worker phụ lỗi'); maybeFinish(); };
  }
  for (let d = 0; d < DEPTH; d++) for (const h of helpers) dispatch(h);

  maybeFinish();
  await allDone;
  if (failed) throw failed;
  return mergeMeshData(results as MeshData[], names, handles);
}

let keptBuffer: ArrayBuffer | null = null;

async function loadModel(buffer: ArrayBuffer, id: number): Promise<VsfxModel> {
  const raw = await readStream(buffer);
  post({ type: 'progress', id, stage: 'parse' });
  let parsed: VsfxModel | null = null;
  try { parsed = await parseParallel(raw); } catch (err) { console.warn('Phân tích song song lỗi, phân tích tuần tự:', err); dropScanHelpers(); }
  return parsed ?? parseRaw(raw);
}

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'load') {
      model = null;
      keptBuffer = lowMemory ? req.buffer : null;
      post({ type: 'progress', id: req.id, stage: 'decompress' });
      model = await loadModel(req.buffer, req.id);
      post({ type: 'loaded', id: req.id, summary: summarize(model) });
    } else {
      // Thiết bị ít RAM bỏ model (shell: ~170 MB với file_14) sau khi dựng lưới và chỉ giữ file nén (27 MB): đổi tuỳ chọn hiển thị sẽ phân tích lại (vài giây) thay vì giữ RAM
      if (!model && keptBuffer) model = await loadModel(keptBuffer, req.id);
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
      if (lowMemory && keptBuffer) model = null;
      post({ type: 'built', id: req.id, data }, meshDataTransferables(data));
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
