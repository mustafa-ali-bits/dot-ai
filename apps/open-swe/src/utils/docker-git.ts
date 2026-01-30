import type { DockerSandbox } from "./docker-sandbox.js";
import { ExecuteResponse } from "@daytonaio/sdk/src/types/ExecuteResponse.js";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "DockerGit");

export class DockerGit {
    private sandbox: DockerSandbox;

    constructor(sandbox: DockerSandbox) {
        this.sandbox = sandbox;
    }

    async clone(
        url: string,
        path: string,
        branch?: string,
        commit?: string,
        _username?: string,
        _password?: string
    ): Promise<ExecuteResponse> {
        const cmdParts = ["git", "clone"];
        if (branch) {
            cmdParts.push("-b", branch);
        }

        // Inject credentials into URL if provided
        let cloneUrl = url;
        if (_username && _password) {
            // Insert credentials: https://user:pass@github.com/...
            const urlObj = new URL(url);
            urlObj.username = _username;
            urlObj.password = _password;
            cloneUrl = urlObj.toString();
        }

        cmdParts.push(cloneUrl, path);
        const command = cmdParts.join(" ");

        // Mask password in logs
        logger.info(`Cloning repo`, { url, path, branch, commit });

        const res = await this.sandbox.process.executeCommand(command, undefined, undefined, 300); // 5 min timeout for clone

        if (res.exitCode === 0 && commit) {
            // Checkout specific commit if requested and not just a branch
            // (Daytona clone signature implies commit might be used)
            await this.sandbox.process.executeCommand(`git checkout ${commit}`, path);
        }

        return res;
    }

    async pull(
        path: string,
        _username?: string,
        _password?: string
    ): Promise<ExecuteResponse> {
        // For pulling, we might need to configure credential helper or use URL with token again.
        // Safer to set up git config credential helper store temporarily or just passed token in URL.
        // But `git pull` usually uses remote URL. If remote has token, it's fine.
        // If not, we need to update remote or use `git pull <url_with_token>`.

        // Assuming path is a git repo.
        // We can try to just pull. If it fails, we might need to update remote url.

        return await this.sandbox.process.executeCommand("git pull", path);
    }

    async push(
        path: string,
        _username?: string,
        token?: string
    ): Promise<ExecuteResponse> {
        // Similar to pull.
        // If we use token, we might need to push to specific URL.
        // git push https://user:token@github.com/owner/repo.git HEAD

        // But we need the remote URL first.
        // Simplified implementation:
        // If token provided, construct remote URL.

        // Get remote url
        const remoteRes = await this.sandbox.process.executeCommand("git remote get-url origin", path);
        let remoteUrl = remoteRes.result.trim();

        if (_username && token && remoteUrl.startsWith("https://")) {
            const urlObj = new URL(remoteUrl);
            urlObj.username = _username;
            urlObj.password = token;
            const authUrl = urlObj.toString();
            return await this.sandbox.process.executeCommand(`git push ${authUrl}`, path);
        }

        return await this.sandbox.process.executeCommand("git push", path);
    }

    async status(path: string): Promise<string> {
        const res = await this.sandbox.process.executeCommand("git status --porcelain", path);
        return res.result;
    }

    async add(path: string, files: string[]): Promise<ExecuteResponse> {
        // files is array of paths.
        // git add file1 file2 ...
        // Need to handle spaces in filenames?
        const filesStr = files.map(f => `"${f}"`).join(" ");
        return await this.sandbox.process.executeCommand(`git add ${filesStr}`, path);
    }

    async commit(
        path: string,
        message: string,
        author: string,
        email: string
    ): Promise<ExecuteResponse> {
        const setConfig = `git config user.name "${author}" && git config user.email "${email}"`;
        await this.sandbox.process.executeCommand(setConfig, path);

        return await this.sandbox.process.executeCommand(`git commit -m "${message}"`, path);
    }

    async createBranch(path: string, branch: string): Promise<ExecuteResponse> {
        return await this.sandbox.process.executeCommand(`git checkout -b ${branch}`, path);
    }
}
