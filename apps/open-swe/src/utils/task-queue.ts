import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "TaskQueueManager");

export type QueueEntryStatus = "waiting" | "running" | "completed" | "timeout" | "error";

export interface QueueEntry {
    id: string;
    threadId: string;
    sandboxId?: string;
    status: QueueEntryStatus;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    lastActivityAt: string;
}

export interface QueueState {
    entries: QueueEntry[];
    maxConcurrent: number;
    taskTimeoutMs: number;
    idleTimeoutMs: number;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TASK_TIMEOUT_MINUTES = 30;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;

export class TaskQueueManager {
    private queueFilePath: string;
    private state: QueueState;
    private idleTimers: Map<string, NodeJS.Timeout> = new Map();
    private taskTimers: Map<string, NodeJS.Timeout> = new Map();
    private onContainerCleanup?: (sandboxId: string) => Promise<void>;

    constructor(
        baseDir: string = ".langgraph_api",
        onContainerCleanup?: (sandboxId: string) => Promise<void>
    ) {
        this.queueFilePath = path.join(baseDir, "task-queue.json");
        this.onContainerCleanup = onContainerCleanup;

        const maxConcurrent = parseInt(
            process.env.OPEN_SWE_MAX_CONCURRENT_CONTAINERS || String(DEFAULT_MAX_CONCURRENT),
            10
        );
        const taskTimeoutMs =
            parseInt(process.env.OPEN_SWE_TASK_TIMEOUT_MINUTES || String(DEFAULT_TASK_TIMEOUT_MINUTES), 10) *
            60 *
            1000;
        const idleTimeoutMs =
            parseInt(process.env.OPEN_SWE_IDLE_TIMEOUT_MINUTES || String(DEFAULT_IDLE_TIMEOUT_MINUTES), 10) *
            60 *
            1000;

        this.state = {
            entries: [],
            maxConcurrent,
            taskTimeoutMs,
            idleTimeoutMs,
        };

        this.loadState();
        this.recoverOnStartup();
    }

    private loadState(): void {
        try {
            if (fs.existsSync(this.queueFilePath)) {
                const data = fs.readFileSync(this.queueFilePath, "utf-8");
                const loaded = JSON.parse(data) as QueueState;
                this.state.entries = loaded.entries || [];
                logger.info("Loaded queue state", { entryCount: this.state.entries.length });
            }
        } catch (error) {
            logger.error("Failed to load queue state, starting fresh", { error });
            this.state.entries = [];
        }
    }

    private saveState(): void {
        try {
            const dir = path.dirname(this.queueFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.queueFilePath, JSON.stringify(this.state, null, 2));
        } catch (error) {
            logger.error("Failed to save queue state", { error });
        }
    }

    private recoverOnStartup(): void {
        // Mark any "running" entries as "waiting" on startup (server crash recovery)
        let modified = false;
        for (const entry of this.state.entries) {
            if (entry.status === "running") {
                entry.status = "waiting";
                entry.startedAt = undefined;
                modified = true;
                logger.info("Recovered running entry to waiting", { threadId: entry.threadId });
            }
        }
        if (modified) {
            this.saveState();
        }
    }

    public getMaxConcurrent(): number {
        return this.state.maxConcurrent;
    }

    public getActiveCount(): number {
        return this.state.entries.filter((e) => e.status === "running").length;
    }

    public getWaitingCount(): number {
        return this.state.entries.filter((e) => e.status === "waiting").length;
    }

    public getQueuePosition(threadId: string): number {
        const waitingEntries = this.state.entries.filter((e) => e.status === "waiting");
        const index = waitingEntries.findIndex((e) => e.threadId === threadId);
        return index >= 0 ? index + 1 : -1;
    }

    public getEntry(threadId: string): QueueEntry | undefined {
        return this.state.entries.find((e) => e.threadId === threadId);
    }

    public async enqueue(threadId: string): Promise<QueueEntry> {
        // Check if already in queue
        const existing = this.getEntry(threadId);
        if (existing) {
            logger.info("Thread already in queue", { threadId, status: existing.status });
            return existing;
        }

        const entry: QueueEntry = {
            id: uuidv4(),
            threadId,
            status: "waiting",
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
        };

        this.state.entries.push(entry);
        this.saveState();
        logger.info("Enqueued thread", { threadId, position: this.getQueuePosition(threadId) });
        return entry;
    }

    public canAcquire(): boolean {
        return this.getActiveCount() < this.state.maxConcurrent;
    }

