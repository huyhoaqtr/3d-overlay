/* Nhánh IFC (file ODA Visualize sinh từ IFC2x3 / IFC4).
 *  - Node:  marker 40 10 11 00 00 01 01 00 00 00 72; owner (u32) ở offset +44.
 *    Owner phổ biến nhất = model space; owner khác = thân block của entity model-space liền trước,
 *    dùng chung ma trận với entity đó.
 *  - Entity: header [B G R] [C0..C8] (FF FF | 00 00) | u16 len | tên UTF-16 (vd OdIfc2x3::IfcWallStandardCase).
 *    Màu là OdCmEntityColor (0xC2 = by RGB). Shell nằm sau header thuộc entity đó.
 *    Header con ('' hoặc *::IfcShapeRepresentation) gắn vào entity cấp trên trong cùng node.
 *  - Transform entity thường: ma trận trực giao nằm ở CUỐI phạm vi entity (ngay trước node kế tiếp).
 *  - Entity INSERT (OdIfcRepresentationMap): ngay trước header là
 *    18 00 1D 00 00 00 00 00 01 + 12 byte 0 | pos(3) scale(3) angle normal(3) | u64 handle | 00 0D (06|04)
 *    Hình học của handle chỉ lưu ở lần xuất hiện đầu, các INSERT sau dùng lại.
 *    world = OCS(normal) · (pos + Rz(angle) · S · v)   (Arbitrary Axis Algorithm của AutoCAD) */
import * as THREE from 'three';
import { views, scanTransforms, lastLE, scanExtents, scanSourceRecords } from './scan';
import { detectUnitMM } from './units';
import type { InsertParams, Instance, Part, Shell, VsfxModel } from './types';

export interface IfcNode {
  off: number;
  owner: number;
  /** handle của node: u32 ở +22 (sau 08 00 00 00 ở +18) */
  handle: number;
}

interface Entity {
  p: number;
  name: string;
  color: number;
  insert?: InsertParams;
}

interface TopEntity extends Entity {
  ni: number;
  parts: Part[];
  end: number;
}

const NODE_MARK = [0x40, 0x10, 0x11, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x72];

export function scanIfcNodes(raw: Uint8Array): IfcNode[] {
  const L = raw.length, { u32 } = views(raw), nodes: IfcNode[] = [];
  outer: for (let o = 0; o + 60 <= L; o++) {
    for (let k = 0; k < NODE_MARK.length; k++) if (raw[o + k] !== NODE_MARK[k]) continue outer;
    nodes.push({ off: o, owner: u32(o + 44), handle: u32(o + 22) });
  }
  return nodes;
}

function insertMatrix({ P, S, ang, N }: InsertParams): THREE.Matrix4 {
  const n = new THREE.Vector3(...N).normalize();
  const ax = (Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64)
    ? new THREE.Vector3(0, 1, 0).cross(n) : new THREE.Vector3(0, 0, 1).cross(n);
  ax.normalize();
  const ay = new THREE.Vector3().crossVectors(n, ax).normalize();
  return new THREE.Matrix4().makeBasis(ax, ay, n)
    .multiply(new THREE.Matrix4().makeTranslation(P[0], P[1], P[2]))
    .multiply(new THREE.Matrix4().makeRotationZ(ang))
    .multiply(new THREE.Matrix4().makeScale(S[0], S[1], S[2]));
}

function scanEntities(raw: Uint8Array): Entity[] {
  const L = raw.length, { f64, u32 } = views(raw), ents: Entity[] = [];
  for (let p = 3; p + 5 <= L; p++) {
    if (raw[p] < 0xc0 || raw[p] > 0xc8) continue;
    const ffff = raw[p + 1] === 0xff && raw[p + 2] === 0xff, zero = !raw[p + 1] && !raw[p + 2];
    if (!ffff && !zero) continue;
    const len = raw[p + 3] | (raw[p + 4] << 8);
    if (len > 80 || p + 5 + len * 2 > L || (zero && len < 3)) continue;
    let name = '', ok = true;
    for (let i = 0; i < len; i++) {
      const lo = raw[p + 5 + i * 2], hi = raw[p + 6 + i * 2];
      if (hi || lo < 0x20 || lo > 0x7e) { ok = false; break; }
      name += String.fromCharCode(lo);
    }
    if (!ok) continue;
    const color = raw[p] === 0xc2 ? (raw[p - 1] << 16) | (raw[p - 2] << 8) | raw[p - 3] : 0;
    const ent: Entity = { p, name, color };
    const q = p - 115;
    if (q >= 0 && raw[q] === 0x18 && raw[q + 1] === 0 && raw[q + 2] === 0x1d && raw[q + 8] === 1 &&
        raw[q + 110] === 0x0d && (raw[q + 111] === 0x06 || raw[q + 111] === 0x04)) {
      const d = (i: number) => f64(q + 21 + i * 8);
      ent.insert = { P: [d(0), d(1), d(2)], S: [d(3), d(4), d(5)], ang: d(6), N: [d(7), d(8), d(9)], h: u32(q + 101) };
    }
    ents.push(ent);
    p += 4 + len * 2;
  }
  return ents;
}

