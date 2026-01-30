import { tool } from "@langchain/core/tools";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSandboxSessionOrThrow } from "../utils/get-sandbox-id.js";
import { createTextEditorToolFields } from "@openswe/shared/open-swe/tools";
import {
  handleViewCommand,
  handleStrReplaceCommand,
  handleCreateCommand,
  handleInsertCommand,
} from "./handlers.js";


const logger = createLogger(LogLevel.INFO, "TextEditorTool");

export function createTextEditorTool(
  state: Pick<GraphState, "sandboxSessionId" | "targetRepository">,
  config: GraphConfig,
) {
  const textEditorTool = tool(
    async (input): Promise<{ result: string; status: "success" | "error" }> => {
      try {
        const {
          command,
          path,
          view_range,
          old_str,
          new_str,
          file_text,
          insert_line,
        } = input;

        const workDir = getRepoAbsolutePath(state.targetRepository);
        let result: string;

        // Sandbox mode: use existing handler
        const sandbox = await getSandboxSessionOrThrow(input);

        switch (command) {
          case "view":
            result = await handleViewCommand(sandbox, config, {
              path,
              workDir,
              viewRange: view_range,
            });
            break;
          case "str_replace":
            if (!old_str || new_str === undefined) {
              throw new Error(
                "str_replace command requires both old_str and new_str parameters",
              );
            }
            result = await handleStrReplaceCommand(sandbox, config, {
              path,
              workDir,
              oldStr: old_str,
              newStr: new_str,
            });
            break;
          case "create":
            if (!file_text) {
              throw new Error("create command requires file_text parameter");
            }
            result = await handleCreateCommand(sandbox, config, {
              path,
              workDir,
              fileText: file_text,
            });
            break;
          case "insert":
            if (insert_line === undefined || new_str === undefined) {
              throw new Error(
                "insert command requires both insert_line and new_str parameters",
              );
            }
            result = await handleInsertCommand(sandbox, config, {
              path,
              workDir,
              insertLine: insert_line,
              newStr: new_str,
            });
            break;
          default:
            throw new Error(`Unknown command: ${command}`);
        }

        logger.info(
          `Text editor command '${command}' executed successfully on ${path}`,
        );
        return { result, status: "success" };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`Text editor command failed: ${errorMessage}`);
        return {
          result: `Error: ${errorMessage}`,
          status: "error",
        };
      }
    },
    createTextEditorToolFields(state.targetRepository),
  );

  return textEditorTool;
}
