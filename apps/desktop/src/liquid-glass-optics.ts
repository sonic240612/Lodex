export interface GlassLens {
  width: number;
  height: number;
  radius: number;
  rim: number;
  thickness: number;
  indexOfRefraction: number;
}

const positive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

export function createGlassLens(width: number, height: number, radius: number): GlassLens {
  const w = Math.max(1, positive(width, 1));
  const h = Math.max(1, positive(height, 1));
  const shorter = Math.min(w, h);
  return {
    width: w,
    height: h,
    radius: Math.min(shorter / 2, Math.max(0, Number.isFinite(radius) ? radius : 0)),
    rim: Math.min(28, shorter * 0.3),
    thickness: Math.min(24, shorter * 0.24),
    indexOfRefraction: 1.48,
  };
}

/** Ray offset through a rounded glass rim. The flat center has no distortion.
 * The rounded-rectangle distance gives the outward normal; Snell's law bends
 * a vertical ray at the curved air/glass boundary toward that normal.
 */
export function glassRayOffset(lens: GlassLens, x: number, y: number) {
  const px = x - lens.width / 2;
  const py = y - lens.height / 2;
  const qx = Math.abs(px) - (lens.width / 2 - lens.radius);
  const qy = Math.abs(py) - (lens.height / 2 - lens.radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const cornerDistance = Math.hypot(ox, oy);
  const distance = cornerDistance + Math.min(Math.max(qx, qy), 0) - lens.radius;
  const depth = -distance;
  if (depth < 0 || depth >= lens.rim) return { x: 0, y: 0 };
  const normalX =
    cornerDistance > 0 ? (ox / cornerDistance) * Math.sign(px) : qx > qy ? Math.sign(px) : 0;
  const normalY =
    cornerDistance > 0 ? (oy / cornerDistance) * Math.sign(py) : qx > qy ? 0 : Math.sign(py);
  // A quarter-circle cross section joins the flat center with a horizontal
  // tangent. Clamp the extreme tangent at the outermost pixel for stability.
  const t = Math.max(0.025, Math.min(1, depth / lens.rim));
  const slope = (1 - t) / Math.sqrt(1 - (1 - t) ** 2);
  const incidence = Math.atan(slope);
  const transmitted = Math.asin(Math.sin(incidence) / lens.indexOfRefraction);
  const shift = lens.thickness * Math.tan(incidence - transmitted);
  // Backward image sampling: points along the rim sample toward the center.
  return { x: -normalX * shift, y: -normalY * shift };
}

export function displacementMapSize(width: number, height: number) {
  const w = positive(width, 1);
  const h = positive(height, 1);
  const ratio = Math.min(1, 768 / Math.max(w, h), Math.sqrt(180_000 / (w * h)));
  return { width: Math.max(1, Math.floor(w * ratio)), height: Math.max(1, Math.floor(h * ratio)) };
}

export function createDisplacementPixels(lens: GlassLens) {
  const size = displacementMapSize(lens.width, lens.height);
  // feComponentTransfer converts encoded channel 128 to precisely 0.5.
  // Offsets therefore remain neutral in the center, even with 8-bit pixels.
  const scale = lens.thickness * 4;
  const pixels = new Uint8ClampedArray(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const ray = glassRayOffset(
        lens,
        ((x + 0.5) / size.width) * lens.width,
        ((y + 0.5) / size.height) * lens.height,
      );
      const index = (y * size.width + x) * 4;
      pixels[index] = 128 + (ray.x / scale) * 256;
      pixels[index + 1] = 128 + (ray.y / scale) * 256;
      pixels[index + 2] = 128;
      pixels[index + 3] = 255;
    }
  }
  return { ...size, pixels, scale };
}

/** WebKit/Gecko parse the syntax but do not reliably render SVG backdrops. */
export function supportsGlassRefraction(userAgent: string, supportsSvgBackdrop: boolean) {
  return (
    supportsSvgBackdrop &&
    /(?:Chrome|Chromium|Edg)\//.test(userAgent) &&
    !/(?:iPhone|iPad|iPod)/.test(userAgent)
  );
}
