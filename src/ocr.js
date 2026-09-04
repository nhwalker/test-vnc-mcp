/**
 * Text on the screen, with its position, via Tesseract.
 *
 * tesseract.js runs the Tesseract engine as WebAssembly in a worker thread:
 * pure JavaScript as far as `npm install` is concerned, so no toolchain
 * (DECISIONS.md #5 still holds). It is not small, and it is not instant —
 * roughly half a second to a second per window on a laptop CPU — so the
 * worker starts on first use and the results are cached upstream per
 * framebuffer update.
 *
 * Two things learned the hard way, both handled here:
 *
 * - OCR must run per region, not per screen. Two windows side by side share
 *   rows of pixels, and Tesseract will happily read across the gap and return
 *   "notes.txt Save changes?" as one line. So each surface is cropped out,
 *   with the surfaces inside it painted over, and read alone.
 * - Desktop text is small. Tesseract is trained on scanned pages, and at 14px
 *   it misreads `ls` as `1s`; doubled with nearest-neighbour it does not.
 *
 * Language data ships as an npm dependency (`@tesseract.js-data/eng`) rather
 * than being fetched at first run, so nothing touches the network and nothing
 * is written to the working directory — which, for an MCP server, is wherever
 * the client happened to start it.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);

/** The English data that ships with the package: the LSTM-only, integer-quantised variant. */
export const DEFAULT_LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int');

/** Lines below this confidence are noise (a border read as "|", a scrollbar as "l"). */
const MIN_CONFIDENCE = 30;

/** Crops with more pixels than this are read at 1x: doubling a full screen costs more than it helps. */
const MAX_UPSCALED_PIXELS = 500_000;

/** Loading the engine and language data should take well under a second; this is a hang. */
const START_TIMEOUT_MS = 60_000;

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * @typedef {object} TextLine
 * @property {string} text
 * @property {number} confidence 0-100
 * @property {Rect} bbox in full-image pixels
 * @property {number|null} region id of the surface it was read from, null for the bare screen
 * @property {Array<{text: string, confidence: number, bbox: Rect}>} [words]
 */

export class Ocr {
  /**
   * @param {object} [options]
   * @param {string} [options.langs] Tesseract language codes, `+`-separated (default `eng`)
   * @param {string} [options.langPath] directory holding `<lang>.traineddata.gz` for each of them
   */
  constructor({ langs = 'eng', langPath = DEFAULT_LANG_PATH } = {}) {
    this.langs = langs;
    this.langPath = langPath;
    this._worker = null;
    this._starting = null;
    this._parameters = {};
  }

  /** The worker, started on first use. Concurrent first calls share the one start. */
  async _get() {
    if (this._worker) return this._worker;
    if (!this._starting) {
      // tesseract.js does not reliably reject when a language file is missing
      // (the worker can sit there forever), so check ourselves first, and put a
      // ceiling on the start regardless.
      for (const lang of this.langs.split('+')) {
        const file = path.join(this.langPath, `${lang}.traineddata.gz`);
        if (!fs.existsSync(file)) {
          throw new Error(
            `no OCR data for language "${lang}": ${file} does not exist. Each language needs ` +
              '<lang>.traineddata.gz in one directory; the npm packages @tesseract.js-data/<lang> provide them. ' +
              'Set VNC_OCR_LANGS and VNC_OCR_LANG_PATH to change what is loaded.',
          );
        }
      }
      const start = createWorker(this.langs, OEM.LSTM_ONLY, {
        langPath: this.langPath,
        gzip: true,
        cacheMethod: 'none', // read the data from langPath every start; never write it anywhere
        logger: () => {},
      });
      this._starting = withTimeout(start, START_TIMEOUT_MS, 'starting the OCR worker')
        .then((worker) => {
          this._worker = worker;
          return worker;
        })
        .catch(async (err) => {
          this._starting = null;
          // If the worker did come up late, do not leak the thread.
          start.then((worker) => worker.terminate()).catch(() => {});
          throw new Error(`could not start OCR for language(s) "${this.langs}": ${err?.message ?? err}`, { cause: err });
        });
    }
    return this._starting;
  }

  /** Set Tesseract parameters, skipping the round trip when nothing changed. */
  async _setParameters(worker, params) {
    const changed = {};
    for (const [key, value] of Object.entries(params)) {
      if (this._parameters[key] !== value) changed[key] = value;
    }
    if (Object.keys(changed).length === 0) return;
    await worker.setParameters(changed);
    Object.assign(this._parameters, changed);
  }

