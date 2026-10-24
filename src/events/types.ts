/**
 * Everything the daemon streams to clients over `/v1/events`.
 * Later tickets add agent, tool, task and decision events to this union.
 */
export type HamnessEvent =
  | { type: "daemon.hello"; version: string; pid: number; schemaVersion: number }
  | { type: "daemon.stopping" };

export type HamnessEventType = HamnessEvent["type"];
