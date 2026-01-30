import { initializeSandbox } from "../graphs/shared/initialize-sandbox.js";
import { GraphConfig, TargetRepository } from "@openswe/shared/open-swe/types";
import { isDockerMode } from "@openswe/shared/open-swe/docker-mode";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "ReproDocker");

async function run() {
    process.env.OPEN_SWE_DOCKER_MODE = "true";
    process.env.OPEN_SWE_LOCAL_MODE = "false";

    const mockConfig: GraphConfig = {
        configurable: {
            thread_id: "mock-thread-id",
            assistant_id: "mock-assistant-id",
            // "x-docker-mode": "true",
            // Add a dummy GitHub token header if needed, though we made it optional
        },
    };

    logger.info("Is Docker Mode?", { isDocker: isDockerMode(mockConfig) });

    const mockState = {
        targetRepository: {
            owner: "facebook",
            repo: "react",
        } as TargetRepository,
        branchName: "main",
        messages: [],
    };

    try {
        logger.info("Calling initializeSandbox...");
        const result = await initializeSandbox(mockState, mockConfig);
        logger.info("initializeSandbox result", result);

        if (result.sandboxSessionId && result.sandboxSessionId.length > 20) {
            console.log("\nSUCCESS: Sandbox session ID generated: " + result.sandboxSessionId);
            console.log("Check 'docker ps' to see active container.");
        } else {
            console.error("\nFAILURE: No valid sandbox session ID returned.");
        }

    } catch (error) {
        logger.error("Error running reproduction script", { error });
    }
}

run();
