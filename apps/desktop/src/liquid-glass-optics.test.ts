import { describe, expect, it } from 'vitest';
import {
  createDisplacementPixels,
  createGlassLens,
  displacementMapSize,
  glassRayOffset,
  supportsGlassRefraction,
  glassOpticalResponse,
  glassChannelMasks,
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
      expect(map.width * map.height).toBeLessThanOrEqual(98_304);
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

describe('chromatic lens response', () => {
  it('changes edge sampling per channel with subtle bounded separation', () => {
    const lens = createGlassLens(300, 180, 28);
    const shift = glassRayOffset(lens, 0.1, 90).x;
    const response = glassOpticalResponse(96, { pressure: 1, stretchX: 1.13 });
    expect(response.red).toBeGreaterThan(response.green);
    expect(response.blue).toBeLessThan(response.green);
    expect(((shift * (response.red - response.blue)) / 96) * 1.13).toBeLessThan(0.7);
    expect(glassOpticalResponse(96).green).toBe(96);
    expect(glassOpticalResponse(96, { pressure: 1 }).green).toBeCloseTo(109.44);
  });

  it('keeps the flat map exactly neutral under pressure and directional stretch', () => {
    for (const pressure of [0, 0.5, 1]) {
      const response = glassOpticalResponse(96, { pressure, stretchX: 1.13, stretchY: 0.9 });
      for (const axis of [response.x, response.y]) {
        expect((128 / 255) * axis.slope + axis.intercept).toBeCloseTo(0.5, 14);
      }
    }
    expect(glassOpticalResponse(96, { pressure: NaN, stretchX: Infinity, stretchY: -10 })).toEqual(
      glassOpticalResponse(96, { pressure: 0, stretchX: 1, stretchY: 0.9 }),
    );
    expect(glassOpticalResponse(96, { pressure: 50 }).green).toBeCloseTo(109.44);
  });

  it('recombines identical flat-center samples without a tint or inflated alpha', () => {
    const applyMask = (mask: string, rgba: number[]) => {
      const values = mask.trim().split(/\s+/).map(Number);
      return Array.from({ length: 4 }, (_, row) =>
        rgba.reduce(
          (sum, value, column) => sum + value * values[row * 5 + column]!,
          values[row * 5 + 4]!,
        ),
      );
    };
    for (const alpha of [0, 0.15, 0.6, 1]) {
      for (const color of [
        [0.2, 0.7, 0.9],
        [1, 1, 1],
        [0, 0, 0],
      ]) {
        const samples = Object.values(glassChannelMasks).map((mask) =>
          applyMask(mask, [...color, alpha]),
        );
        const combined = color.map((_, channel) =>
          samples.reduce((sum, sample) => sum + sample[channel]!, 0),
        );
        // Arithmetic RGB addition uses opaque intermediate alpha; final
        // composite(in) applies the green sample's alpha only once.
        expect(combined.map((value) => value * alpha)).toEqual(color.map((value) => value * alpha));
        expect(samples.every((sample) => sample[3] === 1)).toBe(true);
      }
    }
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
