/* Worker phụ: chạy MỘT lượt quét byte trên luồng đã giải nén dùng chung (SharedArrayBuffer, không sao chép) — xem parseParallel trong worker.ts.
 * Mỗi lượt quét là hàm thuần của `raw`, kết quả giống hệt khi chạy tuần tự. */
import { scanEntities, scanIfcNodes } from './parseIfc';
import { scanExtents, scanSourceRecords, scanTransforms } from './scan';
import { detectUnitMM } from './units';
import type { ScanJob, ScanResult } from './messages';

interface WorkerScope {
  postMessage(message: ScanResult): void;
  onmessage: ((e: MessageEvent<ScanJob>) => void) | null;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent<ScanJob>) => {
  const { id, task, raw } = e.data;
  try {
    switch (task) {
      case 'nodesXfs': {
        const nodes = scanIfcNodes(raw), xfs: number[] = [];   // mỗi ma trận: off + 16 số (Matrix4.elements)
        if (nodes.length) scanTransforms(raw, nodes[0].off - 2000, (off, M) => { xfs.push(off, ...M.elements); });
        scope.postMessage({ id, task, nodes, xfs: new Float64Array(xfs) });
        break;
      }
      case 'entUnit': scope.postMessage({ id, task, ents: scanEntities(raw), unitMM: detectUnitMM(raw) }); break;
      case 'srcExt': scope.postMessage({ id, task, srcRecs: scanSourceRecords(raw), ext: scanExtents(raw) }); break;
    }
  } catch (err) {
    scope.postMessage({ id, task, error: err instanceof Error ? err.message : String(err) });
  }
};
