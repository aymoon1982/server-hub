// On-screen accessory key bar for terminals on touch devices.
// Mobile keyboards can't produce Esc / Tab / Ctrl / arrows / pipes — the keys
// you need constantly in a shell or coding agent. This surfaces them as a
// scrollable touch row. Rendered always, but only shown ≤768px (see App.css).
//
// `onKey(seq)` sends a raw byte sequence over the PTY websocket.
// `ctrlOn` / `onToggleCtrl` drive a sticky Ctrl modifier: when active, the next
// character typed on the real keyboard is converted to its control code by the
// parent's onData handler.

const PRIMARY = [
  { label: 'esc',  seq: '\x1b'    },
  { label: 'tab',  seq: '\t'      },
  { label: '↑',    seq: '\x1b[A'  },
  { label: '↓',    seq: '\x1b[B'  },
  { label: '←',    seq: '\x1b[D'  },
  { label: '→',    seq: '\x1b[C'  },
];

const SYMBOLS = [
  { label: '⌃C', seq: '\x03', wide: true },
  { label: '|',  seq: '|'  },
  { label: '~',  seq: '~'  },
  { label: '/',  seq: '/'  },
  { label: '-',  seq: '-'  },
  { label: '_',  seq: '_'  },
  { label: '$',  seq: '$'  },
  { label: '⌃D', seq: '\x04', wide: true },
  { label: '⌃L', seq: '\x0c', wide: true },
  { label: '⌃Z', seq: '\x1a', wide: true },
];

export function TerminalKeyBar({ onKey, ctrlOn, onToggleCtrl }) {
  // preventDefault on pointer-down keeps focus (and the on-screen keyboard)
  // on the terminal's hidden textarea instead of stealing it to the button.
  const hold = (e) => e.preventDefault();

  return (
    <div className="term-keybar" role="toolbar" aria-label="Terminal keys" onPointerDown={hold}>
      <button
        type="button"
        className={`tkb-key tkb-mod${ctrlOn ? ' is-on' : ''}`}
        onClick={onToggleCtrl}
        aria-pressed={ctrlOn}
      >ctrl</button>
      {PRIMARY.map(k => (
        <button key={k.label} type="button" className="tkb-key" onClick={() => onKey(k.seq)}>{k.label}</button>
      ))}
      <span className="tkb-sep" />
      {SYMBOLS.map(k => (
        <button
          key={k.label}
          type="button"
          className={`tkb-key${k.wide ? ' tkb-key--wide' : ''}`}
          onClick={() => onKey(k.seq)}
        >{k.label}</button>
      ))}
    </div>
  );
}
