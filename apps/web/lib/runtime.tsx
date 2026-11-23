import { FharaRuntimeProvider, FharaRuntimeReactClient } from "@fhara/runtime/react";
import { useState } from "react";
import { publicFharaRuntimeUrl } from "./env.client";

export default function FharaRuntimeClientProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const url = publicFharaRuntimeUrl();
    if (!url) throw new Error("FHARA_BACKEND_URL missing — copy .env.example to .env");
    return new FharaRuntimeReactClient(url);
  });
  return <FharaRuntimeProvider client={client}>{children}</FharaRuntimeProvider>;
}

