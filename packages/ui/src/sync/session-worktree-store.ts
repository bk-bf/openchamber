/**
 * SessionWorktreeStore — authoritative shared-sync holder for session↔worktree attachments.
 *
 * This is NOT session-ui-store (which is ephemeral UI state).
 * This store holds the Phase 1 canonical worktree attachment per session,
 * used across bootstrap, reload, and runtime boundaries.
 */
import { create } from 'zustand';
import type { SessionWorktreeAttachment } from '@/stores/types/sessionTypes';

interface SessionWorktreeState {
  attachments: Map<string, SessionWorktreeAttachment>;
}

interface SessionWorktreeActions {
  setAttachment(sessionId: string, attachment: SessionWorktreeAttachment): void;
  getAttachment(sessionId: string): SessionWorktreeAttachment | undefined;
  clearAttachment(sessionId: string): void;
}

type SessionWorktreeStore = SessionWorktreeState & SessionWorktreeActions;

export const useSessionWorktreeStore = create<SessionWorktreeStore>((set, get) => ({
  attachments: new Map(),

  setAttachment: (sessionId, attachment) =>
    set((s) => {
      const next = new Map(s.attachments);
      next.set(sessionId, attachment);
      return { attachments: next };
    }),

  getAttachment: (sessionId) => get().attachments.get(sessionId),

  clearAttachment: (sessionId) =>
    set((s) => {
      const next = new Map(s.attachments);
      next.delete(sessionId);
      return { attachments: next };
    }),
}));
