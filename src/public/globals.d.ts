// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// What the plain <script> files put on window for the dashboard modules (type checking only).

/** public/world-map.js: land outlines for the stream map. */
interface WorldMap {
  width: number;
  height: number;
  land: string;
}

/** public/map-projection.js: the map's projection (also used by scripts/build-world-map.js). */
interface MapProjectionApi {
  project(lon: number, lat: number): [number, number];
  LAT_TOP: number;
  LAT_BOTTOM: number;
  [key: string]: any;
}

interface Window {
  WORLD_MAP?: WorldMap;
  MapProjection?: MapProjectionApi;
}
declare var WORLD_MAP: WorldMap;
declare var MapProjection: MapProjectionApi;

/** One app as /api/overview sends it: up with its collector's data, or down with an error. */
interface ServiceState {
  id: string;
  kind: string;
  name: string;
  link?: string;
  up: boolean;
  error?: string;
  version?: string | null;
  latency?: number | null;
  actions?: { clear: string | null; recheck: string };
  data?: { [key: string]: any };
  [key: string]: any;
}

/** What /api/overview returns (lib/poll.js overview()). */
interface Overview {
  generatedAt: number;
  demo: boolean;
  refreshSeconds: number;
  configured: boolean;
  host: any;
  services: ServiceState[];
  events: any[];
  docker: any;
  disks: any[];
  gpus: any[];
  space: any;
  uploadMbps: number | null;
  version: string;
  latestVersion: string | null;
  settingsLocked: boolean;
  layout: { order: string[]; hidden: string[]; blocks: Record<string, string[]> };
  [key: string]: any;
}

/** An app that answered (util.js answered()), so it has data. */
type Answered = ServiceState & { data: { [key: string]: any } };

/** One field on an app or notification form (lib/kinds.js Field). */
interface FormField {
  key: string;
  label: string;
  type: 'text' | 'secret';
  help?: string;
  optional?: boolean;
  link?: string;
  placeholder?: string;
}

/** A saved app as Settings sees it: secrets replaced by `<key>Saved` flags. */
interface AppRow {
  id: string;
  kind: string;
  name: string;
  url: string;
  link?: string;
  enabled?: boolean;
  [key: string]: any;
}

/** What GET /api/settings returns (lib/settings-api.js settingsPayload()). */
interface SettingsPayload {
  authEnabled: boolean;
  dashboardAuth: boolean;
  version: string;
  loggedIn: boolean;
  demo: boolean;
  configFile: string;
  general: {
    refreshSeconds: number;
    paths: string[];
    dockerSocket: string;
    mapEnabled: boolean;
    mapHome: string;
    mapAsgard: boolean;
    uploadMbps: number | string;
    cleanupDays: number;
    checkUpdates: boolean;
  };
  services: AppRow[];
  kinds: { kind: string; label: string; group: string; port: number | null; note?: string; fields: FormField[] }[];
  hostOs: string | null;
  platform: { id: string; label: string; vm: boolean };
  notifications: {
    diskThreshold: number;
    quiet: { enabled: boolean; from: string; to: string; allowDown: boolean };
    digest: { enabled: boolean; time: string };
    targets: {
      id: string;
      type: string;
      name: string;
      enabled?: boolean;
      events: Record<string, boolean>;
      last: { at: number; ok: boolean; error?: string } | null;
      [key: string]: any;
    }[];
  };
  notifyTypes: { type: string; label: string; fields: FormField[] }[];
  notifyEvents: { key: string; label: string; def: boolean }[];
  statusPage: { enabled: boolean; title: string; notice: string; services: string[] };
  layout: { order: string[]; hidden: string[] };
  layoutBlocks: { id: string; cards: { id: string; label: string }[] }[];
  autoFix: {
    enabled: boolean;
    minutes: number;
    recent: { at: number; app: string; title: string; reason: string; ok: boolean; error?: string }[];
  };
  appearance: {
    theme: string;
    accent: string;
    title: string;
    statusTheme: string;
    liveStrip: boolean;
    logo: { type: string; hash: string } | null;
  };
  accents: { id: string; label: string; dark: string; light: string }[];
  metrics: { enabled: boolean; tokenSet: boolean };
}

type AppKind = SettingsPayload['kinds'][number];
type NotifyType = SettingsPayload['notifyTypes'][number];
type NotifyTarget = SettingsPayload['notifications']['targets'][number];

/** Settings → Diagnostics: what GET /api/settings/diagnostics returns (lib/diagnostics.js). */
interface DiagCall {
  method: string;
  url: string;
  status?: number;
  ms?: number;
  bytes?: number;
  sample?: string;
  error?: string;
}
interface DiagReport {
  mediaOps: string;
  node: string;
  platform: string;
  apps: {
    name: string;
    kind: string;
    ok: boolean;
    version?: string | null;
    ms: number;
    error?: string;
    calls: DiagCall[];
    [key: string]: any;
  }[];
  recentLog: { at: string; level: string; text: string }[];
  [key: string]: any;
}
