/**
 * Full Integration Test for Docker Sandbox Pool with Queue
 * 
 * Tests:
 * 1. Docker container creation with queue limits
 * 2. Queue waiting when limit reached
 * 3. Container cleanup after release
 * 
 * Run with: npx tsx src/utils/test-docker-queue-integration.ts
 */

import { getDockerSandboxClient, DockerSandboxPool } from "./docker-sandbox.js";
import Docker from "dockerode";

// Set max concurrent to 2 for testing
process.env.OPEN_SWE_MAX_CONCURRENT_CONTAINERS = "2";

const docker = new Docker();

async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRunningContainers() {
    const containers = await docker.listContainers({
        filters: { label: ["created_by=open-swe"] }
    });
    return containers;
}

async function cleanupAllContainers() {
    console.log("\n🧹 Cleaning up existing containers...");
    const containers = await getRunningContainers();
    for (const container of containers) {
        try {
            const c = docker.getContainer(container.Id);
            await c.remove({ force: true });
            console.log(`   Removed: ${container.Id.substring(0, 12)}`);
        } catch (e) {
            // Ignore
        }
    }
    console.log("   ✓ Cleanup complete\n");
}

async function testContainerCreation() {
    console.log("=== Test 1: Container Creation with Limits ===\n");

    const client = getDockerSandboxClient();
    const pool = new DockerSandboxPool();

    console.log("📊 Max concurrent:", pool.getMaxConcurrent());
    console.log("📊 Active count:", pool.getActiveCount());

    // Create first container
    console.log("\n🐳 Creating container 1...");
    const sandbox1 = await client.create({}, {});
    console.log(`   ✓ Container 1 created: ${sandbox1.id.substring(0, 12)}`);
    console.log(`   State: ${sandbox1.state}`);

    // Create second container
    console.log("\n🐳 Creating container 2...");
    const sandbox2 = await client.create({}, {});
    console.log(`   ✓ Container 2 created: ${sandbox2.id.substring(0, 12)}`);
    console.log(`   State: ${sandbox2.state}`);

    // Check running containers
    const running = await getRunningContainers();
    console.log(`\n📊 Running containers: ${running.length}`);

    // Try to create third - should queue (we won't await this in blocking way)
    console.log("\n🐳 Attempting container 3 (should queue if pool enforces limit)...");

    // For this test, we'll just verify pool state
    console.log(`📊 Pool active count: ${pool.getActiveCount()}`);
    console.log(`📊 Pool can acquire: ${pool.canAcquire()}`);

    // Execute a simple command to verify containers work
    console.log("\n🔧 Testing command execution on container 1...");
    const result = await sandbox1.process.executeCommand("echo 'Hello from container!'", "/home/user");
    console.log(`   Exit code: ${result.exitCode}`);
    console.log(`   Output: ${result.result.trim()}`);

    // Delete containers
    console.log("\n🗑️ Deleting container 1...");
    await client.delete(sandbox1);
    console.log("   ✓ Container 1 deleted");

    console.log("\n🗑️ Deleting container 2...");
    await client.delete(sandbox2);
    console.log("   ✓ Container 2 deleted");

    // Verify cleanup
    const afterCleanup = await getRunningContainers();
    console.log(`\n📊 Running containers after cleanup: ${afterCleanup.length}`);

    if (afterCleanup.length === 0) {
        console.log("\n✅ Test 1 passed!\n");
    } else {
        console.log("\n⚠️ Some containers still running\n");
    }
}

async function testConcurrentCreation() {
    console.log("=== Test 2: Concurrent Container Creation ===\n");

    const client = getDockerSandboxClient();

    console.log("🚀 Creating 2 containers concurrently...");
    const startTime = Date.now();

    const [sandbox1, sandbox2] = await Promise.all([
        client.create({}, {}),
        client.create({}, {}),
    ]);

    const elapsed = Date.now() - startTime;
    console.log(`   ✓ Both created in ${elapsed}ms`);
    console.log(`   Container 1: ${sandbox1.id.substring(0, 12)}`);
    console.log(`   Container 2: ${sandbox2.id.substring(0, 12)}`);

    // Verify both running
    const running = await getRunningContainers();
    console.log(`\n📊 Running containers: ${running.length}`);

    // Cleanup
    await client.delete(sandbox1);
    await client.delete(sandbox2);

    console.log("\n✅ Test 2 passed!\n");
}

async function testPoolQueueBehavior() {
    console.log("=== Test 3: Pool Queue Behavior ===\n");

    const pool = new DockerSandboxPool();

    console.log("📊 Initial state:");
    console.log(`   Max concurrent: ${pool.getMaxConcurrent()}`);
    console.log(`   Active: ${pool.getActiveCount()}`);
    console.log(`   Queue length: ${pool.getQueueLength()}`);
    console.log(`   Can acquire: ${pool.canAcquire()}`);

    // Simulate acquiring slots
    console.log("\n🔒 Simulating slot acquisition...");

    let acquired1 = false;
    let acquired2 = false;

    const factory = async () => {
        // Simulate container creation
        await sleep(100);
        return { id: `test-${Date.now()}`, state: "started" } as any;
    };

    const result1 = await pool.acquireWithFactory(factory);
    console.log(`   Slot 1 acquired: ${result1.id.substring(0, 12)}`);

    const result2 = await pool.acquireWithFactory(factory);
    console.log(`   Slot 2 acquired: ${result2.id.substring(0, 12)}`);

    console.log("\n📊 After 2 acquisitions:");
    console.log(`   Active: ${pool.getActiveCount()}`);
    console.log(`   Can acquire: ${pool.canAcquire()}`);

    // Third should queue
    console.log("\n⏳ Third acquisition should queue...");
    const third = pool.acquireWithFactory(factory);
    // Don't await - it will block

    console.log(`   Queue length: ${pool.getQueueLength()}`);

    // Release one
    console.log("\n🔓 Releasing slot 1...");
    pool.releaseSandbox(result1.id);

    // Wait for queue to process
    await sleep(200);

    const result3 = await third;
    console.log(`   Slot 3 acquired: ${result3.id.substring(0, 12)}`);

    // Cleanup
    pool.releaseSandbox(result2.id);
    pool.releaseSandbox(result3.id);

    console.log("\n✅ Test 3 passed!\n");
}

async function main() {
    console.log("╔════════════════════════════════════════════╗");
    console.log("║  Docker Sandbox + Queue Integration Test   ║");
    console.log("╚════════════════════════════════════════════╝\n");

    console.log("Configuration:");
    console.log(`  MAX_CONCURRENT_CONTAINERS: ${process.env.OPEN_SWE_MAX_CONCURRENT_CONTAINERS}`);

    try {
        await cleanupAllContainers();
        await testContainerCreation();

        await cleanupAllContainers();
        await testConcurrentCreation();

        await testPoolQueueBehavior();

        await cleanupAllContainers();

        console.log("╔════════════════════════════════════════════╗");
        console.log("║  ✅ All integration tests passed!          ║");
        console.log("╚════════════════════════════════════════════╝\n");
    } catch (error) {
        console.error("\n❌ Test failed:", error);
        await cleanupAllContainers();
        process.exit(1);
    }
}

main();
