/* Dựng lưới (chạy trong worker): triangulate thủ công, áp ma trận instance, gộp theo màu/loại,
 * tính normal và cạnh. Kết quả là các mảng Float32Array thuần để chuyển giao về main thread. */
import * as THREE from 'three';
import { edgesFromTriangles, pruneCoplanarEdgesFast } from './edges';
import type { BuildOptions, ChunkKind, MeshChunk, MeshData, SheetView, Shell, TextItem, VsfxModel } from './types';

/** Viewport: ma trận mô hình -> giấy (nhìn theo +Y từ phía nam: X→x, Z→y, tỉ lệ s, dời (a, b));
 *  z' = −kz·(Y − y0) để vật gần camera (Y nhỏ) đứng trên khi nhìn từ trên xuống (đúng che khuất bằng depth test). */
function viewMatrix(v: SheetView, M: THREE.Matrix4): THREE.Matrix4 {
  const { s, a, b, y0 } = v;
  // độ sâu nén mạnh (kz ≪ s): mặt/đường vẫn che nhau đúng theo depth test nhưng nằm gần như phẳng — camera bản vẽ là phối cảnh nên
  // nếu để z' = −s·Y thì tấm địa hình dài vài chục ft lệch hẳn ra ngoài khung khi nhìn xiên.
  const kz = s * 0.02;
  if (v.plan) return new THREE.Matrix4().set(s, 0, 0, a,  0, s, 0, b,  0, 0, kz, -kz * y0,  0, 0, 0, 1).multiply(M);   // mặt bằng: X,Y → giấy, Z cao = gần camera
  return new THREE.Matrix4().set(s, 0, 0, a,  0, 0, s, b,  0, -kz, 0, kz * y0,  0, 0, 0, 1).multiply(M);
}

/** Chú thích của view (đầu level, vòng tròn lưới, chữ…) có kích thước tính theo TỈ LỆ IN (cao chữ 0.0098 ft = 3 mm giấy): chỉ VỊ TRÍ được chiếu và
 *  nhân tỉ lệ s, còn hình dạng giữ nguyên kích thước giấy. (Nhân s cho cả hình thì chữ và vòng tròn nhỏ đi 100 lần.) */
function annMatrix(v: SheetView, M: THREE.Matrix4): THREE.Matrix4 {
  const { s, a, b, y0 } = v, kz = s * 0.02, e = M.elements;
  const lin = M.clone(); lin.setPosition(0, 0, 0);
  if (v.plan) return new THREE.Matrix4().set(1, 0, 0, 0,  0, 1, 0, 0,  0, 0, kz / s, 0,  0, 0, 0, 1).multiply(lin).setPosition(a + s * e[12], b + s * e[13], kz * (e[14] - y0));
  const A = new THREE.Matrix4().set(1, 0, 0, 0,  0, 0, 1, 0,  0, -kz / s, 0, 0,  0, 0, 0, 1).multiply(lin);
  return A.setPosition(a + s * e[12], b + s * e[14], -kz * (e[13] - y0));
}

/** Shell/đường có kích thước local < 0.5 ft là hình tính theo tỉ lệ in (xem annMatrix). */
function isPaperSizedShell(sh: Shell): boolean {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k + 2 < sh.verts.length; k += 3) for (let d = 0; d < 3; d++) { const x = sh.verts[k + d]; if (x < mn[d]) mn[d] = x; if (x > mx[d]) mx[d] = x; }
  return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) < 0.5;
}

/** Cắt đa giác (toạ độ giấy x, y; z nội suy) theo khung chữ nhật — Sutherland–Hodgman. */
function clipPoly(pts: number[][], [x0, y0, x1, y1]: [number, number, number, number]): number[][] {
  const sides: [number, number, number][] = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]];   // trục, giá trị, hướng trong
  let poly = pts;
  for (const [ax, val, dir] of sides) {
    const next: number[][] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const pin = (p[ax] - val) * dir >= 0, qin = (q[ax] - val) * dir >= 0;
      if (pin) next.push(p);
      if (pin !== qin) {
        const t = (val - p[ax]) / (q[ax] - p[ax]);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
      }
    }
    poly = next;
    if (!poly.length) break;
  }
  return poly;
}

/** Hatch chấm của sàn (mặt bằng): file KHÔNG lưu hình hatch (chỉ tham chiếu vật liệu/texture ngoài), ảnh gốc tô chấm ngẫu nhiên -> hiệu chỉnh theo ảnh:
 *  rải chấm (đoạn dài 0.0015 ft giấy) ngẫu nhiên có hạt giống cố định trong tam giác sàn (toạ độ mô hình), ~1 chấm mỗi 0.011 × 0.011 ft giấy. */
function stipple(P: number[][], v: SheetView, seed: number, out: number[]) {
  const cell = 0.00012, area = Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])) / 2 * v.s * v.s;
  let st = (seed ^ 0x9e3779b9) >>> 0;
  const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let n = area / cell; n = Math.floor(n) + (rnd() < n - Math.floor(n) ? 1 : 0);
  for (let i = 0; i < n; i++) {
    let u = rnd(), w = rnd();
    if (u + w > 1) { u = 1 - u; w = 1 - w; }
    const x = v.a + v.s * (P[0][0] + u * (P[1][0] - P[0][0]) + w * (P[2][0] - P[0][0])), y = v.b + v.s * (P[0][1] + u * (P[1][1] - P[0][1]) + w * (P[2][1] - P[0][1]));
    const seg = clipSeg([x, y, 0], [x + 0.0015, y, 0], v.crop);
    if (seg) out.push(...seg[0], ...seg[1]);
  }
}

/** Sọc đen dọc của khoảng thông tầng (mặt bằng; hiệu chỉnh theo ảnh — khoảng trống giữa nhà là một tấm ở z = −0.5 ft, 6 tam giác, bbox 24..53 × −40..64):
 *  đường thẳng đứng (theo Y) cách nhau 0.0103 ft giấy, cắt theo tam giác. */
function stripes(P: number[][], v: SheetView, out: number[]) {
  const pitch = 0.0103, xs = P.map(q => v.a + v.s * q[0]);
  for (let px = Math.ceil(Math.min(...xs) / pitch) * pitch; px <= Math.max(...xs); px += pitch) {
    const ys: number[] = [];
    for (let j = 0; j < 3; j++) {
      const p = P[j], q = P[(j + 1) % 3], x0 = v.a + v.s * p[0], x1 = v.a + v.s * q[0];
      if ((x0 <= px) !== (x1 <= px) && x0 !== x1) ys.push(v.b + v.s * (p[1] + (q[1] - p[1]) * ((px - x0) / (x1 - x0))));
    }
    if (ys.length < 2) continue;
    const seg = clipSeg([px, Math.min(...ys), 0], [px, Math.max(...ys), 0], v.crop);
    if (seg) out.push(...seg[0], ...seg[1]);
  }
}

