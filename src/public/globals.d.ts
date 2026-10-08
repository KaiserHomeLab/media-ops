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
