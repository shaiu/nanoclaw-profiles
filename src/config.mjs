import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(raw, baseDir) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const errors = [];

  if (typeof cfg.nanoclawDir !== 'string' || !cfg.nanoclawDir) errors.push('nanoclawDir is required');

  const access = cfg.access ?? {};
  if (typeof access.teamDomain !== 'string' || !access.teamDomain) errors.push('access.teamDomain is required');
  if (typeof access.aud !== 'string' || !access.aud) errors.push('access.aud is required');

  const users = cfg.users ?? {};
  if (typeof users !== 'object' || Array.isArray(users) || Object.keys(users).length === 0) {
    errors.push('users must map at least one email to a NanoClaw user id');
  } else {
    for (const [email, id] of Object.entries(users)) {
      if (!EMAIL_RE.test(email)) errors.push(`users: "${email}" is not an email address`);
      if (typeof id !== 'string' || !id) errors.push(`users: "${email}" must map to a user id string`);
    }
  }

  const port = cfg.port ?? 3200;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port must be an integer 1-65535');

  const timezone = cfg.timezone ?? 'UTC';
  if (!isValidTimezone(timezone)) errors.push(`timezone "${timezone}" is not a valid IANA timezone`);

  const currency = { code: 'USD', symbol: '$', rate: 1, ...(cfg.currency ?? {}) };
  if (typeof currency.rate !== 'number' || !(currency.rate > 0)) errors.push('currency.rate must be a positive number');

  const prices = cfg.prices ?? {};
  for (const [model, p] of Object.entries(prices)) {
    for (const k of ['input', 'output']) {
      if (typeof p?.[k] !== 'number') errors.push(`prices.${model}.${k} must be a number`);
    }
  }

  const plugins = cfg.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.some((p) => typeof p !== 'string')) errors.push('plugins must be an array of paths');

  const hiddenGroups = cfg.hiddenGroups ?? [];
  if (!Array.isArray(hiddenGroups) || hiddenGroups.some((g) => typeof g !== 'string')) {
    errors.push('hiddenGroups must be an array of group folders');
  }

  if (errors.length) throw new ConfigError(`Invalid config:\n- ${errors.join('\n- ')}`);

  const nanoclawDir = path.resolve(baseDir, cfg.nanoclawDir);
  return {
    port,
    nanoclawDir,
    dbPath: path.join(nanoclawDir, 'data', 'v2.db'),
    sessionsDir: path.join(nanoclawDir, 'data', 'v2-sessions'),
    groupsDir: path.join(nanoclawDir, 'groups'),
    ncl: cfg.ncl ? path.resolve(baseDir, cfg.ncl) : path.join(nanoclawDir, 'bin', 'ncl'),
    timezone,
    access: {
      teamDomain: access.teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      aud: access.aud,
    },
    users: Object.fromEntries(Object.entries(users).map(([e, id]) => [e.toLowerCase(), id])),
    hiddenGroups,
    showCostToMembers: cfg.showCostToMembers === true,
    currency,
    prices,
    plugins: plugins.map((p) => path.resolve(baseDir, p)),
  };
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read config ${abs}: ${err.message}`);
  }
  return validateConfig(raw, path.dirname(abs));
}
