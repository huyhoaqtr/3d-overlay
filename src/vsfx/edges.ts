/* Lọc cạnh thừa do T-junction.
 *
 * EdgesGeometry coi một cạnh là "biên" khi nó chỉ thuộc một tam giác, so khớp theo toạ độ đỉnh. Khi tường
 * bị cắt thành nhiều face quanh ô cửa, cạnh dài của face này (vd mép trên dải cửa sổ) đối diện với nhiều
 * cạnh ngắn của face bên dưới -> không khớp từng cặp -> cả hai đều bị vẽ dù hai face nằm cùng một mặt phẳng.
 *
 * Ở đây mỗi cạnh được cắt tại các đỉnh nằm trên nó, rồi từng đoạn bị bỏ nếu hai bên đoạn đều có tam giác
 * gần như đồng phẳng (tức đoạn nằm giữa một mặt liền). Đoạn thật sự là biên (mép lỗ cửa) chỉ có một bên nên giữ. */

const COS_COPLANAR = Math.cos(25 * Math.PI / 180);   // cùng ngưỡng với EdgesGeometry
const GRID_MIN = 24, GRID_MAX = 160;   // số ô theo đường chéo bbox; lưới thưa quá thì mỗi ô chứa hàng nghìn tam giác (file_13: 41k tam giác/shell -> 1.5 s/shell, cả file không dựng xong)
const MAX_EDGES = 200_000;

