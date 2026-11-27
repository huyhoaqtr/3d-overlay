/* Nhánh OdTv (file ODA Visualize xuất từ Revit).
 * Suy ra từ revit.vsfx, kiểm chứng bằng bảng extents (handle + bbox) trong file:
 *  - Bản ghi bắt đầu bằng 50 00 11. Handle riêng:
 *      A: 50 00 11 00 00 …(10×00) 0C 02 00 00 00 [u32 h]       C: 50 00 11 01 01 … 0C 02 00 00 00 [h]
 *      B (chứa hình học): sau 4 điểm (0B + 3 double) và 3 byte 0 là [u64 h]
 *  - Danh sách con: [C0..C3] FF FF 00 00 [u32 n] rồi n × (12 00 00 00 00 08 00 00 00 00 [u64 h]),
 *    sau đó 00 00 hoặc 01 01 + ma trận (3 double tịnh tiến + 9 double xoay) của bản ghi.
 *  - Handle cấp tuần tự theo DFS => cây con của H chiếm khoảng [H, anh-em-kế-tiếp).
 *    Bản ghi có handle = model space (handle phổ biến nhất) đánh dấu về cấp cao nhất.
 *  - Hình học g nhận tích các ma trận của mọi H (cùng phạm vi cấp cao) có H ≤ g < end(H).
 *  - Màu: 0D 04 00 00 [f1 f2] 00 [B G R] C2 (f1 & 0x40 = kế thừa) và FF FF FF FF [B G R] C2 FF.
 *    000000 = "không đặt màu" -> dùng màu diffuse của vật liệu (handle 8 byte trước `18 00 1D`).
 *  - Đơn vị: feet (đơn vị nội bộ Revit) nếu file không có bản ghi đơn vị. */
import * as THREE from 'three';
import { views, scanTransforms, lastLE, identity } from './scan';
import { detectUnitMM } from './units';
import type { Instance, SheetView, Shell, VsfxModel } from './types';

interface TvRecord {
  o: number;
  end: number;
  h: number | null;
  kids: number[];
}

interface Holder {
  H: number;
  E: number;
  M: THREE.Matrix4;
}

function scanRecords(raw: Uint8Array): TvRecord[] {
  const L = raw.length, { u32 } = views(raw);
  const isPfx = (q: number) => raw[q] === 0x0c && raw[q + 1] === 0x02 && !raw[q + 2] && !raw[q + 3] && !raw[q + 4];
  // Bản ghi mở đầu bằng 50 00 11 (mọi file Revit mẫu). File BẢN VẼ (sheet3.vsfx: 8 546 bản ghi 40 00 11, chỉ 32 cái 50 00 11 là
  // byte lẫn trong dữ liệu) dùng 40 00 11 — bỏ qua thì không có cây bản ghi, mọi ma trận/handle mất, cả mô hình dồn về gốc toạ độ.
  // Chỉ chuyển sang 40 khi nó áp đảo hẳn: file_1/file_5 có lẻ tẻ vài bản ghi 40 (1 và 357) mà nhận vào sẽ đổi ma trận của 4 / 204 shell.
  let n50 = 0, n40 = 0;
  for (let o = 0; o + 40 <= L; o++)
    if (raw[o + 1] === 0x00 && raw[o + 2] === 0x11) { if (raw[o] === 0x50) n50++; else if (raw[o] === 0x40) n40++; }
  const lead = n40 > 4 * n50 ? 0x40 : 0x50;
  const starts: number[] = [];
  for (let o = 0; o + 40 <= L; o++)
    if (raw[o] === lead && raw[o + 1] === 0x00 && raw[o + 2] === 0x11) starts.push(o);
  return starts.map((o, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : L;
    const r: TvRecord = { o, end, h: null, kids: [] };
    // Phần B (chứa hình học): 0C 02 [≠0] … rồi 4 điểm (0B + 3 double) + 3 byte 0 + [u64 h]
    const findB = (from: number): number | null => {
      for (let q = from; q < Math.min(from + 220, end - 110); q++)
        if (raw[q] === 0x0b && raw[q + 25] === 0x0b && raw[q + 50] === 0x0b && raw[q + 75] === 0x0b &&
            !raw[q + 100] && !raw[q + 101] && !raw[q + 102]) return u32(q + 103);
      return null;
    };
    if (raw[o + 15] === 0x0c && raw[o + 16] === 0x02 && (raw[o + 17] || raw[o + 18])) {   // B
      r.h = findB(o + 20);
    } else {
      for (let q = o; q < Math.min(o + 800, end - 9); q++) if (isPfx(q)) { r.h = u32(q + 5); break; }
      // Bản ghi gộp C + B (mở đầu 50 00 11 01 01 … màu đối tượng, phần B nằm sau ~95 byte): không có tiền tố
      // 0C 02 00 00 00 nên trước đây h = null -> hình học mất ma trận (thành bồn tắm revit.vsfx nằm ở gốc toạ độ).
      if (r.h == null)
        for (let q = o; q < Math.min(o + 400, end - 120); q++)
          if (raw[q] === 0x0c && raw[q + 1] === 0x02 && (raw[q + 2] || raw[q + 3])) {
            r.h = findB(q + 5);
            if (r.h != null) break;
          }
    }
    const lim = Math.min(end, o + 4000);
    for (let q = o; q + 26 <= lim; q++) {
      if (raw[q] < 0xc0 || raw[q] > 0xc3 || raw[q + 1] !== 0xff || raw[q + 2] !== 0xff || raw[q + 3] || raw[q + 4]) continue;
      const n = u32(q + 5);
      let p = q + 9;
      if (n < 1 || n > 100000 || raw[p] !== 0x12 || raw[p + 5] !== 0x08) continue;
      for (let k = 0; k < n && p + 18 <= end; k++, p += 18) {
        if (raw[p] !== 0x12 || raw[p + 5] !== 0x08) break;
        r.kids.push(u32(p + 10));
      }
      break;
    }
    return r;
  });
}

