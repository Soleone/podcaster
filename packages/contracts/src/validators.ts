// Runtime validators associated with the generated contract model names.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CONTRACT_SCHEMAS, type ContractModelName } from './generated/contracts.js';

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats.default(ajv);
ajv.addKeyword({
  keyword: 'maxUtf8Bytes',
  type: 'string',
  schemaType: 'number',
  validate: (limit: number, value: string) => !hasUnpairedSurrogate(value) && Buffer.byteLength(value, 'utf8') <= limit,
});
for (const schema of Object.values(CONTRACT_SCHEMAS)) ajv.addSchema(schema);

export const CONTRACT_VALIDATORS =
  // SAFETY: CONTRACT_SCHEMAS is generated with exactly one schema for every
  // ContractModelName. Every schema is registered above and must resolve by path.
  Object.fromEntries(
    Object.entries(CONTRACT_SCHEMAS).map(([path, schema]) => [
      schema.title,
      ajv.getSchema(`https://podcaster.local/schema/${path}`)!,
    ]),
  ) as Record<ContractModelName, ValidateFunction>;
