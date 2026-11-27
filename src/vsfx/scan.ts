/* Các bộ quét dùng chung cho mọi biến thể .vsfx (mọi số đều little-endian).
 * Không có spec công khai; quy tắc suy ra bằng reverse-engineering trên file mẫu. */
import * as THREE from 'three';
import type { Shell } from './types';

export interface RawViews {
  dv: DataView;
  f64: (o: number) => number;
  u32: (o: number) => number;
  i32: (o: number) => number;
}

export const views = (raw: Uint8Array): RawViews => {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    dv,
    f64: o => dv.getFloat64(o, true),
    u32: o => dv.getUint32(o, true),
    i32: o => dv.getInt32(o, true),
  };
};

/* Shell (lưới):  08 00 00 00 00 0C 00 [cờ] [cờ2] 00 | u32 cnt | cnt × (x,y,z float64)
 *   cờ2 = 01 khi shell có thêm dữ liệu theo đỉnh (normal/UV; vd tấm kính trong file Revit).
 * Face list:  u32 0xFFFFFFFF, u32 N, N × i32  -> (n, i0..in-1)... ; n âm = lỗ của face trước
 *        hoặc u32 n (cố định, vd 4), u32 T    -> T/(n+1) face, mỗi face n index (không có count)
 * Màu theo từng mặt (file Revit, vd mặt đất): 01 00 00 03 00 01 00 01 00 01 [u32 n] + n × (01 B G R C2)
 *
 * Biến thể header có thuộc tính riêng của shell (gặp ở school.vsfx — 3 618 shell, gồm mặt bậc thang; 3 file mẫu
 * cũ không có):  08 00 00 02 10 00 [u32 handle vật liệu] 00×4 01 00 [B G R] C2 00 | 0C 00 [cờ] [cờ2] 00 | u32 cnt …
 * Phần từ 0C trở đi giống hệt dạng thường. */
export function scanShells(raw: Uint8Array): Shell[] {
  const L = raw.length, { f64, u32, i32 } = views(raw);
  const shells: Shell[] = [];
  for (let o = 0; o + 22 <= L; o++) {
    if (raw[o] !== 8 || raw[o + 1] || raw[o + 2]) continue;
    // h = vị trí byte 0C của header
    let h: number, color: number | undefined, mat: number | undefined;
    if (!raw[o + 3] && !raw[o + 4]) h = o + 5;
    else if (raw[o + 3] === 2 && raw[o + 4] === 0x10 && !raw[o + 5] && o + 34 <= L &&
             !raw[o + 10] && !raw[o + 11] && !raw[o + 12] && !raw[o + 13] &&
             raw[o + 14] === 1 && !raw[o + 15] && raw[o + 19] === 0xc2 && !raw[o + 20]) {
      h = o + 21;
      color = (raw[o + 18] << 16) | (raw[o + 17] << 8) | raw[o + 16];
      mat = u32(o + 6);
    } else continue;
    if (raw[h] !== 0x0c || raw[h + 1] || raw[h + 3] > 1 || raw[h + 4]) continue;
    const cnt = u32(h + 5), s = h + 9;
    if (cnt < 1 || cnt > 500000 || s + cnt * 24 + 8 > L) continue;
    const v = new Float64Array(cnt * 3);
    let ok = true;
    for (let i = 0; i < cnt * 3; i++) {
      const x = f64(s + i * 8);
      if (!Number.isFinite(x) || Math.abs(x) > 1e7) { ok = false; break; }
      v[i] = x;
    }
    if (!ok) continue;
    const e = s + cnt * 24, a = u32(e), T = u32(e + 4);
    let faces: Int32Array, end: number;
    if (a === 0xFFFFFFFF) {
      if (T < 4 || e + 8 + T * 4 > L) continue;
      faces = new Int32Array(T);
      let p = 0;
      for (let i = 0; i < T; i++) faces[i] = i32(e + 8 + i * 4);
      while (p < T) {
        const n = Math.abs(faces[p]);
        if (n < 3 || p + 1 + n > T) { ok = false; break; }
        for (let k = 1; k <= n; k++) if (faces[p + k] < 0 || faces[p + k] >= cnt) ok = false;
        p += 1 + n;
      }
      if (!ok || p !== T) continue;
      end = e + 8 + T * 4;
    } else if (a >= 3 && a <= 64 && T > 0 && T % (a + 1) === 0) {
      const nf = T / (a + 1);
      if (e + 8 + nf * a * 4 > L) continue;
      faces = new Int32Array(T);
      let q = 0;
      for (let f = 0; f < nf && ok; f++) {
        faces[q++] = a;
        for (let k = 0; k < a; k++) {
          const idx = u32(e + 8 + (f * a + k) * 4);
          if (idx >= cnt) { ok = false; break; }
          faces[q++] = idx;
        }
      }
      if (!ok) continue;
      end = e + 8 + nf * a * 4;
    } else continue;

    let faceColors: Int32Array | null = null;
    if (end + 14 <= L && raw[end] === 1 && raw[end + 3] === 3 && raw[end + 5] >= 1 && raw[end + 5] <= 4 &&   // byte +5: 1 ở revit.vsfx, 2 ở school.vsfx (chưa rõ nghĩa; từng chặn mất màu mặt đất)
         raw[end + 7] === 1 && raw[end + 9] === 1) {
      const n = u32(end + 10), q = end + 14;
      if (n > 0 && n < 1e6 && q + n * 5 <= L) {
        faceColors = new Int32Array(n);
        for (let k = 0; k < n; k++) {
          const b = q + k * 5;
          if (raw[b] !== 1 || raw[b + 4] !== 0xc2) { faceColors = null; break; }
          faceColors[k] = (raw[b + 3] << 16) | (raw[b + 2] << 8) | raw[b + 1];
        }
      }
    }
    shells.push({ off: s, end, verts: v, faces, faceColors, color, mat });
    o = end - 1;
  }
  return shells;
}

