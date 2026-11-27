/* Chọn nhánh parser theo biến thể file:
 *   - IFC (ODA sinh từ IFC2x3/IFC4): có marker node 40 10 11 … 72   -> parseIfc
 *   - OdTv (ODA Visualize xuất từ Revit): không có marker trên         -> parseTv */
import { scanLines, scanShells } from './scan';
import { parseIfc, scanIfcNodes } from './parseIfc';
import { parseTv } from './parseTv';
import type { ModelSummary, VsfxModel } from './types';

export function parseRaw(raw: Uint8Array): VsfxModel {
  const shells = scanShells(raw);
  const nodes = scanIfcNodes(raw);
  // Đường gấp khúc (kiểu 05) chỉ nhận cho nhánh OdTv/Revit; nhánh IFC giữ nguyên (không file IFC mẫu nào có).
  if (nodes.length) return parseIfc(raw, shells, nodes);
  return parseTv(raw, [...shells, ...scanLines(raw)].sort((a, b) => a.off - b.off));
}

export function summarize(model: VsfxModel): ModelSummary {
  return {
    format: model.format,
    shellCount: model.shells.filter(s => !s.line).length,
    meshCount: model.instances.reduce((a, i) => a + i.parts.reduce((b, p) => b + p.shells.filter(s => !s.line).length, 0), 0),
    lineCount: model.shells.filter(s => s.line).length,
    instanceCount: model.instances.length,
    records: model.records,
    transforms: model.transforms,
    inserts: model.inserts,
    skipped: model.skipped,
    unitMM: model.unitMM,
  };
}
