import { log } from '../logger.js';
import { EVENTS } from '../core/eventbus.js';
import { dayNight } from '../util/daynight.js';
import { listRules, resolveTarget } from './automations.js';

const TIMER_TICK_MS = 15_000;
const DEFAULT_OFFLINE_DELAY_MIN = 1; // ride out brief disconnects before arming SAMs etc.

// Applies one owner's automation rules on their RustSession. Level-triggered with
// edge detection: the poller reports day/night and team-online state every poll,
// and rules fire when that state changes — including the first reading after a
// (re)connect, so switches are brought in line with the current state.
// Rules are re-read from the DB on every change, so /auto edits apply without
// restarting anything.
export class AutomationEngine {
  constructor(session) {
    this.session = session;
    this.isDay = null; // unknown until the first time poll
    this.allOffline = null; // unknown until the first team poll
    this.offlineTimers = new Map(); // ruleId -> pending delayed "team offline" action
    this.timerPhase = new Map(); // ruleId -> { on, until }
    this.tick = null;

    const bus = session.bus;
    bus.on('rust:connected', () => this.reset());
    bus.on('server:time', (time) => this.onTime(time));
    bus.on('team:state', (state) => this.onTeam(state));
  }

  start() {
    if (this.tick) return;
    this.tick = setInterval(() => this.onTimerTick(), TIMER_TICK_MS);
    if (typeof this.tick.unref === 'function') this.tick.unref();
  }

  stop() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.reset();
  }

  // Forget derived state so the next poll re-applies every rule.
  reset() {
    this.isDay = null;
    this.allOffline = null;
    this.offlineTimers.forEach(clearTimeout);
    this.offlineTimers.clear();
    this.timerPhase.clear();
  }

  rules(trigger) {
    return listRules(this.session.ownerUserId).filter((r) => r.enabled && r.trigger === trigger);
  }

  async apply(rule, on, reason) {
    const ids = resolveTarget(this.session.ownerUserId, rule.target);
    if (!ids.length) return;
    await this.session.applySwitches(Object.fromEntries(ids.map((id) => [id, on])));
    log.info(`automation #${rule.id} (${rule.trigger}) → ${rule.target} ${on ? 'ON' : 'OFF'}`);
    if (reason) this.session.bus.emit(EVENTS.AUTOMATION, { id: rule.id, target: rule.target, on, reason });
  }

  onTime(time) {
    const d = dayNight(time);
    if (!d || d.isDay === this.isDay) return;
    const first = this.isDay === null;
    this.isDay = d.isDay;
    for (const rule of this.rules('night')) {
      const on = !d.isDay !== !!rule.params.invert;
      // Quietly sync on the first reading; announce real sunset/sunrise flips.
      this.apply(rule, on, first ? null : d.isDay ? 'day' : 'night').catch((e) => log.warn('automation night:', e.message));
    }
  }

  onTeam({ online, total }) {
    if (!total) return; // team info not loaded / empty
    const allOffline = online === 0;
    if (allOffline === this.allOffline) return;
    const first = this.allOffline === null;
    this.allOffline = allOffline;

    for (const rule of this.rules('online')) {
      const on = !allOffline !== !!rule.params.invert;
      this.apply(rule, on, first ? null : allOffline ? 'team_offline' : 'team_online').catch((e) => log.warn('automation online:', e.message));
    }

    for (const rule of this.rules('offline')) {
      clearTimeout(this.offlineTimers.get(rule.id));
      this.offlineTimers.delete(rule.id);
      const invert = !!rule.params.invert;
      if (!allOffline) {
        this.apply(rule, invert, first ? null : 'team_online').catch((e) => log.warn('automation offline:', e.message));
        continue;
      }
      this.armOffline(rule);
    }
  }

  // Team is fully offline: fire the rule after its delay unless someone returns.
  armOffline(rule) {
    clearTimeout(this.offlineTimers.get(rule.id));
    const delayMs = (rule.params.delayMin ?? DEFAULT_OFFLINE_DELAY_MIN) * 60_000;
    const timer = setTimeout(() => {
      this.offlineTimers.delete(rule.id);
      const stillActive = this.rules('offline').some((r) => r.id === rule.id); // deleted/disabled meanwhile?
      if (this.allOffline && stillActive) this.apply(rule, !rule.params.invert, 'team_offline').catch((e) => log.warn('automation offline:', e.message));
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.offlineTimers.set(rule.id, timer);
  }

  // A rule just created or re-enabled: bring its target in line with the current
  // state right away instead of waiting for the next sunset / team change.
  // Returns the state applied (true/false), or null if the state isn't known yet.
  applyNow(rule) {
    const invert = !!rule.params.invert;
    let on = null;
    if (rule.trigger === 'night' && this.isDay !== null) on = !this.isDay !== invert;
    if (rule.trigger === 'online' && this.allOffline !== null) on = !this.allOffline !== invert;
    if (rule.trigger === 'offline' && this.allOffline === false) on = invert;
    if (rule.trigger === 'offline' && this.allOffline === true) {
      this.armOffline(rule);
      return !invert;
    }
    if (rule.trigger === 'timer') {
      this.timerPhase.delete(rule.id);
      this.onTimerTick();
      return true;
    }
    if (on === null) return null;
    this.apply(rule, on, null).catch((e) => log.warn('automation applyNow:', e.message));
    return on;
  }

  // Timer rules: ON for onMin, then OFF for offMin, repeat. Silent (no alerts).
  onTimerTick() {
    if (!this.session.isConnected()) return;
    const now = Date.now();
    const rules = this.rules('timer');
    const live = new Set(rules.map((r) => r.id));
    for (const id of this.timerPhase.keys()) if (!live.has(id)) this.timerPhase.delete(id);

    for (const rule of rules) {
      const onMs = (rule.params.onMin ?? 0) * 60_000;
      const offMs = (rule.params.offMin ?? 0) * 60_000;
      if (onMs <= 0 || offMs <= 0) continue;
      const phase = this.timerPhase.get(rule.id);
      if (phase && now < phase.until) continue;
      const on = phase ? !phase.on : true;
      this.timerPhase.set(rule.id, { on, until: now + (on ? onMs : offMs) });
      this.apply(rule, on, null).catch((e) => log.warn('automation timer:', e.message));
    }
  }
}
