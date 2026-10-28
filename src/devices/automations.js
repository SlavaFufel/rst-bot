import { db } from '../store/db.js';
import { listDevices } from './store.js';

// Smart-switch automations per owner. Each rule drives one target (a switch id,
// or a device name = every switch paired under that name) from a trigger:
//   night   — ON at night, OFF during the day
//   offline — ON when the whole team is offline (after delayMin), OFF when anyone is back
//   online  — ON while anyone in the team is online, OFF when everyone left
//   timer   — cycle ON for onMin, OFF for offMin (e.g. farm watering)
// `invert` flips ON/OFF for night/offline/online (e.g. lights OFF when team offline).

export const MAX_RULES = 20;

const addStmt = db.prepare(
  'INSERT INTO automations (owner_user_id, kind, target, params, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
);
// Column is `kind` (TRIGGER is an SQL keyword); exposed to JS as rule.trigger.
const listStmt = db.prepare('SELECT id, kind, target, params, enabled FROM automations WHERE owner_user_id = ? ORDER BY id');
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM automations WHERE owner_user_id = ?');
const delStmt = db.prepare('DELETE FROM automations WHERE id = ? AND owner_user_id = ?');
const enableStmt = db.prepare('UPDATE automations SET enabled = ? WHERE id = ? AND owner_user_id = ?');

const parse = (row) => {
  let params = {};
  try {
    params = JSON.parse(row.params) ?? {};
  } catch {
    // keep defaults
  }
  return { id: row.id, trigger: row.kind, target: row.target, params, enabled: row.enabled === 1 };
};

export function addRule(ownerId, trigger, target, params = {}) {
  return Number(addStmt.run(ownerId, trigger, String(target), JSON.stringify(params), Date.now()).lastInsertRowid);
}
export function listRules(ownerId) {
  return listStmt.all(ownerId).map(parse);
}
export function countRules(ownerId) {
  return countStmt.get(ownerId).n;
}
export function deleteRule(ownerId, id) {
  return delStmt.run(id, ownerId).changes > 0;
}
export function setRuleEnabled(ownerId, id, enabled) {
  return enableStmt.run(enabled ? 1 : 0, id, ownerId).changes > 0;
}

// Target → switch entity ids. A number matches a paired switch id; anything else
// matches every switch whose name equals it (Unicode-aware, case-insensitive).
export function resolveTarget(ownerId, target) {
  const switches = listDevices(ownerId).filter((d) => d.type === 1);
  const t = String(target).trim();
  if (/^\d+$/.test(t)) return switches.filter((d) => d.entity_id === Number(t)).map((d) => d.entity_id);
  const want = t.toLowerCase();
  return switches.filter((d) => (d.name ?? '').trim().toLowerCase() === want).map((d) => d.entity_id);
}
