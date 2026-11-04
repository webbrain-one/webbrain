import { z } from "zod";

export const BOT_MEMORY_CAPABILITY = "bot_memory_v1";
export const MAX_TASK_MEMORY_BYTES = 128 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const taskMemorySchema = z.object({
  version: z.literal(1),
  botId: identifier,
  runId: identifier,
  policyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  callbackUrl: z.string().max(4096),
  callbackToken: z.string().min(32).max(2048),
  policy: z.object({ schemaVersion: z.literal(1), actions: z.array(z.record(z.string(), z.unknown())).min(1).max(20) }).passthrough(),
  context: z.record(z.string(), z.unknown()),
}).strict().superRefine((value, ctx) => {
  try {
    const url = new URL(value.callbackUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
        || url.username || url.password || url.search || url.hash
        || url.pathname !== `/api/internal/bot-memory/${value.runId}`
        || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TASK_MEMORY_BYTES) throw new Error();
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid private task memory transport." });
  }
});

export type TaskMemory = z.infer<typeof taskMemorySchema>;

export function validateTaskMemory(value: unknown): TaskMemory {
  const parsed = taskMemorySchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid task_memory envelope.");
  return parsed.data;
}

const privateKeys = new Set(["taskmemory", "botmemory", "taskmemoryciphertext", "taskmemoryrequired", "callbacktoken", "callbackurl"]);
const snapshotProtocolKeys = new Set(["runId", "run_id", "status", "mode", "tabId", "createdAt", "updatedAt", "completedAt", "errorCode", "code", "private_result"]);

/** The validated envelope's byte limit also bounds this private value inventory. */
export function taskMemoryPrivateValues(memory: TaskMemory): Set<string> {
  const values = new Set<string>();
  const pending: unknown[] = [memory.context, memory.policy];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && value) values.add(value);
    else if (value && typeof value === "object") pending.push(...Object.values(value));
  }
  return values;
}

function redact(value: unknown, credentials: string[], data: string[], depth: number, stripPrivateKeys: boolean, snapshot = false): unknown {
  if (depth > 32) return "[REDACTED]";
  if (typeof value === "string") {
    let safe = value;
    let reflected = false;
    for (const secret of [...credentials, ...data]) if (secret && safe.includes(secret)) {
      // Short policy enums are private envelope data, but matching letters
      // inside unrelated words would destroy otherwise useful run output.
      const next = secret.length < 8 && safe !== secret
        ? safe.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "gu"), "[REDACTED]")
        : safe.split(secret).join("[REDACTED]");
      reflected ||= next !== safe;
      safe = next;
    }
    if (reflected && /"(?:task_?memory|bot_?memory|callback_?(?:token|url))"\s*:/i.test(value.replace(/\\"/g, '"'))) return "[Private bot memory omitted]";
    return safe;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => redact(item, credentials, data, depth + 1, stripPrivateKeys));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !stripPrivateKeys || !privateKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")))
    .map(([key, nested]) => [key, redact(nested, credentials,
      snapshot && snapshotProtocolKeys.has(key) ? [] : data, depth + 1, stripPrivateKeys)]));
}

export function redactTaskMemory(value: unknown, secrets: Iterable<string> = [], depth = 0, stripPrivateKeys = true): unknown {
  const credentials = [...secrets];
  return credentials.length ? redact(value, credentials, [], depth, stripPrivateKeys) : value;
}

export interface MemoryResponseScope {
  runValues?: ReadonlyMap<string, ReadonlySet<string>>;
  requestRunId?: string;
  requestValues?: ReadonlySet<string>;
}

export function redactMemoryRunResponse(value: unknown, secrets: Iterable<string>, protectedRunIds: Set<string>, protectedRequest = false, scope: MemoryResponseScope = {}): unknown {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (result && Array.isArray(result.runs)) {
    return { ...redactTaskMemory(value, secrets) as Record<string, unknown>,
      runs: result.runs.map(run => redactMemoryRunResponse(run, secrets, protectedRunIds, false, scope)) };
  }
  const runId = String(result?.runId || result?.run_id || scope.requestRunId || "");
  const protectedRun = protectedRequest || protectedRunIds.has(runId);
  const credentials = [...secrets];
  const data = protectedRun ? [...(scope.runValues?.get(runId) || scope.requestValues || [])] : [];
  if (!credentials.length && !data.length) return value;
  return redact(value, credentials, data, 0, protectedRun, !!result);
}
