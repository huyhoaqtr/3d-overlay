/* Dựng lưới (chạy trong worker): triangulate thủ công, áp ma trận instance, gộp theo màu/loại,
 * tính normal và cạnh. Kết quả là các mảng Float32Array thuần để chuyển giao về main thread. */
import * as THREE from 'three';
import { pruneCoplanarEdges } from './edges';
import type { BuildOptions, ChunkKind, MeshChunk, MeshData, SheetView, Shell, TextItem, VsfxModel } from './types';

/** Viewport: ma trận mô hình -> giấy (nhìn theo +Y từ phía nam: X→x, Z→y, tỉ lệ s, dời (a, b));
 *  z' = −kz·(Y − y0) để vật gần camera (Y nhỏ) đứng trên khi nhìn từ trên xuống (đúng che khuất bằng depth test). */
function viewMatrix(v: SheetView, M: THREE.Matrix4): THREE.Matrix4 {
  const { s, a, b, y0 } = v;
  // độ sâu nén mạnh (kz ≪ s): mặt/đường vẫn che nhau đúng theo depth test nhưng nằm gần như phẳng — camera bản vẽ là phối cảnh nên
  // nếu để z' = −s·Y thì tấm địa hình dài vài chục ft lệch hẳn ra ngoài khung khi nhìn xiên.
  const kz = s * 0.02;
  return new THREE.Matrix4().set(s, 0, 0, a,  0, 0, s, b,  0, -kz, 0, kz * y0,  0, 0, 0, 1).multiply(M);
}

/** Chú thích của view (đầu level, vòng tròn lưới, chữ…) có kích thước tính theo TỈ LỆ IN (cao chữ 0.0098 ft = 3 mm giấy): chỉ VỊ TRÍ được chiếu và
 *  nhân tỉ lệ s, còn hình dạng giữ nguyên kích thước giấy. (Nhân s cho cả hình thì chữ và vòng tròn nhỏ đi 100 lần.) */
function annMatrix(v: SheetView, M: THREE.Matrix4): THREE.Matrix4 {
  const { s, a, b, y0 } = v, kz = s * 0.02, e = M.elements;
  const lin = M.clone(); lin.setPosition(0, 0, 0);
  const A = new THREE.Matrix4().set(1, 0, 0, 0,  0, 0, 1, 0,  0, -kz / s, 0, 0,  0, 0, 0, 1).multiply(lin);
  return A.setPosition(a + s * e[12], b + s * e[14], -kz * (e[13] - y0));
}

/** Shell/đường có kích thước local < 0.5 ft là hình tính theo tỉ lệ in (xem annMatrix). */
function isPaperSized(sh: Shell): boolean {
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
  const texts: TextItem[] = [];

  instances.forEach((ins, ii) => {
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
    const id = idOf[ii];
    ins.parts.forEach(part => {
      // viewport: mô hình xuất ở kiểu "hidden line" — mặt, chữ, đường đều TRẮNG (nét đen do cạnh); trên giấy trắng chữ/đường trắng sẽ vô hình,
      // nên chữ và đường của viewport luôn vẽ đen như ảnh gốc (mặt vẫn giữ màu file: trắng, kính xanh).
      // nhãn view trên giấy: ảnh gốc vẽ xanh lá (màu này không có trong bản ghi màu của file — hiệu chỉnh theo ảnh): chữ dài (không phải "1 : 100"/số) và đường
      const labelInk = ins.viewLabel ? 0x008000 : 0;
      const lineInk = view ? 0x0a0a0a : 0;
      const color = debugColors ? new THREE.Color().setHSL((ii * 0.618) % 1, .55, .6).getHex() : view && part.opacity !== undefined && part.opacity < 1 ? 0xd2e9f6 : (part.color || 0xb0b0b0);   // kính trong viewport: xanh nhạt như ảnh gốc (file lưu trắng)
      const buckets: Record<ChunkKind, number[]> = { opaque: [], glass: [], faceCol: [], wire: [] };
      const fcol: number[] = [];
      const alpha = part.opacity ?? -1;     // ≥ 0: vật liệu trong file có độ đục < 1 (kính, khối trong suốt)
      for (const sh of part.shells) {
        if (!(sh.text?.abs) && !yIn(sh)) continue;
        if (sh.text?.abs && !view) continue;   // chữ toạ độ mô hình chỉ có nghĩa trong viewport
        if (sh.text?.abs && view) {
          // nhãn level thứ cấp: x = X, y = Z (toạ độ mô hình), cao chữ theo đơn vị mô hình -> chiếu có nhân tỉ lệ s, trục chữ = trục giấy
          const px = view.a + view.s * sh.verts[0], py = view.b + view.s * sh.verts[1];
          if (px < view.crop[0] || px > view.crop[2] || py < view.crop[1] || py > view.crop[3]) continue;
          texts.push({ entity: id, color: lineInk || color, text: sh.text.s, height: sh.text.h * view.s, origin: [px, py, 0], ax: [1, 0, 0], ay: [0, 1, 0] });
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
          if (view && Ml === M) {
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
          if (view && !sh.circle) {
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
            if (seg) { if (dashed) dashSeg(seg[0], seg[1], 0.03, 0.012, w); else w.push(...seg[0], ...seg[1]); }
          }
          continue;
        }
        const glass = glassOn && !debugColors && (alpha >= 0 || isGlass(part.color, sh, unitMM));
        const faceColors = debugColors ? null : sh.faceColors;
        const tri = triangulateShell(sh), out = buckets[faceColors ? 'faceCol' : glass ? 'glass' : 'opaque'];
        const triFace = sh.triFace ?? [];
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
        tri.forEach((vi, k) => {
          v.set(sh.verts[vi * 3], sh.verts[vi * 3 + 1], sh.verts[vi * 3 + 2]).applyMatrix4(M);
          out.push(v.x, v.y, v.z);
          if (faceColors) {
            const fc = faceColors[triFace[(k / 3) | 0]];
            c3.setHex(fc ?? color, THREE.SRGBColorSpace);
            fcol.push(c3.r, c3.g, c3.b);
          }
        });
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

  // Hatch gạch của mặt cắt địa hình trong từng viewport (vẽ như đường đen, thuộc đối tượng đầu tiên của view)
  if (model.sheet && model.views) {
    for (const view of model.views) {
      const cut = terrainCut(view, instances);
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
    normals: concat(a.nor, a.vCount * 3),
    colors: a.kind === 'faceCol' ? concat(a.col, a.vCount * 3) : null,
    edges: concat(a.edg, a.eCount * 3),
    ranges: new Uint32Array(a.ranges),
  }));
  return { chunks, entities, handles, texts, sheet: !!model.sheet };
}

/** Danh sách ArrayBuffer cần chuyển giao (transfer) khi gửi MeshData qua postMessage. */
export function meshDataTransferables(data: MeshData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const c of data.chunks)
    for (const a of [c.positions, c.normals, c.colors, c.edges, c.ranges]) if (a) out.add(a.buffer as ArrayBuffer);
  return [...out];
}
