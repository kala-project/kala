import { pathToFileURL } from 'node:url';

export const text = 'Ab9-中é文😀|'.repeat(51) + '界Z';
const file = (path, contains) => ({ kind: 'assert-file', path: `cu-win-native.${path}`, contains });
const exact = (path, value) => ({ kind: 'assert-file', path: `cu-win-native.${path}`, base64: Buffer.from(value).toString('base64') });
export const actions = [
  file('ready', ['ready session=', 'pointerX=250 pointerY=430', 'units=UTF-16']),
  { type: 'click', x: 100, y: 140, button: 'left' },
  { type: 'key', key: 'Ctrl+A' },
  { type: 'type', text },
  exact('text', text),
  { type: 'key', key: 'Enter' },
  exact('enter', 'Enter'),
  { type: 'key', key: 'Escape' },
  exact('escape', 'Escape'),
  { type: 'move', x: 250, y: 430 },
  { type: 'move', x: 250, y: 430 },
  { type: 'click', x: 250, y: 430, button: 'left', clickCount: 2 },
  { type: 'click', x: 250, y: 430, button: 'right' },
  { type: 'click', x: 250, y: 430, button: 'middle' },
  { type: 'button', x: 260, y: 440, button: 'left', down: true },
  file('state', ['buttons=Left']),
  { type: 'button', x: 260, y: 440, button: 'left', down: false },
  file('state', ['buttons=None modifiers=None']),
  { type: 'scroll', x: 250, y: 430, deltaX: 0, deltaY: 120 },
  { type: 'scroll', x: 250, y: 430, deltaX: 0, deltaY: -120 },
  { type: 'scroll', x: 250, y: 430, deltaX: 120, deltaY: 0 },
  { type: 'scroll', x: 250, y: 430, deltaX: -120, deltaY: 0 },
  { type: 'drag', fromX: 250, fromY: 430, toX: 550, toY: 500 },
  { type: 'drag', fromX: 550, fromY: 500, toX: 550, toY: 500 },
  { type: 'key', key: 'Ctrl+Shift+A' },
  { type: 'key', key: 'b' },
  file('events', ['mouse-double Left', 'mouse-down Right', 'mouse-up Right', 'mouse-down Middle', 'mouse-up Middle', 'wheel vertical delta=120', 'wheel vertical delta=-120', 'wheel horizontal delta=120', 'wheel horizontal delta=-120', 'mouse-move buttons=Left', 'key-down A', 'key-up ControlKey', 'key-up ShiftKey', 'key-down B']),
  file('state', ['buttons=None modifiers=None']),
  { type: 'button', x: 260, y: 440, button: 'left', down: true },
  file('state', ['buttons=Left']),
];

// Redirect this public, synthetic fixture JSON to a private evidence directory for verify-computer-use.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(actions, null, 2)}\n`);
}
