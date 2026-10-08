import { describe, expect, it } from 'vitest';
import {
  createDisplacementPixels,
  createGlassLens,
  displacementMapSize,
  glassRayOffset,
  supportsGlassRefraction,
} from './liquid-glass-optics';

describe('rounded glass lens', () => {
  const lens = createGlassLens(300, 180, 28);

  it('keeps the flat center and pixels outside rounded corners undistorted', () => {
    expect(glassRayOffset(lens, 150, 90)).toEqual({ x: 0, y: 0 });
    expect(glassRayOffset(lens, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(glassRayOffset(lens, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(glassRayOffset(lens, -5, 90)).toEqual({ x: 0, y: 0 });
  });

  it('bends actual sampling coordinates inward symmetrically at opposite rims', () => {
    const left = glassRayOffset(lens, 2, 90);
    const right = glassRayOffset(lens, 298, 90);
    const top = glassRayOffset(lens, 150, 2);
    const bottom = glassRayOffset(lens, 150, 178);
    expect(left.x).toBeGreaterThan(10);
    expect(left.x).toBeLessThan(24);
    expect(left.x).toBeCloseTo(-right.x);
    expect(top.y).toBeCloseTo(-bottom.y);
    expect(top.y).toBeCloseTo(left.x);
    expect(Math.abs(left.y)).toBe(0);
    expect(Math.abs(top.x)).toBe(0);
  });

  it('uses diagonal normals at rounded corners and smoothly becomes flat', () => {
    const corner = glassRayOffset(lens, 10, 10);
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.x).toBeCloseTo(corner.y);
    expect(glassRayOffset(lens, 5, 90).x).toBeGreaterThan(glassRayOffset(lens, 15, 90).x);
    expect(glassRayOffset(lens, lens.rim - 0.01, 90).x).toBeLessThan(0.01);
    expect(glassRayOffset(lens, lens.rim, 90)).toEqual({ x: 0, y: 0 });
  });

  it('has no optical shift without a refractive-index difference', () => {
    const air = { ...lens, indexOfRefraction: 1 };
    expect(glassRayOffset(air, 2, 90).x).toBeCloseTo(0);
  });

  it('encodes a neutral center plus directional, fully opaque displacement channels', () => {
    const map = createDisplacementPixels(lens);
    const center = ((map.height / 2) * map.width + map.width / 2) * 4;
    expect([...map.pixels.slice(center, center + 4)]).toEqual([128, 128, 128, 255]);
    const left = ((map.height / 2) * map.width + 2) * 4;
    const right = ((map.height / 2) * map.width + map.width - 3) * 4;
    expect(map.pixels[left]).toBeGreaterThan(128);
    expect(map.pixels[right]).toBeLessThan(128);
    // The transfer-function slope makes byte 128 exactly neutral in SVG.
    expect((map.pixels[center]! / 255) * (255 / 256)).toBe(0.5);
  });

  it('bounds map memory independently of window size and device pixel ratio', () => {
    for (const [width, height] of [
      [300, 180],
      [800, 4000],
      [7680, 4320],
      [1, 1],
    ]) {
      const map = displacementMapSize(width!, height!);
      expect(map.width * map.height).toBeLessThanOrEqual(180_000);
      expect(Math.max(map.width, map.height)).toBeLessThanOrEqual(768);
      expect(Math.min(map.width, map.height)).toBeGreaterThanOrEqual(1);
    }
  });

  it('sanitizes invalid geometry and clamps radii for tiny controls', () => {
    const small = createGlassLens(10, 6, 100);
    expect(small.radius).toBe(3);
    expect(small.rim).toBeLessThan(3);
    const invalid = createGlassLens(Number.NaN, -1, Number.POSITIVE_INFINITY);
    expect(invalid.width).toBe(1);
    expect(invalid.height).toBe(1);
    expect(invalid.radius).toBe(0);
  });
});

describe('SVG backdrop rendering support', () => {
  it('enables Chromium and WebView2 but falls back for engines that only parse the syntax', () => {
    expect(
      supportsGlassRefraction('Windows Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0', true),
    ).toBe(true);
    expect(supportsGlassRefraction('Linux Chromium/134.0.0.0', true)).toBe(true);
    expect(supportsGlassRefraction('Macintosh Version/18.3 Safari/605.1.15', true)).toBe(false);
    expect(supportsGlassRefraction('Firefox/136.0', true)).toBe(false);
    expect(supportsGlassRefraction('iPhone Chrome/134.0.0.0', true)).toBe(false);
    expect(supportsGlassRefraction('Chrome/134.0.0.0', false)).toBe(false);
  });
});