/* Vật liệu: từ điển "GeneratedMaterial__N" + u64 handle; bản ghi vật liệu: tên, 00 00,
 * 01 [double] [B G R] C2 (ambient), 01 [double] [B G R] C2 (diffuse). Trả Map handle -> diffuse. */
function scanMaterials(raw: Uint8Array, opacityOut?: Map<number, number>): Map<number, number> {
  const L = raw.length, { u32 } = views(raw);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const nameOpacity = new Map<string, number>();
  const nameHandle = new Map<string, number>(), nameDiffuse = new Map<string, number>(), out = new Map<number, number>();
  const GM = 'GeneratedMaterial__';
  for (let q = 0; q + 60 < L; q++) {
    if (raw[q] !== 0x47 || raw[q + 1] !== 0) continue;
    let k = 0;
    for (; k < GM.length; k++) if (raw[q + k * 2] !== GM.charCodeAt(k) || raw[q + k * 2 + 1]) break;
    if (k < GM.length) continue;
    let e = q + GM.length * 2, num = '';
    while (raw[e] >= 0x30 && raw[e] <= 0x39 && !raw[e + 1]) { num += String.fromCharCode(raw[e]); e += 2; }
    if (!num) continue;
    if (raw[e] === 0 && raw[e + 1] === 0 && raw[e + 2] === 1 && raw[e + 14] === 0xc2 && raw[e + 15] === 1 && raw[e + 27] === 0xc2)
{
      nameDiffuse.set(num, (raw[e + 26] << 16) | (raw[e + 25] << 8) | raw[e + 24]);
      // Độ đục: f64 ở +478 sau tên vật liệu (1 = đặc; kính Revit 828d89 = 0.35). Chỉ đúng với biến thể bản ghi có f64 ở +172 >= 1
      // (biến thể còn lại có 0.1/0.5 ở đó và +478 = 0, không phải độ đục). Suy ra từ revit.vsfx + school.vsfx, chưa có spec.
      if (e + 486 <= L && dv.getFloat64(e + 172, true) >= 1) {
        const a = dv.getFloat64(e + 478, true);
        // 0 = trong suốt 100% (Revit transparency 100%; vd khối 延焼ライン ở file_2.vsfx) — từng bị bỏ qua, vẽ thành khối đặc
        if (a >= 0 && a < 1) nameOpacity.set(num, a);
      }
    }
    else if (!nameHandle.has(num)) nameHandle.set(num, u32(e));
    q = e - 1;
  }
  for (const [n, h] of nameHandle) {
    const d = nameDiffuse.get(n);
    if (d !== undefined) out.set(h, d);
    const a = nameOpacity.get(n);
    if (a !== undefined && d !== undefined) opacityOut?.set(h, a);
  }
  return out;
}

/* Header hình học `18 00 1D`: 8 byte trước nó là handle vật liệu. Trả danh sách { o, c } (c = màu diffuse của
 * vật liệu đó), sắp theo offset; dùng làm màu cho shell không có màu entity (màu 0). */
function scanMaterialUse(raw: Uint8Array, materials: Map<number, number>, opacity: Map<number, number>): { o: number; c: number; a: number }[] {
  const out: { o: number; c: number; a: number }[] = [], { u32 } = views(raw);
  for (let q = 8; q + 3 <= raw.length; q++) {
    if (raw[q] !== 0x18 || raw[q + 1] !== 0 || raw[q + 2] !== 0x1d) continue;
    const h = u32(q - 8), c = materials.get(h);
    if (c !== undefined) out.push({ o: q, c, a: opacity.get(h) ?? 1 });
  }
  return out;
}

/** Bản ghi màu của chính hình học, ngay trước header shell (byte 0C ở `h`):
 *  0D [04|06] 00 00 [f1 f2] 00 [B G R] Cx. (Suy luận từ revit.vsfx + school.vsfx, chưa có spec.)
 *   - `material`: f2 = 02 + màu 000000 -> lấy theo vật liệu, bỏ màu đối tượng (cây/bụi/người);
 *   - `base`: f1 = CB, f2 = 07, Cx = C2, màu ≠ 0 -> MÀU NỀN của đối tượng, áp cho shell này và các shell sau
 *     cùng phạm vi không tự đặt màu (vd tường nâu gạch 804020 ở revit.vsfx, tường trắng f4f4f4 ở school.vsfx).
 *     Bit 0x40 của f1 KHÔNG có nghĩa "kế thừa" khi có màu — từng bỏ sót các màu này;
 *   - `unset`: không có bản ghi, hoặc f1 = f2 = 00 + màu 000000 -> dùng màu nền nếu đối tượng có (mặt ngoài tường 34);
 *   - `other`: còn lại, vd 81/00 (màu riêng của mặt: mặt trong trắng, mặt cắt lõi xám) — giữ logic cũ.
 *   - `own`: 8B/03 + màu (school.vsfx: cửa) -> màu RIÊNG của đúng shell mang bản ghi (cánh cửa be e6c19e, khung nâu 994c2b;
 *     trước đây cánh cửa bị đổ màu khung vì bỏ qua bản ghi này, xác nhận bằng ảnh chuẩn của người dùng). KHÔNG dính sang
 *     các shell sau (thử dính như CB/07: đổi 12 289 shell, kể cả 6 744 shell kính -> sai) và bỏ qua với vật liệu trong suốt
 *     (kính mang màu giữ chỗ 0080C0, giữ màu theo vật liệu như trước). */
type GeometryColor = { k: 'material' } | { k: 'base'; c: number } | { k: 'own'; c: number } | { k: 'unset' } | { k: 'other' };
function geometryColor(raw: Uint8Array, h: number): GeometryColor {
  for (let q = h - 1; q >= Math.max(0, h - 48); q--) {
    if (raw[q] !== 0x0d || (raw[q + 1] !== 4 && raw[q + 1] !== 6) || raw[q + 2] || raw[q + 3] || raw[q + 6]) continue;
    const c = (raw[q + 9] << 16) | (raw[q + 8] << 8) | raw[q + 7], f1 = raw[q + 4], f2 = raw[q + 5];
    if (f2 === 2 && !c) return { k: 'material' };
    if (f1 === 0xcb && f2 === 7 && raw[q + 10] === 0xc2 && c) return { k: 'base', c };
    if (f1 === 0x8b && f2 === 3 && raw[q + 10] === 0xc2 && c) return { k: 'own', c };
    if (!f1 && !f2 && !c) return { k: 'unset' };
    return { k: 'other' };
  }
  return { k: 'unset' };
}

