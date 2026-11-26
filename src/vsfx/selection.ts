/* Chọn entity bằng click: raycast (BVH) lên các batch gộp, tra bảng range để ra entity, rồi vẽ
 * highlight (mặt phủ cam mờ + viền) từ chính dữ liệu của các đoạn đó. Hỗ trợ ẩn / cô lập / hiện lại. */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { SceneModel } from './buildScene';
import type { Vec3 } from './types';

const COLOR = 0xff9800;

export interface SelectionInfo {
  /** chỉ số nội bộ (dùng cho chọn/ẩn và hỏi worker), không phải dữ liệu file */
  id: number;
  /** handle trong file ('0x245'; '#n' nếu không tìm được) — ID hiển thị */
  handle: string;
  name: string;
  triangles: number;
  /** bbox (dài, rộng, cao) theo MÉT, trục file (Z lên) */
  size: Vec3;
  /** tên file chứa đối tượng (overlay nhiều file); Viewer điền */
  file?: string;
}

export interface SelectionCallbacks {
  onSelect: (info: SelectionInfo | null) => void;
  onHiddenChange: (hasHidden: boolean) => void;
  /** yêu cầu vẽ lại (viewer chỉ render khi có thay đổi) */
  invalidate: () => void;
}

export class SelectionController {
  private selected: number | null = null;
  private highlights: THREE.Object3D[] = [];
  private resolution = new THREE.Vector2(1, 1);

  /** @param unitScale số mét của 1 đơn vị file (để báo kích thước theo mét) */
  constructor(private model: SceneModel, private cb: SelectionCallbacks, private unitScale = 1) {}

  get selectedId(): number | null {
    return this.selected;
  }

  setResolution(w: number, h: number) {
    this.resolution.set(w, h);
    for (const o of this.highlights) if ((o as LineSegments2).isLineSegments2) ((o as LineSegments2).material as LineMaterial).resolution.set(w, h);
  }

  /** Giao điểm gần nhất của tia với model này (bỏ đối tượng đang ẩn và mặt trong suốt 100%, vd khối 延焼ライン ở
   *  file_2.vsfx, để còn chọn được vật phía sau). Viewer gọi cho mọi model rồi chọn cái gần nhất (overlay). */
  hitTest(raycaster: THREE.Raycaster): { id: number; distance: number } | null {
    this.model.ensureBvh();
    const pickable = this.model.batches.filter(b => !(b.kind === 'glass' && b.opacity === 0)).map(b => b.mesh);
    for (const h of raycaster.intersectObjects(pickable, false)) {
      const batch = this.model.batches.find(b => b.mesh === h.object);
      if (!batch || h.faceIndex == null) continue;
      const id = this.model.entityAt(batch, h.faceIndex);
      if (id == null || this.model.isHidden(id)) continue;
      return { id, distance: h.distance };
    }
    return null;
  }

  select(id: number | null) {
    if (id === this.selected) return;
    this.selected = id;
    this.rebuildHighlight();
    this.cb.onSelect(id == null ? null : this.info(id));
    this.cb.invalidate();
  }

  hideSelected() {
    if (this.selected == null) return;
    this.model.hide([this.selected]);
    this.select(null);
    this.cb.onHiddenChange(this.model.hasHidden);
  }

  isolateSelected() {
    if (this.selected == null) return;
    this.model.isolate(new Set([this.selected]));
    this.cb.onHiddenChange(this.model.hasHidden);
    this.cb.invalidate();
  }

  showAll() {
    this.model.showAll();
    this.cb.onHiddenChange(false);
    this.cb.invalidate();
  }

  dispose() {
    this.clearHighlight();
  }

  private info(id: number): SelectionInfo {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    let tris = 0;
    for (const { batch, range } of this.model.parts.get(id) ?? []) {
      const p = batch.positions, end = (range.vStart + range.vCount) * 3;
      tris += range.vCount / 3;
      for (let i = range.vStart * 3; i < end; i += 3)
        for (let d = 0; d < 3; d++) { const x = p[i + d]; if (x < mn[d]) mn[d] = x; if (x > mx[d]) mx[d] = x; }
    }
    const raw = this.model.entityNames[id] ?? '';
    return {
      id,
      handle: this.model.entityHandles[id] ?? `#${id}`,
      name: raw.replace(/^Od\w+?::/, '') || `Entity #${id}`,
      triangles: tris,
      size: tris ? [0, 1, 2].map(d => (mx[d] - mn[d]) * this.unitScale) as Vec3 : [0, 0, 0],
    };
  }

  private clearHighlight() {
    for (const o of this.highlights) {
      o.parent?.remove(o);
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.highlights = [];
  }

  private rebuildHighlight() {
    this.clearHighlight();
    if (this.selected == null) return;
    const parts = this.model.parts.get(this.selected) ?? [];
    let vN = 0, eN = 0;
    for (const { range } of parts) { vN += range.vCount; eN += range.eCount; }
    const fill = new Float32Array(vN * 3), edge = new Float32Array(eN * 3);
    let vo = 0, eo = 0;
    for (const { batch, range } of parts) {
      fill.set(batch.positions.subarray(range.vStart * 3, (range.vStart + range.vCount) * 3), vo);
      edge.set(batch.edgePositions.subarray(range.eStart * 3, (range.eStart + range.eCount) * 3), eo);
      vo += range.vCount * 3;
      eo += range.eCount * 3;
    }

    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fill, 3));
    const mesh = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
      color: COLOR, transparent: true, opacity: .35, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    mesh.raycast = () => {};
    mesh.renderOrder = 998;
    this.highlights.push(mesh);

    if (eN) {
      const lg = new LineSegmentsGeometry();
      lg.setPositions(edge);
      // depthTest bật: cạnh bị che (vd mặt đáy khối đường chôn dưới địa hình) không vẽ xuyên lên trên.
      // Không z-fight với mặt vì vật liệu đặc đã có polygonOffset đẩy ra sau.
      const mat = new LineMaterial({ color: COLOR, linewidth: 1, worldUnits: false, depthTest: true, transparent: true });
      mat.resolution.copy(this.resolution);
      const line = new LineSegments2(lg, mat);
      line.raycast = () => {};
      line.renderOrder = 999;
      this.highlights.push(line);
    }
    for (const o of this.highlights) this.model.group.add(o);
  }
}
