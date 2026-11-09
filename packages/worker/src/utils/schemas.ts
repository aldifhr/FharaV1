import { z } from "zod";

export const DraftFileSchema = z.object({
  filePath: z.string().min(1),
  newContent: z.string(),
});

export const DraftSchema = z.object({
  files: z.array(DraftFileSchema),
});

export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  filePath: z.string(),
  description: z.string(),
  suggestion: z.string(),
});

export const ReviewSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  findings: z.array(ReviewFindingSchema),
  snapshotId: z.string().optional(),
});

export const DelegationSchema = z.object({
  delegationRecommendation: z
    .object({
      targetCapability: z.string().min(1),
      reason: z.string(),
      priority: z.enum(["high", "medium", "low"]).optional(),
    })
    .optional(),
  findings: z.array(z.string()).optional(),
});

export const McpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  inputSchema: z.record(z.string(), z.unknown()).optional().default({}),
});

export const McpCallResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z
    .union([
      z.array(
        z.object({
          type: z.string().optional(),
          text: z.union([z.string(), z.unknown()]).optional(),
        })
      ),
      z.string(),
    ])
    .optional(),
});

export const BudgetSnapshotSchema = z.object({
  llmCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative(),
  agents: z.array(z.string()),
  delegationDepth: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  maxLLMCalls: z.number().int().positive(),
  maxTokenBudget: z.number().int().positive(),
  maxAgents: z.number().int().positive(),
});