/** Màu của đường gấp khúc (kiểu 05): bản ghi `0D 04|06 00 00 [f1 f2] 00 [B G R] C2` ngay trước header; -1 nếu không có.
 *  000000 là màu đen thật (file_5.vsfx: 118 đường đen) chứ không phải "không đặt màu" như ở shell. */
function lineColor(raw: Uint8Array, h: number): number {
  for (let q = h - 1; q >= Math.max(0, h - 60); q--) {
    if (raw[q] !== 0x0d || (raw[q + 1] !== 4 && raw[q + 1] !== 6) || raw[q + 2] || raw[q + 3] || raw[q + 6] || (raw[q + 10] !== 0xc2 && raw[q + 10] !== 0xc0)) continue;
    if (raw[q + 10] === 0xc0) return -1;   // ByLayer: không có màu riêng -> dùng màu đối tượng
    return (raw[q + 9] << 16) | (raw[q + 8] << 8) | raw[q + 7];
  }
  return -1;
}

function scanColors(raw: Uint8Array): { o: number; c: number }[] {
  const L = raw.length, colors: { o: number; c: number }[] = [];
  for (let q = 17; q + 12 <= L; q++) {
    if (raw[q] === 0x0d && raw[q + 1] === 0x04 && !raw[q + 2] && !raw[q + 3] && !raw[q + 6] && raw[q + 10] === 0xc2) {
      const c = (raw[q + 9] << 16) | (raw[q + 8] << 8) | raw[q + 7];
      // Header kế thừa / màu 0: không đổi màu hiện tại. (Màu diffuse vật liệu làm dự phòng
      // khiến cây bị tô be, khác ảnh tham chiếu -> không dùng.)
      if (!(raw[q + 4] & 0x40) && c !== 0) colors.push({ o: q, c });
    } else if (raw[q] === 0xff && raw[q + 1] === 0xff && raw[q + 2] === 0xff && raw[q + 3] === 0xff &&
               raw[q + 7] === 0xc2 && raw[q + 8] === 0xff) {
      const c = (raw[q + 6] << 16) | (raw[q + 5] << 8) | raw[q + 4];
      if (c) colors.push({ o: q, c });
    }
  }
  return colors;
}

const hexHandle = (h: number | undefined) => (h == null ? undefined : '0x' + h.toString(16));

/* Phần tử Revit: bản ghi chứa `01 01 00 00 00 73 | 00×7 | 08 00 00 00 | u32 Element ID`, sau đó (≤ 40 byte)
 * `0C 02 00 00 00 [u32 handle CSDL]`. Cùng cấu trúc với node IFC (handle nguồn ở sau `08 00 00 00`). Có cho cả
 * system family (tường, mái…: bản ghi mở đầu 50 00 11 00 00 01 01) lẫn family instance (ghế, cửa, cây: nằm trong
 * bản ghi C). Xác nhận bằng viewer gốc: mái revit.vsfx = 243274 (handle CSDL 0x18c). Trả danh sách sắp theo handle CSDL. */
function scanElements(raw: Uint8Array): { db: number; id: number }[] {
  const { u32 } = views(raw), out: { db: number; id: number }[] = [];
  const SIG = [1, 1, 0, 0, 0, 0x73, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0];
  outer: for (let o = 0; o + 80 <= raw.length; o++) {
    for (let k = 0; k < SIG.length; k++) if (raw[o + k] !== SIG[k]) continue outer;
    for (let q = o + 21; q < o + 60; q++)
      if (raw[q] === 0x0c && raw[q + 1] === 2 && !raw[q + 2] && !raw[q + 3] && !raw[q + 4]) {
        out.push({ db: u32(q + 5), id: u32(o + 17) });
        break;
      }
  }
  return out.sort((a, b) => a.db - b.db);
}

/* Tên phần tử trong cây CDA: `03 04 [u64 Element ID] [u16 số ký tự] tên UTF-16` với tên kết thúc bằng "[id]"
 * (vd "Basic Roof : SG Metal Panels roof [243274]"). */
function scanElementNames(raw: Uint8Array): Map<number, string> {
  const { u32 } = views(raw), out = new Map<number, string>();
  for (let q = 0; q + 12 <= raw.length; q++) {
    if (raw[q] !== 3 || raw[q + 1] !== 4 || raw[q + 6] || raw[q + 7] || raw[q + 8] || raw[q + 9]) continue;
    const id = u32(q + 2), len = raw[q + 10] | (raw[q + 11] << 8);
    if (!id || len < 4 || len > 200 || q + 12 + len * 2 > raw.length) continue;
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(raw[q + 12 + i * 2] | (raw[q + 13 + i * 2] << 8));
    const tag = `[${id}]`;
    if (s.endsWith(tag)) out.set(id, s.slice(0, -tag.length).trim());
  }
  return out;
}

