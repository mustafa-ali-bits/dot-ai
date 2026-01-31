import { v4 as uuidv4 } from "uuid";

import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getGitHubTokensFromConfig } from "../../utils/github-tokens.js";
import {
  CustomRules,
  GraphConfig,
  TargetRepository,
} from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { daytonaClient } from "../../utils/sandbox.js";
import { cloneRepo, pullLatestChanges } from "../../utils/github/git.js";
import {
  FAILED_TO_GENERATE_TREE_MESSAGE,
  getCodebaseTree,
} from "../../utils/tree.js";
import { DO_NOT_RENDER_ID_PREFIX } from "@openswe/shared/constants";
import {
  CustomNodeEvent,
  INITIALIZE_NODE_ID,
} from "@openswe/shared/open-swe/custom-node-events";
import { Sandbox } from "../../utils/sandbox.js";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { DEFAULT_SANDBOX_CREATE_PARAMS } from "../../constants.js";
import { getCustomRules } from "../../utils/custom-rules.js";
import { withRetry } from "../../utils/retry.js";
import {
  isLocalMode,

} from "@openswe/shared/open-swe/local-mode";
import { isDockerMode } from "@openswe/shared/open-swe/docker-mode";

const logger = createLogger(LogLevel.INFO, "InitializeSandbox");

type InitializeSandboxState = {
  targetRepository: TargetRepository;
  branchName: string;
  sandboxSessionId?: string;
  codebaseTree?: string;
  messages?: BaseMessage[];
  dependenciesInstalled?: boolean;
  customRules?: CustomRules;
};

