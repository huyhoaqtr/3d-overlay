/* Chọn nhánh parser theo biến thể file:
 *   - IFC (ODA sinh từ IFC2x3/IFC4): có marker node 40 10 11 … 72   -> parseIfc
 *   - OdTv (ODA Visualize xuất từ Revit): không có marker trên         -> parseTv */
import { scanShells } from './scan';
import { parseIfc, scanIfcNodes } from './parseIfc';
import { parseTv } from './parseTv';
import type { ModelSummary, VsfxModel } from './types';

export function parseRaw(raw: Uint8Array): VsfxModel {
  const shells = scanShells(raw);
  const nodes = scanIfcNodes(raw);
  return nodes.length ? parseIfc(raw, shells, nodes) : parseTv(raw, shells);
}

export function summarize(model: VsfxModel): ModelSummary {
  return {
    format: model.format,
    shellCount: model.shells.length,
    meshCount: model.instances.reduce((a, i) => a + i.parts.reduce((b, p) => b + p.shells.length, 0), 0),
    instanceCount: model.instances.length,
    records: model.records,
    transforms: model.transforms,
    inserts: model.inserts,
    skipped: model.skipped,
    unitMM: model.unitMM,
  };
}
