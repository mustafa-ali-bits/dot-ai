import { tool } from "@langchain/core/tools";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../utils/logger.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSandboxSessionOrThrow } from "./utils/get-sandbox-id.js";
import { handleCreateCommand } from "./builtin-tools/handlers.js";
import { z } from "zod";

const logger = createLogger(LogLevel.INFO, "CreateNewFileTool");

export function createCreateNewFileTool(
    state: Pick<GraphState, "sandboxSessionId" | "targetRepository">,
    config: GraphConfig,
) {
    return tool(
        async (input): Promise<string> => {
            try {
                const { path, file_text } = input;
                const workDir = getRepoAbsolutePath(state.targetRepository);

                logger.info(`Creating new file at ${path}`);

                const sandbox = await getSandboxSessionOrThrow({
                    xSandboxSessionId: state.sandboxSessionId
                });

                const result = await handleCreateCommand(sandbox, config, {
                    path,
                    workDir,
                    fileText: file_text,
                });

                return result;

            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                logger.error(`Create new file failed: ${errorMessage}`);
                return `Error: ${errorMessage}`;
            }
        },
        {
            name: "create_new_file",
            description: "Create a new file with the specified content.",
            schema: z.object({
                path: z.string().describe("The path where the new file should be created"),
                file_text: z.string().describe("The content to write to the new file"),
            }),
        },
    );
}
