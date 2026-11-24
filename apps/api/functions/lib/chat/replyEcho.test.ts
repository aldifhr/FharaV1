import { describe, expect, test } from "vitest";
import { replyEchoKey } from "./replyEcho";

describe("replyEchoKey", () => {
  test("groups Indonesian task-created echoes", () => {
    expect(replyEchoKey("Task untuk refresh halaman About sudah dibuat dengan cakupan terpisah.")).toBe("task-created");
    expect(replyEchoKey("Task refresh halaman About sudah dibuat. Tidak ada task duplikat yang dibuat.")).toBe("task-created");
  });

  test("groups English task-created echoes", () => {
    expect(replyEchoKey("I already created the task. No duplicate task was created.")).toBe("task-created");
  });

  test("leaves real answers alone", () => {
    expect(replyEchoKey("The page loads with no console errors.")).toBeNull();
    expect(replyEchoKey(undefined)).toBeNull();
  });
});
