/**
 * Turning human key names into X11 keysyms, using noVNC's tables.
 *
 * Keysyms are what RFB actually carries — there are no keycodes and no keyboard
 * layout on the wire — so "ctrl+c" or "Return" only has to become a number.
 */

import { XK, keysymdef } from './novnc.js';

/**
 * Short names people actually type, mapped to the X11 name noVNC knows.
 * Anything not listed falls through to a case-insensitive `XK_<name>` lookup,
 * which covers the long tail (F13, Menu, Kanji, ...) without enumerating it.
 */
const ALIASES = {
  ctrl: 'Control_L',
  control: 'Control_L',
  ctrl_r: 'Control_R',
  alt: 'Alt_L',
  alt_r: 'Alt_R',
  altgr: 'ISO_Level3_Shift',
  shift: 'Shift_L',
  shift_r: 'Shift_R',
  meta: 'Super_L',
  super: 'Super_L',
  win: 'Super_L',
  windows: 'Super_L',
  cmd: 'Super_L',
  command: 'Super_L',
  enter: 'Return',
  ret: 'Return',
  esc: 'Escape',
  backspace: 'BackSpace',
  bksp: 'BackSpace',
  del: 'Delete',
  ins: 'Insert',
  pgup: 'Prior',
  pageup: 'Prior',
  pgdn: 'Next',
  pagedown: 'Next',
  capslock: 'Caps_Lock',
  numlock: 'Num_Lock',
  scrolllock: 'Scroll_Lock',
  printscreen: 'Print',
  prtsc: 'Print',
  space: 'space',
  spacebar: 'space',
  tab: 'Tab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  menu: 'Menu',
  pause: 'Pause',
};

/** Lower-cased `XK_foo` names -> keysym, built once for forgiving lookups. */
const XK_BY_LOWER_NAME = new Map(
  Object.entries(XK).map(([name, keysym]) => [name.replace(/^XK_/, '').toLowerCase(), keysym]),
);

/**
 * Resolve one key name (no modifiers) to a keysym.
 *
 * A single character is looked up as a character, so "a" and "A" stay distinct;
 * anything longer is treated as a key name.
 *
 * @param {string} name
 * @returns {number}
 */
export function keysymForName(name) {
  if (!name) throw new Error('empty key name');

  const characters = [...name];
  if (characters.length === 1) return keysymdef.lookup(characters[0].codePointAt(0));

  const canonical = ALIASES[name.toLowerCase()] ?? name;
  const keysym = XK[`XK_${canonical}`] ?? XK_BY_LOWER_NAME.get(canonical.toLowerCase());
  if (keysym === undefined) {
    throw new Error(
      `unknown key "${name}". Use a single character, an X11 key name such as ` +
        '"Return", "F5" or "Escape", or a short alias such as "enter", "esc", "pgup".',
    );
  }
  return keysym;
}

/**
 * Split "ctrl+shift+t" into its parts. A "+" that follows a separator is taken
 * literally, so "ctrl++" is control plus the plus key.
 *
 * @param {string} combo
 * @returns {string[]}
 */
export function splitCombo(combo) {
  const parts = [];
  let current = '';
  for (const character of combo.trim()) {
    if (character === '+' && current !== '') {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current !== '') parts.push(current);
  if (parts.length === 0) throw new Error('empty key combination');
  return parts;
}

/**
 * Parse a combination into modifiers to hold and the key to press.
 *
 * @param {string} combo e.g. "ctrl+alt+Delete"
 * @returns {{ modifiers: number[], key: number }}
 */
export function parseCombo(combo) {
  const parts = splitCombo(combo);
  return {
    modifiers: parts.slice(0, -1).map(keysymForName),
    key: keysymForName(parts[parts.length - 1]),
  };
}

/**
 * The keysyms to send for a string of text, one per character.
 *
 * Sending the character's own keysym is what noVNC does for pasted text: the
 * server maps it to whatever key produces that character, so this works
 * regardless of the keyboard layout at either end.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function keysymsForText(text) {
  const keysyms = [];
  for (const character of text) {
    if (character === '\r') continue; // CRLF arrives as one Return
    if (character === '\n') keysyms.push(XK.XK_Return);
    else if (character === '\t') keysyms.push(XK.XK_Tab);
    else keysyms.push(keysymdef.lookup(character.codePointAt(0)));
  }
  return keysyms;
}
