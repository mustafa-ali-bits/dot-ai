import { GraphConfig } from "@openswe/shared/open-swe/types";
import { DOCKER_MODE_HEADER } from "../constants.js";

/**
 * Checks if the current execution context is in Docker mode
 * (working with local Docker containers instead of Daytona cloud sandbox)
 */
export function isDockerMode(config?: GraphConfig): boolean {
    if (!config) {
        return isDockerModeFromEnv();
    }
    const result = (config.configurable as any)?.[DOCKER_MODE_HEADER] === "true" || isDockerModeFromEnv();
    try {
        const fs = require("fs");
        fs.appendFileSync("debug-docker-mode.log", JSON.stringify({
            timestamp: new Date().toISOString(),
            headerVal: (config.configurable as any)?.[DOCKER_MODE_HEADER],
            envVal: process.env.OPEN_SWE_DOCKER_MODE,
            result
        }) + "\n");
    } catch (e) { }
    return result;
}

/**
 * Checks if we're in Docker mode based on environment variables
 * (useful for contexts where GraphConfig is not available)
 */
export function isDockerModeFromEnv(): boolean {
    return process.env.OPEN_SWE_DOCKER_MODE === "true";
}