/* Đường gấp khúc (hình học kiểu 05 — file Revit: đường ống/ống luồn dây, đường mô hình…): cùng header với shell nhưng byte
 * kiểu = 05 thay vì 08:  05 00 00 00 00 0C 00 [cờ] [cờ2] 00 | u32 cnt | cnt × (x,y,z f64), KHÔNG có face list (hết là sang bản ghi
 * kế). Màu nằm trong bản ghi `0D 04|06 00 00 [f1 f2] 00 [B G R] C2` ngay trước (file_5.vsfx: 1 759 đường 2 điểm, xanh/cam/olive
 * như viewer gốc). Chỉ nhận khi có bản ghi màu đó phía trước, để khỏi nhầm với byte 05 ngẫu nhiên. Suy luận, chưa có spec. */
export function scanLines(raw: Uint8Array): Shell[] {
  const L = raw.length, { f64, u32 } = views(raw), lines: Shell[] = [];
  for (let o = 0; o + 14 <= L; o++) {
    if (raw[o] !== 5 || raw[o + 1] || raw[o + 2] || raw[o + 3] || raw[o + 4]) continue;
    const h = o + 5;
    if (raw[h] !== 0x0c || raw[h + 1] || raw[h + 3] > 1 || raw[h + 4]) continue;
    const cnt = u32(h + 5), s = h + 9;
    if (cnt < 2 || cnt > 100000 || s + cnt * 24 > L) continue;
    let hasColor = false;
    for (let q = h - 1; q >= Math.max(0, h - 60) && !hasColor; q--)
      hasColor = raw[q] === 0x0d && (raw[q + 1] === 4 || raw[q + 1] === 6) && !raw[q + 2] && !raw[q + 3] && !raw[q + 6] && (raw[q + 10] === 0xc2 || raw[q + 10] === 0xc0);   // C0 = ByLayer (không màu riêng)
    if (!hasColor) continue;
    const v = new Float64Array(cnt * 3);
    let ok = true;
    for (let i = 0; i < cnt * 3; i++) {
      const x = f64(s + i * 8);
      if (!Number.isFinite(x) || Math.abs(x) > 1e7) { ok = false; break; }
      v[i] = x;
    }
    if (!ok) continue;
    lines.push({ off: s, end: s + cnt * 24, verts: v, faces: new Int32Array(0), faceColors: null, line: true });
    o = s + cnt * 24 - 1;
  }
  return lines;
}

