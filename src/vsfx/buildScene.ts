/* Main thread: tạo Three.js object từ MeshData (worker đã triangulate, tính normal và cạnh). */
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { RANGE_STRIDE } from './types';
import type { ChunkKind, MeshData } from './types';

// Raycast tăng tốc bằng BVH (mesh chưa có cây thì three tự rơi về duyệt từng tam giác).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const EDGE_COLOR = 0x2a2d33;
/** màu tô sáng cả model khi chọn tên file (overlay) */
const HIGHLIGHT_COLOR = 0xff9800;

/** Tham số hiển thị kính (file không lưu độ trong suốt; chỉnh theo ảnh tham chiếu). */
export const GLASS = {
  /** mức pha màu kính với trắng: 0 = giữ nguyên màu file, 1 = trắng */
  whiteMix: 0,
  /** độ đục: 0 = trong hẳn, 1 = đặc */
  opacity: 0.1,
  /** độ đục của vật liệu kính trong file ứng với `opacity` ở trên (kính Revit 828d89 = 0.35); vật liệu khác
   *  được co giãn theo tỉ lệ, nên chỉnh `opacity` vẫn là nút chỉnh chung */
  fileOpacityRef: 0.35,
  /** cường độ tự phát sáng cùng màu (giữ tông xanh khi nằm trong bóng) */
  emissive: 0,
};

/** Đoạn của một entity trong một batch (đơn vị: đỉnh). */
export interface PartRange {
  entity: number;
  vStart: number;
  vCount: number;
  eStart: number;
  eCount: number;
}

/** Một draw call đục/kính (mesh) + cạnh (lines) của cùng vật liệu, gộp mọi entity. */
export interface Batch {
  kind: ChunkKind;
  /** độ đục vật liệu trong file (−1 = không có); 0 = trong suốt 100% -> không nhận click */
  opacity: number;
  mesh: THREE.Mesh;
  lines: THREE.LineSegments;
  positions: Float32Array;
  edgePositions: Float32Array;
  /** chỉ số tam giác / cạnh; ẩn một đoạn = ghi 0 (suy biến), hiện = ghi lại chính chỉ số */
  vIndex: Uint32Array;
  eIndex: Uint32Array;
  ranges: PartRange[];
  bvh: boolean;
}

export interface EntityPart {
  batch: Batch;
  range: PartRange;
}

/* Scene dựng từ MeshData: số draw call = số vật liệu. Giữ bảng entity -> các đoạn để chọn/ẩn/cô lập
 * mà không đụng tới geometry (chỉ ghi lại index buffer). */
export class SceneModel {
  readonly group = new THREE.Group();
  readonly batches: Batch[] = [];
  readonly entityNames: string[];
  /** handle trong file của từng đối tượng ('0x245'…) — ID hiển thị */
  readonly entityHandles: string[];
  readonly parts = new Map<number, EntityPart[]>();
  private hidden = new Set<number>();
  private warmTimer: number | null = null;
  private disposed = false;