export function parseIfc(raw: Uint8Array, shells: Shell[], nodes: IfcNode[]): VsfxModel {
  const L = raw.length;
  const ownerCount = new Map<number, number>();
  for (const n of nodes) ownerCount.set(n.owner, (ownerCount.get(n.owner) ?? 0) + 1);
  const modelOwner = [...ownerCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const xfs: { off: number; M: THREE.Matrix4 }[] = [];
  scanTransforms(raw, nodes[0].off - 2000, (off, M) => xfs.push({ off, M }));
  const ents = scanEntities(raw);
  const nodeAt = (p: number) => lastLE(nodes, p, n => n.off);

  // Mỗi header -> một "phần" gồm các shell đứng sau nó (tới header/node kế tiếp).
  const isSub = (n: string) => n === '' || n.endsWith('::IfcShapeRepresentation');
  const top: TopEntity[] = [];
  let si = 0;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i], ni = nodeAt(e.p);
    let bound = i + 1 < ents.length ? ents[i + 1].p - 120 : L;
    if (ni + 1 < nodes.length) bound = Math.min(bound, nodes[ni + 1].off);
    while (si < shells.length && shells[si].off < e.p) si++;
    const part: Part = { color: e.color, shells: [] };
    for (let k = si; k < shells.length && shells[k].off < bound; k++) part.shells.push(shells[k]);
    const parent = top[top.length - 1];
    if (!e.insert && isSub(e.name) && parent && parent.ni === ni) {
      parent.parts.push(part); parent.end = bound;
    } else {
      top.push({ ...e, ni, parts: [part], end: bound });
    }
  }

  // ID hiển thị = handle IFC: bản ghi `01 01 00 00 00 72 | 00×7 | 08 00 00 00 | u32` ĐẦU TIÊN sau header entity.
  //  - entity thường: là node đứng sau dữ liệu của nó (cây dont.vsfx = 18258, xác nhận bằng viewer gốc);
  //  - INSERT (cửa sổ/cửa đi, OdIfcRepresentationMap): có bản ghi riêng ngay sau tên (77022, 77033… tăng dần) —
  //    trước đây lấy node phía sau nên cửa sổ bị gộp vào sàn/tường đứng sau chúng.
  const srcRecs = scanSourceRecords(raw);
  const nodeHandleAfter = (p: number) => {
    const k = lastLE(srcRecs, p, r => r.o) + 1;
    return k < srcRecs.length ? String(srcRecs[k].id) : undefined;
  };
  const defs = new Map<number, Part[]>(), instances: Instance[] = [], blocks: number[] = [];
  let xi = 0, skipped = 0, lastM: THREE.Matrix4 | null = null, lastGroup = -1;
  for (const e of top) {
    const parts = e.parts.filter(pt => pt.shells.length);
    if (e.insert) {
      const h = e.insert.h;
      if (parts.length && !defs.has(h)) defs.set(h, parts);
      const geo = parts.length ? parts : (defs.get(h) ?? []);
      if (geo.length) instances.push({ parts: geo, M: insertMatrix(e.insert), name: e.name, insert: e.insert, group: instances.length, handle: nodeHandleAfter(e.p) });
      continue;
    }
    if (!parts.length) continue;
    const owner = e.ni >= 0 ? nodes[e.ni].owner : modelOwner;
    if (owner !== modelOwner && e.name === '') {
      if (!lastM) { skipped += parts.reduce((a, pt) => a + pt.shells.length, 0); continue; }
      // thân block là một phần của entity model-space liền trước (bảng extents gộp chung bbox) -> cùng nhóm chọn
      blocks.push(instances.length);
      instances.push({ parts, M: lastM, name: '(block)', group: lastGroup, handle: instances[instances.length - 1]?.handle });
      continue;
    }
    let M: THREE.Matrix4 | null = null;
    while (xi < xfs.length && xfs[xi].off < e.p) xi++;
    for (let k = xi; k < xfs.length && xfs[k].off < e.end; k++) M = xfs[k].M;
    lastM = M ?? new THREE.Matrix4();
    lastGroup = instances.length;
    instances.push({ parts, M: lastM, name: e.name, group: lastGroup, handle: nodeHandleAfter(e.p) });
  }
  const unitMM = detectUnitMM(raw) ?? 1;
  const ext = scanExtents(raw);
  resolveBlockMatrices(ext, instances, blocks, unitMM);
  assignDbHandles(ext, instances, unitMM);
  return {
    format: 'IFC', shells, instances, records: nodes.length, transforms: xfs.length,
    inserts: defs.size, skipped, unitMM,
  };
}

/* Handle bản ghi trong cơ sở dữ liệu .vsfx (khác handle IFC ở node): lấy từ bảng extents — bbox world của nhóm khớp
 * đúng MỘT mục (dung sai 15 mm). dont.vsfx 158/160, mp.vsfx 2107/2351. Chỉ để gỡ lỗi (in trong console khi chọn). */
