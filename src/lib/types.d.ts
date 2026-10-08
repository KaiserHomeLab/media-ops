// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Shared shapes for JSDoc type annotations, e.g. `@param {import('./types').Service} svc`.
// Only read by the type checker (npm run typecheck); nothing here exists at runtime.

/** A saved app (Settings → Apps). Each kind adds its own fields from lib/kinds.js. */
export interface Service {
  id: string;
  kind: string;
  name: string;
  url: string;
  link?: string;
  enabled?: boolean;
  apiKey?: string;
  token?: string;
  username?: string;
  password?: string;
  [field: string]: any;
}

/** A notification destination (Settings → Notifications), see lib/notify.js. */
export interface Target {
  id: string;
  type: string;
  name: string;
  enabled?: boolean;
  events: Record<string, boolean>;
  [field: string]: any;
}

/** config.json, after lib/config.js has filled in the defaults. */
export interface Config {
  refreshSeconds: number;
  docker: { socket: string };
  paths: string[];
  services: Service[];
  auth: { salt: string; hash: string } | null;
  dashboardAuth?: boolean;
  map: { enabled: boolean; home: string };
  uploadMbps?: number | null;
  cleanupDays?: number;
  checkUpdates?: boolean;
  notifications: {
    diskThreshold?: number;
    targets: Target[];
    quiet?: { enabled: boolean; from: string; to: string; allowDown: boolean };
    digest?: { enabled: boolean; time: string };
  };
  dismissed: { before: Record<string, number>; items: any[] };
  /** Public /status page (lib/status.js); null until first saved. */
  statusPage?: { enabled: boolean; title: string; notice: string; services: string[] } | null;
  /** Dashboard rows in order and the cards turned off (lib/layout.js); null = the default. */
  layout?: { order: string[]; hidden: string[] } | null;
  /** Fix stuck downloads automatically (lib/autofix.js); null = off. */
  autoFix?: { enabled: boolean; minutes: number } | null;
  /** Settings → Appearance (lib/appearance.js); the logo is base64 so backups carry it. */
  appearance?: {
    theme: string;
    accent: string;
    title: string;
    statusTheme: string;
    liveStrip?: boolean;
    logo: { type: string; data: string; hash: string } | null;
  } | null;
  [key: string]: any;
}

/**
 * What a collector returns as `data` (see lib/collectors). It's another app's information in
 * our shape; the common lists are named, the rest varies by app.
 */
export interface CollectorData {
  streams?: any[];
  events?: any[];
  queue?: any[];
  items?: any[];
  imports?: any[];
  upcoming?: any[];
  libraries?: any[];
  recentlyAdded?: any[];
  disks?: any[];
  pools?: any[];
  [key: string]: any;
}

/** The shape of a poll result the digest and notifications read: every app, plus local disks. */
export interface PollResult {
  services: Polled[];
  disks?: any[];
  [key: string]: any;
}

/** One library on a media server, as the Library card shows it. */
export interface Library {
  title: string;
  type: string;
  count: number | null;
  episodes?: number | null;
  albums?: number | null;
  tracks?: number | null;
}

/** One app in a poll result (lib/poll.js runService): up with its data, or down with an error. */
export interface Polled {
  id: string;
  kind: string;
  name: string;
  link?: string;
  up: boolean;
  error?: string;
  version?: string | null;
  latency?: number | null;
  data?: CollectorData;
  [key: string]: any;
}

/** Options for lib/http.js req(). */
export interface ReqOptions {
  headers?: Record<string, string>;
  timeout?: number;
  method?: string;
  body?: string | URLSearchParams | null;
  /** 'json' (default) parses the reply, 'text' returns it as is, 'response' returns the Response. */
  as?: 'json' | 'text' | 'response';
}

/** What every collector returns (throwing means the app is down). */
export interface CollectorResult {
  version: string | null;
  latency: number | null;
  data: Record<string, any>;
}