export function parseTv(raw: Uint8Array, shells: Shell[]): VsfxModel {
  const recs = scanRecords(raw);
  const cnt = new Map<number, number>();
  for (const r of recs) if (r.h != null) cnt.set(r.h, (cnt.get(r.h) ?? 0) + 1);
  const MO = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // cây handle: cha + anh em kế tiếp -> end(H)
  const parent = new Map<number, number | null>(), next = new Map<number, number | null>();
  for (const r of recs) r.kids.forEach((k, i) => { parent.set(k, r.h); next.set(k, i + 1 < r.kids.length ? r.kids[i + 1] : null); });
  /** a là tổ tiên của b? (đi ngược cha từ b, tối đa 500 bước) */
  const isAncestor = (a: number, b: number) => {
    let x: number | null | undefined = b;
    for (let d = 0; d < 500 && x != null; d++) { x = parent.get(x); if (x === a) return true; }
    return false;
  };
  const endMemo = new Map<number, number>();
  const endOf = (h: number): number => {
    const chain: number[] = [];
    let x = h, res = Infinity;
    for (let d = 0; d < 500; d++) {
      const memo = endMemo.get(x);
      if (memo !== undefined) { res = memo; break; }
      chain.push(x);
      const s = next.get(x);
      if (s != null) { res = s; break; }
      const p = parent.get(x);
      if (p == null || p === x) break;
      x = p;
    }
    for (const c of chain) endMemo.set(c, res);
    return res;
  };

  const recAt = (o: number) => lastLE(recs, o, r => r.o);
  const tops = recs.filter(r => r.h === MO).map(r => r.o);
  // Handle đối tượng cấp cao = con của model space; đối tượng chứa hình học g = con lớn nhất ≤ g (handle cấp theo DFS)
  const topKids = [...new Set(recs.filter(r => r.h === MO).flatMap(r => r.kids))].sort((x, y) => x - y);
  const topOf = (g: number) => { const i = lastLE(topKids, g, identity); return i >= 0 ? topKids[i] : undefined; };
  // Phần tử Revit chứa đối tượng = bản ghi phần tử có handle CSDL lớn nhất ≤ handle đối tượng (handle cấp theo DFS)
  const elements = scanElements(raw), elementNames = scanElementNames(raw);
  const elementOf = (h: number | undefined) => {
    if (h == null) return undefined;
    const i = lastLE(elements, h, e => e.db);
    return i >= 0 ? elements[i] : undefined;
  };
  const scopeOf = (o: number) => lastLE(tops, o, identity);

  const holders = new Map<number, Holder[]>();   // scope -> các bản ghi mang ma trận
  let nxf = 0;
  scanTransforms(raw, 0, (o, M) => {
    nxf++;
    const ri = recAt(o), H = ri >= 0 ? recs[ri].h : null;
    if (H == null) return;
    const sc = scopeOf(o);
    const list = holders.get(sc) ?? [];
    list.push({ H, E: endOf(H), M });
    holders.set(sc, list);
  });

  const opacity = new Map<number, number>();
  const materials = scanMaterials(raw, opacity);
  const colors = scanColors(raw);
  const matUse = scanMaterialUse(raw, materials, opacity);

  // gán ma trận + màu cho từng shell; gom các shell liền nhau giống nhau thành instance
  const instances: Instance[] = [], ident = new THREE.Matrix4(), mCache = new Map<string, THREE.Matrix4>();
  const groupIds = new Map<string, number>();
  const groupOf = (k: string) => { let g = groupIds.get(k); if (g === undefined) groupIds.set(k, g = groupIds.size); return g; };
  let ci = -1, curColor = 0, lastScope = -2, baseColor = 0, ownColor = 0, glassColor = 0;   // baseColor: màu nền đối tượng (bản ghi CB/07), theo phạm vi
  for (const sh of shells) {
    const sc = scopeOf(sh.off);
    while (ci + 1 < colors.length && colors[ci + 1].o < sh.off) {
      ci++;
      if (scopeOf(colors[ci].o) === sc) curColor = colors[ci].c;
    }
    if (sc !== lastScope) { lastScope = sc; baseColor = 0; ownColor = 0; glassColor = 0; if (ci < 0 || scopeOf(colors[ci].o) !== sc) curColor = 0; }
    const ri = recAt(sh.off), g = ri >= 0 ? recs[ri].h : null;
    let list = g != null ? (holders.get(sc) ?? []).filter(x => x.H <= g && g < x.E).sort((a, b) => a.H - b.H) : [];
    // Holder không tìm được điểm kết thúc (E = ∞: cây con không dò ra anh em kế tiếp) là các nhánh ANH EM nhau
    // (vd mỗi cái ghế quanh bàn có ma trận tuyệt đối riêng), không phải lồng nhau -> chỉ giữ cái gần hình học nhất.
    // Bản cũ cộng dồn hết nên ghế bị đặt lệch tới hàng trăm đơn vị (school.vsfx, kiểm bằng bảng extents).
    const open = list.filter(x => x.E === Infinity);
    if (open.length > 1) { const keep = open[open.length - 1]; list = list.filter(x => x.E !== Infinity || x === keep); }
    // Holder mở còn lại chỉ giữ nếu nó thật sự là TỔ TIÊN của holder đóng phía sau (theo cha–con trong cây bản ghi);
    // không thì là nhánh anh em -> bỏ. Thiếu bước này, file_1.vsfx (~990 instance: lan can, chi tiết…) nhận cả ma trận
    // của anh em lẫn của chính nó -> vị trí bị nhân đôi, lơ lửng ngoài toà nhà.
    const closed = list.filter(x => x.E !== Infinity);
    if (closed.length) list = list.filter(x => x.E !== Infinity || closed.every(c => c.H < x.H || isAncestor(x.H, c.H)));
    // Tương tự với chính bản ghi hình học g: biết cha của g thì holder mở chỉ giữ khi nó — hoặc bản ghi NGAY SAU nó —
    // nằm trên chuỗi cha của g. Bản ghi mang ma trận thường đứng ngay trước "thân" đối tượng (cây revit.vsfx: ma trận
    // 7530, cha của hình học 7531). Không thì là anh em -> bỏ (tay vịn file_1.vsfx bị áp ma trận thanh con tiện 1711).
    if (g != null && parent.has(g)) {
      const anc = new Set<number>([g]);
      for (let x: number | null | undefined = g, d = 0; d < 500 && x != null; d++) { x = parent.get(x); if (x != null) anc.add(x); }
      list = list.filter(x => x.E !== Infinity || anc.has(x.H) || anc.has(x.H + 1));
    }
    let M = ident, ck = sc + ':';
    if (list.length) {
      ck += list.map(x => x.H).join(',');
      let acc = mCache.get(ck);
      if (!acc) { acc = new THREE.Matrix4(); for (const x of list) acc.multiply(x.M); mCache.set(ck, acc); }
      M = acc;
    }
    // Không có màu entity (0): lấy màu diffuse của vật liệu gần nhất phía trước shell
    // Bản ghi màu của chính hình học, ngay trước header shell: 0D [04|06] 00 00 [f1 f2] 00 [B G R] Cx.
    // f2 = 02 + màu 000000: hình học KHÔNG lấy màu đối tượng (FF FF FF FF …) mà lấy theo vật liệu. Chỉ gặp ở
    // cây / bụi / người (revit.vsfx: đúng 10 shell; school.vsfx: các cây) — từng làm 1 cây be, 1 cây vàng trong khi
    // ảnh chuẩn đều xám. Shell thường có f2 = 03 kèm màu thật. (Suy luận từ 2 file, chưa có spec.)
    const gc = geometryColor(raw, sh.off - 9);
    // đường gấp khúc (kiểu 05) có bản ghi màu riêng, không được làm nhiễu màu dính (baseColor/ownColor) của các shell
    if (!sh.line && !sh.text && gc.k === 'base') { baseColor = gc.c; ownColor = 0; }
    if (!sh.line && !sh.text && gc.k === 'own') { ownColor = gc.c; baseColor = 0; }
    let col = gc.k === 'material' ? 0 : gc.k === 'base' ? gc.c : gc.k === 'unset' && baseColor ? baseColor : curColor, alpha = 1;
    const mi = lastLE(matUse, sh.off, x => x.o), mat = mi >= 0 && scopeOf(matUse[mi].o) === sc ? matUse[mi] : null;
    const glassMat = !!mat && mat.a < 1;
    const hadCol = col !== 0;
    if (mat) { if (!col) col = glassMat && glassColor ? glassColor : mat.c; alpha = mat.a; }
    // 8B/03: màu riêng của shell. Với kính (vật liệu trong suốt) chỉ áp khi shell chưa có màu nào khác (màu rơi về vật liệu
    // xám 828d89), và màu đó dính sang các shell kính sau cùng phạm vi — kính school.vsfx là 0080C0 như các file khác.
    if (glassMat) { if (gc.k === 'own' && !hadCol) { col = gc.c; glassColor = gc.c; } }
    else if (gc.k === 'own') col = gc.c;
    else if (gc.k === 'unset' && ownColor) col = ownColor;
    // Shell có màu / vật liệu ghi ngay trong header của nó: ưu tiên hơn màu entity (giống màu theo face)
    if (sh.color) col = sh.color;
    // Chữ: màu trong bản ghi màu; không có -> đen (màu đối tượng ở đây là trắng của khung giấy, từng làm "A103" trắng trên giấy trắng).
    // Màu xanh lá của nhãn view KHÔNG nằm trong bản ghi màu hay vật liệu gần đó (đã dò) -> hiệu chỉnh theo ảnh ở meshData (viewLabel).
    if (sh.text) { const tc = lineColor(raw, sh.off - 2); col = tc > 0 ? tc : 0x0a0a0a; alpha = 1; }
    if (sh.line) { const lc = lineColor(raw, sh.off - 9); col = lc >= 0 ? (lc || 0x0a0a0a) : (curColor || 0x0a0a0a); alpha = 1; }
    if (sh.mat !== undefined && materials.has(sh.mat)) alpha = opacity.get(sh.mat) ?? 1;
    const last = instances[instances.length - 1], grp = groupOf(ck);
    if (last && last.M === M && last.group === grp && last.parts[0].color === col && (last.parts[0].opacity ?? 1) === alpha) last.parts[0].shells.push(sh);
    else {
      // handle CSDL của đối tượng: bản ghi mang ma trận gần nhất (vd từng cái ghế), không có thì đối tượng cấp cao
      const dbh = list.length ? list[list.length - 1].H : g != null ? topOf(g) : undefined;
      // Phần tử tra theo handle của CHÍNH bản ghi hình học (g): handle holder/cấp cao có thể nhỏ hơn bản ghi phần tử
      // (mặt đất revit.vsfx: phần tử 0x196 = 411452 nằm sau, tra theo dbh rơi về mái 0x18c = 243274).
      const el = elementOf(g ?? dbh);
      instances.push({
        parts: [{ color: col, opacity: alpha < 1 ? alpha : undefined, shells: [sh] }], M, group: grp,
        // ID hiển thị = Element ID của Revit (thập phân); không có phần tử thì dùng handle CSDL (hex)
        name: (el && elementNames.get(el.id)) ?? 'tv',
        handle: el ? String(el.id) : hexHandle(dbh),
        dbHandle: dbh,
      });
    }   // cùng scope + cùng chuỗi ma trận = một đối tượng (vd ghế = mặt ghế + chân khác màu)
  }
  removeTextPlates(instances);
  // Mọi bước sau làm việc trên danh sách ĐÃ BỎ instance rỗng — đúng danh sách mà meshData dùng (chỉ số from/to của view phải khớp)
  const live = instances.filter(i => i.parts.some(p => p.shells.length));
  if (shells.some(sh => sh.text)) inheritLostMatrices(live);   // file bản vẽ
  const sheet = markPaperSpace(live);
  const views = sheet ? markViews(live) : undefined;
  if (views) fixHeadTexts(live, views);
  return {
    format: 'OdTv (Revit)', sheet, views, shells, instances: live, records: recs.length, transforms: nxf,
    inserts: 0, skipped: 0, unitMM: detectUnitMM(raw) ?? 304.8, materials,
  };
}

