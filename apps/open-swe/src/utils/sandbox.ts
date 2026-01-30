import { Daytona, Sandbox as DaytonaSandbox, SandboxState } from "@daytonaio/sdk";
import { createLogger, LogLevel } from "./logger.js";
import { GraphConfig, TargetRepository } from "@openswe/shared/open-swe/types";
import { DEFAULT_SANDBOX_CREATE_PARAMS } from "../constants.js";
import { getGitHubTokensFromConfig } from "./github-tokens.js";
import { cloneRepo } from "./github/git.js";
import { FAILED_TO_GENERATE_TREE_MESSAGE, getCodebaseTree } from "./tree.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { DockerSandbox, DockerSandboxClient, getDockerSandboxClient } from "./docker-sandbox.js";
import { isDockerMode } from "@openswe/shared/open-swe/docker-mode";

const logger = createLogger(LogLevel.INFO, "Sandbox");

// Export a unified Sandbox type
export type Sandbox = DaytonaSandbox | DockerSandbox;

// Singleton instance of Daytona
let daytonaInstance: Daytona | null = null;

// Helper to get Daytona client
function getDaytonaClient(): Daytona {
  if (!daytonaInstance) {
    daytonaInstance = new Daytona();
  }
  return daytonaInstance;
}

/**
 * Returns the appropriate sandbox client based on configuration
 */
export function daytonaClient(config?: GraphConfig): Daytona | DockerSandboxClient {
  if (isDockerMode(config)) {
    return getDockerSandboxClient();
  }
  return getDaytonaClient();
}

/**
 * Stops the sandbox. Either pass an existing sandbox client, or a sandbox session ID.
 * If no sandbox client is provided, the sandbox will be connected to.
 * In local mode, this is a no-op since we don't use Daytona sandboxes.
 
 * @param sandboxSessionId The ID of the sandbox to stop.
 * @param sandbox The sandbox client to stop. If not provided, the sandbox will be connected to.
 * @returns The sandbox session ID.
 */
export async function stopSandbox(sandboxSessionId: string, config?: GraphConfig): Promise<string> {
  // In local mode, we don't use Daytona sandboxes, so return early
  if (isLocalMode(config)) {
    logger.info("Local mode: skipping sandbox stop");
    return sandboxSessionId;
  }

  const client = daytonaClient(config);

  try {
    const sandbox = await client.get(sandboxSessionId);

    // Check if it's a Docker sandbox
    if ('waitUntilReady' in sandbox) { // Rough check or use type guard
      // Docker sandbox doesn't have same state enum exactly, but compatible strings
      if (sandbox.state === "started") {
        await (client as any).stop(sandbox);
      }
      return sandboxSessionId;
    }

    // Daytona sandbox
    const daytonaSandbox = sandbox as DaytonaSandbox;
    if (
      daytonaSandbox.state === SandboxState.STOPPED ||
      daytonaSandbox.state === SandboxState.ARCHIVED
    ) {
      return sandboxSessionId;
    } else if (daytonaSandbox.state === "started") {
      await client.stop(daytonaSandbox as any);
    }
  } catch (e) {
    logger.error("Error stopping sandbox", { error: e, sandboxSessionId });
  }

  return sandboxSessionId;
}

/**
 * Deletes the sandbox. In local mode, this is a no-op.
 * @param sandboxSessionId The ID of the sandbox to delete.
 * @returns True if the sandbox was deleted, false if it failed to delete.
 */
export async function deleteSandbox(
  sandboxSessionId: string,
  config?: GraphConfig
): Promise<boolean> {
  // In local mode, we don't use Daytona sandboxes, so return early
  if (isLocalMode(config)) {
    logger.info("Local mode: skipping sandbox delete");
    return true;
  }

  try {
    const client = daytonaClient(config);
    const sandbox = await client.get(sandboxSessionId);
    await client.delete(sandbox as any); // Type assertion needed due to slight mismatch if any
    return true;
  } catch (error) {
    logger.error("Failed to delete sandbox", {
      sandboxSessionId,
      error,
    });
    return false;
  }
}

async function createSandbox(attempt: number, config?: GraphConfig): Promise<Sandbox | null> {
  try {
    const client = daytonaClient(config);
    return await client.create(DEFAULT_SANDBOX_CREATE_PARAMS, {
      timeout: 100, // 100s timeout on creation.
    });
  } catch (e) {
    logger.error("Failed to create sandbox", {
      attempt,
      ...(e instanceof Error
        ? {
          name: e.name,
          message: e.message,
          stack: e.stack,
        }
        : {
          error: e,
        }),
    });
    return null;
  }
}

export async function getSandboxWithErrorHandling(
  sandboxSessionId: string | undefined,
  targetRepository: TargetRepository,
  branchName: string,
  config: GraphConfig,
): Promise<{
  sandbox: Sandbox;
  codebaseTree: string | null;
  dependenciesInstalled: boolean | null;
}> {
  if (isLocalMode(config)) {
    const mockSandbox = {
      id: sandboxSessionId || "local-mock-sandbox",
      state: "started",
      process: { executeCommand: async () => ({ exitCode: 0, result: "" }) }, // Minimal mock
      start: async () => { },
    } as unknown as Sandbox;

    return {
      sandbox: mockSandbox,
      codebaseTree: null,
      dependenciesInstalled: null,
    };
  }

  try {
    // If we have a session ID, try to get it
    if (sandboxSessionId) {
      logger.info("Getting sandbox.");
      const client = daytonaClient(config);

      try {
        const sandbox = await client.get(sandboxSessionId);

        if (sandbox.state === "started") {
          return {
            sandbox,
            codebaseTree: null,
            dependenciesInstalled: null,
          };
        }

        if (sandbox.state === "stopped" || sandbox.state === "archived") {
          await sandbox.start();
          return {
            sandbox,
            codebaseTree: null,
            dependenciesInstalled: null,
          };
        }

        // If we are here, state is weird, fallback to recreate
      } catch (e) {
        logger.warn("Could not get existing sandbox, will create new one", { sandboxSessionId, error: e });
      }
    }

    // Create new sandbox
    let sandbox: Sandbox | null = null;
    let numSandboxCreateAttempts = 0;
    while (!sandbox && numSandboxCreateAttempts < 3) {
      sandbox = await createSandbox(numSandboxCreateAttempts, config);
      if (!sandbox) {
        numSandboxCreateAttempts++;
      }
    }

    if (!sandbox) {
      throw new Error("Failed to create sandbox after 3 attempts");
    }

    const { githubInstallationToken } = getGitHubTokensFromConfig(config);

    // Clone repository
    // Note: cloneRepo expects Sandbox. We strictly typed it in git.ts, 
    // so we might need to cast or update git.ts first. 
    // Ideally we update git.ts to accept our new Sandbox type.
    await cloneRepo(sandbox, targetRepository, {
      githubInstallationToken,
      stateBranchName: branchName,
    });

    // Get codebase tree
    const codebaseTree = await getCodebaseTree(
      config,
      sandbox.id,
      targetRepository,
    );
    const codebaseTreeToReturn =
      codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE ? null : codebaseTree;

    logger.info("Sandbox created successfully", {
      sandboxId: sandbox.id,
    });
    return {
      sandbox,
      codebaseTree: codebaseTreeToReturn,
      dependenciesInstalled: false,
    };
  } catch (error) {
    throw error;
  }
}
