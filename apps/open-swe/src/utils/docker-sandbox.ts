import Docker from "dockerode";
import { ExecuteResponse } from "@daytonaio/sdk/src/types/ExecuteResponse.js";
import { DockerGit } from "./docker-git.js";
import { DOCKER_IMAGE_NAME, DOCKER_SANDBOX_USER } from "@openswe/shared/constants";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "DockerSandbox");

export interface DockerSandbox {
    id: string;
    state: "started" | "stopped" | "paused" | "restarting" | "removing" | "dead" | "created" | "exited";
    git: DockerGit;
    process: {
        executeCommand(
            command: string,
            workdir?: string,
            env?: Record<string, string>,
            timeout?: number
        ): Promise<ExecuteResponse>;
    };
    start(): Promise<void>;
    waitUntilReady?(): Promise<void>;
}

export class DockerSandboxImpl implements DockerSandbox {
    public id: string;
    public state: "started" | "stopped" | "paused" | "restarting" | "removing" | "dead" | "created" | "exited";
    public git: DockerGit;
    private container: Docker.Container;

    constructor(container: Docker.Container, state: string) {
        this.id = container.id;
        this.container = container;
        this.state = this.mapState(state);
        this.git = new DockerGit(this);
    }

    private mapState(dockerState: string): DockerSandbox["state"] {
        if (dockerState === "running") return "started";
        return dockerState as DockerSandbox["state"];
    }

    public process = {
        executeCommand: async (
            command: string,
            workdir: string = `/home/${DOCKER_SANDBOX_USER}`,
            env: Record<string, string> = {},
            timeout: number = 60
        ): Promise<ExecuteResponse> => {
            try {
                const cmdArray = ["/bin/bash", "-c", command];

                const exec = await this.container.exec({
                    Cmd: cmdArray,
                    WorkingDir: workdir,
                    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
                    AttachStdout: true,
                    AttachStderr: true,
                    User: DOCKER_SANDBOX_USER,
                });

                const stream = await exec.start({ Detach: false, Tty: false });

                let output = "";

                // dockerode stream handling
                // We need to demultiplex stdout and stderr if Tty is false, but dockerode demux is complex.
                // For simplicity, we'll collect all output. 
                // Note: dockerode.modem.demuxStream works if we pass streams.

                // A simpler approach for short commands:
                await new Promise((resolve, reject) => {
                    let timeoutId: NodeJS.Timeout | undefined;

                    if (timeout > 0) {
                        timeoutId = setTimeout(() => {
                            // We can't easily kill the exec process via API without killing container
                            // But we can timeout the listener
                            stream.destroy();
                            reject(new Error(`Command timed out after ${timeout}s`));
                        }, timeout * 1000);
                    }

                    this.container.modem.demuxStream(
                        stream,
                        {
                            write: (chunk: Buffer) => { output += chunk.toString(); }
                        } as any,
                        {
                            write: (chunk: Buffer) => { output += chunk.toString(); }
                        } as any
                    );

                    stream.on('end', () => {
                        if (timeoutId) clearTimeout(timeoutId);
                        resolve(null);
                    });
                });

                const inspect = await exec.inspect();
                const exitCode = inspect.ExitCode ?? 1;

                return {
                    exitCode,
                    result: output,
                    // Daytona types might require artifacts, but we map result primarily
                } as unknown as ExecuteResponse;

            } catch (error: any) {
                logger.error("Error executing command in Docker", { error, command });
                return {
                    exitCode: 1,
                    result: `Error executing command: ${error.message}`,
                } as unknown as ExecuteResponse;
            }
        }
    };

    public async start(): Promise<void> {
        await this.container.start();
        this.state = "started";
    }
}

export class DockerSandboxPool {
    private maxConcurrent: number;
    private activeContainerIds: Set<string> = new Set();
    private queue: Array<{ resolve: (value: DockerSandbox) => void; reject: (reason?: any) => void; factory: () => Promise<DockerSandbox> }> = [];

    constructor() {
        this.maxConcurrent = parseInt(
            process.env.OPEN_SWE_MAX_CONCURRENT_CONTAINERS || "2",
            10
        );
        logger.info("DockerSandboxPool initialized", { maxConcurrent: this.maxConcurrent });
    }

    public getMaxConcurrent(): number {
        return this.maxConcurrent;
    }

