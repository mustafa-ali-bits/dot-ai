import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export interface QueueStatusResponse {
    activeCount: number;
    waitingCount: number;
    maxConcurrent: number;
    threadPosition?: number;
    status: "running" | "waiting" | "not_found";
}

/**
 * GET /api/queue/status?threadId=xxx
 * Returns queue status and position for a thread
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const threadId = searchParams.get("threadId");

    // In production, this would call the LangGraph agent API to get queue status
    // For now, return mock data since the queue runs on the agent server
    const langgraphUrl = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";

    try {
        // Try to fetch queue status from the agent
        const response = await fetch(`${langgraphUrl}/queue/status?threadId=${threadId || ""}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
        });

        if (response.ok) {
            const data = await response.json();
            return NextResponse.json(data);
        }

        // Fallback: return default status if agent endpoint not available
        return NextResponse.json({
            activeCount: 0,
            waitingCount: 0,
            maxConcurrent: 2,
            status: "not_found",
        } as QueueStatusResponse);
    } catch (error) {
        // Agent not reachable or endpoint not implemented yet
        return NextResponse.json({
            activeCount: 0,
            waitingCount: 0,
            maxConcurrent: 2,
            status: "not_found",
        } as QueueStatusResponse);
    }
}
