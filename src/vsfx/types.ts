import type { Matrix4 } from 'three';

export type Vec3 = [number, number, number];

/** Một lưới (shell) đọc từ luồng nhị phân. Toạ độ ở hệ local của entity/instance chứa nó. */
export interface Shell {
  /** offset (trong luồng đã giải nén) của mảng đỉnh */
  off: number;
  /** offset ngay sau face list */
  end: number;
  /** cnt × (x, y, z) */
  verts: Float64Array;
  /** face list chuẩn hoá: (n, i0..in-1)...; n âm = lỗ của face trước */
  faces: Int32Array;
  /** màu theo từng face (0xRRGGBB), nếu file có */
  faceColors: Int32Array | null;
  /** màu ghi ngay trong header shell (biến thể header có thuộc tính, vd school.vsfx) */
  color?: number;
  /** handle vật liệu ghi ngay trong header shell (cùng biến thể trên) */
  mat?: number;
  /** cache tam giác (chỉ số đỉnh), tạo khi dựng scene */
  tri?: number[];
  /** chỉ số face của từng tam giác (song song với tri / 3) */
  triFace?: number[];
}

/** Một nhóm shell dùng chung một màu (0 = không có màu). */
export interface Part {
  color: number;
  /** độ đục của vật liệu (0..1) nếu file lưu và < 1 (kính); bỏ trống = đặc */
  opacity?: number;
  shells: Shell[];
}

/** Tham số INSERT kiểu AutoCAD: world = OCS(N) · (P + Rz(ang) · S · v). */
export interface InsertParams {
  P: Vec3;
  S: Vec3;
  ang: number;
  N: Vec3;
  /** handle của định nghĩa hình học (dùng chung giữa các INSERT) */
  h: number;
}

export interface Instance {
  parts: Part[];
  /** ma trận local -> world */
  M: Matrix4;
  name: string;
  /** các instance cùng group là một đối tượng khi chọn / ẩn (vd ghế = mặt ghế + chân khác màu); mặc định mỗi instance một nhóm */
  group?: number;
  /** ID hiển thị của đối tượng chứa instance — giá trị lấy từ file:
   *  IFC: handle của node IFC đứng NGAY SAU dữ liệu entity (u32 ở +22 của node; vd cây trong dont.vsfx = 18258), in thập phân;
   *  OdTv: Element ID của Revit (bản ghi phần tử chứa đối tượng; vd mái revit.vsfx = 243274), in thập phân;
   *  không có phần tử thì handle CSDL (hex). */
  handle?: string;
  /** handle bản ghi trong cơ sở dữ liệu .vsfx (IFC: khoá bảng extents; OdTv: bản ghi mang ma trận / cấp cao) — gỡ lỗi */
  dbHandle?: number;
  insert?: InsertParams;
}

export type VsfxFormat = 'IFC' | 'OdTv (Revit)';

export interface VsfxModel {
  format: VsfxFormat;
  shells: Shell[];
  instances: Instance[];
  /** số node (IFC) hoặc bản ghi (OdTv) */
  records: number;
  transforms: number;
  /** số định nghĩa block INSERT */
  inserts: number;
  /** số shell không được tham chiếu (bị ẩn) */
  skipped: number;
  /** số mm của 1 đơn vị file */
  unitMM: number;
  /** handle vật liệu -> màu diffuse (chỉ file OdTv) */
  materials?: Map<number, number>;
}

/** Tóm tắt model gửi từ worker về main thread (model đầy đủ ở lại trong worker). */
export interface ModelSummary {
  format: VsfxFormat;
  shellCount: number;
  /** số shell được vẽ (shell của định nghĩa INSERT được tính theo số lần dùng) */
  meshCount: number;
  instanceCount: number;
  records: number;
  transforms: number;
  inserts: number;
  skipped: number;
  unitMM: number;
}

export type ChunkKind = 'opaque' | 'glass' | 'faceCol';

/** Một khối lưới đã gộp, sẵn sàng tạo BufferGeometry (toạ độ world, Z lên). */
export interface MeshChunk {
  kind: ChunkKind;
  /** màu vật liệu 0xRRGGBB (không dùng với faceCol) */
  color: number;
  /** độ đục lấy từ vật liệu trong file (chỉ kính; 0 = trong suốt 100%); −1 = không có, dùng GLASS.opacity */
  opacity: number;
  positions: Float32Array;
  normals: Float32Array;
  /** màu theo đỉnh (linear) cho faceCol */
  colors: Float32Array | null;
  /** đoạn thẳng cạnh (EdgesGeometry, ngưỡng 25°) */
  edges: Float32Array;
  /** các đoạn thuộc từng entity, bước 5: [entityId, vStart, vCount, eStart, eCount] (tính theo đỉnh;
   *  vStart/vCount cho tam giác, eStart/eCount cho cạnh). Sắp tăng dần theo vStart. */
  ranges: Uint32Array;
}

export const RANGE_STRIDE = 5;

export interface MeshData {
  /** mỗi chunk = một vật liệu (loại + màu), gộp mọi entity */
  chunks: MeshChunk[];
  /** tên đối tượng theo id (id = nhóm instance; xem Instance.group) */
  entities: string[];
  /** ID hiển thị của từng đối tượng (xem Instance.handle); '#n' nếu không có */
  handles: string[];
}

export type BuildOptions = Pick<ViewOptions, 'glass' | 'debugColors'>;

export type LoadStage = 'decompress' | 'parse' | 'mesh';

export interface ViewOptions {
  edges: boolean;
  light: boolean;
  glass: boolean;
  debugColors: boolean;
}

export interface SceneInfo {
  /** kích thước bbox (dài, rộng, cao) theo đơn vị file */
  size: Vec3;
}
