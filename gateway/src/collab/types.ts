import type {
  ApprovalRef,
  CollabError,
  CollabRunStatus,
  CollabTaskAttempt,
  CollabTaskStatus,
  PolicyId,
  TurnFile,
} from "../../../shared/protocol.ts";

export type CollabExecutionProfile = {
  model: string;
  mode: "agent";
  policy: PolicyId;
  dialect: boolean;
  timezone?: string;
};

export type CollabRun = {
  id: string;
  version: number;
  convId: string;
  triggerSeq: number;
  triggerEventKey: string;
  ownerTenantId: string;
  coordinatorChatId: string;
  executionProfile: CollabExecutionProfile;
  status: CollabRunStatus;
  goal: string;
  wave: number;
  maxWaves: number;
  coordinated: boolean;
  explanation?: string;
  summary?: string;
  partial?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type CollabTask = {
  id: string;
  runId: string;
  version: number;
  attempt: number;
  actorId: string;
  workspaceId: string;
  workspaceKeyAtDispatch?: string;
  status: CollabTaskStatus;
  title: string;
  brief: string;
  wave: number;
  dependsOn: string[];
  acceptance: string[];
  required: boolean;
  suggestedNextActors?: string[];
  delegationId?: string;
  childChatId?: string;
  summary?: string;
  files?: TurnFile[];
  sourceTurnId?: string;
  approval?: ApprovalRef;
  approvedFingerprints?: string[];
  approvalDecisions?: Array<{ fingerprint: string; allow: true; at: number }>;
  error?: CollabError;
  attempts: CollabTaskAttempt[];
  createdAt: number;
  updatedAt: number;
};

export type CollabAggregate = { kind: "run" | "task"; id: string };

export type CollabEffect =
  | {
      kind: "im_actor_message";
      key: string;
      critical: true;
      payload: {
        convId: string;
        actorId: string;
        ownerTenantId: string;
        workspaceId: string;
        runId: string;
        taskId: string;
        summary: string;
        files?: TurnFile[];
      };
    }
  | {
      kind: "collab_state";
      key: string;
      critical: false;
      payload: { convId: string; runId: string };
    }
  | {
      kind: "wake_coordinator";
      key: string;
      critical: false;
      payload: { runId: string; wave: number };
    }
  | {
      kind: "im_coordinator_message";
      key: string;
      critical: true;
      payload: {
        convId: string;
        actorId: string;
        ownerTenantId: string;
        runId: string;
        event: "plan" | "summary";
        wave?: number;
        summary: string;
      };
    };

export type CollabEvent = {
  eventId: string;
  eventKey: string;
  aggregate: CollabAggregate;
  expectedVersion: number;
  nextVersion: number;
  type: string;
  payload: Record<string, unknown>;
  effects: CollabEffect[];
  at: number;
};

export type EffectDelivery = {
  key: string;
  status: "delivered" | "retry" | "failed";
  targetId?: string;
  attempt: number;
  nextAt?: number;
  errorClass?: string;
  at: number;
  expiresAt: number;
};

export type CollabSnapshot = {
  run: CollabRun;
  tasks: CollabTask[];
  snapshotSeq: number;
};

export type CollabStateView = {
  snapshotSeq: number;
  runs: Array<{
    runId: string;
    version: number;
    status: CollabRunStatus;
    tasks: Array<{
      taskId: string;
      version: number;
      workspaceId: string;
      title: string;
      wave: number;
      dependsOn: string[];
      acceptance: string[];
      required: boolean;
      suggestedNextActors?: string[];
      status: CollabTaskStatus;
      attempt: number;
      attempts: CollabTaskAttempt[];
      summary?: string;
      files?: TurnFile[];
      approval?: ApprovalRef;
      error?: CollabError;
    }>;
  }>;
};
