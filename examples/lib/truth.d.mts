export interface Calibration { kx: number; ky: number; e: number; f: number; array: number[] }
export const PAINTED: { x: number; y: number; w: number; h: number };
export const BACKGROUND: number[];
export function calibration(offset?: { dLng?: number; dLat?: number }): Calibration;
export function sourceOf(lng: number, lat: number, cal: Calibration): [number, number];
export function lngLatOf(x: number, y: number, cal: Calibration): [number, number];
export function insideBy(x: number, y: number): number;
export function strokeDistance(x: number, y: number): number;
export function ramp(x: number): number;
export function expectedAt(x: number, y: number, margin?: number): number[] | undefined;
export function near(got: number[], want: number[], slack?: number): boolean;