    public getActiveCount(): number {
        return this.activeContainerIds.size;
    }

    public getQueueLength(): number {
        return this.queue.length;
    }

    public canAcquire(): boolean {
        return this.activeContainerIds.size < this.maxConcurrent;
    }

    public async acquireWithFactory(
        factory: () => Promise<DockerSandbox>,
        onWaiting?: (queuePosition: number) => void
    ): Promise<DockerSandbox> {
        if (this.canAcquire()) {
            try {
                const sandbox = await factory();
                this.activeContainerIds.add(sandbox.id);
                return sandbox;
            } catch (e) {
                throw e;
            }
        }

        const queuePosition = this.queue.length + 1;
        logger.info("Max concurrent containers reached. Queuing request.", {
            active: this.activeContainerIds.size,
            max: this.maxConcurrent,
            queueLength: this.queue.length,
            queuePosition
        });

        // Notify caller they are waiting in queue
        if (onWaiting) {
            onWaiting(queuePosition);
        }

        return new Promise((resolve, reject) => {
            this.queue.push({ resolve, reject, factory });
        });
    }

    private async processQueue() {
        if (this.queue.length > 0 && this.canAcquire()) {
            const item = this.queue.shift();
            if (item) {
                try {
                    const sandbox = await item.factory();
                    this.activeContainerIds.add(sandbox.id);
                    item.resolve(sandbox);
                } catch (e) {
                    item.reject(e);
                    this.processQueue();
                }
            }
        }
    }

    public notifyStart(id: string) {
        this.activeContainerIds.add(id);
    }

    public releaseSandbox(id: string) {
        this.activeContainerIds.delete(id);
        logger.info("Sandbox released", { id, active: this.activeContainerIds.size, queueLength: this.queue.length });
        this.processQueue();
    }

    // Backwards compatibility alias
    public releaseSandox(id: string) {
        this.releaseSandbox(id);
    }
}

export class DockerSandboxClient {
    private docker: Docker;
    private pool: DockerSandboxPool;

    constructor() {
        this.docker = new Docker();
        this.pool = new DockerSandboxPool();
    }

    public async create(
        _params: any,
        _options?: any,
        onWaiting?: (queuePosition: number) => void
    ): Promise<DockerSandbox> {
        logger.info("Requesting Docker sandbox creation");

        return this.pool.acquireWithFactory(async () => {
            logger.info("Creating Docker container...");

            // Ensure image exists (pull if needed)
            // const _imageParams = { fromImage: DOCKER_IMAGE_NAME };

            // Check if image exists locally first to speed up
            // For now, let's assume we use a base node image or similar if the custom one isn't built.
            // But better to fail if not found to prompt user to build.

            const container = await this.docker.createContainer({
                Image: DOCKER_IMAGE_NAME,
                Cmd: ["tail", "-f", "/dev/null"], // Keep alive
                Tty: false,
                // Mounts or other configs
                HostConfig: {
                    // AutoRemove: true // Don't auto remove so we can inspect if needed, but maybe better for cleanup
                },
                Labels: {
                    "created_by": "open-swe"
                }
            });

            await container.start();
            logger.info(`Docker container started: ${container.id}`);

            return new DockerSandboxImpl(container, "running");
        }, onWaiting);
    }

    public async get(sandboxId: string): Promise<DockerSandbox> {
        try {
            const container = this.docker.getContainer(sandboxId);
            const inspect = await container.inspect();
            return new DockerSandboxImpl(container, inspect.State.Status);
        } catch (e) {
            throw new Error(`Sandbox ${sandboxId} not found`);
        }
    }

    public async stop(sandbox: DockerSandbox): Promise<void> {
        const container = this.docker.getContainer(sandbox.id);
        await container.stop();
    }

    public async delete(sandbox: DockerSandbox): Promise<void> {
        try {
            const container = this.docker.getContainer(sandbox.id);
            // Force remove
            await container.remove({ force: true });
            this.pool.releaseSandox(sandbox.id);
        } catch (e) {
            logger.error("Error deleting sandbox", { error: e, id: sandbox.id });
            // Release anyway to unblock queue?
            this.pool.releaseSandox(sandbox.id);
        }
    }
}

// Singleton
let instance: DockerSandboxClient | null = null;
export function getDockerSandboxClient(): DockerSandboxClient {
    if (!instance) instance = new DockerSandboxClient();
    return instance;
}
