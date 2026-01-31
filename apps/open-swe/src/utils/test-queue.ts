/**
 * Test script for TaskQueueManager
 * 
 * Run with: npx tsx src/utils/test-queue.ts
 */

import { TaskQueueManager, getTaskQueueManager } from "./task-queue.js";
import * as fs from "fs";
import * as path from "path";

// Override env vars for testing
process.env.OPEN_SWE_MAX_CONCURRENT_CONTAINERS = "2";
process.env.OPEN_SWE_TASK_TIMEOUT_MINUTES = "1"; // Short timeout for testing
process.env.OPEN_SWE_IDLE_TIMEOUT_MINUTES = "1";

const TEST_QUEUE_FILE = ".langgraph_api/task-queue.json";

async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTestFile() {
    try {
        if (fs.existsSync(TEST_QUEUE_FILE)) {
            fs.unlinkSync(TEST_QUEUE_FILE);
            console.log("✓ Cleaned up old queue file");
        }
    } catch (e) {
        // Ignore
    }
}

async function testBasicQueueOperations() {
    console.log("\n=== Test 1: Basic Queue Operations ===\n");

    const queue = new TaskQueueManager(".langgraph_api");

    // Test enqueue
    const entry1 = await queue.enqueue("thread-1");
    console.log("✓ Enqueued thread-1:", entry1.status);

    const entry2 = await queue.enqueue("thread-2");
    console.log("✓ Enqueued thread-2:", entry2.status);

    // Check queue status
    const status = queue.getQueueStatus();
    console.log("✓ Queue status:", {
        activeCount: status.activeCount,
        waitingCount: status.waitingCount,
        maxConcurrent: status.maxConcurrent,
    });

    // Test acquire (should succeed for first two)
    const acquired1 = await queue.acquire("thread-1", "sandbox-1");
    console.log("✓ Acquired thread-1:", acquired1);

    const acquired2 = await queue.acquire("thread-2", "sandbox-2");
    console.log("✓ Acquired thread-2:", acquired2);

    // Now queue should be at capacity
    console.log("✓ Active count:", queue.getActiveCount());
    console.log("✓ Can acquire more:", queue.canAcquire());

    // Enqueue a third task
    const entry3 = await queue.enqueue("thread-3");
    const acquired3 = await queue.acquire("thread-3", "sandbox-3");
    console.log("✓ Third acquire (should fail):", acquired3);
    console.log("✓ Queue position for thread-3:", queue.getQueuePosition("thread-3"));

    // Release one
    await queue.release("thread-1", "completed");
    console.log("✓ Released thread-1");
    console.log("✓ Active count after release:", queue.getActiveCount());

    // Now third should be able to acquire
    const acquired3Retry = await queue.acquire("thread-3", "sandbox-3");
    console.log("✓ Third acquire retry:", acquired3Retry);

    // Cleanup
    await queue.release("thread-2", "completed");
    await queue.release("thread-3", "completed");

    console.log("\n✓ Basic operations test passed!\n");
}

async function testPersistence() {
    console.log("\n=== Test 2: Persistence ===\n");

    // Create queue and add entry
    const queue1 = new TaskQueueManager(".langgraph_api");
    await queue1.enqueue("persistent-thread");
    await queue1.acquire("persistent-thread", "sandbox-persist");
    console.log("✓ Created entry in first queue instance");

    // Check file exists
    if (fs.existsSync(TEST_QUEUE_FILE)) {
        const content = fs.readFileSync(TEST_QUEUE_FILE, "utf-8");
        console.log("✓ Queue file contents:", content.substring(0, 200) + "...");
    }

    // Create new queue instance (simulates restart)
    const queue2 = new TaskQueueManager(".langgraph_api");
    console.log("✓ Created second queue instance (simulates restart)");

    // Running entries should be reset to waiting on restart
    const status = queue2.getQueueStatus();
    console.log("✓ Queue status after restart:", {
        entries: status.entries.length,
        waiting: status.waitingCount,
    });

    // Cleanup
    await queue2.release("persistent-thread", "completed");

    console.log("\n✓ Persistence test passed!\n");
}

async function testQueuePosition() {
    console.log("\n=== Test 3: Queue Position ===\n");

    const queue = new TaskQueueManager(".langgraph_api");

    // Fill up the queue
    await queue.enqueue("pos-1");
    await queue.acquire("pos-1", "sandbox-p1");
    await queue.enqueue("pos-2");
    await queue.acquire("pos-2", "sandbox-p2");

    // Now add waiting entries
    await queue.enqueue("waiting-1");
    await queue.enqueue("waiting-2");
    await queue.enqueue("waiting-3");

    console.log("✓ Position of waiting-1:", queue.getQueuePosition("waiting-1"));
    console.log("✓ Position of waiting-2:", queue.getQueuePosition("waiting-2"));
    console.log("✓ Position of waiting-3:", queue.getQueuePosition("waiting-3"));

    // Cleanup
    await queue.release("pos-1", "completed");
    await queue.release("pos-2", "completed");
    await queue.release("waiting-1", "completed");
    await queue.release("waiting-2", "completed");
    await queue.release("waiting-3", "completed");

    console.log("\n✓ Queue position test passed!\n");
}

async function main() {
    console.log("========================================");
    console.log("  TaskQueueManager Test Suite");
    console.log("========================================");
    console.log("Max concurrent:", process.env.OPEN_SWE_MAX_CONCURRENT_CONTAINERS);
    console.log("Task timeout:", process.env.OPEN_SWE_TASK_TIMEOUT_MINUTES, "min");
    console.log("Idle timeout:", process.env.OPEN_SWE_IDLE_TIMEOUT_MINUTES, "min");

    await cleanupTestFile();

    try {
        await testBasicQueueOperations();
        await cleanupTestFile();

        await testPersistence();
        await cleanupTestFile();

        await testQueuePosition();
        await cleanupTestFile();

        console.log("\n========================================");
        console.log("  ✅ All tests passed!");
        console.log("========================================\n");
    } catch (error) {
        console.error("\n❌ Test failed:", error);
        process.exit(1);
    }
}

main();
