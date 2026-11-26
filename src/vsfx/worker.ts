/* Web Worker: giải nén + parse .vsfx và dựng lưới, để main thread (UI, render) không bị chặn.
 * Model đầy đủ (shell, ma trận…) ở lại trong worker; main thread chỉ nhận tóm tắt và MeshData
 * (các Float32Array được chuyển giao, không sao chép). */
import { readStream } from './container';
import { parseRaw, summarize } from './parse';
import { buildMeshData, meshDataTransferables } from './meshData';
import type { WorkerRequest, WorkerResponse } from './messages';
import type { VsfxModel } from './types';

// Kiểu tối thiểu cho phạm vi worker (lib "WebWorker" xung đột với lib "DOM" trong cùng tsconfig).
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let model: VsfxModel | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

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
      const data = buildMeshData(model, req.options);
      post({ type: 'built', id: req.id, data }, meshDataTransferables(data));
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