/* Chữ Revit (family "Model Text : …") được xuất kèm một "tấm nền" hộp ngay sau chữ: đúng 5 shell 4 đỉnh (3 mặt ngang + 2 mặt
 * đứng) phủ kín bbox của cả dòng chữ — vẽ ra thành nền trắng đục đằng sau chữ (file_1.vsfx: cả 7 đối tượng chữ đều có đúng 5
 * shell này, vd 2184042 "Snowdon Towers"). Người dùng chỉ muốn thấy chữ -> bỏ các shell đó. Nhận diện: shell ≤ 8 đỉnh có chiều
 * dài (theo trục dài nhất của cả đối tượng) ≥ 90% chiều dài đối tượng; đối tượng phải có ≥ 20 shell để một chữ cái đơn lẻ
 * (vd dấu gạch "—", chữ "l") không bị xoá nhầm. Suy luận từ 7 đối tượng của file_1, chưa có spec. */
function removeTextPlates(instances: Instance[]) {
  const byHandle = new Map<string, Instance[]>();
  for (const ins of instances) {
    if (!ins.name.startsWith('Model Text') || !ins.handle) continue;
    const l = byHandle.get(ins.handle);
    if (l) l.push(ins); else byHandle.set(ins.handle, [ins]);
  }
  for (const list of byHandle.values()) {
    const items: { shell: Shell; b: number[] }[] = [];
    const B = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const ins of list) {
      const e = ins.M.elements;
      for (const p of ins.parts) for (const sh of p.shells) {
        const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], v = sh.verts;
        for (let k = 0; k + 2 < v.length; k += 3)
          for (let d = 0; d < 3; d++) {
            const w = e[d] * v[k] + e[d + 4] * v[k + 1] + e[d + 8] * v[k + 2] + e[d + 12];
            if (w < b[d]) b[d] = w;
            if (w > b[d + 3]) b[d + 3] = w;
          }
        items.push({ shell: sh, b });
        for (let d = 0; d < 3; d++) { if (b[d] < B[d]) B[d] = b[d]; if (b[d + 3] > B[d + 3]) B[d + 3] = b[d + 3]; }
      }
    }
    if (items.length < 20) continue;
    const ext = [0, 1, 2].map(d => B[d + 3] - B[d]);
    const D = ext.indexOf(Math.max(...ext));
    const plate = new Set<Shell>();
    for (const it of items)
      if (it.shell.verts.length <= 24 && it.b[D + 3] - it.b[D] >= 0.9 * ext[D]) plate.add(it.shell);
    if (!plate.size) continue;
    // Hộp gồm 8 shell liền nhau ở ĐUÔI danh sách shell của đối tượng (sau chữ cái cuối), theo thứ tự: mặt đầu trái, ngang,
    // đầu phải, ngang, ngang, mặt giữa, 2 mặt rộng — 5 cái dài đã bắt ở trên, 3 mặt đứng còn lại (trái, giữa, phải) không dài
    // nên không bắt được bằng chiều dài (từng để sót 3 vạch cam khi chọn). Cả 7 đối tượng của file_1 đều đúng 8 shell cuối;
    // chỉ lấy khi 8 shell cuối đều nhỏ (≤ 8 đỉnh) và chứa đủ các shell dài, để mặt bên của chữ không bị ăn nhầm.
    items.sort((a, b) => a.shell.off - b.shell.off);
    const tail = items.slice(-8);
    if (tail.length === 8 && tail.every(it => it.shell.verts.length <= 24) && [...plate].every(sh => tail.some(it => it.shell === sh)))
      for (const it of tail) plate.add(it.shell);
    for (const ins of list) for (const p of ins.parts) p.shells = p.shells.filter(sh => !plate.has(sh));
    for (const ins of list) ins.parts = ins.parts.filter(p => p.shells.length);
  }
}