export function pruneCoplanarEdges(pos: Float32Array, edges: Float32Array): Float32Array {
  const nT = pos.length / 9, nE = edges.length / 6;
  if (!nT || !nE || nE > MAX_EDGES) return edges;

  // --- bbox, dung sai, lưới không gian
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let d = 0; d < 3; d++) { const x = pos[i + d]; if (x < mn[d]) mn[d] = x; if (x > mx[d]) mx[d] = x; }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const maxAbs = Math.max(...mn.map(Math.abs), ...mx.map(Math.abs));
  const tol = Math.max(diag, maxAbs) * 2e-6;
  const GRID = Math.min(GRID_MAX, Math.max(GRID_MIN, Math.ceil(Math.sqrt(nT) / 3)));   // mặt cong: tam giác nằm trên mặt (≈ GRID² ô có tam giác) -> ~ 9 tam giác/ô
  const cell = diag / GRID, inv = 1 / cell;
  const dim = [0, 1, 2].map(d => Math.max(1, Math.ceil((mx[d] - mn[d]) / cell) + 1));
  const cellIdx = (x: number, y: number, z: number) => {
    const cx = Math.min(dim[0] - 1, Math.max(0, Math.floor((x - mn[0]) * inv)));
    const cy = Math.min(dim[1] - 1, Math.max(0, Math.floor((y - mn[1]) * inv)));
    const cz = Math.min(dim[2] - 1, Math.max(0, Math.floor((z - mn[2]) * inv)));
    return cx + dim[0] * (cy + dim[1] * cz);
  };

  // --- pháp tuyến đơn vị từng tam giác (null nếu suy biến) + đưa vào lưới theo AABB nở thêm tol
  const nrm = new Float32Array(nT * 3), ok = new Uint8Array(nT);
  const grid = new Map<number, number[]>();
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < tol * tol) continue;
    nrm[t * 3] = nx / l; nrm[t * 3 + 1] = ny / l; nrm[t * 3 + 2] = nz / l;
    ok[t] = 1;
    const lo = [0, 1, 2].map(d => Math.min(pos[o + d], pos[o + 3 + d], pos[o + 6 + d]) - tol);
    const hi = [0, 1, 2].map(d => Math.max(pos[o + d], pos[o + 3 + d], pos[o + 6 + d]) + tol);
    const c0 = [0, 1, 2].map(d => Math.max(0, Math.floor((lo[d] - mn[d]) * inv)));
    const c1 = [0, 1, 2].map(d => Math.min(dim[d] - 1, Math.floor((hi[d] - mn[d]) * inv)));
    for (let z = c0[2]; z <= c1[2]; z++) for (let y = c0[1]; y <= c1[1]; y++) for (let x = c0[0]; x <= c1[0]; x++) {
      const k = x + dim[0] * (y + dim[1] * z), l2 = grid.get(k);
      if (l2) l2.push(t); else grid.set(k, [t]);
    }
  }

  /** Vị trí của M so với tam giác t: 0 = ngoài / lệch mặt phẳng, 1 = trên biên (trong dung sai), 2 = nằm hẳn bên trong. */
  const touch = (t: number, mx_: number, my: number, mz: number): number => {
    if (!ok[t]) return 0;
    const o = t * 9, nx = nrm[t * 3], ny = nrm[t * 3 + 1], nz = nrm[t * 3 + 2];
    if (Math.abs((mx_ - pos[o]) * nx + (my - pos[o + 1]) * ny + (mz - pos[o + 2]) * nz) > tol) return 0;
    let inside = true;
    for (let i = 0; i < 3; i++) {
      const a = o + i * 3, b = o + ((i + 1) % 3) * 3;
      const ex = pos[b] - pos[a], ey = pos[b + 1] - pos[a + 1], ez = pos[b + 2] - pos[a + 2];
      const el = Math.hypot(ex, ey, ez) || 1;
      // khoảng cách có dấu tới cạnh, dương = phía trong tam giác
      const sd = ((ny * ez - nz * ey) * (mx_ - pos[a]) + (nz * ex - nx * ez) * (my - pos[a + 1]) + (nx * ey - ny * ex) * (mz - pos[a + 2])) / el;
      if (sd < -tol) return 0;
      if (sd < tol) inside = false;
    }
    return inside ? 2 : 1;
  };

  const out: number[] = [];
  const pushSeg = (a: number[], b: number[]) => out.push(a[0], a[1], a[2], b[0], b[1], b[2]);

  for (let e = 0; e < nE; e++) {
    const o = e * 6;
    const A = [edges[o], edges[o + 1], edges[o + 2]], B = [edges[o + 3], edges[o + 4], edges[o + 5]];
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2], L = Math.hypot(dx, dy, dz);
    if (L < tol) continue;
    const dir = [dx / L, dy / L, dz / L];

    // 1) các đỉnh nằm trên đoạn (T-junction) -> điểm cắt
    const near = new Set<number>();
    const steps = Math.max(1, Math.ceil(L / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps, l2 = grid.get(cellIdx(A[0] + dx * f, A[1] + dy * f, A[2] + dz * f));
      if (l2) for (const t of l2) near.add(t);
    }
    const ts = [0, 1];
    for (const t of near) for (let i = 0; i < 3; i++) {
      const p = t * 9 + i * 3, rx = pos[p] - A[0], ry = pos[p + 1] - A[1], rz = pos[p + 2] - A[2];
      const along = rx * dir[0] + ry * dir[1] + rz * dir[2];
      if (along <= tol || along >= L - tol) continue;
      const px = rx - along * dir[0], py = ry - along * dir[1], pz = rz - along * dir[2];
      if (Math.hypot(px, py, pz) <= tol) ts.push(along / L);
    }
    ts.sort((x, y) => x - y);
    const cuts = ts.filter((v, i) => i === 0 || v - ts[i - 1] > tol / L);

    // 2) mỗi đoạn con: hai bên đều có mặt đồng phẳng thì bỏ
    let runStart: number[] | null = null, runEnd: number[] = A;
    const at = (f: number) => [A[0] + dx * f, A[1] + dy * f, A[2] + dz * f];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const p0 = at(cuts[i]), p1 = at(cuts[i + 1]), m = at((cuts[i] + cuts[i + 1]) / 2);
      const list = grid.get(cellIdx(m[0], m[1], m[2])) ?? [];
      const tri: { t: number; c: number }[] = [];
      for (const t of list) { const c = touch(t, m[0], m[1], m[2]); if (c) tri.push({ t, c }); }

      // Chỉ bỏ khi MỌI tam giác chạm đoạn này đều đồng phẳng với nhau (nếu có mặt vuông góc chạm vào thì đây
      // là cạnh gấp thật, vd chân hộp đặt trên sàn) và hai bên đều có mặt (hoặc đoạn nằm hẳn trong một mặt).
      let hidden = false;
      if (tri.length) {
        const r = tri[0].t * 3, n1 = [nrm[r], nrm[r + 1], nrm[r + 2]];
        const s = [n1[1] * dir[2] - n1[2] * dir[1], n1[2] * dir[0] - n1[0] * dir[2], n1[0] * dir[1] - n1[1] * dir[0]];
        let allCo = true, pos_ = false, neg = false;
        for (const { t, c } of tri) {
          const n2 = t * 3;
          if (Math.abs(nrm[n2] * n1[0] + nrm[n2 + 1] * n1[1] + nrm[n2 + 2] * n1[2]) < COS_COPLANAR) { allCo = false; break; }
          if (c === 2) { pos_ = neg = true; continue; }
          const o9 = t * 9;
          const side = ((pos[o9] + pos[o9 + 3] + pos[o9 + 6]) / 3 - m[0]) * s[0]
            + ((pos[o9 + 1] + pos[o9 + 4] + pos[o9 + 7]) / 3 - m[1]) * s[1]
            + ((pos[o9 + 2] + pos[o9 + 5] + pos[o9 + 8]) / 3 - m[2]) * s[2];
          if (side > 0) pos_ = true; else if (side < 0) neg = true;
        }
        hidden = allCo && pos_ && neg;
      }

      if (hidden) {
        if (runStart) { pushSeg(runStart, runEnd); runStart = null; }
      } else {
        if (!runStart) runStart = p0;
        runEnd = p1;
      }
    }
    if (runStart) pushSeg(runStart, runEnd);
  }
  return new Float32Array(out);
}