    public async acquire(threadId: string, sandboxId: string): Promise<boolean> {
        const entry = this.getEntry(threadId);
        if (!entry) {
            logger.warn("Cannot acquire - thread not in queue", { threadId });
            return false;
        }

        if (entry.status === "running") {
            logger.info("Thread already running", { threadId });
            return true;
        }

        if (!this.canAcquire()) {
            logger.info("Cannot acquire - max concurrent reached", {
                threadId,
                active: this.getActiveCount(),
                max: this.state.maxConcurrent,
            });
            return false;
        }

        entry.status = "running";
        entry.sandboxId = sandboxId;
        entry.startedAt = new Date().toISOString();
        entry.lastActivityAt = new Date().toISOString();
        this.saveState();

        // Start task timeout timer
        this.startTaskTimer(threadId);

        logger.info("Acquired slot for thread", { threadId, sandboxId });
        return true;
    }

    public updateActivity(threadId: string): void {
        const entry = this.getEntry(threadId);
        if (entry && entry.status === "running") {
            entry.lastActivityAt = new Date().toISOString();
            this.saveState();

            // Reset idle timer
            this.resetIdleTimer(threadId);
        }
    }

    public async release(
        threadId: string,
        status: "completed" | "error" | "timeout" = "completed"
    ): Promise<void> {
        const entry = this.getEntry(threadId);
        if (!entry) {
            logger.warn("Cannot release - thread not in queue", { threadId });
            return;
        }

        // Clear timers
        this.clearTimers(threadId);

        const sandboxId = entry.sandboxId;
        entry.status = status;
        entry.completedAt = new Date().toISOString();

        // Remove from queue after completion
        this.state.entries = this.state.entries.filter((e) => e.threadId !== threadId);
        this.saveState();

        logger.info("Released thread", { threadId, status, sandboxId });

        // Cleanup container immediately on completion
        if (sandboxId && this.onContainerCleanup) {
            try {
                await this.onContainerCleanup(sandboxId);
                logger.info("Container cleaned up on release", { sandboxId });
            } catch (error) {
                logger.error("Failed to cleanup container on release", { sandboxId, error });
            }
        }

        // Process next in queue
        this.processQueue();
    }

    private startTaskTimer(threadId: string): void {
        this.clearTaskTimer(threadId);

        const timer = setTimeout(async () => {
            logger.warn("Task timeout reached", { threadId });
            await this.release(threadId, "timeout");
        }, this.state.taskTimeoutMs);

        this.taskTimers.set(threadId, timer);
    }

    private startIdleTimer(threadId: string): void {
        this.clearIdleTimer(threadId);

        const timer = setTimeout(async () => {
            logger.warn("Idle timeout reached", { threadId });
            await this.release(threadId, "timeout");
        }, this.state.idleTimeoutMs);

        this.idleTimers.set(threadId, timer);
    }

    private resetIdleTimer(threadId: string): void {
        this.startIdleTimer(threadId);
    }

    private clearTaskTimer(threadId: string): void {
        const timer = this.taskTimers.get(threadId);
        if (timer) {
            clearTimeout(timer);
            this.taskTimers.delete(threadId);
        }
    }

    private clearIdleTimer(threadId: string): void {
        const timer = this.idleTimers.get(threadId);
        if (timer) {
            clearTimeout(timer);
            this.idleTimers.delete(threadId);
        }
    }

    private clearTimers(threadId: string): void {
        this.clearTaskTimer(threadId);
        this.clearIdleTimer(threadId);
    }

    private processQueue(): void {
        // This would trigger waiting entries to try to acquire
        // In practice, this is called externally when sandbox creation is retried
        const waiting = this.state.entries.filter((e) => e.status === "waiting");
        if (waiting.length > 0 && this.canAcquire()) {
            logger.info("Queue slot available", {
                waiting: waiting.length,
                canAcquire: this.canAcquire(),
            });
        }
    }

    public getQueueStatus(): {
        activeCount: number;
        waitingCount: number;
        maxConcurrent: number;
        entries: QueueEntry[];
    } {
        return {
            activeCount: this.getActiveCount(),
            waitingCount: this.getWaitingCount(),
            maxConcurrent: this.state.maxConcurrent,
            entries: [...this.state.entries],
        };
    }
}

// Singleton instance
let queueManagerInstance: TaskQueueManager | null = null;

export function getTaskQueueManager(
    onContainerCleanup?: (sandboxId: string) => Promise<void>
): TaskQueueManager {
    if (!queueManagerInstance) {
        queueManagerInstance = new TaskQueueManager(".langgraph_api", onContainerCleanup);
    }
    return queueManagerInstance;
}
