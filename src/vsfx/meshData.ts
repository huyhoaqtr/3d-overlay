/* Dựng lưới (chạy trong worker): triangulate thủ công, áp ma trận instance, gộp theo màu/loại,
 * tính normal và cạnh. Kết quả là các mảng Float32Array thuần để chuyển giao về main thread. */
import * as THREE from 'three';
import { pruneCoplanarEdges } from './edges';
import type { BuildOptions, ChunkKind, MeshChunk, MeshData, Shell, VsfxModel } from './types';

interface Poly {
  outer: number[];
  holes: number[][];
}

/* Triangulate face list (n, i0..in-1; n âm = lỗ) bằng chiếu lên mặt phẳng Newell + ShapeUtils.
 * Lưu cache vào shell (sh.tri, sh.triFace = chỉ số face của từng tam giác để tô màu theo mặt). */
export function triangulateShell(sh: Shell): number[] {
  if (sh.tri) return sh.tri;
  const { verts, faces } = sh, tri: number[] = [], polys: Poly[] = [], triFace: number[] = [];
  let p = 0;
  while (p < faces.length) {
    const c = faces[p], n = Math.abs(c), idx = Array.from(faces.subarray(p + 1, p + 1 + n));
    if (c > 0 || !polys.length) polys.push({ outer: idx, holes: [] });
    else polys[polys.length - 1].holes.push(idx);
    p += 1 + n;
  }
  sh.triFace = triFace;
  const V = (i: number) => new THREE.Vector3(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
  for (let fi = 0; fi < polys.length; fi++) {
    const { outer, holes } = polys[fi], before = tri.length;
    const mark = () => { for (let t = before; t < tri.length; t += 3) triFace.push(fi); };
    if (outer.length === 3 && !holes.length) { tri.push(...outer); mark(); continue; }
    const nrm = new THREE.Vector3();
    for (let i = 0; i < outer.length; i++) {
      const a = V(outer[i]), b = V(outer[(i + 1) % outer.length]);
      nrm.x += (a.y - b.y) * (a.z + b.z); nrm.y += (a.z - b.z) * (a.x + b.x); nrm.z += (a.x - b.x) * (a.y + b.y);
    }
    if (nrm.lengthSq() === 0) continue;
    nrm.normalize();
    const u = new THREE.Vector3(Math.abs(nrm.x) > .9 ? 0 : 1, Math.abs(nrm.x) > .9 ? 1 : 0, 0).cross(nrm).normalize();
    const w = new THREE.Vector3().crossVectors(nrm, u);
    const to2 = (i: number) => { const q = V(i); return new THREE.Vector2(q.dot(u), q.dot(w)); };
    const all = [...outer, ...holes.flat()];
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer.map(to2), holes.map(h => h.map(to2))))
      tri.push(all[a], all[b], all[c]);
    mark();
  }
  return (sh.tri = tri);
}

/* Kính: file không lưu transparency, nên nhận diện theo heuristic:
 * màu xanh (B > R + 40) VÀ tấm mỏng (chiều nhỏ nhất ≤ 30 mm, chiều thứ hai ≥ 200 mm). */
export function isGlass(color: number, sh: Shell, unitMM = 1): boolean {
  const r = color >> 16 & 255, b = color & 255;
  if (!(b > r + 40)) return false;
  const v = sh.verts, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < v.length; k += 3) for (let d = 0; d < 3; d++) { mn[d] = Math.min(mn[d], v[k + d]); mx[d] = Math.max(mx[d], v[k + d]); }
  const ext = mx.map((x, d) => (x - mn[d]) * unitMM).sort((a, c) => a - c);
  return ext[0] <= 30 && ext[1] >= 200;
}

interface Acc {
  kind: ChunkKind;
  color: number;
  opacity: number;
  pos: Float32Array[];
  nor: Float32Array[];
  col: Float32Array[];
  edg: Float32Array[];
  ranges: number[];
  vCount: number;
  eCount: number;
}

