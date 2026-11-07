// Game balance editor for admins (Edit button in a game). Shows every editable stat of units,
// city upgrades and cities as a table; Save sends the changes to the server, which applies them
// to all games at once and keeps them across restarts.
import { BALANCE_SECTIONS, snapshot, defaults, editable } from '/shared/balance.js';

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export class BalanceEditor {
  constructor(net) {
    this.net = net;
    this.admin = false;
    this.inputs = [];          // { section, row, field, input }
    this.root = el('div', { id: 'balance-editor', class: 'overlay hud balance-editor', hidden: true });
    document.getElementById('screen-game').append(this.root);
  }

  get isOpen() { return !this.root.hidden; }

  open(admin) {
    this.admin = admin;
    this.render();
    this.root.hidden = false;
  }

  close() {
    this.root.hidden = true;
  }

  // The server confirmed new values (from us or another admin): show them.
  refresh(admin, changed) {
    this.admin = admin;
    if (!this.isOpen) return;
    this.render();
    if (changed) this.status('Saved. The new values apply to every game right away.', 'ok');
  }

  status(text, cls = '') {
    this.statusEl.textContent = text;
    this.statusEl.className = `editor-status ${cls}`;
  }

  render() {
    const values = snapshot();
    const base = defaults();
    this.inputs = [];
    this.root.textContent = '';
    this.root.append(el('div', { class: 'editor-head' },
      el('h3', {}, 'Game balance'),
      el('span', { class: 'muted small' },
        this.admin ? 'Changes apply to all games at once and are saved on the server.'
          : 'Only admins can change these values.')));

    const body = el('div', { class: 'editor-body' });
    for (const s of BALANCE_SECTIONS) {
      body.append(el('h4', {}, s.title));
      const head = el('tr', {}, el('th', {}, ''), ...s.fields.map((f) => el('th', { title: f.hint || '' }, f.label)));
      const table = el('table', { class: 'editor-table' }, head);
      for (const r of s.rows) {
        const tr = el('tr', {}, el('td', { class: 'row-name' }, r.name));
        for (const f of s.fields) {
          if (!editable(s.id, r.key, f.key)) {
            tr.append(el('td', { class: 'muted' }, '—'));
            continue;
          }
          const value = values[s.id][r.key][f.key];
          const def = base[s.id][r.key][f.key];
          const input = el('input', {
            type: 'number', min: f.min, max: f.max, step: 'any', value: String(value),
            disabled: !this.admin, title: `Default: ${def}${f.hint ? ` (${f.hint})` : ''}`,
            class: value !== def ? 'changed' : '',
          });
          input.addEventListener('input', () => this.markDirty());
          this.inputs.push({ section: s.id, row: r.key, field: f.key, input, value, def });
          tr.append(el('td', {}, input));
        }
        table.append(tr);
      }
      body.append(table);
    }
    this.root.append(body);

    this.statusEl = el('span', { class: 'editor-status' });
    const save = el('button', { type: 'button', class: 'primary', disabled: !this.admin, onclick: () => this.save() }, 'Save');
    const reset = el('button', {
      type: 'button', disabled: !this.admin,
      onclick: () => {
        if (confirm('Reset every value to the defaults from shared/config.js, for all games?')) {
          this.net.send({ t: 'resetBalance' });
          this.status('Resetting…');
        }
      },
    }, 'Reset to defaults');
    const close = el('button', { type: 'button', onclick: () => this.close() }, 'Close');
    this.root.append(el('div', { class: 'editor-foot' }, this.statusEl, reset, close, save));
    this.status('Highlighted values differ from the defaults. Hover a value to see its default.');
  }

  markDirty() {
    const dirty = this.inputs.filter((i) => Number(i.input.value) !== i.value).length;
    this.status(dirty ? `${dirty} unsaved change${dirty === 1 ? '' : 's'}` : '', dirty ? 'dirty' : '');
  }

  save() {
    const values = {};
    let count = 0, bad = 0;
    for (const i of this.inputs) {
      if (i.input.value.trim() === '') { bad++; continue; }
      const v = Number(i.input.value);
      if (!Number.isFinite(v)) { bad++; continue; }
      if (v === i.value) continue;
      ((values[i.section] ||= {})[i.row] ||= {})[i.field] = v;
      count++;
    }
    if (bad) { this.status('Some fields are empty or not a number.', 'err'); return; }
    if (!count) { this.status('Nothing to save.'); return; }
    this.net.send({ t: 'setBalance', values });
    this.status('Saving…');
  }
}
