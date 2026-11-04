import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = 50;

/** Best score per player, per round and all-time, persisted to a JSON file. */
export class Leaderboard {
  constructor(dataDir) {
    this.file = dataDir ? join(dataDir, 'leaderboard.json') : null;
    this.data = { rounds: {}, allTime: [] };
    this.timer = null;
    if (this.file) {
      mkdirSync(dataDir, { recursive: true });
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.rounds && Array.isArray(parsed.allTime)) this.data = parsed;
      } catch {
        /* first run or unreadable file: start empty */
      }
    }
  }

  static upsert(list, entry) {
    const i = list.findIndex((e) => e.player === entry.player);
    if (i >= 0) {
      if (list[i].score >= entry.score) return list;
      list.splice(i, 1);
    }
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.at - b.at);
    return list.slice(0, KEEP);
  }

  record({ player, score, roundId, counted }) {
    const entry = { player, score, at: Date.now() };
    if (counted && roundId != null) {
      const key = String(roundId);
      this.data.rounds[key] = Leaderboard.upsert(this.data.rounds[key] || [], entry);
    }
    this.data.allTime = Leaderboard.upsert(this.data.allTime, entry);
    this.scheduleSave();
  }

  top(roundId, n = 20) {
    return {
      round: (this.data.rounds[String(roundId)] || []).slice(0, n),
      allTime: this.data.allTime.slice(0, n),
    };
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.save(), 500);
    this.timer.unref?.();
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }
}
