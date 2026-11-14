import { readFileSync } from 'node:fs';

/** @typedef {{valueName: string, valueType: string, valueDescription: string, valueOptional: boolean, valueRestrictions: string|null, valueOptionalBehavior: string|null}} Field */
/** @typedef {{requestType: string, description: string, category: string, initialVersion: string, deprecated: boolean, requestFields: Field[], responseFields: {valueName: string, valueType: string, valueDescription: string}[]}} Command */
/** @type {{source: string, revision: string, requests: Command[]}} */
export const catalog = JSON.parse(readFileSync(new URL('../data/protocol.json', import.meta.url), 'utf8'));

/** Generate the tool's visible index from the same catalog used for command help. */
export function commandIndex() {
  /** @type {Map<string, string[]>} */
  const categories = new Map();
  for (const command of catalog.requests) {
    const names = categories.get(command.category) ?? [];
    names.push(command.requestType);
    categories.set(command.category, names);
  }
  return [`Available catalog commands (${catalog.requests.length}), grouped by category:`,
    ...Array.from(categories).sort(([a], [b]) => a.localeCompare(b)).map(([category, names]) => `${category}: ${names.sort().join(', ')}`),
  ].join('\n');
}

/** @param {{query?: string, name?: string, offset?: number, limit?: number}} options */
export function findCommands({ query = '', name, offset = 0, limit = 20 }) {
  if (name) {
    const command = catalog.requests.find(item => item.requestType === name);
    if (!command) throw new Error(`Unknown OBS command: ${name}`);
    return { source: catalog.source, revision: catalog.revision, command };
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = catalog.requests.filter(item => words.every(word => `${item.requestType} ${item.category} ${item.description}`.toLowerCase().includes(word)));
  return { total: matches.length, offset, commands: matches.slice(offset, offset + limit).map(({ requestType, description, category, initialVersion }) => ({ name: requestType, description, category, initialVersion })) };
}

/** @param {string} name @param {Record<string, unknown>} data */
export function validateCommand(name, data) {
  const command = catalog.requests.find(item => item.requestType === name);
  if (!command) throw new Error(`Unknown OBS command: ${name}. Use obs_commands to discover commands.`);
  for (const key of Object.keys(data)) {
    if (!command.requestFields.some(field => field.valueName === key)) throw new Error(`Unknown parameter ${key} for ${name}`);
  }
  for (const field of command.requestFields) {
    const value = data[field.valueName];
    if (value === undefined) {
      if (!field.valueOptional) throw new Error(`Missing parameter ${field.valueName} for ${name}`);
      continue;
    }
    const type = field.valueType;
    const valid = type === 'String' ? typeof value === 'string' : type === 'Boolean' ? typeof value === 'boolean'
      : type === 'Number' ? typeof value === 'number' && Number.isFinite(value)
      : type.startsWith('Array') ? Array.isArray(value) : type === 'Object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : true;
    if (!valid) throw new Error(`Invalid ${type} parameter ${field.valueName} for ${name}`);
  }
}
