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

/** Việc giao cho worker phụ dựng một lát instance (dựng lưới song song). M = 16 số của Matrix4 (mất prototype khi sao chép). */
export interface SliceJob {
  id: number;
  instances: (Omit<import('./types').Instance, 'M'> & { M: number[] })[];
  unitMM: number;
  options: BuildOptions;
  base: number;
  idOf: number[];
}

/** Lượt quét giao cho worker phụ khi phân tích song song (raw nằm trong SharedArrayBuffer dùng chung). */
export type ScanTask = 'nodesXfs' | 'entUnit' | 'srcExt';
export interface ScanJob { id: number; task: ScanTask; raw: Uint8Array }
export interface ScanResult {
  id: number;
  task: ScanTask;
  error?: string;
  nodes?: import('./parseIfc').IfcNode[];
  xfs?: Float64Array;
  ents?: import('./parseIfc').Entity[];
  srcRecs?: { o: number; id: number }[];
  unitMM?: number | null;
  ext?: { h: number; bb: number[] }[];
}
