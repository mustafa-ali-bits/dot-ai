
import Docker from "dockerode";

async function run() {
    const docker = new Docker();
    const container = docker.getContainer("59b426be6c43");

    console.log("Testing ls command via dockerode...");

    try {
        const cmdArray = ["/bin/bash", "-c", "ls -la /home/daytona"];

        const exec = await container.exec({
            Cmd: cmdArray,
            WorkingDir: "/home/daytona", // Test working dir same as target
            Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
            AttachStdout: true,
            AttachStderr: true,
            User: "node",
        });

        const stream = await exec.start({ Detach: false, Tty: false });

        let output = "";

        container.modem.demuxStream(
            stream,
            { write: (chunk: Buffer) => { output += "STDOUT: " + chunk.toString(); } } as any,
            { write: (chunk: Buffer) => { output += "STDERR: " + chunk.toString(); } } as any
        );

        stream.on('end', () => {
            console.log("Stream ended.");
            console.log("Output Length:", output.length);
            console.log("Captured Output:\n", output);
        });

    } catch (e) {
        console.error("Exec failed:", e);
    }
}

run();