  constructor(data: MeshData) {
    this.entityNames = data.entities;
    this.entityHandles = data.handles;
    const mats = new Map<string, THREE.Material>();
    const edgeMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
    const glassEdge = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: .35 });
    this.mats = [edgeMat, glassEdge];

    // Đường gấp khúc (kiểu 05): vẽ bằng màu riêng của file, không theo màu cạnh chung
    const wireMats = new Map<number, THREE.LineBasicMaterial>();
    const wireMat = (color: number) => {
      let m = wireMats.get(color);
      if (!m) { m = new THREE.LineBasicMaterial({ color }); wireMats.set(color, m); this.mats.push(m); }
      return m;
    };

    const getMat = (kind: string, color: number, opacity: number): THREE.Material => {
      const key = kind === 'faceCol' ? kind : `${kind}:${color}:${opacity}`;
      let m = mats.get(key);
      if (!m) {
        if (kind === 'glass') {
          // Kính xanh nhạt bán trong suốt: giữ tông màu của file (pha một ít trắng), thêm emissive
          // cùng màu để kính không bị xám khi nằm trong bóng; opacity < 1 -> vẫn lờ mờ thấy bên trong.
          const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), GLASS.whiteMix);
          m = new THREE.MeshStandardMaterial({
            color: tint, emissive: tint.clone().multiplyScalar(GLASS.emissive), side: THREE.DoubleSide,
            transparent: true, opacity: opacity >= 0 ? Math.min(1, GLASS.opacity * opacity / GLASS.fileOpacityRef) : GLASS.opacity, roughness: .3, metalness: 0, depthWrite: false,
          });
        } else
          m = new THREE.MeshStandardMaterial({
            ...(kind === 'faceCol' ? { vertexColors: true, roughness: .9 } : { color, roughness: .85 }),
            side: THREE.DoubleSide, flatShading: true, metalness: 0,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
          });
        mats.set(key, m);
        this.mats.push(m);
      }
      return m;
    };

    for (const c of data.chunks) {
      const g = new THREE.BufferGeometry();
      const vIndex = iota(c.positions.length / 3);
      g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
      if (c.colors) g.setAttribute('color', new THREE.BufferAttribute(c.colors, 3));
      g.setIndex(new THREE.BufferAttribute(vIndex, 1));
      const wire = c.kind === 'wire';
      if (!wire) g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, wire ? edgeMat : getMat(c.kind, c.color, c.opacity));
      if (c.kind === 'glass') mesh.renderOrder = 1;
      if (wire) mesh.visible = false;      // không có mặt, chỉ có đoạn thẳng

      const eIndex = iota(c.edges.length / 3);
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(c.edges, 3));
      eg.setIndex(new THREE.BufferAttribute(eIndex, 1));
      eg.computeBoundingSphere();
      const lines = new THREE.LineSegments(eg, wire ? wireMat(c.color) : c.kind === 'glass' ? glassEdge : edgeMat);
      lines.name = 'edges';
      if (!wire) lines.raycast = () => {};        // chỉ chọn theo mặt, không theo cạnh (đường dữ liệu kiểu 05 thì chọn được)

      const ranges: PartRange[] = [];
      for (let k = 0; k < c.ranges.length; k += RANGE_STRIDE)
        ranges.push({ entity: c.ranges[k], vStart: c.ranges[k + 1], vCount: c.ranges[k + 2], eStart: c.ranges[k + 3], eCount: c.ranges[k + 4] });

      const batch: Batch = { kind: c.kind, opacity: c.opacity, mesh, lines, positions: c.positions, edgePositions: c.edges, vIndex, eIndex, ranges, bvh: false };
      for (const range of ranges) {
        const list = this.parts.get(range.entity);
        if (list) list.push({ batch, range }); else this.parts.set(range.entity, [{ batch, range }]);
      }
      this.batches.push(batch);
      this.group.add(mesh, lines);
    }
    // Model đứng yên so với root: không cần cập nhật ma trận mỗi khung hình
    this.group.traverse(o => { o.matrixAutoUpdate = false; });
  }

  private mats: THREE.Material[] = [];
  private highlighted = false;
  private saved = new Map<THREE.Material, THREE.Color>();

  /** Tô sáng cả model (overlay: chọn tên file). Chỉnh trực tiếp vật liệu riêng của model này: mặt pha phát sáng cam,
   *  cạnh đổi màu cam; tắt thì trả lại màu cũ. Không tạo thêm geometry nên dùng được cả với model rất lớn. */
  setHighlight(on: boolean) {
    if (on === this.highlighted) return;
    this.highlighted = on;
    const hl = new THREE.Color(HIGHLIGHT_COLOR);
    for (const m of this.mats) {
      const target = m instanceof THREE.MeshStandardMaterial ? m.emissive : m instanceof THREE.LineBasicMaterial ? m.color : null;
      if (!target) continue;
      if (on) {
        this.saved.set(m, target.clone());
        if (m instanceof THREE.MeshStandardMaterial) target.lerp(hl, 0.55); else target.copy(hl);
      } else {
        const c = this.saved.get(m);
        if (c) target.copy(c);
      }
    }
    if (!on) this.saved.clear();
  }

  setEdgesVisible(visible: boolean) {
    for (const b of this.batches) if (b.kind !== 'wire') b.lines.visible = visible;   // đường dữ liệu (kiểu 05) không phải cạnh
  }

  /** Entity chứa tam giác `faceIndex` của batch (tìm nhị phân theo vStart). */
  entityAt(batch: Batch, faceIndex: number): number | null {
    const v = faceIndex * 3, r = batch.ranges;
    let lo = 0, hi = r.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (v < r[mid].vStart) hi = mid - 1;
      else if (v >= r[mid].vStart + r[mid].vCount) lo = mid + 1;
      else return r[mid].entity;
    }
    return null;
  }

  /** Entity chứa đoạn thẳng `edgeIndex` (vị trí trong index buffer cạnh) của batch 'wire' (tìm nhị phân theo eStart). */
  entityAtEdge(batch: Batch, edgeIndex: number): number | null {
    const r = batch.ranges;
    let lo = 0, hi = r.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (edgeIndex < r[mid].eStart) hi = mid - 1;
      else if (edgeIndex >= r[mid].eStart + r[mid].eCount) lo = mid + 1;
      else return r[mid].entity;
    }
    return null;
  }

  isHidden(entity: number): boolean {
    return this.hidden.has(entity);
  }

  get hasHidden(): boolean {
    return this.hidden.size > 0;
  }

  get entityCount(): number {
    return this.entityNames.length;
  }

  private mask(entity: number, visible: boolean) {
    for (const { batch, range } of this.parts.get(entity) ?? []) {
      const { vIndex, eIndex } = batch;
      for (let i = range.vStart, e = range.vStart + range.vCount; i < e; i++) vIndex[i] = visible ? i : 0;
      for (let i = range.eStart, e = range.eStart + range.eCount; i < e; i++) eIndex[i] = visible ? i : 0;
      batch.mesh.geometry.index!.needsUpdate = true;
      batch.lines.geometry.index!.needsUpdate = true;
    }
  }

  setVisible(entity: number, visible: boolean) {
    if (visible === !this.hidden.has(entity)) return;
    this.mask(entity, visible);
    if (visible) this.hidden.delete(entity); else this.hidden.add(entity);
  }

  hide(entities: Iterable<number>) {
    for (const e of entities) this.setVisible(e, false);
  }

  /** Chỉ giữ lại các entity này, ẩn mọi entity khác. */
  isolate(keep: ReadonlySet<number>) {
    for (const id of this.parts.keys()) this.setVisible(id, keep.has(id));
  }

  showAll() {
    for (const id of [...this.hidden]) this.setVisible(id, true);
  }

  /** Dựng BVH (indirect: không đảo index buffer, nên bảng range vẫn đúng) cho batch chưa có. */
  private buildBvh(b: Batch) {
    if (b.bvh || b.kind === 'wire') return;
    (b.mesh.geometry as THREE.BufferGeometry & { computeBoundsTree(o?: object): void }).computeBoundsTree({ indirect: true });
    b.bvh = true;
  }

  /** Bảo đảm mọi batch đã có BVH trước khi raycast. */
  ensureBvh() {
    this.batches.forEach(b => this.buildBvh(b));
  }

  /** Dựng BVH dần lúc rảnh (mỗi batch một lần) để lần click đầu không bị khựng. */
  warmBvh() {
    const queue = this.batches.filter(b => !b.bvh);
    const step = () => {
      this.warmTimer = null;
      const b = queue.shift();
      if (!b || this.disposed) return;
      this.buildBvh(b);
      this.warmTimer = window.setTimeout(step, 0);
    };
    this.warmTimer = window.setTimeout(step, 200);
  }

  dispose() {
    this.disposed = true;
    if (this.warmTimer != null) clearTimeout(this.warmTimer);
    for (const b of this.batches) {
      (b.mesh.geometry as THREE.BufferGeometry & { disposeBoundsTree(): void }).disposeBoundsTree();
      b.mesh.geometry.dispose();
      b.lines.geometry.dispose();
    }
    this.mats.forEach(m => m.dispose());
    this.group.clear();
  }
}

function iota(n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}
