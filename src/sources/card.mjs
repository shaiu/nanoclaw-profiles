import fs from 'node:fs';
import path from 'node:path';

export class CardError extends Error {}
export const ICON_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

export function findCardFile(groupsDir, folder) {
  const groupDir = path.join(groupsDir, folder);
  const direct = path.join(groupDir, 'agent-card.json');
  if (fs.existsSync(direct)) return direct;
  const pluginsDir = path.join(groupDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) return null;
  for (const name of fs.readdirSync(pluginsDir).sort()) {
    const file = path.join(pluginsDir, name, 'agent-card.json');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return ['card must be a JSON object'];
  const errors = [];
  for (const k of ['name', 'description', 'iconUrl']) {
    if (card[k] !== undefined && typeof card[k] !== 'string') errors.push(`${k} must be a string`);
  }
  if (typeof card.iconUrl === 'string') {
    if (card.iconUrl.includes('..') || path.isAbsolute(card.iconUrl) || /^[a-z][a-z0-9+.-]*:/i.test(card.iconUrl)) {
      errors.push('iconUrl must be a relative path inside the card folder');
    } else if (!ICON_EXT.has(path.extname(card.iconUrl).toLowerCase())) {
      errors.push('iconUrl must be a .png, .jpg, .jpeg, .webp or .svg file');
    }
  }
  if (card.skills !== undefined) {
    if (!Array.isArray(card.skills)) errors.push('skills must be an array');
    else {
      card.skills.forEach((s, i) => {
        if (!s || typeof s.name !== 'string') errors.push(`skills[${i}].name must be a string`);
        if (s?.description !== undefined && typeof s.description !== 'string') errors.push(`skills[${i}].description must be a string`);
        if (s?.examples !== undefined) {
          if (!isStringArray(s.examples)) errors.push(`skills[${i}].examples must be an array of strings`);
          else {
            if (s.examples.length > 5) errors.push(`skills[${i}] has more than 5 examples`);
            s.examples.forEach((e, j) => {
              if (e.length > 120) errors.push(`skills[${i}].examples[${j}] is longer than 120 characters`);
            });
          }
        }
      });
    }
  }
  const x = card['x-profile'];
  if (x !== undefined) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) errors.push('x-profile must be an object');
    else {
      for (const k of ['emoji', 'serves', 'voice']) {
        if (x[k] !== undefined && typeof x[k] !== 'string') errors.push(`x-profile.${k} must be a string`);
      }
      if (x.neverDoes !== undefined && !isStringArray(x.neverDoes)) errors.push('x-profile.neverDoes must be an array of strings');
    }
  }
  return errors;
}

export function readAgentCard(groupsDir, folder) {
  const file = findCardFile(groupsDir, folder);
  if (!file) return null;
  let card;
  try {
    card = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CardError(`${file}: invalid JSON (${err.message})`);
  }
  const errors = validateCard(card);
  if (errors.length) throw new CardError(`${file}: ${errors.join('; ')}`);
  return { card, file, baseDir: path.dirname(file) };
}

export function resolveIconPath(cardInfo) {
  const iconUrl = cardInfo?.card?.iconUrl;
  if (!iconUrl) return null;
  const abs = path.resolve(cardInfo.baseDir, iconUrl);
  if (!abs.startsWith(cardInfo.baseDir + path.sep)) return null;
  if (!ICON_EXT.has(path.extname(abs).toLowerCase())) return null;
  try {
    const real = fs.realpathSync(abs);
    const realBase = fs.realpathSync(cardInfo.baseDir);
    if (!real.startsWith(realBase + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