/* File BẢN VẼ (Revit sheet; sheet3.vsfx): trang giấy (paper space) gồm khung + khung tên (đường) và chữ nằm trong toạ độ giấy (feet,
 * gốc ở góc dưới trái, A1 ≈ 2.76 × 1.95), còn mô hình 3D nằm ở toạ độ ±100 ft — thu nhỏ 1:100 qua viewport. Nhận diện:
 *  - KHUNG: instance có ≥ 8 đường phẳng, bbox local bắt đầu ở gốc (≈ 0,0), rộng ≥ 1 và dài/cao 1.2–1.6 (khung giấy);
 *  - trang giấy = mọi instance CÙNG handle với khung (chữ khung tên bị gán nhầm ma trận đặt tờ giấy vào không gian 3D (85.7, −7.2, 19.7)
 *    nên dùng toạ độ local = toạ độ giấy) + instance có đường/chữ mà bbox world (XY) nằm trong khung (nhãn "South", "1 : 100"…).
 * Trả true nếu tìm được khung. Suy luận từ một file (sheet3.vsfx), chưa có spec. */
function markPaperSpace(instances: Instance[]): boolean {
  let frame: Instance | null = null, fr: number[] = [], frameLines = 0;
  for (const ins of instances) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let lines = 0, other = 0;
    for (const p of ins.parts) for (const sh of p.shells) {
      if (!sh.line) { other++; continue; }
      lines++;
      for (let k = 0; k + 2 < sh.verts.length; k += 3)
        for (let d = 0; d < 3; d++) { if (sh.verts[k + d] < b[d]) b[d] = sh.verts[k + d]; if (sh.verts[k + d] > b[d + 3]) b[d + 3] = sh.verts[k + d]; }
    }
    if (lines < 8 || other) continue;
    const w = b[3] - b[0], h = b[4] - b[1], r = w / (h || 1);
    // nhiều ứng viên (khung cắt của từng view cũng dạng này, vd 12 đường 3.71 × 2.95): lấy cái nhiều đường nhất = khung giấy + khung tên
    if (w >= 1 && Math.abs(b[0]) < 0.05 * w && Math.abs(b[1]) < 0.05 * h && b[5] - b[2] < 1e-6 && r > 1.2 && r < 1.6 && lines > frameLines) { frame = ins; fr = b; frameLines = lines; }
  }
  if (!frame) return false;
  const w = fr[3] - fr[0], h = fr[4] - fr[1], ident = new THREE.Matrix4(), saved: [Instance, THREE.Matrix4][] = [];
  const placed: THREE.Matrix4[] = [];   // ma trận đặt tờ giấy vào không gian 3D (gán nhầm cho chữ khung tên)
  const lo = [fr[0] - 0.05 * w, fr[1] - 0.05 * h], hi = [fr[3] + 0.05 * w, fr[4] + 0.05 * h];
  for (const ins of instances) {
    if (ins.handle === frame.handle) {
      saved.push([ins, ins.M]);
      if (ins.M.elements.some((x, i) => Math.abs(x - ident.elements[i]) > 1e-9) && !placed.some(m => m.equals(ins.M))) placed.push(ins.M);
      ins.M = ident; ins.paper = true; continue;
    }
    let has2d = false;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], e = ins.M.elements;
    for (const p of ins.parts) for (const sh of p.shells) {
      if (sh.line || sh.text) has2d = true;
      for (let k = 0; k + 2 < sh.verts.length; k += 3)
        for (let d = 0; d < 3; d++) {
          const v = e[d] * sh.verts[k] + e[d + 4] * sh.verts[k + 1] + e[d + 8] * sh.verts[k + 2] + e[d + 12];
          if (v < b[d]) b[d] = v;
          if (v > b[d + 3]) b[d + 3] = v;
        }
    }
    if (has2d && b[0] >= lo[0] && b[1] >= lo[1] && b[3] <= hi[0] && b[4] <= hi[1]) { ins.paper = true; ins.viewLabel = true; }
  }
  // Các thực thể khác của trang giấy (đầu bảng sửa đổi "Description"/"Date", dòng bảng…) cũng mang đúng ma trận đặt tờ giấy ấy nhưng khác handle
  for (const ins of instances) {
    if (ins.paper || !placed.some(m => m.equals(ins.M))) continue;
    // chỉ nhận khi MỌI toạ độ local nằm trong khổ giấy (instance cùng ma trận nhưng có đường toạ độ mô hình tuyệt đối thì không phải giấy)
    let inside = true, far = false;
    for (const p of ins.parts) for (const sh of p.shells)
      for (let k = 0; k + 2 < sh.verts.length && inside; k += 3) {
        if (sh.verts[k] < lo[0] || sh.verts[k] > hi[0] || sh.verts[k + 1] < lo[1] || sh.verts[k + 1] > hi[1]) inside = false;
        if (Math.abs(sh.verts[k]) > 0.5 || Math.abs(sh.verts[k + 1]) > 0.5) far = true;
      }
    // chi tiết nhỏ kiểu in gần gốc (đầu level "Roof Line" của view Section: ma trận (85.7, −7.16, 19.69) TRÙNG ma trận đặt tờ giấy) cần chính ma trận đó -> không phải giấy
    if (!inside || !far) continue;
    saved.push([ins, ins.M]); ins.M = ident; ins.paper = true;
  }
  // Một khung giấy mà không có chữ khung tên thì không phải file bản vẽ (revit.vsfx có vài khung 2D tương tự): huỷ.
  let texts = 0;
  for (const ins of instances) if (ins.paper) for (const p of ins.parts) for (const sh of p.shells) if (sh.text) texts++;
  if (texts < 5) {
    for (const ins of instances) { ins.paper = undefined; ins.viewLabel = undefined; }
    for (const [ins, M] of saved) ins.M = M;
    return false;
  }
  return true;
}

