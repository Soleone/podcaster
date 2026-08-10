// Runtime validators associated with the generated contract model names.
import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { CONTRACT_SCHEMAS, type ContractModelName } from "./generated/contracts.js";

type AjvInstance = {
  addKeyword(value: Record<string, unknown>): void;
  addSchema(value: unknown): void;
  getSchema(id: string): ValidateFunction | undefined;
};
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as unknown as new (options: Record<string, unknown>) => AjvInstance;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (ajv: AjvInstance) => void;
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
addFormats(ajv);
ajv.addKeyword({
  keyword: "maxUtf8Bytes",
  type: "string",
  schemaType: "number",
  validate: (limit: number, value: string) => !hasUnpairedSurrogate(value) && Buffer.byteLength(value, "utf8") <= limit,
});
for (const schema of Object.values(CONTRACT_SCHEMAS)) ajv.addSchema(schema);

export const CONTRACT_VALIDATORS = Object.fromEntries(
  Object.entries(CONTRACT_SCHEMAS).map(([path, schema]) => [
    schema.title,
    ajv.getSchema(`https://podcaster.local/schema/${path}`)!,
  ]),
) as Record<ContractModelName, ValidateFunction>;
