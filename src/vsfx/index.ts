/* API main thread của parser .vsfx (ODA Visualize), tự viết, không dùng loader.
 * Không có spec công khai: mọi quy tắc được suy ra bằng reverse-engineering trên file mẫu
 * và kiểm chứng bằng bảng extents trong file.
 *
 *   main: VsfxWorkerClient.load(ArrayBuffer) ──► worker: readStream -> parseRaw -> (giữ model)
 *         VsfxWorkerClient.build(options)    ──► worker: buildMeshData -> MeshData (transfer)
 *   main: new SceneModel(MeshData) -> group + chọn/ẩn/cô lập */
export { VsfxWorkerClient, AbortedError } from './client';
export { SceneModel } from './buildScene';
export type { Batch, PartRange } from './buildScene';
export { SelectionController } from './selection';
export type { SelectionInfo } from './selection';
export { unitLabel } from './units';
export type * from './types';
