
import { tool } from "@langchain/core/tools";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSandboxSessionOrThrow } from "../utils/get-sandbox-id.js";
import { createViewToolFields } from "@openswe/shared/open-swe/tools";
import { handleViewCommand } from "./handlers.js";


const logger = createLogger(LogLevel.INFO, "ViewTool");

export function createViewTool(
  state: Pick<GraphState, "sandboxSessionId" | "targetRepository">,
  config: GraphConfig,
) {
  const viewTool = tool(
    async (input): Promise<{ result: string; status: "success" | "error" }> => {
      try {
        const { command, path, view_range } = input as any;
        if (command !== "view") {
          throw new Error(`Unknown command: ${command}`);
        }

        const workDir = getRepoAbsolutePath(state.targetRepository);

        let result: string;
        // Sandbox mode: use existing handler
        const sandbox = await getSandboxSessionOrThrow(input);
        result = await handleViewCommand(sandbox, config, {
          path,
          workDir,
          viewRange: view_range as [number, number] | undefined,
        });

        logger.info(`View command executed successfully on ${path}`);
        return { result, status: "success" };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`View command failed: ${errorMessage}`);
        return {
          result: `Error: ${errorMessage}`,
          status: "error",
        };
      }
    },
    createViewToolFields(state.targetRepository),
  );

  return viewTool;
}