/* Vòng tròn (hình học kiểu 00 — file bản vẽ: vòng quanh số lưới của view; sheet3.vsfx có 26 cái):
 *   01 00 00 00 00 | 00 00 00 00 | 0C 00 00 00 00 | tâm (x, y, z: 3 × f64) | bán kính (f64)
 * Nằm trong mặt phẳng XY local (cùng mặt phẳng với chữ của đầu lưới). Suy luận từ 26 cái (bán kính 0.0132–0.0214 ft ≈ 4–6.5 mm giấy); trả về đường gấp khúc kín
 * (33 điểm) để dùng chung đường vẽ `wire`. */
export function scanCircles(raw: Uint8Array): Shell[] {
  const L = raw.length, { f64 } = views(raw), out: Shell[] = [];
  const SEG = 32;
  for (let o = 4; o + 43 <= L; o++) {
    if (raw[o - 4] !== 1 || raw[o - 3] || raw[o - 2] || raw[o - 1] || raw[o] || raw[o + 1] || raw[o + 2] || raw[o + 3] || raw[o + 4] ||
        raw[o + 5] !== 0x0c || raw[o + 6] || raw[o + 7] || raw[o + 8] || raw[o + 9]) continue;
    const c = o + 10, cx = f64(c), cy = f64(c + 8), cz = f64(c + 16), r = f64(c + 24);
    if (![cx, cy, cz, r].every(Number.isFinite) || !(r > 1e-4 && r < 1e3) || Math.abs(cx) > 1e5 || Math.abs(cy) > 1e5 || Math.abs(cz) > 1e5) continue;
    const v = new Float64Array((SEG + 1) * 3);
    for (let i = 0; i <= SEG; i++) {
      const t = (i / SEG) * 2 * Math.PI;
      v[i * 3] = cx + r * Math.cos(t); v[i * 3 + 1] = cy + r * Math.sin(t); v[i * 3 + 2] = cz;
    }
    out.push({ off: c, end: c + 32, verts: v, faces: new Int32Array(0), faceColors: null, line: true, circle: { c: [cx, cy, cz], r } });
    o = c + 31;
  }
  return out;
}

/* Thực thể chữ (file bản vẽ Revit/sheet3.vsfx; suy luận từ 79 dòng chữ, đối chiếu vị trí với ảnh gốc):
 *   0C 00 [2 byte] 00 0D | x y x y (4 × f64, cặp sau lặp lại cặp đầu) | 01 | rộng-tỉ-lệ (f64, 1.0) | cao chữ (f64) | u16 số ký tự | UTF-16

 *   Biến thể TUYỆT ĐỐI (nhãn "Level 2", "Foundation", "Level 1 Living Rm.", giá trị cao độ của view): `0C 00 46 20 00 0C [f64 = |y0| của view] x y x y` rồi `00 | góc (≈0) | −1.0 | 0.0 | 1.0 | cao | u16 | UTF-16` —
 *   toạ độ là toạ độ MÔ HÌNH (x = X, y = Z) và cao chữ cũng theo đơn vị mô hình (0.984 ft = 3 mm × 100), khác các nhãn kia dùng kích thước giấy.
 *   Chữ XOAY (byte cờ 05 thay 0D; ngày giờ ở mép phải khổ giấy, xoay 90°): sau `01` có thêm góc quay (f64, radian) trước rộng-tỉ-lệ.
 * Gốc chữ canh TRÁI, đường cơ sở (khớp "Elevations/Sections" tràn ra trái khung tên ở ảnh gốc). Đơn vị feet, toạ độ giấy gốc ở góc
 * dưới trái khổ giấy (A1 ≈ 2.76 × 1.95 ft). Trả về giả-shell: verts = [x, y, 0] ở hệ local, `text` giữ cao + chuỗi. */