/** Nét gạch–chấm của đường lưới (mặt bằng; hiệu chỉnh theo ảnh gốc): gạch 0.06, hở 0.012, chấm 0.008, hở 0.012 ft giấy; bắt đầu bằng gạch. */
function dashDotSeg(p: number[], q: number[], out: number[]) {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len < 1e-9) return;
  const pat = [0.06, 0.012, 0.008, 0.012], at = (d: number) => { const t = Math.min(1, d / len); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]; };
  let d = 0;
  for (let i = 0; d < len; i++) {
    const l = pat[i % 4];
    if (i % 2 === 0) out.push(...at(d), ...at(d + l));
    d += l;
  }
}

/** Chia đoạn thẳng thành các nét đứt (đơn vị giấy). Bắt đầu bằng một nét. */
function dashSeg(p: number[], q: number[], dash: number, gap: number, out: number[]) {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len <= dash) { out.push(...p, ...q); return; }
  const at = (d: number) => { const t = d / len; return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]; };
  for (let d = 0; d < len; d += dash + gap) out.push(...at(d), ...at(Math.min(len, d + dash)));
}

/** Mặt cắt địa hình của view (hiệu chỉnh theo ảnh gốc — file chỉ có vật liệu texture `strokes_ogs.tif`, không có hình hatch):
 *  tấm địa hình = shell lớn nhất (≥ 100 đỉnh, rộng > 100 ft) trong khoảng instance của view; đáy = shell phẳng rộng > 100 ft thấp nhất.
 *  Đường mặt cắt = giao các tam giác của tấm với mặt phẳng y = y0, trả về các điểm (X, Z) sắp theo X. */
function terrainCut(view: SheetView, instances: VsfxModel['instances']): { pts: number[][]; zb: number } | null {
  let best: { sh: Shell; M: THREE.Matrix4 } | null = null, zb = Infinity;
  for (let i = view.from; i <= view.to; i++) {
    const ins = instances[i];
    if (ins.paper) continue;
    const e = ins.M.elements;
    for (const p of ins.parts) for (const sh of p.shells) {
      if (sh.line || sh.text || sh.circle || sh.verts.length < 24) continue;
      let xlo = Infinity, xhi = -Infinity, zlo = Infinity, zhi = -Infinity;
      for (let k = 0; k + 2 < sh.verts.length; k += 3) {
        const x = e[0] * sh.verts[k] + e[4] * sh.verts[k + 1] + e[8] * sh.verts[k + 2] + e[12];
        const z = e[2] * sh.verts[k] + e[6] * sh.verts[k + 1] + e[10] * sh.verts[k + 2] + e[14];
        if (x < xlo) xlo = x; if (x > xhi) xhi = x; if (z < zlo) zlo = z; if (z > zhi) zhi = z;
      }
      if (xhi - xlo < 100) continue;
      if (zhi - zlo < 1e-3) { if (zlo < zb) zb = zlo; }                                     // đáy phẳng
      else if (!best || sh.verts.length > best.sh.verts.length) best = { sh, M: ins.M };
    }
  }
  if (!best || !(zb < Infinity) || best.sh.verts.length < 300) return null;
  const e = best.M.elements, v = best.sh.verts, tri = triangulateShell(best.sh);
  const W = (i: number) => [
    e[0] * v[i * 3] + e[4] * v[i * 3 + 1] + e[8] * v[i * 3 + 2] + e[12],
    e[1] * v[i * 3] + e[5] * v[i * 3 + 1] + e[9] * v[i * 3 + 2] + e[13],
    e[2] * v[i * 3] + e[6] * v[i * 3 + 1] + e[10] * v[i * 3 + 2] + e[14]];
  const pts: number[][] = [];
  for (let k = 0; k + 2 < tri.length; k += 3) {
    const P = [W(tri[k]), W(tri[k + 1]), W(tri[k + 2])], hit: number[][] = [];
    for (let j = 0; j < 3; j++) {
      const a = P[j], b = P[(j + 1) % 3], da = a[1] - view.y0, db = b[1] - view.y0;
      if ((da <= 0) !== (db <= 0)) { const t = da / (da - db); hit.push([a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t]); }
    }
    if (hit.length === 2) pts.push(hit[0], hit[1]);
  }
  if (pts.length < 4) return null;
  pts.sort((a, b) => a[0] - b[0]);
  return { pts, zb };
}

/** Hatch gạch (đường kẻ) trong vùng giữa mặt cắt địa hình và đáy: các hàng cao `row`, mạch đứng cách `tile`, so le nửa viên theo hàng (đơn vị giấy). */
function hatchSegments(view: SheetView, cut: { pts: number[][]; zb: number }, out: number[]) {
  const { a, b, s, crop } = view, row = 0.0074, tile = 0.0316, X = (x: number) => a + s * x, Y = (z: number) => b + s * z;
  const top = (xp: number): number | null => {       // cao độ giấy của mặt cắt tại xp (nội suy), null nếu ngoài
    const pts = cut.pts;
    let lo = 0, hi = pts.length - 1;
    if (xp < X(pts[0][0]) || xp > X(pts[hi][0])) return null;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (X(pts[mid][0]) <= xp) lo = mid; else hi = mid; }
    const x0 = X(pts[lo][0]), x1 = X(pts[hi][0]);
    const t = x1 > x0 ? (xp - x0) / (x1 - x0) : 0;
    return Y(pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t);
  };
  const yb = Y(cut.zb), xmin = Math.max(crop[0], X(cut.pts[0][0])), xmax = Math.min(crop[2], X(cut.pts[cut.pts.length - 1][0]));
  const seg = (x0: number, y0: number, x1: number, y1: number) => out.push(x0, y0, 0, x1, y1, 0);
  for (let r = 0, y = yb; y < crop[3]; r++, y += row) {
    const y1 = y + row;
    // các đoạn x mà cả hàng nằm dưới mặt cắt (đủ chiều cao hàng): lấy mẫu mịn 0.003 ft
    let runStart: number | null = null;
    for (let x = xmin; x <= xmax + 1e-9; x += 0.003) {
      const t = top(x), ok = t !== null && t >= y1 && y >= crop[1];
      if (ok && runStart === null) runStart = x;
      if ((!ok || x + 0.003 > xmax) && runStart !== null) {
        const x1 = ok ? x : x - 0.003;
        seg(runStart, y, x1, y); seg(runStart, y1, x1, y1);
        const off = (r % 2) * tile / 2;
        for (let xj = Math.ceil((runStart - off) / tile) * tile + off; xj <= x1; xj += tile) if (xj >= runStart) seg(xj, y, xj, y1);
        runStart = null;
      }
    }
  }
  // đường mặt cắt (trên) và đường đáy
  for (let i = 0; i + 1 < cut.pts.length; i++) {
    const x0 = X(cut.pts[i][0]), x1 = X(cut.pts[i + 1][0]);
    if (x1 < crop[0] || x0 > crop[2]) continue;
    seg(x0, Y(cut.pts[i][1]), x1, Y(cut.pts[i + 1][1]));
  }
  seg(xmin, yb, xmax, yb);
}

