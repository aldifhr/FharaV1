"use client";

import { Component, type ReactNode } from "react";

/**
 * Keeps one shell widget from taking the whole workspace down when its
 * query fails (e.g. a deployment that does not have the function yet).
 */
export default class QueryBoundary extends Component<
  { fallback?: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[shell] widget query failed:", error);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