export function scanTexts(raw: Uint8Array): Shell[] {
  const L = raw.length, { f64 } = views(raw), out: Shell[] = [];
  for (let o = 5; o + 54 <= L; o++) {
    if (o >= 12 && raw[o - 8] === 0x0c && !raw[o - 9] && raw[o - 10] === 0x20 && raw[o - 11] === 0x46 && !raw[o - 12] && !raw[o + 33] && f64(o + 42) === -1 && f64(o + 58) === 1) {   // biến thể tuyệt đối (8 byte trước x là một f64 = |y0| của view)
      const x = f64(o + 1), y = f64(o + 9), h = f64(o + 66), n = raw[o + 74] | (raw[o + 75] << 8), t0 = o + 76;
      if (!(Math.abs(x) < 1e6 && Math.abs(y) < 1e6) || f64(o + 17) !== x || f64(o + 25) !== y || !(h > 0 && h < 1e3) || n < 1 || n > 200 || t0 + n * 2 > L) continue;
      let s = '', ok = true;
      for (let i = 0; i < n; i++) { const c = raw[t0 + i * 2] | (raw[t0 + 1 + i * 2] << 8); if (c < 0x20 || (c >= 0xd800 && c < 0xe000)) { ok = false; break; } s += String.fromCharCode(c); }
      if (!ok) continue;
      out.push({ off: o + 1, end: t0 + n * 2, verts: new Float64Array([x, y, 0]), faces: new Int32Array(0), faceColors: null, text: { h, s, rot: 0, abs: true } });
      o = t0 + n * 2 - 1;
      continue;
    }
    if ((raw[o] !== 0x0d && raw[o] !== 0x05) || raw[o - 1] || raw[o - 5] !== 0x0c || raw[o - 4] || raw[o + 33] !== 1) continue;
    const x = f64(o + 1), y = f64(o + 9);
    if (!(Math.abs(x) < 1e6 && Math.abs(y) < 1e6) || f64(o + 17) !== x || f64(o + 25) !== y) continue;
    const rotated = f64(o + 34) !== 1, rot = rotated ? f64(o + 34) : 0, b = rotated ? o + 50 : o + 42;   // b = vị trí cao chữ
    if (rotated && !(Math.abs(rot) < 7)) continue;
    const h = f64(b);
    if (!(h > 0 && h < 1e3)) continue;
    const n = raw[b + 8] | (raw[b + 9] << 8), t0 = b + 10;
    if (n < 1 || n > 200 || t0 + n * 2 > L) continue;
    let s = '', ok = true;
    for (let i = 0; i < n; i++) {
      const c = raw[t0 + i * 2] | (raw[t0 + 1 + i * 2] << 8);
      if (c < 0x20 || (c >= 0xd800 && c < 0xe000) || c === 0xfffe || c === 0xffff) { ok = false; break; }
      s += String.fromCharCode(c);
    }
    if (!ok) continue;
    out.push({ off: o + 1, end: t0 + n * 2, verts: new Float64Array([x, y, 0]), faces: new Int32Array(0), faceColors: null, text: { h, s, rot } });
    o = t0 + n * 2 - 1;
  }
  return out;
}

/* Ma trận trực giao: 3 double tịnh tiến + 9 double xoay (lưu theo hàng); world = Mᵀ·v + t.
 * Gọi onMatrix(offset, Matrix4) cho mỗi bản ghi tìm thấy. */