/** Cắt đoạn thẳng theo khung (Liang–Barsky); trả null nếu nằm ngoài. */
function clipSeg(p: number[], q: number[], [x0, y0, x1, y1]: [number, number, number, number]): number[][] | null {
  let t0 = 0, t1 = 1;
  const d = [q[0] - p[0], q[1] - p[1]];
  const chk = (pp: number, qq: number) => {
    if (pp === 0) return qq >= 0;
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!chk(-d[0], p[0] - x0) || !chk(d[0], x1 - p[0]) || !chk(-d[1], p[1] - y0) || !chk(d[1], y1 - p[1])) return null;
  const at = (t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  return [at(t0), at(t1)];
}

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
/** Cạnh của lưới tam giác rời = EdgesGeometry (góc 25°) rồi lọc cạnh thừa do T-junction; kết quả giống từng số với bản dùng THREE.EdgesGeometry + pruneCoplanarEdges (đã so trên hàng nghìn shell). */
export function edgesPruned(pos: Float32Array): Float32Array {
  return pruneCoplanarEdgesFast(pos, edgesFromTriangles(pos, 25).all);
}

export function isGlass(color: number, sh: Shell, unitMM = 1): boolean {
  const r = color >> 16 & 255, g = color >> 8 & 255, b = color & 255;
  // xanh rõ (B > R + 40), hoặc kính nhạt ngả cyan (G, B đều > R: fbffff của mặt bàn kính #110 trong file_13, dae3e0 — gần trắng nên B − R chỉ 4–6)
  if (!(b > r + 40 || (r >= 0xd0 && b > r && g > r))) return false;   // kính nhạt: chỉ khi RẤT sáng (R ≥ d0), để các tấm xám-xanh thường (96aaaf…) không bị coi là kính
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

/** `slice`: dựng lưới cho MỘT LÁT liên tiếp của danh sách instance (dựng song song nhiều worker): `base` = chỉ số toàn cục của instance đầu lát, `idOf` = bảng id đối tượng TOÀN CỤC
 *  (tính một lần từ cả danh sách instance). Chỉ dùng cho model thường (không phải bản vẽ). */
export function buildMeshData(model: VsfxModel, { debugColors, glass: glassOn, noEdges }: BuildOptions, slice?: { base: number; idOf: number[] }): MeshData {
  const { instances, unitMM } = model;
  const accs = new Map<string, Acc>();
  const v = new THREE.Vector3(), c3 = new THREE.Color();
  const { idOf, names: entities, handles } = slice ? { idOf: slice.idOf, names: [] as string[], handles: [] as string[] } : entityIds(instances);
  const base = slice?.base ?? 0;
  const texts: TextItem[] = [];

  // vùng XY của mô hình (shell lưới, không tính chú thích) — dùng để nhận ra đường lưới mang ma trận bậy trong mặt bằng
  let planBounds: number[] | null = null;
  const gridCols: { x: number; lo: number; hi: number }[] = [];
  if (model.sheet && model.views?.some(w => w.plan)) {
    const B = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ins of instances) {
      if (ins.paper) continue;
      const e = ins.M.elements;
      for (const p of ins.parts) for (const sh of p.shells) {
        if (sh.line || sh.text || isPaperSizedShell(sh)) continue;
        for (let k = 0; k + 2 < sh.verts.length; k += 3) {
          const x = e[0] * sh.verts[k] + e[4] * sh.verts[k + 1] + e[8] * sh.verts[k + 2] + e[12], y = e[1] * sh.verts[k] + e[5] * sh.verts[k + 1] + e[9] * sh.verts[k + 2] + e[13];
          if (x < B[0]) B[0] = x;
          if (y < B[1]) B[1] = y;
          if (x > B[2]) B[2] = x;
          if (y > B[3]) B[3] = y;
        }
      }
    }
    if (B[0] < Infinity) planBounds = B;
    // Đường lưới dọc (đường thẳng đứng dài > 20 ft, toạ độ tuyệt đối trong vùng mô hình): khoảng Y của mỗi X
    if (planBounds) {
      for (const ins of instances) {
        if (ins.paper) continue;
        for (const p of ins.parts) for (const sh of p.shells) {
          const vv = sh.verts;
          if (!sh.line || sh.circle || vv.length !== 6 || Math.abs(vv[0] - vv[3]) > 1e-6 || Math.abs(vv[1] - vv[4]) < 20) continue;
          if (vv[0] < planBounds[0] - 40 || vv[0] > planBounds[2] + 40) continue;
          const g = gridCols.find(c => Math.abs(c.x - vv[0]) < 0.3);
          const lo = Math.min(vv[1], vv[4]), hi = Math.max(vv[1], vv[4]);
          if (g) { g.lo = Math.min(g.lo, lo); g.hi = Math.max(g.hi, hi); } else gridCols.push({ x: vv[0], lo, hi });
        }
      }
    }
  }
  /** Bong bóng lưới: file chỉ lưu đầu bong bóng ở một đầu đường lưới (đầu dưới, tâm cách đầu đường 2.13 ft = bán kính vòng) nhưng ảnh gốc còn vẽ đầu trên của những đường lưới dài suốt;
   *  vòng + chữ ở đầu dưới thì sao chép lên đầu trên của đường lưới đó (dịch theo Y). Trả về độ dịch (ft mô hình) hoặc null. */
  const topShift = (view: SheetView, px: number, py: number, tolX: number, tolY: number): number | null => {
    const X = (px - view.a) / view.s, Y = (py - view.b) / view.s;
    // chỉ những đường lưới chạm tới mép trên của cả lưới (116.2 ft ở school_sheet_1: lưới 1, 1.1, 2, 3, 4, 5, 6) mới có bong bóng đầu trên; đầu dưới ở mép dưới của cả lưới
    if (!gridCols.length) return null;
    const lo = Math.min(...gridCols.map(g => g.lo)), hi = Math.max(...gridCols.map(g => g.hi));
    for (const g of gridCols) if (g.hi >= hi - 1 && Math.abs(X - g.x) < tolX && Math.abs(Y - (lo - 2.13)) < tolY) return hi - lo + 4.26;
    return null;
  };

  // Cầu thang trong mặt bằng: một đối tượng gồm ≥ 100 shell nhỏ (mỗi bậc một shell), bề ngang < 12 ft, dài < 70 ft, cao ≥ 5 ft (school_sheet_1: 219/220, 253/254, mỗi cái 180 shell).
  // Mặt phẳng cắt chỉ cắt vài bậc, nhưng ảnh gốc vẽ MỌI bậc dưới mặt cắt -> với cầu thang vẽ thêm cạnh (theo trục) của mặt bậc nằm ngang dưới mặt cắt.
  const stairs = new Map<number, number>();   // chỉ số instance -> độ cao thấp nhất
  const columns: { i: number; x: number; y: number }[] = [];
  const stairBoxes: number[][] = [];            // bbox XY (x0, y0, x1, y1) của các cầu thang
  if (model.sheet && model.views?.some(w => w.plan)) {
    instances.forEach((ins, i) => {
      if (ins.paper) return;
      const e = ins.M.elements, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      let n = 0;
      for (const p of ins.parts) for (const sh of p.shells) {
        if (sh.line || sh.text) continue;
        n++;
        for (let k = 0; k + 2 < sh.verts.length; k += 3) for (let d = 0; d < 3; d++) {
          const w = e[d] * sh.verts[k] + e[d + 4] * sh.verts[k + 1] + e[d + 8] * sh.verts[k + 2] + e[d + 12];
          if (w < b[d]) b[d] = w;
          if (w > b[d + 3]) b[d + 3] = w;
        }
      }
      const w = b[3] - b[0], l = b[4] - b[1], h = b[5] - b[2];
      if (n >= 100 && Math.min(w, l) < 12 && Math.max(w, l) < 70 && h >= 5) { stairs.set(i, b[2]); stairBoxes.push([b[0], b[1], b[3], b[4]]); }
      // cột thép chữ I (≤ 20 shell, tiết diện < 1 ft, cao ≥ 8 ft) bị mặt cắt đi qua: ảnh gốc vẽ ký hiệu = tiết diện chữ I trong một vòng tròn (vòng không có trong file)
      const zc = model.views?.find(q => q.plan)?.y0 ?? 0;
      if (n > 0 && n <= 20 && w < 1 && l < 1 && h >= 8 && b[2] <= zc && b[5] >= zc) columns.push({ i, x: (b[0] + b[3]) / 2, y: (b[1] + b[4]) / 2 });
    });
  }

  instances.forEach((ins, li) => {
    const ii = li + base;
    // file bản vẽ: trang giấy vẽ nguyên; nội dung viewport = bản sao mô hình của view chiếu lên giấy; còn lại bỏ
    let view: SheetView | undefined, M = ins.M;
    if (model.sheet && !ins.paper) {
      view = model.views?.find(w => ii >= w.from && ii <= w.to);
      if (!view) return;
      M = viewMatrix(view, ins.M);
    }
    const yIn = (sh: Shell) => {   // lát cắt độ sâu: MỌI đỉnh nằm trong [y0 − ε, y0 + depth] (Y world, trước khi chiếu)
      if (!view) return true;                // (tấm địa hình/cây chỉ chạm lát bằng một đỉnh thì loại, như ảnh gốc)
      const e = (sh.textM ?? ins.M).elements, vv = sh.verts;
      if (view.plan) {   // mặt bằng: chú thích/đường luôn giữ; mặt phải bị mặt phẳng cắt Z = y0 cắt qua
        if (sh.line || sh.text || isPaperSized(sh)) return true;
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k + 2 < vv.length; k += 3) {
          const z = e[2] * vv[k] + e[6] * vv[k + 1] + e[10] * vv[k + 2] + e[14];
          if (z < lo) lo = z;
          if (z > hi) hi = z;
        }
        if ((stairs.get(ii) ?? Infinity) <= view.y0) return true;   // cầu thang bắt đầu dưới mặt cắt: vẽ cả đoạn thang (bậc nằm trên mặt cắt cũng có, như ảnh gốc)
        return (lo <= view.y0 && hi >= view.y0 - 0.05) || (view.hatchZ !== undefined && lo <= view.hatchZ + 0.05 && hi >= view.hatchZ - 0.05) || (view.stripeZ !== undefined && lo <= view.stripeZ + 0.05 && hi >= view.stripeZ - 0.05);   // hoặc chạm mặt sàn (rải chấm)
      }
      if (view.slab === 'cut') {   // shell cắt qua mặt phẳng view (hoặc nằm trong lát mỏng quanh nó, như chú thích)
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k + 2 < vv.length; k += 3) {
          const y = e[1] * vv[k] + e[5] * vv[k + 1] + e[9] * vv[k + 2] + e[13];
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
        return lo <= view.y0 + view.depth && hi >= view.y0 - 0.05;
      }
      for (let k = 0; k + 2 < vv.length; k += 3) {
        const y = e[1] * vv[k] + e[5] * vv[k + 1] + e[9] * vv[k + 2] + e[13];
        const inSlab = y >= view.y0 - 0.05 && y <= view.y0 + view.depth;
        if (view.slab === 'touch' ? inSlab : !inSlab) return view.slab === 'touch';
      }
      return view.slab !== 'touch';
    };
    const Mann = view ? annMatrix(view, ins.M) : M;
    // Mặt bằng: shell nhỏ (< 0.5 ft) chỉ là chú thích tính theo tỉ lệ in khi instance có chữ/đường; vật nhỏ thật của mô hình (0.49 ft) thì cắt như mọi thứ
    const annot = !view?.plan || ins.parts.some(p => p.shells.some(s => s.text || s.line));
    const isPaperSized = (sh: Shell) => annot && isPaperSizedShell(sh);
    const id = idOf[ii];
    ins.parts.forEach(part => {
      // viewport: mô hình xuất ở kiểu "hidden line" — mặt, chữ, đường đều TRẮNG (nét đen do cạnh); trên giấy trắng chữ/đường trắng sẽ vô hình,
      // nên chữ và đường của viewport luôn vẽ đen như ảnh gốc (mặt vẫn giữ màu file: trắng, kính xanh).
      // nhãn view trên giấy: ảnh gốc vẽ xanh lá (màu này không có trong bản ghi màu của file — hiệu chỉnh theo ảnh): chữ dài (không phải "1 : 100"/số) và đường
      const labelInk = ins.viewLabel ? 0x008000 : 0;
      const lineInk = view ? 0x0a0a0a : 0;
      const color = debugColors ? new THREE.Color().setHSL((ii * 0.618) % 1, .55, .6).getHex() : view && part.opacity !== undefined && part.opacity < 1 ? 0xd2e9f6 : (part.color || 0xb0b0b0);   // kính trong viewport: xanh nhạt như ảnh gốc (file lưu trắng)
      const buckets: Record<ChunkKind, number[]> = { opaque: [], glass: [], faceCol: [], wire: [] };
      const spans: Record<ChunkKind, number[]> = { opaque: [], glass: [], faceCol: [], wire: [] };   // vị trí (số float) cuối mỗi shell trong bucket, để lọc cạnh theo từng shell
      const fcol: number[] = [];
      const alpha = part.opacity ?? -1;     // ≥ 0: vật liệu trong file có độ đục < 1 (kính, khối trong suốt)
      for (const sh of part.shells) {
        if (!(sh.text?.abs) && !yIn(sh)) continue;
        if (sh.text?.abs && !view) continue;   // chữ toạ độ mô hình chỉ có nghĩa trong viewport
        // mặt bằng: chữ cao > 0.05 ft là chữ TÍNH THEO ĐƠN VỊ MÔ HÌNH (số đo của dây kích thước "7315", ghi chú "Exterior overhead canopy…": cao 0.82 ft = 2.5 mm × 100) — chiếu có nhân tỉ lệ s
        const modelText = !!sh.text && !!view?.plan && !sh.text.abs && sh.text.h > 0.05;
        if (sh.text && (sh.text.abs || modelText) && view) {
          // nhãn level thứ cấp: x = X, y = Z (toạ độ mô hình), cao chữ theo đơn vị mô hình -> chiếu có nhân tỉ lệ s, trục chữ = trục giấy
          const px = view.a + view.s * sh.verts[0], py = view.b + view.s * sh.verts[1];
          if (px < view.crop[0] || px > view.crop[2] || py < view.crop[1] || py > view.crop[3]) continue;
          texts.push({ entity: id, color: lineInk || color, text: sh.text.s, height: sh.text.h * view.s, origin: [px, py, 0], ax: [Math.cos(sh.text.rot), Math.sin(sh.text.rot), 0], ay: [-Math.sin(sh.text.rot), Math.cos(sh.text.rot), 0] });
          continue;
        }
        if (sh.text) {   // chữ: đưa ra danh sách riêng (dựng bằng texture canvas ở main thread)
          const e = sh.textM ? (view ? annMatrix(view, sh.textM) : sh.textM).elements : Mann.elements, [x, y] = sh.verts;
          const c = Math.cos(sh.text.rot), sn = Math.sin(sh.text.rot);   // trục chữ local (c, sn) và (−sn, c), rồi qua ma trận instance
          const ax = new THREE.Vector3(e[0] * c + e[4] * sn, e[1] * c + e[5] * sn, e[2] * c + e[6] * sn);
          const ay = new THREE.Vector3(-e[0] * sn + e[4] * c, -e[1] * sn + e[5] * c, -e[2] * sn + e[6] * c);
          const sy = ay.length() || 1;
          if (view) {   // chữ ngoài khung viewport thì bỏ
            const px = e[0] * x + e[4] * y + e[12], py = e[1] * x + e[5] * y + e[13];
            if (px < view.crop[0] || px > view.crop[2] || py < view.crop[1] || py > view.crop[3]) continue;
          }
          const dupY = view?.plan ? topShift(view, e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13], 2.5, 1.5) : null;
          if (dupY !== null && view) {
            const oy = e[1] * x + e[5] * y + e[13] + view.s * dupY;
            if (oy <= view.crop[3]) texts.push({ entity: id, color: lineInk || color, text: sh.text.s, height: sh.text.h * sy, origin: [e[0] * x + e[4] * y + e[12], oy, 0], ax: ax.clone().normalize().toArray() as [number, number, number], ay: ay.clone().normalize().toArray() as [number, number, number] });
          }
          texts.push({
            entity: id, color: lineInk || (labelInk && sh.text.s.length > 3 && !sh.text.s.includes(':') ? labelInk : color), text: sh.text.s, height: sh.text.h * sy,
            origin: [e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13], e[2] * x + e[6] * y + e[14]],
            ax: ax.normalize().toArray() as [number, number, number], ay: ay.normalize().toArray() as [number, number, number],
          });
          continue;
        }
        if (sh.line) {   // đường gấp khúc: các đoạn nối tiếp giữa điểm k và k+1, áp ma trận instance
          const w = buckets.wire, vv = sh.verts;
          let Ml = view && isPaperSized(sh) ? Mann : M;
          let gridLine = false, leader = false;
          if (view?.plan && Ml === M && planBounds) {
            // Đường lưới của mặt bằng: toạ độ local đã là toạ độ mô hình tuyệt đối nhưng instance mang ma trận bậy (dời 180.6, −52.2, 7.1 và lật) -> văng ra ngoài
            // vùng mô hình. Nếu áp ma trận làm đường rơi khỏi vùng (± 40 ft) mà bỏ ma trận thì nằm trong -> bỏ ma trận (như đường level của mặt đứng).
            const inside = (mat: THREE.Matrix4) => {
              const e = mat.elements, vv = sh.verts;
              for (let k = 0; k + 2 < vv.length; k += 3) {
                const x = e[0] * vv[k] + e[4] * vv[k + 1] + e[8] * vv[k + 2] + e[12], y = e[1] * vv[k] + e[5] * vv[k + 1] + e[9] * vv[k + 2] + e[13];
                if (x < planBounds[0] - 40 || x > planBounds[2] + 40 || y < planBounds[1] - 40 || y > planBounds[3] + 40) return false;
              }
              return true;
            };
            let len = 0;
            for (let k = 0; k + 5 < sh.verts.length; k += 3) len += Math.hypot(sh.verts[k + 3] - sh.verts[k], sh.verts[k + 4] - sh.verts[k + 1]);
            // đường dài (> 20 ft) đã nằm trong vùng mô hình với ma trận đơn vị: đường lưới — một số mảnh vẫn rơi vào vùng sau khi áp ma trận bậy nên kiểm "rơi ngoài" là chưa đủ
            // đường ngắn nhưng toạ độ local đã ở xa gốc (> 20 ft: tay dẫn ghi chú "Exterior overhead canopy" — 3 điểm, dài 18 ft) trong instance mang ma trận bậy cũng là toạ độ tuyệt đối;
            // đường quanh gốc (cánh cửa: local ±3 ft) thì ma trận là thật
            const cx = (Math.min(sh.verts[0], sh.verts[sh.verts.length - 3]) + Math.max(sh.verts[0], sh.verts[sh.verts.length - 3])) / 2, cy = (sh.verts[1] + sh.verts[sh.verts.length - 2]) / 2;
            const absolute = Math.hypot(cx, cy) > 20 && (Math.abs(ins.M.elements[12]) > 20 || Math.abs(ins.M.elements[13]) > 20);
            if (inside(new THREE.Matrix4()) && (!inside(ins.M) || len > 20 || absolute)) {
              Ml = viewMatrix(view, new THREE.Matrix4());
              gridLine = len > 20 && ins.M.elements.some((x, i) => Math.abs(x - (i % 5 === 0 ? 1 : 0)) > 1e-9);
              leader = !gridLine && absolute && vv.length === 9;   // đường lưới mang ma trận bậy; dây kích thước (ma trận đơn vị) thì liền nét
            }
          }
          if (view && !view.plan && Ml === M) {
            // Đường level của view (instance chung với đầu level): toạ độ đã là TOẠ ĐỘ MÔ HÌNH tuyệt đối (x, y0, 0) nhưng ma trận
            // của đầu level (dời 95.8, y0, 0 và xoay) vẫn bị áp -> rơi xuống z = y0 ≈ −62 ft, ra ngoài khung. Nếu áp ma trận làm đường
            // văng khỏi dải cao độ của mô hình (z ∉ [−30, 60] ft) mà dùng ma trận đơn vị thì vào dải đó -> dùng ma trận đơn vị.
            const zr = (mat: THREE.Matrix4) => {
              const e = mat.elements;
              let lo = Infinity, hi = -Infinity;
              for (let k = 0; k + 2 < vv.length; k += 3) { const z = e[2] * vv[k] + e[6] * vv[k + 1] + e[10] * vv[k + 2] + e[14]; if (z < lo) lo = z; if (z > hi) hi = z; }
              return [lo, hi];
            };
            const [lo, hi] = zr(ins.M), [ilo, ihi] = zr(new THREE.Matrix4());
            if ((lo < -30 || hi > 60) && ilo >= -30 && ihi <= 60) Ml = viewMatrix(view, new THREE.Matrix4());
          }
          // Nét đứt (hiệu chỉnh theo ảnh gốc): đường lưới và đường level nằm ĐÚNG trên mặt phẳng view (Y = y0) và dài > 5 ft; file không lưu kiểu nét
          // trong bản ghi đường (cờ màu cb/04 hay 80/02 đều giống đường liền) nên chưa đọc được từ dữ liệu.
          let dashed = false;
          if (view?.plan && !sh.circle && vv.length === 6 && !gridLine && !leader) {
            // khung chạy thang (đường mô hình liền quanh thang, lớn hơn bậc ~ 2 ft mỗi bên): ảnh gốc vẽ nét đứt mảnh (file không lưu kiểu nét)
            const mat = Ml.elements, X = (k: number) => mat[0] * vv[k] + mat[4] * vv[k + 1] + mat[8] * vv[k + 2] + mat[12], Y = (k: number) => mat[1] * vv[k] + mat[5] * vv[k + 1] + mat[9] * vv[k + 2] + mat[13];
            const x0 = (X(0) - view.a) / view.s, y0 = (Y(0) - view.b) / view.s, x1 = (X(3) - view.a) / view.s, y1 = (Y(3) - view.b) / view.s;
            if (stairBoxes.some(q => Math.min(x0, x1) >= q[0] - 2.6 && Math.max(x0, x1) <= q[2] + 2.6 && Math.min(y0, y1) >= q[1] - 2.6 && Math.max(y0, y1) <= q[3] + 2.6 && Math.hypot(x1 - x0, y1 - y0) > 3 && (Math.abs(x1 - x0) < 1e-3 || Math.abs(y1 - y0) < 1e-3)))
              { for (let k = 0; k + 5 < vv.length; k += 3) { const q0 = [X(k), Y(k), 0], q1 = [X(k + 3), Y(k + 3), 0], sg = clipSeg(q0, q1, view.crop); if (sg) dashSeg(sg[0], sg[1], 0.012, 0.009, w); } continue; }
          }
          if (view && !view.plan && !sh.circle) {
            let lo = Infinity, hi = -Infinity, len = 0;
            const e = Ml === Mann ? Mann.elements : ins.M.elements;
            for (let k = 0; k + 2 < vv.length; k += 3) {
              const y = Ml === M ? e[1] * vv[k] + e[5] * vv[k + 1] + e[9] * vv[k + 2] + e[13] : vv[k + 1];
              if (y < lo) lo = y;
              if (y > hi) hi = y;
              if (k + 5 < vv.length) len += Math.hypot(vv[k + 3] - vv[k], vv[k + 4] - vv[k + 1], vv[k + 5] - vv[k + 2]);
            }
            dashed = Math.abs(lo - view.y0) < 0.01 && Math.abs(hi - view.y0) < 0.01 && len > 5;
          }
          for (let k = 0; k + 5 < vv.length; k += 3) {
            v.set(vv[k], vv[k + 1], vv[k + 2]).applyMatrix4(Ml);
            const p0 = [v.x, v.y, v.z];
            v.set(vv[k + 3], vv[k + 4], vv[k + 5]).applyMatrix4(Ml);
            const p1 = [v.x, v.y, v.z];
            const seg = view ? clipSeg(p0, p1, view.crop) : [p0, p1];
            if (seg) { if (gridLine) dashDotSeg(seg[0], seg[1], w); else if (dashed) dashSeg(seg[0], seg[1], 0.03, 0.012, w); else w.push(...seg[0], ...seg[1]); }
          }
          if (leader) {   // tay dẫn ghi chú: đầu mũi tên mở (file không lưu mũi tên — hiệu chỉnh theo ảnh: dài 1.8 ft mô hình, mở ±10° so với đường dẫn)
            const dx = vv[6] - vv[3], dy = vv[7] - vv[4], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, A = 1.8, th = (10 * Math.PI) / 180;
            for (const sg of [-1, 1]) {
              const c = Math.cos(th), sn = Math.sin(sg * th), wx = vv[6] - A * (ux * c - uy * sn), wy = vv[7] - A * (ux * sn + uy * c);
              v.set(vv[6], vv[7], vv[8]).applyMatrix4(Ml);
              const t0 = [v.x, v.y, v.z];
              v.set(wx, wy, vv[8]).applyMatrix4(Ml);
              const sg2 = clipSeg(t0, [v.x, v.y, v.z], view!.crop);
              if (sg2) w.push(...sg2[0], ...sg2[1]);
            }
          }
          if (view?.plan && sh.circle) {
            const cc = new THREE.Vector3(sh.circle.c[0], sh.circle.c[1], sh.circle.c[2]).applyMatrix4(Ml), dy = topShift(view, cc.x, cc.y, 0.5, 0.6);
            if (dy !== null) for (let k = 0; k + 5 < vv.length; k += 3) {
              v.set(vv[k], vv[k + 1], vv[k + 2]).applyMatrix4(Ml);
              const q0 = [v.x, v.y + view.s * dy, v.z];
              v.set(vv[k + 3], vv[k + 4], vv[k + 5]).applyMatrix4(Ml);
              const sg = clipSeg(q0, [v.x, v.y + view.s * dy, v.z], view.crop);
              if (sg) w.push(...sg[0], ...sg[1]);
            }
          }
          continue;
        }
        const glass = glassOn && !debugColors && (alpha >= 0 || isGlass(part.color, sh, unitMM));
        const faceColors = debugColors ? null : sh.faceColors;
        const tri = triangulateShell(sh), out = buckets[faceColors ? 'faceCol' : glass ? 'glass' : 'opaque'];
        const triFace = sh.triFace ?? [];
        if (view?.plan && !isPaperSized(sh)) {
          // Mặt bằng: không chiếu mặt đứng (suy biến thành vệt) mà lấy GIAO của từng tam giác với mặt phẳng cắt Z = y0 -> các đoạn thẳng (đường cắt tường/cột…)
          const w = buckets.wire, e = ins.M.elements, z0 = view.y0;
          const W = (vi: number) => {
            const x = sh.verts[vi * 3], y = sh.verts[vi * 3 + 1], z = sh.verts[vi * 3 + 2];
            return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
          };
          for (let k = 0; k + 2 < tri.length; k += 3) {
            const P = [W(tri[k]), W(tri[k + 1]), W(tri[k + 2])], hit: number[][] = [];
            for (let j = 0; j < 3; j++) {
              const p = P[j], q = P[(j + 1) % 3], dp = p[2] - z0, dq = q[2] - z0;
              if ((dp < 0) !== (dq < 0) && dp !== dq) { const t = dp / (dp - dq); hit.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
            }
            if ((stairs.get(ii) ?? Infinity) <= view.y0 && Math.min(Math.max(...P.map(q => q[0])) - Math.min(...P.map(q => q[0])), Math.max(...P.map(q => q[1])) - Math.min(...P.map(q => q[1]))) < 0.5) {   // tam giác có hình chiếu mỏng (< 0.5 ft: mặt bậc, mặt đứng của thanh cạnh/lan can — nét dày hai bên ảnh gốc; bỏ mặt đế lớn): các cạnh theo trục
              for (let j = 0; j < 3; j++) {
                const p = P[j], q = P[(j + 1) % 3];
                if (Math.abs(p[0] - q[0]) > 1e-6 && Math.abs(p[1] - q[1]) > 1e-6) continue;
                const sg = clipSeg([view.a + view.s * p[0], view.b + view.s * p[1], 0], [view.a + view.s * q[0], view.b + view.s * q[1], 0], view.crop);
                if (sg) w.push(...sg[0], ...sg[1]);
              }
            }
            if (view.stripeZ !== undefined && P.every(q => Math.abs(q[2] - view.stripeZ!) < 0.05)) stripes(P, view, w);
            if (view.hatchZ !== undefined && P.every(q => Math.abs(q[2] - view.hatchZ!) < 0.05)) stipple(P, view, (ii * 7919 + k) | 0, w);
            if (hit.length !== 2) continue;
            const seg = clipSeg([view.a + view.s * hit[0][0], view.b + view.s * hit[0][1], 0], [view.a + view.s * hit[1][0], view.b + view.s * hit[1][1], 0], view.crop);
            if (seg) w.push(...seg[0], ...seg[1]);
          }
          continue;
        }
        if (view) {   // viewport: chiếu rồi cắt từng tam giác theo khung (đa giác → quạt tam giác)
          const Ms = isPaperSized(sh) ? Mann : M;
          for (let k = 0; k + 2 < tri.length; k += 3) {
            const P = [0, 1, 2].map(j => { const vi = tri[k + j]; v.set(sh.verts[vi * 3], sh.verts[vi * 3 + 1], sh.verts[vi * 3 + 2]).applyMatrix4(Ms); return [v.x, v.y, v.z]; });
            const poly = clipPoly(P, view.crop);
            for (let j = 1; j + 1 < poly.length; j++)
              for (const q of [poly[0], poly[j], poly[j + 1]]) {
                out.push(q[0], q[1], q[2]);
                if (faceColors) {
                  c3.setHex(faceColors[triFace[k / 3 | 0]] ?? color, THREE.SRGBColorSpace);
                  fcol.push(c3.r, c3.g, c3.b);
                }
              }
          }
          continue;
        }
        // IfcSite (mặt đất) thường CÙNG độ cao với mặt trên sàn nhà (file_13: ground z = 0, IfcSlab sàn z −300…0) -> hai mặt đồng phẳng, depth test z-fight: khi xoay/zoom sàn lẫn màu xanh của đất.
        // Hạ mặt đất xuống 20 mm (đổi ra đơn vị file) — dưới ngưỡng nhìn thấy nhưng đủ để vượt sai số độ sâu.
        const dz = ins.name.endsWith('::IfcSite') ? 20 / unitMM : 0;
        const me = M.elements;
        tri.forEach((vi, k) => {
          const x = sh.verts[vi * 3], y = sh.verts[vi * 3 + 1], z = sh.verts[vi * 3 + 2];
          // = Vector3.applyMatrix4 (hàng cuối ma trận afin là 0 0 0 1 nên w = 1): bỏ cấp phát/lời gọi cho mỗi đỉnh
          out.push(me[0] * x + me[4] * y + me[8] * z + me[12], me[1] * x + me[5] * y + me[9] * z + me[13], me[2] * x + me[6] * y + me[10] * z + me[14] - dz);
          if (faceColors) {
            const fc = faceColors[triFace[(k / 3) | 0]];
            c3.setHex(fc ?? color, THREE.SRGBColorSpace);
            fcol.push(c3.r, c3.g, c3.b);
          }
        });
        spans[faceColors ? 'faceCol' : glass ? 'glass' : 'opaque'].push(out.length);
      }
      for (const kind of ['opaque', 'glass', 'faceCol', 'wire'] as const) {
        const arr = buckets[kind];
        if (!arr.length) continue;
        if (kind === 'wire') {   // chỉ có đoạn thẳng, không có mặt: vCount = 0
          const wc = lineInk || labelInk || color, key = `wire:${wc}`, seg = new Float32Array(arr);
          let acc = accs.get(key);
          if (!acc) accs.set(key, acc = { kind, color: wc, opacity: -1, pos: [], nor: [], col: [], edg: [], ranges: [], vCount: 0, eCount: 0 });
          acc.ranges.push(id, acc.vCount, 0, acc.eCount, seg.length / 3);
          acc.edg.push(seg);
          acc.eCount += seg.length / 3;
          continue;
        }
        const positions = new Float32Array(arr);
        // Pháp tuyến chỉ cần cho KÍNH (MeshStandardMaterial không flatShading). Mọi vật liệu đặc đều flatShading: true (pháp tuyến tính từ đạo hàm màn hình) hoặc MeshBasic nên
        // thuộc tính normal bị bỏ qua -> không dựng/lưu/chuyển giao (file_14: 277 MB và 1.3 s computeVertexNormals; điện thoại hết RAM). Hiển thị không đổi.
        let normals: Float32Array | null = null;
        if (kind === 'glass') {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          g.computeVertexNormals();
          normals = g.getAttribute('normal').array as Float32Array;
          g.dispose();
        }
        let edges: Float32Array;
        const sp = spans[kind];
        if (noEdges) {
          edges = new Float32Array(0);
        } else if (positions.length / 9 > 30000 && sp.length > 1 && sp[sp.length - 1] === positions.length) {
          // Bucket khổng lồ (file_13: 1 part 335 shell, 330 000 tam giác): lọc cạnh trên cả bucket là phi tuyến (lưới không gian + T-junction) -> treo hàng chục giây.
          // Các shell độc lập không chia cạnh với nhau nên lọc từng shell riêng (shell lớn nhất 40 000 tam giác ≈ 0.5 s).
          const pieces: Float32Array[] = [];
          let a = 0, tot = 0;
          for (const b of sp) {
            if (b > a) {
              const sub = positions.subarray(a, b), pe = sub.length / 9 > 20000 ? edgesFromTriangles(sub, 25).all : edgesPruned(sub);   // shell > 20 000 tam giác (mặt cong hữu cơ): bỏ lọc T-junction cho nhanh
              pieces.push(pe); tot += pe.length;
            }
            a = b;
          }
          edges = new Float32Array(tot);
          let o2 = 0;
          for (const pe of pieces) { edges.set(pe, o2); o2 += pe.length; }
        } else {
          edges = edgesPruned(positions);
        }
        const op = kind === 'glass' ? alpha : -1;
        const key = kind === 'faceCol' ? kind : `${kind}:${color}:${op}`;
        let acc = accs.get(key);
        if (!acc) accs.set(key, acc = { kind, color: kind === 'faceCol' ? 0 : color, opacity: op, pos: [], nor: [], col: [], edg: [], ranges: [], vCount: 0, eCount: 0 });
        const vN = positions.length / 3, eN = edges.length / 3;
        acc.ranges.push(id, acc.vCount, vN, acc.eCount, eN);
        acc.pos.push(positions);
        if (normals) acc.nor.push(normals);
        if (kind === 'faceCol') acc.col.push(new Float32Array(fcol));
        acc.edg.push(edges);
        acc.vCount += vN;
        acc.eCount += eN;
      }
    });
  });

  // Vòng tròn quanh tiết diện cột chữ I (mặt bằng): bán kính 0.75 ft mô hình, hiệu chỉnh theo ảnh (đường kính vòng ≈ 2× cạnh chữ I)
  if (columns.length) {
    const view = model.views!.find(q => q.plan)!, SEG = 24, key = 'wire:' + 0x0a0a0a;
    for (const c of columns) {
      const seg: number[] = [];
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * 2 * Math.PI, a1 = ((k + 1) / SEG) * 2 * Math.PI;
        const sg = clipSeg([view.a + view.s * (c.x + 0.75 * Math.cos(a0)), view.b + view.s * (c.y + 0.75 * Math.sin(a0)), 0], [view.a + view.s * (c.x + 0.75 * Math.cos(a1)), view.b + view.s * (c.y + 0.75 * Math.sin(a1)), 0], view.crop);
        if (sg) seg.push(...sg[0], ...sg[1]);
      }
      if (!seg.length) continue;
      const arr = new Float32Array(seg);
      let acc = accs.get(key);
      if (!acc) accs.set(key, acc = { kind: 'wire', color: 0x0a0a0a, opacity: -1, pos: [], nor: [], col: [], edg: [], ranges: [], vCount: 0, eCount: 0 });
      acc.ranges.push(idOf[c.i], acc.vCount, 0, acc.eCount, arr.length / 3);
      acc.edg.push(arr);
      acc.eCount += arr.length / 3;
    }
  }

  // Hatch gạch của mặt cắt địa hình trong từng viewport (vẽ như đường đen, thuộc đối tượng đầu tiên của view)
  if (model.sheet && model.views) {
    for (const view of model.views) {
      const cut = view.plan ? null : terrainCut(view, instances);
      if (!cut) continue;
      const raw: number[] = [];
      hatchSegments(view, cut, raw);
      const seg: number[] = [];
      for (let k = 0; k + 5 < raw.length; k += 6) {
        const c = clipSeg([raw[k], raw[k + 1], raw[k + 2]], [raw[k + 3], raw[k + 4], raw[k + 5]], view.crop);
        if (c) seg.push(...c[0], ...c[1]);
      }
      if (!seg.length) continue;
      const key = 'wire:' + 0x0a0a0a, arr = new Float32Array(seg);
      let acc = accs.get(key);
      if (!acc) accs.set(key, acc = { kind: 'wire', color: 0x0a0a0a, opacity: -1, pos: [], nor: [], col: [], edg: [], ranges: [], vCount: 0, eCount: 0 });
      acc.ranges.push(idOf[view.from], acc.vCount, 0, acc.eCount, arr.length / 3);
      acc.edg.push(arr);
      acc.eCount += arr.length / 3;
    }
  }

  const chunks: MeshChunk[] = [...accs.values()].map(a => ({
    kind: a.kind,
    color: a.color,
    opacity: a.opacity,
    positions: concat(a.pos, a.vCount * 3),
    normals: a.kind === 'glass' ? concat(a.nor, a.vCount * 3) : new Float32Array(0),
    colors: a.kind === 'faceCol' ? concat(a.col, a.vCount * 3) : null,
    edges: concat(a.edg, a.eCount * 3),
    ranges: new Uint32Array(a.ranges),
  }));
  return { chunks, entities, handles, texts, sheet: !!model.sheet, plan: !!model.plan };
}

