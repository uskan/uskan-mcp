/**
 * Thin HTTP client for the uskan.app REST API.
 *
 * Everything the MCP tools do goes through `request()` / `upload()` so that
 * auth, error shaping and hint text live in exactly one place.
 *
 * Secrecy rule: the API key is read from the environment on every call and is
 * never written to stdout/stderr, never embedded in an error message, and never
 * returned to the model. `redact()` is applied to any string that leaves here.
 */

/** Default API origin; override with USKAN_API_URL (e.g. a staging host). */
const DEFAULT_BASE_URL = "https://uskan.app";

export const DASHBOARD_URL = "https://uskan.app/dashboard";
export const BILLING_URL = "https://uskan.app/dashboard/billing";

export class UskanError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UskanError";
    this.status = status;
  }
}

/** Base URL without a trailing slash. */
export function baseUrl(): string {
  const raw = (process.env.USKAN_API_URL || DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, "");
}

/**
 * Return the configured API key, or throw a message the agent can act on.
 * Never include the key itself in any thrown message.
 */
export function apiKey(): string {
  const key = (process.env.USKAN_API_KEY || "").trim();
  if (!key) {
    throw new UskanError(
      "USKAN_API_KEY is not set. Create a personal API token at " +
        `${DASHBOARD_URL} (it looks like "usk_live_…") and expose it to this MCP ` +
        'server as the USKAN_API_KEY environment variable, e.g. in .mcp.json: ' +
        '"env": { "USKAN_API_KEY": "usk_live_…" }. ' +
        "Ask the user for the token — do not invent one.",
      401,
    );
  }
  return key;
}

/** True when a key is present, without revealing anything about it. */
export function hasApiKey(): boolean {
  return Boolean((process.env.USKAN_API_KEY || "").trim());
}

/** Strip anything that looks like a uskan token out of text before it escapes. */
export function redact(text: string): string {
  return text.replace(/usk_(live|test)_[A-Za-z0-9_-]+/g, "usk_***");
}

/** Actionable next step appended to every failure, keyed on the HTTP status. */
function hintFor(status: number, path: string): string {
  switch (status) {
    case 401:
    case 403:
      return (
        `Unauthorized. Create a token at ${DASHBOARD_URL} and set USKAN_API_KEY ` +
        "in this MCP server's env (then restart the MCP server so it picks up the value)."
      );
    case 402:
      return `Insufficient credit balance. Add funds at ${BILLING_URL}, then retry.`;
    case 404:
      return (
        "Not found — the project, artifact or endpoint does not exist for this " +
        "account. Run uskan_status to list the projects this token can see, and " +
        "make sure you are using an id returned by that call."
      );
    case 400:
    case 422:
      return (
        "The request body was rejected. Re-read the tool's input schema and fix " +
        "the offending field; do not retry the identical payload."
      );
    case 409:
      return "Conflict — this resource already exists or is in a state that blocks the change.";
    case 413:
      return "The uploaded file is too large for the API. Check that you are uploading a release build, not an unstripped debug artifact.";
    case 429:
      return "Rate limited. Wait a few seconds before retrying.";
    case 502:
    case 503:
      return (
        "The AI provider behind this endpoint failed or is unavailable. This does " +
        "NOT consume credits — retry once; if it fails again, report it to the user " +
        "instead of looping."
      );
    default:
      return status >= 500
        ? `uskan.app returned a server error for ${path}. Retry once, then report it to the user.`
        : `Unexpected response from ${path}.`;
  }
}

/** Pull the human-readable message out of whatever the server sent back. */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText || `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof body.error === "string") parts.push(body.error);
    if (typeof body.detail === "string") parts.push(body.detail);
    if (Array.isArray(body.issues)) {
      const issues = body.issues
        .map((i) => {
          const issue = i as { path?: unknown[]; message?: string };
          const where = Array.isArray(issue.path) ? issue.path.join(".") : "";
          return where ? `${where}: ${issue.message ?? ""}` : issue.message ?? "";
        })
        .filter(Boolean);
      if (issues.length) parts.push(`(${issues.join("; ")})`);
    }
    if (typeof body.balance === "number" && typeof body.price === "number") {
      parts.push(`balance ${body.balance}, price ${body.price}`);
    }
    if (parts.length) return parts.join(" ");
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return text.slice(0, 400);
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey()}`,
    accept: "application/json",
    "user-agent": "uskan-mcp",
  };
}

async function toError(res: Response, path: string): Promise<UskanError> {
  const message = await errorMessage(res);
  return new UskanError(
    redact(`uskan API ${res.status} on ${path}: ${message} — ${hintFor(res.status, path)}`),
    res.status,
  );
}

/** JSON request. Non-2xx becomes a thrown UskanError carrying an actionable hint. */
export async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<T> {
  const url = new URL(`${baseUrl()}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const headers = authHeaders();
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", headers, body });
  } catch (err) {
    throw new UskanError(
      redact(
        `Could not reach ${url.origin} (${(err as Error).message}). Check network ` +
          "access and USKAN_API_URL.",
      ),
      0,
    );
  }

  if (!res.ok) throw await toError(res, path);
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

/** Multipart upload (build artifacts). Streams the file rather than buffering when possible. */
export async function upload<T = unknown>(
  path: string,
  fields: Record<string, string>,
  file: { blob: Blob; name: string },
): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", file.blob, file.name);

  let res: Response;
  try {
    // NOTE: no explicit content-type — fetch sets the multipart boundary itself.
    res = await fetch(url, { method: "POST", headers: authHeaders(), body: form });
  } catch (err) {
    throw new UskanError(
      redact(`Upload to ${url} failed (${(err as Error).message}).`),
      0,
    );
  }

  if (!res.ok) throw await toError(res, path);
  return (await res.json()) as T;
}