const concat = (parts: Float32Array[], total: number): Float32Array => {
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/* Gộp mọi shell cùng vật liệu (loại + màu) của TOÀN model thành một khối lưới, kèm bảng range để biết
 * đoạn nào thuộc entity nào (chọn / ẩn / cô lập). Draw call = số vật liệu, không phụ thuộc số entity
 * (file Revit > 11 000 shell, mp.vsfx 2 389 instance). Triangulate/normal/cạnh vẫn tính theo từng part
 * nên kết quả hình học giống bản trước. */
/** Gán id đối tượng (đơn vị chọn/ẩn) cho từng instance, id cấp theo thứ tự xuất hiện. Một đối tượng = một PHẦN TỬ
 *  trong file: các instance cùng `handle` (IFC: node; Revit: Element ID) gộp chung, như viewer gốc (vd tường + các
 *  INSERT trong cùng node IFC; vách kính Revit gồm nhiều thanh). Instance không có handle thì gộp theo `group`.
 *  Dùng chung cho buildMeshData và inspectEntity để id trên màn hình khớp với dữ liệu trong worker. */
const GENERIC_NAME = /^(tv|\(block\)|OdIfcRepresentationMap)$/;
export function entityIds(instances: VsfxModel['instances']): { idOf: number[]; names: string[]; handles: string[] } {
  const idOf: number[] = [], names: string[] = [], handles: string[] = [], idByKey = new Map<string, number>();
  instances.forEach((ins, i) => {
    const key = ins.handle != null ? `h:${ins.handle}` : ins.group != null ? `g:${ins.group}` : `i:${i}`;
    let id = idByKey.get(key);
    if (id === undefined) {
      idByKey.set(key, id = names.length);
      names.push(ins.name);
      handles.push(ins.handle ?? `#${id}`);
    } else if (GENERIC_NAME.test(names[id]) && !GENERIC_NAME.test(ins.name)) {
      names[id] = ins.name;   // ưu tiên tên entity thật (INSERT thường đứng trước entity chính trong luồng)
    }
    idOf.push(id);
  });
  return { idOf, names, handles };
}

export function buildMeshData(model: VsfxModel, { debugColors, glass: glassOn }: BuildOptions): MeshData {
  const { instances, unitMM } = model;
  const accs = new Map<string, Acc>();
  const v = new THREE.Vector3(), c3 = new THREE.Color();
  const { idOf, names: entities, handles } = entityIds(instances);

  instances.forEach((ins, ii) => {
    const id = idOf[ii];
    ins.parts.forEach(part => {
      const color = debugColors ? new THREE.Color().setHSL((ii * 0.618) % 1, .55, .6).getHex() : (part.color || 0xb0b0b0);
      const buckets: Record<ChunkKind, number[]> = { opaque: [], glass: [], faceCol: [] };
      const fcol: number[] = [];
      const alpha = part.opacity ?? -1;     // ≥ 0: vật liệu trong file có độ đục < 1 (kính, khối trong suốt)
      for (const sh of part.shells) {
        const glass = glassOn && !debugColors && (alpha >= 0 || isGlass(part.color, sh, unitMM));
        const faceColors = debugColors ? null : sh.faceColors;
        const tri = triangulateShell(sh), out = buckets[faceColors ? 'faceCol' : glass ? 'glass' : 'opaque'];
        const triFace = sh.triFace ?? [];
        tri.forEach((vi, k) => {
          v.set(sh.verts[vi * 3], sh.verts[vi * 3 + 1], sh.verts[vi * 3 + 2]).applyMatrix4(ins.M);
          out.push(v.x, v.y, v.z);
          if (faceColors) {
            const fc = faceColors[triFace[(k / 3) | 0]];
            c3.setHex(fc ?? color, THREE.SRGBColorSpace);
            fcol.push(c3.r, c3.g, c3.b);
          }
        });
      }
      for (const kind of ['opaque', 'glass', 'faceCol'] as const) {
        const arr = buckets[kind];
        if (!arr.length) continue;
        const g = new THREE.BufferGeometry();
        const positions = new Float32Array(arr);
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.computeVertexNormals();
        const edgesGeo = new THREE.EdgesGeometry(g, 25);
        const edges = pruneCoplanarEdges(positions, edgesGeo.getAttribute('position').array as Float32Array);
        const op = kind === 'glass' ? alpha : -1;
        const key = kind === 'faceCol' ? kind : `${kind}:${color}:${op}`;
        let acc = accs.get(key);
        if (!acc) accs.set(key, acc = { kind, color: kind === 'faceCol' ? 0 : color, opacity: op, pos: [], nor: [], col: [], edg: [], ranges: [], vCount: 0, eCount: 0 });
        const vN = positions.length / 3, eN = edges.length / 3;
        acc.ranges.push(id, acc.vCount, vN, acc.eCount, eN);
        acc.pos.push(positions);
        acc.nor.push(g.getAttribute('normal').array as Float32Array);
        if (kind === 'faceCol') acc.col.push(new Float32Array(fcol));
        acc.edg.push(edges);
        acc.vCount += vN;
        acc.eCount += eN;
        g.dispose();
        edgesGeo.dispose();
      }
    });
  });

  const chunks: MeshChunk[] = [...accs.values()].map(a => ({
    kind: a.kind,
    color: a.color,
    opacity: a.opacity,
    positions: concat(a.pos, a.vCount * 3),
    normals: concat(a.nor, a.vCount * 3),
    colors: a.kind === 'faceCol' ? concat(a.col, a.vCount * 3) : null,
    edges: concat(a.edg, a.eCount * 3),
    ranges: new Uint32Array(a.ranges),
  }));
  return { chunks, entities, handles };
}

/** Danh sách ArrayBuffer cần chuyển giao (transfer) khi gửi MeshData qua postMessage. */
export function meshDataTransferables(data: MeshData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const c of data.chunks)
    for (const a of [c.positions, c.normals, c.colors, c.edges, c.ranges]) if (a) out.add(a.buffer as ArrayBuffer);
  return [...out];
}
