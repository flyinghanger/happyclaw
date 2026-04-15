/**
 * Agent Capability Preflight — shared capability declarations for host mode.
 *
 * Container mode gets these tools via Dockerfile; host mode relies on the
 * host OS having them installed.  This module detects what's available and
 * returns environment variables + log messages so `runHostAgent()` can act
 * on the results.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export interface AgentCapability {
  /** Human-readable name */
  name: string;
  /** Binary to look up in $PATH */
  binary: string;
  /** Extra env vars to inject when the tool is present */
  envVars?: Record<string, string>;
  /** Platform-specific overrides for envVars (merged on top) */
  platformEnvVars?: Partial<Record<NodeJS.Platform, Record<string, string>>>;
  /** If true the preflight logs an error; otherwise a warning */
  required: boolean;
  /** One-liner install command shown in the log */
  installHint: string;
}

export const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    name: 'feishu-cli',
    binary: 'feishu-cli',
    required: false,
    installHint:
      'See scripts/install-host-tools.sh or: curl -fsSL https://github.com/riba2534/feishu-cli/releases/latest/download/install.sh | sh',
  },
  {
    name: 'agent-browser',
    binary: 'agent-browser',
    platformEnvVars: {
      darwin: {
        AGENT_BROWSER_EXECUTABLE_PATH:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      linux: {
        AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
      },
    },
    required: false,
    installHint: 'npm install -g agent-browser',
  },
  {
    name: 'uv',
    binary: 'uv',
    required: false,
    installHint: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
  },
];

async function isBinaryAvailable(binary: string): Promise<boolean> {
  try {
    await execFileAsync('which', [binary], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export interface CapabilityCheckResult {
  available: AgentCapability[];
  missing: AgentCapability[];
  /** Env vars to inject into the host process (only for available tools) */
  envVars: Record<string, string>;
}

/** Detect which agent capabilities are present on the host. */
export async function checkHostCapabilities(): Promise<CapabilityCheckResult> {
  const results = await Promise.all(
    AGENT_CAPABILITIES.map(async (cap) => ({
      cap,
      available: await isBinaryAvailable(cap.binary),
    })),
  );

  const available: AgentCapability[] = [];
  const missing: AgentCapability[] = [];
  const envVars: Record<string, string> = {};

  for (const { cap, available: ok } of results) {
    if (ok) {
      available.push(cap);
      if (cap.envVars) Object.assign(envVars, cap.envVars);
      const platformVars = cap.platformEnvVars?.[os.platform()];
      if (platformVars) Object.assign(envVars, platformVars);
    } else {
      missing.push(cap);
    }
  }

  return { available, missing, envVars };
}

/** Log preflight results — warnings for missing, nothing for available. */
export function logCapabilityPreflight(
  groupName: string,
  result: CapabilityCheckResult,
): void {
  if (result.missing.length === 0) return;

  for (const cap of result.missing) {
    const logFn = cap.required
      ? logger.error.bind(logger)
      : logger.warn.bind(logger);
    logFn(
      { group: groupName, tool: cap.name },
      `Host preflight: ${cap.name} not found — some agent capabilities will be unavailable. Install: ${cap.installHint}`,
    );
  }
}
