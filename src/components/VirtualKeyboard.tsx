// Visual on-screen QWERTY keyboard. Click keys to add/remove them from a
// region (or whatever the parent decides). Highlights:
//   - highlightedKeys: primary highlight (the active region's keys, accent color)
//   - otherUsedKeys:   keys claimed by other regions (subdued, dashed border)
//   - pressedKeys:     keys currently physically held on the user's keyboard

interface KeyDef {
  /** Display label. */
  label: string;
  /** Normalized key identity (matches KeyboardSource's normalizeKey output). */
  key: string;
  /** CSS modifier class — "wide", "space", etc. */
  cls?: string;
}

interface RowDef {
  keys: KeyDef[];
  rowClass?: string;
}

const ROWS: RowDef[] = [
  {
    keys: [
      { label: "`", key: "`" },
      { label: "1", key: "1" },
      { label: "2", key: "2" },
      { label: "3", key: "3" },
      { label: "4", key: "4" },
      { label: "5", key: "5" },
      { label: "6", key: "6" },
      { label: "7", key: "7" },
      { label: "8", key: "8" },
      { label: "9", key: "9" },
      { label: "0", key: "0" },
      { label: "-", key: "-" },
      { label: "=", key: "=" },
    ],
  },
  {
    keys: [
      { label: "Q", key: "q" },
      { label: "W", key: "w" },
      { label: "E", key: "e" },
      { label: "R", key: "r" },
      { label: "T", key: "t" },
      { label: "Y", key: "y" },
      { label: "U", key: "u" },
      { label: "I", key: "i" },
      { label: "O", key: "o" },
      { label: "P", key: "p" },
      { label: "[", key: "[" },
      { label: "]", key: "]" },
    ],
  },
  {
    keys: [
      { label: "A", key: "a" },
      { label: "S", key: "s" },
      { label: "D", key: "d" },
      { label: "F", key: "f" },
      { label: "G", key: "g" },
      { label: "H", key: "h" },
      { label: "J", key: "j" },
      { label: "K", key: "k" },
      { label: "L", key: "l" },
      { label: ";", key: ";" },
      { label: "'", key: "'" },
    ],
    rowClass: "indent-1",
  },
  {
    keys: [
      { label: "Z", key: "z" },
      { label: "X", key: "x" },
      { label: "C", key: "c" },
      { label: "V", key: "v" },
      { label: "B", key: "b" },
      { label: "N", key: "n" },
      { label: "M", key: "m" },
      { label: ",", key: "," },
      { label: ".", key: "." },
      { label: "/", key: "/" },
    ],
    rowClass: "indent-2",
  },
  {
    keys: [{ label: "Space", key: "Space", cls: "space" }],
    rowClass: "center",
  },
];

interface VirtualKeyboardProps {
  /** Keys currently in the active selection (e.g. the region being edited). */
  highlightedKeys?: Set<string>;
  /** Keys claimed by other regions (subdued highlight). */
  otherUsedKeys?: Set<string>;
  /** Keys currently held on the physical keyboard, for live feedback. */
  pressedKeys?: Set<string>;
  onKeyClick?: (key: string) => void;
  disabled?: boolean;
}

export function VirtualKeyboard({
  highlightedKeys = new Set(),
  otherUsedKeys = new Set(),
  pressedKeys = new Set(),
  onKeyClick,
  disabled = false,
}: VirtualKeyboardProps) {
  return (
    <div className="virtual-keyboard">
      {ROWS.map((row, i) => (
        <div
          key={i}
          className={`virtual-keyboard-row ${row.rowClass ?? ""}`.trim()}
        >
          {row.keys.map((k) => {
            const classes = [
              "virtual-key",
              k.cls,
              highlightedKeys.has(k.key) && "highlighted",
              !highlightedKeys.has(k.key) &&
                otherUsedKeys.has(k.key) &&
                "other-used",
              pressedKeys.has(k.key) && "pressed",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={k.key}
                className={classes}
                disabled={disabled}
                type="button"
                onClick={() => onKeyClick?.(k.key)}
                title={k.key}
              >
                {k.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
