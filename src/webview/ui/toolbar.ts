// The toolbar above the editor: formatting buttons on the left, mode switch on the right.
import { MODE_LABELS, MODES, type CommandId, type Mode } from '../../shared/protocol';

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  bold: svg('<path d="M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h4.7a2.5 2.5 0 0 1 0 5H4.5z" stroke-width="1.8"/>'),
  italic: svg('<path d="M7 3h5M4 13h5M9.5 3l-3 10"/>'),
  strike: svg('<path d="M2.5 8h11M11 5c-.3-1.3-1.4-2-3-2-1.800 0-3 .9-3 2.300 0 1 .6 1.700 1.700 2.200M5 11c.3 1.300 1.400 2 3 2 1.800 0 3-.9 3-2.300 0-.5-.1-.9-.4-1.200"/>'),
  code: svg('<path d="M5.5 4.500 2 8l3.500 3.500M10.500 4.500 14 8l-3.500 3.500"/>'),
  bullet: svg('<path d="M6 4h8M6 8h8M6 12h8"/><circle cx="2.500" cy="4" r=".7" fill="currentColor"/><circle cx="2.500" cy="8" r=".7" fill="currentColor"/><circle cx="2.500" cy="12" r=".7" fill="currentColor"/>'),
  ordered: svg('<path d="M6.500 4h7.500M6.500 8h7.500M6.500 12h7.500M2 3l1-.5V6M2 10.200c.2-.5 1.800-.6 1.800.3 0 .7-1.800 1.300-1.800 2.500h2" stroke-width="1.100"/>'),
  task: svg('<rect x="2" y="2.500" width="5" height="5" rx="1"/><path d="M3.300 5l1 1 1.600-2M9.500 5H14M2 12h12" />'),
  quote: svg('<path d="M3 3v10M6.500 5h7M6.500 8h7M6.500 11h4.500"/>'),
  codeBlock: svg('<rect x="1.500" y="2.500" width="13" height="11" rx="1.500"/><path d="M6 6 4 8l2 2M10 6l2 2-2 2"/>'),
  link: svg('<path d="M6.700 9.300a2.600 2.600 0 0 0 3.700 0l2.200-2.200a2.600 2.600 0 0 0-3.700-3.700l-.9.9M9.300 6.700a2.600 2.600 0 0 0-3.700 0L3.400 8.900a2.600 2.600 0 0 0 3.700 3.700l.9-.9"/>'),
  image: svg('<rect x="1.500" y="2.500" width="13" height="11" rx="1.500"/><circle cx="5.200" cy="6" r="1.100"/><path d="m2 12 3.500-3.500 2.500 2.500 2-2 4 3.500"/>'),
  table: svg('<rect x="1.500" y="2.500" width="13" height="11" rx="1.500"/><path d="M1.500 6.500h13M1.500 10h13M6 2.500v11M10.500 2.500v11"/>'),
  rule: svg('<path d="M2 8h12"/><path d="M4 4.500h8M4 11.500h8" opacity=".35"/>'),
};

interface ButtonSpec {
  id: CommandId;
  icon: keyof typeof ICONS;
  title: string;
  keys?: string;
  gap?: boolean;
}

const BUTTONS: ButtonSpec[] = [
  { id: 'bold', icon: 'bold', title: 'Bold', keys: 'Mod+B' },
  { id: 'italic', icon: 'italic', title: 'Italic', keys: 'Mod+I' },
  { id: 'strike', icon: 'strike', title: 'Strikethrough', keys: 'Alt+Shift+5' },
  { id: 'code', icon: 'code', title: 'Inline code', keys: 'Mod+E' },
  { id: 'bulletList', icon: 'bullet', title: 'Bullet list', keys: 'Mod+Shift+8', gap: true },
  { id: 'orderedList', icon: 'ordered', title: 'Numbered list', keys: 'Mod+Shift+7' },
  { id: 'taskList', icon: 'task', title: 'Task list' },
  { id: 'quote', icon: 'quote', title: 'Quote', keys: 'Mod+Shift+9' },
  { id: 'codeBlock', icon: 'codeBlock', title: 'Code block' },
  { id: 'link', icon: 'link', title: 'Link', keys: 'Mod+L', gap: true },
  { id: 'image', icon: 'image', title: 'Insert image' },
  { id: 'table', icon: 'table', title: 'Insert table' },
  { id: 'rule', icon: 'rule', title: 'Horizontal rule' },
];

const MODE_HINTS: Record<Mode, string> = {
  raw: 'Raw Markdown source',
  half: 'Half preview: rendered, with the syntax shown where the cursor is',
  full: 'Full preview: looks like the finished document and stays editable',
};

export interface Toolbar {
  dom: HTMLElement;
  setMode(mode: Mode): void;
  setHeading(level: number): void;
  setVisible(visible: boolean): void;
}

export function createToolbar(run: (id: CommandId, arg?: unknown) => void, isMac: boolean): Toolbar {
  const dom = document.createElement('div');
  dom.className = 'mdl-toolbar';
  dom.setAttribute('role', 'toolbar');
  dom.setAttribute('aria-label', 'Formatting');
  const mod = isMac ? '⌘' : 'Ctrl';
  const keys = (k: string) => k.replace('Mod', mod).replace('Alt', isMac ? '⌥' : 'Alt').replace('Shift', isMac ? '⇧' : 'Shift');

  const heading = document.createElement('select');
  heading.className = 'mdl-heading';
  heading.title = 'Paragraph style';
  heading.setAttribute('aria-label', 'Paragraph style');
  ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'].forEach((label, level) => {
    const option = document.createElement('option');
    option.value = String(level);
    option.textContent = label;
    heading.append(option);
  });
  let headingLevel = 0;
  heading.addEventListener('change', () => {
    const level = Number(heading.value);
    // Choosing the current level again would toggle it off, so only act on a real change.
    if (level !== headingLevel) run('heading', level === 0 ? headingLevel : level);
    run('focus');
  });
  dom.append(heading);

  const left = document.createElement('div');
  left.className = 'mdl-toolbar-buttons';
  for (const spec of BUTTONS) {
    if (spec.gap) {
      const sep = document.createElement('span');
      sep.className = 'mdl-toolbar-sep';
      left.append(sep);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = ICONS[spec.icon];
    b.title = spec.keys ? `${spec.title} (${keys(spec.keys)})` : spec.title;
    b.setAttribute('aria-label', spec.title);
    // Keep the text selection (or the focused table cell) while the button is pressed.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => run(spec.id));
    left.append(b);
  }
  dom.append(left);

  const modes = document.createElement('div');
  modes.className = 'mdl-modes';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'Editor mode');
  const modeButtons = new Map<Mode, HTMLButtonElement>();
  for (const mode of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = MODE_LABELS[mode];
    b.title = `${MODE_HINTS[mode]} (${keys('Alt+M')} cycles)`;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => run('setMode', mode));
    modeButtons.set(mode, b);
    modes.append(b);
  }
  dom.append(modes);

  return {
    dom,
    setMode(mode) {
      for (const [m, b] of modeButtons) {
        b.classList.toggle('mdl-active', m === mode);
        b.setAttribute('aria-pressed', String(m === mode));
      }
    },
    setHeading(level) {
      headingLevel = level;
      heading.value = String(level);
    },
    setVisible(visible) {
      dom.hidden = !visible;
    },
  };
}
