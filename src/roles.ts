import type { DomainData } from "./domain.js";

export type Role = string;

/** 按角色过滤旅客身份字段：operator / border / auditor 只能读取各自允许的字段。 */
export function filterIdentity(
  domain: DomainData,
  role: Role,
  identity: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!identity) return {};
  const allowed = new Set(domain.permissions.roles[role]?.identity_fields ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(identity)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}
