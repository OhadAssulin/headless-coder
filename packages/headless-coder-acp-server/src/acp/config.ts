import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import type { AcpConfig } from './types';

const CONFIG_PATH = path.resolve(process.cwd(), 'acp.config.json');
const SCHEMA_PATH = path.resolve(process.cwd(), 'acp.config.schema.json');
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

let cached: AcpConfig | null = null;
let schemaLoaded = false;

function getValidator() {
  if (!schemaLoaded) {
    const schemaRaw = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    ajv.addSchema(schemaRaw, 'acp-config');
    schemaLoaded = true;
  }
  return ajv.getSchema('acp-config')!;
}

export function loadConfig(): AcpConfig {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const validate = getValidator();
  if (!validate(raw)) {
    const errors = (validate.errors ?? []).map(err => `${err.instancePath} ${err.message}`).join('; ');
    throw new Error(`Invalid ACP config: ${errors}`);
  }
  cached = raw as AcpConfig;
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