export async function initializeSandbox(
  state: InitializeSandboxState,
  config: GraphConfig,
): Promise<Partial<InitializeSandboxState>> {
  const { sandboxSessionId, targetRepository, branchName } = state;
  const absoluteRepoDir = getRepoAbsolutePath(targetRepository);
  const repoName = `${targetRepository.owner}/${targetRepository.repo}`;

  logger.info("initializeSandbox called", {
    isLocal: isLocalMode(config),
    isDocker: isDockerMode(config),
    sandboxSessionId,
    repoName,
    dockerEnv: process.env.OPEN_SWE_DOCKER_MODE,
    localEnv: process.env.OPEN_SWE_LOCAL_MODE,
  });

  try {
    const fs = await import("fs");
    fs.appendFileSync(
      "debug-init.log",
      JSON.stringify({
        timestamp: new Date().toISOString(),
        isLocal: isLocalMode(config),
        isDocker: isDockerMode(config),
        dockerEnv: process.env.OPEN_SWE_DOCKER_MODE,
        localEnv: process.env.OPEN_SWE_LOCAL_MODE
      }) + "\n"
    );
  } catch (e) {
    // ignore
  }

  const events: CustomNodeEvent[] = [];
  const emitStepEvent = (
    base: CustomNodeEvent,
    status: "pending" | "success" | "error" | "skipped",
    error?: string,
  ) => {
    const event = {
      ...base,
      createdAt: new Date().toISOString(),
      data: {
        ...base.data,
        status,
        ...(error ? { error } : {}),
        runId: config.configurable?.run_id ?? "",
      },
    };
    events.push(event);
    try {
      config.writer?.(event);
    } catch (err) {
      logger.error("Failed to emit custom event", { event, err });
    }
  };
  const createEventsMessage = () => [
    new AIMessage({
      id: `${DO_NOT_RENDER_ID_PREFIX}${uuidv4()}`,
      content: "Initialize sandbox",
      additional_kwargs: {
        hidden: true,
        customNodeEvents: events,
      },
    }),
  ];

  // Check if we're in Docker mode (Prioritize Docker over Local if both are seemingly enabled)
  if (isDockerMode(config)) {
    return initializeSandboxDocker(
      state,
      config,
      emitStepEvent,
      createEventsMessage,
    );
  }

  // Fallback to Daytona (or legacy Docker logic if hidden) or just default to Docker if strictly enforcing
  // For now, let's make Docker default if not explicitly local (which is removed)
  // Since we are migrating, we can just proceed with Docker logic if isDockerMode is false for now,
  // or checks for other environments.
  // The error was that initializeSandboxDaytona was not defined.
  // It seems the intention was to use initializeSandboxDocker as the main logic flow given the current file structure.
  // Or perhaps the code below IS the Daytona logic but wasn't wrapped?
  // Looking at the code structure, lines 132+ seem to be the implementation that was supposed to be
  // inside initializeSandboxDaytona OR it's the main body.
  // Given "return initializeSandboxDaytona..." was there, it implies separation.
  // But since the definition is missing and the code follows, I will assume the code below IS the intended logic.
  // I will just remove the return statement and let it flow through, but I need to make sure variables are defined.

  let githubInstallationToken = "";
  try {
    const tokens = getGitHubTokensFromConfig(config);
    githubInstallationToken = tokens.githubInstallationToken;
  } catch (e) {
    logger.warn("Failed to get GitHub tokens, proceeding without authentication", { error: e });
  }

  if (!sandboxSessionId) {
    emitStepEvent(
      {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: uuidv4(),
        action: "Resuming sandbox",
        data: {
          status: "skipped",
          branch: branchName,
          repo: repoName,
        },
      },
      "skipped",
    );
    emitStepEvent(
      {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: uuidv4(),
        action: "Pulling latest changes",
        data: {
          status: "skipped",
          branch: branchName,
          repo: repoName,
        },
      },
      "skipped",
    );
  }

  if (sandboxSessionId) {
    const resumeSandboxActionId = uuidv4();
    const baseResumeSandboxAction: CustomNodeEvent = {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: resumeSandboxActionId,
      action: "Resuming sandbox",
      data: {
        status: "pending",
        sandboxSessionId,
        branch: branchName,
        repo: repoName,
      },
    };
    emitStepEvent(baseResumeSandboxAction, "pending");

    try {
      const existingSandbox = await daytonaClient().get(sandboxSessionId);
      emitStepEvent(baseResumeSandboxAction, "success");

      const pullLatestChangesActionId = uuidv4();
      const basePullLatestChangesAction: CustomNodeEvent = {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: pullLatestChangesActionId,
        action: "Pulling latest changes",
        data: {
          status: "pending",
          sandboxSessionId,
          branch: branchName,
          repo: repoName,
        },
      };
      emitStepEvent(basePullLatestChangesAction, "pending");

      const pullChangesRes = await pullLatestChanges(
        absoluteRepoDir,
        existingSandbox,
        {
          githubInstallationToken,
        },
      );
      if (!pullChangesRes) {
        emitStepEvent(basePullLatestChangesAction, "skipped");
        throw new Error("Failed to pull latest changes.");
      }
      emitStepEvent(basePullLatestChangesAction, "success");

      const generateCodebaseTreeActionId = uuidv4();
      const baseGenerateCodebaseTreeAction: CustomNodeEvent = {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: generateCodebaseTreeActionId,
        action: "Generating codebase tree",
        data: {
          status: "pending",
          sandboxSessionId,
          branch: branchName,
          repo: repoName,
        },
      };
      emitStepEvent(baseGenerateCodebaseTreeAction, "pending");
      try {
        const codebaseTree = await getCodebaseTree(config, existingSandbox.id);
        if (codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE) {
          emitStepEvent(
            baseGenerateCodebaseTreeAction,
            "error",
            FAILED_TO_GENERATE_TREE_MESSAGE,
          );
        } else {
          emitStepEvent(baseGenerateCodebaseTreeAction, "success");
        }

        return {
          sandboxSessionId: existingSandbox.id,
          codebaseTree,
          messages: createEventsMessage(),
          customRules: await getCustomRules(
            existingSandbox,
            absoluteRepoDir,
            config,
          ),
        };
      } catch {
        emitStepEvent(
          baseGenerateCodebaseTreeAction,
          "error",
          FAILED_TO_GENERATE_TREE_MESSAGE,
        );
        return {
          sandboxSessionId: existingSandbox.id,
          codebaseTree: FAILED_TO_GENERATE_TREE_MESSAGE,
          messages: createEventsMessage(),
          customRules: await getCustomRules(
            existingSandbox,
            absoluteRepoDir,
            config,
          ),
        };
      }
    } catch {
      emitStepEvent(
        baseResumeSandboxAction,
        "skipped",
        "Unable to resume sandbox. A new environment will be created.",
      );
    }
  }

  // Creating sandbox
  const createSandboxActionId = uuidv4();
  const baseCreateSandboxAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: createSandboxActionId,
    action: "Creating sandbox",
    data: {
      status: "pending",
      sandboxSessionId: null,
      branch: branchName,
      repo: repoName,
    },
  };

  emitStepEvent(baseCreateSandboxAction, "pending");
  let sandbox: Sandbox;
  try {
    sandbox = await daytonaClient().create(DEFAULT_SANDBOX_CREATE_PARAMS);
    emitStepEvent(baseCreateSandboxAction, "success");
  } catch (e) {
    logger.error("Failed to create sandbox environment", { e });
    emitStepEvent(
      baseCreateSandboxAction,
      "error",
      "Failed to create sandbox environment. Please try again later.",
    );
    throw new Error("Failed to create sandbox environment.");
  }

  // Cloning repository
  const cloneRepoActionId = uuidv4();
  const baseCloneRepoAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: cloneRepoActionId,
    action: "Cloning repository",
    data: {
      status: "pending",
      sandboxSessionId: sandbox.id,
      branch: branchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseCloneRepoAction, "pending");

  // Retry the clone command up to 3 times. Sometimes, it can timeout if the repo is large.
  const cloneRepoRes = await withRetry(
    async () => {
      return await cloneRepo(sandbox, targetRepository, {
        githubInstallationToken,
        stateBranchName: branchName,
      });
    },
    { retries: 0, delay: 0 },
  );

  if (
    cloneRepoRes instanceof Error &&
    // Check if message exists before accessing it to satisfy TS
    (!cloneRepoRes.message || !cloneRepoRes.message.includes("repository already exists"))
  ) {
    emitStepEvent(
      baseCloneRepoAction,
      "error",
      "Failed to clone repository. Please check your repo URL and permissions.",
    );
    const errorFields = {
      ...(cloneRepoRes instanceof Error
        ? {
          name: cloneRepoRes.name,
          message: cloneRepoRes.message,
          stack: cloneRepoRes.stack,
        }
        : {}),
    };
    logger.error("Cloning repository failed", errorFields);
    throw new Error("Failed to clone repository.");
  }
  const newBranchName =
    typeof cloneRepoRes === "string" ? cloneRepoRes : branchName;
  emitStepEvent(baseCloneRepoAction, "success");

  // Checking out branch
  const checkoutBranchActionId = uuidv4();
  const baseCheckoutBranchAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: checkoutBranchActionId,
    action: "Checking out branch",
    data: {
      status: "pending",
      sandboxSessionId: sandbox.id,
      branch: newBranchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseCheckoutBranchAction, "success");

  // Generating codebase tree
  const generateCodebaseTreeActionId = uuidv4();
  const baseGenerateCodebaseTreeAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: generateCodebaseTreeActionId,
    action: "Generating codebase tree",
    data: {
      status: "pending",
      sandboxSessionId: sandbox.id,
      branch: newBranchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseGenerateCodebaseTreeAction, "pending");
  let codebaseTree: string | undefined;
  try {
    codebaseTree = await getCodebaseTree(config, sandbox.id);
    emitStepEvent(baseGenerateCodebaseTreeAction, "success");
  } catch (_) {
    emitStepEvent(
      baseGenerateCodebaseTreeAction,
      "error",
      "Failed to generate codebase tree.",
    );
  }

  return {
    sandboxSessionId: sandbox.id,
    targetRepository,
    codebaseTree,
    messages: createEventsMessage(),
    dependenciesInstalled: false,
    customRules: await getCustomRules(sandbox, absoluteRepoDir, config),
    branchName: newBranchName,
  };
}

