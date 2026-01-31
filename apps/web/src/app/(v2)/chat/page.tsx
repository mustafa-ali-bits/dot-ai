"use client";

import { DefaultView } from "@/components/v2/default-view";
import { useThreadsSWR } from "@/hooks/useThreadsSWR";
import { GitHubAppProvider, useGitHubAppProvider } from "@/providers/GitHubApp";
import { Toaster } from "@/components/ui/sonner";
import { Suspense } from "react";
import { MANAGER_GRAPH_ID } from "@openswe/shared/constants";

function ChatPageComponent() {
  const { currentInstallation } = useGitHubAppProvider();
  const isLocalMode = process.env.NEXT_PUBLIC_LOCAL_MODE === "true";
  const { threads, isLoading: threadsLoading } = useThreadsSWR({
    assistantId: MANAGER_GRAPH_ID,
    currentInstallation,
    disableOrgFiltering: isLocalMode, // In local mode, show all threads without org filtering
  });

  if (!threads) {
    return <div>No threads</div>;
  }

  return (
    <div className="bg-background h-screen">
      <Suspense>
        <Toaster />
        <DefaultView
          threads={threads}
          threadsLoading={threadsLoading}
        />
      </Suspense>
    </div>
  );
}

export default function ChatPage() {
  return (
    <GitHubAppProvider>
      <ChatPageComponent />
    </GitHubAppProvider>
  );
}
