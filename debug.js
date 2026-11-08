#!/usr/bin/env node
(async () => {
  const command = process.argv.slice(2).join(" ").trim() || 'Buat file hello.html dengan heading "Hello, world!" dan satu paragraf. Validasi struktur HTML.';
  const [{ classifyCommand }, { heuristicPlan, pickOrchestrator }, { validatePlan }, { capabilitiesOf }] = await Promise.all([
    import("./packages/worker/src/orchestrator/classifier.ts"),
    import("./packages/worker/src/orchestrator/planner.ts"),
    import("./packages/worker/src/orchestrator/planValidator.ts"),
    import("./packages/worker/src/orchestrator/capabilities.ts"),
  ]);
  const agents = [
    { _id: "cto", name: "CTO", role: "cto", capabilities: ["architecture", "code-review", "security-audit"] },
    { _id: "frontend", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] },
    { _id: "backend", name: "Backend", role: "backend", capabilities: ["backend-development", "shell-execution"] },
    { _id: "designer", name: "Designer", role: "designer", capabilities: ["ui-ux-design", "frontend-development"] },
    { _id: "qa", name: "QA", role: "qa", capabilities: ["browser-testing", "code-review"] },
  ];
  const classification = classifyCommand(command);
  const plan = heuristicPlan({ command, classification, agents, policy: { reviewMode: "auto", qaMode: "auto" }, hasQaUrl: true });
  const validation = validatePlan(plan, 20);
  const trace = { input: { command }, cto: { selected: pickOrchestrator(agents)?.name, team: agents.map((a) => ({ name: a.name, role: a.role, capabilities: capabilitiesOf(a) })) }, classification, plan, validation, decisions: plan.subtasks.map((s) => ({ task: s.title, kind: s.kind, capability: s.capability, assignedAgent: agents.find((a) => capabilitiesOf(a).includes(s.capability))?.name ?? "unroutable", dependsOn: s.dependencies })) };
  console.log(JSON.stringify({ stage: "local-pipeline", ...trace }, null, 2));

  const baseUrl = process.env.DEBUG_BASE_URL;
  const apiKey = process.env.DEBUG_API_KEY;
  if (!baseUrl || !apiKey) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEBUG_TIMEOUT_MS || 300000));
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: process.env.DEBUG_MODEL || "nous", temperature: 0, max_tokens: 800, messages: [{ role: "system", content: "You are the CTO. Return concise JSON with decision, agents, checks, and rationale." }, { role: "user", content: command }] }) });
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw: raw.slice(0, 12000), note: "Provider returned multiple JSON values or a non-JSON stream." };
    }
    console.log(JSON.stringify({ stage: "provider", status: response.status, model: process.env.DEBUG_MODEL || "nous", response: body.choices?.[0]?.message?.content ?? body.error ?? body }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ stage: "provider", status: "timeout_or_error", error: error instanceof Error ? error.message : String(error) }, null, 2));
  } finally { clearTimeout(timeout); }
})();
