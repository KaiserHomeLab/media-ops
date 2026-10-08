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
