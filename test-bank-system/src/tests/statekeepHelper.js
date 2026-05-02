const express = require('express');
const fs = require('fs');
const crypto = require('crypto');

class MockStateKeep {
  constructor({ persistFile = null } = {}) {
    this.remoteUrl = process.env.STATEKEEP_URL || null;
    this.app = null;
    this.server = null;
    this.port = null;
    this.persistFile = persistFile;
    this.store = { actors: {}, events: [] };
    this.localEvents = [];
    if (!this.remoteUrl) {
      this.app = express();
      this.app.use(express.json());
      this._setupRoutes();
    }
  }

  _fingerprintActor(actor) {
    const types = (actor.history || []).map(e => e.type || '').join(',');
    return crypto.createHash('sha1').update(types).digest('hex');
  }

  _setupRoutes() {
    this.app.post('/events', (req, res) => {
      const ev = req.body;
      if (!ev || !ev.actorId) return res.status(400).json({ ok: false });
      const a = this.store.actors[ev.actorId] || { history: [], state: null, version: ev.version || 'v1' };
      a.lastSeen = Date.now();
      a.history.push(ev);
      this.store.actors[ev.actorId] = a;
      this.store.events.push(ev);
      res.json({ ok: true });
    });

    this.app.get('/actors/:id', (req, res) => {
      const a = this.store.actors[req.params.id];
      if (!a) return res.status(404).json({ found: false });
      res.json(a);
    });

    this.app.post('/persist', (req, res) => {
      if (!this.persistFile) return res.status(500).json({ error: 'no persistFile' });
      fs.writeFileSync(this.persistFile, JSON.stringify(this.store, null, 2));
      res.json({ ok: true });
    });

    this.app.post('/load', (req, res) => {
      if (!this.persistFile || !fs.existsSync(this.persistFile)) return res.status(404).json({ ok: false });
      this.store = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
      res.json({ ok: true });
    });

    this.app.post('/migrate', (req, res) => {
      const { actorId, newVersion, expectedFingerprint } = req.body;
      const actor = this.store.actors[actorId];
      if (!actor) return res.status(404).json({ ok: false });
      const fingerprint = this._fingerprintActor(actor);
      let apply = false;
      if (expectedFingerprint) {
        apply = fingerprint !== expectedFingerprint;
      } else {
        // fallback: odd-history rule
        apply = (actor.history.length % 2 === 1);
      }
      if (apply) {
        actor.migratedTo = newVersion;
      }
      res.json({ migrated: apply, actor, fingerprint });
    });

    this.app.get('/fingerprint/:id', (req, res) => {
      const actor = this.store.actors[req.params.id];
      if (!actor) return res.status(404).json({ ok: false });
      const fp = this._fingerprintActor(actor);
      res.json({ fingerprint: fp });
    });

    this.app.post('/setstate', (req, res) => {
      const { actorId, state } = req.body;
      const actor = this.store.actors[actorId];
      if (!actor) return res.status(404).json({ ok: false });
      actor.state = state;
      res.json({ ok: true, actor });
    });

    this.app.get('/report/marooned', (req, res) => {
      const marooned = Object.entries(this.store.actors)
        .filter(([id, a]) => (a.history && a.history.length > 0) && (!a.state || a.state === null))
        .map(([id]) => id);
      res.json({ marooned });
    });
  }

  start() {
    if (this.remoteUrl) {
      // remote mode: no local server
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(0, () => {
        this.port = this.server.address().port;
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  url() {
    if (this.remoteUrl) return this.remoteUrl.replace(/\/+$/, '');
    return `http://localhost:${this.port}`;
  }

  stop() {
    return new Promise((res) => this.server.close(() => res()));
  }

  getStore() {
    // return local store; in remote mode we still track localEvents
    return { actors: this.store.actors, events: this.localEvents.length ? this.localEvents : this.store.events };
  }

  persistTo(filePath) {
    fs.writeFileSync(filePath, JSON.stringify(this.store, null, 2));
    this.persistFile = filePath;
  }

  static loadFrom(filePath) {
    const m = new MockStateKeep({ persistFile: filePath });
    m.store = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : { actors: {}, events: [] };
    return m;
  }

  async sendEvent(event) {
    const target = `${this.url()}/events`;
    const res = await fetch(target, {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'content-type': 'application/json' },
    });
    // always record locally so tests can assert sent events regardless of mode
    this.localEvents.push(event);
    return res.json();
  }
}

module.exports = MockStateKeep;