  /**
   * Read the text inside one rectangle of an RGBA image.
   *
   * @param {Uint8Array} rgba
   * @param {number} width image width
   * @param {number} height image height
   * @param {Rect} rect the part to read
   * @param {object} [options]
   * @param {Rect[]} [options.mask] areas inside `rect` to paint over first (nested surfaces)
   * @param {[number, number, number]} [options.maskColor] what to paint them with
   * @param {number} [options.upscale] integer factor (default 2 for small crops, 1 for large)
   * @param {boolean} [options.singleLine] tell Tesseract to expect exactly one line (buttons, titles)
   * @param {boolean} [options.words] include word boxes as well as lines
   * @param {number|null} [options.region] tag for the returned lines
   * @returns {Promise<TextLine[]>}
   */
  async recognize(rgba, width, height, rect, options = {}) {
    const {
      mask = [],
      maskColor = [128, 128, 128],
      singleLine = false,
      words = false,
      region = null,
    } = options;
    const upscale = options.upscale ?? (rect.width * rect.height <= MAX_UPSCALED_PIXELS ? 2 : 1);
    if (rect.width < 4 || rect.height < 4) return [];

    const image = cropToPng(rgba, width, rect, { mask, maskColor, upscale });
    const worker = await this._get();
    await this._setParameters(worker, {
      tessedit_pageseg_mode: singleLine ? PSM.SINGLE_LINE : PSM.AUTO,
      // Tesseract otherwise guesses the resolution from the text and warns; a screen at 1x is ~96 dpi.
      user_defined_dpi: String(96 * upscale),
    });
    const { data } = await worker.recognize(image, {}, { blocks: true, text: false });

    const toRect = (b) => ({
      x: rect.x + Math.round(b.x0 / upscale),
      y: rect.y + Math.round(b.y0 / upscale),
      width: Math.round((b.x1 - b.x0) / upscale),
      height: Math.round((b.y1 - b.y0) / upscale),
    });

    const lines = [];
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          const text = line.text.trim();
          if (!/[\p{L}\p{N}]/u.test(text)) continue; // borders and scrollbars read as "|", "l", "—"
          if (line.confidence < MIN_CONFIDENCE) continue;
          const out = { text, confidence: Math.round(line.confidence), bbox: toRect(line.bbox), region };
          if (words) {
            out.words = line.words
              .filter((w) => w.text.trim())
              .map((w) => ({ text: w.text.trim(), confidence: Math.round(w.confidence), bbox: toRect(w.bbox) }));
          }
          lines.push(out);
        }
      }
    }
    return lines;
  }

  /** Stop the worker thread. Safe to call twice, or before any recognize. */
  async terminate() {
    const starting = this._starting;
    this._starting = null;
    this._worker = null;
    this._parameters = {};
    const worker = await starting?.catch(() => null);
    if (worker) await worker.terminate();
  }
}

/**
 * Read every surface of a screen, each on its own, plus whatever text lies on
 * no surface at all. Returns lines in reading order, tagged with the surface
 * they came from.
 *
 * @param {Ocr} ocr
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {import('./regions.js').Surface[]} surfaces
 * @param {{ words?: boolean }} [options]
 * @returns {Promise<TextLine[]>}
 */
export async function readSurfaces(ocr, rgba, width, height, surfaces, { words = false } = {}) {
  const childrenOf = new Map(surfaces.map((s) => [s.id, []]));
  const roots = [];
  for (const s of surfaces) (s.parent === null ? roots : childrenOf.get(s.parent)).push(s);

  const jobs = [];
  // The bare screen: whatever is not on any surface (wallpaper text, a photo).
  // Skipped when one surface already covers the whole screen.
  const wholeScreen = surfaces.some((s) => s.x === 0 && s.y === 0 && s.width === width && s.height === height);
  if (!wholeScreen) {
    jobs.push({ rect: { x: 0, y: 0, width, height }, mask: roots, maskColor: [128, 128, 128], region: null, singleLine: false });
  }
  for (const s of surfaces) {
    // Step one pixel in: the surface's own border, if any, is just outside its pixels.
    const inset = s.parent === null ? 0 : 1;
    jobs.push({
      rect: { x: s.x + inset, y: s.y + inset, width: s.width - 2 * inset, height: s.height - 2 * inset },
      mask: childrenOf.get(s.id),
      maskColor: hexToRgb(s.color),
      region: s.id,
      // Buttons, tabs, title bars: one line, and telling Tesseract so stops it inventing paragraphs.
      singleLine: s.parent !== null && s.height <= 40 && s.width <= 320,
    });
  }

  const lines = [];
  for (const job of jobs) {
    lines.push(...(await ocr.recognize(rgba, width, height, job.rect, { ...job, words })));
  }
  return lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}

/**
 * Cut `rect` out of an RGBA image as a PNG, scaled up by an integer factor with
 * nearest-neighbour (crisp edges are what Tesseract wants; smoothing would
 * only blur the text), with the `mask` rectangles painted flat first.
 */
function cropToPng(rgba, imageWidth, rect, { mask, maskColor, upscale }) {
  const f = upscale;
  const png = new PNG({ width: rect.width * f, height: rect.height * f });
  const out = png.data;
  const [mr, mg, mb] = maskColor;
  for (let y = 0; y < rect.height; y++) {
    const sy = rect.y + y;
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      let src = (sy * imageWidth + sx) * 4;
      let r = rgba[src];
      let g = rgba[src + 1];
      let b = rgba[src + 2];
      for (const m of mask) {
        if (sx >= m.x && sx < m.x + m.width && sy >= m.y && sy < m.y + m.height) {
          r = mr;
          g = mg;
          b = mb;
          break;
        }
      }
      for (let dy = 0; dy < f; dy++) {
        let dst = ((y * f + dy) * png.width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, dst += 4) {
          out[dst] = r;
          out[dst + 1] = g;
          out[dst + 2] = b;
          out[dst + 3] = 255;
        }
      }
    }
  }
  // Fastest settings: the bytes go straight to the worker, never to disk.
  return PNG.sync.write(png, { deflateLevel: 1, filterType: 0 });
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