/* Viewport của file bản vẽ — HIỆU CHỈNH THEO ẢNH GỐC (sheet3.vsfx), không đọc từ file:
 *  - mỗi view là một BẢN SAO cả mô hình; chú thích của view (lưới, level, chữ) nằm trên mặt phẳng y = y0 (−62.49 South, −7.16 Section) và
 *    đứng ở CUỐI bản sao nên instance cuối cùng của mặt phẳng đó đánh dấu hết bản sao (bản sao đầu: 0…; bản sau: ngay sau đó…);
 *  - tỉ lệ 1:100 (chữ " 1 : 100" của view); giấy = (a + s·X, b + s·Z) đo từ ảnh gốc: lưới 1…7 cách 9.84 ft → 0.0984 ft giấy, Level 1 ở y giấy 1.44 (South)
 *    và 0.671 (Section), lưới 1 ở x giấy 0.692 (a = 0.854);
 *  - khung cắt = vùng viewport suy từ ảnh (nhãn "South"/"Longitudinal Section" nằm dưới góc trái khung);
 *  - độ sâu cắt: ước lượng, chỉnh theo hình (nhà không hiện ở view South dù bản sao có đủ nhà).
 * Mặt phẳng lạ (không có trong bảng) -> bỏ qua, view đó không vẽ. */
const VIEW_PRESETS: { y0: number; a: number; b: number; crop: [number, number, number, number]; depth: number; slab: 'inside' | 'touch' | 'cut' }[] = [
  { y0: -62.49, a: 0.854, b: 1.44, crop: [0.1, 1.3, 1.9, 1.9], depth: 1, slab: 'inside' },
  { y0: -7.16, a: 0.854, b: 0.671, crop: [0.1, 0.52, 1.9, 1.12], depth: 0.3, slab: 'cut' },
];