/** Cùng kết quả (từng số) với `pruneCoplanarEdges` nhưng không cấp phát trong vòng lặp cạnh: bộ đệm kiểu số dùng lại (tập `near` bằng tem theo vòng, mảng cắt, danh sách tam giác chạm),
 *  số học giữ nguyên thứ tự. Dựng lưới file_14 (7.7 triệu tam giác, 79 000 part) từ 35 s ở bước này xuống còn vài giây. */
let _stamp: Int32Array = new Int32Array(0), _epoch = 0;
let _ts: Float64Array = new Float64Array(256), _near: Int32Array = new Int32Array(256), _triT: Int32Array = new Int32Array(64), _triC: Uint8Array = new Uint8Array(64);

export function pruneCoplanarEdgesFast(pos: Float32Array, edges: Float32Array): Float32Array {
  const nT = pos.length / 9, nE = edges.length / 6;
  if (!nT || !nE || nE > MAX_EDGES) return edges;

  const mn0 = [Infinity, Infinity, Infinity], mx0 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let d = 0; d < 3; d++) { const x = pos[i + d]; if (x < mn0[d]) mn0[d] = x; if (x > mx0[d]) mx0[d] = x; }
  const mnx = mn0[0], mny = mn0[1], mnz = mn0[2];
  const diag = Math.hypot(mx0[0] - mnx, mx0[1] - mny, mx0[2] - mnz) || 1;
  const maxAbs = Math.max(Math.abs(mnx), Math.abs(mny), Math.abs(mnz), Math.abs(mx0[0]), Math.abs(mx0[1]), Math.abs(mx0[2]));
  const tol = Math.max(diag, maxAbs) * 2e-6;
  const GRID = Math.min(GRID_MAX, Math.max(GRID_MIN, Math.ceil(Math.sqrt(nT) / 3)));
  const cell = diag / GRID, inv = 1 / cell;
  const dim0 = Math.max(1, Math.ceil((mx0[0] - mnx) / cell) + 1), dim1 = Math.max(1, Math.ceil((mx0[1] - mny) / cell) + 1), dim2 = Math.max(1, Math.ceil((mx0[2] - mnz) / cell) + 1);
  const cellIdx = (x: number, y: number, z: number) => {
    const cx = Math.min(dim0 - 1, Math.max(0, Math.floor((x - mnx) * inv)));
    const cy = Math.min(dim1 - 1, Math.max(0, Math.floor((y - mny) * inv)));
    const cz = Math.min(dim2 - 1, Math.max(0, Math.floor((z - mnz) * inv)));
    return cx + dim0 * (cy + dim1 * cz);
  };

  const nrm = new Float32Array(nT * 3), ok = new Uint8Array(nT);
  const grid = new Map<number, number[]>();
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < tol * tol) continue;
    nrm[t * 3] = nx / l; nrm[t * 3 + 1] = ny / l; nrm[t * 3 + 2] = nz / l;
    ok[t] = 1;
    const lox = Math.min(pos[o], pos[o + 3], pos[o + 6]) - tol, loy = Math.min(pos[o + 1], pos[o + 4], pos[o + 7]) - tol, loz = Math.min(pos[o + 2], pos[o + 5], pos[o + 8]) - tol;
    const hix = Math.max(pos[o], pos[o + 3], pos[o + 6]) + tol, hiy = Math.max(pos[o + 1], pos[o + 4], pos[o + 7]) + tol, hiz = Math.max(pos[o + 2], pos[o + 5], pos[o + 8]) + tol;
    const c0x = Math.max(0, Math.floor((lox - mnx) * inv)), c0y = Math.max(0, Math.floor((loy - mny) * inv)), c0z = Math.max(0, Math.floor((loz - mnz) * inv));
    const c1x = Math.min(dim0 - 1, Math.floor((hix - mnx) * inv)), c1y = Math.min(dim1 - 1, Math.floor((hiy - mny) * inv)), c1z = Math.min(dim2 - 1, Math.floor((hiz - mnz) * inv));
    for (let z = c0z; z <= c1z; z++) for (let y = c0y; y <= c1y; y++) for (let x = c0x; x <= c1x; x++) {
      const k = x + dim0 * (y + dim1 * z), l2 = grid.get(k);
      if (l2) l2.push(t); else grid.set(k, [t]);
    }
  }

  const touch = (t: number, mx_: number, my: number, mz: number): number => {
    if (!ok[t]) return 0;
    const o = t * 9, nx = nrm[t * 3], ny = nrm[t * 3 + 1], nz = nrm[t * 3 + 2];
    if (Math.abs((mx_ - pos[o]) * nx + (my - pos[o + 1]) * ny + (mz - pos[o + 2]) * nz) > tol) return 0;
    let inside = true;
    for (let i = 0; i < 3; i++) {
      const a = o + i * 3, b = o + ((i + 1) % 3) * 3;
      const ex = pos[b] - pos[a], ey = pos[b + 1] - pos[a + 1], ez = pos[b + 2] - pos[a + 2];
      const el = Math.hypot(ex, ey, ez) || 1;
      const sd = ((ny * ez - nz * ey) * (mx_ - pos[a]) + (nz * ex - nx * ez) * (my - pos[a + 1]) + (nx * ey - ny * ex) * (mz - pos[a + 2])) / el;
      if (sd < -tol) return 0;
      if (sd < tol) inside = false;
    }
    return inside ? 2 : 1;
  };

  if (_stamp.length < nT) _stamp = new Int32Array(Math.max(nT, _stamp.length * 2));
  const out: number[] = [];

  for (let e = 0; e < nE; e++) {
    const o = e * 6;
    const Ax = edges[o], Ay = edges[o + 1], Az = edges[o + 2];
    const dx = edges[o + 3] - Ax, dy = edges[o + 4] - Ay, dz = edges[o + 5] - Az, L = Math.hypot(dx, dy, dz);
    if (L < tol) continue;
    const dirx = dx / L, diry = dy / L, dirz = dz / L;

    // 1) đỉnh nằm trên đoạn (T-junction) -> điểm cắt
    if (++_epoch >= 0x7fffffff) { _stamp.fill(0); _epoch = 1; }
    let nn = 0;
    const steps = Math.max(1, Math.ceil(L / (cell * 0.5)));
    for (let st = 0; st <= steps; st++) {
      const f = st / steps, l2 = grid.get(cellIdx(Ax + dx * f, Ay + dy * f, Az + dz * f));
      if (l2) for (let q = 0; q < l2.length; q++) {
        const t = l2[q];
        if (_stamp[t] === _epoch) continue;
        _stamp[t] = _epoch;
        if (nn >= _near.length) { const g = new Int32Array(_near.length * 2); g.set(_near); _near = g; }
        _near[nn++] = t;
      }
    }
    let nts = 2;
    _ts[0] = 0; _ts[1] = 1;
    // đỉnh cách đường thẳng ≤ tol (và chân vuông góc nằm trong đoạn) thì nằm trong AABB của đoạn nở thêm tol -> loại nhanh các đỉnh xa trước khi chiếu (kết quả không đổi)
    const bx0 = Math.min(Ax, Ax + dx) - tol, bx1 = Math.max(Ax, Ax + dx) + tol, by0 = Math.min(Ay, Ay + dy) - tol, by1 = Math.max(Ay, Ay + dy) + tol, bz0 = Math.min(Az, Az + dz) - tol, bz1 = Math.max(Az, Az + dz) + tol;
    for (let q = 0; q < nn; q++) {
      const t = _near[q];
      for (let i = 0; i < 3; i++) {
        const p = t * 9 + i * 3;
        const vx = pos[p], vy = pos[p + 1], vz = pos[p + 2];
        if (vx < bx0 || vx > bx1 || vy < by0 || vy > by1 || vz < bz0 || vz > bz1) continue;
        const rx = vx - Ax, ry = vy - Ay, rz = vz - Az;
        const along = rx * dirx + ry * diry + rz * dirz;
        if (along <= tol || along >= L - tol) continue;
        const px = rx - along * dirx, py = ry - along * diry, pz = rz - along * dirz;
        if (Math.hypot(px, py, pz) <= tol) {
          if (nts >= _ts.length) { const g = new Float64Array(_ts.length * 2); g.set(_ts); _ts = g; }
          _ts[nts++] = along / L;
        }
      }
    }
    if (nts > 2) _ts.subarray(0, nts).sort();   // Float64Array.sort: số học tăng dần
    // lọc trùng tại chỗ (so với phần tử TRƯỚC trong mảng đã sắp như bản gốc; ghi đè chỉ ở chỉ số ≤ i − 1 nên _ts[i − 1] vẫn nguyên khi đọc)
    let nc = 0;
    for (let i = 0; i < nts; i++) { const v = _ts[i]; if (i === 0 || v - _ts[i - 1] > tol / L) _ts[nc++] = v; }
    // 2) mỗi đoạn con
    let has = false, rsx = 0, rsy = 0, rsz = 0, rex = Ax, rey = Ay, rez = Az;
    for (let i = 0; i + 1 < nc; i++) {
      const f0 = _ts[i], f1 = _ts[i + 1], fm = (f0 + f1) / 2;
      const p0x = Ax + dx * f0, p0y = Ay + dy * f0, p0z = Az + dz * f0;
      const p1x = Ax + dx * f1, p1y = Ay + dy * f1, p1z = Az + dz * f1;
      const mx_ = Ax + dx * fm, my_ = Ay + dy * fm, mz_ = Az + dz * fm;
      const list = grid.get(cellIdx(mx_, my_, mz_));
      let nt = 0;
      if (list) for (let q = 0; q < list.length; q++) {
        const t = list[q], c = touch(t, mx_, my_, mz_);
        if (c) {
          if (nt >= _triT.length) { const g = new Int32Array(_triT.length * 2); g.set(_triT); _triT = g; const h = new Uint8Array(_triC.length * 2); h.set(_triC); _triC = h; }
          _triT[nt] = t; _triC[nt] = c; nt++;
        }
      }
      let hidden = false;
      if (nt) {
        const r = _triT[0] * 3, n1x = nrm[r], n1y = nrm[r + 1], n1z = nrm[r + 2];
        const sx = n1y * dirz - n1z * diry, sy = n1z * dirx - n1x * dirz, sz = n1x * diry - n1y * dirx;
        let allCo = true, pos_ = false, neg = false;
        for (let q = 0; q < nt; q++) {
          const t = _triT[q], n2 = t * 3;
          if (Math.abs(nrm[n2] * n1x + nrm[n2 + 1] * n1y + nrm[n2 + 2] * n1z) < COS_COPLANAR) { allCo = false; break; }
          if (_triC[q] === 2) { pos_ = neg = true; continue; }
          const o9 = t * 9;
          const side = ((pos[o9] + pos[o9 + 3] + pos[o9 + 6]) / 3 - mx_) * sx
            + ((pos[o9 + 1] + pos[o9 + 4] + pos[o9 + 7]) / 3 - my_) * sy
            + ((pos[o9 + 2] + pos[o9 + 5] + pos[o9 + 8]) / 3 - mz_) * sz;
          if (side > 0) pos_ = true; else if (side < 0) neg = true;
        }
        hidden = allCo && pos_ && neg;
      }
      if (hidden) {
        if (has) { out.push(rsx, rsy, rsz, rex, rey, rez); has = false; }
      } else {
        if (!has) { has = true; rsx = p0x; rsy = p0y; rsz = p0z; }
        rex = p1x; rey = p1y; rez = p1z;
      }
    }
    if (has) out.push(rsx, rsy, rsz, rex, rey, rez);
  }
  return new Float32Array(out);
}

