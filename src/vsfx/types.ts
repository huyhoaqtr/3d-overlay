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
  /** thực thể chữ (file bản vẽ): vị trí gốc chữ (verts = [x, y, 0] trong hệ local), chiều cao và nội dung; không có mặt/cạnh */
  text?: { h: number; s: string; /** góc quay trong mặt phẳng chữ (rad) */ rot: number; /** chữ toạ độ MÔ HÌNH tuyệt đối (x = X, y = Z, cao tính theo đơn vị mô hình): nhãn level thứ cấp của view */ abs?: boolean };
  /** vòng tròn (kiểu 00) đã đổi thành đường gấp khúc kín: tâm local + bán kính */
  circle?: { c: Vec3; r: number };
  /** ma trận RIÊNG của dòng chữ (khi ma trận instance sai, vd số lưới 1 ở view South bị rơi về gốc toạ độ) */
  textM?: Matrix4;
  /** true = đường gấp khúc (hình học kiểu 05: ống/đường Revit), không có face; verts là các điểm nối tiếp */
  line?: boolean;
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
  /** thuộc trang giấy (paper space) của file bản vẽ: toạ độ giấy, không phải mô hình 3D */
  paper?: boolean;
  /** nhãn view trên giấy ("South", "Longitudinal Section", gạch chân, số trong vòng): ảnh gốc vẽ màu xanh lá */
  viewLabel?: boolean;
}

/** Một viewport của file bản vẽ: nội dung = bản sao mô hình của view (instance [from, to]) chiếu trực giao (nhìn theo +Y từ phía nam,
 *  X sang phải, Z lên) lên giấy theo giấy = (a + s·X, b + s·Z), chỉ lấy lát mỏng y ∈ [y0 − ε, y0 + depth], cắt theo khung `crop` (toạ độ giấy).
 *  HỆ SỐ a, b, crop, depth HIỆU CHỈNH THEO ẢNH GỐC của sheet3.vsfx (file chưa có bản ghi viewport) — xem markViews trong parseTv.ts. */
export interface SheetView {
  from: number;
  to: number;
  /** mặt phẳng view: Y = y0 (mặt đứng) hoặc, khi `plan`, độ cao cắt Z = y0 (mặt bằng: chiếu X,Y lên giấy) */
  y0: number;
  plan?: boolean;
  /** mặt phẳng (Z, ft) của sàn được rải chấm hatch trong mặt bằng */
  hatchZ?: number;
  /** mặt phẳng (Z, ft) của khoảng thông tầng: tô sọc đen dọc */
  stripeZ?: number;
  a: number;
  b: number;
  s: number;
  depth: number;
  /** 'inside' = shell phải nằm HẲN trong lát; 'touch' = chỉ cần có đỉnh trong lát; 'cut' = shell CẮT QUA mặt phẳng view (kính/tường bị mặt cắt đi qua) */
  slab: 'inside' | 'touch' | 'cut';
  crop: [number, number, number, number];
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
  /** file bản vẽ (Revit sheet): chỉ vẽ phần trang giấy (instance `paper`), bỏ mô hình 3D */
  sheet?: boolean;
  /** file bản vẽ nhưng KHÔNG tìm được khung giấy (school_sheet_1.vsfx: chỉ có chữ khung tên, không có đường khung): vẫn mở như bản vẽ 2D — nhìn thẳng từ trên xuống, không xoay — và hiện cả mô hình như mặt bằng */
  plan?: boolean;
  /** các viewport của file bản vẽ (chỉ khi `sheet`) */
  views?: SheetView[];
  /** handle vật liệu -> màu diffuse (chỉ file OdTv) */
  materials?: Map<number, number>;
}

/** Tóm tắt model gửi từ worker về main thread (model đầy đủ ở lại trong worker). */
export interface ModelSummary {
  format: VsfxFormat;
  shellCount: number;
  /** số shell được vẽ (shell của định nghĩa INSERT được tính theo số lần dùng) */
  meshCount: number;
  /** số dòng chữ đọc được (file bản vẽ) */
  textCount: number;
  /** số đường gấp khúc (kiểu 05) vẽ được; 0 nếu file không có */
  lineCount: number;
  instanceCount: number;
  records: number;
  transforms: number;
  inserts: number;
  skipped: number;
  unitMM: number;
}

