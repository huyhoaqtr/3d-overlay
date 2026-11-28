/* Worker phụ: dựng lưới cho MỘT LÁT liên tiếp các instance (dựng song song — xem buildParallel trong worker.ts).
 * Nhận bản sao (structured clone) của các instance trong lát + bảng id đối tượng toàn cục; trả MeshData chỉ có `chunks` (chuyển giao, không sao chép). */
import * as THREE from 'three';
import { buildMeshData, meshDataTransferables } from './meshData';
import type { BuildOptions, Instance, MeshData, VsfxModel } from './types';
import type { SliceJob } from './messages';

interface WorkerScope {
  postMessage(message: { id: number; data?: MeshData; error?: string }, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<SliceJob>) => void) | null;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent<SliceJob>) => {
  const j = e.data;
  try {
    // Matrix4 mất prototype khi qua postMessage: dựng lại từ mảng 16 số
    const instances = j.instances.map(i => ({ ...i, M: new THREE.Matrix4().fromArray(i.M) })) as unknown as Instance[];
    const data = buildMeshData({ instances, unitMM: j.unitMM } as unknown as VsfxModel, j.options as BuildOptions, { base: j.base, idOf: j.idOf });
    scope.postMessage({ id: j.id, data }, meshDataTransferables(data));
  } catch (err) {
    scope.postMessage({ id: j.id, error: err instanceof Error ? err.message : String(err) });
  }
};