/** Thay `new THREE.EdgesGeometry(g, thresholdAngle)` cho mảng tam giác rời (3 đỉnh/tam giác, không index): cùng thuật toán và cùng thứ tự đầu ra
 *  (cạnh có anh em đồng hướng ngược theo thứ tự tam giác, rồi các cạnh lẻ theo thứ tự chèn), nhưng khoá đỉnh/cạnh là số nguyên trong bảng băm mở thay vì chuỗi
 *  `"${x},${y},${z}_…"` (EdgesGeometry của three chiếm ~85% thời gian dựng lưới file_14: 7.7 triệu tam giác -> 57 s). Đỉnh được gộp theo toạ độ làm tròn 1e-4 như bản gốc. */
export function edgesFromTriangles(pos: Float32Array, thresholdAngle = 25): { all: Float32Array; split: number } {
  const nV = pos.length / 3, nT = (nV / 3) | 0;
  if (!nT) return { all: new Float32Array(0), split: 0 };
  const thr = Math.cos(thresholdAngle * Math.PI / 180);
  const pow2 = (n: number) => { let c = 16; while (c < n) c <<= 1; return c; };

  // 1) gộp đỉnh theo toạ độ làm tròn
  const cap = pow2(nV * 2), mask = cap - 1, tab = new Int32Array(cap).fill(-1);
  const rx = new Float64Array(nV), ry = new Float64Array(nV), rz = new Float64Array(nV), vid = new Int32Array(nV);
  for (let i = 0; i < nV; i++) {
    const x = Math.round(pos[i * 3] * 1e4), y = Math.round(pos[i * 3 + 1] * 1e4), z = Math.round(pos[i * 3 + 2] * 1e4);
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & mask;
    for (;;) {
      const s = tab[h];
      if (s < 0) { tab[h] = i; rx[i] = x; ry[i] = y; rz[i] = z; vid[i] = i; break; }
      if (rx[s] === x && ry[s] === y && rz[s] === z) { vid[i] = s; break; }
      h = (h + 1) & mask;
    }
  }

  // 2) cạnh có hướng -> bảng băm; trạng thái 1 = còn, 2 = đã ghép (null)
  const ecap = pow2(nT * 6), emask = ecap - 1;
  const ea = new Int32Array(ecap), eb = new Int32Array(ecap), est = new Uint8Array(ecap), ei0 = new Int32Array(ecap), ei1 = new Int32Array(ecap), etri = new Int32Array(ecap);
  const order = new Int32Array(nT * 3);
  let nOrder = 0;
  const nrm = new Float64Array(nT * 3);
  const out = new Float32Array(nT * 18);
  let no = 0;
  const find = (a: number, b: number): number => {   // vị trí khoá (a, b) hoặc −1 − (ô trống đầu tiên)
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) & emask;
    for (;;) {
      if (!est[h]) return -1 - h;
      if (ea[h] === a && eb[h] === b) return h;
      h = (h + 1) & emask;
    }
  };

  for (let t = 0; t < nT; t++) {
    const o = t * 9, i0 = t * 3, v0 = vid[i0], v1 = vid[i0 + 1], v2 = vid[i0 + 2];
    // pháp tuyến như Triangle.getNormal: (c − b) × (a − b)
    const cx = pos[o + 6] - pos[o + 3], cy = pos[o + 7] - pos[o + 4], cz = pos[o + 8] - pos[o + 5];
    const ax = pos[o] - pos[o + 3], ay = pos[o + 1] - pos[o + 4], az = pos[o + 2] - pos[o + 5];
    let nx = cy * az - cz * ay, ny = cz * ax - cx * az, nz = cx * ay - cy * ax;
    const l2 = nx * nx + ny * ny + nz * nz;
    if (l2 > 0) { const k = 1 / Math.sqrt(l2); nx *= k; ny *= k; nz *= k; } else { nx = ny = nz = 0; }
    nrm[t * 3] = nx; nrm[t * 3 + 1] = ny; nrm[t * 3 + 2] = nz;
    if (v0 === v1 || v1 === v2 || v2 === v0) continue;   // tam giác suy biến
    for (let j = 0; j < 3; j++) {
      const jn = (j + 1) % 3, a = vid[i0 + j], b = vid[i0 + jn];
      const rev = find(b, a);
      if (rev >= 0 && est[rev] === 1) {
        const m = etri[rev] * 3;
        if (nx * nrm[m] + ny * nrm[m + 1] + nz * nrm[m + 2] <= thr) {
          const p = o + j * 3, q = o + jn * 3;
          out[no++] = pos[p]; out[no++] = pos[p + 1]; out[no++] = pos[p + 2];
          out[no++] = pos[q]; out[no++] = pos[q + 1]; out[no++] = pos[q + 2];
        }
        est[rev] = 2;
      } else {
        const f = find(a, b);
        if (f < 0) {   // chưa có khoá (a, b): chèn
          const h = -1 - f;
          ea[h] = a; eb[h] = b; est[h] = 1; ei0[h] = i0 + j; ei1[h] = i0 + jn; etri[h] = t;
          order[nOrder++] = h;
        }
      }
    }
  }
  const split = no;   // [0, split): cạnh gấp (có anh em); [split, no): cạnh lẻ (biên) — chỉ cạnh lẻ mới có thể là cạnh thừa do T-junction
  // cạnh lẻ còn lại theo thứ tự chèn
  for (let k = 0; k < nOrder; k++) {
    const h = order[k];
    if (est[h] !== 1) continue;
    const p = ei0[h] * 3, q = ei1[h] * 3;
    out[no++] = pos[p]; out[no++] = pos[p + 1]; out[no++] = pos[p + 2];
    out[no++] = pos[q]; out[no++] = pos[q + 1]; out[no++] = pos[q + 2];
  }
  return { all: out.slice(0, no), split };
}
