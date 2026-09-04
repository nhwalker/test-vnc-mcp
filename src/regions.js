/**
 * Regions of a screenshot, found from the pixels alone.
 *
 * A desktop is mostly flat colour: window bodies, title bars, panels, buttons,
 * text fields. Each of those is a connected run of near-identical pixels — a
 * "surface" — and its bounding box is exactly the region a person would point
 * at. So: flood-fill the framebuffer into components of one colour, keep the
 * ones that are big enough and solid enough to be a surface rather than a
 * stroke of text, and nest them by containment. No models, no dependencies,
 * and the same pixels always give the same boxes.
 *
 * What it will not find: anything without a flat background — photos,
 * gradients, wallpaper. Those come back as no region at all, which is the
 * honest answer; OCR still runs over them.
 */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * @typedef {object} Surface
 * @property {number} id 1-based, in reading order (top to bottom, left to right)
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {string} color dominant colour, as #rrggbb
 * @property {number} fill fraction of the bounding box the surface's own pixels cover, 0-1
 * @property {number|null} parent id of the smallest surface that contains this one
 * @property {number} depth 0 for a top-level surface
 * @property {string} [hint] a geometric guess at the role, when one is safe to make
 */

export const DEFAULT_OPTIONS = {
  /** Sum of |dR|+|dG|+|dB| to still count as the same colour. Anti-aliased text edges are far above this. */
  tolerance: 12,
  /** Smaller components are strokes, icons or the pointer, not surfaces. */
  minWidth: 24,
  minHeight: 12,
  /** A surface must cover at least this fraction of its bounding box; text and borders are far below. */
  minFill: 0.5,
};

/**
 * Find the flat-colour surfaces in an RGBA image.
 *
 * @param {Uint8Array|Buffer} rgba `width * height * 4` bytes
 * @param {number} width
 * @param {number} height
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 * @returns {Surface[]} sorted by id
 */
export function findSurfaces(rgba, width, height, options = {}) {
  const { tolerance, minWidth, minHeight, minFill } = { ...DEFAULT_OPTIONS, ...options };
  const total = width * height;
  if (total === 0) return [];

  // Flood fill with an explicit stack: a recursive fill overflows on any real screen.
  const label = new Int32Array(total).fill(-1);
  const stack = new Int32Array(total);
  const found = [];

  for (let seed = 0; seed < total; seed++) {
    if (label[seed] !== -1) continue;
    const r = rgba[seed * 4];
    const g = rgba[seed * 4 + 1];
    const b = rgba[seed * 4 + 2];
    const id = found.length;
    let sp = 0;
    stack[sp++] = seed;
    label[seed] = id;
    let count = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      // Four neighbours; compare with the seed colour, not the neighbour's, so
      // a gentle gradient cannot be walked across one step at a time.
      if (x > 0) visit(p - 1);
      if (x < width - 1) visit(p + 1);
      if (y > 0) visit(p - width);
      if (y < height - 1) visit(p + width);
    }

    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw < minWidth || bh < minHeight) continue;
    const fill = count / (bw * bh);
    if (fill < minFill) continue;
    found.push({ x: x0, y: y0, width: bw, height: bh, color: hex(r, g, b), fill: round(fill) });

    // eslint-disable-next-line no-inner-declarations
    function visit(q) {
      if (label[q] !== -1) return;
      const i = q * 4;
      if (Math.abs(rgba[i] - r) + Math.abs(rgba[i + 1] - g) + Math.abs(rgba[i + 2] - b) <= tolerance) {
        label[q] = id;
        stack[sp++] = q;
      }
    }
  }

  return nest(found, width);
}

/**
 * Give each surface its smallest containing surface as parent, then number
 * them in reading order.
 */
function nest(surfaces, screenWidth) {
  const byArea = [...surfaces].sort((a, b) => a.width * a.height - b.width * b.height);
  for (const s of byArea) {
    s._parent = null;
    for (const candidate of byArea) {
      if (candidate === s || candidate.width * candidate.height <= s.width * s.height) continue;
      if (contains(candidate, s)) {
        s._parent = candidate; // byArea is ascending, so the first hit is the smallest
        break;
      }
    }
  }

  const ordered = [...surfaces].sort((a, b) => a.y - b.y || a.x - b.x);
  ordered.forEach((s, index) => {
    s.id = index + 1;
  });
  return ordered.map((s) => {
    let depth = 0;
    for (let p = s._parent; p; p = p._parent) depth++;
    const out = {
      id: s.id,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      color: s.color,
      fill: s.fill,
      parent: s._parent ? s._parent.id : null,
      depth,
    };
    const hint = geometricHint(s, screenWidth);
    if (hint) out.hint = hint;
    return out;
  });
}

/** The one role that geometry alone makes obvious: a bar spanning the screen. */
function geometricHint(s, screenWidth) {
  if (s.width >= screenWidth * 0.9 && s.height <= 64 && s.height < s.width / 8) return 'bar';
  return undefined;
}

/** Does `outer` contain `inner` (inclusive)? */
export function contains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function hex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function round(v) {
  return Math.round(v * 100) / 100;
}
