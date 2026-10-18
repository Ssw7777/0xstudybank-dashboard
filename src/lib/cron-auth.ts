import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextRequest } from "next/server";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/**
 * GitHub Actions OIDC trust is fully configured via environment variables:
 *   GITHUB_OIDC_AUDIENCES          comma-separated list of accepted audiences,
 *                                  e.g. "https://your-dashboard.example.com"
 *   GITHUB_OIDC_TRUSTED_WORKFLOWS  JSON array of trusted workflows, e.g.
 *     [{"repository":"owner/repo","repositoryId":"123","visibility":"public",
 *       "workflowRef":"owner/repo/.github/workflows/refresh.yml@refs/heads/main",
 *       "allowedEvents":["schedule","workflow_dispatch"]}]
 * When either is empty, OIDC auth is disabled and only CRON_SECRET / sessions work.
 */
const GITHUB_OIDC_AUDIENCES: string[] = (process.env.GITHUB_OIDC_AUDIENCES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GITHUB_MAIN_REF = "refs/heads/main";

type TrustedWorkflow = {
  repository: string;
  repositoryId: string;
  visibility: string;
  workflowRef: string;
  allowedEvents: string[];
};

function loadTrustedWorkflows(): TrustedWorkflow[] {
  const raw = process.env.GITHUB_OIDC_TRUSTED_WORKFLOWS || "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrustedWorkflow[]) : [];
  } catch {
    return [];
  }
}
const TRUSTED_GITHUB_WORKFLOWS: TrustedWorkflow[] = loadTrustedWorkflows();

const githubJwks = createRemoteJWKSet(
  new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`),
  {
    cooldownDuration: 5 * 60 * 1000,
    timeoutDuration: 10 * 1000,
  }
);

function bearerToken(req: NextRequest) {
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function secretsMatch(left: string, right: string) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function isTrustedGithubWorkflowToken(token: string) {
  if (!token || GITHUB_OIDC_AUDIENCES.length === 0 || TRUSTED_GITHUB_WORKFLOWS.length === 0) return false;

  try {
    const { payload } = await jwtVerify(token, githubJwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: GITHUB_OIDC_AUDIENCES,
      algorithms: ["RS256"],
    });

    const trustedWorkflow = TRUSTED_GITHUB_WORKFLOWS.find(
      (candidate) =>
        payload.repository === candidate.repository &&
        payload.repository_id === candidate.repositoryId &&
        payload.workflow_ref === candidate.workflowRef &&
        payload.repository_visibility === candidate.visibility
    );

    return (
      !!trustedWorkflow &&
      payload.ref === GITHUB_MAIN_REF &&
      trustedWorkflow.allowedEvents.some((event) => payload.event_name === event) &&
      payload.runner_environment === "github-hosted"
    );
  } catch {
    return false;
  }
}

/**
 * Authorizes either the existing shared CRON_SECRET or the short-lived OIDC token
 * issued by GitHub specifically to this repository's production refresh workflow.
 */
export async function hasCronAuthorization(req: NextRequest) {
  const token = bearerToken(req);
  const configuredSecret = process.env.CRON_SECRET || "";
  const querySecret = new URL(req.url).searchParams.get("token") || "";

  if (
    configuredSecret &&
    (secretsMatch(token, configuredSecret) || secretsMatch(querySecret, configuredSecret))
  ) {
    return true;
  }

  return isTrustedGithubWorkflowToken(token);
}