export type ChunkKind = 'opaque' | 'glass' | 'faceCol' | 'wire';

/** Một khối lưới đã gộp, sẵn sàng tạo BufferGeometry (toạ độ world, Z lên). */
export interface MeshChunk {
  kind: ChunkKind;
  /** màu vật liệu 0xRRGGBB (không dùng với faceCol) */
  color: number;
  /** độ đục lấy từ vật liệu trong file (chỉ kính; 0 = trong suốt 100%); −1 = không có, dùng GLASS.opacity */
  opacity: number;
  positions: Float32Array;
  /** pháp tuyến theo đỉnh — CHỈ có cho kính; rỗng với chunk đặc (vật liệu flatShading tính pháp tuyến từ đạo hàm) */
  normals: Float32Array;
  /** màu theo đỉnh (linear) cho faceCol */
  colors: Float32Array | null;
  /** đoạn thẳng cạnh (EdgesGeometry, ngưỡng 25°) */
  edges: Float32Array;
  /** Nén (chỉ khi BuildOptions.quantEdges, không áp cho 'wire'): toạ độ lưu Int16 chuẩn hoá [-1,1] quanh tâm/nửa-kích-thước `box` = [cx,cy,cz,hx,hy,hz] của bbox đỉnh chunk
   *  (cạnh và mặt dùng CHUNG lưới lượng tử nên khớp nhau). `edgesQ` thay `edges` (rỗng); `positionsQ` thay `positions` (rỗng) — trừ kính (pháp tuyến + trong suốt: giữ Float32). Nửa RAM (CPU + GPU) */
  box?: number[];
  edgesQ?: Int16Array;
  positionsQ?: Int16Array;
  /** các đoạn thuộc từng entity, bước 5: [entityId, vStart, vCount, eStart, eCount] (tính theo đỉnh;
   *  vStart/vCount cho tam giác, eStart/eCount cho cạnh). Sắp tăng dần theo vStart. */
  ranges: Uint32Array;
}

export const RANGE_STRIDE = 5;

/** Một dòng chữ đã quy về toạ độ world của file (chưa nhân tỉ lệ đơn vị): gốc, hai trục đơn vị của mặt chữ, chiều cao. */
export interface TextItem {
  entity: number;
  color: number;
  text: string;
  origin: Vec3;
  /** hướng chữ chạy (đơn vị) */
  ax: Vec3;
  /** hướng "lên" của chữ (đơn vị) */
  ay: Vec3;
  /** chiều cao chữ theo đơn vị file */
  height: number;
}

export interface MeshData {
  /** mỗi chunk = một vật liệu (loại + màu), gộp mọi entity */
  chunks: MeshChunk[];
  /** tên đối tượng theo id (id = nhóm instance; xem Instance.group) */
  entities: string[];
  /** ID hiển thị của từng đối tượng (xem Instance.handle); '#n' nếu không có */
  handles: string[];
  /** chữ (file bản vẽ); rỗng nếu file không có */
  texts: TextItem[];
  /** true = file bản vẽ: chỉ có phần trang giấy (nhìn thẳng từ trên xuống) */
  sheet: boolean;
  /** bản vẽ 2D không khung (xem VsfxModel.plan) */
  plan: boolean;
}

/** noEdges: không dựng cạnh của mặt (chỉ worker đặt, khi thiết bị ít RAM mở model quá lớn — cạnh chiếm ~90 MB × 2 (CPU + GPU) với file_14) */
export type BuildOptions = Pick<ViewOptions, 'glass' | 'debugColors'> & { noEdges?: boolean; quantEdges?: boolean };

export type LoadStage = 'decompress' | 'parse' | 'mesh';

export interface ViewOptions {
  edges: boolean;
  light: boolean;
  glass: boolean;
  debugColors: boolean;
  /** độ tương phản hình (1 = mặc định) */
  contrast: number;
}

export interface SceneInfo {
  /** kích thước bbox (dài, rộng, cao) theo đơn vị file */
  size: Vec3;
}
