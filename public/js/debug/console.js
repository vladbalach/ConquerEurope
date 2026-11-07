// In-game developer console (debug builds only). The ~ key toggles it.
// Commands are registered with register(); Tab completes, Up/Down walk the history.

const HISTORY_KEY = 'coe.console.history';
const MAX_HISTORY = 50;
const MAX_LINES = 300;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function commonPrefix(words) {
  let p = words[0] || '';
  for (const w of words) while (!w.startsWith(p)) p = p.slice(0, -1);
  return p;
}

export class DevConsole {
  constructor() {
    this.commands = new Map();     // name -> { help, run(args, con), complete?(args) -> string[] }
    this.history = loadHistory();
    this.histPos = -1;

    this.root = document.createElement('div');
    this.root.className = 'dev-console';
    this.root.hidden = true;
    this.logEl = document.createElement('div');
    this.logEl.className = 'dev-console-log';
    const row = document.createElement('div');
    row.className = 'dev-console-input';
    const prompt = document.createElement('span');
    prompt.textContent = '>';
    this.input = document.createElement('input');
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('spellcheck', 'false');
    row.append(prompt, this.input);
    this.root.append(this.logEl, row);
    document.body.append(this.root);

    window.addEventListener('keydown', (e) => this.onGlobalKey(e), true);
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.log('Developer console. Type "help" for commands; ~ closes it.', 'dim');
  }

  register(name, help, run, complete) {
    this.commands.set(name, { help, run, complete });
  }

  get isOpen() { return !this.root.hidden; }

  open() {
    this.root.hidden = false;
    this.input.focus();
  }

  close() {
    this.root.hidden = true;
    this.input.blur();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  clear() {
    this.logEl.textContent = '';
  }

  log(text, cls = '') {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    this.logEl.append(line);
    while (this.logEl.childElementCount > MAX_LINES) this.logEl.firstChild.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ~ (the key left of 1, whatever the keyboard layout) toggles the console,
  // except while typing in some other text field.
  onGlobalKey(e) {
    if (e.code !== 'Backquote') return;
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t && t.isContentEditable);
    if (typing && t !== this.input) return;
    e.preventDefault();
    e.stopPropagation();
    this.toggle();
  }

  onInputKey(e) {
    if (e.key === 'Enter') {
      const line = this.input.value.trim();
      this.input.value = '';
      this.histPos = -1;
      if (line) this.execute(line);
    } else if (e.key === 'Escape') {
      this.close();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.history.length) return;
      this.histPos = e.key === 'ArrowUp'
        ? Math.min(this.history.length - 1, this.histPos + 1)
        : Math.max(-1, this.histPos - 1);
      this.input.value = this.histPos < 0 ? '' : this.history[this.history.length - 1 - this.histPos];
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.complete();
    }
    e.stopPropagation();     // keep game hotkeys quiet while typing
  }

  execute(line) {
    this.log(`> ${line}`, 'cmd');
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    this.history = this.history.slice(-MAX_HISTORY);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history)); } catch { /* ignore */ }

    const [name, ...args] = line.split(/\s+/);
    const cmd = this.commands.get(name.toLowerCase());
    if (!cmd) {
      this.log(`Unknown command "${name}". Type "help" for the list.`, 'err');
      return;
    }
    try {
      cmd.run(args, this);
    } catch (err) {
      this.log(`Error: ${err.message}`, 'err');
    }
  }

  complete() {
    const parts = this.input.value.split(/\s+/);
    const last = (parts[parts.length - 1] || '').toLowerCase();
    let candidates;
    if (parts.length <= 1) {
      candidates = [...this.commands.keys()].filter((n) => n.startsWith(last));
    } else {
      const cmd = this.commands.get(parts[0].toLowerCase());
      candidates = cmd && cmd.complete ? cmd.complete(parts.slice(1, -1)).filter((c) => c.startsWith(last)) : [];
    }
    if (!candidates.length) return;
    const done = candidates.length === 1;
    parts[parts.length - 1] = done ? candidates[0] : commonPrefix(candidates);
    this.input.value = parts.join(' ') + (done ? ' ' : '');
    if (!done) this.log(candidates.join('    '), 'dim');
  }
}
