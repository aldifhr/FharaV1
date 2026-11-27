/** Approval metrics report what actually ran, not one blanket verification status. */
export interface VerificationCheckLike {
  name: string;
  status: string;
}

export function metricForCheck(checks: readonly VerificationCheckLike[] | undefined, name: string): string {
  return checks?.find((check) => check.name === name)?.status ?? "not run";
}

export function verificationMetrics(checks: readonly VerificationCheckLike[] | undefined) {
  return { build: metricForCheck(checks, "build"), tests: metricForCheck(checks, "test") };
}
