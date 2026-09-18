/**
 * 依据 contracts/request.schema.json 做请求结构校验。
 * 只实现本契约用到的 JSON Schema 子集：type / required / properties /
 * additionalProperties / minLength / minimum / format(date-time)。
 */

export interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
  minLength?: number;
  minimum?: number;
  format?: string;
}

export class ContractError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ContractError";
    this.field = field;
  }
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function validateNode(value: unknown, schema: SchemaNode, path: string): void {
  if (schema.type && !checkType(value, schema.type)) {
    throw new ContractError(path, `应为 ${schema.type}`);
  }
  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ContractError(path, `长度不得小于 ${schema.minLength}`);
    }
    if (schema.format === "date-time") {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new ContractError(path, "不是合法的 date-time");
    }
  }
  if ((schema.type === "integer" || schema.type === "number") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new ContractError(path, `不得小于 ${schema.minimum}`);
    }
  }
  if (schema.type === "object" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) throw new ContractError(path ? `${path}.${req}` : req, "缺少必需字段");
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) throw new ContractError(path ? `${path}.${key}` : key, "契约未定义的字段");
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (key in obj) validateNode(obj[key], child, path ? `${path}.${key}` : key);
    }
  }
}

export function validateAgainstContract(payload: unknown, schema: SchemaNode): void {
  validateNode(payload, schema, "");
}
