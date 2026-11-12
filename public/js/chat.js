// Chat: in the waiting room (RoomChat) and in the game (GameChat: over the minimap, Enter to write).
// The lobby server passes every message and says who sent it (server/index.js, "chat"). In the waiting room
// that is a nickname. While a game runs it is a player's id and colour, never a nickname (GAME_DESIGN.md,
// "Anonymous players"), and a spectator's messages reach the other spectators only. Once the game is over the
// nicknames are back.
import { CHAT, PLAYER_COLOR_NAMES, NEUTRAL_COLOR } from '/shared/config.js';
import { colorTag } from './hud.js';

const $ = (id) => document.getElementById(id);
const SHOW_MS = 12000;      // a new message stays this long over the minimap while the chat is closed...
const FADE_MS = 600;        // ...then fades out in this long (style.css, .game-chat .chat-line)
const AT_END_PX = 24;       // a log scrolled this close to its end follows new messages

function span(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

// Is the log scrolled to its last message (or close)? Then a new one scrolls it on.
const atEnd = (log) => log.scrollHeight - log.scrollTop - log.clientHeight < AT_END_PX;

// ------------------------------------------------------------------ waiting room
// Beside the room's card: everyone in the room, players and spectators, by nickname. No colours: they are dealt
// when the game starts.
export class RoomChat {
  // `send(text)`: to the lobby server. `me()`: this page's id in the room (its own messages in gold).
  constructor({ send, me }) {
    this.log = $('room-chat-log');
    this.input = $('room-chat-input');
    this.me = me;
    this.input.maxLength = CHAT.maxLength;
    $('room-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      send(text);
      this.input.value = '';
    });
  }

  // Every message so far (a room just joined), or none (left it).
  reset(list) {
    this.log.replaceChildren(...list.slice(-CHAT.keep).map((m) => this.line(m)));
    this.log.scrollTop = this.log.scrollHeight;
  }

  add(m) {
    const log = this.log, follow = atEnd(log) || m.from === this.me();
    log.append(this.line(m));
    while (log.childElementCount > CHAT.keep) log.firstChild.remove();
    if (follow) log.scrollTop = log.scrollHeight;
  }

  line(m) {
    const mine = m.from === this.me();
    // A message sent once the game has started, before it reached this page, has a colour instead.
    const name = m.name || (m.spectator ? 'Spectator' : PLAYER_COLOR_NAMES[m.color] || 'Someone');
    const who = span('b', `chat-name${mine ? ' me' : ''}${m.spectator ? ' spectator' : ''}`, name);
    if (m.spectator) who.title = 'Watching the game';
    const line = span('div', 'chat-line', '');
    line.append(who, `: ${m.text}`);
    return line;
  }
}

// ------------------------------------------------------------------ in the game
// Over the minimap: a new message shows there for SHOW_MS, the sender in their colour (a dot and the colour's
// name, "You" for your own). Enter opens the chat: a line to write in, and every message kept to read back.
// Enter sends and closes it, Esc closes it, and so does a click elsewhere (what was typed stays for next time).
export class GameChat {
  // `messages`: the game's chat so far (the lobby server's chatLog), there to read back but not shown as new.
  constructor(game, messages = []) {
    this.g = game;
    this.root = $('chat');
    this.log = $('chat-log');
    this.bar = $('chat-bar');
    this.to = $('chat-to');
    this.input = $('chat-input');
    this.input.maxLength = CHAT.maxLength;
    this.input.value = '';
    this.isOpen = false;
    this.timers = new Set();
    this.handlers = [
      [this.input, 'keydown', (e) => this.onKey(e)],
      [this.input, 'blur', () => this.close()],
      // A click in the open chat (its scrollbar, a message) keeps the line to write in: it would close otherwise.
      [this.root, 'mousedown', (e) => { if (this.isOpen && e.target !== this.input) e.preventDefault(); }],
    ];
    for (const [t, ev, fn] of this.handlers) t.addEventListener(ev, fn);
    this.reset(messages);
    this.close();
  }

  destroy() {
    for (const [t, ev, fn] of this.handlers) t.removeEventListener(ev, fn);
    this.clearTimers();
    this.close();
    this.input.value = '';
    this.log.replaceChildren();
  }

  clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  // While the game runs, a spectator writes to the other spectators only (the server sends it to them alone).
  get toSpectators() {
    return this.g.spectator && !this.g.ended;
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.classList.add('open');
    this.bar.hidden = false;
    const spectators = this.toSpectators;
    this.to.textContent = spectators ? 'To spectators:' : 'To all:';
    this.to.title = spectators ? 'While the game runs, spectators talk among themselves: players don\'t see it' : '';
    this.input.placeholder = 'Enter sends · Esc closes';
    this.input.focus();
    this.log.scrollTop = this.log.scrollHeight;
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.bar.hidden = true;
    if (document.activeElement === this.input) this.input.blur();     // its blur comes back here: nothing left to do
    this.log.scrollTop = this.log.scrollHeight;
  }

  onKey(e) {
    if (e.isComposing) return;           // writing with an input method: Enter picks the word
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;              // still held from opening the chat
      const text = this.input.value.trim();
      this.input.value = '';
      if (text) this.g.net.send({ t: 'chat', text });   // it shows once the lobby server sends it back
      this.close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.input.value = '';
      this.close();
    } else if (e.key === 'Tab') {
      e.preventDefault();                // stay in the chat (Tab is the Players list in the game)
    }
  }

  // The chat so far, all of it read: nothing shows over the minimap until a new message comes.
  reset(list) {
    this.clearTimers();
    this.log.replaceChildren(...list.slice(-CHAT.keep).map((m) => {
      const line = this.line(m);
      line.classList.add('old');
      return line;
    }));
    this.log.scrollTop = this.log.scrollHeight;
  }

  add(m) {
    const log = this.log, follow = !this.isOpen || atEnd(log) || m.from === this.g.you;
    const line = this.line(m);
    log.append(line);
    while (log.childElementCount > CHAT.keep) log.firstChild.remove();
    if (follow) log.scrollTop = log.scrollHeight;
    const later = (ms, fn) => {
      const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms);
      this.timers.add(id);
    };
    later(SHOW_MS, () => line.classList.add('fading'));
    later(SHOW_MS + FADE_MS, () => { line.classList.remove('fading'); line.classList.add('old'); });
  }

  // "● Red: text": a player in their colour, by the colour's name (their nickname once the game is over), your
  // own as "You". A spectator in grey.
  line(m) {
    const g = this.g, mine = m.from === g.you;
    const line = span('div', 'chat-line', '');
    if (m.spectator) {
      const who = span('b', 'chat-spectator', mine ? 'You' : m.name || 'Spectator');
      who.title = 'Spectator';
      line.append(who);
    } else {
      const color = m.color || NEUTRAL_COLOR;
      const dot = span('i', 'pdot', '');
      dot.style.background = color;
      line.append(dot, colorTag(mine ? 'You' : m.name || PLAYER_COLOR_NAMES[color] || 'Someone', color));
    }
    line.append(`: ${m.text}`);
    return line;
  }
}
