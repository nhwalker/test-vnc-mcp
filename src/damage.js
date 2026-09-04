/**
 * Which parts of the screen changed, and when.
 *
 * Every FramebufferUpdate the server sends is a list of rectangles, so the
 * protocol already tells us exactly which pixels moved — there is nothing to
 * diff. This module keeps that geometry for the last several updates so that
 * "what changed since the agent last looked" can be answered from memory.
 */

/** Updates to remember. An agent that looks less often than this gets "everything". */
const HISTORY = 64;

/** More rectangles than this collapse into their bounding box: precision is not worth the tokens. */
const MAX_RECTS = 32;

/**
 * Union overlapping or touching rectangles until none overlap. Adjacent rects
 * merge too: a scroll arrives as hundreds of one-line CopyRects and the agent
 * wants to know "the terminal scrolled", not each line.
 *
 * @param {{x:number,y:number,width:number,height:number}[]} rects
 */
export function mergeRects(rects) {
  let out = rects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (touches(out[i], out[j])) {
          out[i] = union(out[i], out[j]);
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  if (out.length > MAX_RECTS) out = [out.reduce(union)];
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

function touches(a, b) {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export class DamageLog {
  constructor(history = HISTORY) {
    this._history = history;
    /** @type {{update:number, rects:object[]}[]} oldest first */
    this._entries = [];
    this._pending = [];
  }

  /** A rectangle of the update currently being received has been decoded. */
  add(x, y, width, height) {
    this._pending.push({ x, y, width, height });
  }

  /** The update in progress is complete; file it under its number. */
  commit(update) {
    this._entries.push({ update, rects: mergeRects(this._pending) });
    this._pending = [];
    if (this._entries.length > this._history) this._entries.shift();
  }

  /**
   * Everything that changed after update number `since`, merged.
   *
   * @returns {{ complete: boolean, rects: object[] }} `complete` is false when
   *   `since` is older than the history kept, in which case `rects` holds only
   *   what is known and the caller should assume the whole screen changed.
   */
  since(since) {
    const oldest = this._entries[0]?.update;
    const complete = oldest === undefined || since >= oldest - 1;
    const rects = [];
    for (const entry of this._entries) {
      if (entry.update > since) rects.push(...entry.rects);
    }
    return { complete, rects: mergeRects(rects) };
  }
}
