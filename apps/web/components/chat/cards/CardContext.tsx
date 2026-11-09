"use client";

import { createContext, useContext } from "react";

/**
 * What a card needs from the surface it is rendered on (chat timeline or
 * task thread). Every field is optional: a card renders from its own data
 * when the surface has nothing to offer.
 */
export type CardSurface = {
  agents?: any[];
  tasks?: any[];
  subtasksOf?: Map<string, any[]>;
  pendingApprovals?: any[];
  approvalMode?: "ask" | "auto";
  onOpenTask?: (taskId: string) => void;
};

const CardContext = createContext<CardSurface>({});

export const CardSurfaceProvider = CardContext.Provider;

export function useCardSurface(): CardSurface {
  return useContext(CardContext);
}
