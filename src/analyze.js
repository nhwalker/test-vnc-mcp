/**
 * The analysis itself — regions plus text — over any RGBA image, and the
 * decoding needed to run it over an image a client hands us.
 *
 * `describe()` in session.js runs this over the live framebuffer;
 * `vnc_describe_image` runs it over a PNG or JPEG the client already has, such
 * as a screenshot it took earlier, so the two return the same shape and the
 * same numbers for the same pixels.
 */

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { findSurfaces } from './regions.js';
import { readSurfaces } from './ocr.js';

/** A region's text is abridged past this many characters; the lines are still all in `text`. */
const REGION_TEXT_LIMIT = 300;

/** Refuse images beyond this many pixels: decoding one is 4 bytes a pixel, and OCR far more. */
const MAX_PIXELS = 64 * 1024 * 1024;

/**
 * Regions and text for an RGBA image.
 *
 * @param {import('./ocr.js').Ocr} ocr
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ regions?: boolean, text?: boolean, words?: boolean }} [options]
 * @returns {Promise<{ regions: object[], text: import('./ocr.js').TextLine[], elapsedMs: number }>}
 */
export async function analyze(ocr, rgba, width, height, { regions = true, text = true, words = false } = {}) {
  const started = Date.now();
  const surfaces = regions ? findSurfaces(rgba, width, height) : [];
  const lines = text ? await readSurfaces(ocr, rgba, width, height, surfaces, { words }) : [];
  return {
    regions: surfaces.map((s) => describeRegion(s, lines, text)),
    text: lines,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Analyse an image the client supplies.
 *
 * @param {import('./ocr.js').Ocr} ocr
 * @param {object} args
 * @param {string} args.image base64 PNG or JPEG, with or without a `data:` URL prefix
 * @param {string} [args.mimeType] `image/png` or `image/jpeg`; sniffed from the bytes when absent
 * @param {{x:number,y:number,width:number,height:number}} [args.bbox] analyse only this part
 *   (results are still in whole-image coordinates)
 * @param {number} [args.scale] multiply every returned coordinate by this — the factor a
 *   shrunk screenshot reported — so results come back in desktop pixels
 * @param {boolean} [args.regions]
 * @param {boolean} [args.text]
 * @param {boolean} [args.words]
 */
export async function analyzeImage(ocr, { image, mimeType, bbox, scale = 1, regions, text, words }) {
  const decoded = decodeImage(imageBytes(image), mimeType);
  const { width, height } = decoded;
  const info = { width, height, mimeType: decoded.mimeType };

  let target = decoded;
  let offset = { x: 0, y: 0 };
  if (bbox) {
    const clipped = clip(bbox, width, height);
    if (!clipped) {
      throw new Error(`bbox ${JSON.stringify(bbox)} lies outside the ${width}x${height} image`);
    }
    info.bbox = clipped;
    target = crop(decoded, clipped);
    offset = { x: clipped.x, y: clipped.y };
  }
  if (scale !== 1) info.scale = scale;

  const result = await analyze(ocr, target.rgba, target.width, target.height, { regions, text, words });
  const map = (x, y, w, h) => [
    Math.round((offset.x + x) * scale),
    Math.round((offset.y + y) * scale),
    Math.round(w * scale),
    Math.round(h * scale),
  ];
  const mapRect = (r) => {
    const [x, y, w, h] = map(r.x, r.y, r.width, r.height);
    return { x, y, width: w, height: h };
  };
  for (const region of result.regions) region.bbox = map(...region.bbox);
  for (const line of result.text) {
    line.bbox = mapRect(line.bbox);
    if (line.words) for (const word of line.words) word.bbox = mapRect(word.bbox);
  }
  return { image: info, ...result };
}

/** The raw bytes from a base64 string, `data:` URL or not. */
function imageBytes(image) {
  if (typeof image !== 'string' || image.length === 0) throw new Error('image must be a base64 string');
  const comma = image.startsWith('data:') ? image.indexOf(',') : -1;
  const payload = comma >= 0 ? image.slice(comma + 1) : image;
  const bytes = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw new Error('image is not valid base64');
  return bytes;
}

/**
 * Decode PNG or JPEG bytes to RGBA. The type is read from the bytes; a
 * `mimeType` that disagrees is an error rather than a guess.
 *
 * @returns {{ rgba: Uint8Array, width: number, height: number, mimeType: string }}
 */
export function decodeImage(bytes, mimeType) {
  const sniffed = sniff(bytes);
  if (!sniffed) {
    throw new Error('image is neither PNG nor JPEG (checked the first bytes); those are the two formats supported');
  }
  if (mimeType && mimeType !== sniffed) {
    throw new Error(`image was declared ${mimeType} but its bytes are ${sniffed}`);
  }
  let decoded;
  if (sniffed === 'image/png') {
    const png = PNG.sync.read(bytes);
    decoded = { rgba: png.data, width: png.width, height: png.height };
  } else {
    const jpg = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    decoded = { rgba: jpg.data, width: jpg.width, height: jpg.height };
  }
  if (decoded.width * decoded.height > MAX_PIXELS) {
    throw new Error(`image is ${decoded.width}x${decoded.height}; the limit is ${MAX_PIXELS} pixels`);
  }
  return { ...decoded, mimeType: sniffed };
}

function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Intersect a rectangle with the image; null if nothing is left. */
function clip({ x, y, width, height }, imageWidth, imageHeight) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(imageWidth, Math.ceil(x + width));
  const y1 = Math.min(imageHeight, Math.ceil(y + height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function crop({ rgba, width }, rect) {
  const out = Buffer.alloc(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const from = ((rect.y + row) * width + rect.x) * 4;
    out.set(rgba.subarray(from, from + rect.width * 4), row * rect.width * 4);
  }
  return { rgba: out, width: rect.width, height: rect.height };
}

/** One region of the description: the surface plus the text read from it. */
export function describeRegion(surface, lines, withText) {
  const out = {
    id: surface.id,
    bbox: [surface.x, surface.y, surface.width, surface.height],
    color: surface.color,
    parent: surface.parent,
    depth: surface.depth,
  };
  if (surface.hint) out.hint = surface.hint;
  if (!withText) return out;

  const own = lines.filter((l) => l.region === surface.id);
  out.textLines = own.length;
  if (own.length > 0) {
    const joined = own.map((l) => l.text).join('\n');
    out.text = joined.length > REGION_TEXT_LIMIT ? `${joined.slice(0, REGION_TEXT_LIMIT)}…` : joined;
  }
  // The one role text makes safe to guess: a small nested surface with a single
  // line of text centred on it is very probably a button, tab or menu item. A
  // title bar has one line too, but left-aligned, which is what the centring
  // test is for.
  if (!out.hint && surface.parent !== null && own.length === 1 && surface.height <= 48 && surface.width <= 320) {
    const { bbox } = own[0];
    const offCentre = Math.abs(bbox.x + bbox.width / 2 - (surface.x + surface.width / 2));
    if (offCentre <= surface.width * 0.15) out.hint = 'button-like';
  }
  return out;
}