function markViews(instances: Instance[]): SheetView[] {
  // mặt phẳng chú thích: instance không phải giấy, phẳng theo Y, có chữ
  const planes = new Map<number, number>();   // y0 (làm tròn 0.01) -> chỉ số instance cuối có chú thích
  instances.forEach((ins, i) => {
    if (ins.paper) return;
    let hasText = false;   // có chữ HOẶC đường (đường level phụ không có chữ đi kèm trong cùng instance nhưng vẫn nằm trên mặt phẳng view)
    let lo = Infinity, hi = -Infinity;
    const e = ins.M.elements;
    for (const p of ins.parts) for (const sh of p.shells) {
      if (sh.text || (sh.line && !sh.circle)) hasText = true;
      for (let k = 0; k + 2 < sh.verts.length; k += 3) {
        const y = e[1] * sh.verts[k] + e[5] * sh.verts[k + 1] + e[9] * sh.verts[k + 2] + e[13];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    if (hasText && hi - lo < 0.05) planes.set(Math.round(lo * 100) / 100, i);
  });
  // chỉ các mặt phẳng có trong bảng hiệu chỉnh (đường phẳng ở các mặt phẳng khác — vd y = −11.27 — là chi tiết của mô hình, không phải ranh giới view)
  const ordered = [...planes.entries()].filter(([y]) => VIEW_PRESETS.some(p => Math.abs(p.y0 - y) < 0.05)).sort((a, b) => a[1] - b[1]);
  const out: SheetView[] = [];
  let from = 0;
  ordered.forEach(([y0, last0], k) => {
    // bản sao cuối kéo dài tới trước instance trang giấy đầu tiên đứng sau nó (sau chú thích vẫn còn vài instance của bản sao)
    let last = last0;
    if (k === ordered.length - 1) { const nextPaper = instances.findIndex((ins, i) => i > last0 && ins.paper); last = nextPaper > 0 ? nextPaper - 1 : instances.length - 1; }
    const preset = VIEW_PRESETS.find(p => Math.abs(p.y0 - y0) < 0.05);
    if (preset) out.push({ from, to: last, y0, a: preset.a, b: preset.b, s: 0.01, depth: preset.depth, slab: preset.slab, crop: preset.crop });
    from = last + 1;
  });
  return out;
}

/* Số lưới ở đầu vòng tròn: chữ "1" của view South bị rơi về gốc toạ độ (ma trận instance là đơn vị, dù cái vòng tròn cùng đầu lưới có ma trận đúng) -> thấy
 * số 1 lạc ra ngoài vòng. Với mỗi view: chữ nhỏ ở gốc (|toạ độ local| < 0.05, M đơn vị) được ghép với vòng tròn chưa có chữ nào nằm trong (so theo vị trí world),
 * rồi đặt ma trận riêng (`textM`) = ma trận của vòng tròn đó. Ghép tuần tự theo thứ tự trong file. Heuristic suy từ sheet3.vsfx. */
function fixHeadTexts(instances: Instance[], views: SheetView[]) {
  for (const v of views) {
    const circles: { M: THREE.Matrix4; sh: Shell; w: THREE.Vector3 }[] = [];
    const lost: { sh: Shell }[] = [];
    const placed: THREE.Vector3[] = [];
    for (let i = v.from; i <= v.to; i++) {
      const ins = instances[i];
      if (ins.paper) continue;
      const e = ins.M.elements, atOrigin = e[12] === 0 && e[13] === 0 && e[14] === 0;
      for (const p of ins.parts) for (const sh of p.shells) {
        if (sh.circle) { const c = sh.circle.c; circles.push({ M: ins.M, sh, w: new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(ins.M) }); }
        else if (sh.text) {
          if (atOrigin && Math.abs(sh.verts[0]) < 0.05 && Math.abs(sh.verts[1]) < 0.05) lost.push({ sh });
          else placed.push(new THREE.Vector3(sh.verts[0], sh.verts[1], 0).applyMatrix4(ins.M));
        }
      }
    }
    // chỉ ghép với vòng cùng bán kính với các vòng ĐÃ có chữ ở giữa (đầu lưới); vòng đầu level (bán kính khác, chữ nằm lệch bên cạnh) không nhận
    const withText = circles.filter(c => c.sh.circle && placed.some(q => q.distanceTo(c.w) < c.sh.circle!.r * 2));
    const free = circles.filter(c => c.sh.circle && !withText.includes(c) && withText.some(w => Math.abs(w.sh.circle!.r - c.sh.circle!.r) < 0.05 * c.sh.circle!.r));
    lost.forEach((t, k) => {
      const c = free[k];
      if (!c || !c.sh.circle) return;
      const cc = c.sh.circle.c;
      t.sh.verts = new Float64Array([t.sh.verts[0] + cc[0], t.sh.verts[1] + cc[1], t.sh.verts[2] + cc[2]]);
      t.sh.textM = c.M;
    });
  }
}

/* Đầu level/lưới của view có khi MẤT ma trận (M = đơn vị, nằm ở gốc toạ độ): đầu "Roof Line" của view Section (instance cùng handle 196629 với đường level có ma trận
 * (85.7, −7.2, 19.7)). Ở view South cái đầu này có ma trận đúng. Chỉ với instance nhỏ kiểu in (mọi toạ độ local < 0.5 ft) và M đơn vị: nhận ma trận của instance KHÁC cùng handle
 * có ma trận không phải đơn vị (khung/khung tên toạ độ lớn hơn 0.5 ft nên không bị đụng). Nếu không sửa, các instance này bị coi là trang giấy (nằm gọn trong khổ giấy). */
function inheritLostMatrices(instances: Instance[]) {
  const isIdent = (M: THREE.Matrix4) => M.elements.every((x, i) => Math.abs(x - (i % 5 === 0 ? 1 : 0)) < 1e-9);
  const byHandle = new Map<string, number[]>();
  instances.forEach((ins, i) => { if (ins.handle) (byHandle.get(ins.handle) ?? byHandle.set(ins.handle, []).get(ins.handle)!).push(i); });
  const small = (ins: Instance) => ins.parts.every(p => p.shells.every(sh => {
    if (sh.text?.abs) return false;
    for (let k = 0; k < sh.verts.length; k++) if (Math.abs(sh.verts[k]) >= 0.5) return false;
    return true;
  }));
  const fix: [Instance, THREE.Matrix4][] = [];
  for (const list of byHandle.values()) {
    for (const i of list) {
      const ins = instances[i];
      if (!isIdent(ins.M) || !small(ins) || !ins.parts.some(p => p.shells.length)) continue;
      // cùng handle xuất hiện ở cả hai view (đầu level 311 ở South lẫn Section): lấy instance CÓ MA TRẬN gần nhất theo thứ tự (cùng bản sao)
      let best = -1;
      for (const j of list) if (j !== i && !isIdent(instances[j].M) && !instances[j].paper && (best < 0 || Math.abs(j - i) < Math.abs(best - i))) best = j;
      if (best >= 0) fix.push([ins, instances[best].M]);
    }
  }
  for (const [ins, M] of fix) ins.M = M;
}
