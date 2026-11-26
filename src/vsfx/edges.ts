/* Lọc cạnh thừa do T-junction.
 *
 * EdgesGeometry coi một cạnh là "biên" khi nó chỉ thuộc một tam giác, so khớp theo toạ độ đỉnh. Khi tường
 * bị cắt thành nhiều face quanh ô cửa, cạnh dài của face này (vd mép trên dải cửa sổ) đối diện với nhiều
 * cạnh ngắn của face bên dưới -> không khớp từng cặp -> cả hai đều bị vẽ dù hai face nằm cùng một mặt phẳng.
 *
 * Ở đây mỗi cạnh được cắt tại các đỉnh nằm trên nó, rồi từng đoạn bị bỏ nếu hai bên đoạn đều có tam giác
 * gần như đồng phẳng (tức đoạn nằm giữa một mặt liền). Đoạn thật sự là biên (mép lỗ cửa) chỉ có một bên nên giữ. */

const COS_COPLANAR = Math.cos(25 * Math.PI / 180);   // cùng ngưỡng với EdgesGeometry
const GRID = 24;
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