function assignDbHandles(ext: Extent[], instances: Instance[], unitMM: number) {
  if (!ext.length) return;
  const tol = 15 / unitMM, cell = Math.max(tol * 4, 1);
  const idx = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  ext.forEach((e, i) => { const k = key(e.bb[0], e.bb[1]); const l = idx.get(k); if (l) l.push(i); else idx.set(k, [i]); });

  const boxes = new Map<number, number[]>(), v = new THREE.Vector3();
  for (const ins of instances) {
    const g = ins.group!;
    let b = boxes.get(g);
    if (!b) boxes.set(g, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (const p of ins.parts) for (const sh of p.shells)
      for (let k = 0; k < sh.verts.length; k += 3) {
        v.set(sh.verts[k], sh.verts[k + 1], sh.verts[k + 2]).applyMatrix4(ins.M);
        if (v.x < b[0]) b[0] = v.x; if (v.y < b[1]) b[1] = v.y; if (v.z < b[2]) b[2] = v.z;
        if (v.x > b[3]) b[3] = v.x; if (v.y > b[4]) b[4] = v.y; if (v.z > b[5]) b[5] = v.z;
      }
  }
  const handleOf = new Map<number, number>();
  for (const [g, b] of boxes) {
    const cx = Math.floor(b[0] / cell), cy = Math.floor(b[1] / cell), found = new Set<number>();
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++)
      for (const i of idx.get(`${cx + a},${cy + c}`) ?? [])
        if (ext[i].bb.every((x, d) => Math.abs(x - b[d]) <= tol)) found.add(ext[i].h);
    if (found.size === 1) handleOf.set(g, [...found][0]);
  }
  for (const ins of instances) ins.dbHandle = handleOf.get(ins.group!);
}

type Extent = ReturnType<typeof scanExtents>[number];

/** bbox world của các instance (áp M, hoặc ma trận thay thế `M`) */
function worldBox(list: Instance[], M?: THREE.Matrix4): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], v = new THREE.Vector3();
  for (const ins of list) {
    const m = M ?? ins.M;
    for (const p of ins.parts) for (const sh of p.shells)
      for (let k = 0; k < sh.verts.length; k += 3) {
        v.set(sh.verts[k], sh.verts[k + 1], sh.verts[k + 2]).applyMatrix4(m);
        if (v.x < b[0]) b[0] = v.x; if (v.y < b[1]) b[1] = v.y; if (v.z < b[2]) b[2] = v.z;
        if (v.x > b[3]) b[3] = v.x; if (v.y > b[4]) b[4] = v.y; if (v.z > b[5]) b[5] = v.z;
      }
  }
  return b;
}

/** Tra nhanh "bbox này có trong bảng extents không" (dung sai 15 mm). */
function extentIndex(ext: Extent[], unitMM: number) {
  const tol = 15 / unitMM, cell = Math.max(tol * 4, 1), idx = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  ext.forEach((e, i) => { const k = key(e.bb[0], e.bb[1]); const l = idx.get(k); if (l) l.push(i); else idx.set(k, [i]); });
  return (b: number[]) => {
    const found = new Set<number>(), cx = Math.floor(b[0] / cell), cy = Math.floor(b[1] / cell);
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++)
      for (const i of idx.get(`${cx + a},${cy + c}`) ?? [])
        if (ext[i].bb.every((x, d) => Math.abs(x - b[d]) <= tol)) found.add(ext[i].h);
    return found;
  };
}

/* Thân block (node owner ≠ model space, entity không tên) mặc định dùng ma trận của entity model-space liền trước
 * (đúng cho bộ bàn ghế dont.vsfx). Nhưng ở ikoma.vsfx nhiều thân block ĐÃ ở toạ độ world: áp thêm ma trận cha đẩy chúng
 * đi vài chục mét (khối lơ lửng trên mái). Quyết định bằng bảng extents: không áp ma trận mà khớp bảng (riêng nó, hoặc
 * gộp với entity cha), còn áp ma trận cha thì không khớp -> giữ nguyên toạ độ. File không có bảng -> giữ cách cũ. */
function resolveBlockMatrices(ext: Extent[], instances: Instance[], blocks: number[], unitMM: number) {
  if (!ext.length || !blocks.length) return;
  const has = extentIndex(ext, unitMM), ident = new THREE.Matrix4(), isBlock = new Set(blocks);
  const parentsOf = new Map<number | undefined, Instance[]>();
  instances.forEach((x, k) => {
    if (isBlock.has(k)) return;
    const l = parentsOf.get(x.group);
    if (l) l.push(x); else parentsOf.set(x.group, [x]);
  });
  for (const i of blocks) {
    const ins = instances[i];
    const parents = parentsOf.get(ins.group) ?? [];
    const fits = (M?: THREE.Matrix4) => {
      if (has(worldBox([ins], M)).size) return true;
      if (!parents.length) return false;
      const a = worldBox(parents), b = worldBox([ins], M);
      return has([0, 1, 2, 3, 4, 5].map(d => (d < 3 ? Math.min(a[d], b[d]) : Math.max(a[d], b[d])))).size > 0;
    };
    if (!fits() && fits(ident)) ins.M = ident;
  }
}
