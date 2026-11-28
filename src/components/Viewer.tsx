import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SceneModel, SelectionController } from '../vsfx';
import type { MeshData, SelectionInfo, Vec3 } from '../vsfx';

/** Một file đã dựng lưới để vẽ (overlay: nhiều file chồng lên nhau trong cùng hệ toạ độ). */
export interface ViewLayer {
  /** định danh lần tải — đổi key = model mới */
  key: number;
  name: string;
  data: MeshData;
  /** số mm của 1 đơn vị file: mọi layer được quy về MÉT để chồng khớp nhau */
  unitMM: number;
  visible: boolean;
}

/** Thao tác chọn/ẩn mà App gọi vào Viewer. */
/** Bản vẽ 2D (sheet): tắt xoay, chuột trái = kéo (pan), lăn = zoom; trở lại bình thường khi không còn bản vẽ. */
function setSheetControls(c: ViewerContext, sheet: boolean) {
  const ctl = c.controls;
  ctl.enableRotate = !sheet;
  ctl.mouseButtons = { LEFT: sheet ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  ctl.touches = { ONE: sheet ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  ctl.screenSpacePanning = true;
}

export interface ViewerHandle {
  hideSelected(): void;
  isolateSelected(): void;
  showAll(): void;
  clearSelection(): void;
}

interface Props {
  layers: ViewLayer[];
  /** key của layer đang được tô sáng cả model (chọn tên file); null = không */
  highlightKey: number | null;
  edges: boolean;
  light: boolean;
  /** độ tương phản hình (1 = mặc định) */
  contrast: number;
  /** kích thước (m) của từng layer, theo trục file (dài, rộng, cao) */
  onLayerSize?: (key: number, size: Vec3) => void;
  onSelect?: (info: SelectionInfo | null) => void;
  onHiddenChange?: (hasHidden: boolean) => void;
}

interface LayerState {
  key: number;
  name: string;
  data: MeshData;
  /** nhóm scale đơn vị file -> mét, nằm trong `world` */
  holder: THREE.Group;
  model: SceneModel;
  selection: SelectionController;
}

interface ViewerContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  invalidate: () => void;
  /** gốc chung: xoay Z-lên -> Y-lên và dời về tâm của layer đầu tiên */
  world: THREE.Group;
  /** đã đặt gốc + căn camera theo layer đầu tiên chưa (reset khi không còn layer nào) */
  anchored: boolean;
  layers: Map<number, LayerState>;
  /** layer đang có đối tượng được chọn */
  active: LayerState | null;
  size: [number, number];
}

const CLICK_SLOP_PX = 5;

/* Khung nhìn Three.js. Renderer/camera/controls tạo một lần khi mount; mỗi file là một layer (SceneModel riêng),
 * tất cả quy về mét trong một gốc chung để chồng lên nhau. Chọn xuyên mọi layer (giao điểm gần nhất). Chỉ render khi
 * có thay đổi (camera, kích thước, tùy chọn, chọn/ẩn) nên lúc đứng yên GPU nghỉ. */
const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(
  { layers, highlightKey, edges, light, contrast, onLayerSize, onSelect, onHiddenChange }, ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<ViewerContext | null>(null);
  // callback giữ trong ref để đổi callback không làm dựng lại scene
  const cbs = useRef({ onSelect, onHiddenChange, onLayerSize });
  cbs.current = { onSelect, onHiddenChange, onLayerSize };

  const reportHidden = () => {
    const c = ctx.current;
    cbs.current.onHiddenChange?.(!!c && [...c.layers.values()].some(l => l.model.hasHidden));
  };
  /** chọn `id` trong layer `l` (null = bỏ chọn ở mọi layer) */
  const selectIn = (l: LayerState | null, id: number | null) => {
    const c = ctx.current;
    if (!c) return;
    for (const other of c.layers.values()) if (other !== l) other.selection.select(null);
    c.active = l && id != null ? l : null;
    if (l) l.selection.select(id);
    if (!l || id == null) cbs.current.onSelect?.(null);
  };

  // handle (nút trên panel + phím tắt) — đọc handleRef để luôn dùng phiên bản mới nhất
  useImperativeHandle(ref, () => ({
    hideSelected: () => handleRef.current.hideSelected(),
    isolateSelected: () => handleRef.current.isolateSelected(),
    showAll: () => handleRef.current.showAll(),
    clearSelection: () => handleRef.current.clearSelection(),
  }), []);

  // --- khởi tạo / dọn dẹp
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 1e6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Phối sáng: môi trường studio (IBL) cho độ chuyển sắc mềm + đèn chính ấm từ một phía (tạo tương phản mặt sáng/tối)
    // + đèn phụ lạnh phía đối diện (giữ mặt khuất không bị bẩn/xám) + bán cầu nhẹ.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    // Theo three-gltf-viewer: RoomEnvironment + đèn môi trường + đèn định hướng gắn vào camera (~60°), nên mặt đang nhìn
    // luôn được chiếu sáng, không phụ thuộc hướng xoay model. Cường độ hạ so với mặc định của họ (0.3 / 0.8π):
    // vật liệu IFC/Revit vốn nhạt, giữ nguyên thì trắng bị cháy (đã so bằng mắt trên file_4).
    scene.add(camera);
    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    const main = new THREE.DirectionalLight(0xffffff, 1.2);
    main.position.set(0.5, 0, 0.866);
    camera.add(ambient, main);
    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2;            // file dùng Z lên -> Three dùng Y lên
    scene.add(world);

    let dirty = true;
    const invalidate = () => { dirty = true; };
    const c: ViewerContext = {
      renderer, scene, camera, controls, invalidate, world, anchored: false, layers: new Map(), active: null, size: [1, 1],
    };

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      c.size = [w, h];
      for (const l of c.layers.values()) l.selection.setResolution(w, h);
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    controls.addEventListener('change', invalidate);
    renderer.setAnimationLoop(() => {
      controls.update();                       // có damping: phát 'change' khi còn đang trôi
      if (!dirty) return;
      dirty = false;
      renderer.render(scene, camera);
    });

    // Click (không kéo) -> chọn: raycast mọi layer đang hiện, lấy giao điểm gần nhất.
    const dom = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    (raycaster as THREE.Raycaster & { firstHitOnly: boolean }).firstHitOnly = true;   // BVH dừng ở giao điểm đầu
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
      const rect = dom.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
      let best: { l: LayerState; id: number; distance: number } | null = null;
      for (const l of c.layers.values()) {
        if (!l.holder.visible) continue;
        const h = l.selection.hitTest(raycaster);
        if (h && (!best || h.distance < best.distance)) best = { l, ...h };
      }
      selectIn(best?.l ?? null, best?.id ?? null);
    };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const h = handleRef.current;
      if (e.key === 'Escape') h.clearSelection();
      else if (e.key === 'h' || e.key === 'H') e.shiftKey ? h.showAll() : h.hideSelected();
      else if (e.key === 'i' || e.key === 'I') h.isolateSelected();
    };
    window.addEventListener('keydown', onKey);

    ctx.current = c;
    // Hook gỡ lỗi (chỉ dev): điều khiển camera / chọn object từ console
    if (import.meta.env.DEV) (window as unknown as { __viewer?: unknown }).__viewer = c;
    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      controls.removeEventListener('change', invalidate);
      controls.dispose();
      envTex.dispose(); pmrem.dispose();
      for (const l of c.layers.values()) { l.selection.dispose(); l.model.dispose(); }
      renderer.dispose();
      el.removeChild(dom);
      ctx.current = null;
    };
  }, []);

  // handle dùng trong phím tắt (đọc qua ref để không phụ thuộc vòng đời effect)
  const handleRef = useRef<ViewerHandle>(null as unknown as ViewerHandle);
  handleRef.current = {
    hideSelected: () => { ctx.current?.active?.selection.hideSelected(); },
    isolateSelected: () => {
      const c = ctx.current, a = c?.active;
      if (!c || !a || a.selection.selectedId == null) return;
      a.selection.isolateSelected();
      for (const l of c.layers.values()) if (l !== a) l.model.isolate(new Set());
      reportHidden();
      c.invalidate();
    },
    showAll: () => { const c = ctx.current; if (c) for (const l of c.layers.values()) l.selection.showAll(); },
    clearSelection: () => selectIn(null, null),
  };

  // --- tương phản (bộ lọc trên canvas: áp lên cả cạnh/kính, không cần dựng lại cảnh)
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.renderer.domElement.style.filter = contrast === 1 ? '' : `contrast(${contrast})`;
  }, [contrast]);

  // --- nền
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.scene.background = new THREE.Color(light ? 0xffffff : 0x1b1e24);
    c.invalidate();
  }, [light]);

  // --- đồng bộ layer: tạo / thay / gỡ SceneModel theo (key, data); cập nhật hiện/ẩn
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const wanted = new Map(layers.map(l => [l.key, l]));
    // còn giữ lại layer nào từ trước không? Không (mở file mới thay toàn bộ) -> đặt lại gốc + camera theo file mới.
    // Có (thêm file chồng, dựng lại lưới khi đổi tùy chọn) -> giữ nguyên gốc và camera.
    const keepsAny = [...c.layers.keys()].some(k => wanted.has(k));
    let changed = false;

    for (const [key, st] of c.layers) {
      const w = wanted.get(key);
      if (w && w.data === st.data) continue;
      // bị gỡ hoặc dựng lại lưới (đổi tùy chọn kính / màu debug)
      if (c.active === st) { c.active = null; cbs.current.onSelect?.(null); }
      c.world.remove(st.holder);
      st.selection.dispose();
      st.model.dispose();
      c.layers.delete(key);
      changed = true;
    }
    if (!keepsAny) { c.anchored = false; c.world.position.set(0, 0, 0); setSheetControls(c, false); }

    for (const l of layers) {
      if (c.layers.has(l.key)) continue;
      const s = l.unitMM / 1000;               // số mét của 1 đơn vị file
      const model = new SceneModel(l.data);
      const holder = new THREE.Group();
      holder.scale.setScalar(s);
      holder.add(model.group);
      c.world.add(holder);
      const st: LayerState = { key: l.key, name: l.name, data: l.data, holder, model, selection: null as unknown as SelectionController };
      st.selection = new SelectionController(model, {
        onSelect: info => { if (info) cbs.current.onSelect?.({ ...info, file: st.name }); },
        onHiddenChange: () => reportHidden(),
        invalidate: c.invalidate,
      }, s);
      st.selection.setResolution(...c.size);
      model.setEdgesVisible(edges);
      c.layers.set(l.key, st);
      changed = true;

      // kích thước của riêng layer (m), theo trục file: Box3 trong hệ `world` rồi đổi (x, z, y) -> (dài, rộng, cao)
      c.world.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder);
      const size = box.getSize(new THREE.Vector3());
      cbs.current.onLayerSize?.(l.key, [size.x, size.z, size.y]);

      if (!c.anchored) {
        // Layer đầu tiên quyết định gốc chung (các file chồng sau giữ nguyên toạ độ dự án) và vị trí camera
        const center = box.getCenter(new THREE.Vector3());
        c.world.position.sub(center);
        const r = Math.max(size.x, size.y, size.z) || 1;
        // file bản vẽ (sheet): nhìn thẳng từ trên xuống, trục Y của giấy hướng lên màn hình (y file = −z Three)
        if (l.data.sheet || l.data.plan) { c.camera.position.set(0, r * 1.1, r * 0.002); setSheetControls(c, true); }
        else c.camera.position.set(r * .55, r * .75, r * .75);
        c.camera.near = r / 2000;
        c.camera.far = r * 50;
        c.camera.updateProjectionMatrix();
        c.controls.target.set(0, 0, 0);
        c.controls.update();
        c.anchored = true;
      }
      c.world.updateMatrixWorld(true);         // mesh con tắt matrixAutoUpdate nên phải cập nhật tường minh
      model.warmBvh();
    }
    for (const l of layers) {
      const st = c.layers.get(l.key);
      if (st && st.holder.visible !== l.visible) {
        st.holder.visible = l.visible;
        if (!l.visible && c.active === st) selectIn(null, null);
        changed = true;
      }
    }
    if (changed) { reportHidden(); c.invalidate(); }
  }, [layers, edges]);

  // --- tô sáng cả model của file được chọn tên
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    for (const l of c.layers.values()) l.model.setHighlight(l.key === highlightKey);
    c.invalidate();
  }, [highlightKey, layers]);

  // --- cạnh
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    for (const l of c.layers.values()) l.model.setEdgesVisible(edges);
    c.invalidate();
  }, [edges]);

  return <div ref={mountRef} className="viewer" />;
});

export default Viewer;
