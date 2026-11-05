"use client";

import { useEffect, useState } from "react";
import IconRail, { type WorkspaceSection } from "../../../components/IconRail";
import Sidebar from "../../../components/Sidebar";
import ChatPanel from "../../../components/ChatPanel";
import TaskThreadPanel from "../../../components/TaskThreadPanel";
import { useQuery } from "convex/react";
import { api } from "../../../../api/convex/_generated/api";

function SectionPage({
  section,
  agents,
  tasks,
}: {
  section: Exclude<WorkspaceSection, "chat" | "board">;
  agents: Array<{ _id: string; name: string; role: string; status: string }> | undefined;
  tasks: Array<{ _id: string; title: string; status: string }> | undefined;
}) {
  const titles: Record<typeof section, string> = {
    team: "Team",
    activity: "Aktivitas",
    health: "Kesehatan agent",
    integrations: "Integrasi",
    memory: "Memori",
  };
  return (
    <section className="min-w-0 flex-1 overflow-y-auto bg-white p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-xl font-semibold">{titles[section]}</h1>
        <p className="mt-1 text-sm text-gray-500">Informasi project dan agent yang sedang aktif.</p>
        {section === "team" && (
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {(agents ?? []).map((agent) => (
              <div key={agent._id} className="rounded-xl border border-gray-200 p-4">
                <p className="font-medium">{agent.name}</p>
                <p className="text-xs text-gray-500">{agent.role} · {agent.status}</p>
              </div>
            ))}
            {!agents?.length && <p className="text-sm text-gray-400">Belum ada agent di project ini.</p>}
          </div>
        )}
        {section === "activity" && (
          <div className="mt-6 rounded-xl border border-gray-200 p-4 text-sm">
            {tasks?.length ? `${tasks.length} task tercatat di project ini.` : "Belum ada aktivitas."}
          </div>
        )}
        {section === "health" && (
          <div className="mt-6 rounded-xl border border-gray-200 p-4 text-sm">
            {(agents ?? []).filter((agent) => agent.status === "working").length} agent sedang bekerja.
          </div>
        )}
        {(section === "integrations" || section === "memory") && (
          <div className="mt-6 rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400">
            Fitur ini belum dikonfigurasi untuk project ini.
          </div>
        )}
      </div>
    </section>
  );
}

export default function WorkspaceClient({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const [section, setSection] = useState<WorkspaceSection>("chat");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as never });
  const allAgents = useQuery(api.agents.list, {});
  const project = useQuery(api.projects.get, { projectId: projectId as never });
  const projectAgentIds = project?.agentIds;
  const agents = projectAgentIds
    ? allAgents?.filter((agent) => projectAgentIds.includes(agent._id))
    : allAgents;

  useEffect(() => {
    if (!selectedTaskId && tasks?.[0]) setSelectedTaskId(tasks[0]._id);
  }, [selectedTaskId, tasks]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#f7f7fb] text-[#24232d] dark:bg-gray-950 dark:text-gray-100 max-[979px]:h-auto max-[979px]:flex-col max-[979px]:overflow-y-auto">
      <IconRail
        projectId={projectId}
        activeSection={section}
        onSectionChange={(nextSection) => {
          setSection(nextSection);
          if (nextSection === "chat") setTab("chat");
          if (nextSection === "board") setTab("tasks");
        }}
      />
      <Sidebar projectId={projectId} />
      {section === "chat" || section === "board" ? (
        <ChatPanel projectId={projectId} tab={tab} setTab={setTab} onSelectTask={setSelectedTaskId} selectedTaskId={selectedTaskId} />
      ) : (
        <SectionPage section={section} agents={agents} tasks={tasks} />
      )}
      <TaskThreadPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  );
}