export function scanTransforms(raw: Uint8Array, start: number, onMatrix: (off: number, M: THREE.Matrix4) => void): void {
  const L = raw.length, { f64 } = views(raw);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let o = Math.max(0, start); o + 96 <= L; o++) {
    const m: number[] = [];
    let ok = true;
    for (let i = 0; i < 9; i++) {
      const x = f64(o + 24 + i * 8);
      if (!(Math.abs(x) <= 1.0000001)) { ok = false; break; }
      m.push(x);
    }
    if (!ok) continue;
    const r = [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
    for (let i = 0; i < 3 && ok; i++) {
      if (Math.abs(dot(r[i], r[i]) - 1) > 1e-6) ok = false;
      for (let j = i + 1; j < 3 && ok; j++) if (Math.abs(dot(r[i], r[j])) > 1e-6) ok = false;
    }
    if (!ok) continue;
    const t = [f64(o), f64(o + 8), f64(o + 16)];
    if (!t.every(x => Number.isFinite(x) && Math.abs(x) < 1e7)) continue;
    const M = new THREE.Matrix4().set(
      m[0], m[3], m[6], t[0],
      m[1], m[4], m[7], t[1],
      m[2], m[5], m[8], t[2],
      0, 0, 0, 1);
    onMatrix(o, M);
    o += 95;
  }
}

/** Vị trí cuối cùng có key ≤ x trong mảng tăng dần, hoặc -1. */
export function lastLE<T>(arr: readonly T[], x: number, key: (v: T) => number): number {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (key(arr[m]) <= x) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

export const identity = (x: number) => x;

/** Bảng extents trong metadata: ≥ 4 mục liên tiếp [u64 handle][u8 cờ 0..6][6 × f64 bbox min ≤ max], bước 57 byte.
 *  Đây là bbox world mà chính file ghi cho từng đối tượng — dùng để lấy handle của entity IFC (handle không nằm cạnh
 *  hình học) và để kiểm chứng parser. Port từ `.claude/tools/vsfx_probe.py extent_tables`. */
export function scanExtents(raw: Uint8Array): { h: number; bb: number[] }[] {
  const L = raw.length, { f64, u32 } = views(raw), out: { h: number; bb: number[] }[] = [];
  const ok = (o: number) => {
    if (o + 57 > L) return false;
    const h = u32(o);
    if (!h || h >= 0x10000000 || u32(o + 4) || raw[o + 8] > 6) return false;
    for (let i = 0; i < 6; i++) { const x = f64(o + 9 + i * 8); if (!Number.isFinite(x) || Math.abs(x) >= 1e7) return false; }
    for (let i = 0; i < 3; i++) if (f64(o + 9 + i * 8) > f64(o + 33 + i * 8) + 1e-9) return false;
    return true;
  };
  for (let o = 0; o + 57 * 4 <= L;) {
    if (ok(o) && ok(o + 57) && ok(o + 114) && ok(o + 171)) {
      while (ok(o)) {
        out.push({ h: u32(o), bb: [0, 1, 2, 3, 4, 5].map(i => f64(o + 9 + i * 8)) });
        o += 57;
      }
      continue;
    }
    o++;
  }
  return out;
}

/** Bản ghi mang handle nguồn (handle phần tử IFC / Element ID Revit): `01 01 00 00 00 [72|73] | 00×7 | 08 00 00 00 |
 *  u32 id`. Gặp trong node IFC (marker 40 10 11 … 72), ngay sau tên INSERT IFC, và trong bản ghi phần tử Revit (73).
 *  Trả theo thứ tự offset; `o` = offset byte đầu chữ ký. */
export function scanSourceRecords(raw: Uint8Array): { o: number; id: number }[] {
  const { u32 } = views(raw), out: { o: number; id: number }[] = [];
  const SIG = [1, 1, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0];
  outer: for (let o = 0; o + 21 <= raw.length; o++) {
    for (let k = 0; k < SIG.length; k++) {
      const b = raw[o + k];
      if (SIG[k] < 0 ? b !== 0x72 && b !== 0x73 : b !== SIG[k]) continue outer;
    }
    out.push({ o, id: u32(o + 17) });
    o += 20;
  }
  return out;
}
