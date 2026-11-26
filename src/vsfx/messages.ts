/* Giao thức giữa main thread và worker. Mỗi yêu cầu có id; phản hồi mang lại id đó. */
import type { BuildOptions, LoadStage, MeshData, ModelSummary } from './types';

export type WorkerRequest =
  /** giải nén + parse; model được giữ trong worker cho các lần build sau */
  | { type: 'load'; id: number; buffer: ArrayBuffer }
  /** dựng lưới từ model đang giữ */
  | { type: 'build'; id: number; options: BuildOptions };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: LoadStage }
  | { type: 'loaded'; id: number; summary: ModelSummary }
  | { type: 'built'; id: number; data: MeshData }
  | { type: 'error'; id: number; message: string };
