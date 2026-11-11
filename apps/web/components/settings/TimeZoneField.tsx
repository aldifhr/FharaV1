"use client";

/**
 * Settings → General: the time zone of the time line agents see in their
 * prompts (DeepSeek Harness D4). Stored on the appSettings row; the worker
 * picks it up with the app settings and chat reads it per reply.
 */
import { useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "@/components/Toasts";
import { errorText, INPUT, Row, Section, useAppSettings } from "./controls";

const DEFAULT_ZONE = "Asia/Jakarta";
const FALLBACK_ZONES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"];

function supportedZones(current: string): string[] {
  let zones: string[] = FALLBACK_ZONES;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    if (typeof intl.supportedValuesOf === "function") zones = intl.supportedValuesOf("timeZone");
  } catch {
    zones = FALLBACK_ZONES;
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

export function TimeZoneField() {
  const settings = useAppSettings();
  const save = useMutation(api.appSettings.setUserTimeZone);
  const toast = useToast();
  const current = settings?.userTimeZone ?? DEFAULT_ZONE;
  const zones = useMemo(() => supportedZones(current), [current]);
  return (
    <Section title="Time" description="Agents get the current time in this zone at the end of their prompt, refreshed at most every 10 minutes.">
      <Row label="Time zone" description="Default Asia/Jakarta." htmlFor="settings-time-zone">
        <select
          id="settings-time-zone"
          aria-label="Time zone"
          className={`${INPUT} w-56`}
          value={current}
          disabled={settings === undefined}
          onChange={async (event) => {
            try {
              await save({ timeZone: event.target.value });
            } catch (err) {
              toast("error", "Couldn't save the time zone", errorText(err));
            }
          }}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  );
}