/** Danh sách ArrayBuffer cần chuyển giao (transfer) khi gửi MeshData qua postMessage. */
export function meshDataTransferables(data: MeshData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const c of data.chunks)
    for (const a of [c.positions, c.normals, c.colors, c.edges, c.ranges]) if (a) out.add(a.buffer as ArrayBuffer);
  return [...out];
}

/** Ghép MeshData của các lát liên tiếp (theo thứ tự instance) thành một: cùng khoá (loại, màu, độ đục) thì nối mảng và dời `ranges` (vStart, eStart) — kết quả giống từng số với dựng tuần tự,
 *  vì chunk mới xuất hiện theo thứ tự lát (lát đứng trước chứa các instance đứng trước) và trong chunk các range vẫn theo thứ tự instance. */
const EMPTY_F32 = new Float32Array(0), EMPTY_U32 = new Uint32Array(0);
export function mergeMeshData(parts: MeshData[], entities: string[], handles: string[]): MeshData {
  const byKey = new Map<string, MeshChunk[]>();
  for (const d of parts) for (const c of d.chunks) {
    const k = `${c.kind}|${c.color}|${c.opacity}`;
    const l = byKey.get(k);
    if (l) l.push(c); else byKey.set(k, [c]);
  }
  const chunks: MeshChunk[] = [];
  for (const list of byKey.values()) {
    if (list.length === 1) { chunks.push(list[0]); continue; }
    let nP = 0, nN = 0, nE = 0, nR = 0, nC = 0;
    for (const c of list) { nP += c.positions.length; nN += c.normals.length; nE += c.edges.length; nR += c.ranges.length; if (c.colors) nC += c.colors.length; }
    const positions = new Float32Array(nP), normals = new Float32Array(nN), edges = new Float32Array(nE), ranges = new Uint32Array(nR), colors = list[0].colors ? new Float32Array(nC) : null;
    let oP = 0, oN = 0, oE = 0, oR = 0, oC = 0;
    for (const c of list) {
      const vOff = oP / 3, eOff = oE / 3;
      positions.set(c.positions, oP); normals.set(c.normals, oN); edges.set(c.edges, oE);
      if (colors && c.colors) { colors.set(c.colors, oC); oC += c.colors.length; }
      for (let r = 0; r < c.ranges.length; r += 5) {
        ranges[oR + r] = c.ranges[r];
        ranges[oR + r + 1] = c.ranges[r + 1] + vOff;
        ranges[oR + r + 2] = c.ranges[r + 2];
        ranges[oR + r + 3] = c.ranges[r + 3] + eOff;
        ranges[oR + r + 4] = c.ranges[r + 4];
      }
      oP += c.positions.length; oN += c.normals.length; oE += c.edges.length; oR += c.ranges.length;
      // đã chép xong chunk này: bỏ tham chiếu mảng nguồn để GC thu hồi ngay trong lúc ghép (đỉnh bộ nhớ ≈ tổng + một khoá, không phải 2 × tổng — quan trọng trên điện thoại)
      c.positions = EMPTY_F32; c.normals = EMPTY_F32; c.edges = EMPTY_F32; c.colors = c.colors ? EMPTY_F32 : null; c.ranges = EMPTY_U32;
    }
    chunks.push({ kind: list[0].kind, color: list[0].color, opacity: list[0].opacity, positions, normals, colors, edges, ranges });
  }
  return { chunks, entities, handles, texts: [], sheet: false, plan: false };
}

/** Ghép danh sách MeshData KHÔNG nối chunk (không sao chép mảng): chỉ xếp các chunk của từng lát cạnh nhau. Nhiều draw call hơn (số chunk × số lát) nhưng không cần thêm bộ nhớ như mergeMeshData
 *  (đỉnh 2 × kích thước lưới) — dùng cho thiết bị ít RAM. Hiển thị giống hệt: mỗi chunk có bảng range riêng, entity trải trên nhiều chunk đã được hỗ trợ. */
export function concatMeshData(parts: MeshData[], entities: string[], handles: string[]): MeshData {
  return { chunks: parts.flatMap(d => d.chunks), entities, handles, texts: [], sheet: false, plan: false };
}
