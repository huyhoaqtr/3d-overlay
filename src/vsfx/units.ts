/* Đơn vị: bản ghi [u32 số ký tự] tên (UTF-16) 02 00 00 00 viết-tắt, vd "Millimeters"/"mm", "Feet"/"ft". */
const UNITS: Record<string, number> = { Millimeters: 1, Centimeters: 10, Meters: 1000, Feet: 304.8, Inches: 25.4 };
const LABELS: Record<number, string> = { 1: 'mm', 10: 'cm', 1000: 'm', 304.8: 'feet', 25.4: 'inch' };

/** Số mm của 1 đơn vị file, hoặc null nếu file không có bản ghi đơn vị. */
export function detectUnitMM(raw: Uint8Array): number | null {
  for (const [name, mm] of Object.entries(UNITS)) {
    const n = name.length;
    outer: for (let q = 4; q + n * 2 + 4 <= raw.length; q++) {
      if (raw[q] !== name.charCodeAt(0) || raw[q + 1]) continue;
      for (let k = 1; k < n; k++) if (raw[q + k * 2] !== name.charCodeAt(k) || raw[q + k * 2 + 1]) continue outer;
      const e = q + n * 2;
      if (raw[q - 4] === n && !raw[q - 3] && !raw[q - 2] && !raw[q - 1] &&
          raw[e] === 2 && !raw[e + 1] && !raw[e + 2] && !raw[e + 3]) return mm;
    }
  }
  return null;
}

export function unitLabel(mm: number): string {
  return LABELS[mm] ?? `${mm} mm`;
}
