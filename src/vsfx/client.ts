/* Main thread: giao diện Promise cho worker parse .vsfx.
 *  - load(): chuyển giao ArrayBuffer cho worker (không sao chép). Nếu đang có lần load khác,
 *    worker cũ bị terminate để bắt đầu ngay (yêu cầu cũ bị reject bằng AbortedError).
 *  - build(): dựng lưới từ model worker đang giữ (dùng lại khi đổi tùy chọn hiển thị). */
import type { WorkerRequest, WorkerResponse } from './messages';
import type { BuildOptions, LoadStage, MeshData, ModelSummary } from './types';

export class AbortedError extends Error {
  constructor() {
    super('Đã hủy');
    this.name = 'AbortedError';
  }
}

/** Omit phân phối theo từng nhánh của union (Omit thường chỉ giữ các key chung). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: LoadStage) => void;
}

export class VsfxWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private loadInFlight = false;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
    w.onerror = e => this.failAll(new Error(e.message || 'Worker gặp lỗi'));
    this.worker = w;
    return w;
  }

  private handle(msg: WorkerResponse) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'progress': p.onProgress?.(msg.stage); return;
      case 'loaded': this.loadInFlight = false; p.resolve(msg.summary as never); break;
      case 'built': p.resolve(msg.data as never); break;
      case 'error': this.loadInFlight = false; p.reject(new Error(msg.message)); break;
    }
    this.pending.delete(msg.id);
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.loadInFlight = false;
  }

  private request<T>(msg: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[], onProgress?: (s: LoadStage) => void): Promise<T> {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, onProgress });
      worker.postMessage({ ...msg, id } as WorkerRequest, transfer);
    });
  }

  load(buffer: ArrayBuffer, onProgress?: (stage: LoadStage) => void): Promise<ModelSummary> {
    if (this.loadInFlight) this.terminate();   // hủy lần parse đang chạy, bắt đầu ngay
    this.loadInFlight = true;
    return this.request<ModelSummary>({ type: 'load', buffer }, [buffer], onProgress);
  }

  build(options: BuildOptions, onProgress?: (stage: LoadStage) => void): Promise<MeshData> {
    return this.request<MeshData>({ type: 'build', options }, [], onProgress);
  }

  /** Dừng worker; mọi yêu cầu đang chờ bị reject bằng AbortedError. */
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new AbortedError());
  }
}
