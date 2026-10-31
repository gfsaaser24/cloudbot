"use client";

import { type ReactNode, createContext, useContext } from "react";

// Answers a tool's approval request (Firecrawl crawls, agents and the like).
// The chat sends the answer, and the tool runs or is skipped on the server.
type RespondToApproval = (approvalId: string, approved: boolean) => void;

const ToolApprovalContext = createContext<RespondToApproval | undefined>(
  undefined,
);

export const ToolApprovalProvider = ({
  respond,
  children,
}: {
  respond: RespondToApproval;
  children: ReactNode;
}) => (
  <ToolApprovalContext.Provider value={respond}>
    {children}
  </ToolApprovalContext.Provider>
);

export const useToolApproval = (): RespondToApproval => {
  const respond = useContext(ToolApprovalContext);
  if (!respond) {
    throw new Error("useToolApproval must be used within a ToolApprovalProvider");
  }
  return respond;
};