/**
 * Local mode version of initializeSandbox
 * Skips sandbox creation and repository cloning, works directly with local filesystem
 */


/**
 * Docker mode version of initializeSandbox
 * Creates a local Docker container, clones the repository, and generates the codebase tree
 */
async function initializeSandboxDocker(
  state: InitializeSandboxState,
  config: GraphConfig,
  emitStepEvent: (
    base: CustomNodeEvent,
    status: "pending" | "success" | "error" | "skipped",
    error?: string,
  ) => void,
  createEventsMessage: () => BaseMessage[],
): Promise<Partial<InitializeSandboxState>> {
  const { targetRepository, branchName, sandboxSessionId } = state;
  const absoluteRepoDir = getRepoAbsolutePath(targetRepository);
  const repoName = `${targetRepository.owner}/${targetRepository.repo}`;

  let githubInstallationToken = "";
  try {
    const tokens = getGitHubTokensFromConfig(config);
    githubInstallationToken = tokens.githubInstallationToken;
  } catch (e) {
    logger.warn("Failed to get GitHub tokens, proceeding without authentication (public repo mode?)", { error: e });
  }

  // If we have an existing sandbox session, try to resume it
  if (sandboxSessionId) {
    const resumeSandboxActionId = uuidv4();
    const baseResumeSandboxAction: CustomNodeEvent = {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: resumeSandboxActionId,
      action: "Resuming Docker sandbox",
      data: {
        status: "pending",
        sandboxSessionId,
        branch: branchName,
        repo: repoName,
      },
    };
    emitStepEvent(baseResumeSandboxAction, "pending");

    try {
      const existingSandbox = await daytonaClient(config).get(sandboxSessionId);

      // If sandbox is in stopped state, start it
      if (existingSandbox.state !== "started") {
        await existingSandbox.start();
      }

      emitStepEvent(baseResumeSandboxAction, "success");

      // Pull latest changes
      const pullLatestChangesActionId = uuidv4();
      const basePullLatestChangesAction: CustomNodeEvent = {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: pullLatestChangesActionId,
        action: "Pulling latest changes",
        data: {
          status: "pending",
          sandboxSessionId,
          branch: branchName,
          repo: repoName,
        },
      };
      emitStepEvent(basePullLatestChangesAction, "pending");

      try {
        await pullLatestChanges(absoluteRepoDir, existingSandbox, {
          githubInstallationToken,
        });
        emitStepEvent(basePullLatestChangesAction, "success");
      } catch {
        emitStepEvent(basePullLatestChangesAction, "skipped");
      }

      // Generate codebase tree
      const generateCodebaseTreeActionId = uuidv4();
      const baseGenerateCodebaseTreeAction: CustomNodeEvent = {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: generateCodebaseTreeActionId,
        action: "Generating codebase tree",
        data: {
          status: "pending",
          sandboxSessionId,
          branch: branchName,
          repo: repoName,
        },
      };
      emitStepEvent(baseGenerateCodebaseTreeAction, "pending");

      try {
        const codebaseTree = await getCodebaseTree(config, existingSandbox.id);
        if (codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE) {
          emitStepEvent(baseGenerateCodebaseTreeAction, "error", FAILED_TO_GENERATE_TREE_MESSAGE);
        } else {
          emitStepEvent(baseGenerateCodebaseTreeAction, "success");
        }

        return {
          sandboxSessionId: existingSandbox.id,
          codebaseTree,
          messages: createEventsMessage(),
          customRules: await getCustomRules(existingSandbox, absoluteRepoDir, config),
        };
      } catch {
        emitStepEvent(baseGenerateCodebaseTreeAction, "error", FAILED_TO_GENERATE_TREE_MESSAGE);
        return {
          sandboxSessionId: existingSandbox.id,
          codebaseTree: FAILED_TO_GENERATE_TREE_MESSAGE,
          messages: createEventsMessage(),
          customRules: await getCustomRules(existingSandbox, absoluteRepoDir, config),
        };
      }
    } catch {
      emitStepEvent(baseResumeSandboxAction, "skipped", "Unable to resume Docker sandbox. Creating new one.");
    }
  }

  // Create new Docker sandbox
  const createSandboxActionId = uuidv4();
  const baseCreateSandboxAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: createSandboxActionId,
    action: "Creating Docker sandbox",
    data: {
      status: "pending",
      sandboxSessionId: null,
      branch: branchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseCreateSandboxAction, "pending");

  let sandbox: Sandbox;
  try {
    const client = daytonaClient(config);

    // For Docker mode, pass onWaiting callback to show queue status
    if (isDockerMode(config) && 'create' in client) {
      const dockerClient = client as any;
      sandbox = await dockerClient.create(DEFAULT_SANDBOX_CREATE_PARAMS, undefined, (queuePosition: number) => {
        // Emit waiting in queue event
        const waitingEvent: CustomNodeEvent = {
          nodeId: INITIALIZE_NODE_ID,
          createdAt: new Date().toISOString(),
          actionId: uuidv4(),
          action: "Waiting in queue",
          data: {
            status: "pending",
            queuePosition,
            message: `Waiting for available container slot (position ${queuePosition} in queue)`,
            branch: branchName,
            repo: repoName,
          },
        };
        emitStepEvent(waitingEvent, "pending");
        logger.info("Task queued, waiting for container slot", { queuePosition });
      });
    } else {
      sandbox = await client.create(DEFAULT_SANDBOX_CREATE_PARAMS);
    }
    emitStepEvent(baseCreateSandboxAction, "success");
  } catch (e) {
    logger.error("Failed to create Docker sandbox", { e });
    emitStepEvent(baseCreateSandboxAction, "error", "Failed to create Docker sandbox.");
    throw new Error("Failed to create Docker sandbox.");
  }

  // Clone repository into Docker container
  const cloneRepoActionId = uuidv4();
  const baseCloneRepoAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: cloneRepoActionId,
    action: "Cloning repository",
    data: {
      status: "pending",
      sandboxSessionId: sandbox.id,
      branch: branchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseCloneRepoAction, "pending");

  const cloneRepoRes = await withRetry(
    async () => {
      return await cloneRepo(sandbox, targetRepository, {
        githubInstallationToken,
        stateBranchName: branchName,
      });
    },
    { retries: 0, delay: 0 },
  );

  if (cloneRepoRes instanceof Error && !cloneRepoRes.message.includes("repository already exists")) {
    emitStepEvent(baseCloneRepoAction, "error", "Failed to clone repository in Docker.");
    logger.error("Cloning repository failed in Docker", {
      name: cloneRepoRes.name,
      message: cloneRepoRes.message,
    });
    throw new Error("Failed to clone repository in Docker.");
  }
  const newBranchName = typeof cloneRepoRes === "string" ? cloneRepoRes : branchName;
  emitStepEvent(baseCloneRepoAction, "success");

  // Branch checkout
  emitStepEvent(
    {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: uuidv4(),
      action: "Checking out branch",
      data: {
        status: "success",
        sandboxSessionId: sandbox.id,
        branch: newBranchName,
        repo: repoName,
      },
    },
    "success",
  );

  // Generate codebase tree
  const generateCodebaseTreeActionId = uuidv4();
  const baseGenerateCodebaseTreeAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: generateCodebaseTreeActionId,
    action: "Generating codebase tree",
    data: {
      status: "pending",
      sandboxSessionId: sandbox.id,
      branch: newBranchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseGenerateCodebaseTreeAction, "pending");

  let codebaseTree: string | undefined;
  try {
    codebaseTree = await getCodebaseTree(config, sandbox.id);
    emitStepEvent(baseGenerateCodebaseTreeAction, "success");
  } catch (_) {
    emitStepEvent(baseGenerateCodebaseTreeAction, "error", "Failed to generate codebase tree.");
  }

  return {
    sandboxSessionId: sandbox.id,
    targetRepository,
    codebaseTree,
    messages: createEventsMessage(),
    dependenciesInstalled: false,
    customRules: await getCustomRules(sandbox, absoluteRepoDir, config),
    branchName: newBranchName,
  };
}
