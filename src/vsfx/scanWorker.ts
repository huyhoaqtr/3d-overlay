/* Worker phụ: chạy MỘT lượt quét byte trên luồng đã giải nén dùng chung (SharedArrayBuffer, không sao chép) — xem parseParallel trong worker.ts.
 * Mỗi lượt quét là hàm thuần của `raw`, kết quả giống hệt khi chạy tuần tự. */
import { scanEntities, scanIfcNodes } from './parseIfc';
import { scanCircles, scanExtents, scanLines, scanSourceRecords, scanTexts, scanTransforms } from './scan';
import { scanColors, scanElementNames, scanElements, scanMaterials, scanMaterialUse, scanRecords } from './parseTv';
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
      // --- nhánh OdTv/Revit (các lượt quét độc lập của parse.ts + parseTv.ts) ---
      case 'tvText': {   // chữ -> đường (biến thể lenient chỉ khi file có ≥ 50 chữ) -> vòng tròn: ~2 s
        const texts = scanTexts(raw);
        scope.postMessage({ id, task, shells: [...scanLines(raw, texts.length >= 50), ...scanCircles(raw), ...texts] });
        break;
      }
      case 'tvXfm': {    // ma trận (từ 0) + tên phần tử + đơn vị: ~2 s
        const xfs: number[] = [];
        scanTransforms(raw, 0, (off, M) => { xfs.push(off, ...M.elements); });
        scope.postMessage({ id, task, xfs: new Float64Array(xfs), elementNames: scanElementNames(raw), unitMM: detectUnitMM(raw) });
        break;
      }
      case 'tvRecs': scope.postMessage({ id, task, recs: scanRecords(raw), elements: scanElements(raw), colors: scanColors(raw) }); break;
      case 'tvMats': {   // vật liệu + độ đục + vật liệu dùng; thêm dò marker IFC để xác nhận nhánh
        const opacity = new Map<number, number>(), materials = scanMaterials(raw, opacity);
        scope.postMessage({ id, task, nodes: scanIfcNodes(raw), materials, opacity, matUse: scanMaterialUse(raw, materials, opacity) });
        break;
      }
      case 'srcExt': scope.postMessage({ id, task, srcRecs: scanSourceRecords(raw), ext: scanExtents(raw) }); break;
    }
  } catch (err) {
    scope.postMessage({ id, task, error: err instanceof Error ? err.message : String(err) });
  }
};
