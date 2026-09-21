import { EventEmitter } from 'node:events';

export class CodexConnection extends EventEmitter {
  constructor(url) { super(); this.url = url; this.pending = new Map(); this.sequence = 0; }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== undefined && !message.method) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer); this.pending.delete(message.id);
        if (message.error) waiter.reject(Error(message.error.message)); else waiter.resolve(message.result);
      } else if (message.id !== undefined) {
        // No automatic permission escalation or fabricated tool responses.
        this.socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Conductor cannot grant interactive approval; stop and inspect.' } }));
        this.emit('notice', { method: 'conductor/approvalUnavailable' });
      } else this.emit('notice', message);
    });
    this.socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('Codex app server disconnected')); }
      this.pending.clear(); this.emit('disconnected');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Codex connection timed out')), 10000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Cannot connect to Codex')); }, { once: true });
    });
    await this.request('initialize', { clientInfo: { name: 'nova_conductor', title: 'Nova Conductor', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: 'initialized' }));
    return this;
  }
  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket?.close(); }
}
